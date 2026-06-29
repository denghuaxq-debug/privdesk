# PrivDesk · 私有远程桌面

> 数据只走你自己的服务器，私密、安全、自主掌控的远程桌面工具。

## 简介

PrivDesk 让你通过自己的云服务器，安全地远程控制自己的电脑。所有数据只经过你自己的服务器，不经过任何第三方。

- **客户端**：Tauri 2 (HTML/CSS/JS + Rust)，Windows 桌面应用 + macOS 桌面应用
- **服务端**：bash 一键部署脚本 + frps 中转
- **底层**：基于 frp 内网穿透

> **平台说明**：Windows 被控端转发远程桌面 (RDP 3389)；macOS 被控端转发系统「屏幕共享」(VNC 5900)。服务端、连接码格式完全通用，无需区分平台。

## 项目结构

```
client/privdesk-app/      客户端源码 (Tauri 2)
  ├── src/                前端: index.html / styles.css / app.js
  └── src-tauri/          后端: Rust (src/lib.rs 核心逻辑)
server/                   服务端部署脚本
发布/                     文档 (使用说明书 / 快速开始 / 维护备忘)
```

## ⚠️ 注意：二进制文件未包含

为保持仓库整洁，以下文件**未上传**，需自行补充后才能构建/使用：

- `client/privdesk-app/src-tauri/frpc.exe` — 客户端内置的 frp 客户端 (Windows)
- `client/privdesk-app/src-tauri/frpc` — 客户端内置的 frp 客户端 (macOS, universal)
- `server/privdesk-server-installer/privdesk-server_amd64` / `_arm64` — 服务端 frps 程序

从 [frp 官方releases](https://github.com/fatedier/frp/releases) 下载 v0.69.1 对应文件即可。
> macOS 的 `frpc` 需把 `darwin_amd64` 与 `darwin_arm64` 用 `lipo` 合成 universal；GitHub Actions 工作流已自动完成这一步。

## 构建

详见 `发布/项目维护备忘.txt`，核心命令：

```bash
# 开发
cd client/privdesk-app/src-tauri && cargo build

# Windows 打包 (在 Windows 上)
cd client/privdesk-app && npx tauri build

# macOS 打包 (.dmg)
# 本仓库无需手动操作: push 一个 v* tag 或在 GitHub Actions 手动触发
# 「Build macOS (.dmg)」工作流, 即在云端 macOS 主机自动产出 universal .dmg。
# 若手头有 Mac, 也可本地: 先用 lipo 合成 frpc 放到 src-tauri/, 再:
cd client/privdesk-app && npx tauri build --target universal-apple-darwin
```

## 功能

连接管理、连接码导入、连接信息缓存、系统托盘、开机自启+自动连接(无人值守)、
远程桌面检测+一键开启、主题系统(3外观×8色)、被安全软件拦截引导、服务端连接码闭环。

## 已知限制

远程控制+内网穿透类软件会被杀毒软件/Windows智能应用控制(SAC)拦截，这是品类通病。
程序内置"被拦截引导"提示用户放行。公开发布需 EV 代码签名证书。

---
本项目基于 [frp](https://github.com/fatedier/frp) (Apache 2.0) 构建。
