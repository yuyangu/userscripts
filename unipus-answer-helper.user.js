// ==UserScript==
// @name         U校园 答题助手
// @namespace    xiaobu.userscripts
// @version      1.2.0
// @description  U校园(unipus.cn)在线测试/作业页：一键提取全部题目并复制（可发给AI求解），粘贴答案后按随机节奏逐题填写、模仿真人答题（滚动定位+真实坐标点击）；填写延迟默认10~20秒可在面板调节
// @author       小布
// @match        https://*.unipus.cn/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/yuyangu/userscripts/main/unipus-answer-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/yuyangu/userscripts/main/unipus-answer-helper.user.js
// ==/UserScript==

(function () {
    'use strict';

    const log = (...a) => console.log('%c[U校园助手]', 'color:#4f8ef7;font-weight:bold', ...a);

    // ===================== 设置（持久化） =====================
    const DEFAULTS = {
        FILL_DELAY_MIN: 10,  // 填写间隔下限（秒）
        FILL_DELAY_MAX: 20,  // 填写间隔上限（秒）—— 0~0 表示立即全部填入
    };
    const STORAGE_KEY = 'unipus_helper_settings_v2';
    const settings = Object.assign({}, DEFAULTS);
    try { Object.assign(settings, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')); } catch (e) {}
    function saveSettings() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
    }

    // ===================== 工具 =====================
    function isVisible(el) {
        if (!el) return false;
        let node = el;
        while (node && node !== document.body) {
            if (node.classList && node.classList.contains('hide')) return false;
            const st = getComputedStyle(node);
            if (st.display === 'none' || st.visibility === 'hidden') return false;
            node = node.parentElement;
        }
        return true;
    }

    function clampInt(v, lo, hi) {
        v = parseInt(v, 10);
        if (isNaN(v)) return lo;
        return Math.min(hi, Math.max(lo, v));
    }

    // 按设置的区间返回随机毫秒；上限 <=0 视为关闭（返回 0）
    function randFillDelay() {
        let mn = Number(settings.FILL_DELAY_MIN);
        let mx = Number(settings.FILL_DELAY_MAX);
        if (isNaN(mn) || mn < 0) mn = 0;
        if (isNaN(mx) || mx <= 0) return 0;
        if (mx < mn) mx = mn;
        return (mn + Math.random() * (mx - mn)) * 1000;
    }

    // ===================== 题目提取 =====================
    function extractQuestions() {
        const blocks = document.querySelectorAll('.question-basic');
        const list = [];
        blocks.forEach(block => {
            const stemEl = block.querySelector('.ques-title p') || block.querySelector('.ques-title');
            const stem = stemEl ? stemEl.innerText.replace(/\s+/g, ' ').trim() : '';
            if (!stem) return;
            const opts = [];
            block.querySelectorAll('.option-wrap .option').forEach(op => {
                const cap = op.querySelector('.caption');
                const content = op.querySelector('.content');
                opts.push({
                    letter: (cap ? cap.innerText : '').trim().toUpperCase(),
                    text: (content ? content.innerText : '').replace(/\s+/g, ' ').trim(),
                    el: op,
                });
            });
            list.push({ no: list.length + 1, stem, opts });
        });
        return list;
    }

    function formatQuestions(list) {
        const lines = [];
        list.forEach(q => {
            lines.push(q.no + '. ' + q.stem);
            q.opts.forEach(o => lines.push('   ' + o.letter + '. ' + o.text));
            lines.push('');
        });
        return lines.join('\n').trim();
    }

    // ===================== 答案解析 =====================
    // 支持格式：1B 2B 3A ／ 1.B 2.A ／ 1、B 2、A ／ 1-B ...
    function parseAnswers(text) {
        const pairs = [];
        const re = /(\d+)\s*[.\-:、,，]?\s*([A-Za-z])/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            pairs.push({ num: parseInt(m[1], 10), letter: m[2].toUpperCase() });
        }
        return pairs;
    }

    // 模拟真人点击：滚动到可视区 → 元素内随机取点 → 完整指针事件序列（更真实的鼠标行为）
    function fireClick(el) {
        try {
            if (el.scrollIntoView) {
                try { el.scrollIntoView({ block: 'center', behavior: 'auto' }); }
                catch (e) { el.scrollIntoView(); }
            }
            const r = el.getBoundingClientRect();
            const x = Math.round(r.left + r.width * (0.3 + Math.random() * 0.4));
            const y = Math.round(r.top + r.height * (0.3 + Math.random() * 0.4));
            const base = {
                bubbles: true, cancelable: true, view: window,
                clientX: x, clientY: y, screenX: x, screenY: y,
            };
            const seq = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
            seq.forEach(type => {
                let ev;
                if (type.indexOf('pointer') === 0 && typeof window.PointerEvent === 'function') {
                    ev = new PointerEvent(type, Object.assign({
                        pointerId: 1, pointerType: 'mouse', isPrimary: true,
                    }, base));
                } else {
                    ev = new MouseEvent(type, base);
                }
                el.dispatchEvent(ev);
            });
        } catch (e) {
            try { el.click(); } catch (e2) {}
        }
    }

    // ===================== 随机节奏填写状态机 =====================
    let fillQueue = [];      // 待填写队列 [{num, letter, el}]
    let fillTimer = null;    // 延迟定时器
    let fillDone = 0;        // 已完成数
    let fillTotal = 0;       // 总题数
    let fillMiss = [];       // 未匹配的答案项

    function isFilling() {
        return fillTimer !== null || fillQueue.length > 0;
    }

    function stopFilling(msg) {
        if (fillTimer) { clearTimeout(fillTimer); fillTimer = null; }
        fillQueue = [];
        updateFillButton();
        if (msg && elResult) elResult.textContent = msg;
    }

    function stepFill() {
        fillTimer = null;
        if (!fillQueue.length) {
            let msg = '填写完成：共 ' + fillDone + ' 题（请核对页面选择后手动提交）';
            if (fillMiss.length) msg += '；未匹配：' + fillMiss.join('、');
            stopFilling(msg);
            updateFillButton();
            return;
        }
        const job = fillQueue.shift();
        fireClick(job.el);
        fillDone++;
        if (elResult) {
            elResult.textContent = '正在按真人节奏填写… 已完成 ' + fillDone + '/' + fillTotal +
                ' 题（第 ' + job.num + ' 题 → ' + job.letter + '）';
        }
        // 下一题：随机延迟
        const delay = randFillDelay();
        fillTimer = setTimeout(stepFill, delay);
    }

    function startFilling(text) {
        const pairs = parseAnswers(text);
        if (!pairs.length) {
            if (elResult) elResult.textContent = '未解析到答案，请按「题号+选项字母」格式输入，如：1B 2A 3C';
            return;
        }
        const list = extractQuestions();
        const jobs = [];
        fillMiss = [];
        pairs.forEach(p => {
            const q = list[p.num - 1];
            if (!q) { fillMiss.push(p.num + p.letter); return; }
            const opt = q.opts.find(o => o.letter === p.letter);
            if (opt) jobs.push({ num: p.num, letter: p.letter, el: opt.el });
            else fillMiss.push(p.num + p.letter);
        });
        if (!jobs.length) {
            if (elResult) elResult.textContent = '没有可填写的题目（检查题号与选项字母是否匹配）';
            return;
        }
        jobs.sort((a, b) => a.num - b.num);   // 按题号顺序（真人习惯）
        fillQueue = jobs;
        fillTotal = jobs.length;
        fillDone = 0;
        updateFillButton();
        log('开始填写', fillTotal, '题，间隔', settings.FILL_DELAY_MIN, '~', settings.FILL_DELAY_MAX, '秒');
        stepFill();   // 第一题立即开始，后续按随机延迟
    }

    // ===================== 右下角面板 =====================
    let elPanel = null, elPill = null, elStatus = null, elPreview = null, elAnswer = null, elResult = null, elFillBtn = null;
    let panelVisible = false;

    function injectStyle() {
        if (document.getElementById('unipus-helper-style')) return;
        const css = `
#up-pill, #up-panel, #up-panel * {
    box-sizing: border-box;
    font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
}
#up-pill {
    position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;
    display: flex; align-items: center; gap: 7px;
    background: rgba(22,24,26,0.92); color: #e8eaed;
    font-size: 12px; padding: 8px 13px; border-radius: 999px;
    border: 1px solid rgba(255,255,255,0.14);
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    cursor: pointer; user-select: none;
}
#up-pill:hover { background: rgba(42,46,50,0.95); }
#up-pill .up-dot { width: 7px; height: 7px; border-radius: 50%; background: #4f8ef7; flex: 0 0 auto; }
#up-pill.filling .up-dot { background: #f0b429; }
#up-panel {
    position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;
    width: 300px;
    background: rgba(22,24,26,0.96); color: #e8eaed; font-size: 12px;
    border-radius: 12px; border: 1px solid rgba(255,255,255,0.14);
    box-shadow: 0 8px 28px rgba(0,0,0,0.5);
    padding: 10px 12px 11px;
}
#up-panel .up-head { display: flex; justify-content: space-between; align-items: center; }
#up-panel .up-title { font-weight: 600; font-size: 12.5px; color: #f1f3f4; }
#up-panel .up-min { cursor: pointer; color: #9aa0a6; padding: 0 5px; font-weight: 700; line-height: 1; }
#up-panel .up-min:hover { color: #ffffff; }
#up-panel .up-status {
    margin: 7px 0 8px; padding: 5px 8px; border-radius: 6px;
    background: rgba(255,255,255,0.07); color: #cfd3d6;
    font-size: 11px; line-height: 1.5; min-height: 17px;
}
#up-panel button.up-btn {
    width: 100%; padding: 7px 0; margin-top: 4px;
    background: rgba(79,142,247,0.16); color: #9cc0ff;
    border: 1px solid rgba(79,142,247,0.42); border-radius: 8px;
    cursor: pointer; font-size: 12px; font-family: inherit;
}
#up-panel button.up-btn:hover { background: rgba(79,142,247,0.3); color: #c3d8ff; }
#up-panel button.up-btn.up-green {
    background: rgba(46,204,113,0.16); color: #7ee2a8;
    border-color: rgba(46,204,113,0.4);
}
#up-panel button.up-btn.up-green:hover { background: rgba(46,204,113,0.3); color: #a5f0c4; }
#up-panel button.up-btn.up-stop {
    background: rgba(224,82,82,0.16); color: #f0a0a0;
    border-color: rgba(224,82,82,0.45);
}
#up-panel button.up-btn.up-stop:hover { background: rgba(224,82,82,0.3); color: #ffc0c0; }
#up-panel textarea {
    width: 100%; margin-top: 6px; resize: vertical;
    background: rgba(255,255,255,0.08); color: #e8eaed;
    border: 1px solid rgba(255,255,255,0.2); border-radius: 7px;
    padding: 6px 8px; font-size: 11px; line-height: 1.5; outline: none;
    font-family: "Consolas", "Microsoft YaHei", monospace;
}
#up-panel textarea:focus { border-color: rgba(79,142,247,0.6); }
#up-panel .up-preview { height: 96px; overflow-y: auto; }
#up-panel .up-answer { height: 52px; }
#up-panel .up-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0 0; color: #d6d9dc; }
#up-panel .up-range { display: flex; align-items: center; gap: 3px; color: #cfd3d6; font-size: 11px; }
#up-panel .up-num {
    width: 36px; text-align: center;
    background: rgba(255,255,255,0.1); color: #e8eaed;
    border: 1px solid rgba(255,255,255,0.22); border-radius: 6px;
    padding: 2px 2px; font-size: 11px; outline: none;
    -moz-appearance: textfield; appearance: textfield;
}
#up-panel .up-num::-webkit-outer-spin-button,
#up-panel .up-num::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
#up-panel .up-num:focus { border-color: rgba(79,142,247,0.65); }
#up-panel .up-result { margin-top: 6px; font-size: 11px; color: #cfd3d6; min-height: 15px; word-break: break-all; }
#up-panel .up-foot { margin-top: 6px; font-size: 10.5px; color: #8a8f98; text-align: center; }
        `;
        const style = document.createElement('style');
        style.id = 'unipus-helper-style';
        style.textContent = css;
        document.head.appendChild(style);
    }

    function setPanelOpen(open) {
        panelVisible = open;
        if (elPanel) elPanel.style.display = open ? 'block' : 'none';
        if (elPill) elPill.style.display = open ? 'none' : 'flex';
    }

    function refreshStatus() {
        if (!elStatus || isFilling()) return;
        const n = extractQuestions().length;
        elStatus.textContent = n
            ? '检测到 ' + n + ' 道题'
            : '暂未检测到题目（打开测试答题页后自动识别）';
    }

    function updateFillButton() {
        if (!elFillBtn) return;
        if (isFilling()) {
            elFillBtn.textContent = '停止填写（已完成 ' + fillDone + '/' + fillTotal + '）';
            elFillBtn.className = 'up-btn up-stop';
        } else {
            elFillBtn.textContent = '填入答案（随机节奏，模仿真人）';
            elFillBtn.className = 'up-btn up-green';
        }
        if (elPill) elPill.classList.toggle('filling', isFilling());
    }

    // 延迟区间输入组
    function makeDelayInputs() {
        const wrap = document.createElement('span');
        wrap.className = 'up-range';

        const inpMin = document.createElement('input');
        const inpMax = document.createElement('input');
        [inpMin, inpMax].forEach(i => {
            i.type = 'number';
            i.min = '0';
            i.max = '600';
            i.step = '1';
            i.className = 'up-num';
        });
        inpMin.value = settings.FILL_DELAY_MIN;
        inpMax.value = settings.FILL_DELAY_MAX;
        inpMin.title = '每题间隔下限（秒）';
        inpMax.title = '每题间隔上限（秒）；0~0 表示立即全部填入';

        const sep = document.createElement('span');
        sep.textContent = '~';
        const unit = document.createElement('span');
        unit.textContent = '秒/题';

        inpMin.addEventListener('change', () => {
            const v = clampInt(inpMin.value, 0, 600);
            settings.FILL_DELAY_MIN = v;
            inpMin.value = v;
            if (v > (Number(settings.FILL_DELAY_MAX) || 0)) {
                settings.FILL_DELAY_MAX = v;
                inpMax.value = v;
            }
            saveSettings();
        });
        inpMax.addEventListener('change', () => {
            const v = clampInt(inpMax.value, 0, 600);
            settings.FILL_DELAY_MAX = v;
            inpMax.value = v;
            if (v < (Number(settings.FILL_DELAY_MIN) || 0)) {
                settings.FILL_DELAY_MIN = v;
                inpMin.value = v;
            }
            saveSettings();
        });

        wrap.appendChild(inpMin);
        wrap.appendChild(sep);
        wrap.appendChild(inpMax);
        wrap.appendChild(unit);
        return wrap;
    }

    function buildUI() {
        injectStyle();

        // 折叠胶囊
        elPill = document.createElement('div');
        elPill.id = 'up-pill';
        const dot = document.createElement('span');
        dot.className = 'up-dot';
        const pillText = document.createElement('span');
        pillText.textContent = '答题助手';
        elPill.appendChild(dot);
        elPill.appendChild(pillText);
        elPill.title = '点击打开答题助手';
        elPill.addEventListener('click', () => setPanelOpen(true));
        document.body.appendChild(elPill);

        // 展开面板
        elPanel = document.createElement('div');
        elPanel.id = 'up-panel';

        const head = document.createElement('div');
        head.className = 'up-head';
        const title = document.createElement('span');
        title.className = 'up-title';
        title.textContent = 'U校园答题助手';
        const min = document.createElement('span');
        min.className = 'up-min';
        min.textContent = '—';
        min.title = '收起面板（点页面其他区域也会收起）';
        min.addEventListener('click', () => setPanelOpen(false));
        head.appendChild(title);
        head.appendChild(min);

        elStatus = document.createElement('div');
        elStatus.className = 'up-status';
        elStatus.textContent = '初始化中…';

        // 提取按钮
        const btnExtract = document.createElement('button');
        btnExtract.className = 'up-btn';
        btnExtract.textContent = '提取题目并复制';
        btnExtract.addEventListener('click', () => {
            const list = extractQuestions();
            if (!list.length) {
                elStatus.textContent = '未检测到题目，请确认已打开测试答题页';
                return;
            }
            const text = formatQuestions(list);
            elPreview.value = text;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(
                    () => { elStatus.textContent = '已提取 ' + list.length + ' 道题，并复制到剪贴板（可直接发给 AI 求解）'; },
                    () => { elStatus.textContent = '已提取 ' + list.length + ' 道题（复制失败，请手动从下方文本框复制）'; }
                );
            } else {
                elStatus.textContent = '已提取 ' + list.length + ' 道题（请手动从下方文本框复制）';
            }
        });

        // 题目预览
        elPreview = document.createElement('textarea');
        elPreview.className = 'up-preview';
        elPreview.readOnly = true;
        elPreview.placeholder = '点击上方按钮后，题目文本会显示在这里（可手动复制）';

        // 答案输入
        elAnswer = document.createElement('textarea');
        elAnswer.className = 'up-answer';
        elAnswer.placeholder = '粘贴答案，如：1B 2B 3A 4A 5C 6C 7A 8B 9C 10B';

        // 填写延迟配置
        const delayRow = document.createElement('div');
        delayRow.className = 'up-row';
        const delayLabel = document.createElement('span');
        delayLabel.textContent = '填写间隔';
        delayLabel.title = '每题之间的随机等待时间，模仿真人答题节奏；0~0 表示立即全部填入';
        delayRow.appendChild(delayLabel);
        delayRow.appendChild(makeDelayInputs());

        // 填入按钮
        elFillBtn = document.createElement('button');
        elFillBtn.className = 'up-btn up-green';
        elFillBtn.textContent = '填入答案（随机节奏，模仿真人）';
        elFillBtn.addEventListener('click', () => {
            if (isFilling()) {
                stopFilling('已停止填写（已完成 ' + fillDone + '/' + fillTotal + ' 题，已选的保留）');
                return;
            }
            startFilling(elAnswer.value || '');
        });

        elResult = document.createElement('div');
        elResult.className = 'up-result';

        const foot = document.createElement('div');
        foot.className = 'up-foot';
        foot.textContent = '提取 → 发给 AI 求解 → 粘贴答案 → 随机节奏填写';

        elPanel.appendChild(head);
        elPanel.appendChild(elStatus);
        elPanel.appendChild(btnExtract);
        elPanel.appendChild(elPreview);
        elPanel.appendChild(elAnswer);
        elPanel.appendChild(delayRow);
        elPanel.appendChild(elFillBtn);
        elPanel.appendChild(elResult);
        elPanel.appendChild(foot);
        document.body.appendChild(elPanel);

        // 点击页面其他区域自动收起
        document.addEventListener('click', (e) => {
            if (!panelVisible) return;
            if (elPanel && elPanel.contains(e.target)) return;
            if (elPill && elPill.contains(e.target)) return;
            setPanelOpen(false);
        }, true);

        setPanelOpen(true);
        updateFillButton();

        refreshStatus();
        setInterval(refreshStatus, 2000);
    }

    function start() {
        log('U校园答题助手已启动 v1.1');
        buildUI();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
