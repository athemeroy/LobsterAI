---
name: heartbeat-manager
description: 管理心跳巡查配置，支持启用/禁用、修改间隔、编辑巡查提示词和 HEARTBEAT.md 文件。当用户想设置或修改 AI 主动巡查时使用。Manage heartbeat patrol configuration including enable/disable, interval, prompt, and HEARTBEAT.md editing.
official: true
---

# 心跳巡查管理 Skill

## ⚠️ 核心原则

### 原则一：心跳 ≠ 定时任务

> 心跳巡查是"有事才通知"的主动监控机制，**不是定时任务**。
> - 心跳：固定间隔轮询，Agent 判断"有事就通知，没事就静默"
> - 定时任务：Cron 定时，每次都产出结果
>
> 当用户说"帮我定期检查 XX，有问题告诉我"→ 用心跳。
> 当用户说"每天 9 点生成报告"→ 用定时任务。

### 原则二：IM 通知 = notifyPlatforms 字段

> 当用户说"有问题发钉钉/飞书/TG 通知我"，设置 `notifyPlatforms` 字段，**不要**写进 prompt 或 HEARTBEAT.md。
>
> 常见触发词映射：
> | 用户说的 | 对应 notifyPlatforms 值 |
> |---------|----------------------|
> | 发到钉钉/DingTalk | `"dingtalk"` |
> | 发到飞书/Lark | `"feishu"` |
> | 发到 Telegram/TG | `"telegram"` |
> | 发到 Discord | `"discord"` |
> | 发到云信/NIM | `"nim"` |

### 原则三：HEARTBEAT.md 是巡查清单

> HEARTBEAT.md 是 Agent 每次巡查时读取的任务清单。用自然语言写，每条一行。
> - 保持简短（3-8 条）
> - 写清判断条件（什么时候通知、什么时候不管）
> - 最后一条写"如果没有需要关注的事项，回复 HEARTBEAT_OK"

## 使用场景

当用户想要：
- 启用/禁用心跳巡查
- 修改巡查间隔（15分钟/30分钟/1小时/2小时）
- 设置活跃时段（如只在工作时间巡查）
- 编辑巡查提示词（prompt）
- 创建或编辑 HEARTBEAT.md 文件
- 查看心跳运行状态和历史
- 设置心跳通知的 IM 渠道
- 手动触发一次巡查

---

## 查看当前配置和状态

```bash
bash "$SKILLS_ROOT/heartbeat-manager/scripts/get-config.sh"
```

返回 `{ "success": true, "config": {...}, "status": {...} }`，包含：
- `config.enabled` — 是否启用
- `config.intervalMs` — 巡查间隔（毫秒）
- `config.prompt` — 巡查提示词
- `config.activeHours` — 活跃时段
- `config.notifyPlatforms` — 通知渠道
- `config.workingDirectory` — 心跳工作目录
- `status.running` — 是否正在运行
- `status.lastRunAt` — 上次运行时间戳
- `status.lastResult` — 上次结果（ok/notified/error/skipped）
- `status.nextRunAt` — 下次运行时间戳

---

## 修改配置

只传入需要修改的字段（部分更新）：

```bash
cat > /tmp/heartbeat-config.json <<'JSON'
{
  "enabled": true,
  "intervalMs": 1800000
}
JSON

bash "$SKILLS_ROOT/heartbeat-manager/scripts/set-config.sh" @/tmp/heartbeat-config.json
```

### 可修改字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | boolean | 是否启用心跳 |
| `intervalMs` | number | 巡查间隔（毫秒）。常用值：900000(15m), 1800000(30m), 3600000(1h), 7200000(2h) |
| `prompt` | string | 巡查提示词（Agent 每次收到的指令） |
| `activeHours` | object/null | 活跃时段 `{ "start": "08:00", "end": "22:00", "timezone": "Asia/Shanghai" }` 或 `null`（全天） |
| `notifyPlatforms` | string[] | 通知渠道 `["dingtalk","feishu","telegram","discord","nim"]` |
| `ackMaxChars` | number | 通知消息最大字符数（默认 300） |
| `workingDirectory` | string | 心跳工作目录（HEARTBEAT.md 所在目录） |

### 常用间隔对照

| 用户说的 | intervalMs 值 |
|---------|--------------|
| 15分钟 | `900000` |
| 30分钟 | `1800000` |
| 1小时 | `3600000` |
| 2小时 | `7200000` |

---

## 查看/编辑 HEARTBEAT.md

