# 潮汐之音 (mood-chat)

为 [my-neuro](https://github.com/A-night-owl-Rabbit/my-neuro) 框架开发的心情系统插件。AI 的心情如潮汐般涨落——不仅自动调整主动对话的频率，还会实时影响 AI 的说话语气和态度。

**v2.0 新增：场景感知系统** — 通过截图 + 独立视觉模型识别用户当前活动场景，动态调整对话策略。游戏时多陪伴，编程时少打扰，工作结束时说一句辛苦了。

## 功能一览

### 心情系统（v1.0）

传统的主动对话只是定时触发，AI 的态度始终如一。潮汐之音让 AI 拥有一个 0~100 的心情值，这个值会根据和用户的互动实时变化，并产生两个维度的影响：

1. **对话频率** — 心情好时话多，心情差时沉默
2. **说话态度** — 心情好时活泼热情，心情差时冷淡疏离（通过实时注入 system prompt 实现）

### 场景感知系统（v2.0 新增）

在心情的基础上增加「场景」维度，让 AI 不只是根据心情决定说不说话，还能根据用户**正在做什么**来决定**怎么说话**：

- **截图识别场景**：定时截图，调用独立视觉模型（如 SiliconFlow Qwen2.5-VL）自动分类当前场景
- **场景自适应间隔**：游戏/视频时更频繁（陪伴模式），编程/办公/阅读时更稀疏（安静模式）
- **场景化提示词**：主动对话时自动追加场景上下文，让 AI 回复更贴合当前活动
- **防重复打扰**：专注型场景限制同场景连续对话次数，陪伴型场景不限制
- **任务收尾感**：从编程/办公切换到游戏/视频时，AI 主动说一句收尾的话
- **时间感知**：根据时段（早上/下午/晚上/深夜）调整语气指引，深夜自动降低对话频率
- **场景惯性**：游戏场景具有粘性，不会因为游戏内的过场动画或对话界面被误判为其他场景

#### 场景分类

| 场景 | 类型 | 间隔系数 | 说明 |
| --- | --- | --- | --- |
| 游戏 (gaming) | 陪伴型 | 0.7x（更频繁） | 不限制同场景对话次数，配合洛基之影插件自动查攻略 |
| 视频/动漫 (video) | 陪伴型 | 0.7x（更频繁） | 不限制同场景对话次数，可搜索剧情信息 |
| 编程 (coding) | 专注型 | 2.0x（更稀疏） | 限制同场景连续对话，减少打扰 |
| 办公 (office) | 专注型 | 1.5x（更稀疏） | 限制同场景连续对话 |
| 阅读 (reading) | 专注型 | 3.0x（大幅减少） | 限制同场景连续对话 |
| 浏览 (browsing) | 中性 | 1.0x | 正常频率 |
| 空闲 (idle) | 中性 | 0.5x（更频繁） | 用户闲着，多聊几句 |

> 间隔系数乘在心情驱动的基础间隔上。例如心情正常（300秒）+ 游戏场景（×0.7）= 210秒触发一次。

### 游戏场景与洛基之影插件

在游戏场景下，插件会在主动对话的提示词中**强制要求** AI 调用 [洛基之影 (loki-shadow)](https://github.com/A-night-owl-Rabbit/my-neuro-plugin-loki-shadow) 游戏陪玩插件的 `loki_shadow_query` 工具来查询当前游戏的攻略信息。

**启用洛基之影的好处：**

- AI 不再只是空聊，而是能根据当前游戏画面主动查询攻略、Boss 打法、任务流程
- 5 源并行搜索（游民星空/B站/TapTap/NGA/米游社），信息覆盖面广
- 本地攻略库缓存，重复问题秒回不费 token
- 自动检测当前游戏名称，无需用户手动告知
- AI 可以把查到的攻略用自己的风格转述，实现真正的「游戏陪玩」体验

**如果不安装洛基之影**，游戏场景下 AI 仍会尝试调用 `loki_shadow_query` 工具，但调用会失败并回退为普通对话。建议在使用场景感知功能时同时启用洛基之影插件。

### 视频/动漫场景与搜索工具

在视频/动漫场景下，插件会提示 AI 可以调用 `web_search` 等搜索工具来查询当前作品的剧情、角色等信息，让 AI 像一起看的朋友一样自然地聊起来。

## 心情状态

| 状态 | 心情值 | 默认对话间隔 | AI 态度倾向 |
| --- | --- | --- | --- |
| 兴奋 | >= 90 | 250 秒 | 活泼热情，主动找话聊 |
| 正常 | >= 80 | 300 秒 | 自然随意，正常互动 |
| 低落 | >= 60 | 600 秒 | 简短冷淡，不太想搭理人 |
| 沉默 | < 60 | 不主动对话 | 冷漠疏离，话极少 |

以上间隔和阈值均可在配置中自定义。

## 心情变化的 5 个来源

| 来源 | 触发时机 | 影响范围 |
| --- | --- | --- |
| AI 日志评估 | 启动时 / 新的一天 | 根据昨天的日志评估初始心情（需配合 ai-log 插件） |
| 实时情感分析 | 每轮对话结束后 | 独立 LLM 分析用户态度，返回 -20 ~ +20 的心情变化 |
| 回复速度感知 | 用户回复时 | 回复越快加成越高（3秒内 1.5x，9秒以上 0.5x） |
| 无回复衰减 | 主动对话后用户超时未回复 | 心情下降（默认 -5） |
| 自然回归 | 持续运行中 | 心情值定时向稳定值靠拢（默认每 60 秒回归 1 点） |

## 心情态度注入

开启后（默认开启），每次 LLM 请求时会在 system prompt 末尾追加一段心情状态描述：

```
[心情系统 - 实时状态，必须遵循] 你拥有真实的心情波动，以下状态反映你此刻的真实感受，必须据此调整语气和态度，优先级高于默认性格设定：
当前心情: 67/100（低落）| 趋势: 下降中
最近变化: 用户敷衍回复(-5) → 用户未回应(-5)
你现在心情不好。回复简短冷淡，问什么答什么不多说，语气少了平时的活泼多了不耐烦。
现在是晚上，语气可以更放松。
```

4 个心情区间的态度模板均可在配置中自定义，适配不同角色性格。

## 工作流程

```
启动
  → 恢复持久化心情 → 如果是新一天，异步评估初始心情
  → 启动 SceneDetector（定时截图 + 视觉模型分类）
  → 挂载 ProactiveEnhancer（包装调度/对话/注入方法）
                            ↓
运行中
  ┌─ 心情系统：情感评估 / 速度感知 / 无回复衰减 / 自然回归 → 更新心情分数
  ├─ 场景检测：每 30 秒截图 → hash 对比 → 变化时调视觉模型分类
  ├─ 对话调度：基础间隔(心情) × 场景系数 × 深夜系数 → 计算下次对话时间
  ├─ 执行对话：防重复检查 → 追加场景 prompt → 原始 executeChat → 恢复 prompt
  └─ 收尾感知：工作场景持续 30 分钟后切到休闲 → 触发收尾对话
                            ↓
每次 LLM 请求
  → getMoodInjection → 心情状态 + 时间语气指引 → 注入 system prompt
```

## 前置依赖

### 强烈推荐

- **AI 日志插件 (ai-log)** — 每日日志是心情初始评估的数据来源，实现跨会话心情记忆
- **洛基之影 (loki-shadow)** — 游戏场景下自动查询攻略，实现真正的游戏陪玩体验

### 场景感知需要

- **SiliconFlow 账号** — 场景检测需要调用视觉模型 API（推荐 Qwen2.5-VL-7B，$0.05/M tokens）
- **my-neuro 的 vision.auto_screenshot 功能** — 需在 config.json 中启用 `vision.enabled` 和 `vision.auto_screenshot`

## 安装

1. 将插件目录放入 `plugins/built-in/mood-chat/` 或 `plugins/community/mood-chat/`
2. 在 `enabled_plugins.json` 中添加 `"mood-chat"`
3. 编辑 `plugin_config.json`，添加 `value` 字段覆盖需要修改的配置

## 配置说明

### 必须配置

| 配置项 | 说明 |
| --- | --- |
| evaluation_model.api_key | 心情评估 LLM 的 API 密钥（SiliconFlow） |
| scene_vision_model.api_key | 场景识别视觉模型的 API 密钥（可与上面共用） |

### 场景感知配置（v2.0 新增）

| 配置项 | 说明 | 默认值 |
| --- | --- | --- |
| scene_vision_model | 视觉模型配置（api_url / api_key / model） | SiliconFlow + Qwen2.5-VL-7B |
| scene_detection_enabled | 是否启用场景感知 | true |
| scene_check_interval | 场景检测间隔（毫秒） | 30000 |
| scene_interval_multipliers | 各场景间隔系数 | 见场景分类表 |
| anti_repeat_enabled | 是否启用防重复（仅限专注型场景） | true |
| max_same_scene_chats | 同场景连续对话上限 | 2 |
| task_end_enabled | 是否启用任务收尾感 | true |
| task_end_min_duration | 触发收尾的最短工作时长（毫秒） | 1800000（30 分钟） |
| time_aware_enabled | 是否启用时间感知 | true |
| late_night_multiplier | 深夜（23:00~6:00）间隔倍率 | 2.0 |

### 心情系统配置

| 配置项 | 说明 | 默认值 |
| --- | --- | --- |
| intervals | 各心情状态的对话间隔（秒） | 250 / 300 / 600 / -1 |
| thresholds | 心情状态分界阈值 | 90 / 80 / 60 |
| mood_changes | 各事件对心情的影响 | 见配置文件 |
| response_timeout | 等待用户回复超时（毫秒） | 60000 |
| prompt | 主动对话时附加的提示词 | 通用英文指令 |
| mood_injection_enabled | 是否启用心情态度注入 | true |
| mood_attitude_templates | 各心情区间的态度模板 | 通用风格 |

### 评估模型与日志

| 配置项 | 说明 | 默认值 |
| --- | --- | --- |
| evaluation_model | 评估 LLM 配置（api_url / api_key / model） | SiliconFlow + DeepSeek-V3.2 |
| ai_log_folder | AI 日志目录绝对路径 | 空（需填写） |
| ai_log_filename_template | 日志文件名模板 | {date}AI日志.txt |
| initial_evaluation_prompt | 初始心情评估提示词 | 通用版本 |
| sentiment_evaluation_prompt | 实时情感评估提示词 | 通用版本 |

> **注意**：`scene_vision_model.model` 必须填写支持图片输入的 **VL 模型**（如 `Qwen/Qwen2.5-VL-7B-Instruct`），纯文本模型会导致 API 返回 404。

## 文件说明

| 文件 | 说明 |
| --- | --- |
| index.js | 插件入口。生命周期管理，LLM 钩子，初始化场景检测和增强模块 |
| MoodChatModule.js | 心情核心逻辑。评估、持久化、对话调度、态度注入 |
| SceneDetector.js | 场景检测模块。截图 + 视觉模型分类 + 变化检测 + 场景惯性 |
| ProactiveEnhancer.js | 主动对话增强。场景系数 + 防重复 + 时间感知 + 收尾感 + 工具引导 |
| metadata.json | 插件元信息 |
| plugin_config.json | 配置 schema |

## 架构

```
index.js (插件入口)
  ├── MoodChatModule (心情核心，不修改)
  │     ├── 心情评估 / 持久化 / 对话调度
  │     └── getMoodInjection / getChatInterval / executeChat
  │
  ├── SceneDetector (场景检测)
  │     ├── take-screenshot IPC → 截图
  │     ├── hash 对比 → 变化检测
  │     ├── SiliconFlow VL 模型 → 场景分类
  │     └── 场景惯性 + 历史记录 + 变化回调
  │
  └── ProactiveEnhancer (方法包装，零侵入)
        ├── 包装 getChatInterval → ×场景系数 ×深夜系数
        ├── 包装 executeChat → 防重复 + 追加场景 prompt + 工具引导
        ├── 包装 getMoodInjection → +时间语气指引
        └── 场景切换回调 → 任务收尾感对话
```

ProactiveEnhancer 通过 monkey-patch 包装 MoodChatModule 的方法，不修改核心代码。`uninstall()` 可完全恢复原始行为。

## 依赖

- my-neuro 框架（Plugin 基类、事件总线、LLM 钩子等）
- AI 日志插件 (ai-log)（强烈推荐）
- 洛基之影 (loki-shadow)（游戏陪玩场景强烈推荐）
- SiliconFlow API（心情评估 + 场景识别视觉模型）

## 许可

MIT
