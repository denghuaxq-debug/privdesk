#!/bin/bash
#==============================================================================
#  PrivDesk · Mac 一键打包 (双击运行)
#
#  使用步骤 (在 Mac 上):
#    1. 解压收到的压缩包, 得到 PrivDesk 文件夹
#    2. 进入 PrivDesk/mac打包包/ , 双击本文件 "一键打包.command"
#       (若双击提示无法打开: 右键 → 打开 → 再点"打开")
#    3. 按提示等待, 完成后 dmg 在 PrivDesk/dist-mac/ 里
#
#  frp 的 Mac 二进制已随包预置 (frp预置/), 无需联网下载。
#  但 Rust 和 npm 依赖仍需联网安装 (Mac 平台专用, 无法在 Windows 预置)。
#  无需 Apple 开发者账号。产出为 universal (Intel+Apple芯片) 未签名 dmg。
#==============================================================================

set -e

# ---------- 定位目录 ----------
# 本脚本在  PrivDesk/mac打包包/ 下, 项目根目录是它的上一级
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$ROOT/client/privdesk-app"
PREBUILT="$SCRIPT_DIR/frp预置"

# ---------- 自愈: 去掉隔离属性 + 补可执行权限 ----------
# 从 Windows 压缩过来会丢失这些, 在这里统一修好, 避免后续步骤被拦。
xattr -dr com.apple.quarantine "$SCRIPT_DIR" 2>/dev/null || true
chmod +x "$PREBUILT/frpc_amd64" "$PREBUILT/frpc_arm64" 2>/dev/null || true

# ---------- 颜色 ----------
G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[0;34m'; N='\033[0m'
info(){ echo -e "${G}[✓]${N} $1"; }
warn(){ echo -e "${Y}[!]${N} $1"; }
err(){ echo -e "${R}[✗]${N} $1"; }
step(){ echo -e "\n${B}==== $1 ====${N}"; }

echo -e "${B}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║      PrivDesk · Mac 一键打包          ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${N}"

# ---------- 0. 校验项目结构 ----------
if [ ! -d "$APP_DIR/src-tauri" ]; then
    err "目录结构不对, 没找到 $APP_DIR/src-tauri"
    err "请确认本脚本位于 PrivDesk/mac打包包/ 下, 且整个 PrivDesk 文件夹完整。"
    read -p "按回车键退出..." _; exit 1
fi

# ---------- 1. 检查构建环境 ----------
step "检查构建环境"

# Xcode 命令行工具 (含 lipo / clang)
if ! xcode-select -p >/dev/null 2>&1; then
    warn "未安装 Xcode 命令行工具, 正在唤起安装窗口..."
    xcode-select --install || true
    err "请在弹窗里点'安装', 装完后重新双击本脚本。"
    read -p "按回车键退出..." _; exit 1
fi
info "Xcode 命令行工具已就绪"

# Rust
if ! command -v cargo >/dev/null 2>&1; then
    source "$HOME/.cargo/env" 2>/dev/null || true
fi
if ! command -v cargo >/dev/null 2>&1; then
    warn "未安装 Rust, 正在自动安装..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
fi
info "Rust 已就绪: $(cargo --version)"
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null 2>&1 || true
info "已添加 aarch64 / x86_64 编译目标"

# Node
if ! command -v node >/dev/null 2>&1; then
    err "未安装 Node.js。请先去 https://nodejs.org 装 LTS 版 (或 brew install node), 再重跑。"
    read -p "按回车键退出..." _; exit 1
fi
info "Node 已就绪: $(node --version)"

# ---------- 2. 合成 universal frpc (优先用预置二进制) ----------
step "准备 frpc (universal)"
DEST="$APP_DIR/src-tauri/frpc"
if [ -f "$DEST" ] && lipo -info "$DEST" 2>/dev/null | grep -q "x86_64 arm64"; then
    info "已存在 universal frpc, 跳过"
elif [ -f "$PREBUILT/frpc_amd64" ] && [ -f "$PREBUILT/frpc_arm64" ]; then
    info "使用随包预置的 frp 二进制 (无需联网)"
    lipo -create -output "$DEST" "$PREBUILT/frpc_amd64" "$PREBUILT/frpc_arm64"
    chmod +x "$DEST"
    info "已合成 universal frpc:"
    lipo -info "$DEST"
else
    warn "没找到预置的 frp 二进制, 改为联网下载..."
    V=0.69.1; base="https://github.com/fatedier/frp/releases/download/v${V}"
    curl -fL "${base}/frp_${V}_darwin_amd64.tar.gz" -o /tmp/frp_amd64.tgz
    curl -fL "${base}/frp_${V}_darwin_arm64.tar.gz" -o /tmp/frp_arm64.tgz
    tar -xzf /tmp/frp_amd64.tgz -C /tmp; tar -xzf /tmp/frp_arm64.tgz -C /tmp
    lipo -create -output "$DEST" "/tmp/frp_${V}_darwin_amd64/frpc" "/tmp/frp_${V}_darwin_arm64/frpc"
    chmod +x "$DEST"
    info "已合成 universal frpc"
fi

# ---------- 3. 装依赖 + 打包 ----------
step "安装依赖并打包 (首次较慢, 请耐心等 10~30 分钟)"
cd "$APP_DIR"
npm install
npx tauri build --target universal-apple-darwin

# ---------- 4. 收集 dmg ----------
step "收集产物"
mkdir -p "$ROOT/dist-mac"
found=$(find "$APP_DIR/src-tauri/target/universal-apple-darwin/release/bundle/dmg" -name "*.dmg" 2>/dev/null)
if [ -z "$found" ]; then
    err "没找到 dmg, 打包可能失败, 请向上翻看报错。"
    read -p "按回车键退出..." _; exit 1
fi
cp $found "$ROOT/dist-mac/"
echo ""
info "🎉 打包完成! dmg 在这里:"
ls -lh "$ROOT/dist-mac/"*.dmg
echo ""
warn "此包未做苹果签名, 用户首次打开需'右键(按住Control点击) → 打开'。"
warn "使用说明见  发布/Mac端使用说明.txt"
echo ""
read -p "按回车键关闭窗口..." _
