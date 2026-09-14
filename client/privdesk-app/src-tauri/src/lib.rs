// PrivDesk 客户端 - Rust 后端
// 功能: 启动/停止 frpc、真实连接判断、系统托盘、开机自启、关闭到托盘

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_autostart::ManagerExt;

// ---------- 全局状态 ----------
struct AppState {
    frpc_child: Mutex<Option<Child>>,
    // 共享上网(代理): gost 进程 + 代理专用 frpc 进程
    gost_child: Mutex<Option<Child>>,
    proxy_frpc_child: Mutex<Option<Child>>,
}

#[derive(Debug, Deserialize)]
struct ConnectParams {
    server: String,
    port: String,
    token: String,
    remote: String,
}

#[derive(Debug, Serialize)]
struct ConnectResult {
    ok: bool,
    message: String,
}

fn app_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

// ---------- 平台相关常量/辅助 ----------
// Windows: frpc.exe + 转发 RDP(3389)
// macOS:   frpc    + 转发 屏幕共享/VNC(5900)
#[cfg(windows)]
const FRPC_FILENAME: &str = "frpc.exe";
#[cfg(not(windows))]
const FRPC_FILENAME: &str = "frpc";

// 被控端本机要转发的本地端口
#[cfg(windows)]
const LOCAL_PORT: u16 = 3389; // Windows 远程桌面
#[cfg(target_os = "macos")]
const LOCAL_PORT: u16 = 5900; // macOS 屏幕共享(VNC)
#[cfg(all(not(windows), not(target_os = "macos")))]
const LOCAL_PORT: u16 = 5900; // 其它类 Unix 也按 VNC 处理

// 当前平台标识(给前端切换文案用)
#[cfg(windows)]
const PLATFORM: &str = "windows";
#[cfg(target_os = "macos")]
const PLATFORM: &str = "macos";
#[cfg(all(not(windows), not(target_os = "macos")))]
const PLATFORM: &str = "other";

// 日志目录: %APPDATA%\com.privdesk.app\logs
fn log_dir(app: &tauri::AppHandle) -> PathBuf {
    let dir = app_dir(app).join("logs");
    let _ = fs::create_dir_all(&dir);
    dir
}

#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn hide_window(_cmd: &mut Command) {}

enum FrpcEvent {
    Success,
    Failed(String),
}

// 把一行 frpc 日志追加写入日志文件(线程安全)
fn write_log_line(log: &Arc<Mutex<Option<fs::File>>>, line: &str) {
    if let Ok(mut guard) = log.lock() {
        if let Some(f) = guard.as_mut() {
            let _ = writeln!(f, "{}", line);
        }
    }
}

// ========== 命令: 连接 ==========
#[tauri::command]
async fn connect(
    app: tauri::AppHandle,
    params: ConnectParams,
) -> ConnectResult {
    // 把阻塞逻辑放到后台线程, 避免卡住 UI(连接中窗口仍可拖动)
    tauri::async_runtime::spawn_blocking(move || connect_blocking(app, params))
        .await
        .unwrap_or_else(|e| ConnectResult {
            ok: false,
            message: format!("内部错误: {}", e),
        })
}

