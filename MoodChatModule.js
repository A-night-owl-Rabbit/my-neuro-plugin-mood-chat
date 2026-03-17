// MoodChatModule.js - 基于心情系统的智能主动对话模块
const fs = require('fs');
const path = require('path');
const { appState } = require('../../../js/core/app-state.js');
const { eventBus } = require('../../../js/core/event-bus.js');
const { Events } = require('../../../js/core/events.js');
const { logToTerminal } = require('../../../js/api-utils.js');

class MoodChatModule {
    constructor(config) {
        this.config = config;

        // 对话间隔配置（秒 → 毫秒）
        this.intervals = {
            excited: (config.intervals?.excited || 5) * 1000,
            normal:  (config.intervals?.normal  || 30) * 1000,
            low:     (config.intervals?.low     || 120) * 1000,
            silent:  config.intervals?.silent   || -1
        };

        // 心情阈值配置
        this.thresholds = {
            excited: config.thresholds?.excited || 90,
            normal:  config.thresholds?.normal  || 80,
            low:     config.thresholds?.low     || 60
        };

        // 心情变化配置
        this.moodChanges = {
            userResponse:       config.mood_changes?.user_response       || 5,
            noResponse:         config.mood_changes?.no_response         || -10,
            regressionTarget:   config.mood_changes?.regression_target   || 80,
            regressionInterval: config.mood_changes?.regression_interval || 60000
        };

        this.responseTimeout = config.response_timeout || 10000;
        this.prompt = config.prompt || '请主动根据上下文说些什么。';

        // 评估模型配置（SiliconFlow 独立模型）
        const evalModel = config.evaluation_model || {};
        this.evalApiUrl = evalModel.api_url || 'https://api.siliconflow.cn/v1/chat/completions';
        this.evalApiKey = evalModel.api_key || '';
        this.evalModel  = evalModel.model   || 'deepseek-ai/DeepSeek-V3.2';

        // AI 日志相关配置
        this.aiLogFolder           = config.ai_log_folder            || 'K:\\AI日志';
        this.aiLogFilenameTemplate = config.ai_log_filename_template || '{date}肥牛的AI日志.txt';
        this.nightHourStart        = config.night_hour_start         ?? 7;
        this.persistenceMaxHours   = config.mood_persistence_max_hours ?? 48;
        this.maxRetries            = config.max_retries              ?? 3;

        // 提示词配置
        this.initialEvaluationPrompt   = config.initial_evaluation_prompt   || '';
        this.sentimentEvaluationPrompt = config.sentiment_evaluation_prompt || '';

        // 当前状态
        this.moodScore = this.moodChanges.regressionTarget;
        this.stableMood = this.moodChanges.regressionTarget;
        this.isProcessing = false;
        this.waitingForResponse = false;
        this.responseTimer = null;
        this.chatTimer = null;
        this.regressionTimer = null;
        this.lastChatTime = Date.now();
        this.ttsEndTime = Date.now();

        // 情感评估防抖标志
        this._sentimentEvaluating = false;
        // 上次用户回复时的速度系数，供异步情感评估回调使用
        this._lastSpeedBonus = 1.0;
        // 上次持久化文件的保存时间戳
        this._lastSaveTimestamp = 0;

        // mood_status.json 路径
        this._moodFilePath = path.join(__dirname, '..', '..', 'AI记录室', 'mood_status.json');
    }

    // ===== 生命周期 =====

    start() {
        eventBus.on(Events.USER_MESSAGE_RECEIVED, this._onUserResponseBound = () => this.onUserResponse());
        eventBus.on(Events.TTS_END,         this._onTtsEndBound = () => { this.ttsEndTime = Date.now(); });
        eventBus.on(Events.TTS_INTERRUPTED, this._onTtsIntBound = () => { this.ttsEndTime = Date.now(); });

        this.startMoodRegression();
        this._initMood();
    }

    stop() {
        logToTerminal('info', '🛑 停止心情对话系统');
        if (this.chatTimer)       { clearTimeout(this.chatTimer);   this.chatTimer = null; }
        if (this.responseTimer)   { clearTimeout(this.responseTimer); this.responseTimer = null; }
        if (this.regressionTimer) { clearInterval(this.regressionTimer); this.regressionTimer = null; }
        this.stopMoodFileSync();

        if (this._onUserResponseBound) eventBus.off(Events.USER_MESSAGE_RECEIVED, this._onUserResponseBound);
        if (this._onTtsEndBound)       eventBus.off(Events.TTS_END, this._onTtsEndBound);
        if (this._onTtsIntBound)       eventBus.off(Events.TTS_INTERRUPTED, this._onTtsIntBound);

        this.isProcessing = false;
        this.waitingForResponse = false;
    }

