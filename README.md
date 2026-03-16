# 心情主动对话插件 (mood-chat)

为 [my-neuro](https://github.com/A-night-owl-Rabbit) 框架开发的心情主动对话插件。AI 会根据当前心情自动调整主动对话频率，并通过多维度评估实时更新心情状态。

## 功能特性

- **心情驱动对话** — 心情越好，主动对话越频繁；心情低落时减少打扰
- **AI 日志评估** — 启动时读取上一天的 AI 日志，评估初始心情状态
- **心情持久化** — 重启后恢复上次心情，自动计算离线期间的心情衰减
- **实时情感分析** — 每轮对话后异步调用独立 LLM 评估情感变化（不影响主对话）
- **回复速度感知** — 用户回复越快，心情加成越高
- **心情回归机制** — 心情值随时间自动回归到稳定值
- **API 重试** — 评估 API 调用失败时自动重试

## 心情系统

心情值范围 0~100，对应 4 个状态：

| 状态 | 心情值 | 默认对话间隔 |
|------|--------|-------------|
| 兴奋 | ≥ 90 | 5 秒 |
| 普通 | ≥ 80 | 30 秒 |
| 低落 | ≥ 60 | 120 秒 |
| 沉默 | < 60 | 不主动对话 |

### 心情变化来源

1. **初始评估**：基于 AI 日志，由独立 LLM 分析整体基调、结尾情绪、互动关系
2. **实时情感**：每轮对话后，LLM 分析用户态度和互动质量，返回 -20~+20 的 delta
3. **速度系数**：根据用户回复速度，对 delta 施加 0.5x~1.5x 的乘数
4. **无回复衰减**：AI 主动说话后用户未回应，心情下降
5. **自然回归**：心情值定时向稳定值靠拢

## 安装

将插件目录放入 `plugins/community/mood-chat/` 或 `plugins/built-in/mood-chat/`，然后在 `enabled_plugins.json` 中添加对应路径。

## 配置

编辑 `plugin_config.json`，为每个配置项添加 `value` 字段：

### 基础配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| intervals | 各心情状态的对话间隔（秒） | 兴奋5s / 普通30s / 低落120s |
| thresholds | 心情状态分界阈值 | 兴奋90 / 普通80 / 低落60 |
| mood_changes | 心情变化幅度 | 回复+5 / 无回复-10 / 回归目标80 |
| response_timeout | 等待用户回复超时（毫秒） | 10000 |

### 评估模型配置

| 配置项 | 说明 |
|--------|------|
| evaluation_model.api_url | 评估 LLM 的 API 地址（如 SiliconFlow） |
| evaluation_model.api_key | 评估 LLM 的 API 密钥 |
| evaluation_model.model | 评估使用的模型名称 |

### 日志与持久化

| 配置项 | 说明 |
|--------|------|
| ai_log_folder | AI 日志文件所在目录（由 ai-log 插件生成） |
| ai_log_filename_template | 日志文件名模板，`{date}` 替换为日期 |
| night_hour_start | 凌晨几点前算前一天 |
| mood_persistence_max_hours | 心情持久化最大有效时长（小时） |
| max_retries | 评估 API 最大重试次数 |

### 提示词配置

| 配置项 | 说明 |
|--------|------|
| prompt | 触发主动对话时附加给主 LLM 的指令 |
| initial_evaluation_prompt | 启动时基于日志评估初始心情的提示词 |
| sentiment_evaluation_prompt | 每轮对话后评估情感的提示词，支持 `{userMsg}` 和 `{aiMsg}` 占位符 |

## 文件说明

| 文件 | 说明 |
|------|------|
| `index.js` | 插件入口，接入框架生命周期和 `onLLMResponse` 钩子 |
| `MoodChatModule.js` | 核心心情逻辑模块 |
| `metadata.json` | 插件元信息 |
| `plugin_config.json` | 配置 schema（用户需自行填入 value） |

## 依赖

- [my-neuro](https://github.com/A-night-owl-Rabbit) 框架（提供 Plugin 基类、事件总线等）
- ai-log 插件（可选，用于生成 AI 日志供心情评估）
- 独立 LLM API（如 SiliconFlow）用于心情评估