fn connect_blocking(app: tauri::AppHandle, params: ConnectParams) -> ConnectResult {
    let state = app.state::<AppState>();
    stop_frpc(&state);

    let dir = app_dir(&app);
    let _ = fs::create_dir_all(&dir);

    let frpc_path = dir.join(FRPC_FILENAME);
    if !frpc_path.exists() {
        if let Ok(resource) = app.path().resource_dir() {
            let bundled = resource.join(FRPC_FILENAME);
            if bundled.exists() {
                let _ = fs::copy(&bundled, &frpc_path);
            }
        }
    }
    if !frpc_path.exists() {
        return ConnectResult {
            ok: false,
            message: "BLOCKED:连接组件丢失,可能被安全软件删除,请将 PrivDesk 加入信任".into(),
        };
    }

    // 类 Unix(macOS): 确保 frpc 有可执行权限(从资源拷贝出来后可能丢失 x 位)
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(&frpc_path) {
            let mut perm = meta.permissions();
            perm.set_mode(0o755);
            let _ = fs::set_permissions(&frpc_path, perm);
        }
    }

    let config = format!(
        r#"serverAddr = "{}"
serverPort = {}

auth.method = "token"
auth.token = "{}"

transport.tls.enable = true

[[proxies]]
name = "RDP-{}"
type = "tcp"
localIP = "127.0.0.1"
localPort = {}
remotePort = {}
"#,
        params.server, params.port, params.token, params.remote, LOCAL_PORT, params.remote
    );
    let config_path = dir.join("frpc.toml");
    if let Err(e) = fs::write(&config_path, config) {
        return ConnectResult {
            ok: false,
            message: format!("写入配置失败: {}", e),
        };
    }

    let mut cmd = Command::new(&frpc_path);
    cmd.arg("-c").arg(&config_path);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    hide_window(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_e) => {
            // 启动失败: 极可能是被安全软件(SAC/杀软)拦截或删除了 frpc
            return ConnectResult {
                ok: false,
                message: "BLOCKED:连接组件无法启动,可能被系统或安全软件拦截".into(),
            };
        }
    };

    // 启动后短暂检查: 如果进程瞬间退出(被杀软拦杀), 也判定为拦截
    thread::sleep(Duration::from_millis(300));
    if let Ok(Some(_status)) = child.try_wait() {
        // 进程已退出 -> 检查 frpc 文件还在不在(被删?)
        if !frpc_path.exists() {
            return ConnectResult {
                ok: false,
                message: "BLOCKED:连接组件被安全软件删除,请将 PrivDesk 加入信任".into(),
            };
        }
        return ConnectResult {
            ok: false,
            message: "BLOCKED:连接组件启动后被安全软件终止".into(),
        };
    }

    let (tx, rx) = mpsc::channel::<FrpcEvent>();

    // 打开日志文件(每次连接覆盖, 只保留最近一次尝试的完整日志, 方便排查)
    // 用 Arc<Mutex> 让 stdout / stderr 两个线程共享同一个写入句柄
    let log_path = log_dir(&app).join("frpc.log");
    let log_file: Arc<Mutex<Option<fs::File>>> = Arc::new(Mutex::new(
        fs::File::create(&log_path).ok().map(|mut f| {
            let header = format!(
                "PrivDesk 连接日志\n服务器: {}:{}  远程端口: {}\n----------------------------------------\n",
                params.server, params.port, params.remote
            );
            let _ = f.write_all(header.as_bytes());
            f
        }),
    ));

    if let Some(stdout) = child.stdout.take() {
        let tx2 = tx.clone();
        let log = Arc::clone(&log_file);
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                write_log_line(&log, &line);
                let l = line.to_lowercase();
                if l.contains("start proxy success") {
                    let _ = tx2.send(FrpcEvent::Success);
                    break;
                } else if l.contains("login to server failed")
                    || l.contains("authentication failed")
                    || l.contains("token in login")
                {
                    let _ = tx2.send(FrpcEvent::Failed(
                        "认证失败, 请检查认证密钥是否正确".into(),
                    ));
                    break;
                } else if l.contains("proxy") && l.contains("already exists") {
                    let _ = tx2.send(FrpcEvent::Failed(
                        "该连接已在别处使用中。请确认这台电脑没有重复连接, 或换一个远程端口重试".into(),
                    ));
                    break;
                } else if l.contains("port already used")
                    || l.contains("already used")
                    || l.contains("port not allowed")
                {
                    let _ = tx2.send(FrpcEvent::Failed(
                        "远程端口已被占用, 请更换一个远程端口后重试".into(),
                    ));
                    break;
                } else if l.contains("start error") || l.contains("start proxy error") {
                    let _ = tx2.send(FrpcEvent::Failed(
                        "隧道启动失败, 请检查远程端口是否可用或更换端口".into(),
                    ));
                    break;
                } else if l.contains("connection refused")
                    || l.contains("no such host")
                    || l.contains("i/o timeout")
                    || l.contains("dial tcp")
                {
                    let _ = tx2.send(FrpcEvent::Failed(
                        "无法连接到服务器, 请检查服务器地址和端口是否正确".into(),
                    ));
                    break;
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let tx3 = tx.clone();
        let log = Arc::clone(&log_file);
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                write_log_line(&log, &line);
                let l = line.to_lowercase();
                if l.contains("port already used") || l.contains("already used") {
                    let _ = tx3.send(FrpcEvent::Failed(
                        "远程端口已被占用, 请更换一个远程端口后重试".into(),
                    ));
                    break;
                } else if l.contains("error") || l.contains("failed") {
                    let _ = tx3.send(FrpcEvent::Failed(
                        "连接失败, 请检查连接信息是否正确".into(),
                    ));
                    break;
                }
            }
        });
    }

    *state.frpc_child.lock().unwrap() = Some(child);

    match rx.recv_timeout(Duration::from_secs(8)) {
        Ok(FrpcEvent::Success) => ConnectResult {
            ok: true,
            message: "连接成功".into(),
        },
        Ok(FrpcEvent::Failed(reason)) => {
            stop_frpc(&state);
            ConnectResult { ok: false, message: reason }
        }
        Err(_) => {
            stop_frpc(&state);
            ConnectResult {
                ok: false,
                message: "连接超时, 请检查服务器地址、端口和网络是否正常".into(),
            }
        }
    }
}

// ========== 命令: 断开 ==========
#[tauri::command]
fn disconnect(state: tauri::State<AppState>) -> ConnectResult {
    stop_frpc(&state);
    ConnectResult {
        ok: true,
        message: "已断开连接".into(),
    }
}

// ========== 命令: 查询连接状态 ==========
#[tauri::command]
fn is_connected(state: tauri::State<AppState>) -> bool {
    let mut guard = state.frpc_child.lock().unwrap();
    if let Some(child) = guard.as_mut() {
        matches!(child.try_wait(), Ok(None))
    } else {
        false
    }
}

// ========== 命令: 设置开机自启 ==========
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enable: bool) -> bool {
    let manager = app.autolaunch();
    let result = if enable {
        manager.enable()
    } else {
        manager.disable()
    };
    result.is_ok()
}

// ========== 命令: 查询开机自启状态 ==========
#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

