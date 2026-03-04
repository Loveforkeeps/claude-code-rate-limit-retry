#!/usr/bin/env node
/**
 * Rate Limit Retry Hook
 *
 * 检测 Claude Code 会话中的 429 限流错误，并根据配置自动安排重试通知。
 * 支持三种触发场景：
 *   - PostToolUse (Bash)：直接扫描工具输出，捕获 API 调用返回的限流错误
 *   - Stop hook：读取 transcript，扫描最近条目中的限流信号
 *   - Notification hook：直接扫描 stdin 中的通知文本
 *
 * 配置文件：~/.claude/rate-limit-config.json
 * 日志文件：~/.claude/rate-limit-log.jsonl
 * 恢复上下文：~/.claude/rate-limit-resume-context.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

// ─── 配置加载 ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'rate-limit-config.json');
const DEFAULT_CONFIG = {
  enabled: true,
  retryDelay: 300,          // 固定等待秒数（fixed 模式）
  retryMode: 'until-reset', // 'fixed' | 'exponential' | 'until-reset'
  maxRetries: 5,
  notification: {
    enabled: true,
    sound: true,
    message: 'Rate limit 已重置，爹可以继续工作了'
  },
  autoResume: false,
  logFile: path.join(os.homedir(), '.claude', 'rate-limit-log.jsonl')
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        notification: { ...DEFAULT_CONFIG.notification, ...(parsed.notification || {}) }
      };
    }
  } catch (e) {
    dbg(`Failed to load config: ${e.message}`);
  }
  return DEFAULT_CONFIG;
}

// ─── 限流检测（评分机制，避免误报）─────────────────────────────────────────────

// 强信号（单独命中即判定为限流，权重 10）
const STRONG_PATTERNS = [
  /\bstatus[_\s"':]*429\b/i,           // HTTP status 429
  /\bHTTP[\/\s]*\d\.\d\s+429\b/,       // HTTP/1.1 429
  /\b429\s+Too Many Requests\b/i,      // 标准 HTTP 429 短语
  /you'?ve hit your limit/i,           // Claude 官方限流提示
  /request.?limit.?exceeded/i,         // API 限流标准消息
  /quota.?exceeded/i,                  // 配额超限
  /"err_code"\s*:\s*429/,              // 中文网关 JSON 格式
  /err_code.*429.*throttl/i,           // 中文网关组合信号
];

// 弱信号（需要至少 2 个同时命中才判定，权重 1）
const WEAK_PATTERNS = [
  /rate.?limit(?:ed|ing)?\b/i,         // rate limit/limited/limiting
  /too many requests/i,                // 通用限流消息
  /usage.?limit/i,                     // 用量限制
  /resets?\s+\d+\s*(am|pm)/i,          // 重置时间提示
  /retry.{0,10}after\s+\d+/i,         // retry-after 头
  /throttl(?:ed|ing)\b/i,             // throttled/throttling（要求完整词）
  /err_msg.*throttl/i,                // 错误消息含 throttle
  /\bTPM\b.*(?:limit|exceed|quota)/i, // TPM + 限流上下文
  /\bRPM\b.*(?:limit|exceed|quota)/i, // RPM + 限流上下文
];

// 误报排除：如果文本匹配这些模式，直接跳过（源码、注释、正则定义等）
const FALSE_POSITIVE_PATTERNS = [
  /\/.*429.*\//,                       // 正则字面量中包含 429
  /['"`].*429.*['"`]\s*[,;)]/,         // 字符串字面量中的 429
  /\bconst\b.*PATTERN/i,              // 模式定义行
  /\bfunction\b.*detect/i,            // 检测函数定义
  /\/\/.*429/,                         // 注释中的 429
  /\btest\b.*429/i,                    // 测试代码中的 429
];

function detectRateLimit(text) {
  if (!text) return false;

  // 排除已知误报场景
  if (FALSE_POSITIVE_PATTERNS.some(p => p.test(text))) {
    dbg('Skipped: matched false positive exclusion pattern');
    return false;
  }

  // 强信号：命中任意一个即判定
  if (STRONG_PATTERNS.some(p => p.test(text))) {
    return true;
  }

  // 弱信号：需要至少 2 个同时命中
  const weakHits = WEAK_PATTERNS.filter(p => p.test(text)).length;
  if (weakHits >= 2) {
    return true;
  }

  return false;
}

// ─── 时间解析 ──────────────────────────────────────────────────────────────────

/**
 * 解析 "resets 4am (America/Los_Angeles)" 样式的重置时间
 * 返回本地 Date 对象，如无法解析则返回 null
 */
