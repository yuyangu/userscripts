// ==UserScript==
// @name         GXNUFL 刷课助手
// @namespace    xiaobu.userscripts
// @version      3.4.0
// @description  广西师大漓江学院(elearnmooc)在线课程：视频播完自动点"下一节"；弹题自动处理（跳过/字幕匹配/答错纠错）；播放倍速可自定义（最高 16x），高倍速下接近题目点自动临时降速，确保题目正常弹出；随机延迟范围与各开关均可在右下角面板调节
// @author       小布
// @match        https://gxnufl.elearnmooc.com/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/yuyangu/userscripts/main/gxnufl-auto-next.user.js
// @downloadURL  https://raw.githubusercontent.com/yuyangu/userscripts/main/gxnufl-auto-next.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ===================== 默认设置（可在右下角面板实时修改） =====================
    const DEFAULTS = {
        AUTO_NEXT: true,        // 视频播完自动点"下一节"
        AUTO_ANSWER: true,      // 弹题自动处理（跳过/作答/纠错）
        AUTO_PLAY: true,        // 视频暂停且无弹题时自动续播（防卡死）
        USE_SUBTITLE: true,     // 单选题优先用视频字幕匹配答案
        MUTE: false,            // 静音
        SPEED: 0,               // 播放倍速：0=不干预；支持自定义输入（最高 16）
        GUARD: true,            // 弹题保护：高倍速时接近题目点自动临时降至 1x，确保题目弹出
        DELAY_ANSWER_MIN: 2,    // 答题延迟下限（秒）
        DELAY_ANSWER_MAX: 8,    // 答题延迟上限（秒）—— 0~0 表示关闭
        DELAY_NEXT_MIN: 1,      // 下一节延迟下限（秒）
        DELAY_NEXT_MAX: 3,      // 下一节延迟上限（秒）—— 0~0 表示关闭
        _panelOpen: true,       // 设置面板是否展开（记忆上次状态）
    };
    const FIXED = {
        POLL_MS: 500,           // 主循环轮询间隔
        SHORT_MIN: 500,         // 短延迟区间（提交/关闭提示）：0.5~2 秒
        SHORT_MAX: 2000,
        NEXT_FLOOR: 500,        // "下一节"最小保底延迟，防止操作竞态
    };
    // 注：倍速已改为面板自由输入（0~16，0=不干预）

    // ===================== 设置持久化（localStorage） =====================
    const STORAGE_KEY = 'gxnufl_auto_settings_v3';
    const state = Object.assign({}, DEFAULTS);
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) {}
    Object.assign(state, saved);
    // 兼容迁移：把早期版本的档位字符串（如 '2-8'）转成数值区间
    [['DELAY_ANSWER', 'DELAY_ANSWER_MIN', 'DELAY_ANSWER_MAX'],
     ['DELAY_NEXT', 'DELAY_NEXT_MIN', 'DELAY_NEXT_MAX']].forEach(([o, mn, mx]) => {
        const ov = saved[o];
        if (ov && saved[mn] === undefined && saved[mx] === undefined) {
            if (ov === 'off') { state[mn] = 0; state[mx] = 0; }
            else {
                const p = String(ov).split('-').map(Number);
                if (p.length === 2 && !isNaN(p[0]) && !isNaN(p[1])) { state[mn] = p[0]; state[mx] = p[1]; }
            }
        }
        delete state[o];
    });
    function saveState() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    }

    const log = (...a) => console.log('%c[GXNUFL刷课]', 'color:#2ecc71;font-weight:bold', ...a);
    const jq = window.jQuery || window.$;

    // ===================== 随机延迟 =====================
    // 读取区间配置（秒）返回随机毫秒；上限 <=0 视为关闭（返回 0 不等待）
    function randDelay(minKey, maxKey) {
        let mn = Number(state[minKey]);
        let mx = Number(state[maxKey]);
        if (isNaN(mn) || mn < 0) mn = 0;
        if (isNaN(mx) || mx <= 0) return 0;
        if (mx < mn) mx = mn;
        return (mn + Math.random() * (mx - mn)) * 1000;
    }
    function randAnswerDelay() { return randDelay('DELAY_ANSWER_MIN', 'DELAY_ANSWER_MAX'); }
    function randNextDelay() { return randDelay('DELAY_NEXT_MIN', 'DELAY_NEXT_MAX'); }
    // 固定短延迟（提交答案、关闭"我知道了"等微操作）
    function shortDelay() {
        return FIXED.SHORT_MIN + Math.random() * (FIXED.SHORT_MAX - FIXED.SHORT_MIN);
    }

    // ===================== 全局状态 =====================
    let pendingCorrect = null;   // 答错后待重选的正确答案
    let schedule = null;         // 当前延迟调度 { type, at }
    let lastSubmitTime = 0;      // 上次提交时间（防重复提交节流）
    let nextPendingAt = 0;       // "下一节"等待中的时间点（用于状态显示）
    let lastStatusText = '';
    let lastStatusLevel = '';

    // ===================== 工具函数 =====================
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

    function clickEl(el) {
        if (!el) return false;
        el.click();
        try { el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch (e) {}
        return true;
    }

    // iCheck 选中（关键：不能用原生 click）
    function icheck(input, action) {
        if (!input) return false;
        if (jq && jq.fn && jq.fn.iCheck) {
            jq(input).iCheck(action || 'check');
            return true;
        }
        if (action === 'uncheck') { input.checked = false; } else { input.checked = true; }
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    function fillText(el, text) {
        if (!el) return false;
        const proto = el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, text);
        else el.value = text;
        try {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
        } catch (e) {}
        if (jq) { try { jq(el).trigger('blur'); } catch (e) {} }
        return true;
    }

    function getVideo() {
        return document.querySelector('video.videoplayer');
    }

    function remainSec(at) {
        return Math.max(0, Math.ceil((at - Date.now()) / 1000));
    }

    // ===================== 字幕辅助 =====================
    function getSubtitleText() {
        const els = ['.font-con', '.control_subtitle', '.font_pop .changeFont'];
        for (const sel of els) {
            const el = document.querySelector(sel);
            const t = el ? el.innerText.trim() : '';
            if (t) return t;
        }
        return '';
    }

    function norm(s) {
        return (s || '').toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function pickBySubtitle(options, subtitle) {
        if (!subtitle) return -1;
        const sub = norm(subtitle);
        if (!sub) return -1;
        let best = -1, bestScore = 0;
        options.forEach((opt, i) => {
            const o = norm(opt);
            if (!o) return;
            let s = 0;
            if (sub.includes(o)) s += 100;
            const words = o.split(' ').filter(Boolean);
            if (words.length > 1 && sub.includes(words.join(' '))) s += 60;
            for (const w of words) {
                if (w.length >= 3 && sub.includes(w)) s += 2;
                else if (w.length >= 2 && sub.includes(w)) s += 1;
            }
            if (s > bestScore) { bestScore = s; best = i; }
        });
        return bestScore >= 100 ? best : -1;
    }

    // ===================== 自动作答 =====================
    function autoAnswer() {
        const qbox = document.querySelector('.language_question:not(.hide)');
        if (!qbox) return false;

        // 判断题：选"正确"
        const pd = qbox.querySelector('.question_panduan');
        if (pd) {
            if (pd.querySelector('input:checked')) return true;
            return icheck(pd.querySelector('input[value="true"]'));
        }

        // 单选题：字幕匹配优先，匹配不到选第一个
        const dx = qbox.querySelector('.question_danxuan');
        if (dx) {
            if (dx.querySelector('input:checked')) return true;
            const areas = Array.from(dx.querySelectorAll('.question_option_area'));
            if (!areas.length) return false;
            const radios = areas.map(a => a.querySelector('input[type="radio"]')).filter(Boolean);
            if (!radios.length) return false;
            const texts = areas.map(a => {
                const opt = a.querySelector('.question_option') || a.querySelector('.question_lable');
                return opt ? opt.innerText.trim() : '';
            });
            let idx = -1;
            if (state.USE_SUBTITLE) idx = pickBySubtitle(texts, getSubtitleText());
            if (idx < 0) idx = 0;
            log('单选题选第', idx + 1, '项');
            return icheck(radios[idx]);
        }

        // 多选题：全选
        const ddx = qbox.querySelector('.question_duoxuan');
        if (ddx) {
            if (ddx.querySelector('input:checked')) return true;
            const boxes = Array.from(ddx.querySelectorAll('input[type="checkbox"]'));
            if (!boxes.length) return false;
            boxes.forEach(b => icheck(b));
            return true;
        }

        // 填空题：逐空填写
        const tk = qbox.querySelector('.question_tiankong');
        if (tk) {
            const blanks = Array.from(tk.querySelectorAll('input.text'));
            if (!blanks.length) return false;
            blanks.forEach(el => { if (!el.value.trim()) fillText(el, '答案'); });
            return blanks.every(el => el.value.trim());
        }

        // 翻译 / 改述 / 造句：textarea 填占位
        for (const cls of ['.question_translate', '.question_changediscourse', '.question_makesentence']) {
            const box = qbox.querySelector(cls);
            if (box) {
                const ta = box.querySelector('textarea');
                if (ta) {
                    if (!ta.value.trim()) fillText(ta, '无');
                    return true;
                }
            }
        }

        // 跟读 / 听写 / 辨析等音频题：无法自动作答
        return false;
    }

    // ===================== 读正确答案 & 纠错重选 =====================
    function readCorrectAnswer(tip) {
        const val = tip.querySelector('.ans_tip_value');
        if (val && !val.classList.contains('hide') && val.innerText.trim()) {
            const text = val.innerText.trim();
            const m = text.match(/正确答案\s*[:：]\s*(.*)/);
            return m ? m[1].trim() : text;
        }
        const labels = tip.querySelectorAll('.ans_tip_value_frame .taglabel');
        if (labels.length) {
            return Array.from(labels).map(l => l.textContent.trim());
        }
        return null;
    }

    function reselect(correct) {
        const qbox = document.querySelector('.language_question:not(.hide)');
        if (!qbox || correct === null) return;

        const dx = qbox.querySelector('.question_danxuan');
        if (dx) {
            const idx = /^[A-Za-z]$/.test(correct) ? correct.toUpperCase().charCodeAt(0) - 65 : -1;
            const radios = Array.from(dx.querySelectorAll('input[type="radio"]'));
            if (idx >= 0 && idx < radios.length) icheck(radios[idx]);
            return;
        }

        const pd = qbox.querySelector('.question_panduan');
        if (pd) {
            const isTrue = /正确|true|对/i.test(String(correct));
            const target = pd.querySelector('input[value="' + (isTrue ? 'true' : 'false') + '"]');
            if (target) icheck(target);
            return;
        }

        const ddx = qbox.querySelector('.question_duoxuan');
        if (ddx) {
            const letters = String(correct).trim().split(/\s+/).map(s => s.toUpperCase());
            const boxes = Array.from(ddx.querySelectorAll('input[type="checkbox"]'));
            boxes.forEach((b, i) => {
                const letter = String.fromCharCode(65 + i);
                if (letters.includes(letter)) icheck(b, 'check');
                else icheck(b, 'uncheck');
            });
            return;
        }

        const tk = qbox.querySelector('.question_tiankong');
        if (tk && Array.isArray(correct)) {
            const inputs = Array.from(tk.querySelectorAll('input.text'));
            correct.forEach((ans, i) => { if (inputs[i]) fillText(inputs[i], ans); });
        }
    }

    // ===================== 弹题处理（带随机延迟的调度状态机） =====================
    // schedule.type 取值：'answer' 审题等待 / 'submit' 提交等待 / 'resubmit' 重答等待
    //                    'skip' 跳过等待 / 'gotknow' 关闭答对提示等待
    function handleQuestion() {
        if (!state.AUTO_ANSWER) { schedule = null; return null; }
        const qbox = document.querySelector('.language_question:not(.hide)');
        if (!qbox) { schedule = null; return null; }

        const now = Date.now();
        const tip = document.querySelector('.question_tip_frame:not(.hide)');

        // ---------- 有提示框 ----------
        if (tip) {
            const title = tip.querySelector('.ans_tip_title');
            const gotKnow = tip.querySelector('.got_know_btn');

            // 答对：随机短延迟后点"我知道了"
            if (title && title.classList.contains('right')) {
                if (!schedule || schedule.type !== 'gotknow') {
                    schedule = { type: 'gotknow', at: now + shortDelay() };
                }
                if (now < schedule.at) {
                    return { text: '已答对，' + remainSec(schedule.at) + ' 秒后继续', level: 'ok' };
                }
                schedule = null;
                pendingCorrect = null;
                clickEl(gotKnow);
                return { text: '回答正确，继续播放', level: 'ok' };
            }

            // 答错：立即关提示、读取正确答案，安排随机延迟后重答
            if (title && (title.classList.contains('error') || title.classList.contains('tip'))) {
                if (pendingCorrect === null) {
                    pendingCorrect = readCorrectAnswer(tip);
                    log('答错，正确答案 =', pendingCorrect);
                }
                if (!schedule || schedule.type !== 'resubmit') {
                    schedule = { type: 'resubmit', at: now + randAnswerDelay() };
                }
                clickEl(gotKnow);
                return { text: '答错，' + remainSec(schedule.at) + ' 秒后重答', level: 'busy' };
            }

            // 其他提示：关掉
            clickEl(gotKnow);
            return { text: '关闭提示', level: 'busy' };
        }

        // ---------- 无提示框 ----------
        // 重答：等随机延迟 → 重选正确答案 → 提交
        if (pendingCorrect !== null) {
            if (!schedule || schedule.type !== 'resubmit') {
                schedule = { type: 'resubmit', at: now + randAnswerDelay() };
            }
            if (now < schedule.at) {
                return { text: '重答准备中（' + remainSec(schedule.at) + ' 秒）', level: 'busy' };
            }
            schedule = null;
            reselect(pendingCorrect);
            pendingCorrect = null;
            const cont = document.querySelector('.questions_btngroup_tools .continueNode');
            if (cont && isVisible(cont)) {
                lastSubmitTime = now;
                clickEl(cont);
            }
            return { text: '已重选正确答案并提交', level: 'busy' };
        }

        // 跳过：等随机延迟 → 点"跳过"
        const skip = document.querySelector('.questions_btngroup_tools .skipNode');
        if (skip && isVisible(skip)) {
            if (!schedule || schedule.type !== 'skip') {
                schedule = { type: 'skip', at: now + randAnswerDelay() };
            }
            if (now < schedule.at) {
                return { text: '准备跳过（' + remainSec(schedule.at) + ' 秒）', level: 'busy' };
            }
            schedule = null;
            clickEl(skip);
            return { text: '本题可跳过，已跳过', level: 'busy' };
        }

        // 审题：等随机延迟 → 作答
        if (!schedule || schedule.type === 'answer') {
            if (!schedule) {
                schedule = { type: 'answer', at: now + randAnswerDelay() };
            }
            if (now < schedule.at) {
                return { text: '审题中（' + remainSec(schedule.at) + ' 秒）', level: 'busy' };
            }
            schedule = null;
            autoAnswer();
            schedule = { type: 'submit', at: Date.now() + shortDelay() };
            return { text: '已选择答案，准备提交…', level: 'busy' };
        }

        // 提交：短延迟 → 点"继续"
        if (schedule.type === 'submit') {
            if (now < schedule.at) {
                return { text: '准备提交（' + remainSec(schedule.at) + ' 秒）', level: 'busy' };
            }
            schedule = null;
            const cont = document.querySelector('.questions_btngroup_tools .continueNode');
            if (cont && isVisible(cont) && Date.now() - lastSubmitTime > 2500) {
                lastSubmitTime = Date.now();
                clickEl(cont);
            }
            return { text: '已提交答案', level: 'busy' };
        }

        // 兜底
        schedule = null;
        return { text: '弹题处理中', level: 'busy' };
    }

    // ===================== 倍速管理（含弹题保护） =====================
    // 原理：弹题靠视频每秒的 timeupdate 逐秒检测命中题目时间点。
    // 高倍速时视频时间会"跳跃"越过题目点（例如 16x 下可能一次跳 4 秒），导致弹题被漏掉。
    // 方案：从进度条上的题目点读取精确时间，接近时把倍速临时降到 1x，通过后再恢复。
    let guardPoints = [];      // 弹题点列表（视频秒数）
    let guardActive = false;   // 当前是否处于保护减速中
    let guardPointsAt = 0;     // 上次收集时间戳
    let lastDuration = 0;      // 上次视频时长（用于检测切换视频）

    function collectGuardPoints(v) {
        // 视频切换（时长变化）时强制立即重新收集
        if (v && v.duration && Math.abs(v.duration - lastDuration) > 0.5) {
            lastDuration = v.duration;
            guardPointsAt = 0;
        }
        const now = Date.now();
        if (now - guardPointsAt < 1500) return;   // 1.5 秒收集一次即可
        guardPointsAt = now;

        const pts = [];
        // 首选：从页面 jQuery 的 data 读取精确的整数秒（appendPoint 时写入）
        if (jq && jq.fn) {
            try {
                jq('.videoPointNode.question_point').each(function () {
                    const pos = jq(this).data('pointPosition');
                    if (typeof pos === 'number' && pos > 0) pts.push(pos);
                });
            } catch (e) {}
        }
        // 兜底：按进度条位置百分比 × 总时长 估算
        if (!pts.length && v && v.duration) {
            const nodes = document.querySelectorAll('.videoPointNode.question_point');
            for (const n of nodes) {
                const left = parseFloat(n.style.left);
                if (!isNaN(left) && left > 0) pts.push(Math.round(left / 100 * v.duration));
            }
        }
        guardPoints = pts;
    }

    // 倍速管理主函数；返回是否正处于保护减速状态
    function speedGuard(v) {
        const target = Number(state.SPEED) || 0;
        if (target <= 0 || v.ended) { guardActive = false; return false; }

        collectGuardPoints(v);

        // 高倍速保护：接近弹题点（前 guardWindow 秒）时临时降至 1x，
        // 通过弹题点后 3 秒内保持 1x（确保弹题完成触发），之后恢复目标倍速。
        if (state.GUARD && target > 1 && guardPoints.length && !v.paused) {
            const ct = v.currentTime;
            const guardWindow = Math.max(3, target * 0.3 + 1.5);
            const inZone = guardPoints.some(pt => ct >= pt - guardWindow && ct <= pt + 3);
            if (inZone) {
                if (v.playbackRate !== 1) {
                    v.playbackRate = 1;
                    log('弹题保护：接近题目点，临时降至 1x');
                }
                guardActive = true;
                return true;
            }
        }

        guardActive = false;
        if (v.playbackRate !== target) {
            v.playbackRate = target;
        }
        return false;
    }

    // ===================== 下一节 & 自动播放 =====================
    let nextTimer = null;
    function scheduleNext() {
        if (nextTimer) return;
        let delay = randNextDelay();
        if (delay < FIXED.NEXT_FLOOR) delay = FIXED.NEXT_FLOOR; // 保底 0.5 秒防竞态
        nextPendingAt = Date.now() + delay;
        nextTimer = setTimeout(() => {
            nextTimer = null;
            nextPendingAt = 0;
            const btn = document.querySelector('.next_chapter');
            if (btn && isVisible(btn)) {
                log('视频播完 → 点击"下一节"');
                clickEl(btn);
            }
        }, delay);
    }

    function ensurePlaying() {
        const v = getVideo();
        if (!v) return;
        if (state.MUTE && !v.muted) v.muted = true;
        const qbox = document.querySelector('.language_question:not(.hide)');
        if (qbox) return;
        if (state.AUTO_PLAY && v.paused && !v.ended) {
            v.play().catch(() => {});
        }
    }

    function bindVideo() {
        const v = getVideo();
        if (!v) return;
        if (v.dataset.gxnuflBound) return;
        v.dataset.gxnuflBound = '1';
        v.addEventListener('ended', () => {
            if (state.AUTO_NEXT) scheduleNext();
        });
    }

    // ===================== 右下角设置面板 =====================
    let elPanel = null, elPill = null, elStatus = null, elPillDot = null;

    const LEVEL_COLORS = { ok: '#2ecc71', busy: '#f0b429', warn: '#e05252', off: '#8a8f98' };

    function injectStyle() {
        if (document.getElementById('gxnufl-style')) return;
        const css = `
#gxnufl-pill, #gxnufl-panel, #gxnufl-panel * {
    box-sizing: border-box;
    font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
}
#gxnufl-pill {
    position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;
    display: flex; align-items: center; gap: 7px;
    background: rgba(22,24,26,0.92); color: #e8eaed;
    font-size: 12px; padding: 8px 13px; border-radius: 999px;
    border: 1px solid rgba(255,255,255,0.14);
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    cursor: pointer; user-select: none;
}
#gxnufl-pill:hover { background: rgba(42,46,50,0.95); }
#gxnufl-pill .gx-dot { width: 7px; height: 7px; border-radius: 50%; background: #2ecc71; flex: 0 0 auto; }
#gxnufl-panel {
    position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;
    width: 238px;
    background: rgba(22,24,26,0.95); color: #e8eaed; font-size: 12px;
    border-radius: 12px; border: 1px solid rgba(255,255,255,0.14);
    box-shadow: 0 8px 28px rgba(0,0,0,0.5);
    padding: 10px 12px 11px;
}
#gxnufl-panel .gx-head { display: flex; justify-content: space-between; align-items: center; }
#gxnufl-panel .gx-title { font-weight: 600; font-size: 12.5px; color: #f1f3f4; }
#gxnufl-panel .gx-min { cursor: pointer; color: #9aa0a6; padding: 0 5px; font-weight: 700; line-height: 1; }
#gxnufl-panel .gx-min:hover { color: #ffffff; }
#gxnufl-panel .gx-status {
    margin: 7px 0 8px; padding: 5px 8px; border-radius: 6px;
    background: rgba(255,255,255,0.07); color: #cfd3d6;
    font-size: 11px; line-height: 1.5; min-height: 17px; word-break: break-all;
}
#gxnufl-panel .gx-row { display: flex; justify-content: space-between; align-items: center; padding: 3.5px 0; }
#gxnufl-panel .gx-label { color: #d6d9dc; }
#gxnufl-panel .gx-switch {
    position: relative; width: 34px; height: 18px; border-radius: 999px;
    background: rgba(255,255,255,0.2); cursor: pointer;
    transition: background 0.15s; flex: 0 0 auto;
}
#gxnufl-panel .gx-switch.on { background: #2ecc71; }
#gxnufl-panel .gx-knob {
    position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
    border-radius: 50%; background: #ffffff; transition: left 0.15s;
}
#gxnufl-panel .gx-switch.on .gx-knob { left: 18px; }
#gxnufl-panel select {
    background: rgba(255,255,255,0.1); color: #e8eaed;
    border: 1px solid rgba(255,255,255,0.22); border-radius: 6px;
    padding: 2px 4px; font-size: 11px; outline: none; cursor: pointer;
}
#gxnufl-panel select option { background: #17191b; color: #e8eaed; }
#gxnufl-panel .gx-range { display: flex; align-items: center; gap: 3px; color: #cfd3d6; font-size: 11px; }
#gxnufl-panel .gx-num {
    width: 36px; text-align: center;
    background: rgba(255,255,255,0.1); color: #e8eaed;
    border: 1px solid rgba(255,255,255,0.22); border-radius: 6px;
    padding: 2px 2px; font-size: 11px; outline: none;
    -moz-appearance: textfield; appearance: textfield;
}
#gxnufl-panel .gx-num::-webkit-outer-spin-button,
#gxnufl-panel .gx-num::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
#gxnufl-panel .gx-num:focus { border-color: rgba(46,204,113,0.65); }
#gxnufl-panel .gx-jump {
    width: 100%; margin-top: 9px; padding: 7px 0;
    background: rgba(46,204,113,0.16); color: #7ee2a8;
    border: 1px solid rgba(46,204,113,0.4); border-radius: 8px;
    cursor: pointer; font-size: 12px; font-family: inherit;
}
#gxnufl-panel .gx-jump:hover { background: rgba(46,204,113,0.3); color: #a5f0c4; }
#gxnufl-panel .gx-foot { margin-top: 7px; font-size: 10.5px; color: #8a8f98; text-align: center; }
        `;
        const style = document.createElement('style');
        style.id = 'gxnufl-style';
        style.textContent = css;
        document.head.appendChild(style);
    }

    function makeSwitch(key) {
        const sw = document.createElement('div');
        sw.className = 'gx-switch' + (state[key] ? ' on' : '');
        const knob = document.createElement('span');
        knob.className = 'gx-knob';
        sw.appendChild(knob);
        sw.title = '点击切换';
        sw.addEventListener('click', () => {
            state[key] = !state[key];
            sw.classList.toggle('on', state[key]);
            saveState();
            log(key, '=', state[key]);
        });
        return sw;
    }

    function makeRow(label, node) {
        const r = document.createElement('div');
        r.className = 'gx-row';
        const l = document.createElement('span');
        l.className = 'gx-label';
        l.textContent = label;
        r.appendChild(l);
        r.appendChild(node);
        return r;
    }

    function makeSelect(key, options, transform) {
        const sel = document.createElement('select');
        options.forEach(([v, t]) => {
            const o = document.createElement('option');
            o.value = v;
            o.textContent = t;
            sel.appendChild(o);
        });
        sel.value = String(state[key]);
        sel.addEventListener('change', () => {
            state[key] = transform ? transform(sel.value) : sel.value;
            saveState();
            log(key, '=', state[key]);
        });
        return sel;
    }

    // 倍速自定义输入（0 = 不干预；0.25 步进，最高 16）
    function makeSpeedInput() {
        const wrap = document.createElement('span');
        wrap.className = 'gx-range';
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.min = '0';
        inp.max = '16';
        inp.step = '0.25';
        inp.className = 'gx-num';
        inp.style.width = '46px';
        inp.value = state.SPEED;
        inp.title = '0 = 不干预；最高 16 倍速。高倍速时接近题目点会自动临时降速';
        const unit = document.createElement('span');
        unit.textContent = 'x';
        inp.addEventListener('change', () => {
            let v = parseFloat(inp.value);
            if (isNaN(v) || v < 0) v = 0;
            if (v > 16) v = 16;
            v = Math.round(v * 100) / 100;
            state.SPEED = v;
            inp.value = v;
            saveState();
            log('SPEED =', v);
        });
        wrap.appendChild(inp);
        wrap.appendChild(unit);
        return wrap;
    }

    function clampInt(v, lo, hi) {
        v = parseInt(v, 10);
        if (isNaN(v)) return lo;
        return Math.min(hi, Math.max(lo, v));
    }

    // 延迟区间输入组：[min] ~ [max] 秒（0~0 表示关闭）
    function makeDelayInputs(minKey, maxKey) {
        const wrap = document.createElement('span');
        wrap.className = 'gx-range';

        const inpMin = document.createElement('input');
        const inpMax = document.createElement('input');
        [inpMin, inpMax].forEach(i => {
            i.type = 'number';
            i.min = '0';
            i.max = '600';
            i.step = '1';
            i.className = 'gx-num';
        });
        inpMin.value = state[minKey];
        inpMax.value = state[maxKey];
        inpMin.title = '延迟下限（秒）';
        inpMax.title = '延迟上限（秒）；0~0 表示关闭';

        const sep = document.createElement('span');
        sep.textContent = '~';
        const unit = document.createElement('span');
        unit.textContent = '秒';

        inpMin.addEventListener('change', () => {
            const v = clampInt(inpMin.value, 0, 600);
            state[minKey] = v;
            inpMin.value = v;
            // 下限高于上限时，上限跟随
            if (v > (Number(state[maxKey]) || 0)) {
                state[maxKey] = v;
                inpMax.value = v;
            }
            saveState();
            log(minKey, '=', v, '|', maxKey, '=', state[maxKey]);
        });
        inpMax.addEventListener('change', () => {
            const v = clampInt(inpMax.value, 0, 600);
            state[maxKey] = v;
            inpMax.value = v;
            // 上限低于下限时，下限跟随
            if (v < (Number(state[minKey]) || 0)) {
                state[minKey] = v;
                inpMin.value = v;
            }
            saveState();
            log(minKey, '=', state[minKey], '|', maxKey, '=', v);
        });

        wrap.appendChild(inpMin);
        wrap.appendChild(sep);
        wrap.appendChild(inpMax);
        wrap.appendChild(unit);
        return wrap;
    }

    // 面板运行时可见状态；persist=false 时仅改变本次显示（临时收起），不写入持久化偏好
    let panelVisible = false;
    function setPanelOpen(open, persist) {
        panelVisible = open;
        if (persist !== false) {
            state._panelOpen = open;
            saveState();
        }
        if (elPanel) elPanel.style.display = open ? 'block' : 'none';
        if (elPill) elPill.style.display = open ? 'none' : 'flex';
    }

    function buildUI() {
        injectStyle();

        // 折叠态：状态胶囊
        elPill = document.createElement('div');
        elPill.id = 'gxnufl-pill';
        elPillDot = document.createElement('span');
        elPillDot.className = 'gx-dot';
        const pillText = document.createElement('span');
        pillText.textContent = '刷课助手';
        elPill.appendChild(elPillDot);
        elPill.appendChild(pillText);
        elPill.title = '点击打开设置面板';
        elPill.addEventListener('click', () => setPanelOpen(true));
        document.body.appendChild(elPill);

        // 展开态：设置面板
        elPanel = document.createElement('div');
        elPanel.id = 'gxnufl-panel';

        const head = document.createElement('div');
        head.className = 'gx-head';
        const title = document.createElement('span');
        title.className = 'gx-title';
        title.textContent = '刷课助手设置';
        const min = document.createElement('span');
        min.className = 'gx-min';
        min.textContent = '—';
        min.title = '收起面板';
        min.addEventListener('click', () => setPanelOpen(false));
        head.appendChild(title);
        head.appendChild(min);

        elStatus = document.createElement('div');
        elStatus.className = 'gx-status';
        elStatus.textContent = '初始化中…';

        const bodyBox = document.createElement('div');
        bodyBox.appendChild(makeRow('自动下一节', makeSwitch('AUTO_NEXT')));
        bodyBox.appendChild(makeRow('自动答题', makeSwitch('AUTO_ANSWER')));
        bodyBox.appendChild(makeRow('自动续播', makeSwitch('AUTO_PLAY')));
        bodyBox.appendChild(makeRow('字幕匹配答案', makeSwitch('USE_SUBTITLE')));
        bodyBox.appendChild(makeRow('静音', makeSwitch('MUTE')));
        bodyBox.appendChild(makeRow('播放倍速', makeSpeedInput()));
        bodyBox.appendChild(makeRow('弹题保护', makeSwitch('GUARD')));
        bodyBox.appendChild(makeRow('答题延迟', makeDelayInputs('DELAY_ANSWER_MIN', 'DELAY_ANSWER_MAX')));
        bodyBox.appendChild(makeRow('下一节延迟', makeDelayInputs('DELAY_NEXT_MIN', 'DELAY_NEXT_MAX')));

        const jump = document.createElement('button');
        jump.className = 'gx-jump';
        jump.textContent = '立即跳下一节';
        jump.addEventListener('click', () => {
            const btn = document.querySelector('.next_chapter');
            if (btn && isVisible(btn)) {
                clickEl(btn);
                setStatus('已手动跳到下一节', 'busy');
            } else {
                setStatus('未找到"下一节"按钮', 'warn');
            }
        });

        const foot = document.createElement('div');
        foot.className = 'gx-foot';
        foot.textContent = '延迟 0~0 = 关闭；倍速 0 = 不干预，高速时题目点自动降速';

        elPanel.appendChild(head);
        elPanel.appendChild(elStatus);
        elPanel.appendChild(bodyBox);
        elPanel.appendChild(jump);
        elPanel.appendChild(foot);
        document.body.appendChild(elPanel);

        // 点击页面其他区域（面板与胶囊之外）自动收起面板（临时收起，不改变记忆偏好）
        document.addEventListener('click', (e) => {
            if (!panelVisible) return;
            if (elPanel && elPanel.contains(e.target)) return;
            if (elPill && elPill.contains(e.target)) return;
            setPanelOpen(false, false);
        }, true);

        setPanelOpen(state._panelOpen !== false, false);
    }

    function setStatus(text, level) {
        level = level || 'ok';
        if (text === lastStatusText && level === lastStatusLevel) return;
        lastStatusText = text;
        lastStatusLevel = level;
        if (elStatus) elStatus.textContent = text;
        if (elPillDot) elPillDot.style.background = LEVEL_COLORS[level] || LEVEL_COLORS.ok;
    }

    // ===================== 主循环 =====================
    function tick() {
        bindVideo();
        const handled = handleQuestion();
        ensurePlaying();

        if (handled) {
            setStatus(handled.text, handled.level);
            return;
        }

        // 高速保护减速中
        if (guardActive) {
            setStatus('弹题保护：接近题目点，已临时降至 1x', 'busy');
            return;
        }

        // "下一节"等待中
        if (nextPendingAt > Date.now()) {
            setStatus('本节完成，' + remainSec(nextPendingAt) + ' 秒后跳下一节', 'ok');
            return;
        }

        // 自动答题关闭但检测到弹题 → 提示人工
        if (!state.AUTO_ANSWER && document.querySelector('.language_question:not(.hide)')) {
            setStatus('检测到弹题（自动答题已关闭，请手动作答）', 'warn');
            return;
        }

        const v = getVideo();
        if (!v) {
            setStatus('等待视频加载…', 'off');
        } else if (!state.AUTO_NEXT && !state.AUTO_ANSWER && !state.AUTO_PLAY) {
            setStatus('全部功能已关闭', 'off');
        } else {
            setStatus('自动刷课运行中', 'ok');
        }
    }

    function start() {
        log('脚本已启动 v3.4', state);
        buildUI();
        setInterval(tick, FIXED.POLL_MS);
        // 倍速管理用更高频检查（100ms），保证高倍速下能及时在题目点减速
        setInterval(() => {
            const v = getVideo();
            if (v) speedGuard(v);
        }, 100);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