// ========== 命令: 保存连接信息到本地 ==========
#[tauri::command]
fn save_profile(app: tauri::AppHandle, params: ConnectParams) -> bool {
    let dir = app_dir(&app);
    let _ = fs::create_dir_all(&dir);
    let profile = serde_json::json!({
        "server": params.server,
        "port": params.port,
        "token": params.token,
        "remote": params.remote,
    });
    let path = dir.join("profile.json");
    fs::write(&path, profile.to_string()).is_ok()
}

// ========== 命令: 读取本地保存的连接信息 ==========
#[tauri::command]
fn load_profile(app: tauri::AppHandle) -> Option<serde_json::Value> {
    let path = app_dir(&app).join("profile.json");
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

// ========== 命令: 按主题色更新托盘 + 窗口(任务栏)图标 ==========
#[tauri::command]
fn update_tray_color(app: tauri::AppHandle, r: u8, g: u8, b: u8) {
    use tauri::image::Image;
    let size: u32 = 64;
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    let radius = 12.0_f32;
    let w = size as f32;
    for y in 0..size {
        for x in 0..size {
            let inside = is_inside_rounded_rect(x as f32, y as f32, w, w, radius);
            let idx = ((y * size + x) * 4) as usize;
            if inside {
                rgba[idx] = r;
                rgba[idx + 1] = g;
                rgba[idx + 2] = b;
                rgba[idx + 3] = 255;
            } else {
                rgba[idx + 3] = 0;
            }
        }
    }

    // 在中间叠加白色字母 "P"
    draw_letter_p(&mut rgba, size);

    if let Some(tray) = app.tray_by_id("main-tray") {
        let img = Image::new_owned(rgba.clone(), size, size);
        let _ = tray.set_icon(Some(img));
    }
    if let Some(win) = app.get_webview_window("main") {
        let img = Image::new_owned(rgba, size, size);
        let _ = win.set_icon(img);
    }
}

// 在 64x64 图标中间用像素绘制白色字母 "P"
fn draw_letter_p(rgba: &mut [u8], size: u32) {
    let s = size as i32;
    // 字母P的设计区域: 大致占中间 50%
    // 竖线: x 从 24 到 30 ; 上半圆/方框
    let set = |rgba: &mut [u8], x: i32, y: i32| {
        if x >= 0 && y >= 0 && x < s && y < s {
            let idx = ((y * s + x) * 4) as usize;
            rgba[idx] = 255;
            rgba[idx + 1] = 255;
            rgba[idx + 2] = 255;
            rgba[idx + 3] = 255;
        }
    };
    let top = 18;      // P 顶部
    let bottom = 46;   // P 底部
    let left = 22;     // 竖线左侧
    let thickness = 6; // 笔画粗细
    let bowl_right = 40; // P 头部右边界
    let bowl_bottom = 33; // P 头部下边界

    // 竖线
    for y in top..=bottom {
        for x in left..left + thickness {
            set(rgba, x, y);
        }
    }
    // 上横线
    for x in left..=bowl_right {
        for t in 0..thickness {
            set(rgba, x, top + t);
        }
    }
    // 中横线
    for x in left..=bowl_right {
        for t in 0..thickness {
            set(rgba, x, bowl_bottom + t);
        }
    }
    // 右竖线(头部右侧)
    for y in top..=bowl_bottom + thickness {
        for x in bowl_right - thickness + 1..=bowl_right {
            set(rgba, x, y);
        }
    }
}

// 判断点是否在圆角矩形内
fn is_inside_rounded_rect(px: f32, py: f32, w: f32, h: f32, r: f32) -> bool {
    if px < 0.0 || py < 0.0 || px > w - 1.0 || py > h - 1.0 {
        return false;
    }
    // 四个角的圆心
    let cx = if px < r { r } else if px > w - 1.0 - r { w - 1.0 - r } else { px };
    let cy = if py < r { r } else if py > h - 1.0 - r { h - 1.0 - r } else { py };
    let dx = px - cx;
    let dy = py - cy;
    dx * dx + dy * dy <= r * r
}

// ========== 命令: 当前平台标识(给前端切换文案) ==========
#[tauri::command]
fn get_platform() -> String {
    PLATFORM.to_string()
}

// ========== 控制端: 探测远程地址端口是否可达 ==========
// 返回 true 表示 TCP 能连上(对方已连线且端口已放行)
#[tauri::command]
async fn probe_remote(host: String, port: u16) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        use std::net::{TcpStream, ToSocketAddrs};
        let addr = format!("{}:{}", host, port);
        // 解析地址(可能是 IP 或域名), 逐个尝试, 2 秒超时
        if let Ok(mut addrs) = addr.to_socket_addrs() {
            if let Some(sa) = addrs.next() {
                return TcpStream::connect_timeout(&sa, Duration::from_secs(2)).is_ok();
            }
        }
        false
    })
    .await
    .unwrap_or(false)
}

