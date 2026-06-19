#!/bin/bash
#==============================================================================
#  PrivDesk - 私有远程桌面服务
#  服务端卸载脚本
#==============================================================================

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }
title() { echo -e "\n${BLUE}==== $1 ====${NC}"; }

INSTALL_DIR="/usr/local/privdesk"
SERVICE_NAME="privdesk-server"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

#==============================================================================
title "PrivDesk 服务端卸载"
#==============================================================================

# 检查 root 权限
if [ "$(id -u)" != "0" ]; then
    error "请使用 root 权限运行 (sudo bash $0)"
    exit 1
fi

# 检查是否已安装
if [ ! -d "$INSTALL_DIR" ] && [ ! -f "$SERVICE_FILE" ]; then
    warn "未检测到 PrivDesk 安装, 无需卸载。"
    exit 0
fi

# 确认操作
echo ""
warn "即将卸载 PrivDesk 服务端, 这将:"
echo "    - 停止并删除服务"
echo "    - 删除程序和配置文件 ($INSTALL_DIR)"
echo "    - 删除连接信息文件"
echo ""
read -p "确认卸载吗? (输入 yes 继续): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
    info "已取消卸载。"
    exit 0
fi

# 1. 停止并禁用服务
title "停止服务"
if systemctl list-unit-files 2>/dev/null | grep -q "${SERVICE_NAME}"; then
    systemctl stop "${SERVICE_NAME}" 2>/dev/null
    systemctl disable "${SERVICE_NAME}" 2>/dev/null
    info "服务已停止并禁用"
else
    warn "未找到服务, 跳过"
fi

# 2. 删除 systemd 服务文件
if [ -f "$SERVICE_FILE" ]; then
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload
    info "服务文件已删除"
fi

# 3. 删除安装目录
if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    info "程序及配置文件已删除"
fi

# 4. 清理可能残留的进程
pkill -x "${SERVICE_NAME}" 2>/dev/null || true

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     PrivDesk 服务端已完全卸载           ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""
warn "提示: 云服务器安全组里放行的端口规则未自动删除,"
warn "      如不再使用, 可手动到云控制台移除。"
