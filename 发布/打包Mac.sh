#!/bin/bash
#==============================================================================
#  PrivDesk · Mac 一键打包脚本 (在任意一台 Mac 上运行, 产出 .dmg)
#
#  用法:
#    1. 把整个 PrivDesk 项目拷到这台 Mac (U盘/git clone 都行)
#    2. 打开"终端", cd 到项目根目录
#    3. 运行:  bash 发布/打包Mac.sh
#    4. 跑完后 dmg 会复制到项目根目录的 dist-mac/ 里
#
#  无需 Apple 开发者账号。产出为 universal (Intel + Apple 芯片通用) 未签名包。
#==============================================================================

set -e

FRP_VERSION="0.69.1"
APP_DIR="client/privdesk-app"

# ---------- 颜色 ----------
G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[0;34m'; N='\033[0m'
info(){ echo -e "${G}[✓]${N} $1"; }
warn(){ echo -e "${Y}[!]${N} $1"; }
err(){ echo -e "${R}[✗]${N} $1"; }
step(){ echo -e "\n${B}==== $1 ====${N}"; }

# ---------- 0. 确认在项目根目录 ----------
if [ ! -d "$APP_DIR/src-tauri" ]; then
    err "没找到 $APP_DIR/src-tauri"
    err "请先 cd 到 PrivDesk 项目根目录再运行本脚本。"
    exit 1
fi

# ---------- 1. 检查/安装 基础工具 ----------
step "检查构建环境"

# Xcode 命令行工具 (含 lipo / clang, 编译 Rust 需要)
if ! xcode-select -p >/dev/null 2>&1; then
    warn "未安装 Xcode 命令行工具, 正在唤起安装窗口..."
    xcode-select --install || true
    err "请在弹出的窗口里点'安装', 装完后重新运行本脚本。"
    exit 1
fi
info "Xcode 命令行工具已就绪"

# Rust (cargo)
if ! command -v cargo >/dev/null 2>&1; then
    warn "未安装 Rust, 正在自动安装 (官方脚本)..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    # shellcheck disable=SC1090
    source "$HOME/.cargo/env"
fi
command -v cargo >/dev/null 2>&1 || { source "$HOME/.cargo/env" 2>/dev/null || true; }
info "Rust 已就绪: $(cargo --version)"

# 两个 macOS 编译目标 (合成 universal 需要)
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null 2>&1 || true
info "已添加 aarch64 / x86_64 编译目标"

# Node (装 tauri cli 需要)
if ! command -v node >/dev/null 2>&1; then
    err "未安装 Node.js。请先安装: https://nodejs.org (装 LTS 版), 再重跑本脚本。"
    err "或用 Homebrew:  brew install node"
    exit 1
fi
info "Node 已就绪: $(node --version)"

# ---------- 2. 下载 frpc 并用 lipo 合成 universal ----------
step "准备 frpc (universal)"
cd "$APP_DIR"

if [ -f "src-tauri/frpc" ] && lipo -info src-tauri/frpc 2>/dev/null | grep -q "x86_64 arm64"; then
    info "已存在 universal frpc, 跳过下载"
else
    base="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}"
    info "下载 frp ${FRP_VERSION} (darwin amd64 / arm64)..."
    curl -fL "${base}/frp_${FRP_VERSION}_darwin_amd64.tar.gz" -o /tmp/frp_amd64.tar.gz
    curl -fL "${base}/frp_${FRP_VERSION}_darwin_arm64.tar.gz" -o /tmp/frp_arm64.tar.gz
    tar -xzf /tmp/frp_amd64.tar.gz -C /tmp
    tar -xzf /tmp/frp_arm64.tar.gz -C /tmp
    lipo -create -output src-tauri/frpc \
        "/tmp/frp_${FRP_VERSION}_darwin_amd64/frpc" \
        "/tmp/frp_${FRP_VERSION}_darwin_arm64/frpc"
    chmod +x src-tauri/frpc
    info "已合成 universal frpc:"
    lipo -info src-tauri/frpc
fi

# ---------- 3. 装前端依赖 + 打包 ----------
step "安装依赖并打包 (首次较慢, 请耐心等)"
npm install
npx tauri build --target universal-apple-darwin

# ---------- 4. 收集 dmg ----------
step "收集产物"
cd - >/dev/null
mkdir -p dist-mac
found=$(find "$APP_DIR/src-tauri/target/universal-apple-darwin/release/bundle/dmg" -name "*.dmg" 2>/dev/null)
if [ -z "$found" ]; then
    err "没找到 dmg, 打包可能失败, 请翻看上面的报错。"
    exit 1
fi
cp $found dist-mac/
echo ""
info "🎉 打包完成! dmg 在这里:"
ls -lh dist-mac/*.dmg
echo ""
warn "提示: 此包未做苹果签名, 用户首次打开需'右键(Control 点击) → 打开'。"
warn "详见 发布/Mac端使用说明.txt"
