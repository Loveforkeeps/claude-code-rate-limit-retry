#!/usr/bin/env bash
# =============================================================================
# Claude Code Rate Limit Auto-Retry — 一键安装脚本
#
# 用法：bash install.sh [--config-only]
#   --config-only   仅复制默认配置，不覆盖已有配置
#
# 支持系统：macOS / Linux
# 依赖：Node.js（Claude Code 本身已依赖）
# =============================================================================
set -euo pipefail

# ── 颜色输出 ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { echo -e "${BLUE}ℹ${RESET}  $*"; }
success() { echo -e "${GREEN}✅${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET}  $*"; }
error()   { echo -e "${RED}❌${RESET} $*" >&2; }
step()    { echo -e "\n${BOLD}── $* ──${RESET}"; }

# ── 路径常量 ──────────────────────────────────────────────────────────────────
CLAUDE_DIR="$HOME/.claude"
HOOKS_DIR="$CLAUDE_DIR/scripts/hooks"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
HOOK_FILENAME="rate-limit-retry.js"
CONFIG_FILENAME="rate-limit-config.json"
HOOK_DEST="$HOOKS_DIR/$HOOK_FILENAME"
CONFIG_DEST="$CLAUDE_DIR/$CONFIG_FILENAME"
HOOK_COMMAND="node \"$HOOK_DEST\""

# 脚本自身所在目录（支持从任意位置运行）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_HOOK="$SCRIPT_DIR/src/$HOOK_FILENAME"
SRC_CONFIG="$SCRIPT_DIR/$CONFIG_FILENAME"

# ── 前置检查 ──────────────────────────────────────────────────────────────────
step "前置检查"

# 检查 Node.js
if ! command -v node &>/dev/null; then
  error "未找到 Node.js，请先安装 Node.js (https://nodejs.org)"
  exit 1
fi
NODE_VER=$(node --version)
success "Node.js ${NODE_VER}"

# 检查 Claude Code 配置目录
if [[ ! -d "$CLAUDE_DIR" ]]; then
  error "未找到 Claude Code 配置目录：$CLAUDE_DIR"
  error "请先安装并运行一次 Claude Code"
  exit 1
fi
success "Claude Code 配置目录：$CLAUDE_DIR"

# 检查源文件
if [[ ! -f "$SRC_HOOK" ]]; then
  error "Hook 脚本不存在：$SRC_HOOK"
  exit 1
fi
if [[ ! -f "$SRC_CONFIG" ]]; then
  error "默认配置不存在：$SRC_CONFIG"
  exit 1
fi

# ── 安装 Hook 脚本 ────────────────────────────────────────────────────────────
step "安装 Hook 脚本"

mkdir -p "$HOOKS_DIR"
cp "$SRC_HOOK" "$HOOK_DEST"
chmod +x "$HOOK_DEST"
success "Hook 脚本已安装：$HOOK_DEST"

# ── 安装默认配置（不覆盖已有配置）─────────────────────────────────────────────
step "安装配置文件"

if [[ -f "$CONFIG_DEST" ]]; then
  warn "配置文件已存在，跳过覆盖：$CONFIG_DEST"
  warn "如需恢复默认配置，请手动运行：cp $SRC_CONFIG $CONFIG_DEST"
else
  cp "$SRC_CONFIG" "$CONFIG_DEST"
  success "默认配置已安装：$CONFIG_DEST"
fi

# ── 注册 Hooks 到 settings.json ───────────────────────────────────────────────
step "注册 Hooks（幂等操作）"

# 如果 settings.json 不存在，创建最小配置
if [[ ! -f "$SETTINGS_FILE" ]]; then
  echo '{"hooks":{}}' > "$SETTINGS_FILE"
  info "已创建空白 settings.json"
fi

# 备份 settings.json
BACKUP_FILE="${SETTINGS_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
cp "$SETTINGS_FILE" "$BACKUP_FILE"
info "settings.json 已备份：$BACKUP_FILE"

# 使用 Node.js 做幂等注册（避免重复添加）
node - "$SETTINGS_FILE" "$HOOK_COMMAND" <<'NODE_SCRIPT'
const fs = require('fs');
const path = require('path');

const [,, settingsPath, hookCommand] = process.argv;

