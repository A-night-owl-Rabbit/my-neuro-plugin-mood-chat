const { eventBus } = require('../../../js/core/event-bus.js');
const { Events } = require('../../../js/core/events.js');
const { logToTerminal } = require('../../../js/api-utils.js');

const COMPANION_SCENES = ['gaming', 'video'];
const RECENT_TOPICS_MAX = 8;

const DEFAULT_SCENE_MULTIPLIERS = {
    coding: 2.0,
    office: 1.5,
    reading: 3.0,
    gaming: 0.7,
    video: 0.7,
    browsing: 1.0,
    chat: 1.0,
    music: 1.0,
    design: 1.5,
    idle: 0.5,
    unknown: 1.0
};

class ProactiveEnhancer {
    constructor(module, sceneDetector, config) {
        this._module = module;
        this._sceneDetector = sceneDetector;
        this._config = config;

        this._recentTopics = [];

        // 保存原始方法引用，用于 uninstall 恢复
        this._origGetChatInterval = null;
        this._origExecuteChat = null;
        this._origGetMoodInjection = null;
        this._sceneChangeHandler = null;
        this._installed = false;
    }

    install() {
        if (this._installed) return;
        this._installed = true;

        this._patchGetChatInterval();
        this._patchExecuteChat();
        this._patchGetMoodInjection();
        this._setupTaskEndSense();

        logToTerminal('info', '主动对话增强已挂载');
    }

    uninstall() {
        if (!this._installed) return;

        if (this._origGetChatInterval) {
            this._module.getChatInterval = this._origGetChatInterval;
        }
        if (this._origExecuteChat) {
            this._module.executeChat = this._origExecuteChat;
        }
        if (this._origGetMoodInjection) {
            this._module.getMoodInjection = this._origGetMoodInjection;
        }

        this._installed = false;
        logToTerminal('info', '主动对话增强已卸载，方法已恢复');
    }

    // ===== getChatInterval：场景系数 + 深夜系数 =====

    _patchGetChatInterval() {
        const self = this;
        this._origGetChatInterval = this._module.getChatInterval.bind(this._module);
        const origFn = this._origGetChatInterval;

        this._module.getChatInterval = function () {
            const base = origFn();
            if (base === Infinity) return base;

            const scene = self._sceneDetector.getCurrentScene();
            const customMul = self._config.scene_interval_multipliers || {};
            const sceneMul = customMul[scene.type] ?? DEFAULT_SCENE_MULTIPLIERS[scene.type] ?? 1.0;

            const hour = new Date().getHours();
            const timeMul = (hour >= 23 || hour < 6)
                ? (self._config.late_night_multiplier ?? 2.0)
                : 1.0;

            const result = Math.round(base * sceneMul * timeMul);
            return result;
        };
    }

    // ===== executeChat：防重复 + 场景 prompt 追加 =====

    _patchExecuteChat() {
        const self = this;
        this._origExecuteChat = this._module.executeChat.bind(this._module);
        const origFn = this._origExecuteChat;
        const module = this._module;

        module.executeChat = async function () {
            const scene = self._sceneDetector.getCurrentScene();

            // 防重复：仅对非陪伴型场景限制
            if (self._config.anti_repeat_enabled !== false
                && !COMPANION_SCENES.includes(scene.type)
                && scene.type !== 'unknown') {
                const maxSame = self._config.max_same_scene_chats || 2;
                const sameCount = self._recentTopics.filter(t => t.type === scene.type).length;
                if (sameCount >= maxSame) {
                    logToTerminal('info', `防重复: ${scene.label}场景已连续对话${sameCount}次，跳过`);
                    module.scheduleNextChat();
                    return;
                }
            }

            // 临时追加场景 prompt
            const origPrompt = module.prompt;
            const sceneHint = self._buildScenePrompt(scene);
            if (sceneHint) {
                module.prompt = origPrompt + '\n\n' + sceneHint;
            }

            try {
                await origFn();
            } finally {
                module.prompt = origPrompt;
                self._recordTopic(scene);
            }
        };
    }

    // ===== getMoodInjection：时间语气指引 =====

    _patchGetMoodInjection() {
        const self = this;
        this._origGetMoodInjection = this._module.getMoodInjection.bind(this._module);
        const origFn = this._origGetMoodInjection;

        this._module.getMoodInjection = function () {
            const base = origFn();
            if (!base) return base;
            if (self._config.time_aware_enabled === false) return base;

            const hour = new Date().getHours();
            let timeHint;
            if (hour >= 6 && hour < 12)       timeHint = '现在是早上，语气可以更清醒轻快。';
            else if (hour >= 12 && hour < 18)  timeHint = '现在是下午，语气自然直接即可。';
            else if (hour >= 18 && hour < 22)  timeHint = '现在是晚上，语气可以更放松。';
            else                               timeHint = '现在已经很晚了，尽量低打扰，语气温柔简短。';

            return base + '\n' + timeHint;
        };
    }

    // ===== 任务收尾感 =====

    _setupTaskEndSense() {
        const self = this;
        const module = this._module;

        this._sceneChangeHandler = (oldScene, newScene) => {
            if (self._config.task_end_enabled === false) return;

            const workTypes = ['coding', 'office'];
            const restTypes = ['video', 'gaming', 'browsing', 'idle'];
            const minDuration = self._config.task_end_min_duration || 1800000;

            const duration = oldScene.endTime - oldScene.startTime;
            if (!workTypes.includes(oldScene.type)) return;
            if (!restTypes.includes(newScene.type)) return;
            if (duration < minDuration) return;

            const minutes = Math.round(duration / 60000);
            const prompt = module.prompt
                + `\n\n[收尾感知] 用户刚结束了大约${minutes}分钟的${oldScene.label}，`
                + `现在切到了${newScene.label}。顺势说一句简短的话，自然不说教。`;

            logToTerminal('info', `任务收尾感触发: ${oldScene.label}(${minutes}min) → ${newScene.label}`);

            setTimeout(async () => {
                try {
                    const { appState } = require('../../../js/core/app-state.js');
                    if (appState.isPlayingTTS() || appState.isProcessingUserInput()) return;
                    const voiceChat = global.voiceChat;
                    if (voiceChat) await voiceChat.sendToLLM(prompt);
                } catch (e) {
                    logToTerminal('warn', `收尾感对话失败: ${e.message}`);
                }
            }, 3000);
        };

        this._sceneDetector.onSceneChange(this._sceneChangeHandler);
    }

    // ===== 辅助方法 =====

    _buildScenePrompt(scene) {
        if (!scene || scene.type === 'idle' || scene.type === 'unknown') return '';

        let hint = `[场景感知补充] 当前检测到用户正在「${scene.label}」，请结合截图内容自然互动。`;

        if (scene.type === 'gaming') {
            hint += '\n用户正在玩游戏，你必须调用 loki_shadow_query 工具来查询当前游戏的相关攻略或信息，'
                  + '然后用你的风格把有用的内容告诉用户。不要空聊，先查再说。';
        } else if (scene.type === 'video') {
            hint += '\n如果你对画面里的动漫或视频内容感兴趣，或想和用户聊剧情，'
                  + '可以调用 web_search 工具搜索这部作品的剧情、角色等信息，然后自然地聊起来。';
        }

        return hint;
    }

    _recordTopic(scene) {
        this._recentTopics.push({
            type: scene.type,
            label: scene.label,
            time: Date.now()
        });
        if (this._recentTopics.length > RECENT_TOPICS_MAX) {
            this._recentTopics.shift();
        }
    }
}

module.exports = { ProactiveEnhancer };
