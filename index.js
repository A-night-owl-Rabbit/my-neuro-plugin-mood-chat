// plugins/built-in/mood-chat/index.js
const { Plugin } = require('../../../js/core/plugin-base.js');
const { MoodChatModule } = require('../../../js/ai/MoodChatModule.js');
const { SceneDetector } = require('./SceneDetector.js');
const { ProactiveEnhancer } = require('./ProactiveEnhancer.js');

const { eventBus } = require('../../../js/core/event-bus.js');
const { Events } = require('../../../js/core/events.js');

class MoodChatPlugin extends Plugin {
    constructor(metadata, context) {
        super(metadata, context);
        this._module = null;
        this._isUserTriggered = false;
    }

    async onStart() {
        const pluginConfig = this.context.getPluginFileConfig();
        this._module = new MoodChatModule(pluginConfig);
        global.moodChatModule = this._module;
        this._module.start();

        this._onUserMsgBound = () => { this._isUserTriggered = true; };
        eventBus.on(Events.USER_MESSAGE_RECEIVED, this._onUserMsgBound);

        this._sceneDetector = new SceneDetector(pluginConfig);
        this._enhancer = new ProactiveEnhancer(this._module, this._sceneDetector, pluginConfig);
        this._sceneDetector.start();
        this._enhancer.install();
    }

    async onStop() {
        if (this._enhancer) {
            this._enhancer.uninstall();
            this._enhancer = null;
        }
        if (this._sceneDetector) {
            this._sceneDetector.stop();
            this._sceneDetector = null;
        }
        if (this._module) {
            this._module.stop();
            this._module = null;
        }
        if (this._onUserMsgBound) {
            eventBus.off(Events.USER_MESSAGE_RECEIVED, this._onUserMsgBound);
        }
    }

    async onLLMRequest(request) {
        if (!this._module) return;
        const injection = this._module.getMoodInjection();
        if (!injection) return;
        const sys = request.messages.find(m => m.role === 'system');
        if (sys) {
            sys.content += '\n' + injection;
        }
    }

    async onLLMResponse(response) {
        if (!this._module) return;

        // 只对用户真正发言触发的回复进行情感评估，跳过插件/工具触发的 LLM 调用
        if (!this._isUserTriggered) return;
        this._isUserTriggered = false;

        const voiceChat = global.voiceChat;
        if (!voiceChat?.messages) return;

        // 从消息历史中找最后一条 user 消息
        let lastUserMsg = null;
        for (let i = voiceChat.messages.length - 1; i >= 0; i--) {
            const msg = voiceChat.messages[i];
            if (msg.role === 'user') {
                lastUserMsg = typeof msg.content === 'string'
                    ? msg.content
                    : (Array.isArray(msg.content)
                        ? msg.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
                        : null);
                break;
            }
        }

        if (!lastUserMsg || !response.text) return;

        // 截断过长的内容，避免 token 浪费
        const maxLen = 500;
        const userSnippet = lastUserMsg.length > maxLen ? lastUserMsg.substring(0, maxLen) + '...' : lastUserMsg;
        const aiSnippet   = response.text.length > maxLen ? response.text.substring(0, maxLen) + '...' : response.text;

        // 异步评估，fire-and-forget
        this._module.evaluateConversationSentiment(userSnippet, aiSnippet).catch(() => {});
    }
}

module.exports = MoodChatPlugin;
