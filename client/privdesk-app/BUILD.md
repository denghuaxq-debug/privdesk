# 编译与打包说明

## 前置条件

- **Node.js** 18+（用于 `@tauri-apps/cli`）
- **Rust** 1.70+（含 `cargo`）
- **WebView2 Runtime**（Windows 10/11 通常已自带）
- 首次编译需要联网（下载 crates 依赖）

## 快速开始

```bash
cd client/privdesk-app
npm install          # 安装 Tauri CLI
npx tauri build      # 编译 release 并生成 NSIS 安装包
```

产物路径：

```
client/privdesk-app/src-tauri/target/release/privdesk.exe
client/privdesk-app/src-tauri/target/release/bundle/nsis/PrivDesk_<版本>_x64-setup.exe
```

## 第三方二进制依赖（重要）

`src-tauri/tauri.windows.conf.json` 的 `bundle.resources` 声明了 5 个必须存在的二进制，
**缺失任何一个都会导致编译失败**：

```
error: resource path `frpc.exe` doesn't exist
```

这些文件已提交进仓库（通过 `.gitignore` 里 `!client/privdesk-app/src-tauri/*.exe` 例外规则），
**正常 clone 即可直接编译，无需额外操作**。

| 文件 | 大小 | 用途 | 版本 | 许可证 |
|---|---|---|---|---|
| `frpc.exe` | 16.1 MB | frp 内网穿透客户端 | 0.69.1 | Apache-2.0 |
| `tvnviewer.exe` | 1.0 MB | TightVNC Viewer（Mac/VNC 画面） | 2.8.88.0 | GPL-2.0 |
| `gost.exe` | 46.5 MB | 共享上网（SOCKS5 代理） | - | MIT |
| `wireguard.exe` | 8.8 MB | WireGuard 全局共享 | 1.1 | GPL-2.0 |
| `wg.exe` | 0.13 MB | WireGuard 命令行 | 1.0.20260223 | GPL-2.0 |

完整的许可证文本与源码地址见：[`src-tauri/licenses/第三方开源声明.txt`](src-tauri/licenses/第三方开源声明.txt)

### 升级组件时

替换文件后请同步更新上表的版本号，并确认新版本许可证仍允许再分发。
注意：二进制进 git 后每次升级都会增加仓库体积，属预期行为。

## 常见问题

### 1. `resource path 'xxx.exe' doesn't exist`

检查 `src-tauri/` 下 5 个 exe 是否都在。若缺失，可从任意已安装的 PrivDesk
目录（`%LOCALAPPDATA%\PrivDesk\`）复制补齐。

### 2. macOS 打包

`.dmg` 只能在 macOS 上构建。仓库提供了 GitHub Actions 流水线
（`.github/workflows/build-mac.yml`）借用云端 Mac 打包，或使用
`发布/打包Mac一键打包.command`。

### 3. `gen/schemas/*.json` 出现改动

这是 `cargo check` 自动生成的产物，**不要提交**。编译后请执行：

```bash
git checkout -- client/privdesk-app/src-tauri/gen/schemas/
```

## 版本号说明

版本号需要同时改两处，保持一致：

- `client/privdesk-app/src-tauri/tauri.conf.json` → `version`
- `client/privdesk-app/src-tauri/Cargo.toml` → `version`