### 读取文件

```bash
bash "$SKILLS_ROOT/heartbeat-manager/scripts/get-file.sh"
```

返回 `{ "success": true, "exists": true/false, "content": "..." }`

### 写入文件

```bash
cat > /tmp/heartbeat-file.json <<'JSON'
{
  "content": "# 心跳巡查任务\n\n- 检查邮箱有没有紧急邮件\n- 检查 GitHub 是否有新 Issue\n- 如果没有需要关注的事项，回复 HEARTBEAT_OK\n"
}
JSON

bash "$SKILLS_ROOT/heartbeat-manager/scripts/set-file.sh" @/tmp/heartbeat-file.json
```

**编写 HEARTBEAT.md 的要求**：
- 每条任务一行自然语言描述
- 写清判断条件（什么时候通知、什么时候不管）
- 保持简短（3-8 条），控制 token 消耗
- 最后写"如果没有需要关注的事项，回复 HEARTBEAT_OK"

---

## 手动触发一次巡查

```bash
bash "$SKILLS_ROOT/heartbeat-manager/scripts/run-now.sh"
```

返回巡查结果：`{ "success": true, "result": { "result": "ok"|"notified"|"error", ... } }`

---

## 查看历史记录

```bash
bash "$SKILLS_ROOT/heartbeat-manager/scripts/get-history.sh"
```

返回最近 50 条巡查历史：`{ "success": true, "history": [...] }`

---

## 完整配置示例

### 示例 1：用户说"帮我每30分钟检查邮箱，有紧急邮件通过钉钉通知我"

**Step 1: 写 HEARTBEAT.md**
```bash
cat > /tmp/heartbeat-file.json <<'JSON'
{
  "content": "# 心跳巡查任务\n\n## 邮件监控\n- 检查收件箱是否有紧急邮件（主题包含\"紧急\"、\"urgent\"、\"ASAP\"、\"P0\"）\n- 如果有，摘要邮件标题、发件人和核心内容\n\n## 默认\n- 如果没有需要关注的事项，回复 HEARTBEAT_OK\n"
}
JSON

bash "$SKILLS_ROOT/heartbeat-manager/scripts/set-file.sh" @/tmp/heartbeat-file.json
```

**Step 2: 设置配置**
```bash
cat > /tmp/heartbeat-config.json <<'JSON'
{
  "enabled": true,
  "intervalMs": 1800000,
  "activeHours": { "start": "08:00", "end": "22:00" },
  "notifyPlatforms": ["dingtalk"]
}
JSON

bash "$SKILLS_ROOT/heartbeat-manager/scripts/set-config.sh" @/tmp/heartbeat-config.json
```

### 示例 2：用户说"关闭心跳巡查"

```bash
cat > /tmp/heartbeat-config.json <<'JSON'
{
  "enabled": false
}
JSON

bash "$SKILLS_ROOT/heartbeat-manager/scripts/set-config.sh" @/tmp/heartbeat-config.json
```

### 示例 3：用户说"把心跳的检查内容改成监控 GitHub"

先查看当前 HEARTBEAT.md：
```bash
bash "$SKILLS_ROOT/heartbeat-manager/scripts/get-file.sh"
```

然后写入新内容：
```bash
cat > /tmp/heartbeat-file.json <<'JSON'
{
  "content": "# 心跳巡查任务\n\n## GitHub 监控\n- 检查 myorg/myapp 过去 30 分钟是否有新 Issue 或 PR\n- 检查是否有 CI 构建失败\n- 检查是否有指派给我的 review 请求\n\n## 默认\n- 如果都没有，回复 HEARTBEAT_OK\n"
}
JSON

bash "$SKILLS_ROOT/heartbeat-manager/scripts/set-file.sh" @/tmp/heartbeat-file.json
```

## 重要注意事项

- **IM 通知分离**：用户提到"发到钉钉/飞书/TG"时，设置 `notifyPlatforms` 字段，**不要**写进 prompt 或 HEARTBEAT.md
- **编码安全（Windows）**：含中文 payload 必须使用 `@file` 方式
- **心跳会话可见**：心跳巡查使用一个持久 Cowork 会话 `[Heartbeat] 巡查`，用户可在会话列表中查看完整对话记录
- **HEARTBEAT_OK 静默**：Agent 回复包含 `HEARTBEAT_OK` 时不推送通知
- **重复抑制**：24 小时内相同的告警内容会被自动抑制
- **活跃时段**：设置后超出时段的巡查会被跳过
