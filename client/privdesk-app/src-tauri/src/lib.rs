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

// 用 netstat 检查本机某端口是否处于 TCP LISTEN 状态 (类 Unix / macOS)
// 说明:
//   1. GUI 启动的 .app 不继承 shell 的 PATH, 故用绝对路径 /usr/bin/netstat。
//   2. macOS 屏幕共享服务 screensharingd 以 root 身份监听 5900,
//      普通用户用 `lsof -i` 看不到 root 拥有的 socket, 会误判为未开启;
//      而 `netstat -an` 无需权限即可列出全系统所有监听端口, 更可靠。
#[cfg(not(windows))]
fn port_listening(port: u16) -> bool {
    let suffix = format!(".{}", port); // 本地地址列形如 *.5900 / 127.0.0.1.5900
    if let Ok(o) = Command::new("/usr/bin/netstat")
        .args(["-an", "-p", "tcp"])
        .output()
    {
        let s = String::from_utf8_lossy(&o.stdout);
        for line in s.lines() {
            let cols: Vec<&str> = line.split_whitespace().collect();
            // 列: Proto Recv-Q Send-Q Local-Address Foreign-Address (state)
            if cols.last() == Some(&"LISTEN") {
                if let Some(local) = cols.get(3) {
                    if local.ends_with(&suffix) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

// ========== 命令: 检测屏幕共享(VNC 5900)是否已开启 (macOS) ==========
#[cfg(not(windows))]
#[tauri::command]
fn check_rdp_enabled() -> bool {
    // 主检测: netstat 列出全系统监听端口(不受属主/权限限制)
    if port_listening(LOCAL_PORT) {
        return true;
    }
    // 退路: lsof(绝对路径, 避免 GUI 无 PATH 找不到命令)
    if let Ok(o) = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-iTCP:5900", "-sTCP:LISTEN"])
        .output()
    {
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
            get_platform
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
                        // 退出前停掉 frpc
                        let state = app.state::<AppState>();
                        stop_frpc(&state);
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
            // 程序退出时, 清理 frpc 子进程, 避免残留占用端口
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app_handle.state::<AppState>();
                stop_frpc(&state);
            }
        });
}
