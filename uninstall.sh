#!/usr/bin/env bash
# =============================================================================
# Claude Code Rate Limit Auto-Retry — 卸载脚本
#
# 用法：bash uninstall.sh [--purge]
#   --purge   同时删除配置文件和日志文件
# =============================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { echo -e "\033[0;34mℹ${RESET}  $*"; }
success() { echo -e "${GREEN}✅${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET}  $*"; }
step()    { echo -e "\n${BOLD}── $* ──${RESET}"; }

PURGE=false
for arg in "$@"; do
  [[ "$arg" == "--purge" ]] && PURGE=true
done

CLAUDE_DIR="$HOME/.claude"
HOOKS_DIR="$CLAUDE_DIR/scripts/hooks"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
HOOK_DEST="$HOOKS_DIR/rate-limit-retry.js"
CONFIG_DEST="$CLAUDE_DIR/rate-limit-config.json"
LOCK_FILE="$CLAUDE_DIR/rate-limit-lock.json"
LOG_FILE="$CLAUDE_DIR/rate-limit-log.jsonl"
RESUME_FILE="$CLAUDE_DIR/rate-limit-resume-context.json"

echo -e "${BOLD}Claude Code Rate Limit Auto-Retry — 卸载${RESET}"
$PURGE && warn "已开启 --purge 模式，配置和日志文件也将被删除"

# ── 从 settings.json 移除 hooks ───────────────────────────────────────────────
step "从 settings.json 移除 Hooks"

if [[ ! -f "$SETTINGS_FILE" ]]; then
  warn "settings.json 不存在，跳过"
else
  # 备份
  BACKUP_FILE="${SETTINGS_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
  cp "$SETTINGS_FILE" "$BACKUP_FILE"
  info "settings.json 已备份：$BACKUP_FILE"

  node - "$SETTINGS_FILE" <<'NODE_SCRIPT'
const fs = require('fs');
const settingsPath = process.argv[2];

let settings;
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch (e) {
  console.error('❌ 无法解析 settings.json：' + e.message);
  process.exit(1);
}

let changed = false;

function removeRateLimitHooks(hookGroups) {
  if (!Array.isArray(hookGroups)) return hookGroups;
  return hookGroups
    .map(group => ({
      ...group,
      hooks: (group.hooks || []).filter(
        h => !h.command || !h.command.includes('rate-limit-retry')
      )
    }))
    .filter(group => group.hooks && group.hooks.length > 0);
}

['Stop', 'Notification'].forEach(hookType => {
  if (!settings.hooks?.[hookType]) return;
  const before = JSON.stringify(settings.hooks[hookType]);
  settings.hooks[hookType] = removeRateLimitHooks(settings.hooks[hookType]);
  if (JSON.stringify(settings.hooks[hookType]) !== before) {
    console.log(`✅ 已从 ${hookType} 移除 rate-limit-retry hook`);
    changed = true;
  } else {
    console.log(`ℹ  ${hookType} 中未找到 rate-limit-retry hook`);
  }
});

if (changed) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  console.log('✅ settings.json 已更新');
} else {
  console.log('ℹ  settings.json 无需变更');
}
NODE_SCRIPT
fi

# ── 删除 Hook 脚本 ────────────────────────────────────────────────────────────
step "删除 Hook 脚本"

if [[ -f "$HOOK_DEST" ]]; then
  rm "$HOOK_DEST"
  success "已删除：$HOOK_DEST"
else
  warn "Hook 脚本不存在，跳过：$HOOK_DEST"
fi

# ── 清理运行时文件 ─────────────────────────────────────────────────────────────
step "清理运行时文件"

for f in "$LOCK_FILE" "$RESUME_FILE"; do
  if [[ -f "$f" ]]; then
    rm "$f"
    success "已删除：$f"
  fi
done

# ── Purge 模式：删除配置和日志 ─────────────────────────────────────────────────
if $PURGE; then
  step "Purge 模式：删除配置和日志"
  for f in "$CONFIG_DEST" "$LOG_FILE"; do
    if [[ -f "$f" ]]; then
      rm "$f"
      success "已删除：$f"
    else
      warn "文件不存在，跳过：$f"
    fi
  done
else
  info "配置文件保留（如需删除请用 --purge）：$CONFIG_DEST"
  [[ -f "$LOG_FILE" ]] && info "日志文件保留：$LOG_FILE"
fi

echo ""
echo -e "${GREEN}${BOLD}✅ 卸载完成${RESET}"
echo ""
