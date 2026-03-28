const { ipcRenderer } = require('electron');
const { logToTerminal } = require('../../../js/api-utils.js');

let detectGameFromProcesses = null;
let getForegroundWindowProcess = null;

try {
    ({ detectGameFromProcesses, getForegroundWindowProcess } = require('../../community/loki-shadow/window-detector.js'));
} catch (e) {}

const VALID_SCENE_TYPES = ['coding', 'gaming', 'video', 'office', 'reading', 'browsing', 'chat', 'music', 'design', 'idle'];
const CODING_WINDOW_KEYWORDS = ['visual studio code', 'vscode', 'cursor', 'trae', 'windsurf', 'webstorm', 'intellij', 'idea', 'pycharm', 'clion', 'goland', 'rider', 'visual studio', 'devenv', 'android studio', 'xcode', 'zed', 'sublime text', 'notepad++'];
const CODING_PROCESS_KEYWORDS = ['code', 'cursor', 'trae', 'windsurf', 'webstorm64', 'idea64', 'pycharm64', 'clion64', 'goland64', 'rider64', 'devenv', 'studio64', 'zed'];

class SceneDetector {
    constructor(config) {
        const vm = config.scene_vision_model || {};
        this._apiUrl = (vm.api_url || '').trim();
        this._apiKey = (vm.api_key || '').trim();
        this._model  = (vm.model || '').trim();
        this._enabled = SceneDetector._toBool(config.scene_detection_enabled, true);
        this._checkInterval = config.scene_check_interval || 30000;
        this._windowCrossCheckEnabled = SceneDetector._toBool(config.scene_window_cross_check_enabled, true);

        this._lastScreenHash = '';
        this._currentScene = { type: 'unknown', label: '未知', since: Date.now() };
        this._sceneHistory = [];
        this._historyMax = 10;
        this._changeCallbacks = [];
        this._timer = null;
        this._running = false;
    }

    // ===== 公开接口 =====

    getCurrentScene() {
        return { ...this._currentScene };
    }

    getSceneHistory() {
        return this._sceneHistory.slice();
    }

    onSceneChange(fn) {
        if (typeof fn === 'function') {
            this._changeCallbacks.push(fn);
        }
    }

    offSceneChange(fn) {
        const idx = this._changeCallbacks.indexOf(fn);
        if (idx !== -1) {
            this._changeCallbacks.splice(idx, 1);
        }
    }

    start() {
        if (this._running) return;
        if (!this._enabled || !this._apiUrl || !this._apiKey || !this._model) {
            logToTerminal('info', '场景检测未启用或未配置视觉模型，跳过');
            return;
        }
        this._running = true;
        logToTerminal('info', `场景检测已启动 | 间隔: ${this._checkInterval}ms | 模型: ${this._model}`);
        this._schedulePoll(0);
    }

    stop() {
        this._running = false;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        logToTerminal('info', '场景检测已停止');
    }

    _schedulePoll(delay) {
        if (this._timer) clearTimeout(this._timer);
        this._timer = setTimeout(async () => {
            await this._poll();
            if (this._running) {
                this._schedulePoll(this._checkInterval);
            }
        }, delay);
    }

    // ===== 内部逻辑 =====

    async _poll() {
        try {
            const screenshot = await this._takeScreenshot();
            if (!screenshot) return;

            const hash = this._computeScreenHash(screenshot);
            if (hash === this._lastScreenHash) return;
            this._lastScreenHash = hash;

            const classifiedScene = await this._classifyScene(screenshot);
            const scene = await this._crossCheckScene(classifiedScene);
            if (scene.type === this._currentScene.type) {
                return;
            }

            const now = Date.now();
            const oldScene = {
                type: this._currentScene.type,
                label: this._currentScene.label,
                startTime: this._currentScene.since,
                endTime: now
            };
            const newScene = { type: scene.type, label: scene.label, since: now };

            this._sceneHistory.push(oldScene);
            if (this._sceneHistory.length > this._historyMax) {
                this._sceneHistory.shift();
            }

            this._currentScene = newScene;
            logToTerminal('info', `场景切换: ${oldScene.label} → ${newScene.label}`);

            for (const cb of this._changeCallbacks) {
                try { cb(oldScene, newScene); } catch (e) {
                    logToTerminal('warn', `场景变化回调异常: ${e.message}`);
                }
            }
        } catch (e) {
            logToTerminal('warn', `场景检测轮询异常: ${e.message}`);
        }
    }