// ========== 控制端: 远程别人的电脑 ==========
// kind = "vnc" (Mac/屏幕共享) 或 "rdp" (Windows 远程桌面)
// 仅 Windows 客户端提供此功能(内置 VNC 查看器 + 系统 mstsc)
#[cfg(windows)]
#[tauri::command]
async fn remote_connect(app: tauri::AppHandle, address: String, kind: String, password: String, username: String) -> ConnectResult {
    // 全程放到阻塞线程执行, 绝不占用主线程(否则 mstsc/cmdkey 一慢, 界面就无响应)
    tauri::async_runtime::spawn_blocking(move || {
        remote_connect_inner(app, address, kind, password, username)
    })
    .await
    .unwrap_or_else(|_| ConnectResult {
        ok: false,
        message: "远程任务执行出错".into(),
    })
}

// 放行"委派保存的凭据"策略, 让 mstsc 能用 cmdkey 存的密码直接登录, 不再二次弹密码框。
// 只写 HKCU(当前用户), 无需管理员权限。等价于组策略里的:
//   Credentials Delegation -> Allow Delegating Saved Credentials (+NTLM-only) 加入 TERMSRV/*
#[cfg(windows)]
fn allow_saved_rdp_credentials(target: &str) {
    // 两个策略键: 普通保存凭据 + 仅NTLM服务器认证时的保存凭据
    let keys = [
        r"HKCU\SOFTWARE\Policies\Microsoft\Windows\CredentialsDelegation\AllowSavedCredentials",
        r"HKCU\SOFTWARE\Policies\Microsoft\Windows\CredentialsDelegation\AllowSavedCredentialsWhenNTLMOnly",
    ];
    // 具体条目值名从 1 开始递增; 我们同时写一个通配 TERMSRV/* 和精确 TERMSRV/host:port,
    // 通配覆盖大多数情况, 精确项作为兜底(某些策略对通配匹配较严格)。
    let values = [format!("TERMSRV/*"), format!("TERMSRV/{}", target)];
    for key in keys.iter() {
        // 先确保父开关开启: ConcatenateDefaults_AllowSaved = 1
        let parent = key.rsplitn(2, '\\').nth(1).unwrap_or("");
        let mut on = Command::new("reg");
        on.args(["add", parent, "/v", "AllowSavedCredentials", "/t", "REG_DWORD", "/d", "1", "/f"]);
        hide_window(&mut on);
        on.stdin(Stdio::null()); on.stdout(Stdio::null()); on.stderr(Stdio::null());
        let _ = on.status();

        for (i, v) in values.iter().enumerate() {
            let mut cmd = Command::new("reg");
            cmd.args(["add", key, "/v", &(i + 1).to_string(), "/t", "REG_SZ", "/d", v, "/f"]);
            hide_window(&mut cmd);
            cmd.stdin(Stdio::null()); cmd.stdout(Stdio::null()); cmd.stderr(Stdio::null());
            let _ = cmd.status();
        }
    }
}