function parseResetTime(text) {
  // 匹配 "resets 4am" 或 "resets 4:30am"
  const match = text.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2] || '0', 10);
  const period = match[3].toLowerCase();

  if (period === 'pm' && hours !== 12) hours += 12;
  if (period === 'am' && hours === 12) hours = 0;

  const now = new Date();
  const reset = new Date(now);
  reset.setHours(hours, minutes, 0, 0);

  // 如果今天已过该时间，则定为明天
  if (reset <= now) {
    reset.setDate(reset.getDate() + 1);
  }

  return reset;
}

/**
 * 解析 "retry after N seconds/minutes/ms" 样式
 * 返回秒数或 null
 */
function parseRetryAfter(text) {
  const secMatch = text.match(/retry.{0,10}after\s+(\d+)\s*s(ec(ond)?s?)?/i);
  if (secMatch) return parseInt(secMatch[1], 10);

  const minMatch = text.match(/retry.{0,10}after\s+(\d+)\s*min(ute)?s?/i);
  if (minMatch) return parseInt(minMatch[1], 10) * 60;

  const msMatch = text.match(/retry.{0,10}after\s+(\d+)\s*ms/i);
  if (msMatch) return Math.ceil(parseInt(msMatch[1], 10) / 1000);

  return null;
}

/**
 * 根据配置和错误文本计算等待秒数
 */
function calculateWaitSeconds(config, errorText, attempt = 1) {
  if (config.retryMode === 'until-reset') {
    const resetTime = parseResetTime(errorText);
    if (resetTime) {
      // 至少等 60 秒，避免差一秒差错
      return Math.max(60, Math.ceil((resetTime - new Date()) / 1000));
    }
    const retryAfter = parseRetryAfter(errorText);
    if (retryAfter) return retryAfter;
  }

  if (config.retryMode === 'exponential') {
    // 指数退避，最多 1 小时
    return Math.min(config.retryDelay * Math.pow(2, attempt - 1), 3600);
  }

  // fixed 模式：直接使用 retryDelay
  return config.retryDelay;
}

// ─── Transcript 扫描 ───────────────────────────────────────────────────────────

/**
 * 读取 JSONL transcript 的最后 N 行，检测限流错误
 * 返回 { found, errorText, lastUserMessage }
 */
function scanTranscript(transcriptPath, maxLines = 60) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { found: false, errorText: '', lastUserMessage: '' };
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const recent = lines.slice(-maxLines);

    let errorText = '';
    let lastUserMessage = '';

    for (const line of recent) {
      try {
        const entry = JSON.parse(line);

        // 只扫描错误相关字段，不扫描整个 JSON（避免源码/工具输出误报）
        const fieldsToScan = [
          entry.error,
          entry.message?.error,
          entry.errorMessage,
          entry.data?.error,
          entry.data?.message,
          // assistant 类型的文本内容（可能包含 Claude 返回的限流提示）
          (entry.type === 'assistant' || entry.role === 'assistant' || entry.message?.role === 'assistant')
            ? (typeof (entry.message?.content ?? entry.content) === 'string'
                ? (entry.message?.content ?? entry.content)
                : '')
            : null,
        ].filter(Boolean);

        const scanText = fieldsToScan.map(f => typeof f === 'string' ? f : JSON.stringify(f)).join(' ');
        if (scanText && detectRateLimit(scanText)) {
          errorText = scanText;
        }

        // 收集最后一条用户消息，用于后续上下文保存
        const rawContent = entry.message?.content ?? entry.content;
        const text =
          typeof rawContent === 'string'
            ? rawContent
            : Array.isArray(rawContent)
            ? rawContent.map(c => (c && c.text) || '').join(' ')
            : '';

        const isUser =
          entry.type === 'user' ||
          entry.role === 'user' ||
          entry.message?.role === 'user';

        if (isUser && text.trim()) {
          lastUserMessage = text.trim().slice(0, 500);
        }
      } catch {
        // 跳过无法解析的行
      }
    }

    return { found: !!errorText, errorText, lastUserMessage };
  } catch (e) {
    dbg(`Error reading transcript: ${e.message}`);
    return { found: false, errorText: '', lastUserMessage: '' };
  }
}

// ─── 通知与调度 ────────────────────────────────────────────────────────────────

/**
 * 检测 terminal-notifier 是否可用
 */
let _hasTerminalNotifier = null;
function hasTerminalNotifier() {
  if (_hasTerminalNotifier !== null) return _hasTerminalNotifier;
  try {
    execSync('which terminal-notifier', { timeout: 2000, stdio: 'ignore' });
    _hasTerminalNotifier = true;
  } catch {
    _hasTerminalNotifier = false;
  }
  return _hasTerminalNotifier;
}

/**
 * 获取日志文件路径（用于点击通知时打开）
 */
function getLogFilePath(config) {
  const logPath = config.logFile
    ? config.logFile.replace(/^~/, os.homedir())
    : path.join(os.homedir(), '.claude', 'rate-limit-log.jsonl');
  return logPath;
}

