# Claude Code Rate Limit Auto-Retry

当 Claude Code 遭遇 **429 Rate Limit** 错误时，自动检测、等待、并在限流重置后通过系统通知提醒恢复工作。

## 特性

- **双层检测**：同时挂载 Stop hook 和 Notification hook，覆盖订阅限流和 API 速率限制
- **智能等待**：自动解析 "resets 4am" 样式的重置时间，无需手动计算
- **系统通知**：macOS 弹窗 + 语音提醒（Linux 使用 notify-send）
- **防重复调度**：锁文件机制，同一限流事件只触发一次通知
- **上下文保存**：保留最后一条用户消息，方便手动恢复
- **可配置**：retryMode / retryDelay / notification.sound 等多项参数
- **幂等安装**：多次运行 install.sh 安全，不重复注册

## 快速安装

```bash
git clone <this-repo> claude-code-rate-limit-retry
cd claude-code-rate-limit-retry
bash install.sh
```

**要求**：Node.js（Claude Code 本身已依赖）

## 配置

安装后编辑 `~/.claude/rate-limit-config.json`：

```json
{
  "enabled": true,
  "retryMode": "until-reset",
  "retryDelay": 300,
  "maxRetries": 5,
  "notification": {
    "enabled": true,
    "sound": true,
    "message": "Rate limit 已重置，可以继续工作了"
  },
  "autoResume": false,
  "logFile": "~/.claude/rate-limit-log.jsonl"
}
```

### 配置项说明

| 键 | 默认值 | 说明 |
|----|--------|------|
| `enabled` | `true` | 插件总开关 |
| `retryMode` | `"until-reset"` | `until-reset` = 解析错误中的重置时间 \| `fixed` = 固定等待 `retryDelay` 秒 \| `exponential` = 指数退避 |
| `retryDelay` | `300` | `fixed` 模式下的等待秒数 |
| `maxRetries` | `5` | 最大重试次数（日志记录用） |
| `notification.enabled` | `true` | 是否发送系统通知 |
| `notification.sound` | `true` | 是否播放声音和语音 |
| `notification.message` | 已设 | 通知文字 |
| `logFile` | `~/.claude/rate-limit-log.jsonl` | 事件日志路径 |

## 工作流程

```
Claude Code 遇到 429
        │
        ├─ Notification hook → 扫描通知文本
        └─ Stop hook → 读取 transcript 最后 60 行
                │
        检测到限流关键词
                │
        解析重置时间（如 "resets 4am (America/Los_Angeles)"）
                │
        立即通知 → "429 限流触发，X 分钟后提醒"
                │
        后台 sleep → 到时弹通知 + 语音 ✅
                │
        保存 → ~/.claude/rate-limit-resume-context.json
        日志 → ~/.claude/rate-limit-log.jsonl
```

## 调试

```bash
# 开启详细日志
CLAUDE_RATE_LIMIT_DEBUG=1 claude

# 查看事件日志
cat ~/.claude/rate-limit-log.jsonl | jq .

# 查看保存的上下文（上次被中断的消息）
cat ~/.claude/rate-limit-resume-context.json
```

## 卸载

```bash
# 保留配置文件
bash uninstall.sh

# 彻底删除（含配置和日志）
bash uninstall.sh --purge
```

## 文件清单

```
~/.claude/
├── rate-limit-config.json          # 配置文件
├── rate-limit-log.jsonl            # 事件日志（运行后生成）
├── rate-limit-lock.json            # 防重复调度锁（临时）
├── rate-limit-resume-context.json  # 上次中断的上下文（运行后生成）
└── scripts/hooks/
    └── rate-limit-retry.js         # Hook 脚本
```