#[cfg(windows)]
fn remote_connect_inner(app: tauri::AppHandle, address: String, kind: String, password: String, username: String) -> ConnectResult {
    // 解析 address 成 host / port
    let (host, port) = match parse_address(&address) {
        Some(v) => v,
        None => {
            return ConnectResult {
                ok: false,
                message: "地址格式不对, 应为 IP:端口, 例如 1.2.3.4:7002".into(),
            }
        }
    };

    if kind == "rdp" {
        // Windows 远程桌面: 用系统自带 mstsc, 无需捆绑。
        // mstsc 本身没有传用户名的命令行参数, 要让用户名/密码自动带入,
        // 必须先用 cmdkey 把凭据写进系统凭据库(目标名: TERMSRV/host:port), mstsc 会自动读取。
        let target = format!("{}:{}", host, port);
        let has_pw = !password.is_empty();
        let mut credential_stored = false;
        if !username.trim().is_empty() {
            // 填了密码 -> 先放行"凭据委派"策略, 否则 Windows 即使存了密码也会再弹密码框,
            // 无法真正"直接登录"。此步只写 HKCU, 不需要管理员权限。
            if has_pw {
                allow_saved_rdp_credentials(&target);
            }
            let mut ck = Command::new("cmdkey");
            ck.arg(format!("/generic:TERMSRV/{}", target));
            ck.arg(format!("/user:{}", username.trim()));
            // 密码可留空(留空则 mstsc 弹窗只需输密码, 用户名已带入)
            ck.arg(format!("/pass:{}", password));
            hide_window(&mut ck);
            // 关键: cmdkey 是控制台程序, 在 CREATE_NO_WINDOW 下必须重定向 stdio 到 null,
            // 否则其 stdout/stderr 无处可去会导致进程挂起, 使 .status() 永不返回 -> 界面无响应。
            ck.stdin(Stdio::null());
            ck.stdout(Stdio::null());
            ck.stderr(Stdio::null());
            // 存凭据失败不阻断, 顶多回退到手动输入
            if ck.status().map(|s| s.success()).unwrap_or(false) {
                credential_stored = true;
            }
        }

        let mut cmd = Command::new("mstsc");
        cmd.arg(format!("/v:{}", target));
        match cmd.spawn() {
            Ok(_) => {
                // 凭据用完即删: mstsc 启动后延迟清理, 避免残留在系统凭据库里。
                // (mstsc 启动时已读取凭据, 之后删除不影响本次连接)
                if credential_stored {
                    let target_cleanup = target.clone();
                    thread::spawn(move || {
                        thread::sleep(Duration::from_secs(20));
                        let mut del = Command::new("cmdkey");
                        del.arg(format!("/delete:TERMSRV/{}", target_cleanup));
                        hide_window(&mut del);
                        del.stdin(Stdio::null());
                        del.stdout(Stdio::null());
                        del.stderr(Stdio::null());
                        let _ = del.status();
                    });
                }
                let msg = if credential_stored && has_pw {
                    "已发起远程, 正在用保存的账号密码自动登录"
                } else if credential_stored {
                    "已打开远程桌面, 用户名已自动带入, 请在窗口中输入密码"
                } else {
                    "已打开远程桌面, 请在窗口中输入对方的用户名和密码"
                };
                ConnectResult { ok: true, message: msg.into() }
            }
            Err(e) => ConnectResult {
                ok: false,
                message: format!("打开远程桌面失败: {}", e),
            },
        }
    } else {
        // VNC(远程 Mac): 用捆绑的 tvnviewer.exe
        // 排查日志: %APPDATA%\com.privdesk.app\logs\remote.log
        let mut diag = String::new();
        diag.push_str(&format!("远程目标: {}:{}  类型: VNC\n", host, port));

        // 优先直接用资源目录里的 tvnviewer(不必先复制), 复制目录作为兜底
        let mut viewer: Option<PathBuf> = None;
        if let Ok(resource) = app.path().resource_dir() {
            let p = resource.join("tvnviewer.exe");
            diag.push_str(&format!("资源目录候选: {} 存在={}\n", p.display(), p.exists()));
            if p.exists() {
                viewer = Some(p);
            }
        } else {
            diag.push_str("resource_dir() 获取失败\n");
        }
        // 兜底: 从资源复制到数据目录再用
        if viewer.is_none() {
            let dir = app_dir(&app);
            let _ = fs::create_dir_all(&dir);
            let dest = dir.join("tvnviewer.exe");
            if dest.exists() {
                diag.push_str(&format!("数据目录已有: {}\n", dest.display()));
                viewer = Some(dest);
            } else if let Ok(resource) = app.path().resource_dir() {
                let bundled = resource.join("tvnviewer.exe");
                match fs::copy(&bundled, &dest) {
                    Ok(n) => {
                        diag.push_str(&format!("已复制到数据目录 ({} 字节): {}\n", n, dest.display()));
                        viewer = Some(dest);
                    }
                    Err(e) => diag.push_str(&format!("复制失败: {}\n", e)),
                }
            }
        }

        let viewer = match viewer {
            Some(v) => v,
            None => {
                diag.push_str("结论: 找不到 tvnviewer.exe\n");
                write_remote_log(&app, &diag);
                return ConnectResult {
                    ok: false,
                    message: "BLOCKED:远程组件丢失,可能被安全软件删除,请将 PrivDesk 加入信任".into(),
                };
            }
        };

        // tvnviewer 语法: host::port 表示直接用该 TCP 端口(实测确认)
        let arg_addr = format!("{}::{}", host, port);
        diag.push_str(&format!("启动: {} {}\n", viewer.display(), arg_addr));
        let mut cmd = Command::new(&viewer);
        cmd.arg(&arg_addr);
        // -scale=auto: 画面自动缩放铺满窗口(拖动窗口大小画面自适应), 解决"画面没铺满"的问题。
        // -shared=1: 共享模式连接, 不踢掉对方已有的连接。
        cmd.arg("-scale=auto");
        cmd.arg("-shared=1");
        if !password.is_empty() {
            cmd.arg(format!("-password={}", password));
        }
        match cmd.spawn() {
            Ok(mut child) => {
                // 启动后短暂等一下, 检查是否秒退(被杀软拦杀 / 崩溃)
                thread::sleep(Duration::from_millis(500));
                match child.try_wait() {
                    Ok(Some(status)) => {
                        diag.push_str(&format!("进程已退出, code={:?}\n", status.code()));
                        write_remote_log(&app, &diag);
                        return ConnectResult {
                            ok: false,
                            message: "BLOCKED:远程组件启动后被安全软件终止,请将 PrivDesk 加入信任".into(),
                        };
                    }
                    _ => {
                        diag.push_str("进程存活, 窗口应已弹出\n");
                        write_remote_log(&app, &diag);
                    }
                }
                ConnectResult {
                    ok: true,
                    message: "已发起远程连接".into(),
                }
            }
            Err(e) => {
                diag.push_str(&format!("spawn 失败: {}\n", e));
                write_remote_log(&app, &diag);
                ConnectResult {
                    ok: false,
                    message: "BLOCKED:远程组件无法启动,可能被安全软件拦截".into(),
                }
            }
        }
    }
}

// 把控制端远程排查信息写入 logs\remote.log(每次覆盖)
#[cfg(windows)]
fn write_remote_log(app: &tauri::AppHandle, content: &str) {
    let path = log_dir(app).join("remote.log");
    let _ = fs::write(path, content);
}

// 非 Windows 平台: 控制端功能暂不提供
#[cfg(not(windows))]
#[tauri::command]
fn remote_connect(_app: tauri::AppHandle, _address: String, _kind: String, _password: String, _username: String) -> ConnectResult {
    ConnectResult {
        ok: false,
        message: "当前系统暂不支持在客户端内直接远程别人的电脑".into(),
    }
}

