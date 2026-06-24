#!/bin/bash
#==============================================================================
#  PrivDesk - 私有远程桌面服务
#  连接码单独生成脚本 (不重装、不改服务)
#  用途: 一台服务器接多台被控电脑, 为每台单独生成一个连接码
#==============================================================================

set -e

# ---------- 颜色输出 ----------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }
title() { echo -e "\n${BLUE}==== $1 ====${NC}"; }

PRODUCT="PrivDesk"
INSTALL_DIR="/usr/local/privdesk"
CONFIG_FILE="${INSTALL_DIR}/config.toml"
CLIENTS_FILE="${INSTALL_DIR}/clients.txt"   # 登记表: 备注名|远程端口|生成时间
DEFAULT_REMOTE_START=7002                    # 远程端口从这里开始自动分配

#==============================================================================
echo -e "${BLUE}"
echo "  PrivDesk 连接码生成工具"
echo -e "${NC}"
echo "  为每台被控电脑单独生成一个连接码 (共用服务器认证密钥, 不同远程端口)"
#==============================================================================

# ---------- 0. 检查 root 权限 ----------
if [ "$(id -u)" != "0" ]; then
    error "请使用 root 权限运行 (sudo bash $0)"
    exit 1
fi

# ---------- 1. 读取已安装的服务配置 ----------
title "读取服务配置"
if [ ! -f "$CONFIG_FILE" ]; then
    error "未找到服务配置: $CONFIG_FILE"
    error "请先运行 install.sh 安装服务端, 再用本脚本生成连接码。"
    exit 1
fi

# 从 config.toml 提取认证密钥和连接端口
TOKEN=$(grep -E '^[[:space:]]*auth\.token' "$CONFIG_FILE" | head -n1 | sed -E 's/.*=[[:space:]]*"(.*)".*/\1/')
BIND_PORT=$(grep -E '^[[:space:]]*bindPort' "$CONFIG_FILE" | head -n1 | sed -E 's/[^0-9]//g')

if [ -z "$TOKEN" ] || [ -z "$BIND_PORT" ]; then
    error "无法从配置中读取认证密钥或连接端口, 配置可能已损坏。"
    exit 1
fi
info "已读取服务配置 (连接端口: ${BIND_PORT})"

# ---------- 2. 获取公网 IP ----------
title "获取服务器公网 IP"
PUBLIC_IP=$(curl -4 -fsSL --max-time 5 ifconfig.me 2>/dev/null)
[ -z "$PUBLIC_IP" ] && PUBLIC_IP=$(curl -4 -fsSL --max-time 5 ip.sb 2>/dev/null)
[ -z "$PUBLIC_IP" ] && PUBLIC_IP=$(curl -4 -fsSL --max-time 5 api.ipify.org 2>/dev/null)
[ -z "$PUBLIC_IP" ] && PUBLIC_IP=$(curl -4 -fsSL --max-time 5 ipinfo.io/ip 2>/dev/null)
PUBLIC_IP=$(printf '%s' "$PUBLIC_IP" | tr -d '[:space:]')
if [ -z "$PUBLIC_IP" ]; then
    warn "未能自动获取公网 IP"
    read -p "请手动输入服务器公网 IP: " PUBLIC_IP
    PUBLIC_IP=$(printf '%s' "$PUBLIC_IP" | tr -d '[:space:]')
    [ -z "$PUBLIC_IP" ] && { error "未提供公网 IP, 已退出。"; exit 1; }
fi
info "服务器公网 IP: ${PUBLIC_IP}"

# ---------- 3. 计算下一个空闲远程端口 ----------
touch "$CLIENTS_FILE"
# 已登记的远程端口集合
USED_PORTS=$(awk -F'|' 'NF>=2{print $2}' "$CLIENTS_FILE" | tr -d ' ')
SUGGEST_PORT=$DEFAULT_REMOTE_START
while printf '%s\n' "$USED_PORTS" | grep -qx "$SUGGEST_PORT"; do
    SUGGEST_PORT=$((SUGGEST_PORT + 1))
done

# ---------- 4. 已登记的电脑一览 ----------
if [ -s "$CLIENTS_FILE" ] && awk -F'|' 'NF>=2' "$CLIENTS_FILE" | grep -q .; then
    title "已登记的被控电脑"
    printf "  %-20s %-10s %s\n" "备注名" "远程端口" "生成时间"
    echo "  ----------------------------------------------------------"
    awk -F'|' 'NF>=2{printf "  %-20s %-10s %s\n", $1, $2, $3}' "$CLIENTS_FILE"
fi