/**
 * 发送 macOS 通知，优先使用 terminal-notifier（支持点击打开日志）
 * 降级到 osascript（不支持点击动作）
 */
function sendMacNotification(title, message, config, options = {}) {
  const { sound = false, openFile = null } = options;

  if (hasTerminalNotifier()) {
    const args = [
      '-title', title,
      '-message', message,
      '-group', 'claude-rate-limit',
    ];
    if (sound) args.push('-sound', 'Ping');
    if (openFile) args.push('-open', `file://${openFile}`);
    try {
      execSync(
        `terminal-notifier ${args.map(a => `"${escapeShell(a)}"`).join(' ')}`,
        { timeout: 3000, stdio: 'ignore' }
      );
    } catch {
      // 降级到 osascript
      sendOsascriptNotification(title, message, sound);
    }
    return;
  }

  sendOsascriptNotification(title, message, sound);
}

function sendOsascriptNotification(title, message, sound) {
  try {
    const soundPart = sound ? ' sound name "Ping"' : '';
    execSync(
      `osascript -e 'display notification "${escapeOsa(message)}" with title "${escapeOsa(title)}"${soundPart}'`,
      { timeout: 3000, stdio: 'ignore' }
    );
  } catch {
    // 非致命
  }
}

/**
 * 立即发送系统通知（告知正在等待）
 */
function sendImmediateNotification(message, config) {
  if (process.platform === 'darwin') {
    sendMacNotification('Claude Code ⏳', message, config, {
      openFile: getLogFilePath(config),
    });
  }
}

/**
 * 安排后台延迟通知（到时提醒 + 语音）
 * 使用 detached subprocess + sleep，不阻塞 Claude Code
 */
function scheduleDelayedNotification(waitSeconds, config) {
  const msg = config.notification.message;
  const sound = config.notification.sound;
  const logFile = getLogFilePath(config);

  if (process.platform === 'darwin') {
    let notifyCmd;
    if (hasTerminalNotifier()) {
      const args = [
        '-title', 'Claude Code ✅',
        '-message', msg,
        '-group', 'claude-rate-limit',
        '-open', `file://${logFile}`,
      ];
      if (sound) args.push('-sound', 'Ping');
      notifyCmd = `terminal-notifier ${args.map(a => `"${escapeShell(a)}"`).join(' ')}`;
    } else {
      const soundPart = sound ? ' sound name "Ping"' : '';
      notifyCmd = `osascript -e 'display notification "${escapeOsa(msg)}" with title "Claude Code ✅"${soundPart}'`;
    }

    const sayPart = sound ? ` && say "${escapeShell(msg)}"` : '';
    const cmd = `sleep ${waitSeconds} && ${notifyCmd}${sayPart}`;

    const child = spawn('sh', ['-c', cmd], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return true;
  }

  if (process.platform === 'linux') {
    const cmd = `sleep ${waitSeconds} && notify-send "Claude Code ✅" "${escapeShell(msg)}"`;
    const child = spawn('sh', ['-c', cmd], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return true;
  }

  return false;
}

// ─── 防重复调度（锁文件机制）─────────────────────────────────────────────────

const LOCK_PATH = path.join(os.homedir(), '.claude', 'rate-limit-lock.json');
const LOCK_GRACE_SECONDS = 300; // 同一限流事件在 5 分钟内只调度一次

function isAlreadyScheduled() {
  try {
    if (!fs.existsSync(LOCK_PATH)) return false;
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    const createdAt = new Date(lock.createdAt);
    const ageSeconds = (Date.now() - createdAt.getTime()) / 1000;
    return ageSeconds < LOCK_GRACE_SECONDS;
  } catch {
    return false;
  }
}

function writeLock(waitSeconds) {
  try {
    fs.writeFileSync(
      LOCK_PATH,
      JSON.stringify({ createdAt: new Date().toISOString(), waitSeconds }),
      'utf8'
    );
  } catch {
    // 非致命
  }
}

function clearLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
  } catch {}
}

// ─── 上下文保存 ───────────────────────────────────────────────────────────────

/**
 * 保存最后一条用户消息，方便手动恢复时参考
 */
function saveResumeContext(lastUserMessage, resetTime) {
  if (!lastUserMessage) return;
  const resumePath = path.join(os.homedir(), '.claude', 'rate-limit-resume-context.json');
  try {
    fs.writeFileSync(
      resumePath,
      JSON.stringify(
        {
          lastUserMessage,
          resetTime: resetTime?.toISOString() || null,
          savedAt: new Date().toISOString()
        },
        null,
        2
      ),
      'utf8'
    );
  } catch {
    // 非致命
  }
}

// ─── 事件日志 ─────────────────────────────────────────────────────────────────

