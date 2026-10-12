#!/bin/bash
# ============================================================
# 配置 pm2 开机自启（macOS launchd）
# 用法：sudo bash scripts/setup-pm2-startup.sh
#
# 作用：
#   1. 注册 launchd 开机自启项（需要 sudo）
#   2. 保存当前进程快照，开机后按此恢复
#   3. 校验结果
#
# 路径全部自动推导，无需手工修改。
# ============================================================

set -e

# ---- 必须 root ----
if [ "$(id -u)" -ne 0 ]; then
  echo "✗ 请用 sudo 运行："
  echo "  sudo bash scripts/setup-pm2-startup.sh"
  exit 1
fi

# ---- 推导目标用户：优先取 sudo 调用者，其次取当前登录用户 ----
if [ -n "$SUDO_USER" ]; then
  USER_NAME="$SUDO_USER"
else
  USER_NAME="$(stat -f '%Su' /dev/console 2>/dev/null || echo "$USER")"
fi

USER_HOME="$(eval echo "~$USER_NAME")"
[ -d "$USER_HOME" ] || USER_HOME="/Users/$USER_NAME"

echo "目标用户：$USER_NAME"
echo "用户目录：$USER_HOME"
echo ""

# ---- 定位 pm2 ----
PM2_BIN=""

# 1) 目标用户 PATH 里的 pm2
PM2_BIN="$(su - "$USER_NAME" -c 'command -v pm2' 2>/dev/null || true)"

# 2) 常见位置兜底
if [ -z "$PM2_BIN" ] || [ ! -x "$PM2_BIN" ]; then
  for c in \
    "$USER_HOME/.nvm/versions/node"/*/lib/node_modules/pm2/bin/pm2 \
    /usr/local/lib/node_modules/pm2/bin/pm2 \
    /opt/homebrew/lib/node_modules/pm2/bin/pm2
  do
    if [ -x "$c" ]; then PM2_BIN="$c"; break; fi
  done
fi

if [ -z "$PM2_BIN" ] || [ ! -x "$PM2_BIN" ]; then
  echo "✗ 找不到 pm2。请先安装：npm install -g pm2"
  exit 1
fi

NODE_BIN_DIR="$(dirname "$(dirname "$PM2_BIN")")/bin"

echo "pm2      ：$PM2_BIN"
echo "node bin ：$NODE_BIN_DIR"
echo ""

echo "──────────────────────────────────────────"
echo " 1/3  注册 launchd 开机自启"
echo "──────────────────────────────────────────"

env PATH="$NODE_BIN_DIR:$PATH" \
  "$PM2_BIN" startup launchd -u "$USER_NAME" --hp "$USER_HOME"

echo ""
echo "──────────────────────────────────────────"
echo " 2/3  保存进程快照"
echo "──────────────────────────────────────────"

su - "$USER_NAME" -c "export PATH=$NODE_BIN_DIR:\$PATH && $PM2_BIN save"

echo ""
echo "──────────────────────────────────────────"
echo " 3/3  校验"
echo "──────────────────────────────────────────"

PLIST="/Library/LaunchDaemons/pm2-${USER_NAME}.plist"
DUMP="$USER_HOME/.pm2/dump.pm2"

if [ -f "$PLIST" ]; then
  echo "✓ 自启配置已写入：$PLIST"
else
  echo "✗ 未找到 $PLIST，请检查上面的输出"
fi

if [ -f "$DUMP" ]; then
  echo "✓ 进程快照已保存：$DUMP"
  echo ""
  echo "  快照内包含的进程："
  su - "$USER_NAME" -c "export PATH=$NODE_BIN_DIR:\$PATH && $PM2_BIN jlist" 2>/dev/null \
    | grep -o '"name":"[^"]*"' | sed 's/"name":"/    · /; s/"$//' || true
else
  echo "✗ 未找到进程快照"
fi

echo ""
echo "──────────────────────────────────────────"
echo " 完成。重启电脑后 pm2 会自动拉起上面的进程。"
echo ""
echo " 常用命令："
echo "   pm2 list                    # 查看状态"
echo "   pm2 logs four-quadrants     # 看日志"
echo "   pm2 restart four-quadrants  # 重启"
echo "──────────────────────────────────────────"
