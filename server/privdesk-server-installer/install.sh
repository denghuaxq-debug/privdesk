#!/bin/bash
#==============================================================================
#  PrivDesk - 私有远程桌面服务
#  服务端一键部署脚本
#  适用: Linux (CentOS / Ubuntu / Debian), x86_64 / ARM64
#==============================================================================

set -e

# ---------- 颜色输出 ----------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }
title() { echo -e "\n${BLUE}==== $1 ====${NC}"; }

PRODUCT="PrivDesk"
VERSION="1.0.0"
INSTALL_DIR="/usr/local/privdesk"
SERVICE_NAME="privdesk-server"
BIN_NAME="privdesk-server"

#==============================================================================
echo -e "${BLUE}"
echo "  ____       _      ____            _    "
echo " |  _ \ _ __(_)_   _|  _ \  ___  ___| | __"
echo " | |_) | '__| \ \ / / | | |/ _ \/ __| |/ /"
echo " |  __/| |  | |\ V /| |_| |  __/\__ \   < "
echo " |_|   |_|  |_| \_/ |____/ \___||___/_|\_\\"
echo -e "${NC}"
echo "  PrivDesk 私有远程桌面服务 - 服务端部署 v${VERSION}"
#==============================================================================

# ---------- 0. 检查 root 权限 ----------
if [ "$(id -u)" != "0" ]; then
    error "请使用 root 权限运行 (sudo bash $0)"
    exit 1
fi

# ---------- 1. 检测系统架构 ----------
title "检测系统环境"
ARCH=$(uname -m)
case "$ARCH" in
    x86_64)  PD_ARCH="amd64" ;;
    aarch64) PD_ARCH="arm64" ;;
    *) error "不支持的架构: $ARCH (仅支持 x86_64 / ARM64)"; exit 1 ;;
esac
info "系统架构: $ARCH"

# ---------- 1.5 检测是否已安装 ----------
if [ -d "$INSTALL_DIR" ] || [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]; then
    warn "检测到 PrivDesk 已经安装过了。"
    echo "  继续安装将【覆盖】旧的安装和配置 (连接密钥会重新生成)。"
    read -p "是否覆盖重装? (输入 yes 继续, 其他键取消): " REINSTALL
    if [ "$REINSTALL" != "yes" ]; then
        info "已取消。如需先卸载, 可运行: bash uninstall.sh"
        exit 0
    fi
    # 先停掉旧服务, 避免文件占用和端口冲突
    systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
    info "已停止旧服务, 准备覆盖重装"
fi

# ---------- 2. 交互式配置 ----------
title "配置参数 (直接回车使用默认值)"
read -p "服务连接端口 [默认 7000]: " BIND_PORT
BIND_PORT=${BIND_PORT:-7000}
read -p "管理面板端口 [默认 7500]: " DASH_PORT
DASH_PORT=${DASH_PORT:-7500}
read -p "管理面板用户名 [默认 admin]: " DASH_USER
DASH_USER=${DASH_USER:-admin}

# 管理面板密码: 可自定义, 直接回车则自动生成强密码
echo ""
echo "管理面板密码: 可自己设置, 或直接回车自动生成强密码"
read -p "请输入面板密码 [回车=自动生成]: " DASH_PWD
if [ -z "$DASH_PWD" ]; then
    DASH_PWD=$(head -c 18 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 20)
    info "已自动生成面板密码"
else
    info "已使用您自定义的面板密码"
fi

# 连接密钥(token)始终自动生成, 保证足够强度
TOKEN=$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)

# ---------- 3. 安装程序 (使用随包附带, 无需联网) ----------
title "安装 ${PRODUCT} 服务端"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_BIN="${SCRIPT_DIR}/${BIN_NAME}_${PD_ARCH}"

if [ ! -f "$LOCAL_BIN" ]; then
    error "未找到程序文件: $LOCAL_BIN"
    error "请确认 ${BIN_NAME}_${PD_ARCH} 与本脚本在同一目录"
    exit 1
fi

mkdir -p "$INSTALL_DIR"
cp "$LOCAL_BIN" "$INSTALL_DIR/${BIN_NAME}"
chmod +x "$INSTALL_DIR/${BIN_NAME}"
info "已安装到 $INSTALL_DIR"

# ---------- 4. 生成配置文件 ----------
title "生成配置文件"
cat > "$INSTALL_DIR/config.toml" << EOF
# PrivDesk 服务端配置 - 自动生成
bindPort = ${BIND_PORT}

auth.method = "token"
auth.token = "${TOKEN}"

webServer.addr = "0.0.0.0"
webServer.port = ${DASH_PORT}
webServer.user = "${DASH_USER}"
webServer.password = "${DASH_PWD}"
EOF
info "配置文件已生成"

# ---------- 5. 设置开机自启 ----------
title "设置开机自启服务"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" << EOF
[Unit]
Description=PrivDesk Private Remote Desktop Server
After=network.target

[Service]
Type=simple
ExecStart=${INSTALL_DIR}/${BIN_NAME} -c ${INSTALL_DIR}/config.toml
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1
systemctl restart "${SERVICE_NAME}"
sleep 2

if systemctl is-active --quiet "${SERVICE_NAME}"; then
    info "服务已启动并设为开机自启"
else
    error "服务启动失败,请运行: systemctl status ${SERVICE_NAME}"
    exit 1