# ---------- 5. 交互: 备注名 + 远程端口 ----------
title "生成新的连接码"
read -p "给这台电脑起个备注名 [如: 家里台式机]: " CLIENT_NAME
CLIENT_NAME=${CLIENT_NAME:-未命名}
# 去掉备注名里的分隔符, 避免破坏登记表
CLIENT_NAME=$(printf '%s' "$CLIENT_NAME" | tr -d '|' | tr -d '\r\n')

while true; do
    read -p "远程端口 [回车=自动用 ${SUGGEST_PORT}]: " REMOTE_PORT
    REMOTE_PORT=${REMOTE_PORT:-$SUGGEST_PORT}
    # 校验是数字
    if ! printf '%s' "$REMOTE_PORT" | grep -qE '^[0-9]+$'; then
        warn "端口必须是数字, 请重新输入。"; continue
    fi
    # 校验范围
    if [ "$REMOTE_PORT" -lt 1024 ] || [ "$REMOTE_PORT" -gt 65535 ]; then
        warn "端口需在 1024-65535 之间, 请重新输入。"; continue
    fi
    # 校验是否已被登记
    if printf '%s\n' "$USED_PORTS" | grep -qx "$REMOTE_PORT"; then
        warn "远程端口 ${REMOTE_PORT} 已分配给其他电脑, 请换一个 (建议 ${SUGGEST_PORT})。"; continue
    fi
    break
done

# ---------- 6. 生成连接码 ----------
CONN_JSON="{\"server\":\"${PUBLIC_IP}\",\"port\":\"${BIND_PORT}\",\"token\":\"${TOKEN}\",\"remote\":\"${REMOTE_PORT}\"}"
CONN_CODE="PRIVDESK-$(printf '%s' "$CONN_JSON" | base64 | tr -d '\n')"
GEN_TIME=$(date '+%Y-%m-%d %H:%M:%S')

# 登记到 clients.txt
printf '%s|%s|%s\n' "$CLIENT_NAME" "$REMOTE_PORT" "$GEN_TIME" >> "$CLIENTS_FILE"

# 单独保存这台电脑的连接信息文件 (放在当前目录, 方便取走)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SAFE_NAME=$(printf '%s' "$CLIENT_NAME" | tr ' /' '__')
OUT_FILE="${SCRIPT_DIR}/connection-${SAFE_NAME}-${REMOTE_PORT}.txt"
cat > "$OUT_FILE" << EOF
==================================================
  PrivDesk 连接信息  (${CLIENT_NAME})
  生成时间: ${GEN_TIME}
==================================================

【连接码】(复制到客户端"粘贴连接码"框, 一键导入)
${CONN_CODE}

【手动填写信息】(填入 PrivDesk 客户端)
  服务器地址 : ${PUBLIC_IP}
  连接端口   : ${BIND_PORT}
  认证密钥   : ${TOKEN}
  远程端口   : ${REMOTE_PORT}

==================================================
  ⚠ 本文件含认证密钥, 请妥善保管, 勿外泄!
  ⚠ 远程端口 ${REMOTE_PORT} 需在【云控制台安全组】放行 (TCP)
==================================================
EOF
chmod 600 "$OUT_FILE"

# ---------- 7. 屏幕输出 ----------
clear
echo -e "${GREEN}"
echo "╔════════════════════════════════════════════════════╗"
echo "║       🎉 连接码已生成!                                ║"
echo "╚════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "  备注: ${YELLOW}${CLIENT_NAME}${NC}   远程端口: ${YELLOW}${REMOTE_PORT}${NC}"
echo ""
echo -e "${GREEN}★ 复制下面的【连接码】, 粘贴到 PrivDesk 客户端一键导入 ★${NC}"
echo "──────────────────────────────────────────────"
echo -e "${YELLOW}${CONN_CODE}${NC}"
echo "──────────────────────────────────────────────"
echo ""
echo "或手动填写:"
echo -e "  服务器地址 : ${YELLOW}${PUBLIC_IP}${NC}"
echo -e "  连接端口   : ${YELLOW}${BIND_PORT}${NC}"
echo -e "  认证密钥   : ${YELLOW}${TOKEN}${NC}"
echo -e "  远程端口   : ${YELLOW}${REMOTE_PORT}${NC}"
echo "──────────────────────────────────────────────"
echo ""
warn "远程端口 ${REMOTE_PORT} 记得在【云控制台安全组】放行 (TCP)!"
echo ""
info "本台连接信息已保存到: ${OUT_FILE}"
info "所有已生成的电脑登记在: ${CLIENTS_FILE}"
