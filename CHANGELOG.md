# 更新日志

PrivDesk 的版本变更记录。版本号取自 `client/privdesk-app/src-tauri/tauri.conf.json`，
打 `v*` 形式的 tag 会触发 GitHub Actions 自动编译 macOS `.dmg` 与 Windows `.exe`
并发布到 GitHub Releases。

## [1.2.0] - 2026-11-20

把历史上分叉的两条开发线合并成一个版本：Gitee 线（1.0.4，含 QUIC / RDP 环境检测 /
无人值守等功能）与 GitHub 线（1.1.1，含 macOS 屏幕共享检测修复 / 依赖锁）。
两者此前各改各的，本次用一次真实 merge 合并，避免覆盖推送丢掉任一侧的修复。

### 新增

- **QUIC 传输协议**：被控端可选择用 QUIC 而非 TCP 建立隧道（服务端 `quicBindPort`，
  实测建连快约 96ms / 27.7%）。切换协议不会自动改端口，避免与任意 `quicBindPort` 冲突；
  HTTP 共享与全局共享仍走 TCP。
- **RDP 环境检测面板**：读取并展示系统版本（`Windows 11 Pro 26H2` 这种，Win11 由 build
  号而非 ProductName 判定）、RDP Wrapper 是否安装/是否监听/是否支持当前 termsrv 版本，
  并给出建议文案。面板只在系统原生不支持远程桌面（家庭版等）时才展示。
- **无人值守（开机即连，无需登录）**：Windows 上「开机自启」不再写
  `HKCU\...\Run`（该键要等用户登录进桌面才由资源管理器触发），改为注册 SYSTEM 身份、
  `AtStartup` 触发器的计划任务，开机后约 10 秒即建立隧道，停在登录界面也能远程连入。
  设置状态用 app 目录下的 marker 文件记录（非管理员查不到计划任务）。
- **登录自启开关**：与无人值守相互独立。开启后用户登录进桌面时自动打开界面；
  启动时会用当前进程路径重写 Run 键，避免装新版本或换目录后指向已不存在的旧 exe。
- **自动重启（看门狗）**：无人值守任务增加 `-RestartCount 999` +
  每分钟重复的看门狗触发器。实测仅靠 `RestartOnFailure` 在任务以非 0 退出码结束时
  并不会重启，加触发器后 frpc 被杀约 36 秒内自动补起，且运行中不会产生重复实例。

### 修复

- **远程桌面就绪检测增强**：从「只看注册表 `fDenyTSConnections`」改为三重校验
  （注册表精确解析 `REG_DWORD` + `TermService` 服务状态 + 3389 端口是否真的在监听）。
  旧的 `s.contains("0x0")` 写法会被同行其它键值命中而误判。
- **RDP Wrapper 安装判定**：目录里有 `rdpwrap.dll` 不等于已安装。改为要求
  「文件存在」外加「服务已注册 / IFEO 已注入 / System32 有 dll」任意一项，
  避免残留文件被误报成已安装。
- **macOS 屏幕共享检测**：改用三级探测（先直接 TCP 连 `5900`，再用
  `/usr/sbin/netstat` 查 LISTEN，最后退到 `/usr/bin/lsof`），修复 GUI 环境无 PATH
  时检测一直失败的问题。
- **macOS 构建**：锁定 `time = "=0.3.51"`，规避 0.3.52 对 `Parsable::parse` 的破坏性
  改动导致 `cookie 0.18.1` 编译失败（E0061）。
- **默认主题**：新安装默认纯黑外观。

### 构建与发布

- 提交了打包必需的 5 个第三方二进制（`frpc.exe` / `tvnviewer.exe` / `gost.exe` /
  `wireguard.exe` / `wg.exe`），CI 无需额外下载即可打包。
- 新增 `client/privdesk-app/BUILD.md`：编译步骤、第三方组件版本与许可证表、常见问题。
- 新增 `.github/workflows/build-windows.yml`，与既有的 `build-mac.yml` 对应：
  打 tag 时同时产出 Windows NSIS 安装包与 macOS dmg 并发布到 Release。

## [1.1.1] - 2026-07-01

- GitHub 线最后一个版本，见 `v1.1.1` tag。

## [1.1.0] - 2026-07-01

- GitHub 线版本（`v1.1.0` tag）。

## [1.0.4] - 2026-09-22

- Gitee 线最后一个独立版本（`581e5df` "stabilize WinNAT global sharing and tabs"），
  此后 Gitee 线的新功能都汇总进了 1.2.0。

## [1.0.1] - 2026-06-30

- 修复 mac universal 构建（`minimumSystemVersion` 11.0）。

## [1.0.0] - 2026-06-30

- 首发：Windows + macOS 被控端。
