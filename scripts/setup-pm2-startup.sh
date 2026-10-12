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
# 注意：不能简单按字母序 glob，否则 v18 会排在 v22 前面被误选。
# 本项目依赖 node:sqlite（Node 22.5+），必须挑一个真正支持它的版本。
PM2_BIN=""
NODE_BIN=""     # 与该 pm2 配套的 node 可执行文件，在循环中一并记录，避免事后推算出错

# 逐个探测候选（版本从高到低），要求：pm2 存在 且 该版 node 支持 node:sqlite
for c in $(ls -1d "$USER_HOME/.nvm/versions/node"/*/ 2>/dev/null | sort -Vr); do
  N="${c}bin/node"
  P="${c}lib/node_modules/pm2/bin/pm2"
  [ -x "$N" ] || continue
  [ -x "$P" ] || continue
  # 校验 node:sqlite 是否可用
  if "$N" -e "require('node:sqlite')" >/dev/null 2>&1; then
    PM2_BIN="$P"
    NODE_BIN="$N"
    break
  fi
done

# 兜底：系统级安装位置
if [ -z "$PM2_BIN" ]; then
  for c in \
    /usr/local/lib/node_modules/pm2/bin/pm2 \
    /opt/homebrew/lib/node_modules/pm2/bin/pm2
  do
    if [ -x "$c" ]; then PM2_BIN="$c"; break; fi
  done
fi

if [ -z "$PM2_BIN" ] || [ ! -x "$PM2_BIN" ]; then
  echo "✗ 找不到可用的 pm2（需 Node 22.5+ 且已全局安装 pm2）。"
  echo "  请先执行：npm install -g pm2"
  exit 1
fi

# node 的 bin 目录：从已记录的 NODE_BIN 反推（比推算 pm2 路径可靠）
NODE_BIN_DIR="$(dirname "$NODE_BIN")"

echo "pm2      ：$PM2_BIN"
echo "node     ：$NODE_BIN"
echo "node 版本：$("$NODE_BIN" -v)"
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

# launchd 配置可能落在两个位置，都要检查
PLIST_DAEMON="/Library/LaunchDaemons/pm2-${USER_NAME}.plist"
PLIST_AGENT="$USER_HOME/Library/LaunchAgents/pm2.${USER_NAME}.plist"
DUMP="$USER_HOME/.pm2/dump.pm2"

# --- 检查 launchd 配置（两个位置都查）---
PLIST=""
if [ -f "$PLIST_DAEMON" ]; then
  PLIST="$PLIST_DAEMON"
elif [ -f "$PLIST_AGENT" ]; then
  PLIST="$PLIST_AGENT"
fi

if [ -n "$PLIST" ]; then
  echo "✓ 自启配置已写入：$PLIST"

  # 关键校验：确认 plist 里引用的 pm2 路径确实存在，且指向支持 node:sqlite 的版本
  REF_PM2="$(grep -o '[^ <>"]*node_modules/pm2/bin/pm2' "$PLIST" | head -1)"
  if [ -n "$REF_PM2" ]; then
    if [ -x "$REF_PM2" ]; then
      echo "  ✓ 引用的 pm2 存在：$REF_PM2"
      # 反查它对应哪个 node 版本
      REF_NODE="$(echo "$REF_PM2" | sed 's|/lib/node_modules/pm2/bin/pm2||')/bin/node"
      if [ -x "$REF_NODE" ] && "$REF_NODE" -e "require('node:sqlite')" >/dev/null 2>&1; then
        echo "  ✓ 该版本 node 支持 node:sqlite（$("$REF_NODE" -v)）—— 重启可正常启动"
      else
        echo "  ✗ 该版本 node 不支持 node:sqlite —— 重启后应用会起不来！"
        echo "    请重新运行本脚本，或手动修正 $PLIST"
      fi
    else
      echo "  ✗ plist 引用的 pm2 不存在：$REF_PM2"
    fi
  fi
else
  echo "✗ 未找到 launchd 配置（已查：$PLIST_DAEMON / $PLIST_AGENT）"
  echo "  请检查上面的输出是否有报错"
fi

# --- 检查快照 ---
if [ -f "$DUMP" ]; then
  echo "✓ 进程快照已保存：$DUMP"

  # 校验快照里的解释器
  REF_INTERP="$(grep -o '"exec_interpreter":"[^"]*"' "$DUMP" | head -1 | sed 's/.*:"//; s/"$//')"
  if [ -n "$REF_INTERP" ]; then
    if "$REF_INTERP" -e "require('node:sqlite')" >/dev/null 2>&1; then
      echo "  ✓ 快照解释器可用：$REF_INTERP"
    else
      echo "  ✗ 快照解释器不可用（不支持 node:sqlite）：$REF_INTERP"
      echo "    修复：pm2 delete four-quadrants && pm2 start ecosystem.config.cjs && pm2 save"
    fi
  fi

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
echo " 建议再手工确认一次："
echo "   launchctl list | grep -i pm2      # 应能看到 com.PM2"
echo ""
echo " 常用命令："
echo "   pm2 list                    # 查看状态"
echo "   pm2 logs four-quadrants     # 看日志"
echo "   pm2 restart four-quadrants  # 重启"
echo "──────────────────────────────────────────"