// 把 "1.2.3.4:7002" 解析成 (host, port)
fn parse_address(address: &str) -> Option<(String, u16)> {
    let s = address.trim();
    let idx = s.rfind(':')?;
    let host = s[..idx].trim();
    let port: u16 = s[idx + 1..].trim().parse().ok()?;
    if host.is_empty() || port == 0 {
        return None;
    }
    Some((host.to_string(), port))
}

// ========== 共享上网(代理): 参数 ==========
#[derive(Debug, Deserialize)]
struct ProxyParams {
    remote_port: String, // 服务器对外暴露的代理端口(如 6080)
    user: String,        // 代理账号(自动生成)
    password: String,    // 代理密码(自动生成)
}

// 停掉代理相关的两个子进程(gost + 代理 frpc)
fn stop_proxy(state: &tauri::State<AppState>) {
    if let Ok(mut g) = state.gost_child.lock() {
        if let Some(mut c) = g.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
    if let Ok(mut f) = state.proxy_frpc_child.lock() {
        if let Some(mut c) = f.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

// ========== 命令: 查询代理是否在运行 ==========
#[tauri::command]
fn proxy_status(state: tauri::State<AppState>) -> bool {
    let gost_alive = state
        .gost_child
        .lock()
        .ok()
        .and_then(|mut g| g.as_mut().map(|c| matches!(c.try_wait(), Ok(None))))
        .unwrap_or(false);
    let frpc_alive = state
        .proxy_frpc_child
        .lock()
        .ok()
        .and_then(|mut f| f.as_mut().map(|c| matches!(c.try_wait(), Ok(None))))
        .unwrap_or(false);
    gost_alive && frpc_alive
}

// ========== 命令: 停止共享上网 ==========
#[tauri::command]
fn stop_proxy_cmd(state: tauri::State<AppState>) -> ConnectResult {
    stop_proxy(&state);
    ConnectResult { ok: true, message: "已停止共享上网".into() }
}

// ========== 命令: 开启共享上网(仅 Windows) ==========
// 流程: 读取本机保存的服务器信息(server/port/token) -> 启动 gost 本地 SOCKS5
//       -> 写代理专用 frpc 配置, 把本地代理端口穿透到服务器 remote_port
#[cfg(windows)]
#[tauri::command]
async fn start_proxy(app: tauri::AppHandle, params: ProxyParams) -> ConnectResult {
    tauri::async_runtime::spawn_blocking(move || start_proxy_blocking(app, params))
        .await
        .unwrap_or_else(|e| ConnectResult { ok: false, message: format!("内部错误: {}", e) })
}

#[cfg(windows)]
fn start_proxy_blocking(app: tauri::AppHandle, params: ProxyParams) -> ConnectResult {
    let state = app.state::<AppState>();
    stop_proxy(&state); // 先停掉旧的

    // 1. 读取已保存的服务器信息(需先在被控端连接过一次)
    let profile_path = app_dir(&app).join("profile.json");
    let profile: serde_json::Value = match fs::read_to_string(&profile_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
    {
        Some(v) => v,
        None => {
            return ConnectResult {
                ok: false,
                message: "还没有服务器信息。请先到\"让别人控制我\"里连接一次, 获取服务器地址和密钥".into(),
            }
        }
    };
    let server = profile.get("server").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let sport = profile.get("port").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let token = profile.get("token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if server.is_empty() || sport.is_empty() || token.is_empty() {
        return ConnectResult {
            ok: false,
            message: "服务器信息不完整, 请先到\"让别人控制我\"里重新连接一次".into(),
        };
    }

    let dir = app_dir(&app);
    let _ = fs::create_dir_all(&dir);
    let local_proxy_port: u16 = 1080; // 本机 gost 监听端口(仅本地)

    // 2. 找到并启动 gost
    let gost_path = match resolve_bundled(&app, "gost.exe") {
        Some(p) => p,
        None => {
            return ConnectResult {
                ok: false,
                message: "BLOCKED:代理组件丢失,可能被安全软件删除,请将 PrivDesk 加入信任".into(),
            }
        }
    };
    // 用 HTTP 代理: Chrome 内核不支持带密码认证的 SOCKS 代理, 但支持 HTTP 代理认证。
    // 只上网页的场景 HTTP 代理(CONNECT 隧道)完全够用。
    let listen = format!(
        "http://{}:{}@127.0.0.1:{}",
        params.user, params.password, local_proxy_port
    );
    let mut gcmd = Command::new(&gost_path);
    gcmd.arg("-L").arg(&listen);
    hide_window(&mut gcmd);
    let gchild = match gcmd.spawn() {
        Ok(c) => c,
        Err(_) => {
            return ConnectResult {
                ok: false,
                message: "BLOCKED:代理组件无法启动,可能被安全软件拦截".into(),
            }
        }
    };
    // 短暂检查 gost 是否秒退
    thread::sleep(Duration::from_millis(400));
    {
        let mut g = gchild;
        if let Ok(Some(_)) = g.try_wait() {
            return ConnectResult {
                ok: false,
                message: "BLOCKED:代理组件启动后被安全软件终止,请将 PrivDesk 加入信任".into(),
            };
        }
        *state.gost_child.lock().unwrap() = Some(g);
    }

    // 3. 写代理专用 frpc 配置并启动(穿透 gost 端口 -> 服务器 remote_port)
    let frpc_path = match resolve_bundled(&app, FRPC_FILENAME) {
        Some(p) => p,
        None => {
            stop_proxy(&state);
            return ConnectResult {
                ok: false,
                message: "BLOCKED:连接组件丢失,可能被安全软件删除,请将 PrivDesk 加入信任".into(),
            };
        }
    };
    let config = format!(
        r#"serverAddr = "{}"
serverPort = {}

auth.method = "token"
auth.token = "{}"

transport.tls.enable = true

[[proxies]]
name = "gost-proxy-{}"
type = "tcp"
localIP = "127.0.0.1"
localPort = {}
remotePort = {}
"#,
        server, sport, token, params.remote_port, local_proxy_port, params.remote_port
    );
    let config_path = dir.join("frpc-proxy.toml");
    if let Err(e) = fs::write(&config_path, config) {
        stop_proxy(&state);
        return ConnectResult { ok: false, message: format!("写入代理配置失败: {}", e) };
    }

    let mut fcmd = Command::new(&frpc_path);
    fcmd.arg("-c").arg(&config_path);
    fcmd.stdout(Stdio::piped());
    fcmd.stderr(Stdio::piped());
    hide_window(&mut fcmd);
    let mut fchild = match fcmd.spawn() {
        Ok(c) => c,
        Err(_) => {
            stop_proxy(&state);
            return ConnectResult {
                ok: false,
                message: "BLOCKED:连接组件无法启动,可能被安全软件拦截".into(),
            };
        }
    };

    // 读 frpc 输出, 判断穿透是否成功(复用被控端那套关键字)
    let (tx, rx) = mpsc::channel::<FrpcEvent>();
    if let Some(stdout) = fchild.stdout.take() {
        let tx2 = tx.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                let l = line.to_lowercase();
                if l.contains("start proxy success") {
                    let _ = tx2.send(FrpcEvent::Success);
                    break;
                } else if l.contains("login to server failed")
                    || l.contains("authentication failed")
                    || l.contains("token in login")
                {
                    let _ = tx2.send(FrpcEvent::Failed("认证失败, 服务器密钥不匹配".into()));
                    break;
                } else if l.contains("port already used") || l.contains("already used") {
                    let _ = tx2.send(FrpcEvent::Failed(
                        "该代理端口已被占用, 请换一个端口重试".into(),
                    ));
                    break;
                } else if l.contains("connection refused")
                    || l.contains("no such host")
                    || l.contains("i/o timeout")
                    || l.contains("dial tcp")
                {
                    let _ = tx2.send(FrpcEvent::Failed(
                        "无法连接到服务器, 请检查服务器是否正常".into(),
                    ));
                    break;
                }
            }
        });
    }
    if let Some(stderr) = fchild.stderr.take() {
        let tx3 = tx.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let l = line.to_lowercase();
                if l.contains("error") || l.contains("failed") {
                    let _ = tx3.send(FrpcEvent::Failed("代理穿透失败, 请重试".into()));
                    break;
                }
            }
        });
    }

    *state.proxy_frpc_child.lock().unwrap() = Some(fchild);

    match rx.recv_timeout(Duration::from_secs(8)) {
        Ok(FrpcEvent::Success) => ConnectResult {
            ok: true,
            message: "共享上网已开启".into(),
        },
        Ok(FrpcEvent::Failed(reason)) => {
            stop_proxy(&state);
            ConnectResult { ok: false, message: reason }
        }
        Err(_) => {
            stop_proxy(&state);
            ConnectResult {
                ok: false,
                message: "开启超时, 请检查服务器与网络是否正常".into(),
            }
        }
    }
}