    async _takeScreenshot() {
        try {
            return await ipcRenderer.invoke('take-screenshot');
        } catch (e) {
            logToTerminal('warn', `截图失败: ${e.message}`);
            return '';
        }
    }

    _computeScreenHash(base64) {
        if (!base64) return '';
        return `${base64.length}:${base64.slice(0, 200)}:${base64.slice(-200)}`;
    }

    async _crossCheckScene(scene) {
        if (scene.type !== 'gaming' || !this._windowCrossCheckEnabled || typeof detectGameFromProcesses !== 'function' || typeof getForegroundWindowProcess !== 'function') {
            return scene;
        }

        try {
            const foregroundWindow = await getForegroundWindowProcess();
            if (!foregroundWindow) {
                return scene;
            }

            const gameDetection = detectGameFromProcesses([foregroundWindow]);
            if (gameDetection.detected) {
                return scene;
            }

            if (SceneDetector._isCodingWindow(foregroundWindow)) {
                logToTerminal('info', `窗口核对: 前台窗口「${foregroundWindow.windowTitle || foregroundWindow.processName}」更像编程，已阻止误切换到游戏`);
                return { type: 'coding', label: '编程' };
            }

            if (this._currentScene.type && !['unknown', 'idle'].includes(this._currentScene.type)) {
                logToTerminal('info', `窗口核对: 前台窗口「${foregroundWindow.windowTitle || foregroundWindow.processName}」未识别为游戏，保留当前场景${this._currentScene.label}`);
                return { type: this._currentScene.type, label: this._currentScene.label };
            }
        } catch (e) {
            logToTerminal('warn', `窗口核对失败: ${e.message}`);
        }

        return scene;
    }

    async _classifyScene(screenshotBase64) {
        try {
            const response = await fetch(this._apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this._apiKey}`
                },
                body: JSON.stringify({
                    model: this._model,
                    messages: [{
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: '根据这张屏幕截图，判断用户当前的活动场景。只返回JSON。\n'
                                    + '格式：{"type":"场景类型","label":"中文标签"}\n'
                                    + '场景类型限定：coding, gaming, video, office, reading, browsing, chat, music, design, idle\n'
                                    + '重要判定规则：\n'
                                    + '- 游戏内的一切画面都算 gaming，包括：过场动画/CG、剧情对话、菜单界面、'
                                    + '地图、背包、加载画面、游戏内视频播放、游戏内文字阅读等\n'
                                    + '- 只有在独立的视频播放器或视频网站（如B站、YouTube）里看视频才算 video\n'
                                    + '- 只有在独立的阅读应用或文档中阅读才算 reading'
                            },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:image/jpeg;base64,${screenshotBase64}`,
                                    detail: 'low'
                                }
                            }
                        ]
                    }],
                    max_tokens: 60,
                    temperature: 0.1
                })
            });

            if (!response.ok) {
                logToTerminal('warn', `场景分类 API 返回 ${response.status}`);
                return { type: 'unknown', label: '未知' };
            }

            const data = await response.json();
            const text = data.choices?.[0]?.message?.content || '';
            const match = text.match(/\{[\s\S]*\}/);
            if (match) {
                const json = JSON.parse(match[0]);
                if (json.type && VALID_SCENE_TYPES.includes(json.type)) {
                    return { type: json.type, label: json.label || json.type };
                }
                if (json.type) {
                    logToTerminal('warn', `场景分类返回未知类型「${json.type}」，已回退为 unknown`);
                }
            }
        } catch (e) {
            logToTerminal('warn', `场景分类失败: ${e.message}`);
        }
        return { type: 'unknown', label: '未知' };
    }
}

SceneDetector._toBool = function(val, defaultVal = true) {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') return val.toLowerCase() !== 'false';
    return defaultVal;
};

SceneDetector._isCodingWindow = function(windowInfo) {
    const processName = String(windowInfo?.processName || '').toLowerCase();
    const windowTitle = String(windowInfo?.windowTitle || '').toLowerCase();
    return CODING_PROCESS_KEYWORDS.some(keyword => processName.includes(keyword))
        || CODING_WINDOW_KEYWORDS.some(keyword => windowTitle.includes(keyword));
};

module.exports = { SceneDetector };
