// ==UserScript==
// @name         GXNUFL 刷课助手
// @namespace    xiaobu.userscripts
// @version      3.26.0
// @description  广西师大漓江学院(elearnmooc)：自动下一节 + 弹题自动处理 + 自定义倍速 + 自动提问 + 省流量模式；兼容智慧树网(zhihuishu.com)资料学习页（自动播放/倍速/自动切换下一个资源）
// @author       小布
// @match        https://gxnufl.elearnmooc.com/*
// @match        https://*.zhihuishu.com/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/yuyangu/userscripts/main/gxnufl-auto-next.user.js
// @downloadURL  https://raw.githubusercontent.com/yuyangu/userscripts/main/gxnufl-auto-next.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ===== 网络请求记录（排查掉登录/风控用：只记关键接口，响应截断） =====
    const NET_MAX = 100;
    const netLog = [];
    const NET_PATTERN = /stuStudy|studyResources|userInfo|isLogin|login|logout|session|auth|token|hike-teaching|zhsuser/i;

    function formatNet(status, method, url, resp) {
        let u = String(url || '');
        u = u.replace(/signature=[^&]*/i, 'signature=***').replace(/([?&])_=\d+/g, '$1_=***');
        const r = String(resp || '').replace(/\s+/g, ' ').slice(0, 260);
        return new Date().toLocaleTimeString() + '  [' + status + '] ' + (method || '') + ' ' + u + (r ? '  →  ' + r : '');
    }

    function recordNet(line) {
        try {
            if (!line) return;
            netLog.push(line);
            if (netLog.length > NET_MAX) netLog.shift();
            // 网络请求同样写入共享分片（kind=n）：页面跳转/重载后仍可从原域名导出
            try {
                sharedPending.push({
                    t: Date.now(), w: getWinIdSafe(), f: currentFidShort(),
                    m: String(line).slice(0, 320), k: 'n'
                });
            } catch (e) {}   // 脚本初始化早期（TDZ）丢几条无妨，不影响主流程
        } catch (e) {}
    }

    // 上报响应里的 rt = 该视频在服务端的"累计学习时长(秒)"
    // 用它可以立刻知道服务端是否已记满，不必等统计接口刷新
    function noteStudyReport(url, body) {
        try {
            if (!/saveStuStudyRecord/i.test(String(url || ''))) return;
            const m = String(body || '').match(/"rt"\s*:\s*(\d+)/);
            if (!m) return;
            const fid = (String(url).match(/fileId=(\d+)/) || [])[1] || '';
            window.__gxRt = { at: Date.now(), rt: parseInt(m[1], 10), fileId: fid };
        } catch (e) {}
    }

    // 尽早挂钩子：捕获学习上报参数 + 记录关键接口的请求/响应
    (function hookStudyReport() {
        try {
            const XO = XMLHttpRequest.prototype.open;
            const XS = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function (m, u) {
                try {
                    this.__gxUrl = String(u || '');
                    this.__gxMethod = m || 'GET';
                    if (!this.__gxNetHooked) {
                        this.__gxNetHooked = true;
                        this.addEventListener('load', function () {
                            try {
                                if (!NET_PATTERN.test(this.__gxUrl || '')) return;
                                let body = '';
                                try {
                                    if (!this.responseType || this.responseType === 'text') body = this.responseText || '';
                                } catch (e) {}
                                recordNet(formatNet(this.status, this.__gxMethod, this.__gxUrl, body));
                                noteStudyReport(this.__gxUrl, body);
                            } catch (e) {}
                        });
                    }
                } catch (e) {}
                return XO.apply(this, arguments);
            };
            XMLHttpRequest.prototype.send = function (body) {
                try {
                    if (/StuStudy|saveStuStudy/i.test(this.__gxUrl || '')) {
                        window.__gxStudyReq = { url: this.__gxUrl, method: this.__gxMethod, body: body, at: Date.now() };
                        window.__gxReportAt = Date.now();   // 最近一次上报时间（用于"卡住/掉登录"报警）
                        // 日志队列（主逻辑会转存进日志缓冲；签名打码后再记录）
                        (window.__gxHookLog = window.__gxHookLog || []).push(
                            '捕获上报: ' + String(this.__gxUrl).replace(/signature=[^&]*/i, 'signature=***')
                        );
                        console.log('%c[GXNUFL刷课] 捕获学习上报请求', 'color:#2ecc71;font-weight:bold', this.__gxUrl);
                    }
                } catch (e) {}
                return XS.apply(this, arguments);
            };
            if (window.fetch) {
                const of = window.fetch;
                window.fetch = function (input, init) {
                    const u = (typeof input === 'string') ? input : ((input && input.url) || '');
                    const method = (init && init.method) || 'GET';
                    const p = of.apply(this, arguments);
                    try {
                        if (/StuStudy|saveStuStudy/i.test(u)) {
                            window.__gxStudyReq = { url: u, method: method, body: init && init.body, at: Date.now() };
                            window.__gxReportAt = Date.now();
                            (window.__gxHookLog = window.__gxHookLog || []).push(
                                '捕获上报: ' + String(u).replace(/signature=[^&]*/i, 'signature=***')
                            );
                        }
                        if (NET_PATTERN.test(u) && p && p.then) {
                            p.then(res => {
                                try {
                                    res.clone().text().then(t => {
                                        recordNet(formatNet(res.status, method, u, t));
                                        noteStudyReport(u, t);
                                    }).catch(() => {});
                                } catch (e) {}
                            }).catch(() => {});
                        }
                    } catch (e) {}
                    return p;
                };
            }
        } catch (e) {}
    })();

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
        SAVE_DATA: false,       // 省流量模式（默认关：不下载视频、虚拟推进；需要时手动开）
        MULTI_WIN: false,       // 智慧树：多开用独立窗口（默认关 → 后台标签页）
        KEEP_ALIVE: false,      // 后台保活（超声波防标签页休眠，默认关）
        SYNC_SEC: 5,            // 多窗口信息同步间隔（秒）：3 / 5，越大越不易互相干扰
        LOG_MAX_LINES: 300,     // 日志记录条数（每个标签页分片 / 本页内存上限）
        LOG_TTL_HOURS: 24,      // 自动清理周期（小时）：超过该时长的日志自动删除
        LOG_MAX_KB: 512,        // 日志最大大小（KB，每个分片）：超出自动丢弃最旧的
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
    // 清理已废弃的配置项（旧版本残留，如已合并掉的 PARALLEL）
    delete state.PARALLEL;

    function saveState() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    }

    // 日志：内存缓冲 + 按标签页分片持久化（localStorage），页面重载/关闭后仍保留，
    // 导出时合并所有分片 = 所有标签页共用的日志目录。各窗口只写自己的分片，避免写竞态互相覆盖。
    const SHARD_PREFIX = 'gxnufl_log_';
    const logBuffer = [];
    const sharedPending = [];

    // 日志设置（可在「日志设置」界面调整，实时生效）
    function getLogCfg() {
        const lines = Math.max(50, Math.min(5000, Number(state.LOG_MAX_LINES) || 300));
        const hours = Math.max(1, Math.min(720, Number(state.LOG_TTL_HOURS) || 24));
        const maxKB = Math.max(32, Math.min(4096, Number(state.LOG_MAX_KB) || 512));
        return { lines: lines, hours: hours, ttlMs: hours * 3600 * 1000, maxBytes: maxKB * 1024 };
    }

    // 事件日志(k=l)与网络日志(k=n)分别限额，避免高频网络日志把事件日志挤掉
    function trimLogArr(arr, cfg) {
        let ev = [], nt = [];
        (arr || []).forEach(x => {
            if (!x) return;
            ((x.k || 'l') === 'n' ? nt : ev).push(x);
        });
        if (ev.length > cfg.lines) ev = ev.slice(ev.length - cfg.lines);
        if (nt.length > cfg.lines) nt = nt.slice(nt.length - cfg.lines);
        return ev.concat(nt).sort((a, b) => a.t - b.t);
    }

    function getWinIdSafe() {
        try { return WIN_ID || 'main'; } catch (e) { return 'main'; }   // WIN_ID 定义较靠后，TDZ 时回退
    }

    function currentFidShort() {
        const m = location.search.match(/[?&]fileId=(\d+)/);
        return m ? m[1] : '-';
    }

    const log = (...a) => {
        try {
            const msg = a.map(x => {
                if (typeof x === 'string') return x;
                try { return JSON.stringify(x); } catch (e) { return String(x); }
            }).join(' ');
            const line = new Date().toLocaleTimeString() + '  ' + msg;
            const cfg = getLogCfg();
            logBuffer.push(line);
            while (logBuffer.length > cfg.lines) logBuffer.shift();
            // 同时攒入共享分片（带时间戳、窗口 id、fileId，便于跨窗口合并排序）
            sharedPending.push({
                t: Date.now(), w: getWinIdSafe(), f: currentFidShort(), m: msg.slice(0, 220), k: 'l'
            });
        } catch (e) {}
        console.log('%c[GXNUFL刷课]', 'color:#2ecc71;font-weight:bold', ...a);
    };

    // 把待写入的日志落盘到本窗口分片（覆盖式写自己的 key，无竞态）
    function flushSharedLogs() {
        if (!sharedPending.length) return;
        const cfg = getLogCfg();
        const key = SHARD_PREFIX + getWinIdSafe();
        let arr = [];
        try { arr = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { arr = []; }
        if (!Array.isArray(arr)) arr = [];
        const cutoff = Date.now() - cfg.ttlMs;
        arr = arr.filter(x => x && x.t > cutoff);
        while (sharedPending.length) arr.push(sharedPending.shift());
        arr = trimLogArr(arr, cfg);
        // 大小上限：超出就丢弃最旧的
        let json = JSON.stringify(arr);
        let guard = 0;
        while (arr.length > 1 && json.length > cfg.maxBytes && guard++ < 6000) {
            arr.shift();
            json = JSON.stringify(arr);
        }
        try { localStorage.setItem(key, json); } catch (e) {}
    }

    // 合并所有标签页的分片日志，按时间排序（跨窗口共用的日志目录）
    function collectSharedLogs(kind) {
        const want = kind || 'l';
        const all = [];
        try {
            const cutoff = Date.now() - getLogCfg().ttlMs;
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k || k.indexOf(SHARD_PREFIX) !== 0) continue;
                let arr;
                try { arr = JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { continue; }
                if (!Array.isArray(arr)) continue;
                const win = k.slice(SHARD_PREFIX.length);
                arr.forEach(x => {
                    if (x && x.t > cutoff && (x.k || 'l') === want) {
                        all.push({ t: x.t, w: x.w || win, f: x.f || '-', m: x.m || '', k: (x.k || 'l') });
                    }
                });
            }
        } catch (e) {}
        all.sort((a, b) => a.t - b.t);
        return all;
    }

    function clearSharedLogs() {
        try {
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.indexOf(SHARD_PREFIX) === 0) keys.push(k);
            }
            keys.forEach(k => localStorage.removeItem(k));
        } catch (e) {}
        logBuffer.length = 0;
        netLog.length = 0;
        sharedPending.length = 0;
        log('已清空所有标签页的共享日志');
        flushSharedLogs();
        setStatus('已清空共享日志', 'ok');
    }

    // 自动清理：按"清理周期 / 记录条数 / 最大大小"裁剪所有分片
    function autoCleanLogs() {
        const cfg = getLogCfg();
        const now = Date.now();
        try {
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.indexOf(SHARD_PREFIX) === 0) keys.push(k);
            }
            keys.forEach(k => {
                let arr;
                try { arr = JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { return; }
                if (!Array.isArray(arr)) { localStorage.removeItem(k); return; }
                const before = arr.length;
                arr = arr.filter(x => x && x.t > now - cfg.ttlMs);
                arr = trimLogArr(arr, cfg);
                let json = JSON.stringify(arr);
                let guard = 0;
                while (arr.length > 1 && json.length > cfg.maxBytes && guard++ < 6000) {
                    arr.shift();
                    json = JSON.stringify(arr);
                }
                if (!arr.length) { localStorage.removeItem(k); return; }
                if (arr.length !== before) { try { localStorage.setItem(k, json); } catch (e) {} }
            });
        } catch (e) {}
    }

    function logStats() {
        const all = collectSharedLogs();
        let bytes = 0, shards = 0;
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.indexOf(SHARD_PREFIX) === 0) {
                    shards++;
                    bytes += (localStorage.getItem(k) || '').length * 2;
                }
            }
        } catch (e) {}
        return { count: all.length, shards: shards, kb: (bytes / 1024).toFixed(1), all: all };
    }

    function fmtLogLine(x) {
        const d = new Date(x.t);
        const p2 = n => String(n).padStart(2, '0');
        return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())
            + ' [w:' + x.w + '|f:' + x.f + '] ' + x.m;
    }

    // ===================== 日志设置界面 =====================
    let logDlgTimer = null;
    function openLogSettings() {
        if (document.getElementById('gxnufl-logdlg-overlay')) return;
        flushSharedLogs();

        const ov = document.createElement('div');
        ov.id = 'gxnufl-logdlg-overlay';
        const dlg = document.createElement('div');
        dlg.id = 'gxnufl-logdlg';

        const head = document.createElement('div');
        head.className = 'gxl-head';
        head.innerHTML = '<span>日志设置</span><span class="gxl-close">×</span>';
        dlg.appendChild(head);

        const body = document.createElement('div');
        body.className = 'gxl-body';
        const sec1 = document.createElement('div');
        sec1.className = 'gxl-sec'; sec1.textContent = '记录设置';
        body.appendChild(sec1);

        const cfg = getLogCfg();
        const makeCfgRow = (label, key, val, unit, tip) => {
            const row = document.createElement('div');
            row.className = 'gxl-row';
            const lb = document.createElement('label');
            lb.textContent = label; lb.title = tip || '';
            const right = document.createElement('span');
            right.className = 'gxl-right';
            const inp = document.createElement('input');
            inp.type = 'number'; inp.className = 'gxl-num'; inp.value = val;
            if (key === 'LOG_MAX_LINES') { inp.min = '50'; inp.max = '5000'; inp.step = '50'; }
            if (key === 'LOG_TTL_HOURS') { inp.min = '1'; inp.max = '720'; inp.step = '1'; }
            if (key === 'LOG_MAX_KB') { inp.min = '32'; inp.max = '4096'; inp.step = '32'; }
            inp.addEventListener('change', () => {
                let v = parseInt(inp.value, 10);
                if (isNaN(v)) v = DEFAULTS[key];
                if (key === 'LOG_MAX_LINES') v = Math.max(50, Math.min(5000, v));
                if (key === 'LOG_TTL_HOURS') v = Math.max(1, Math.min(720, v));
                if (key === 'LOG_MAX_KB') v = Math.max(32, Math.min(4096, v));
                inp.value = v;
                state[key] = v;
                saveState();
                autoCleanLogs();
                renderPreview();
                log('日志设置已更新：' + key + '=' + v);
            });
            const u = document.createElement('span');
            u.className = 'gxl-unit'; u.textContent = unit;
            right.appendChild(inp); right.appendChild(u);
            row.appendChild(lb); row.appendChild(right);
            return row;
        };
        body.appendChild(makeCfgRow('日志记录条数', 'LOG_MAX_LINES', cfg.lines, '条', '每个标签页分片及本页最多保留的日志条数'));
        body.appendChild(makeCfgRow('自动清理周期', 'LOG_TTL_HOURS', cfg.hours, '小时', '超过该时长的日志自动删除'));
        body.appendChild(makeCfgRow('日志最大大小', 'LOG_MAX_KB', Math.round(cfg.maxBytes / 1024), 'KB', '每个分片超过该大小时自动丢弃最旧的日志'));

        const info = document.createElement('div');
        info.className = 'gxl-info';
        body.appendChild(info);

        const sec2 = document.createElement('div');
        sec2.className = 'gxl-sec gxl-sec-tabs';
        const sec2Label = document.createElement('span');
        sec2Label.textContent = '最近日志预览（所有标签页，最近 40 条）';
        const tabWrap = document.createElement('span');
        tabWrap.className = 'gxl-tabs';
        const tabEv = document.createElement('button');
        tabEv.className = 'gxl-tab on'; tabEv.textContent = '事件';
        const tabNet = document.createElement('button');
        tabNet.className = 'gxl-tab'; tabNet.textContent = '网络';
        tabWrap.appendChild(tabEv); tabWrap.appendChild(tabNet);
        sec2.appendChild(sec2Label); sec2.appendChild(tabWrap);
        body.appendChild(sec2);
        let previewKind = 'l';
        const preview = document.createElement('div');
        preview.className = 'gxl-preview';
        body.appendChild(preview);
        dlg.appendChild(body);

        const foot = document.createElement('div');
        foot.className = 'gxl-foot';
        const mkBtn = (text, cls) => {
            const b = document.createElement('button');
            b.className = 'gxl-btn' + (cls ? ' ' + cls : '');
            b.textContent = text;
            return b;
        };
        const refreshBtn = mkBtn('刷新预览');
        const exportBtn = mkBtn('导出日志');
        const exportNetBtn = mkBtn('导出网络');
        const clearBtn = mkBtn('清空日志');
        const doneBtn = mkBtn('完成', 'primary');
        [refreshBtn, exportBtn, exportNetBtn, clearBtn, doneBtn].forEach(b => foot.appendChild(b));
        dlg.appendChild(foot);
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'gxl-resize';
        resizeHandle.title = '拖动调整窗口大小';
        dlg.appendChild(resizeHandle);
        ov.appendChild(dlg);
        document.body.appendChild(ov);

        // ---- 位置 / 尺寸：记忆 + 标题栏拖拽 + 右下角缩放 ----
        const DLG_RECT_KEY = 'gxnufl_logdlg_rect';
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        const readRect = () => {
            try { return JSON.parse(localStorage.getItem(DLG_RECT_KEY) || 'null'); } catch (e) { return null; }
        };
        const saveRect = () => {
            try {
                localStorage.setItem(DLG_RECT_KEY, JSON.stringify({
                    left: dlg.offsetLeft, top: dlg.offsetTop,
                    width: dlg.offsetWidth, height: dlg.offsetHeight
                }));
            } catch (e) {}
        };
        const vw = () => window.innerWidth, vh = () => window.innerHeight;
        const minW = 330, minH = 280;
        const r = readRect();
        const w0 = clamp(r && Number(r.width) ? Number(r.width) : 440, minW, Math.max(minW, vw() - 16));
        const h0 = clamp(r && Number(r.height) ? Number(r.height) : 520, minH, Math.max(minH, vh() - 16));
        dlg.style.width = w0 + 'px';
        dlg.style.height = h0 + 'px';
        dlg.style.left = clamp(r && Number.isFinite(r.left) ? r.left : (vw() - w0) / 2, 0, Math.max(0, vw() - w0 - 4)) + 'px';
        dlg.style.top = clamp(r && Number.isFinite(r.top) ? r.top : (vh() - h0) / 2, 0, Math.max(0, vh() - h0 - 4)) + 'px';

        // 标题栏拖拽（点关闭按钮时不触发）
        head.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || (e.target && e.target.classList && e.target.classList.contains('gxl-close'))) return;
            const sx = e.clientX, sy = e.clientY;
            const ol = dlg.offsetLeft, ot = dlg.offsetTop;
            const onMove = (ev) => {
                dlg.style.left = clamp(ol + ev.clientX - sx, 0, Math.max(0, vw() - dlg.offsetWidth - 4)) + 'px';
                dlg.style.top = clamp(ot + ev.clientY - sy, 0, Math.max(0, vh() - dlg.offsetHeight - 4)) + 'px';
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                saveRect();
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp, { once: true });
            e.preventDefault();
        });

        // 右下角缩放
        resizeHandle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            const sx = e.clientX, sy = e.clientY;
            const ow = dlg.offsetWidth, oh = dlg.offsetHeight;
            const ol = dlg.offsetLeft, ot = dlg.offsetTop;
            const onMove = (ev) => {
                dlg.style.width = clamp(ow + ev.clientX - sx, minW, Math.max(minW, vw() - ol - 4)) + 'px';
                dlg.style.height = clamp(oh + ev.clientY - sy, minH, Math.max(minH, vh() - ot - 4)) + 'px';
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                saveRect();
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp, { once: true });
            e.preventDefault();
        });
        // 视口变化时保证弹窗不被挤出屏幕
        const onWinResize = () => {
            dlg.style.left = clamp(dlg.offsetLeft, 0, Math.max(0, vw() - dlg.offsetWidth - 4)) + 'px';
            dlg.style.top = clamp(dlg.offsetTop, 0, Math.max(0, vh() - dlg.offsetHeight - 4)) + 'px';
        };
        window.addEventListener('resize', onWinResize);

        const onEsc = (e) => { if (e.key === 'Escape') close(); };
        const close = () => {
            if (logDlgTimer) { clearInterval(logDlgTimer); logDlgTimer = null; }
            document.removeEventListener('keydown', onEsc);
            window.removeEventListener('resize', onWinResize);
            saveRect();
            try { ov.remove(); } catch (e) {}
        };
        head.querySelector('.gxl-close').addEventListener('click', close);
        ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
        document.addEventListener('keydown', onEsc);

        function renderPreview() {
            flushSharedLogs();
            const st = logStats();
            const c = getLogCfg();
            const netCnt = collectSharedLogs('n').length;
            info.textContent = '当前：事件 ' + st.count + ' 条 / 网络 ' + netCnt + ' 条 / ' + st.shards + ' 个标签页分片 / 约 ' + st.kb + ' KB'
                + '　上限：' + c.lines + ' 条 · ' + c.hours + ' 小时 · ' + Math.round(c.maxBytes / 1024) + ' KB/分片'
                + (/^login\./i.test(location.hostname)
                    ? '\n⚠️ 当前在登录页：日志按域名隔离，这里的记录是独立的；回到课程页可导出完整时间线。'
                    : '');
            const src = collectSharedLogs(previewKind);
            const recent = src.slice(-40).reverse();
            preview.textContent = recent.length
                ? recent.map(x => previewKind === 'n' ? x.m : fmtLogLine(x)).join('\n')
                : (previewKind === 'n' ? '（暂无网络记录）' : '（暂无日志记录）');
            tabEv.classList.toggle('on', previewKind === 'l');
            tabNet.classList.toggle('on', previewKind === 'n');
        }
        tabEv.addEventListener('click', () => { previewKind = 'l'; renderPreview(); });
        tabNet.addEventListener('click', () => { previewKind = 'n'; renderPreview(); });
        refreshBtn.addEventListener('click', renderPreview);
        exportBtn.addEventListener('click', exportLog);
        exportNetBtn.addEventListener('click', exportNetLog);
        let confirmClear = false;
        clearBtn.addEventListener('click', () => {
            if (!confirmClear) {
                confirmClear = true;
                clearBtn.textContent = '确认清空？';
                clearBtn.classList.add('danger');
                setTimeout(() => {
                    confirmClear = false;
                    clearBtn.textContent = '清空日志';
                    clearBtn.classList.remove('danger');
                }, 3000);
                return;
            }
            clearSharedLogs();
            confirmClear = false;
            clearBtn.textContent = '清空日志';
            clearBtn.classList.remove('danger');
            renderPreview();
        });
        doneBtn.addEventListener('click', close);

        renderPreview();
        logDlgTimer = setInterval(() => {
            if (document.getElementById('gxnufl-logdlg-overlay')) renderPreview();
            else { clearInterval(logDlgTimer); logDlgTimer = null; }
        }, 3000);
    }
    // document-start 时 jQuery 可能还没加载，start() 里会重新取
    let jq = window.jQuery || window.$;

    // 通用文本下载（导出日志 / 导出网络日志共用）
    function saveTextFile(prefix, text, okMsg) {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        const d = new Date();
        const p2 = n => String(n).padStart(2, '0');
        a.download = prefix + '-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate())
            + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '.txt';
        a.href = URL.createObjectURL(blob);
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 3000);
        setStatus(okMsg || '已导出（浏览器下载 txt）', 'ok');
    }

    // 单独导出网络日志（所有标签页合并，按时间排序；不掺杂事件日志）
    function exportNetLog() {
        try {
            flushSharedLogs();
            const nets = collectSharedLogs('n');
            const head = [
                '=== GXNUFL 刷课助手 · 网络日志（单独导出）===',
                '导出时间: ' + new Date().toLocaleString(),
                '脚本版本: 3.26.0',
                '页面: ' + location.href,
                '当前域名: ' + location.hostname + '　（日志按域名隔离：跨子域不共享，完整记录请回到课程页导出）',
                '记录条数: ' + nets.length + ' 条（所有标签页合并，页面重载后仍保留）',
                '说明: 仅记录关键接口（stuStudy / studyResources / userInfo / isLogin / login / session / auth / token 等）',
                '',
                '--- 网络请求 ---',
            ].join('\n');
            const body = nets.length ? nets.map(x => x.m).join('\n') : '（暂无网络记录）';
            const tail = '\n\n--- 本页网络请求（最近 ' + NET_MAX + ' 条）---\n'
                + (netLog.length ? netLog.join('\n') : '（暂无网络记录）');
            saveTextFile('gxnufl-netlog', head + '\n' + body + tail, '网络日志已单独导出');
        } catch (e) {
            setStatus('网络日志导出失败：' + e.message, 'warn');
        }
    }

    // 导出运行日志（含环境信息、开关状态、事件日志、最近 100 条网络请求）
    function exportLog() {
        try {
            flushSharedLogs();   // 先把本页尚未落盘的日志写进去，保证导出完整
            const shared = collectSharedLogs('l');
            const sharedNet = collectSharedLogs('n');
            const pad = n => String(n).padStart(2, '0');
            const fmtLog = x => {
                const d = new Date(x.t);
                return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
                    + ' [w:' + x.w + '|f:' + x.f + '] ' + x.m;
            };
            const env = [
                '=== GXNUFL 刷课助手 · 运行日志 ===',
                '导出时间: ' + new Date().toLocaleString(),
                '脚本版本: 3.26.0',
                '页面: ' + location.href,
                '主机: ' + location.hostname,
                'UA: ' + navigator.userAgent,
                '窗口: ' + window.innerWidth + 'x' + window.innerHeight,
                '开关: ' + JSON.stringify(state),
                '多开窗口: ' + (IS_ZHS ? (zhsIsParallelWindow() ? '是' : '否') : '—'),
                '资源统计: ' + (zhsStat ? (zhsStat.count + ' 个视频 / 总 ' + fmtDuration(zhsStat.total) + ' / 已完成 ' + zhsStat.doneCount + ' 个') : '未加载'),
                '最近上报: ' + (window.__gxReportAt ? new Date(window.__gxReportAt).toLocaleString() : '无'),
                '当前域名: ' + location.hostname + '　（日志按域名隔离：login./wenda./hike. 子域之间不共享；完整日志请回到课程页导出）',
                '',
                '--- 全部标签页日志（跨窗口合并，共 ' + shared.length + ' 条；页面重载后仍保留）---',
            ].join('\n');
            const text = env + '\n' + (shared.length ? shared.map(fmtLog).join('\n') : '（暂无日志）')
                + '\n\n--- 本页日志 ---\n' + (logBuffer.length ? logBuffer.join('\n') : '（暂无日志）')
                + '\n\n--- 全部标签页网络请求（跨窗口合并，共 ' + sharedNet.length + ' 条；页面重载后仍保留）---\n'
                + (sharedNet.length ? sharedNet.map(x => x.m).join('\n') : '（暂无网络记录）')
                + '\n\n--- 本页网络请求（最近 ' + NET_MAX + ' 条关键接口）---\n'
                + (netLog.length ? netLog.join('\n') : '（暂无网络记录）');
            saveTextFile('gxnufl-log', text, '日志已导出（浏览器下载 txt）');
        } catch (e) {
            setStatus('日志导出失败：' + e.message, 'warn');
        }
    }

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
    let lastZhsSyncAt = 0;       // 上次同步智慧树完成状态的时间

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
        // 起点：优先视频当前进度；没有则用该资源在服务端的已学时长（避免刷新后进度条从 0 开始）
        let startAt = Number(video.currentTime) || 0;
        if (!startAt && zhsStat && zhsStat.map) {
            const it = zhsStat.map[zhsCurrentFileId()];
            if (it) startAt = Math.min(it.t, Number(it.s) || 0);
        }
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
        ['duration', 'currentTime', 'paused', 'ended', 'readyState', 'networkState',
         'buffered', 'seekable', 'played', 'videoWidth', 'videoHeight'].forEach(k => {
            origMembers[k] = Object.getOwnPropertyDescriptor(video, k) || null;
        });
        origMembers.play = video.play;
        origMembers.pause = video.pause;

        // 劫持关键属性
        virtualTime = startAt;
        try {
            Object.defineProperty(video, 'duration', { configurable: true, get: () => realDuration });
            Object.defineProperty(video, 'currentTime', {
                configurable: true,
                get: () => virtualTime,
                set: (v) => { virtualTime = Math.max(0, Math.min(Number(v) || 0, realDuration)); },
            });
            Object.defineProperty(video, 'paused', { configurable: true, get: () => !virtualPlaying });
            Object.defineProperty(video, 'ended', { configurable: true, get: () => virtualTime >= realDuration - 0.05 });
            // 伪装"正常播放中"的媒体状态：页面的进度上报会检查这些
            Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 });      // HAVE_ENOUGH_DATA
            Object.defineProperty(video, 'networkState', { configurable: true, get: () => 1 });    // NETWORK_IDLE
            Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => 1280 });
            Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => 720 });
            Object.defineProperty(video, 'buffered', {
                configurable: true,
                get: () => ({ length: 1, start: () => 0, end: () => realDuration }),
            });
            Object.defineProperty(video, 'seekable', {
                configurable: true,
                get: () => ({ length: 1, start: () => 0, end: () => realDuration }),
            });
            Object.defineProperty(video, 'played', {
                configurable: true,
                get: () => ({ length: 1, start: () => 0, end: () => virtualTime }),
            });
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
            // 智慧树按"真实观看时长"记进度，倍速无效 → 虚拟播放强制 1x，保证时长与视频等长
            const rate = IS_ZHS ? 1 : (Number(video.playbackRate) || 1);
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
        ['duration', 'currentTime', 'paused', 'ended', 'readyState', 'networkState',
         'buffered', 'seekable', 'played', 'videoWidth', 'videoHeight'].forEach(k => {
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

    // 省流量模式自检：每 3 分钟核对服务端学习时长，若没增长说明页面不上报 → 自动回退真实播放
    let saveSelfCheckAt = 0;
    let saveSelfLastStudy = -1;
    function selfCheckSaveMode() {
        if (!IS_ZHS || !saveModeActive) return;
        if (Date.now() - saveSelfCheckAt < 3 * 60 * 1000) return;
        saveSelfCheckAt = Date.now();
        const fid = zhsCurrentFileId();
        const cid = zhsCourseId();
        if (!fid || !cid || !jq || !jq.ajax) return;
        jq.ajax({
            url: '//studyResources.zhihuishu.com/studyResources/stuResouce/queryResourceMenuTree',
            data: { courseId: cid },
            dataType: 'jsonp',
            timeout: 8000,
            success: (res) => {
                const list = (res && (res.rt || res.data)) || [];
                if (!Array.isArray(list)) return;
                const stat = computeZhsStat(list);
                const it = stat.map[fid];
                if (!it) return;
                if (saveSelfLastStudy >= 0 && it.s <= saveSelfLastStudy) {
                    log('省流量模式自检：3 分钟内学习时长未增长 → 自动回退真实播放');
                    setStatus('省流量模式未上报进度，已自动关闭', 'warn');
                    state.SAVE_DATA = false;
                    saveState();
                    const v = getVideo();
                    if (v) disableSaveData(v);
                }
                saveSelfLastStudy = it.s;
            },
        });
    }

    // ===================== 智慧树网适配（资料学习页） =====================
    // 页面结构：#sourceTree 下的 .file-item（id="file_<fileId>"，点击调 changeFile(id)）
    //          完成状态：.status-box > i.icon-finish
    //          播放器：video#vjs_mediaPlayer_html5_api（video.js）
    //
    // 状态同步说明：主窗口资源树是静态的，多开窗口播完不会自动刷新。
    // 因此用 localStorage 记录「已分配给多开窗口」（2 小时过期）与「多开已播完」，
    // 避免二次点击时把同一个视频再分配一遍。
    const ZHS_ASSIGN_KEY = 'gxnufl_zhs_assigned';
    const ZHS_DONE_KEY = 'gxnufl_zhs_done_local';

    function readJsonMap(key) {
        try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; }
    }
    function writeJsonMap(key, m) {
        try { localStorage.setItem(key, JSON.stringify(m)); } catch (e) {}
    }
    function zhsMarkAssigned(id) {
        if (!id) return;
        const m = readJsonMap(ZHS_ASSIGN_KEY);
        let dur = 0;
        if (zhsStat && zhsStat.map && zhsStat.map[id]) dur = Number(zhsStat.map[id].t) || 0;
        m[id] = { at: Date.now(), dur: dur };
        writeJsonMap(ZHS_ASSIGN_KEY, m);
    }
    function zhsMarkDoneLocal(id) {
        if (!id) return;
        const m = readJsonMap(ZHS_DONE_KEY);
        m[id] = Date.now();
        writeJsonMap(ZHS_DONE_KEY, m);
    }
    function zhsAssignedInfo(id) {
        const v = readJsonMap(ZHS_ASSIGN_KEY)[id];
        if (!v) return null;
        if (typeof v === 'number') return { at: v, dur: 0 };   // 兼容旧格式
        return { at: Number(v.at) || 0, dur: Number(v.dur) || 0 };
    }
    // "资源已被占用"判定：①别的活跃窗口正在播它 ②刚分配给新窗口（3 分钟内）
    // 不再用"视频时长 + 10 分钟"的长有效期（那会把视频锁死几十分钟 → 表现为"总是被跳过"）
    function zhsIsRecentlyAssigned(id) {
        if (!id) return false;
        if (zhsIsPlayingElsewhere(id)) return true;
        const info = zhsAssignedInfo(id);
        if (!info || !info.at) return false;
        return (Date.now() - info.at) < 3 * 60 * 1000;
    }
    function zhsIsDoneLocal(id) {
        // 【已废弃】本地"完成"标记不可靠（虚拟播放会在未上报时也触发 ended → 误标完成）。
        // 现在统一以服务端 studyTime >= totalTime 为准，不再使用本地记录。
        return false;
    }
    // 该资源是否"还值得播"：DOM 未完成 + 本地未完成 + 非近期已分配
    function zhsIsUsable(el) {
        const id = (el.id || '').replace('file_', '');
        if (!id) return false;
        if (zhsIsDone(el)) return false;
        if (zhsIsDoneLocal(id)) return false;
        if (zhsIsRecentlyAssigned(id)) return false;
        return true;
    }
    // 清理旧版本留下的错误状态：误标的"本地完成" + 长期占用的"分配记录"
    function clearFalseLocalDone() {
        // 旧版"分配记录"有效期长达数十分钟，会把视频锁死 → 直接清空
        try { localStorage.removeItem(ZHS_ASSIGN_KEY); } catch (e) {}
        let m = {};
        try { m = JSON.parse(localStorage.getItem(ZHS_DONE_KEY) || '{}'); } catch (e) { return; }
        const ids = Object.keys(m);
        if (!ids.length) return;
        ids.forEach(id => {
            const el = document.querySelector('#sourceTree .file-item#file_' + id);
            if (!el) return;
            const box = el.querySelector('.status-box');
            if (box) box.innerHTML = '';   // 清掉脚本打上的 ✓（刷新页面会恢复服务端真实状态）
        });
        try { localStorage.removeItem(ZHS_DONE_KEY); } catch (e) {}
        log('已清理 ' + ids.length + ' 个本地误标完成记录（刷新页面显示服务端真实状态）');
    }

    // 秒数 → 时钟格式（mm:ss / h:mm:ss）
    function fmtClock(sec) {
        sec = Math.max(0, Math.round(sec));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const mm = (h > 0 && m < 10 ? '0' : '') + m;
        const ss = (s < 10 ? '0' : '') + s;
        return (h > 0 ? h + ':' : '') + mm + ':' + ss;
    }

    // 给资源列表每一项后面追加视频时长
    // 20 号包资料树：.file-item 带 id="file_<fileId>" → 精确匹配
    // 21 号包学习资源页：Vue 组件无 id → 按文件名匹配（去扩展名）
    function zhsDecorateDurations() {
        if (!zhsStat || !zhsStat.map) return;
        const byName = {};
        Object.keys(zhsStat.map).forEach(id => {
            const it = zhsStat.map[id];
            if (it.name && !byName[it.name]) byName[it.name] = it;
        });
        const items = document.querySelectorAll('.file-item');
        items.forEach(el => {
            if (el.querySelector('.gx-dur')) return;   // 已加过
            const nameEl = el.querySelector('.file-name');
            if (!nameEl) return;
            const id = (el.id || '').replace('file_', '');
            let info = id ? zhsStat.map[id] : null;
            if (!info) {
                const raw = (nameEl.textContent || '').trim();
                const noExt = raw.replace(/\.[a-zA-Z0-9]{2,5}$/, '').trim();
                info = byName[noExt] || byName[raw];
            }
            if (!info || !info.t) return;
            const span = document.createElement('span');
            span.className = 'gx-dur';
            span.textContent = fmtClock(info.t);
            span.title = '视频时长 ' + fmtDuration(info.t);
            nameEl.parentElement.insertBefore(span, nameEl.nextSibling);
        });
    }

    // ===================== 智慧树：右侧资源栏可拖拽调宽 =====================
    const ZHS_SIDEBAR_KEY = 'gxnufl_zhs_sidebar_w';
    const SIDEBAR_MIN = 240;
    let currentSidebarW = 0;   // 用户设定的侧栏宽度（供收起态恢复用）

    function applySidebarWidth(w, persist) {
        const right = document.querySelector('.right');
        if (!right) return;
        const max = Math.max(SIDEBAR_MIN + 60, Math.min(760, window.innerWidth - 480));
        w = Math.max(SIDEBAR_MIN, Math.min(Math.round(w), max));
        // 用 CSS 变量驱动（不写内联样式 → 页面自己的收起/全屏逻辑仍能覆盖）
        currentSidebarW = w;
        document.documentElement.style.setProperty('--gx-sidebar-w', w + 'px');
        const h = document.getElementById('gxnufl-sidebar-handle');
        if (h) h.style.right = w + 'px';
        if (persist !== false) {
            try { localStorage.setItem(ZHS_SIDEBAR_KEY, String(w)); } catch (e) {}
        }
    }

    // 清理上一版留下的内联宽度（会把页面收起/全屏的样式顶掉）
    function clearLegacyInlineWidths() {
        const right = document.querySelector('.right');
        const left = document.querySelector('.left');
        if (right) right.style.width = '';
        if (left) left.style.right = '';
        document.querySelectorAll('.file-item, .folder-item .folder-box').forEach(el => { el.style.width = ''; });
        const fb = document.querySelector('.right .fold-btn');
        if (fb) fb.style.right = '';
    }

    function initSidebarResizer() {
        if (!IS_ZHS) return;
        const right = document.querySelector('.right');
        if (!right || document.getElementById('gxnufl-sidebar-handle')) return;

        clearLegacyInlineWidths();

        const h = document.createElement('div');
        h.id = 'gxnufl-sidebar-handle';
        h.title = '拖动调整资源栏宽度';
        document.body.appendChild(h);

        let dragging = false, startX = 0, startW = 0;
        h.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            dragging = true;
            startX = e.clientX;
            startW = right.getBoundingClientRect().width;
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp, { once: true });
            e.preventDefault();
        });
        function onMove(e) {
            if (!dragging) return;
            const dx = startX - e.clientX;   // 往左拖 → 变宽
            applySidebarWidth(startW + dx);
        }
        function onUp() {
            dragging = false;
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMove);
        }

        // 侧栏宽度变化（页面收起/展开、窗口缩放）→ 同步手柄位置；收起（过窄）时隐藏手柄
        const sync = () => {
            const w = right.getBoundingClientRect().width;
            h.style.right = w + 'px';
            h.style.display = w > 80 ? 'block' : 'none';
        };
        if (window.ResizeObserver) new ResizeObserver(sync).observe(right);
        window.addEventListener('resize', sync);

        // 播放器全屏时隐藏手柄（侧栏是否收起交给页面自身逻辑处理）
        document.addEventListener('fullscreenchange', () => {
            h.style.display = document.fullscreenElement ? 'none' : 'block';
        });

        // 恢复上次宽度（无记录则保持页面原宽）
        let saved = 0;
        try { saved = parseInt(localStorage.getItem(ZHS_SIDEBAR_KEY) || '0', 10); } catch (e) {}
        const nativeW = right.getBoundingClientRect().width || 304;

        // 页面收起/展开侧栏靠改 .right 的 right 偏移（按原生 304px 计算）。
        // 我们把侧栏加宽后，只偏移 304px 会露出一截 → 跟随页面的偏移量同步宽度，保证完全移出屏幕。
        const mo = new MutationObserver(() => {
            const off = parseFloat(right.style.right || '');
            if (!isNaN(off) && off < 0) {
                document.documentElement.style.setProperty('--gx-sidebar-w', Math.abs(off) + 'px');
            } else {
                const restore = currentSidebarW || nativeW;
                document.documentElement.style.setProperty('--gx-sidebar-w', restore + 'px');
            }
        });
        mo.observe(right, { attributes: true, attributeFilter: ['style'] });

        applySidebarWidth(saved || nativeW, false);
        sync();
    }

    // ===================== 智慧树资源统计（总时长 / 已完成 / 剩余） =====================
    let zhsStat = null;    // { total, done, count, doneCount, map, fetchedAt }
    let elZhsStat = null;

    // 统计缓存（跨窗口共享）：让所有多开窗口用同一份"完成状态"，避免算出同一个下一个
    const ZHS_STAT_KEY = 'gxnufl_zhs_stat';

    let lastStatWriteAt = 0;
    function saveZhsStat() {
        try {
            if (!zhsStat) return;
            // 多窗口同步节流：SYNC_SEC 内不重复写共享缓存，避免互相触发 storage 风暴
            if (Date.now() - lastStatWriteAt < (Number(state.SYNC_SEC) || 5) * 1000) return;
            lastStatWriteAt = Date.now();
            localStorage.setItem(ZHS_STAT_KEY, JSON.stringify({
                total: zhsStat.total, done: zhsStat.done, count: zhsStat.count,
                doneCount: zhsStat.doneCount, map: zhsStat.map, fetchedAt: zhsStat.fetchedAt
            }));
        } catch (e) {}
    }

    function loadZhsStatCache() {
        try {
            const raw = localStorage.getItem(ZHS_STAT_KEY);
            if (!raw) return null;
            const o = JSON.parse(raw);
            if (!o || !o.map) return null;
            if (Date.now() - (Number(o.fetchedAt) || 0) > 10 * 60 * 1000) return null;   // 超过 10 分钟不采用
            return o;
        } catch (e) { return null; }
    }

    function fmtDuration(sec) {
        sec = Math.max(0, Math.round(sec));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        if (h > 0) return h + '小时' + (m > 0 ? m + '分' : '');
        if (m > 0) return m + '分' + (sec % 60 > 0 ? (sec % 60) + '秒' : '');
        return sec + '秒';
    }

    // 智慧树：学习时长达到视频时长的 80% 即算"已完成"（平台口径）
    const ZHS_DONE_RATIO = 0.8;
    function zhsNeedSec(t) { return Math.ceil((Number(t) || 0) * ZHS_DONE_RATIO); }
    function zhsIsDoneSec(s, t) {
        const tt = Number(t) || 0;
        return tt > 0 && (Number(s) || 0) >= zhsNeedSec(tt);
    }

    // 递归统计资源树：总时长、已完成（studyTime >= totalTime * 80%）
    function computeZhsStat(list) {
        let total = 0, done = 0, count = 0, doneCount = 0;
        const map = {};
        (function walk(nodes) {
            (nodes || []).forEach(n => {
                if (n.type === 1 && n.totalTime) {
                    const t = Number(n.totalTime) || 0;
                    const s = Number(n.studyTime) || 0;
                    total += t;
                    count++;
                    const isDone = zhsIsDoneSec(s, t);
                    if (isDone) { done += zhsNeedSec(t); doneCount++; }
                    map[String(n.id)] = { t: t, s: s, done: isDone, name: String(n.name || '').trim() };
                }
                if (n.childList) walk(n.childList);
            });
        })(list);
        return { total: total, done: done, count: count, doneCount: doneCount, map: map, fetchedAt: Date.now() };
    }

    function fetchZhsStats() {
        if (!IS_ZHS) return;
        lastStatRefreshAt = Date.now();
        const cid = zhsCourseId();
        if (!cid) return;
        const base = '//studyResources.zhihuishu.com/studyResources/stuResouce/';
        // 资料学习页用 queryResourceMenuTree；学习资源页（新版）用 queryResourceTree
        const urls = [base + 'queryResourceMenuTree', base + 'queryResourceTree'];
        let i = 0;

        const takeList = (res) => {
            let v = res && (res.rt !== undefined ? res.rt : res.data);
            if (v && !Array.isArray(v)) v = v.tree || v.list || v.childList || v.resourceTree;
            return Array.isArray(v) ? v : null;
        };

        const handle = (res) => {
            const list = takeList(res);
            if (!list) return false;
            zhsStat = computeZhsStat(list);
            saveZhsStat();          // 写入共享缓存，供其他多开窗口同步
            renderZhsStat();
            zhsDecorateDurations();
            log('资源统计：', zhsStat.total, '秒 /', zhsStat.count, '个 / 已完成', zhsStat.doneCount);
            return true;
        };

        const tryOne = () => {
            if (i >= urls.length) { log('资源统计：接口均未取到数据'); return; }
            const url = urls[i++];
            // 1) 页面自带 server 对象（资料页可用）
            if (window.server && typeof window.server.get === 'function') {
                try {
                    window.server.get(url, { courseId: cid }, (res) => { if (!handle(res)) tryOne(); });
                    // 兜底：8 秒后仍无数据则试下一个接口
                    setTimeout(() => { if (!zhsStat) tryOne(); }, 8000);
                    return;
                } catch (e) {}
            }
            // 2) jQuery JSONP（带超时，失败自动换下一个接口）
            if (jq && jq.ajax) {
                jq.ajax({
                    url: url,
                    data: { courseId: cid },
                    dataType: 'jsonp',
                    timeout: 6000,
                    success: (res) => { if (!handle(res)) tryOne(); },
                    error: () => tryOne(),
                });
                return;
            }
            tryOne();
        };
        tryOne();
    }

    function renderZhsStat() {
        if (!elZhsStat) return;
        if (!zhsStat) {
            elZhsStat.textContent = '资源统计：加载中…';
            return;
        }
        const total = zhsStat.total;
        const count = zhsStat.count, doneCount = zhsStat.doneCount;
        // 剩余时长按 80% 完成口径累加：未完成视频只需补到 80%
        let remain = 0;
        Object.keys(zhsStat.map).forEach(id => {
            const it = zhsStat.map[id];
            if (it && it.t && !it.done) remain += Math.max(0, zhsNeedSec(it.t) - (Number(it.s) || 0));
        });
        // 下一个待播视频（方便核对切换逻辑）
        let nextTxt = '全部完成';
        try {
            const pend = zhsPendingIds();
            if (pend.length) {
                const it = zhsStat.map[pend[0].id];
                const nm = (it && it.name) ? it.name : ('#' + pend[0].id);
                const remainSec = it && it.t ? Math.max(0, zhsNeedSec(it.t) - (Number(it.s) || 0)) : 0;
                nextTxt = (nm.length > 14 ? nm.slice(0, 14) + '…' : nm) + '（还差 ' + fmtDuration(remainSec) + '）';
            }
        } catch (e) {}
        elZhsStat.innerHTML =
            '<div>资源总时长 <b>' + fmtDuration(total) + '</b>（' + count + ' 个视频）</div>' +
            '<div>已完成 <b>' + doneCount + '</b> / ' + count + ' 个（看满 80% 即完成）</div>' +
            '<div>剩余时长 ' + fmtDuration(remain) + ' · 下一个：' + nextTxt + '</div>';
    }

    // 当前视频在服务端已完成（或侧边栏已显示 ✓）→ 自动切到下一个未完成资源
    // 只依据"服务器实时返回的当前视频学习时长"判断是否完成，不依赖本地缓存/DOM ✓
    // 每次判定都实时请求服务器资源树，用返回的 studyTime >= totalTime×80% 判定；
    // 判定完成与选下一个，全部使用同一份服务器数据（serverStat），不读 zhsStat 缓存
    const ZHSSWITCH_KEY = 'gxnufl_last_switch_at';
    let lastDoneQueryAt = 0;
    let doneQueryPending = false;

    function zhsDoSwitch(why, serverStat) {
        const pend = zhsPendingIds(serverStat);   // 用服务器数据选下一个
        if (!pend.length) return;
        try { sessionStorage.setItem(ZHSSWITCH_KEY, String(Date.now())); } catch (e) {}
        log('当前视频已完成（' + why + '），自动切换到下一个:', pend[0].id);
        zhsMarkAssigned(pend[0].id);
        zhsSwitchById(pend[0].id);
    }

    function zhsSkipIfDone() {
        if (!IS_ZHS) return;
        // 刚切换过来 N 秒内不判定（等页面/播放/URL 稳定，避免连锁跳）
        let lastSw = 0;
        try { lastSw = Number(sessionStorage.getItem(ZHSSWITCH_KEY)) || 0; } catch (e) {}
        if (Date.now() - lastSw < 6000) return;
        if (doneQueryPending || Date.now() - lastDoneQueryAt < 8000) return;

        const fid = zhsCurrentFileId();
        const cid = zhsCourseId();
        if (!fid || !cid || !jq || !jq.ajax) return;

        doneQueryPending = true;
        lastDoneQueryAt = Date.now();
        jq.ajax({
            url: '//studyResources.zhihuishu.com/studyResources/stuResouce/queryResourceMenuTree',
            data: { courseId: cid },
            dataType: 'jsonp',
            timeout: 8000,
            success: (res) => {
                doneQueryPending = false;
                const list = (res && (res.rt || res.data)) || [];
                if (!Array.isArray(list)) return;
                const serverStat = computeZhsStat(list);   // 服务器实时数据
                const it = serverStat.map[fid];
                if (it && it.t && zhsIsDoneSec(it.s, it.t)) {
                    zhsDoSwitch('服务器 studyTime=' + it.s + '/' + zhsNeedSec(it.t) + '(80%)', serverStat);
                }
            },
            error: () => { doneQueryPending = false; },
        });
    }
    // 统计定时刷新（每 60 秒，仅供面板显示/排序用；不参与"完成"判定）
    let lastStatRefreshAt = 0;
    function zhsRefreshStatsIfStale() {
        if (!IS_ZHS || !zhsStat) return;
        if (Date.now() - lastStatRefreshAt < 60 * 1000) return;
        lastStatRefreshAt = Date.now();
        fetchZhsStats();
    }

    // 多开窗口：把右侧资源树自动滚动到"当前播放的视频"位置（并展开所在文件夹）
    function zhsScrollToCurrent() {
        if (!IS_ZHS) return false;
        const fid = zhsCurrentFileId();
        if (!fid) return false;
        let el = document.getElementById('file_' + fid);
        if (!el) return false;

        // 先展开所有折叠的祖先文件夹（折叠状态下子项不可见，无法滚动）
        let node = el.parentElement;
        let guard = 0;
        while (node && guard++ < 12) {
            if (node.classList && node.classList.contains('folder-item')) {
                const id = (node.id || '').replace('folder_', '');
                const box = node.querySelector(':scope > .folder-box');
                const child = node.querySelector(':scope > .folder-child');
                const collapsed = child && getComputedStyle(child).display === 'none';
                if (collapsed && id) {
                    if (typeof window.stretchFolder === 'function') {
                        try { window.stretchFolder(id); } catch (e) {}
                    } else if (box) {
                        clickEl(box);
                    }
                }
            }
            node = node.parentElement;
        }

        // 展开后需要一点时间布局，再滚动
        setTimeout(() => {
            try {
                const cur = document.getElementById('file_' + fid);
                if (!cur) return;
                if (jq && jq.fn && jq.fn.nanoScroller) {
                    jq('.source-list.nano').nanoScroller({ scrollTo: jq(cur) });
                    return;
                }
                cur.scrollIntoView({ block: 'center' });
            } catch (e) {}
        }, 350);
        return true;
    }

    // 轮询等待列表渲染完成后再滚动（最多等 12 秒）
    function zhsScrollToCurrentWhenReady() {
        if (!IS_ZHS) return;
        const deadline = Date.now() + 12000;
        const tickWait = () => {
            const fid = zhsCurrentFileId();
            if (fid && document.getElementById('file_' + fid)) {
                zhsScrollToCurrent();
                return;
            }
            if (Date.now() < deadline) setTimeout(tickWait, 500);
        };
        tickWait();
    }

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

    // 找下一个资源：优先"当前之后第一个可用"，其次从头补漏
    function zhsNextFile() {
        const items = zhsFileItems();
        if (!items.length) return null;
        const curId = zhsCurrentFileId();
        let curIdx = items.findIndex(el => (el.id || '').replace('file_', '') === curId);
        if (curIdx < 0) curIdx = -1;
        for (let i = curIdx + 1; i < items.length; i++) {
            if (zhsIsUsable(items[i])) return items[i];
        }
        for (let i = 0; i <= curIdx && i >= 0; i++) {
            if (zhsIsUsable(items[i])) return items[i];
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

    // 按 fileId 直接切换（不需要 DOM 元素，折叠章节里的视频也能切）
    function zhsSwitchById(id) {
        if (!id) return false;
        if (typeof window.changeFile === 'function') {
            window.changeFile(String(id));
            return true;
        }
        const el = document.getElementById('file_' + id);
        if (el) return clickEl(el);
        return false;
    }

    // 当前页面的 courseId
    function zhsCourseId() {
        const m = location.search.match(/[?&]courseId=(\d+)/);
        return m ? m[1] : '';
    }

    // 【优先】从服务端资源树数据里选可播视频：不依赖 DOM，折叠章节里的视频也能选到
    // statOverride：切换链路传入"服务器实时数据"，避免依赖本地缓存判断完成
    function zhsPendingIds(statOverride) {
        const stat = statOverride || zhsStat;
        if (!stat || !stat.map) return [];
        const curId = zhsCurrentFileId();
        const list = [];
        Object.keys(stat.map).forEach(id => {
            const it = stat.map[id];
            if (!it || !it.t) return;
            if (id === curId) return;
            if (it.done) return;                    // 该数据里显示已完成
            if (zhsIsDoneLocal(id)) return;         // 本地已记录完成
            if (zhsIsRecentlyAssigned(id)) return;  // 近期已分配给其他窗口
            list.push({ id: id, s: Number(it.s) || 0, t: it.t });
        });
        // 平台按"完成个数"计进度，且看满 80% 即完成 → 优先做最快达到 80% 的
        list.sort((a, b) => (zhsNeedSec(a.t) - a.s) - (zhsNeedSec(b.t) - b.s));
        return list;
    }

    // DOM 回退：接口数据不可用时按页面上的资源项选
    function zhsPendingFiles() {
        const curId = zhsCurrentFileId();
        const list = zhsFileItems().filter(el => {
            const id = (el.id || '').replace('file_', '');
            return id && id !== curId && zhsIsUsable(el);
        });
        if (zhsStat && zhsStat.map) {
            const getS = el => {
                const it = zhsStat.map[(el.id || '').replace('file_', '')];
                return it ? (Number(it.s) || 0) : 0;
            };
            // 同上：按到 80% 还差多少升序（DOM 回退时用 studyTime 估算）
            list.sort((a, b) => {
                const ia = zhsStat && zhsStat.map ? zhsStat.map[(a.id || '').replace('file_', '')] : null;
                const ib = zhsStat && zhsStat.map ? zhsStat.map[(b.id || '').replace('file_', '')] : null;
                const ta = ia && ia.t ? ia.t : (Number(a.dataset.t) || 0);
                const tb = ib && ib.t ? ib.t : (Number(b.dataset.t) || 0);
                const sa = ia ? (Number(ia.s) || 0) : getS(a);
                const sb = ib ? (Number(ib.s) || 0) : getS(b);
                return (zhsNeedSec(ta) - sa) - (zhsNeedSec(tb) - sb);
            });
        }
        return list;
    }

    // 是否"多开"窗口（URL 带 gxParallel=1）——播完会继续切下一个资源
    function zhsIsParallelWindow() {
        return /[?&]gxParallel=1/.test(location.search);
    }

    // 本窗口标识 + 心跳（统计"当前有几个多开窗口在跑"）
    const ZHS_WINS_KEY = 'gxnufl_zhs_wins';
    const ZHS_WIN_TTL = 90000;   // 心跳有效期 90 秒（窗口关掉后自动从计数里消失）
    // 用 sessionStorage 保存窗口 ID：同一标签页刷新/切换视频后 ID 不变，避免重复计数
    const WIN_ID = (() => {
        try {
            let id = sessionStorage.getItem('gxnufl_win_id');
            if (!id) {
                id = Math.random().toString(36).slice(2, 8);
                sessionStorage.setItem('gxnufl_win_id', id);
            }
            return id;
        } catch (e) {
            return Math.random().toString(36).slice(2, 8);
        }
    })();

    function zhsWinHeartbeat() {
        if (!IS_ZHS) return;
        try {
            const m = readJsonMap(ZHS_WINS_KEY);
            const now = Date.now();
            const main = !zhsIsParallelWindow();
            // 心跳里带上"当前正在播的 fileId"：主窗口也写（带 main 标记），
            // 这样多开窗口选片时能避开主窗口正在播的视频，不会撞车
            m[WIN_ID] = { at: now, fid: zhsCurrentFileId() || '', main: main };
            // 清掉 90 秒没有心跳的（窗口已关闭）
            Object.keys(m).forEach(k => {
                const v = m[k];
                const at = v && typeof v === 'object' ? Number(v.at) || 0 : Number(v) || 0;
                if (now - at > ZHS_WIN_TTL) delete m[k];
            });
            writeJsonMap(ZHS_WINS_KEY, m);
        } catch (e) {}
    }

    // 是否有其他活跃窗口正在播放该资源（心跳里 fid 匹配；含主窗口，避免撞车）
    function zhsIsPlayingElsewhere(id) {
        if (!id) return false;
        const m = readJsonMap(ZHS_WINS_KEY);
        const now = Date.now();
        return Object.keys(m).some(k => {
            if (k === WIN_ID) return false;   // 自己不算
            const v = m[k];
            if (!v || typeof v !== 'object') return false;
            if (now - (Number(v.at) || 0) > ZHS_WIN_TTL) return false;
            return String(v.fid) === String(id);
        });
    }

    // 当前活跃的多开窗口数（最近 3 分钟内还有心跳的）
    function zhsActiveWindows() {
        const m = readJsonMap(ZHS_WINS_KEY);
        const now = Date.now();
        let n = 0;
        Object.keys(m).forEach(k => {
            const v = m[k];
            const at = v && typeof v === 'object' ? Number(v.at) || 0 : Number(v) || 0;
            if (now - at > ZHS_WIN_TTL) { delete m[k]; return; }
            // 主窗口也写心跳（用于防撞车），但不算进"多开窗口数"
            if (v && typeof v === 'object' && v.main) return;
            n++;
        });
        try { writeJsonMap(ZHS_WINS_KEY, m); } catch (e) {}
        return n;
    }

    // 「多开窗口」每次打开的数量（1 个；需要更多就重复点击）
    const MULTI_COUNT = 1;
    const MULTI_COOLDOWN = 3000;    // 连点冷却 3 秒
    let lastMultiClickAt = 0;

    // 打开多开窗口：每个播一个未完成资源（优先未看完的），播完自动关闭
    function openParallelWindows() {
        // 冷却：防止快速连点导致多个窗口选到同一个视频
        if (Date.now() - lastMultiClickAt < MULTI_COOLDOWN) {
            const wait = Math.ceil((MULTI_COOLDOWN - (Date.now() - lastMultiClickAt)) / 1000);
            setStatus('操作太快，请 ' + wait + ' 秒后再点', 'warn');
            return;
        }
        lastMultiClickAt = Date.now();
        const cid = zhsCourseId();
        if (!cid) { setStatus('未取到 courseId，无法多开', 'warn'); return; }
        // 优先用服务端数据（覆盖折叠章节），接口不可用时回退 DOM
        let pend = zhsPendingIds().map(x => x.id);
        if (!pend.length) {
            pend = zhsPendingFiles().map(el => (el.id || '').replace('file_', ''));
        }
        if (!pend.length) { setStatus('没有待学习的资源了', 'ok'); return; }
        const total = Math.min(MULTI_COUNT, pend.length);
        const base = location.origin + location.pathname;
        const feat = state.MULTI_WIN ? 'popup=1,width=1100,height=700' : undefined;
        let opened = 0;
        for (let i = 0; i < total; i++) {
            const id = pend[i];
            const url = base + '?courseId=' + cid + '&fileId=' + id + '&gxParallel=1';
            try {
                const w = feat ? window.open(url, 'gxmulti_' + id, feat) : window.open(url, '_blank');
                if (w) {
                    opened++;
                    zhsMarkAssigned(id);   // 记录已分配，防止二次点击重复开同一批
                    if (!state.MULTI_WIN) {
                        // 标签页模式：立刻让新标签页失焦（尽量不抢当前页）
                        try { w.blur(); } catch (e) {}
                    }
                }
            } catch (e) {}
        }
        if (opened) {
            // 标签页模式：密集地把焦点切回当前页（等效鼠标中键后台打开）
            if (!state.MULTI_WIN) {
                [0, 30, 80, 150, 300, 600, 1000].forEach(t => {
                    setTimeout(() => { try { window.focus(); } catch (e) {} }, t);
                });
            }
            setStatus('已打开 ' + opened + ' 个' + (state.MULTI_WIN ? '独立窗口' : '后台标签页') + '（播完自动关闭）', 'ok');
            log('多开：', opened, '个');
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
            // 优先用服务端数据选（可覆盖折叠章节里的视频）；接口不可用时回退 DOM
            const pend = zhsPendingIds();
            if (pend.length) {
                const id = pend[0].id;
                log('本资源播完 → 切换下一个未完成资源:', id);
                zhsMarkAssigned(id);   // 先占位，避免多个窗口抢同一个
                zhsSwitchById(id);
                return;
            }
            const nf = zhsNextFile();
            if (nf) {
                log('本资源播完 → 切换下一个未完成资源（DOM）');
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
        const donePct = IS_ZHS ? 80 : 99;   // 智慧树看满 80% 即算完成
        if (pct >= donePct) { doJumpNext(); return; }

        const msg = pct >= 0
            ? '本节视频还没看完（已看 ' + pct + '%，需 ' + donePct + '%），跳过将不计入视频成绩。确定要跳吗？'
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

    // ===================== 后台保活（防浏览器休眠标签页） =====================
    // Edge/Chrome 会休眠不活跃标签页（JS 定时器全部暂停）→ 多开的刷课窗口进度会中断。
    // 通过持续输出极低音量的超声波，让页面保持"有声音"的活跃状态，从而不被判定为可休眠。
    let keepAliveCtx = null;
    function startKeepAlive() {
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return false;
            if (keepAliveCtx) {
                if (keepAliveCtx.state === 'suspended') keepAliveCtx.resume().catch(() => {});
                return true;
            }
            if (!document.body) return false;
            keepAliveCtx = new AC();
            const osc = keepAliveCtx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = 18000;   // 18kHz 超声波，人耳基本听不到
            const gain = keepAliveCtx.createGain();
            gain.gain.value = 0.005;       // 极低音量（非零，浏览器才判为"有声"）
            osc.connect(gain);
            gain.connect(keepAliveCtx.destination);
            osc.start();
            log('后台保活已启动（防标签页休眠）');
            return true;
        } catch (e) { keepAliveCtx = null; return false; }
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
                // 先看服务端完成度：只差一点就补播最后 30 秒（把学习时长补满），避免整段重刷
                const it = (zhsStat && zhsStat.map) ? zhsStat.map[zhsCurrentFileId()] : null;
                // 优先用上报响应里的 rt（服务端累计时长，最准）
                let serverSec = it ? (Number(it.s) || 0) : 0;
                const rp0 = window.__gxRt;
                if (rp0 && rp0.fileId === zhsCurrentFileId() && (Date.now() - rp0.at) < 120000) {
                    serverSec = rp0.rt;
                }
                const needSec = it && it.t ? zhsNeedSec(it.t) : 0;
                const bufCnt = Number(v.dataset.gxBuf || 0);
                if (needSec && serverSec < needSec && (needSec - serverSec) <= 60 && bufCnt < 3) {
                    v.dataset.gxBuf = String(bufCnt + 1);
                    log('距 80% 完成还差 ' + (needSec - serverSec) + ' 秒，补播最后 30 秒补足（第 ' + (bufCnt + 1) + ' 次）');
                    try {
                        v.currentTime = Math.max(0, (v.duration || 0) - 30);
                        v.play();
                    } catch (e) {}
                    return;
                }
                // 多开窗口：不受「自动下一节」开关控制，总是继续下一个
                if (zhsIsParallelWindow()) {
                    log('多开窗口：本资源播完 → 自动切换下一个');
                    scheduleZhsNext();
                    return;
                }
                if (state.AUTO_NEXT) scheduleZhsNext();
                return;
            }
            if (state.AUTO_NEXT) scheduleNext();
        });
    }

    // ===================== 右下角设置面板 =====================
    let elPanel = null, elPill = null, elStatus = null, elPillDot = null, elParBtn = null;

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
#gxnufl-panel .gx-head { display: flex; justify-content: space-between; align-items: center; cursor: move; user-select: none; }
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
/* 资源栏宽度由 CSS 变量驱动（页面自己的内联样式仍可覆盖，保证收起/全屏正常） */
.right { width: var(--gx-sidebar-w, 304px); }
.left { right: var(--gx-sidebar-w, 304px); }
.file-item { width: var(--gx-sidebar-w, 304px); }
.folder-item .folder-box { width: var(--gx-sidebar-w, 304px); }
.right .fold-btn { right: calc(var(--gx-sidebar-w, 304px) - 17px); }
.file-item { position: relative; }
.file-item .gx-dur {
    position: absolute; right: 44px; top: 50%; transform: translateY(-50%);
    font-size: 11px; color: #b6bac3; font-family: Consolas, "Microsoft YaHei", monospace;
    white-space: nowrap; pointer-events: none; z-index: 2;
    background: rgba(44,45,61,0.92); padding: 1px 4px; border-radius: 3px;
}
/* 右侧资源栏可拖拽调宽手柄 */
#gxnufl-sidebar-handle {
    position: fixed; top: 0; bottom: 0; width: 7px;
    cursor: col-resize; z-index: 2147483646;
    background: transparent; transition: background 0.15s;
}
#gxnufl-sidebar-handle:hover { background: rgba(79,142,247,0.45); }
/* 学习资源页（Vue SPA）：标题完整显示 */
.gx-zhs-source .file-item { height: auto !important; min-height: 44px; padding: 8px 0; }
.gx-zhs-source .file-item .file-name {
    white-space: normal !important; overflow: visible !important; text-overflow: clip !important;
    height: auto !important; line-height: 1.5 !important; word-break: break-all;
}
.gx-zhs-source .file-item .gx-dur {
    position: static !important; float: right; margin: 2px 0 0 8px;
    transform: none !important; top: auto !important; right: auto !important;
}
#gxnufl-panel .gx-stat {
    margin: 0 0 8px; padding: 5px 8px; border-radius: 6px;
    background: rgba(79,142,247,0.12); color: #cfd3d6;
    font-size: 11px; line-height: 1.55;
}
#gxnufl-panel .gx-stat b { color: #9cc0ff; font-weight: 600; }
#gxnufl-panel .gx-log-row { display: flex; gap: 6px; margin-top: 6px; }
#gxnufl-panel .gx-log {
    width: 100%; margin-top: 6px; padding: 5px 0;
    background: rgba(255,255,255,0.06); color: #b8bcc4;
    border: 1px solid rgba(255,255,255,0.16); border-radius: 7px;
    cursor: pointer; font-size: 11.5px; font-family: inherit;
}
#gxnufl-panel .gx-log:hover { background: rgba(255,255,255,0.12); color: #e8eaed; }
#gxnufl-panel .gx-foot { margin-top: 7px; font-size: 10.5px; color: #8a8f98; text-align: center; }
#gxnufl-logdlg-overlay {
    position: fixed; inset: 0; z-index: 2147483646;
    background: rgba(0,0,0,0.62);
}
#gxnufl-logdlg, #gxnufl-logdlg * { box-sizing: border-box; font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; }
#gxnufl-logdlg {
    position: absolute;
    width: 440px; height: 520px; min-width: 330px; min-height: 280px;
    background: rgba(26,28,32,0.98); color: #e8eaed; font-size: 12px;
    border: 1px solid rgba(255,255,255,0.16); border-radius: 12px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.6);
    display: flex; flex-direction: column; overflow: hidden;
}
#gxnufl-logdlg .gxl-head {
    display: flex; justify-content: space-between; align-items: center;
    padding: 11px 14px; font-weight: 600; font-size: 13px;
    border-bottom: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04);
    cursor: move; user-select: none; flex: 0 0 auto;
}
#gxnufl-logdlg .gxl-close { cursor: pointer; color: #9aa0a6; font-size: 18px; line-height: 1; padding: 0 4px; }
#gxnufl-logdlg .gxl-close:hover { color: #fff; }
#gxnufl-logdlg .gxl-body { padding: 10px 14px; flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
#gxnufl-logdlg .gxl-body > * { flex: 0 0 auto; }
#gxnufl-logdlg .gxl-sec { color: #9cc0ff; font-weight: 600; font-size: 11.5px; margin: 6px 0 8px; }
#gxnufl-logdlg .gxl-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; }
#gxnufl-logdlg .gxl-row label { color: #d6d9dc; }
#gxnufl-logdlg .gxl-right { display: flex; align-items: center; gap: 5px; }
#gxnufl-logdlg .gxl-num {
    width: 72px; text-align: center; padding: 3px 4px;
    background: rgba(255,255,255,0.1); color: #e8eaed;
    border: 1px solid rgba(255,255,255,0.22); border-radius: 6px; font-size: 11.5px; outline: none;
}
#gxnufl-logdlg .gxl-num:focus { border-color: rgba(46,204,113,0.65); }
#gxnufl-logdlg .gxl-unit { color: #9aa0a6; font-size: 11px; width: 26px; }
#gxnufl-logdlg .gxl-info {
    margin: 8px 0 10px; padding: 6px 8px; border-radius: 6px;
    background: rgba(79,142,247,0.12); color: #cfd3d6; font-size: 10.5px; line-height: 1.5;
}
#gxnufl-logdlg .gxl-preview {
    flex: 1; min-height: 90px; overflow: auto; padding: 8px; border-radius: 7px;
    background: rgba(0,0,0,0.32); border: 1px solid rgba(255,255,255,0.1);
    color: #b8bec7; font: 10.5px/1.7 Consolas, "Microsoft YaHei", monospace;
    white-space: pre-wrap; word-break: break-all;
}
#gxnufl-logdlg .gxl-foot { display: flex; gap: 6px; padding: 10px 14px; border-top: 1px solid rgba(255,255,255,0.1); }
#gxnufl-logdlg .gxl-foot { flex: 0 0 auto; }
#gxnufl-logdlg .gxl-foot { flex-wrap: wrap; }
#gxnufl-logdlg .gxl-btn { flex: 1 1 30%; min-width: 78px; }
#gxnufl-logdlg .gxl-sec-tabs { display: flex; justify-content: space-between; align-items: center; }
#gxnufl-logdlg .gxl-tabs { display: flex; gap: 4px; }
#gxnufl-logdlg .gxl-tab {
    padding: 2px 9px; border-radius: 5px; cursor: pointer; font-size: 10.5px;
    background: rgba(255,255,255,0.06); color: #9aa0a6;
    border: 1px solid rgba(255,255,255,0.14); font-family: inherit;
}
#gxnufl-logdlg .gxl-tab:hover { color: #fff; }
#gxnufl-logdlg .gxl-tab.on { background: rgba(79,142,247,0.22); border-color: rgba(79,142,247,0.5); color: #cfe0ff; }
#gxnufl-logdlg .gxl-resize {
    position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
    cursor: nwse-resize; z-index: 2;
}
#gxnufl-logdlg .gxl-resize::after {
    content: ''; position: absolute; right: 3px; bottom: 3px; width: 8px; height: 8px;
    border-right: 2px solid rgba(156,192,255,0.7); border-bottom: 2px solid rgba(156,192,255,0.7);
}
#gxnufl-logdlg .gxl-resize:hover::after { border-color: #9cc0ff; }
#gxnufl-logdlg .gxl-btn {
    flex: 1; padding: 6px 4px; border-radius: 7px; cursor: pointer;
    background: rgba(255,255,255,0.07); color: #d6d9dc;
    border: 1px solid rgba(255,255,255,0.16); font-size: 11.5px; font-family: inherit;
}
#gxnufl-logdlg .gxl-btn:hover { background: rgba(255,255,255,0.14); color: #fff; }
#gxnufl-logdlg .gxl-btn.primary { background: rgba(46,204,113,0.22); border-color: rgba(46,204,113,0.5); color: #b9f6d0; }
#gxnufl-logdlg .gxl-btn.danger { background: rgba(231,76,60,0.28); border-color: rgba(231,76,60,0.6); color: #ffd5d0; }
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

    // ---- 拖拽（位置记忆）：胶囊 + 设置面板 ----
    const PILL_POS_KEY = 'gxnufl_pill_pos';
    const PANEL_POS_KEY = 'gxnufl_panel_pos';

    function readPos(key) {
        try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
    }

    function writePos(key, left, top) {
        try { localStorage.setItem(key, JSON.stringify({ left: left, top: top })); } catch (e) {}
    }

    function getSavedPos() { return readPos(PILL_POS_KEY); }

    function syncPanelPos() {
        if (!elPanel) return;
        // 优先面板自己拖动保存的位置，其次跟随胶囊位置
        const saved = readPos(PANEL_POS_KEY) || getSavedPos();
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

    // el: 要移动的元素；handle: 拖动手柄（默认 el 自身）；posKey: 位置存储键
    function makeDraggable(el, handle, posKey) {
        const dragEl = handle || el;
        posKey = posKey || PILL_POS_KEY;
        let dragging = false, moved = false;
        let startX = 0, startY = 0, origLeft = 0, origTop = 0;

        const saved = readPos(posKey);
        if (saved && saved.left && saved.top) {
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            el.style.left = saved.left;
            el.style.top = saved.top;
        }

        dragEl.addEventListener('mousedown', (e) => {
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
                writePos(posKey, el.style.left, el.style.top);
                if (el === elPill) syncPanelPos();   // 胶囊移动后，面板跟随（若面板没有自己的位置）
            }
        }

        // 拖拽后抑制误触的 click（避免拖动结束顺手触发点击）
        dragEl.addEventListener('click', (e) => {
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

        // 智慧树：资源统计块
        if (IS_ZHS) {
            elZhsStat = document.createElement('div');
            elZhsStat.className = 'gx-stat';
            elZhsStat.textContent = '资源统计：加载中…';
        }

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
            IS_ZHS
                ? '智慧树按真实观看时长计进度，倍速不会加快进度；建议保持 1x'
                : '0 = 不干预；支持 0~16 倍速。注意：超过 4 倍速时浏览器会自动静音'));
        // 智慧树：多开是否使用独立窗口（而非浏览器标签页）
        if (IS_ZHS) {
            bodyBox.appendChild(makeRow('独立窗口', makeSwitch('MULTI_WIN'),
                '开启时「多开窗口」用独立窗口打开（可并排查看）；关闭则用浏览器标签页'));
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
            IS_ZHS
                ? '⚠️ 实验性：不下载视频按 1x 虚拟推进，但实测可能不上报学习时长（会白刷），不建议开启'
                : '不下载视频画面，用虚拟进度推进；弹题与进度上报照常，几乎不耗流量'));
        bodyBox.appendChild(makeRow('后台保活', makeSwitch('KEEP_ALIVE', (on) => {
            if (on) startKeepAlive();
        }),
            '用超声波让页面保持"有声"活跃状态，防止浏览器休眠后台标签页导致刷课中断（默认关）'));
        // 多窗口信息同步间隔（3/5 秒）
        const syncWrap = document.createElement('span');
        syncWrap.className = 'gx-range';
        const syncSel = document.createElement('select');
        syncSel.className = 'gx-num';
        [3, 5, 8].forEach(v => {
            const o = document.createElement('option');
            o.value = String(v);
            o.textContent = v + ' 秒';
            if (Number(state.SYNC_SEC) === v) o.selected = true;
            syncSel.appendChild(o);
        });
        syncSel.addEventListener('change', () => {
            state.SYNC_SEC = parseInt(syncSel.value, 10) || 5;
            saveState();
        });
        syncWrap.appendChild(syncSel);
        bodyBox.appendChild(makeRow('窗口同步', syncWrap,
            '多窗口共享统计/心跳的间隔；越大越不容易互相干扰导致乱跳（默认 5 秒，可选 3 秒）'));
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
            parBtn.textContent = '多开窗口';
            parBtn.title = '每次打开 ' + MULTI_COUNT + ' 个窗口（或标签页），自动播放未完成资源（优先未看完的）；播完自动切下一个，可重复点击开更多';
            parBtn.addEventListener('click', () => openParallelWindows());
            elParBtn = parBtn;
        }

        // 智慧树模式：隐藏不适用的功能行
        if (IS_ZHS) {
            ['自动答题', '字幕匹配答案', '弹题保护', '自动提问', '答题延迟'].forEach(name => {
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
        if (elZhsStat) elPanel.appendChild(elZhsStat);
        elPanel.appendChild(bodyBox);
        elPanel.appendChild(btnRow);

        // 日志设置入口（合并导出/清空 + 配置 + 预览）
        const logBtn = document.createElement('button');
        logBtn.className = 'gx-log';
        logBtn.textContent = '日志设置';
        logBtn.title = '打开日志设置：记录条数 / 自动清理周期 / 最大大小 / 最近日志预览 / 导出 / 清空';
        logBtn.addEventListener('click', openLogSettings);
        elPanel.appendChild(logBtn);

        elPanel.appendChild(foot);
        document.body.appendChild(elPanel);

        // 面板顶栏拖拽（位置单独记忆，优先于胶囊位置）
        makeDraggable(elPanel, head, PANEL_POS_KEY);

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
        // 转存 hook 捕获的上报日志（进内存缓冲，导出日志时可见）
        if (window.__gxHookLog && window.__gxHookLog.length) {
            try { window.__gxHookLog.splice(0).forEach(l => log(l)); } catch (e) {}
        }
        // 智慧树：把本地完成状态同步到资源树（✓ 即时显示）并补齐时长标注，2 秒一次
        if (IS_ZHS && Date.now() - lastZhsSyncAt > 2000) {
            lastZhsSyncAt = Date.now();
            zhsDecorateDurations();
            selfCheckSaveMode();
            zhsSkipIfDone();
            zhsRefreshStatsIfStale();
            // 多开窗口心跳 + 按钮上显示当前活跃窗口数
            zhsWinHeartbeat();
            if (elParBtn) {
                const n = zhsActiveWindows();
                const txt = '多开窗口' + (n > 0 ? '（' + n + '）' : '');
                if (elParBtn.textContent !== txt) elParBtn.textContent = txt;
                const cooling = Date.now() - lastMultiClickAt < MULTI_COOLDOWN;
                if (elParBtn.disabled !== cooling) elParBtn.disabled = cooling;
            }
            // 页面渲染出侧栏后再初始化拖拽手柄
            if (!document.getElementById('gxnufl-sidebar-handle')) initSidebarResizer();
        }
        // 省流量模式：确保虚拟播放器已启用（智慧树同样支持：不下载画面，学习时长按真实时间照常累计）
        if (state.SAVE_DATA) {
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
            // 上报空闲报警：超过 5 分钟没有上报 → 可能是掉登录/页面被休眠/播放器卡住
            const lastReport = Number(window.__gxReportAt) || 0;
            const refAt = lastReport || START_AT;
            const idleMin = (Date.now() - refAt) / 60000;
            if (idleMin > 5) {
                setStatus('⚠️ 已 ' + Math.round(idleMin) + ' 分钟无进度上报：可能掉登录 / 页面被休眠 / 播放器卡住', 'warn');
            } else if (lastReport && Date.now() - lastReport < 2 * 60000) {
                setStatus(document.hidden ? '智慧树模式 · 后台运行中（' + Math.round((Date.now() - lastReport) / 1000) + ' 秒前上报）'
                    : '智慧树模式 · 自动刷资源中', 'ok');
            } else {
                setStatus(document.hidden ? '智慧树模式 · 后台运行中' : '智慧树模式 · 自动刷资源中', 'ok');
            }
        } else if (!state.AUTO_NEXT && !state.AUTO_ANSWER && !state.AUTO_PLAY) {
            setStatus('全部功能已关闭', 'off');
        } else {
            setStatus('自动刷课运行中', 'ok');
        }
    }

    function start() {
        jq = window.jQuery || window.$;   // document-start 注入时 jQuery 可能还没加载
        log('脚本已启动 v3.26', state);
        // 多开窗口：强制关闭省流量模式（虚拟播放在智慧树可能不上报进度，会白刷）
        if (IS_ZHS && zhsIsParallelWindow() && state.SAVE_DATA) {
            state.SAVE_DATA = false;
            saveState();
            log('多开窗口：已关闭省流量模式（该模式可能不上报进度）');
        }
        buildUI();
        // 共享日志：每 2 秒落盘一次；页面重载/关闭前强制落盘，保证日志连续
        flushSharedLogs();
        setInterval(flushSharedLogs, 2000);
        autoCleanLogs();                    // 启动时按设置清理一次
        setInterval(autoCleanLogs, 5 * 60 * 1000);   // 每 5 分钟自动清理
        window.addEventListener('pagehide', flushSharedLogs);
        window.addEventListener('beforeunload', flushSharedLogs);
        // 后台保活（默认关闭）：开启时先试一次，被自动播放策略拦下则等用户点击后再启动
        if (state.KEEP_ALIVE) {
            startKeepAlive();
            const keepKick = () => { startKeepAlive(); };
            document.addEventListener('click', keepKick, { once: true });
            document.addEventListener('keydown', keepKick, { once: true });
        }
        // 移除"浏览器版本过低"提示条（页面可能延迟插入，做几次补偿检查）
        removeBrowserTip();
        setTimeout(removeBrowserTip, 1200);
        setInterval(removeBrowserTip, 5000);
        // 智慧树：加载资源统计（等页面初始化完成）；学习资源页加样式标记
        if (IS_ZHS) {
            if (/^wenda\./i.test(location.hostname)) document.body.classList.add('gx-zhs-source');
            // 先用共享缓存（其他窗口刚更新过的统计），再后台刷新
            const cached = loadZhsStatCache();
            if (cached) {
                zhsStat = cached;
                renderZhsStat();
                zhsDecorateDurations();
                log('已载入共享资源统计缓存（' + cached.count + ' 个视频 / 已完成 ' + cached.doneCount + '）');
            }
            setTimeout(fetchZhsStats, 2000);
            // 其他窗口更新统计时实时同步
            let lastStatSyncAt = 0;
            window.addEventListener('storage', (e) => {
                if (e.key !== ZHS_STAT_KEY || !e.newValue) return;
                if (Date.now() - lastStatSyncAt < (Number(state.SYNC_SEC) || 5) * 1000) return;
                lastStatSyncAt = Date.now();
                try {
                    const o = JSON.parse(e.newValue);
                    if (!o || !o.map) return;
                    zhsStat = o;
                    renderZhsStat();
                    zhsDecorateDurations();
                    log('已同步其他窗口更新的资源统计');
                } catch (err) {}
            });
            setTimeout(clearFalseLocalDone, 3500);   // 清理旧版本误标的完成记录
            // 多开窗口：自动把右侧列表滚到当前播放的视频位置
            if (zhsIsParallelWindow()) setTimeout(zhsScrollToCurrentWhenReady, 1500);
        }
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
