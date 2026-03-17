# 潮汐之音 (mood-chat)

为 [my-neuro](https://github.com/morettt/my-neuro) 框架开发的心情系统插件。AI 的心情如潮汐般涨落——不仅自动调整主动对话的频率，还会实时影响 AI 的说话语气和态度。

## 它做了什么

传统的主动对话只是定时触发，AI 的态度始终如一。潮汐之音让 AI 拥有一个 0~100 的心情值，这个值会根据和用户的互动实时变化，并产生两个维度的影响：

1. **对话频率** — 心情好时话多，心情差时沉默
2. **说话态度** — 心情好时活泼热情，心情差时冷淡疏离（通过实时注入 system prompt 实现）

## 工作流程

```
启动 → 读取持久化文件恢复心情 → 如果是新的一天，异步读取 AI 日志评估初始心情
                                                          ↓
运行中 ← 根据心情值调度下次主动对话 ← 心情分数更新 ← 情感评估 / 速度感知 / 无回复衰减 / 自然回归
  ↓
每次 LLM 请求 → onLLMRequest 钩子 → 将心情分数 + 趋势 + 原因链 + 态度指令注入 system prompt
```

## 心情状态

| 状态 | 心情值 | 默认对话间隔 | AI 态度倾向 |
|------|--------|-------------|------------|
| 兴奋 | >= 90 | 5 秒 | 活泼热情，主动找话聊 |
| 正常 | >= 80 | 30 秒 | 自然随意，正常互动 |
| 低落 | >= 60 | 60 秒 | 简短冷淡，不太想搭理人 |
| 沉默 | < 60 | 不主动对话 | 冷漠疏离，话极少 |

以上间隔和阈值均可在配置中自定义。

## 心情变化的 5 个来源

| 来源 | 触发时机 | 影响范围 |
|------|---------|---------|
| AI 日志评估 | 启动时 / 新的一天 | 根据昨天的日志评估初始心情（需配合 ai-log 插件） |
| 实时情感分析 | 每轮对话结束后 | 独立 LLM 分析用户态度，返回 -20 ~ +20 的心情变化 |
| 回复速度感知 | 用户回复时 | 回复越快加成越高（3秒内 1.5x，9秒以上 0.5x） |
| 无回复衰减 | 主动对话后用户超时未回复 | 心情下降（默认 -10） |
| 自然回归 | 持续运行中 | 心情值定时向稳定值靠拢（默认每 60 秒回归 1 点） |

## 心情态度注入

这是本插件的核心特性。开启后（默认开启），每次 LLM 请求时会在 system prompt 末尾追加一段心情状态描述，格式如下：

```
[心情系统 - 实时状态，必须遵循] 你拥有真实的心情波动，以下状态反映你此刻的真实感受，必须据此调整语气和态度，优先级高于默认性格设定：
当前心情: 67/100（低落）| 趋势: 下降中
最近变化: 用户敷衍回复(-5) → 用户未回应(-10)
你现在心情不好。回复简短冷淡，问什么答什么不多说，语气少了平时的活泼多了不耐烦。
```

其中：
- **框架指令**（第一行）告诉 LLM 这是实时状态，必须遵循
- **分数和趋势** 让 LLM 了解心情的精确程度和走向
- **最近变化** 提供原因链，LLM 可以据此做出更合理的情绪反应（比如"因为用户敷衍所以不开心"和"因为等太久所以不开心"表现会不同）
- **态度指令** 直接告诉 LLM 当前应该用什么语气说话

4 个心情区间的态度模板均可在配置中自定义，适配不同角色性格。

如果不需要此功能，可将 `mood_injection_enabled` 设为 `false`，心情系统将仅影响主动对话频率。

## 前置依赖

> **强烈推荐配套安装 [AI 日志插件 (ai-log)](https://github.com/A-night-owl-Rabbit/my-neuro-plugin-ai-log)**

ai-log 插件生成的每日日志是潮汐之音「初始心情评估」的数据来源。两者配合可实现：

- **跨会话心情记忆** — AI 重启后根据昨天的互动质量自动恢复心情，而非从默认值开始
- **心情有据可依** — 心情基于真实对话记录，由独立 LLM 从整体基调、结尾情绪、互动关系三个维度评估
- **人格连贯性** — ai-log 写入核心记忆，潮汐之音从日志评估情绪，共同构建「有昨天、有今天」的 AI 人格

不安装 ai-log 插件也能正常运行，但每次重启后会从默认心情值开始。

## 安装

将插件目录放入 `plugins/community/mood-chat/` 或 `plugins/built-in/mood-chat/`，在 `enabled_plugins.json` 中启用。

## 配置说明

编辑 `plugin_config.json`，为需要修改的配置项添加 `value` 字段覆盖 `default` 值。

### 必须配置

| 配置项 | 说明 | 为什么必须 |
|--------|------|-----------|
| `evaluation_model.api_key` | 评估 LLM 的 API 密钥 | 没有 key 则情感分析和初始评估不可用 |
| `ai_log_folder` | AI 日志文件目录的绝对路径 | 留空则初始心情评估不可用 |

### 主动对话配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `intervals.excited / normal / low / silent` | 各心情状态的对话间隔（秒），-1 不主动 | 5 / 30 / 60 / -1 |
| `thresholds.excited / normal / low` | 心情状态分界阈值 | 90 / 80 / 60 |
| `response_timeout` | 等待用户回复超时（毫秒） | 10000 |
| `prompt` | 触发主动对话时附加给主 LLM 的指令 | 英文通用指令 |

### 心情变化配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `mood_changes.user_response` | 情感评估失败时的后备加分值 | 5 |
| `mood_changes.no_response` | 用户不回复时的扣分值 | -10 |
| `mood_changes.regression_target` | 心情自然回归的目标值 | 80 |
| `mood_changes.regression_interval` | 回归间隔（毫秒） | 60000 |

### 评估模型配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `evaluation_model.api_url` | 评估 LLM 的 API 地址 | SiliconFlow |
| `evaluation_model.api_key` | API 密钥 | 空（必填） |
| `evaluation_model.model` | 模型名称 | deepseek-ai/DeepSeek-V3.2 |
| `max_retries` | API 失败重试次数 | 3 |

### 日志与持久化

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `ai_log_folder` | AI 日志目录绝对路径 | 空（必填） |
| `ai_log_filename_template` | 日志文件名模板，`{date}` 替换为日期 | `{date}AI日志.txt` |
| `night_hour_start` | 凌晨几点前算前一天 | 7 |
| `mood_persistence_max_hours` | 心情持久化有效时长（小时），超出则重新评估 | 48 |

### 提示词配置

| 配置项 | 说明 |
|--------|------|
| `initial_evaluation_prompt` | 启动时基于日志评估初始心情的提示词，LLM 需返回 JSON |
| `sentiment_evaluation_prompt` | 每轮对话后评估情感的提示词，支持 `{userMsg}` 和 `{aiMsg}` 占位符 |

### 心情态度注入配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `mood_injection_enabled` | 是否启用心情态度注入到 system prompt | true |
| `mood_injection_prefix` | 注入文本的框架指令（告知 LLM 优先级） | 见配置文件 |
| `mood_attitude_templates.excited` | 兴奋时的态度描述 | 活泼带笑意... |
| `mood_attitude_templates.normal` | 正常时的态度描述 | 该吐槽吐槽... |
| `mood_attitude_templates.low` | 低落时的态度描述 | 简短冷淡... |
| `mood_attitude_templates.bad` | 很差时的态度描述 | 冷漠疏离... |

态度模板需要根据你的 AI 角色性格来编写。默认模板是通用风格，建议用 `value` 覆盖为角色专属版本。

## 文件说明

| 文件 | 说明 |
|------|------|
| `index.js` | 插件入口。接入 `onStart` / `onStop` 生命周期，`onLLMRequest` 钩子注入心情状态，`onLLMResponse` 钩子触发情感评估 |
| `MoodChatModule.js` | 核心逻辑。心情评估、持久化、对话调度、态度注入文本生成 |
| `metadata.json` | 插件元信息 |
| `plugin_config.json` | 配置 schema，用户添加 `value` 字段覆盖默认值 |

## 依赖

- [my-neuro](https://github.com/morettt/my-neuro) 框架（Plugin 基类、事件总线、LLM 钩子等）
- [AI 日志插件 (ai-log)](https://github.com/A-night-owl-Rabbit/my-neuro-plugin-ai-log)（强烈推荐，用于初始心情评估）
- 独立 LLM API（如 SiliconFlow）用于心情评估，不消耗主对话的 token

## 许可

MIT