// 非 Windows: 共享上网暂不提供
#[cfg(not(windows))]
#[tauri::command]
async fn start_proxy(_app: tauri::AppHandle, _params: ProxyParams) -> ConnectResult {
    ConnectResult { ok: false, message: "当前系统暂不支持共享上网".into() }
}

// 在资源目录 / 数据目录里找捆绑的可执行文件, 返回可用路径
fn resolve_bundled(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    // 优先资源目录
    if let Ok(resource) = app.path().resource_dir() {
        let p = resource.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    // 兜底: 数据目录已有 / 从资源复制
    let dir = app_dir(app);
    let _ = fs::create_dir_all(&dir);
    let dest = dir.join(name);
    if dest.exists() {
        return Some(dest);
    }
    if let Ok(resource) = app.path().resource_dir() {
        let bundled = resource.join(name);
        if bundled.exists() && fs::copy(&bundled, &dest).is_ok() {
            return Some(dest);
        }
    }
    None
}

// ========== 命令: 检测远程桌面(RDP)是否已开启 ==========
#[cfg(windows)]
#[tauri::command]
fn check_rdp_enabled() -> bool {
    // 读取注册表 fDenyTSConnections, 0 表示允许远程桌面
    let mut cmd = Command::new("reg");
    cmd.args([
        "query",
        r"HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server",
        "/v",
        "fDenyTSConnections",
    ]);
    hide_window(&mut cmd);
    match cmd.output() {
        Ok(out) => {
            let s = String::from_utf8_lossy(&out.stdout);
            // 输出含 0x0 表示已开启
            s.contains("0x0")
        }
        Err(_) => false,
    }
}

// ========== 命令: 检测屏幕共享(VNC 5900)是否已开启 (macOS) ==========
#[cfg(not(windows))]
#[tauri::command]
fn check_rdp_enabled() -> bool {
    // macOS: 屏幕共享开启后会有进程监听 5900 端口
    // 用 lsof 检查本机 5900 是否处于监听状态
    let out = Command::new("lsof")
        .args(["-nP", "-iTCP:5900", "-sTCP:LISTEN"])
        .output();
    if let Ok(o) = out {
        if o.status.success() && !o.stdout.is_empty() {
            return true;
        }
    }
    false
}

// ========== 命令: 一键开启远程桌面(Windows, 需管理员权限会弹UAC) ==========
#[cfg(windows)]
#[tauri::command]
fn enable_rdp() -> ConnectResult {
    // 用 PowerShell 提权执行: 改注册表 + 开防火墙规则
    let ps_script = r#"
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name 'fDenyTSConnections' -Value 0;
Enable-NetFirewallRule -DisplayGroup '远程桌面' -ErrorAction SilentlyContinue;
Enable-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue;
"#;
    // 通过 Start-Process -Verb RunAs 触发 UAC 提权
    let outer = format!(
        "Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','{}'",
        ps_script.replace('\n', " ").replace('\'', "''")
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", &outer]);
    hide_window(&mut cmd);
    match cmd.status() {
        Ok(_) => ConnectResult {
            ok: true,
            message: "已请求开启远程桌面".into(),
        },
        Err(e) => ConnectResult {
            ok: false,
            message: format!("开启失败: {}", e),
        },
    }
}

// ========== 命令: 打开"屏幕共享"设置面板 (macOS) ==========
#[cfg(not(windows))]
#[tauri::command]
fn enable_rdp() -> ConnectResult {
    // macOS 无法可靠地静默开启屏幕共享(涉及系统权限/设密码),
    // 直接打开"系统设置 → 通用 → 共享"面板, 引导用户手动勾选"屏幕共享"。
    let r1 = Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preferences.sharing?Services_ScreenSharing")
        .status();
    if matches!(r1, Ok(s) if s.success()) {
        return ConnectResult {
            ok: true,
            message: "已打开共享设置, 请勾选\"屏幕共享\"".into(),
        };
    }
    // 退路: 打开"共享"偏好设置面板
    match Command::new("open")
        .arg("/System/Library/PreferencePanes/SharingPref.prefPane")
        .status()
    {
        Ok(_) => ConnectResult {
            ok: true,
            message: "已打开共享设置, 请勾选\"屏幕共享\"".into(),
        },
        Err(e) => ConnectResult {
            ok: false,
            message: format!("无法打开共享设置: {}", e),
        },
    }
}

// ========== 命令: 获取本机登录用户名(供远程方填写) ==========
#[tauri::command]
fn get_username() -> String {
    #[cfg(windows)]
    {
        std::env::var("USERNAME").unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        std::env::var("USER").unwrap_or_default()
    }
}

// ========== 命令: 打开日志文件夹 ==========
#[tauri::command]
fn open_log_dir(app: tauri::AppHandle) -> bool {
    let dir = log_dir(&app);
    #[cfg(windows)]
    {
        // 用资源管理器打开日志目录
        let mut cmd = Command::new("explorer");
        cmd.arg(&dir);
        hide_window(&mut cmd);
        // explorer 打开目录时返回码可能非 0, 这里不以状态码判定成功
        cmd.spawn().is_ok()
    }
    #[cfg(not(windows))]
    {
        // macOS: 用 Finder 打开目录
        Command::new("open").arg(&dir).spawn().is_ok()
    }
}

fn stop_frpc(state: &tauri::State<AppState>) {
    let mut guard = state.frpc_child.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

// 显示并聚焦主窗口
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState {
            frpc_child: Mutex::new(None),
            gost_child: Mutex::new(None),
            proxy_frpc_child: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            connect,
            disconnect,
            is_connected,
            set_autostart,
            get_autostart,
            save_profile,
            load_profile,
            update_tray_color,
            check_rdp_enabled,
            enable_rdp,
            open_log_dir,
            get_username,
            get_platform,
            probe_remote,
            remote_connect,
            start_proxy,
            stop_proxy_cmd,
            proxy_status
        ])
        .setup(|app| {
            // ---------- 创建系统托盘 ----------
            let show_item = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("PrivDesk - 私有远程桌面")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => {
                        // 退出前停掉 frpc 和代理
                        let state = app.state::<AppState>();
                        stop_frpc(&state);
                        stop_proxy(&state);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键单击托盘图标 -> 显示主窗口
                    if let TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building PrivDesk")
        .run(|app_handle, event| {
            // 程序退出时, 清理 frpc / 代理 子进程, 避免残留占用端口
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app_handle.state::<AppState>();
                stop_frpc(&state);
                stop_proxy(&state);
            }
        });
}