    // ===== Task 6: 统一 API 调用与重试 =====

    async _callEvaluationAPI(systemPrompt, userContent, temperature = 0.4) {
        if (!this.evalApiKey) {
            logToTerminal('warn', '⚠️ 心情评估 API Key 未配置，跳过评估');
            return null;
        }

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                const response = await fetch(this.evalApiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.evalApiKey}`
                    },
                    body: JSON.stringify({
                        model: this.evalModel,
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user',   content: userContent }
                        ],
                        max_tokens: 500,
                        temperature,
                        stream: false
                    })
                });

                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                const data = await response.json();
                const content = data.choices?.[0]?.message?.content;
                if (!content) throw new Error('API 返回空内容');
                return content;
            } catch (err) {
                logToTerminal('warn', `⚠️ 评估 API 第 ${attempt}/${this.maxRetries} 次失败: ${err.message}`);
                if (attempt < this.maxRetries) {
                    await new Promise(r => setTimeout(r, attempt * 1000));
                }
            }
        }

        logToTerminal('error', `❌ 评估 API 全部 ${this.maxRetries} 次重试失败`);
        return null;
    }

    // ===== Task 1 + 2: 初始化心情（持久化恢复 → AI日志评估 → 默认值） =====

    async _initMood() {
        const restored = this._restoreMoodFromFile();

        if (restored) {
            logToTerminal('info', `✅ 从持久化文件恢复心情: ${this.moodScore}分`);
            this.scheduleNextChat();

            if (this._isNewLogicalDay(this._lastSaveTimestamp)) {
                logToTerminal('info', '🌅 新的一天，异步刷新心情评估...');
                this._evaluateFromAILog().catch(err => {
                    this._applyInitFallback(`异常: ${err.message}`);
                });
            }
        } else {
            this.moodScore = this.moodChanges.regressionTarget;
            this.scheduleNextChat();

            logToTerminal('info', '🔍 无持久化记录，异步评估初始心情...');
            this._evaluateFromAILog().catch(err => {
                this._applyInitFallback(`异常: ${err.message}`);
            });
        }

        this.startMoodFileSync();
    }

    // Task 1: 从 mood_status.json 恢复
    _restoreMoodFromFile() {
        try {
            if (!fs.existsSync(this._moodFilePath)) return false;

            const raw = JSON.parse(fs.readFileSync(this._moodFilePath, 'utf8'));
            if (!raw.timestamp || !Number.isFinite(raw.score)) return false;

            this._lastSaveTimestamp = raw.timestamp;

            const offlineMs = Date.now() - raw.timestamp;
            const maxMs = this.persistenceMaxHours * 3600000;
            if (offlineMs > maxMs) {
                logToTerminal('info', `⏰ 离线 ${Math.round(offlineMs / 3600000)}h 超过 ${this.persistenceMaxHours}h，需重新评估`);
                return false;
            }

            // 离线回归速率 = 在线的 1/5（离线时 AI 没有经历任何事，不应快速回归）
            const offlineRegressionInterval = this.moodChanges.regressionInterval * 5;
            const steps = Math.floor(offlineMs / offlineRegressionInterval);
            let score = raw.score;
            const target = this.moodChanges.regressionTarget;
            for (let i = 0; i < steps; i++) {
                if (score > target) score--;
                else if (score < target) score++;
                else break;
            }

            this.moodScore = Math.max(0, Math.min(100, score));
            if (Number.isFinite(raw.stable)) this.stableMood = raw.stable;

            logToTerminal('info', `🔄 离线 ${Math.round(offlineMs / 60000)} 分钟，心情 ${raw.score} → ${this.moodScore} (回归 ${steps} 步)`);
            return true;
        } catch (err) {
            logToTerminal('warn', `⚠️ 读取心情持久化文件失败: ${err.message}`);
            return false;
        }
    }

    // 判断当前是否已进入新的"逻辑日"（nightHourStart 前算前一天）
    _isNewLogicalDay(savedTimestamp) {
        if (!savedTimestamp) return true;

        const getLogicalDate = (ts) => {
            const d = new Date(ts);
            if (d.getHours() < this.nightHourStart) {
                d.setDate(d.getDate() - 1);
            }
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        };

        const savedDay = getLogicalDate(savedTimestamp);
        const nowDay = getLogicalDate(Date.now());
        return savedDay !== nowDay;
    }

    // Task 2: 基于 AI 日志评估初始心情
    async _evaluateFromAILog() {
        const logContent = this._findRecentAILog();
        if (!logContent) {
            this._applyInitFallback('未找到 AI 日志文件');
            return;
        }

        logToTerminal('info', '🔍 找到 AI 日志，开始异步评估初始心情...');

        const result = await this._callEvaluationAPI(
            this.initialEvaluationPrompt,
            `以下是AI日志内容，请分析并评估心情：\n\n${logContent}`,
            0.4
        );

        if (!result) {
            this._applyInitFallback('评估 API 调用失败');
            return;
        }

        try {
            const jsonStr = result.match(/\{[\s\S]*\}/)?.[0];
            if (!jsonStr) throw new Error('未找到 JSON');

            const parsed = JSON.parse(jsonStr);
            const tone     = Number(parsed.overall_tone) || 80;
            const ending   = Number(parsed.ending_mood)  || 80;
            const relation = Number(parsed.relationship) || 80;

            const raw = tone * 0.4 + ending * 0.35 + relation * 0.25;
            const score = Math.round(Math.max(50, Math.min(95, raw)));

            const oldScore = this.moodScore;
            this.moodScore = score;
            this.stableMood = score;

            logToTerminal('info', `✨ AI日志评估完成: ${oldScore} → ${score}分 (基调${tone} 结尾${ending} 关系${relation}) 原因: ${parsed.reason || '无'}`);
            this.scheduleNextChat();
        } catch (err) {
            logToTerminal('warn', `⚠️ 解析评估结果失败: ${err.message}，原始内容: ${result.substring(0, 200)}`);
            this._applyInitFallback('评估结果解析失败');
        }
    }

    // 初始评估失败时的回退：保持当前心情值并明确告知
    _applyInitFallback(reason) {
        logToTerminal('warn', `⚠️ 初始心情评估失败（${reason}），当前心情 ${this.moodScore} 分将作为起始值使用`);
    }

    // 查找最近的 AI 日志文件
    _findRecentAILog() {
        try {
            if (!fs.existsSync(this.aiLogFolder)) return null;

            const suffix = this.aiLogFilenameTemplate.replace('{date}', '');

            // 先尝试精确匹配昨天的日志
            const yesterday = this._getYesterdayDate();
            const exactFile = this.aiLogFilenameTemplate.replace('{date}', yesterday);
            const exactPath = path.join(this.aiLogFolder, exactFile);
            if (fs.existsSync(exactPath)) {
                const content = fs.readFileSync(exactPath, 'utf8').trim();
                if (content) {
                    logToTerminal('info', `📄 找到昨日日志: ${exactFile}`);
                    return content;
                }
            }

            // 扫描目录找最近的日志
            const files = fs.readdirSync(this.aiLogFolder)
                .filter(f => f.endsWith(suffix) || f.includes('AI日志'))
                .sort()
                .reverse();

            for (const f of files) {
                const filePath = path.join(this.aiLogFolder, f);
                const content = fs.readFileSync(filePath, 'utf8').trim();
                if (content) {
                    logToTerminal('info', `📄 找到最近日志: ${f}`);
                    return content;
                }
            }

            return null;
        } catch (err) {
            logToTerminal('warn', `⚠️ 搜索 AI 日志失败: ${err.message}`);
            return null;
        }
    }

    // 计算"昨天"的日期字符串（凌晨 nightHourStart 前算更前一天）
    _getYesterdayDate() {
        const now = new Date();
        now.setDate(now.getDate() - 1);
        if (new Date().getHours() < this.nightHourStart) {
            now.setDate(now.getDate() - 1);
        }
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    // ===== Task 3b: 实时对话情感评估 =====

    async evaluateConversationSentiment(userMsg, aiMsg) {
        if (this._sentimentEvaluating) {
            logToTerminal('info', '⏸️ 上次情感评估进行中，跳过本次');
            return;
        }

        if (!userMsg || !aiMsg) return;

        this._sentimentEvaluating = true;

        try {
            const promptTemplate = this.sentimentEvaluationPrompt;
            if (!promptTemplate) return;

            const filledPrompt = promptTemplate
                .replace(/\{userMsg\}/g, userMsg)
                .replace(/\{aiMsg\}/g, aiMsg);

            const result = await this._callEvaluationAPI(
                '你是一个对话情感分析器。',
                filledPrompt,
                0.3
            );

            if (!result) {
                this._applyFallbackMood();
                return;
            }

            const jsonStr = result.match(/\{[\s\S]*\}/)?.[0];
            if (!jsonStr) {
                logToTerminal('warn', `⚠️ 情感评估未返回 JSON: ${result.substring(0, 100)}`);
                this._applyFallbackMood();
                return;
            }

            const parsed = JSON.parse(jsonStr);
            const delta = Math.max(-20, Math.min(20, Number(parsed.delta) || 0));
            const finalDelta = Math.round(delta * this._lastSpeedBonus);

            if (finalDelta !== 0) {
                this.adjustMood(finalDelta);
                logToTerminal('info', `💭 情感评估: delta=${delta} × 速度系数${this._lastSpeedBonus} = ${finalDelta} | ${parsed.reason || ''}`);
            }
        } catch (err) {
            logToTerminal('warn', `⚠️ 情感评估失败: ${err.message}`);
            this._applyFallbackMood();
        } finally {
            this._sentimentEvaluating = false;
        }
    }

    _applyFallbackMood() {
        const fallback = Math.round(this.moodChanges.userResponse * this._lastSpeedBonus);
        if (fallback !== 0) {
            this.adjustMood(fallback);
            logToTerminal('info', `💭 情感评估回退: 使用后备值 +${fallback}`);
        }
    }

    // ===== Task 4: 回复速度感知 =====

    _calculateSpeedBonus() {
        const responseTime = Date.now() - this.ttsEndTime;
        if (responseTime < 3000)  return 1.5;
        if (responseTime < 6000)  return 1.0;
        if (responseTime < 9000)  return 0.7;
        return 0.5;
    }

    // ===== 对话调度（保持原有逻辑） =====

    getChatInterval() {
        if (this.moodScore >= this.thresholds.excited) return this.intervals.excited;
        if (this.moodScore >= this.thresholds.normal)  return this.intervals.normal;
        if (this.moodScore >= this.thresholds.low)     return this.intervals.low;
        return this.intervals.silent === -1 ? Infinity : this.intervals.silent;
    }

    scheduleNextChat() {
        if (this.chatTimer) clearTimeout(this.chatTimer);

        const interval = this.getChatInterval();

        if (interval === Infinity) {
            logToTerminal('info', `😔 心情太低(${this.moodScore}分)，暂停主动对话`);
            this.chatTimer = setTimeout(() => this.scheduleNextChat(), 3600000);
            return;
        }

        const nextTime = new Date(Date.now() + interval).toLocaleTimeString();
        logToTerminal('info', `⏰ 下次主动对话: ${nextTime} (心情${this.moodScore}分, ${interval / 1000}秒后)`);

        this.chatTimer = setTimeout(() => this.executeChat(), interval);
    }

    async executeChat() {
        if (this.isProcessing) {
            logToTerminal('info', '⏸️ 正在处理中，跳过本次主动对话');
            this.scheduleNextChat();
            return;
        }

        if (appState.isPlayingTTS() || appState.isProcessingBarrage() || appState.isProcessingUserInput()) {
            logToTerminal('info', '⏸️ 系统繁忙，延迟主动对话');
            setTimeout(() => this.executeChat(), 5000);
            return;
        }

        this.isProcessing = true;
        this.lastChatTime = Date.now();

        try {
            logToTerminal('info', `💬 执行主动对话 (心情${this.moodScore}分)`);

            const voiceChat = global.voiceChat;
            if (!voiceChat) {
                logToTerminal('error', 'voiceChat不可用');
                return;
            }

            await voiceChat.sendToLLM(this.prompt);

            const ttsEndHandler = () => {
                this.waitingForResponse = true;
                this.ttsEndTime = Date.now();
                this.startResponseTimer();
                logToTerminal('info', '🎤 TTS播放完成，开始等待用户回应');
            };

            eventBus.once(Events.TTS_END, ttsEndHandler);
            eventBus.once(Events.TTS_INTERRUPTED, ttsEndHandler);

            setTimeout(() => {
                if (!this.waitingForResponse) {
                    eventBus.off(Events.TTS_END, ttsEndHandler);
                    eventBus.off(Events.TTS_INTERRUPTED, ttsEndHandler);
                    ttsEndHandler();
                }
            }, 5000);

        } catch (error) {
            logToTerminal('error', `❌ 主动对话执行失败: ${error.message}`);
        } finally {
            this.isProcessing = false;
            this.scheduleNextChat();
        }
    }

    // ===== 用户回应 =====

    startResponseTimer() {
        if (this.responseTimer) clearTimeout(this.responseTimer);

        this.responseTimer = setTimeout(() => {
            if (this.waitingForResponse) {
                logToTerminal('info', `😞 用户${this.responseTimeout / 1000}秒内没有回应，心情下降`);
                this.decreaseMood();
                this.waitingForResponse = false;
            }
        }, this.responseTimeout);
    }

    onUserResponse() {
        if (!this.waitingForResponse) return;

        // 计算速度系数并保存（供异步情感评估使用）
        this._lastSpeedBonus = this._calculateSpeedBonus();
        const responseTime = Date.now() - this.ttsEndTime;
        logToTerminal('info', `😊 用户回应 (${Math.round(responseTime / 1000)}秒, 速度系数${this._lastSpeedBonus})`);

        if (this.responseTimer) {
            clearTimeout(this.responseTimer);
            this.responseTimer = null;
        }

        this.waitingForResponse = false;

        // 不在此处直接加分——等待 evaluateConversationSentiment 的异步结果
        // 如果情感评估正在进行中或被跳过，_applyFallbackMood 会兜底
    }

    // ===== 心情调整 =====

    adjustMood(delta) {
        const oldScore = this.moodScore;
        const oldInterval = this.getChatInterval();
        this.moodScore = Math.max(0, Math.min(100, this.moodScore + delta));

        const direction = delta > 0 ? '📈' : '📉';
        logToTerminal('info', `${direction} 心情变化: ${oldScore} → ${this.moodScore} (${delta > 0 ? '+' : ''}${delta})`);

        if (this.getChatInterval() !== oldInterval) {
            this.scheduleNextChat();
        }
    }

    decreaseMood() {
        const decrease = Math.abs(this.moodChanges.noResponse);
        this.adjustMood(-decrease);
    }

    increaseMood(amount) {
        const increase = amount || this.moodChanges.userResponse;
        this.adjustMood(increase);
    }

    // ===== 心情回归 =====

    startMoodRegression() {
        this.regressionTimer = setInterval(() => {
            const oldScore = this.moodScore;

            if (this.moodScore < this.stableMood) {
                this.moodScore = Math.min(this.stableMood, this.moodScore + 1);
            } else if (this.moodScore > this.stableMood) {
                this.moodScore = Math.max(this.stableMood, this.moodScore - 1);
            }

            if (this.moodScore !== oldScore) {
                logToTerminal('info', `🔄 心情回归: ${oldScore} → ${this.moodScore} (目标${this.stableMood})`);
            }
        }, this.moodChanges.regressionInterval);
    }

    // ===== 状态查询 =====

    getMoodStatus() {
        return {
            score: this.moodScore,
            stable: this.stableMood,
            interval: this.getChatInterval(),
            waitingResponse: this.waitingForResponse
        };
    }

    // ===== 心情持久化 =====

    saveMoodToFile() {
        try {
            const moodData = {
                score: this.moodScore,
                stable: this.stableMood,
                interval: this.getChatInterval(),
                waitingResponse: this.waitingForResponse,
                timestamp: Date.now()
            };
            fs.writeFileSync(this._moodFilePath, JSON.stringify(moodData, null, 2), 'utf8');
        } catch (_) { /* 静默失败 */ }
    }

    startMoodFileSync() {
        this.saveMoodToFile();
        this.moodFileSyncTimer = setInterval(() => this.saveMoodToFile(), 2000);
    }

    stopMoodFileSync() {
        if (this.moodFileSyncTimer) {
            clearInterval(this.moodFileSyncTimer);
            this.moodFileSyncTimer = null;
        }
    }
}

module.exports = { MoodChatModule };