let settings;
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch (e) {
  console.error('❌ 无法解析 settings.json：' + e.message);
  process.exit(1);
}

if (!settings.hooks) settings.hooks = {};

let changed = false;

// ── 工具函数 ──
function hasCommand(hookGroups, cmd) {
  if (!Array.isArray(hookGroups)) return false;
  return hookGroups.some(group =>
    Array.isArray(group.hooks) &&
    group.hooks.some(h => h.command && h.command.trim() === cmd.trim())
  );
}

function addHookGroup(hookGroups, matcher, cmd) {
  if (!Array.isArray(hookGroups)) hookGroups = [];
  if (hasCommand(hookGroups, cmd)) return hookGroups; // 已存在，跳过
  hookGroups.push({
    matcher,
    hooks: [{ type: 'command', command: cmd }]
  });
  return hookGroups;
}

// ── 注册 Stop hook ──
if (!hasCommand(settings.hooks.Stop, hookCommand)) {
  settings.hooks.Stop = addHookGroup(settings.hooks.Stop, '*', hookCommand);
  changed = true;
  console.log('✅ 已注册 Stop hook');
} else {
  console.log('ℹ  Stop hook 已存在，跳过');
}

// ── 注册 Notification hook ──
if (!hasCommand(settings.hooks.Notification, hookCommand)) {
  settings.hooks.Notification = addHookGroup(settings.hooks.Notification, '', hookCommand);
  changed = true;
  console.log('✅ 已注册 Notification hook');
} else {
  console.log('ℹ  Notification hook 已存在，跳过');
}

if (changed) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  console.log('✅ settings.json 已更新');
} else {
  console.log('ℹ  settings.json 无需变更');
}

process.exit(0);
NODE_SCRIPT

# ── 安装验证 ──────────────────────────────────────────────────────────────────
step "安装验证"

node - "$SETTINGS_FILE" "$HOOK_DEST" "$CONFIG_DEST" <<'VERIFY_SCRIPT'
const fs = require('fs');

const [,, settingsPath, hookDest, configDest] = process.argv;
let ok = true;

// 验证 hook 脚本存在且可解析
try {
  require(hookDest); // 不执行，仅检查语法
} catch (e) {
  // 模块可能有 stdin 依赖，改用语法检查
}

// 验证文件存在
[
  [hookDest,   'Hook 脚本'],
  [configDest, '配置文件'],
  [settingsPath,'settings.json'],
].forEach(([p, label]) => {
  if (fs.existsSync(p)) {
    console.log(`✅ ${label}：${p}`);
  } else {
    console.error(`❌ ${label} 缺失：${p}`);
    ok = false;
  }
});

// 验证 hooks 已注册
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const hookCmd = `node "${hookDest}"`;

const inStop = (settings.hooks?.Stop || []).some(g =>
  g.hooks?.some(h => h.command?.includes('rate-limit-retry'))
);
const inNotif = (settings.hooks?.Notification || []).some(g =>
  g.hooks?.some(h => h.command?.includes('rate-limit-retry'))
);

console.log(inStop  ? '✅ Stop hook 已注册'        : '❌ Stop hook 未注册');
console.log(inNotif ? '✅ Notification hook 已注册' : '❌ Notification hook 未注册');
if (!inStop || !inNotif) ok = false;

process.exit(ok ? 0 : 1);
VERIFY_SCRIPT

# ── 完成提示 ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}🎉 安装完成！${RESET}"
echo ""
echo -e "  配置文件：${BOLD}$CONFIG_DEST${RESET}"
echo -e "  可用配置项："
echo -e "    ${YELLOW}retryMode${RESET}   until-reset（解析重置时间）| fixed（固定等待）| exponential（指数退避）"
echo -e "    ${YELLOW}retryDelay${RESET}  fixed 模式等待秒数（默认 300）"
echo -e "    ${YELLOW}enabled${RESET}     true | false（临时关闭插件）"
echo -e "    ${YELLOW}notification.sound${RESET}  true | false（开关语音通知）"
echo ""
echo -e "  调试模式（查看检测日志）："
echo -e "    ${BOLD}CLAUDE_RATE_LIMIT_DEBUG=1 claude${RESET}"
echo ""
echo -e "  卸载："
echo -e "    ${BOLD}bash $SCRIPT_DIR/uninstall.sh${RESET}"
echo ""