function writeLog(config, entry) {
  try {
    const logPath = config.logFile
      ? config.logFile.replace(/^~/, os.homedir())
      : path.join(os.homedir(), '.claude', 'rate-limit-log.jsonl');
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n');
  } catch {
    // 非致命
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function dbg(msg) {
  if (process.env.CLAUDE_RATE_LIMIT_DEBUG) {
    process.stderr.write(`[RateLimit] ${msg}\n`);
  }
}

function escapeOsa(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'");
}

function escapeShell(str) {
  return str.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

function formatWait(seconds) {
  if (seconds >= 3600) {
    const h = Math.round(seconds / 3600);
    return `${h} 小时`;
  }
  if (seconds >= 60) {
    const m = Math.round(seconds / 60);
    return `${m} 分钟`;
  }
  return `${seconds} 秒`;
}

// ─── 入口 ─────────────────────────────────────────────────────────────────────

const MAX_STDIN = 512 * 1024;
let stdinData = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (stdinData.length < MAX_STDIN) stdinData += chunk;
});
process.stdin.on('end', () => {
  main().catch(e => {
    dbg(`Unhandled error: ${e.message}`);
    process.exit(0); // 始终正常退出，不影响 Claude Code 关闭流程
  });
});

async function main() {
  const config = loadConfig();
  if (!config.enabled) return process.exit(0);

  // ── 解析 stdin ──
  let transcriptPath = null;
  let inlineText = stdinData;
  let isPostToolUse = false;
  let toolOutput = '';

  try {
    const input = JSON.parse(stdinData);
    transcriptPath = input.transcript_path || null;

    // PostToolUse 场景：有 tool_name 且有工具输出
    if (input.tool_name || input.tool_input) {
      isPostToolUse = true;
      // 兼容不同版本的字段名
      toolOutput =
        input.tool_response?.output ||
        input.tool_output?.output ||
        input.tool_response?.content ||
        '';
      dbg(`PostToolUse mode, tool: ${input.tool_name}, output length: ${toolOutput.length}`);
    }

    // Notification hook：只扫描通知消息文本，不扫描元数据
    // 避免 session_id、version、hook_event_name 等元数据触发误报
    if (input.message) {
      inlineText = typeof input.message === 'string' ? input.message : JSON.stringify(input.message);
    } else if (input.notification) {
      inlineText = typeof input.notification === 'string' ? input.notification : JSON.stringify(input.notification);
    } else {
      // PostToolUse 或无 message 字段 → 不扫描整个 JSON 元数据
      inlineText = '';
    }
  } catch {
    // stdin 不是 JSON，当作纯文本处理
  }

  // PostToolUse：必须把 stdin 原样透传给 Claude Code，不能截断
  if (isPostToolUse) {
    process.stdout.write(stdinData);
  }

  // ── 三层检测 ──
  let found = false;
  let errorText = '';
  let lastUserMessage = '';

  // 1. PostToolUse Bash：直接扫描工具输出（最准确的来源）
  if (isPostToolUse && toolOutput && detectRateLimit(toolOutput)) {
    found = true;
    errorText = toolOutput;
    dbg('Rate limit detected in tool output');
  }

  // 2. Notification hook / 通用 stdin 扫描
  if (!found && detectRateLimit(inlineText)) {
    found = true;
    errorText = inlineText;
    dbg('Rate limit detected in stdin/notification data');
  }

  // 3. Stop hook：扫描 transcript
  if (!found && transcriptPath) {
    const result = scanTranscript(transcriptPath);
    found = result.found;
    errorText = result.errorText;
    lastUserMessage = result.lastUserMessage;
    if (found) dbg('Rate limit detected in transcript');
  }

  if (!found) {
    clearLock(); // 正常退出时清除旧锁
    return process.exit(0);
  }

  // ── 防重复调度 ──
  if (isAlreadyScheduled()) {
    dbg('Already scheduled within grace period, skipping');
    return process.exit(0);
  }

  // ── 计算等待时间 ──
  const waitSeconds = calculateWaitSeconds(config, errorText);
  const resetTime = parseResetTime(errorText);
  const waitStr = formatWait(waitSeconds);

  dbg(`Detected rate limit. Wait: ${waitSeconds}s (${waitStr})`);

  // ── 立即通知用户正在等待 ──
  sendImmediateNotification(`429 限流触发，${waitStr}后提醒恢复`, config);

  // ── 调度延迟通知 ──
  if (config.notification.enabled) {
    scheduleDelayedNotification(waitSeconds, config);
  }

  // ── 写锁 & 保存上下文 ──
  writeLock(waitSeconds);
  saveResumeContext(lastUserMessage, resetTime);

  // ── 写日志 ──
  writeLog(config, {
    event: 'rate_limit_detected',
    waitSeconds,
    resetTime: resetTime?.toISOString() || null,
    lastUserMessage: lastUserMessage.slice(0, 200),
    errorSnippet: errorText.slice(0, 300)
  });

  process.exit(0);
}