fi

# ---------- 6. 配置防火墙 ----------
title "配置防火墙"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "active"; then
    ufw allow ${BIND_PORT}/tcp >/dev/null 2>&1
    ufw allow ${DASH_PORT}/tcp >/dev/null 2>&1
    info "ufw 已放行端口"
elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
    firewall-cmd --permanent --add-port=${BIND_PORT}/tcp >/dev/null 2>&1
    firewall-cmd --permanent --add-port=${DASH_PORT}/tcp >/dev/null 2>&1
    firewall-cmd --reload >/dev/null 2>&1
    info "firewalld 已放行端口"
else
    warn "未检测到活动防火墙,跳过"
fi
warn "云服务器请记得在【控制台安全组】放行端口!"

# ---------- 7. 保存连接信息到文件 ----------
title "保存连接信息"
# 强制获取 IPv4 公网地址 (frp 走 IPv4, 且兼容性最好), 多个源备用
PUBLIC_IP=$(curl -4 -fsSL --max-time 5 ifconfig.me 2>/dev/null)
[ -z "$PUBLIC_IP" ] && PUBLIC_IP=$(curl -4 -fsSL --max-time 5 ip.sb 2>/dev/null)
[ -z "$PUBLIC_IP" ] && PUBLIC_IP=$(curl -4 -fsSL --max-time 5 api.ipify.org 2>/dev/null)
[ -z "$PUBLIC_IP" ] && PUBLIC_IP=$(curl -4 -fsSL --max-time 5 ipinfo.io/ip 2>/dev/null)
# 去掉可能的空白字符
PUBLIC_IP=$(printf '%s' "$PUBLIC_IP" | tr -d '[:space:]')
[ -z "$PUBLIC_IP" ] && PUBLIC_IP="<你的服务器公网IP>"

# 生成连接码: PRIVDESK- + base64(JSON), 客户端可一键导入
# remote 远程端口给默认值 7002, 用户在客户端可自行修改
CONN_JSON="{\"server\":\"${PUBLIC_IP}\",\"port\":\"${BIND_PORT}\",\"token\":\"${TOKEN}\",\"remote\":\"7002\"}"
CONN_CODE="PRIVDESK-$(printf '%s' "$CONN_JSON" | base64 | tr -d '\n')"

INFO_FILE="${SCRIPT_DIR}/connection-info.txt"
GEN_TIME=$(date '+%Y-%m-%d %H:%M:%S')
cat > "$INFO_FILE" << EOF
==================================================
  PrivDesk 连接信息
  生成时间: ${GEN_TIME}
==================================================

【连接码】(推荐: 复制到客户端"粘贴连接码"框, 一键导入)
${CONN_CODE}

【手动填写信息】(填入 PrivDesk 客户端)
  服务器地址 : ${PUBLIC_IP}
  连接端口   : ${BIND_PORT}
  认证密钥   : ${TOKEN}

【管理面板】
  地址 : http://${PUBLIC_IP}:${DASH_PORT}
  账号 : ${DASH_USER}
  密码 : ${DASH_PWD}

【常用命令】
  查看状态 : systemctl status ${SERVICE_NAME}
  重启服务 : systemctl restart ${SERVICE_NAME}
  停止服务 : systemctl stop ${SERVICE_NAME}
  查看日志 : journalctl -u ${SERVICE_NAME} -f

==================================================
  ⚠ 本文件含认证密钥, 请妥善保管, 勿外泄!
==================================================
EOF
chmod 600 "$INFO_FILE"
info "连接信息已保存到当前目录的文件: connection-info.txt"
info "查看命令: cat connection-info.txt"

# ---------- 8. 屏幕输出结果 ----------
clear
echo -e "${GREEN}"
echo "╔════════════════════════════════════════════════════╗"
echo "║       🎉 PrivDesk 服务端部署成功!                    ║"
echo "╚════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "${GREEN}★ 推荐: 复制下面的【连接码】, 粘贴到 PrivDesk 客户端一键导入 ★${NC}"
echo "──────────────────────────────────────────────"
echo -e "${YELLOW}${CONN_CODE}${NC}"
echo "──────────────────────────────────────────────"
echo ""
echo "或手动填写以下【连接信息】:"
echo "──────────────────────────────────────────────"
echo -e "  服务器地址 : ${YELLOW}${PUBLIC_IP}${NC}"
echo -e "  连接端口   : ${YELLOW}${BIND_PORT}${NC}"
echo -e "  认证密钥   : ${YELLOW}${TOKEN}${NC}"
echo "──────────────────────────────────────────────"
echo "管理面板:"
echo -e "  地址 : http://${PUBLIC_IP}:${DASH_PORT}"
echo -e "  账号 : ${DASH_USER}    密码 : ${DASH_PWD}"
echo "──────────────────────────────────────────────"
echo "常用命令:"
echo "  状态: systemctl status ${SERVICE_NAME}"
echo "  重启: systemctl restart ${SERVICE_NAME}"
echo "  日志: journalctl -u ${SERVICE_NAME} -f"
echo ""
echo -e "${GREEN}以上信息已自动保存到文件:${NC}"
echo -e "  ${YELLOW}${INFO_FILE}${NC}"
echo -e "  (随时可用  cat ${INFO_FILE}  查看)"
echo ""
warn "请妥善保存连接信息 (尤其是认证密钥)!"
