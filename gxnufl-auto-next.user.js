// ==UserScript==
// @name         GXNUFL 刷课助手
// @namespace    xiaobu.userscripts
// @version      3.8.0
// @description  广西师大漓江学院(elearnmooc)：自动下一节 + 弹题自动处理 + 自定义倍速 + 自动提问 + 省流量模式；兼容智慧树网(zhihuishu.com)资料学习页（自动播放/倍速/自动切换下一个资源）
// @author       小布
// @match        https://gxnufl.elearnmooc.com/*
// @match        https://*.zhihuishu.com/*
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
        AUTO_ASK: false,        // 自动提问：每节视频自动生成一个问题并提交一次
        SAVE_DATA: false,       // 省流量模式：不下载视频内容，虚拟推进进度（弹题/进度上报照常）
        PARALLEL: 3,            // 智慧树：并行窗口数（多开同时播放）
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
        ASK_READY_AT: 3000,     // 页面加载后至少等 3 秒再自动提问（等页面初始化）
    };
    const ASK_RECORD_KEY = 'gxnufl_asked_sections';   // 已自动提问过的小节记录
    const START_AT = Date.now();
    const IS_ZHS = /zhihuishu\.com$/i.test(location.hostname);   // 智慧树网模式

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
    let askInFlight = false;     // 自动提问进行中标记

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
        if (IS_ZHS) {
            return document.querySelector('video#vjs_mediaPlayer_html5_api') || document.querySelector('video');
        }
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

    // ===================== 自动提问（按视频标题生成问题并提交） =====================
    // 页面结构：.question_student_title（标题）/ .question_textarea（内容）/ .save_question（提交）
    // 提交接口：/multilingual/insertDiscussPost（由页面自身处理，脚本只负责填值+点按钮）

    // 读取视频标题（优先 title 属性）
    function getVideoTitle() {
        const el = document.querySelector('.video_name');
        if (!el) return '';
        return (el.getAttribute('title') || el.innerText || '').trim();
    }

    // 生成一个提问：标题即问题本身（不带"In the video…"等引导语），内容补一句客套
    // 与视频的关联由平台自动记录（提交时带 subsectionId + showTime）
    function genQuestion() {
        const bank = [
            'What are the main challenges discussed, and how can we deal with them in our daily life?',
            'Could you explain the main idea with one more example?',
            'How can we apply these ideas in real situations?',
            'Could you explain how to use these important expressions correctly?',
            'What is the main idea, and how are the ideas organized?',
        ];
        const q = bank[Math.floor(Math.random() * bank.length)];
        return {
            title: q,                                  // 标题 = 问题本身
            content: q + '\n\nLooking forward to your answer. Thank you!',
        };
    }

    // 关闭匹配关键词的 alertBox 提示（页面自定义弹窗）
    function closeAlertIfMatch(keyword) {
        const boxes = document.querySelectorAll('.alertbox');
        boxes.forEach(box => {
            const msg = box.querySelector('.alertbox_message');
            if (msg && msg.innerText.indexOf(keyword) !== -1) {
                const btn = box.querySelector('.alertbox_group button')
                    || box.querySelector('.alertbox_group input')
                    || box.querySelector('.alertbox_group a');
                if (btn) clickEl(btn);
            }
        });
    }

    // 本节是否已经提问过
    function isSectionAsked(key) {
        if (!key) return false;
        try {
            const asked = JSON.parse(localStorage.getItem(ASK_RECORD_KEY) || '{}');
            return !!asked[key];
        } catch (e) { return false; }
    }

    // 记录本节已提问
    function markSectionAsked(key) {
        if (!key) return;
        try {
            const asked = JSON.parse(localStorage.getItem(ASK_RECORD_KEY) || '{}');
            asked[key] = Date.now();
            localStorage.setItem(ASK_RECORD_KEY, JSON.stringify(asked));
        } catch (e) {}
    }

    // ---- 服务端核对：本节的提问列表里是否有我发的（兼容"脚本加记录功能之前"发的提问）----
    let askedRemoteCache = {};   // key → true/false，避免重复请求

    function getMyUserId() {
        try {
            return (window.websiteInfo && window.websiteInfo.data
                && window.websiteInfo.data.userInfo && window.websiteInfo.data.userInfo.userId) || 0;
        } catch (e) { return 0; }
    }

    function getMyName() {
        try {
            return (window.websiteInfo && window.websiteInfo.data
                && window.websiteInfo.data.userInfo && window.websiteInfo.data.userInfo.chinaName) || '';
        } catch (e) { return ''; }
    }

    // 查服务端：本节帖子列表里是否有自己的帖子
    function checkAskedRemote(cb) {
        const key = getSectionKey();
        if (!key) { cb(false); return; }
        if (askedRemoteCache[key] !== undefined) { cb(askedRemoteCache[key]); return; }
        if (!jq || !jq.ajaxPlus) { cb(false); return; }
        const myId = getMyUserId();
        const myName = getMyName();
        try {
            jq.ajaxPlus({
                url: '/multilingual/queryDiscussPostList',
                data: { subsectionId: key, size: 50, page: 1 },
                success: function (d) {
                    const list = (d && d.DiscussPostList) || [];
                    const has = list.some(p =>
                        (myId && String(p.creatorId) === String(myId)) ||
                        (myName && p.creatorName === myName)
                    );
                    askedRemoteCache[key] = has;
                    cb(has);
                },
                error: function () { cb(false); },
            });
        } catch (e) { cb(false); }
    }

    // 统一的"本节是否已提问"判断：本地记录优先，其次查服务端（查到则回填本地）
    function checkAsked(cb) {
        const key = getSectionKey();
        if (!key) { cb(false); return; }
        if (isSectionAsked(key)) { cb(true); return; }
        checkAskedRemote((has) => {
            if (has) markSectionAsked(key);
            cb(has);
        });
    }

    // 填写并提交一个问题；返回是否成功触发
    function submitQuestion() {
        const titleEl = document.querySelector('.question_student_title');
        const contentEl = document.querySelector('.question_textarea');
        if (!titleEl || !contentEl) {
            setStatus('未找到提问输入框（当前页面可能不支持提问）', 'warn');
            return false;
        }
        // 切到"提问"标签页（保证输入区可见、状态正确）
        const tab = document.querySelector('.note_title .student_question');
        if (tab && !tab.classList.contains('active')) clickEl(tab);

        const q = genQuestion();
        fillText(titleEl, q.title);
        fillText(contentEl, q.content);
        log('生成提问：', q.title);
        setStatus('已生成提问，正在提交…', 'busy');
        markSectionAsked(getSectionKey());   // 记录本节已提问，防止重复

        // 稍等片刻（等 tab 切换/赋值完成）再点提交
        setTimeout(() => {
            const btn = document.querySelector('.save_question');
            if (btn) clickEl(btn);
            // 自动关闭"保存提问成功"提示
            setTimeout(() => {
                closeAlertIfMatch('保存提问成功');
                closeAlertIfMatch('保存提问失败');
            }, 1200);
        }, 400);
        return true;
    }

    // 取当前小节标识（subsectionId 优先）
    function getSectionKey() {
        const m = location.search.match(/subsectionId=(\d+)/);
        if (m) return m[1];
        const t = getVideoTitle();
        return t || location.pathname;
    }

    // 自动提问主检查（每节只问一次，记录在 localStorage）
    function autoAskTick() {
        if (!state.AUTO_ASK || askInFlight || IS_ZHS) return;
        if (Date.now() - START_AT < FIXED.ASK_READY_AT) return;   // 等页面初始化
        const v = getVideo();
        if (!v || v.readyState < 1) return;                       // 等视频元数据

        const key = getSectionKey();
        if (!key) return;

        askInFlight = true;
        checkAsked((has) => {
            if (!has && submitQuestion()) {
                log('本节自动提问完成，已记录', key);
            }
            askInFlight = false;
        });
    }

    // 手动提问入口：先查本地记录+服务端列表，已提问则弹确认框（"是否还要提问？"）
    function askWithConfirm() {
        setStatus('正在检查本节是否已提问…', 'busy');
        checkAsked((has) => {
            if (!has) {
                submitQuestion();
                return;
            }
            const msg = '这个视频已经提问过一次了，是否还要提问？';
            // 优先用页面自带的 alertBox（样式与平台一致，带按钮回调）
            if (typeof window.alertBox === 'function') {
                try {
                    window.alertBox(msg, ['确定', '取消'], [
                        function () { submitQuestion(); },
                        function () { /* 取消：不做任何事 */ },
                    ]);
                    return;
                } catch (e) {}
            }
            // 回退：原生 confirm
            if (window.confirm(msg)) submitQuestion();
        });
    }

    // ===================== 省流量模式（不下载视频，虚拟推进进度） =====================
    // 原理：视频卡在下载上。此模式只预加载 metadata（文件头几 KB）拿到总时长，
    // 然后把 <video> 换成"虚拟播放器"：不下载画面，用定时器推进 currentTime 并触发
    // timeupdate —— 平台的进度上报（每 60 秒一次）与弹题检测（逐秒比对）都照常工作。
    let saveModeActive = false;   // 是否已启用虚拟播放
    let savePending = false;      // 正在等待 metadata
    let savePendingAt = 0;        // 等待开始时间（超时兜底）
    let virtualTime = 0;          // 虚拟播放时间（秒）
    let virtualPlaying = false;   // 虚拟播放状态
    let virtualTimer = null;      // 虚拟推进定时器
    let realDuration = 0;         // 真实视频总时长
    const origMembers = {};       // 原始属性/方法（关闭时还原用）

    function enableSaveData(video) {
        if (!video || saveModeActive) return;
        if (savePending) {
            if (Date.now() - savePendingAt > 15000) { savePending = false; }  // 超时兜底
            else return;
        }
        // 已知时长 → 直接进入虚拟播放
        if (realDuration > 0) { applyVirtualPlayer(video); return; }
        if (video.duration && isFinite(video.duration) && video.duration > 0) {
            realDuration = video.duration;
            applyVirtualPlayer(video);
            return;
        }
        // 时长未知 → 只预加载 metadata（只下文件头，几 KB）
        savePending = true;
        savePendingAt = Date.now();
        if (!video.dataset.origSrc && video.getAttribute('src')) {
            video.dataset.origSrc = video.getAttribute('src');
        }
        try {
            video.preload = 'metadata';
            video.addEventListener('loadedmetadata', function onMeta() {
                video.removeEventListener('loadedmetadata', onMeta);
                savePending = false;
                realDuration = video.duration || 0;
                applyVirtualPlayer(video);
            }, { once: true });
            video.load();
        } catch (e) { savePending = false; }
        log('省流量模式：正在读取视频时长（只加载文件头）…');
    }

    function applyVirtualPlayer(video) {
        if (saveModeActive || !realDuration) return;
        // 停止下载
        try {
            video.pause();
            if (!video.dataset.origSrc && video.getAttribute('src')) {
                video.dataset.origSrc = video.getAttribute('src');
            }
            video.preload = 'none';
            video.removeAttribute('src');   // 断开缓冲（原地址存在 dataset 里）
            video.load();
        } catch (e) {}

        // 记录原始定义（便于关闭时还原）
        ['duration', 'currentTime', 'paused', 'ended'].forEach(k => {
            origMembers[k] = Object.getOwnPropertyDescriptor(video, k) || null;
        });
        origMembers.play = video.play;
        origMembers.pause = video.pause;

        // 劫持关键属性
        virtualTime = 0;
        try {
            Object.defineProperty(video, 'duration', { configurable: true, get: () => realDuration });
            Object.defineProperty(video, 'currentTime', {
                configurable: true,
                get: () => virtualTime,
                set: (v) => { virtualTime = Math.max(0, Math.min(Number(v) || 0, realDuration)); },
            });
            Object.defineProperty(video, 'paused', { configurable: true, get: () => !virtualPlaying });
            Object.defineProperty(video, 'ended', { configurable: true, get: () => virtualTime >= realDuration - 0.05 });
        } catch (e) { log('虚拟播放属性劫持失败', e); return; }

        video.play = function () { virtualPlaying = true; startVirtualTick(video); return Promise.resolve(); };
        video.pause = function () { virtualPlaying = false; return undefined; };

        saveModeActive = true;
        // 通知平台：时长已就绪、可以播放
        try { video.dispatchEvent(new Event('durationchange')); } catch (e) {}
        try { video.dispatchEvent(new Event('canplay')); } catch (e) {}
        // 自动开始
        virtualPlaying = true;
        startVirtualTick(video);
        log('省流量模式已启用：不下载视频，虚拟推进进度（总时长 ' + Math.round(realDuration) + ' 秒）');
    }

    function startVirtualTick(video) {
        if (virtualTimer) return;
        virtualTimer = setInterval(() => {
            if (!saveModeActive || !virtualPlaying) return;
            const rate = Number(video.playbackRate) || 1;
            virtualTime = Math.min(virtualTime + 0.25 * rate, realDuration);
            try { video.dispatchEvent(new Event('timeupdate')); } catch (e) {}
            if (virtualTime >= realDuration - 0.05) {
                virtualPlaying = false;
                if (virtualTimer) { clearInterval(virtualTimer); virtualTimer = null; }
                try { video.dispatchEvent(new Event('ended')); } catch (e) {}
            }
        }, 250);
    }

    function disableSaveData(video) {
        if (!saveModeActive || !video) return;
        const resumeAt = virtualTime;
        saveModeActive = false;
        virtualPlaying = false;
        if (virtualTimer) { clearInterval(virtualTimer); virtualTimer = null; }

        // 还原属性与方法
        ['duration', 'currentTime', 'paused', 'ended'].forEach(k => {
            try { delete video[k]; } catch (e) {}
            if (origMembers[k]) { try { Object.defineProperty(video, k, origMembers[k]); } catch (e) {} }
        });
        if (origMembers.play) video.play = origMembers.play;
        if (origMembers.pause) video.pause = origMembers.pause;

        // 恢复真实视频，并从虚拟进度处继续
        const src = video.dataset.origSrc;
        if (src) {
            try {
                video.preload = 'auto';
                video.addEventListener('loadedmetadata', function once() {
                    try { video.currentTime = Math.min(resumeAt, video.duration || resumeAt); } catch (e) {}
                    video.play().catch(() => {});
                }, { once: true });
                video.src = src;
                video.load();
            } catch (e) {}
        }
        log('省流量模式已关闭，恢复真实视频');
    }

    // ===================== 智慧树网适配（资料学习页） =====================
    // 页面结构：#sourceTree 下的 .file-item（id="file_<fileId>"，点击调 changeFile(id)）
    //          完成状态：.status-box > i.icon-finish
    //          播放器：video#vjs_mediaPlayer_html5_api（video.js）
    function zhsCurrentFileId() {
        const m = location.search.match(/[?&]fileId=(\d+)/);
        return m ? m[1] : '';
    }

    function zhsFileItems() {
        return Array.from(document.querySelectorAll('#sourceTree .file-item'));
    }

    function zhsIsDone(el) {
        return !!(el && el.querySelector('.status-box .icon-finish'));
    }

    // 找下一个资源：优先"当前之后第一个未完成"，其次从头找未完成
    function zhsNextFile() {
        const items = zhsFileItems();
        if (!items.length) return null;
        const curId = zhsCurrentFileId();
        let curIdx = items.findIndex(el => (el.id || '').replace('file_', '') === curId);
        if (curIdx < 0) curIdx = -1;
        for (let i = curIdx + 1; i < items.length; i++) {
            if (!zhsIsDone(items[i])) return items[i];
        }
        for (let i = 0; i <= curIdx && i >= 0; i++) {
            if (!zhsIsDone(items[i])) return items[i];
        }
        return null;
    }

    function zhsSwitchTo(el) {
        if (!el) return false;
        const id = (el.id || '').replace('file_', '');
        if (!id) return false;
        if (typeof window.changeFile === 'function') {
            window.changeFile(id);
            return true;
        }
        return clickEl(el);
    }

    // 当前页面的 courseId
    function zhsCourseId() {
        const m = location.search.match(/[?&]courseId=(\d+)/);
        return m ? m[1] : '';
    }

    // 未完成、且不是当前播放的文件项
    function zhsPendingFiles() {
        const curId = zhsCurrentFileId();
        return zhsFileItems().filter(el => {
            const id = (el.id || '').replace('file_', '');
            return id && id !== curId && !zhsIsDone(el);
        });
    }

    // 是否"多开"窗口（URL 带 gxParallel=1）——播完自动关闭，避免多个窗口互相抢资源
    function zhsIsParallelWindow() {
        return /[?&]gxParallel=1/.test(location.search);
    }

    // 打开 N 个并行窗口，每个播一个未完成资源（进度按真实观看时长累计，多开 = N 倍效率）
    function openParallelWindows(n) {
        const cid = zhsCourseId();
        if (!cid) { setStatus('未取到 courseId，无法多开', 'warn'); return; }
        const pend = zhsPendingFiles();
        if (!pend.length) { setStatus('没有待学习的资源了', 'ok'); return; }
        let total = parseInt(n, 10);
        if (isNaN(total) || total < 1) total = 3;
        if (total > 8) total = 8;
        const base = location.origin + location.pathname;
        let opened = 0;
        for (let i = 0; i < total && i < pend.length; i++) {
            const id = (pend[i].id || '').replace('file_', '');
            const url = base + '?courseId=' + cid + '&fileId=' + id + '&gxParallel=1';
            try {
                const w = window.open(url, '_blank', 'width=1100,height=700');
                if (w) opened++;
            } catch (e) {}
        }
        if (opened) {
            setStatus('已打开 ' + opened + ' 个并行窗口（各自播完会自动关闭）', 'ok');
            log('多开：', opened, '个窗口');
        } else {
            setStatus('窗口被浏览器拦截，请允许本页弹出窗口', 'warn');
        }
    }

    // 本资源播完 → 随机延迟后切下一个未完成资源
    function scheduleZhsNext() {
        if (nextTimer) return;
        let delay = randNextDelay();
        if (delay < FIXED.NEXT_FLOOR) delay = FIXED.NEXT_FLOOR;
        nextPendingAt = Date.now() + delay;
        nextTimer = setTimeout(() => {
            nextTimer = null;
            nextPendingAt = 0;
            const nf = zhsNextFile();
            if (nf) {
                log('本资源播完 → 切换下一个未完成资源');
                zhsSwitchTo(nf);
            } else {
                log('所有资源都已完成');
                setStatus('全部资源已完成', 'ok');
            }
        }, delay);
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

    // 手动"下一节"：进度不足时先确认（避免把没看完的视频跳过 → 该视频不计入成绩）
    function jumpNextChapter() {
        const v = getVideo();
        let pct = -1;   // -1 = 无法判断
        if (v && v.duration && isFinite(v.duration) && v.duration > 0) {
            pct = Math.min(100, Math.round((v.currentTime / v.duration) * 100));
        }
        if (pct >= 99) { doJumpNext(); return; }

        const msg = pct >= 0
            ? '本节视频还没看完（已看 ' + pct + '%），跳过将不计入视频成绩。确定要跳吗？'
            : '暂时无法确认本节观看进度，跳过可能不计入视频成绩。确定要跳吗？';
        if (typeof window.alertBox === 'function') {
            try {
                window.alertBox(msg, ['确定跳转', '取消'], [
                    function () { doJumpNext(); },
                    function () { /* 取消 */ },
                ]);
                return;
            } catch (e) {}
        }
        if (window.confirm(msg)) doJumpNext();
    }

    function doJumpNext() {
        const btn = document.querySelector('.next_chapter');
        if (btn && isVisible(btn)) {
            clickEl(btn);
            setStatus('已手动跳到下一节', 'busy');
        } else {
            setStatus('未找到"下一节"按钮', 'warn');
        }
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
            if (IS_ZHS) {
                // 多开窗口：播完自动关闭自己（避免多个窗口切到同一个资源）
                if (zhsIsParallelWindow()) {
                    log('多开窗口：本资源播完，2 秒后自动关闭');
                    setTimeout(() => { try { window.close(); } catch (e) {} }, 2000);
                    return;
                }
                if (state.AUTO_NEXT) scheduleZhsNext();
                return;
            }
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
#gxnufl-panel .gx-btn-row { display: flex; gap: 6px; margin-top: 9px; }
#gxnufl-panel .gx-jump {
    flex: 1 1 0; padding: 7px 0;
    background: rgba(46,204,113,0.16); color: #7ee2a8;
    border: 1px solid rgba(46,204,113,0.4); border-radius: 8px;
    cursor: pointer; font-size: 12px; font-family: inherit;
}
#gxnufl-panel .gx-jump:hover { background: rgba(46,204,113,0.3); color: #a5f0c4; }
#gxnufl-panel .gx-ask {
    flex: 1 1 0; padding: 7px 0;
    background: rgba(79,142,247,0.16); color: #9cc0ff;
    border: 1px solid rgba(79,142,247,0.42); border-radius: 8px;
    cursor: pointer; font-size: 12px; font-family: inherit;
}
#gxnufl-panel .gx-ask:hover { background: rgba(79,142,247,0.3); color: #c3d8ff; }
#gxnufl-panel .gx-label-wrap { position: relative; display: inline-flex; align-items: center; gap: 4px; }
#gxnufl-panel .gx-info {
    display: inline-flex; align-items: center; justify-content: center;
    width: 13px; height: 13px; border-radius: 50%;
    border: 1px solid rgba(255,255,255,0.4); color: #9aa0a6;
    font-size: 9px; line-height: 1; cursor: help; font-weight: 700;
    flex: 0 0 auto;
}
#gxnufl-panel .gx-info:hover { border-color: #7ee2a8; color: #7ee2a8; }
#gxnufl-panel .gx-tip {
    display: none; position: absolute; left: 0; top: 100%; margin-top: 4px;
    width: 196px; padding: 6px 8px; border-radius: 6px;
    background: rgba(42,46,50,0.98); color: #e8eaed;
    border: 1px solid rgba(255,255,255,0.18);
    font-size: 11px; line-height: 1.5; white-space: normal;
    z-index: 20; pointer-events: none;
    box-shadow: 0 4px 12px rgba(0,0,0,0.45);
}
#gxnufl-panel .gx-info:hover + .gx-tip { display: block; }
#gxnufl-pill { cursor: grab; }
#gxnufl-pill:active { cursor: grabbing; }
#gxnufl-panel .gx-foot { margin-top: 7px; font-size: 10.5px; color: #8a8f98; text-align: center; }
        `;
        const style = document.createElement('style');
        style.id = 'gxnufl-style';
        style.textContent = css;
        document.head.appendChild(style);
    }

    function makeSwitch(key, onChange) {
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
            if (typeof onChange === 'function') onChange(state[key]);
        });
        return sw;
    }

    function makeRow(label, node, tip) {
        const r = document.createElement('div');
        r.className = 'gx-row';
        const left = document.createElement('span');
        left.className = 'gx-label-wrap';
        const l = document.createElement('span');
        l.className = 'gx-label';
        l.textContent = label;
        left.appendChild(l);
        if (tip) {
            const icon = document.createElement('span');
            icon.className = 'gx-info';
            icon.textContent = '!';
            icon.title = '';
            const tipEl = document.createElement('span');
            tipEl.className = 'gx-tip';
            tipEl.textContent = tip;
            left.appendChild(icon);
            left.appendChild(tipEl);
        }
        r.appendChild(left);
        r.appendChild(node);
        return r;
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

    // ---- 胶囊拖拽（位置记忆）+ 面板位置同步 ----
    const PILL_POS_KEY = 'gxnufl_pill_pos';

    function getSavedPos() {
        try { return JSON.parse(localStorage.getItem(PILL_POS_KEY) || 'null'); } catch (e) { return null; }
    }

    function syncPanelPos() {
        if (!elPanel) return;
        const saved = getSavedPos();
        if (!saved || !saved.left || !saved.top) return;
        elPanel.style.right = 'auto';
        elPanel.style.bottom = 'auto';
        elPanel.style.left = saved.left;
        elPanel.style.top = saved.top;
        // 边界修正（面板比胶囊宽，可能超出屏幕）
        const r = elPanel.getBoundingClientRect();
        let left = r.left, top = r.top;
        if (left + r.width > window.innerWidth - 4) left = window.innerWidth - r.width - 4;
        if (top + r.height > window.innerHeight - 4) top = window.innerHeight - r.height - 4;
        if (left < 4) left = 4;
        if (top < 4) top = 4;
        elPanel.style.left = left + 'px';
        elPanel.style.top = top + 'px';
    }

    function makeDraggable(el) {
        let dragging = false, moved = false;
        let startX = 0, startY = 0, origLeft = 0, origTop = 0;

        const saved = getSavedPos();
        if (saved && saved.left && saved.top) {
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            el.style.left = saved.left;
            el.style.top = saved.top;
        }

        el.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            dragging = true;
            moved = false;
            const rect = el.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            origLeft = rect.left;
            origTop = rect.top;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            el.style.left = origLeft + 'px';
            el.style.top = origTop + 'px';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp, { once: true });
            e.preventDefault();
        });

        function onMove(e) {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
            let x = origLeft + dx;
            let y = origTop + dy;
            x = Math.max(0, Math.min(x, window.innerWidth - el.offsetWidth - 2));
            y = Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight - 2));
            el.style.left = x + 'px';
            el.style.top = y + 'px';
        }

        function onUp() {
            dragging = false;
            document.removeEventListener('mousemove', onMove);
            if (moved) {
                try {
                    localStorage.setItem(PILL_POS_KEY, JSON.stringify({ left: el.style.left, top: el.style.top }));
                } catch (e) {}
                syncPanelPos();
            }
        }

        // 拖拽后抑制误触的 click（避免拖动结束顺手打开面板）
        el.addEventListener('click', (e) => {
            if (moved) {
                moved = false;
                e.stopPropagation();
                e.preventDefault();
            }
        }, true);
    }

    // 移除页面"浏览器版本过低"提示条（fixed 定位横幅，无 class，按文本+样式匹配）
    function removeBrowserTip() {
        const fixedEls = document.querySelectorAll('div[style*="position: fixed"], div[style*="position:fixed"]');
        for (const el of fixedEls) {
            if (el.innerText && el.innerText.indexOf('浏览器版本过低') !== -1) {
                el.style.display = 'none';
                log('已移除"浏览器版本过低"提示条');
                return true;
            }
        }
        return false;
    }

    // 面板运行时可见状态；persist=false 时仅改变本次显示（临时收起），不写入持久化偏好
    let panelVisible = false;
    function setPanelOpen(open, persist) {
        panelVisible = open;
        if (persist !== false) {
            state._panelOpen = open;
            saveState();
        }
        if (elPanel) {
            elPanel.style.display = open ? 'block' : 'none';
            if (open) syncPanelPos();
        }
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
        elPill.title = '点击打开设置面板，按住可拖动位置';
        elPill.addEventListener('click', () => setPanelOpen(true));
        document.body.appendChild(elPill);
        makeDraggable(elPill);

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
        bodyBox.appendChild(makeRow('自动下一节', makeSwitch('AUTO_NEXT'),
            '视频播完后自动点击"下一节"，进入下一节继续播放'));
        bodyBox.appendChild(makeRow('自动答题', makeSwitch('AUTO_ANSWER'),
            '弹题时自动跳过或作答；答错会自动读取正确答案并重答，确保必答题通过'));
        bodyBox.appendChild(makeRow('自动续播', makeSwitch('AUTO_PLAY'),
            '视频被暂停且没有弹题时自动继续播放，防止刷课中断'));
        bodyBox.appendChild(makeRow('字幕匹配答案', makeSwitch('USE_SUBTITLE'),
            '单选题优先用视频字幕匹配选项，匹配不到时选第一个'));
        bodyBox.appendChild(makeRow('静音', makeSwitch('MUTE'),
            '强制静音播放，不影响进度记录'));
        bodyBox.appendChild(makeRow('播放倍速', makeSpeedInput(),
            '0 = 不干预；支持 0~16 倍速。注意：超过 4 倍速时浏览器会自动静音'));
        // 智慧树：并行窗口数（多开同时播放，进度按真实观看时长累计）
        if (IS_ZHS) {
            const wrap = document.createElement('span');
            wrap.className = 'gx-range';
            const inp = document.createElement('input');
            inp.type = 'number';
            inp.min = '1';
            inp.max = '8';
            inp.step = '1';
            inp.className = 'gx-num';
            inp.value = state.PARALLEL;
            const unit = document.createElement('span');
            unit.textContent = '个';
            inp.addEventListener('change', () => {
                let v = parseInt(inp.value, 10);
                if (isNaN(v) || v < 1) v = 1;
                if (v > 8) v = 8;
                state.PARALLEL = v;
                inp.value = v;
                saveState();
            });
            wrap.appendChild(inp);
            wrap.appendChild(unit);
            bodyBox.appendChild(makeRow('并行窗口', wrap,
                '点「多开播放」时同时打开几个窗口，每个播一个未完成资源；播完自动关闭'));
        }
        bodyBox.appendChild(makeRow('弹题保护', makeSwitch('GUARD'),
            '高倍速时接近题目时间点会自动降到 1x，确保弹题正常弹出，通过后再恢复高速'));
        bodyBox.appendChild(makeRow('自动提问', makeSwitch('AUTO_ASK'),
            '每节视频自动生成一个问题并提交；同一节只问一次，重复时会弹框确认'));
        bodyBox.appendChild(makeRow('省流量模式', makeSwitch('SAVE_DATA', (on) => {
            const v = getVideo();
            if (!v) return;
            if (on) enableSaveData(v);
            else disableSaveData(v);
        }),
            '不下载视频画面，用虚拟进度推进；弹题与进度上报照常，几乎不耗流量'));
        bodyBox.appendChild(makeRow('答题延迟', makeDelayInputs('DELAY_ANSWER_MIN', 'DELAY_ANSWER_MAX'),
            '弹题后等待的随机秒数（模仿真人审题）；0~0 表示立即作答'));
        bodyBox.appendChild(makeRow('下一节延迟', makeDelayInputs('DELAY_NEXT_MIN', 'DELAY_NEXT_MAX'),
            '视频播完后延迟的随机秒数；0~0 表示立即跳转'));

        // 按钮区：跳转下一节 + 立即提问
        const btnRow = document.createElement('div');
        btnRow.className = 'gx-btn-row';

        const jump = document.createElement('button');
        jump.className = 'gx-jump';
        jump.textContent = IS_ZHS ? '下一个资源' : '立即跳下一节';
        jump.addEventListener('click', () => {
            if (IS_ZHS) {
                const nf = zhsNextFile();
                if (nf) {
                    zhsSwitchTo(nf);
                    setStatus('已切换到下一个资源', 'busy');
                } else {
                    setStatus('没有下一个未完成的资源', 'warn');
                }
                return;
            }
            jumpNextChapter();
        });

        const ask = document.createElement('button');
        ask.className = 'gx-ask';
        ask.textContent = '立即提问';
        ask.title = '根据视频标题生成一个问题并提交';
        ask.addEventListener('click', () => {
            // 手动提问：已提问过会弹确认框
            askWithConfirm();
        });
        let parBtn = null;
        if (IS_ZHS) {
            ask.style.display = 'none';   // 智慧树资料页无此提问面板
            parBtn = document.createElement('button');
            parBtn.className = 'gx-ask';
            parBtn.textContent = '多开播放';
            parBtn.title = '按"并行窗口"数量打开窗口，每个播一个未完成资源（播完自动关闭）';
            parBtn.addEventListener('click', () => openParallelWindows(state.PARALLEL));
        }

        // 智慧树模式：隐藏不适用的功能行
        if (IS_ZHS) {
            ['自动答题', '字幕匹配答案', '弹题保护', '自动提问', '省流量模式', '答题延迟'].forEach(name => {
                const row = Array.from(bodyBox.querySelectorAll('.gx-row')).find(r => {
                    const l = r.querySelector('.gx-label');
                    return l && l.textContent === name;
                });
                if (row) row.style.display = 'none';
            });
        }

        btnRow.appendChild(jump);
        btnRow.appendChild(ask);
        if (parBtn) btnRow.appendChild(parBtn);

        const foot = document.createElement('div');
        foot.className = 'gx-foot';
        foot.textContent = '延迟 0~0=关闭；倍速 0=不干预；自动提问默认关';

        elPanel.appendChild(head);
        elPanel.appendChild(elStatus);
        elPanel.appendChild(bodyBox);
        elPanel.appendChild(btnRow);
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
        // 省流量模式：确保虚拟播放器已启用（智慧树不启用，避免破坏其播放器状态机）
        if (state.SAVE_DATA && !IS_ZHS) {
            const v0 = getVideo();
            if (v0 && !saveModeActive) enableSaveData(v0);
        }
        const handled = handleQuestion();
        ensurePlaying();
        autoAskTick();

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
        } else if (IS_ZHS) {
            setStatus('智慧树模式 · 自动刷资源中', 'ok');
        } else if (!state.AUTO_NEXT && !state.AUTO_ANSWER && !state.AUTO_PLAY) {
            setStatus('全部功能已关闭', 'off');
        } else {
            setStatus('自动刷课运行中', 'ok');
        }
    }

    function start() {
        log('脚本已启动 v3.6', state);
        buildUI();
        // 移除"浏览器版本过低"提示条（页面可能延迟插入，做几次补偿检查）
        removeBrowserTip();
        setTimeout(removeBrowserTip, 1200);
        setInterval(removeBrowserTip, 5000);
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
