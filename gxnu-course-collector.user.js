// ==UserScript==
// @name         GXNU 课表采集器
// @namespace    xiaobu.userscripts
// @version      1.7.1
// @updateURL    https://raw.githubusercontent.com/yuyangu/userscripts/main/gxnu-course-collector.user.js
// @downloadURL  https://raw.githubusercontent.com/yuyangu/userscripts/main/gxnu-course-collector.user.js
// @description  在广西师范大学教务系统 / 易班「易知独秀」课表页一键采集课表，导出 JSON 到本地下载目录，供 Obsidian 同步脚本解析。支持「我的课表」(queryKbForXsd)、「课表查询」(api/getKbxx) 与易班课表 (yzdx/dean/course) 三种页面。
// @author       小布
// @match        https://jwjx.gxnu.edu.cn/jw/admin*
// @match        https://yiban.gxnu.edu.cn/yzdx*
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%93%9A%3C/text%3E%3C/svg%3E
// @grant        GM_download
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==
//
// ⚠ v1.7.0 把 @run-at 从 document-idle 改为 document-start —— 原因：
//   易班「易知独秀」课表页的接口响应必须在页面自己的 JS 发出请求**之前**
//   挂钩子才能捕获。DOM 相关的初始化仍然等 DOMContentLoaded，
//   教务系统那两条路径的行为完全不变（它们本来就靠轮询等待表格）。

/**
 * GXNU 课表采集器（油猴脚本）
 * ==========================
 *
 * 页面结构（关键！）
 * ------------------
 * 教务系统 `https://jwjx.gxnu.edu.cn/jw/admin?sfjrxk=1` 是**主页面 + iframe** 架构：
 *
 *   父页面  /jw/admin?sfjrxk=1        ← 只有导航/标签栏，没有课表表格
 *     └─ iframe  /jw/admin//xsd/pkgl/xskb/queryKbForXsd   ← 课表表格在这里
 *
 * 因此脚本**不能**设 `@noframes`（那会导致 iframe 内不注入、读不到表格）。
 * v1.5.1 的做法：
 *   1. 在任意教务页都注入（`@match https://jwjx.gxnu.edu.cn/jw/admin*`）
 *   2. **按 iframe 元素遍历**，用 `el.contentDocument` 取子文档（不依赖下标对齐）
 *   3. ★**必须等到「课程填充完成」**才算找到课表。
 *      教务系统会先返回一张**空课表模板**（96 个空 `<td class="cell">`），
 *      课程内容随后由 JS 填充。v1.4.0 只按结构判断，
 *      在空模板上**立即**判定"找到"→ 根本不等待 → 抓到 96 个空格子 → 0 条记录。
 *      实测判据（2026-09-23）：空模板「非空单元格」= 0，真课表 = 13。
 *   4. ★**pageHtml 里表格只出现一份**。`doc.body.innerHTML` 已含表格，
 *      v1.5.0 又追加了一遍 `table.outerHTML`，导致解析端每门课算 2 次
 *      （16 条虚增为 35 条）。v1.5.1 只在 body 不含已填充表格时才追加。
 *   5. 等不到则**同源直取**：找出课表 iframe 的 `src`（含 `queryKbForXsd`），
 *      用 `fetch(url, {credentials:"same-origin"})` 直接请求课表页 HTML
 *   6. 取不到**已填充**的课表就**拒绝导出**并输出诊断，不产出误导性的 0 条 JSON
 *   7. 面板只在**顶层窗口**显示一次，子 iframe 不重复冒面板
 *
 * ⚠ 关于「另存为」
 * ---------------
 * 浏览器另存**不会**保存 iframe 里的内容！若你 `Ctrl+S` 存的是父页面
 * （`/jw/admin?sfjrxk=1`），存下来的 HTML 里 table 数 = 0，
 * 解析必然 0 条 —— 这不是脚本问题，是另存动作的固有限制。
 * **正确做法：用本油猴脚本采集**（它会穿透 iframe 取表格）。
 *
 * 为什么用油猴而不是 Cookie 抓取
 * ------------------------------
 * 实测（2026-09-22 复核）：Edge 的 `Local State` 中
 * `os_crypt.app_bound_encrypted_key` 前缀为 **`APPB`**（App-Bound Encryption），
 * 受双层 DPAPI + 浏览器进程身份绑定保护，**离线解密必然失败**。
 * 故 Cookie 方案不可行，改由浏览器自身读取课表页并导出。
 *
 * 安全声明（请审阅）
 * ------------------
 * - `@match` 仅限两个校内站点：
 *     `jwjx.gxnu.edu.cn/jw/admin*`（教务系统）
 *     `yiban.gxnu.edu.cn/yzdx*`   （易班易知独秀，v1.7.0 新增）
 *   不会在其他任何站点运行。
 * - **网络请求只发往当前页面的同源地址**，不外传任何第三方：
 *     · 教务「我的课表」：DOM 取不到表格时对同源 iframe 的
 *       `queryKbForXsd` URL 发一次 `fetch(credentials:"same-origin")`
 *     · 教务「课表查询」：按 `sid` 参数逐周直取 `api/getKbxx`
 *     · 易班课表页：**一次请求都不发** —— 只挂钩子捕获页面自身已发出的响应
 * - **不读取 Cookie**（请求由浏览器自动附带登录态，脚本接触不到 Cookie 值）。
 * - **不读取 localStorage 里的登录 token**。易班接口只认 Bearer token，
 *   但本脚本选择**捕获页面自身的那次请求**，而不是自己带 token 去调 ——
 *   这样脚本全程不接触任何登录凭证。代价：需要页面加载时钩子在位，
 *   故 v1.7.0 起 `@run-at` 为 `document-start`。
 * - 只读取当前页 DOM（含同源子 iframe），不访问其他标签页。
 * - 导出的 JSON 含姓名，落盘位置由你控制，不经任何第三方。
 *
 * 使用
 * ----
 * 1. 装好 Tampermonkey，导入本脚本
 * 2. 登录教务系统，点左侧「我的课表」
 *    （入口 https://jwjx.gxnu.edu.cn/jw/admin?sfjrxk=1）
 * 3. 等课表表格显示出来，再点右下角「采集并导出课表」
 *    （脚本自身也会等最多 8 秒）
 * 4. 浏览器会下载 course-schedule-*.json 到**默认下载目录**
 * 5. 运行同步脚本即可自动导入 Obsidian（脚本只读下载目录，不改路径）
 *
 * 易班「易知独秀」课表页（v1.7.0 新增，同样这一段流程）
 * ---------------------------------------------------
 * 1. 登录易班 → 进入「课表」页
 *    （入口 https://yiban.gxnu.edu.cn/yzdx/dean/course）
 *    ⚠ **进入后刷新一次（F5）** —— 采集依赖页面加载时挂上的钩子，
 *      若你是从首页点进来的（SPA 内部跳转），刷新一下最稳。
 * 2. 点右下角「采集并导出课表」→ 导出 course-schedule-*.json
 * 3. 同一份同步脚本直接可用（易班数据复用教务「课表查询」页的解析路径）
 *
 * 易班页与教务页的差异（实现时务必知道）
 * ------------------------------------
 * · 课表**不是 `<table>`**，是 Tailwind CSS Grid → 旧三套解析判据全部失效
 * · DOM 里**没有教师名**（只在点击后的详情弹窗里）→ 只能走接口数据
 * · 接口 `/api/v2/dean/course` 只认 `Bearer` token，**Cookie 不够**；
 *   token 存在 localStorage 的 `__YZDX__USER_ACCESS_TOKEN__`
 * · 本脚本**不读该 token**，改为捕获页面自身发出的那次响应（权限最小）
 */

(function () {
  "use strict";

  const VERSION = "1.7.0";
  const PANEL_ID = "gxnu-kb-panel";
  const AUTO_KEY = "gxnu-autocollect-last-date";

  const log = (...a) => console.log("[课表采集器]", ...a);

  /* ================= 易班「易知独秀」课表页（v1.7.0） ================= */

  /**
   * 易班「易知独秀」轻应用（`https://yiban.gxnu.edu.cn/yzdx/`）里也有课表，
   * 入口路由 `/dean/course`。它与教务系统**不是同一套页面**，有三点根本差异：
   *
   * 1. Vue3 SPA，路由 base `/yzdx`，课表页是懒加载 chunk（`assets/course-*.js`）
   * 2. 课表**不是 `<table>`**，是 Tailwind CSS Grid（`grid-cols-8 grid-rows-12`）。
   *    每节课用内联样式 `grid-area: <起始节> / <星期+1> / <终止节+1> / <星期+2>`
   *    定位 → `cell` / `jcIndex` / `rowkb` 三套旧判据**全部失效**
   * 3. 课程卡片 DOM 里**没有教师名**（只在点击后的详情弹窗里）
   *
   * 页面数据来自 `GET /api/v2/dean/course`（同源），返回：
   *
   *     { semester, current,
   *       weeks:  [ { weeks, beginDate, endDate } ],      ← 全学期周次表
   *       course: { "<周次>": [ 课… ] } }                 ← 按周分组，一次给全
   *
   * 单条课程字段：kcmc 课程名 / xqj 星期(1-7) / qsj 起始节 / zzj 终止节 /
   *               jxddmc 教室 / skjsxm 教师 / xf 学分 / zxs 总学时 / kcxzmc 课程性质
   * ★ 页面上的「切换周次」是**纯前端**切换，不会重新请求 → 一次响应即含整学期。
   *
   * ⚠ 接口只认 `Authorization: Bearer <token>`，**Cookie 不够**
   *   （实测无 token → `{"code":401,"message":"登录超时"}`）；
   *   token 存在 localStorage 的 `__YZDX__USER_ACCESS_TOKEN__`。
   *
   * 采集策略 —— **权限最小**：
   *   不读取 token、不自己发请求，而是在 `document-start` 注入一个钩子，
   *   **捕获页面自身发出的那次 `/api/v2/dean/course` 响应**。
   *   这样脚本既不接触任何登录凭证，也不产生额外网络请求 ——
   *   那次请求本来就是浏览器打开该页时必然会发生的。
   *
   * 代价：必须在页面加载时挂钩子（故 `@run-at document-start`）。
   *   若打开页面时钩子没赶上（极少见），面板会提示刷新一次。
   */

  /** 是否运行在易班易知独秀站点。 */
  function isYzdxApp() {
    try {
      return /(^|\.)yiban\.gxnu\.edu\.cn$/i.test(location.hostname);
    } catch (e) {
      return false;
    }
  }

  /** 目标接口：`/api/v2/dean/course`。 */
  const YZDX_API_RE = /\/api\/v2\/dean\/course(\?|\/|$)/;
  const YZDX_CAP_KEY = "__GXNU_YZDX_CAPTURE__";
  const YZDX_HOOK_KEY = "__GXNU_YZDX_HOOK__";

  /** 页面真实 window（TM 沙箱下用 unsafeWindow，才能读到注入脚本写的数据）。 */
  function pageWindow() {
    try {
      if (typeof unsafeWindow !== "undefined" && unsafeWindow) return unsafeWindow;
    } catch (e) { /* 忽略 */ }
    return window;
  }

  /**
   * 注入页钩子（**必须**在页面 JS 发出请求之前执行）。
   *
   * 用 `<script>` 注入而非直接改 `unsafeWindow.fetch` —— 注入脚本一定跑在
   * 页面上下文里，不受油猴沙箱的实现差异影响；该站无 CSP，注入不会被拦。
   * 钩子本体通过 `Function.prototype.toString()` 序列化，故它**不能引用外部变量**。
   */
  const YZDX_HOOK_BODY = function () {
    var KEY = "__GXNU_YZDX_CAPTURE__";
    if (window.__GXNU_YZDX_HOOK__) return;
    window.__GXNU_YZDX_HOOK__ = true;

    var cap = window[KEY] = { at: "", url: "", payload: null, error: "" };
    var RE = /\/api\/v2\/dean\/course(\?|\/|$)/;
    var hit = function (u) { return RE.test(String(u || "")); };

    var store = function (url, text) {
      try {
        var obj = JSON.parse(text);
        if (!obj || typeof obj !== "object") return;
        cap.at = new Date().toISOString();
        cap.url = String(url || "");
        cap.payload = obj;
        cap.error = "";
        console.log("[课表采集器] 已捕获易班课表接口响应", obj.code);
      } catch (e) {
        cap.error = "响应不是合法 JSON：" + (e && e.message);
      }
    };

    // --- XMLHttpRequest（axios 浏览器端默认适配器）---
    try {
      var XHR = window.XMLHttpRequest;
      if (XHR && XHR.prototype) {
        var oOpen = XHR.prototype.open;
        var oSend = XHR.prototype.send;
        XHR.prototype.open = function (m, u) {
          try { this.__gxnuUrl = u; } catch (e) { /* 忽略 */ }
          return oOpen.apply(this, arguments);
        };
        XHR.prototype.send = function () {
          var self = this;
          try {
            if (hit(self.__gxnuUrl)) {
              self.addEventListener("load", function () {
                try { store(self.__gxnuUrl, self.responseText); }
                catch (e) { cap.error = String(e); }
              });
            }
          } catch (e) { /* 忽略 */ }
          return oSend.apply(this, arguments);
        };
      }
    } catch (e) { /* 忽略 */ }

    // --- fetch（若页面改用 fetch 适配器）---
    try {
      var oFetch = window.fetch;
      if (typeof oFetch === "function") {
        window.fetch = function (input) {
          var url = (typeof input === "string") ? input : (input && input.url) || "";
          var p = oFetch.apply(this, arguments);
          try {
            if (hit(url) && p && typeof p.then === "function") {
              p.then(function (res) {
                try {
                  if (res && res.ok && typeof res.clone === "function") {
                    res.clone().text().then(function (t) { store(url, t); },
                                            function () {});
                  }
                } catch (e) { /* 忽略 */ }
                return res;
              });
            }
          } catch (e) { /* 忽略 */ }
          return p;
        };
      }
    } catch (e) { /* 忽略 */ }
  };

  /** 在 document-start 安装钩子。 */
  function installYzdxHook() {
    const inject = () => {
      try {
        if (pageWindow()[YZDX_HOOK_KEY]) return true;
        const host = document.head || document.documentElement;
        if (!host) return false;               // 极早期，<html> 还没出现
        const s = document.createElement("script");
        s.textContent = "(" + YZDX_HOOK_BODY.toString() + ")();";
        host.appendChild(s);                   // 经典脚本 → 同步执行
        s.remove();
        return !!pageWindow()[YZDX_HOOK_KEY];
      } catch (e) {
        return false;
      }
    };

    if (inject()) {
      log("易班课表钩子已安装（等待页面自身请求 /api/v2/dean/course）");
      return true;
    }
    // documentElement 尚未就绪 → 每 100ms 重试，最多约 5 秒。
    // 若一直装不上，面板会提示刷新（刷新后钩子必然赶上）。
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (inject()) {
        clearInterval(timer);
        log("易班课表钩子已安装（延迟约 " + n * 100 + "ms）");
      } else if (n >= 50) {
        clearInterval(timer);
        log("易班课表钩子未能安装：documentElement 迟迟不可用");
      }
    }, 100);
    return false;
  }

  /** 读取捕获结果；拿到合法课表数据返回 `{cap, data}`，否则 null。 */
  function yzdxCapture() {
    try {
      const cap = pageWindow()[YZDX_CAP_KEY];
      const d = cap && cap.payload && cap.payload.data;
      if (!d || typeof d !== "object" || !d.course) return null;
      return { cap, data: d };
    } catch (e) {
      return null;
    }
  }

  /** 「2026-2027学年第一学期」→「2026-2027-1」。 */
  function yzdxSemesterCode(s) {
    const m = String(s || "").match(
      /(20\d{2})\s*[-—]\s*(20\d{2})\s*学年\s*第?\s*([12一二])\s*学期/);
    if (!m) return "";
    const n = m[3] === "一" ? 1 : m[3] === "二" ? 2 : m[3];
    return `${m[1]}-${m[2]}-${n}`;
  }

  /**
   * 接口数据 → 与「课表查询」页**同构**的周结构。
   *
   * 有意复用 `kbcxWeeks` 的字段形状（`{sid,label,range,courses:[{week,weekday,
   * periodStart,periodEnd,course,room,teacher,raw}]}`），这样同步脚本里
   * 已被 19 周数据验证过的 `schedule_from_kbcx_weeks()` 可直接复用，
   * 不必新写一套解析器（少一处出错的地方）。
   */
  function buildYzdxWeeks(data) {
    const WD = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    const meta = {};
    for (const w of (data.weeks || [])) {
      const n = parseInt(w && w.weeks, 10);
      if (Number.isFinite(n)) meta[n] = w;
    }
    const map = data.course || {};
    const set = new Set();
    for (const k of Object.keys(map)) {
      const n = parseInt(k, 10);
      if (Number.isFinite(n)) set.add(n);
    }
    // 接口给了完整周次表 → 一并纳入，这样「某周被清空」也能被识别出来
    for (const n of Object.keys(meta)) {
      if (Number.isFinite(+n)) set.add(+n);
    }
    const weeks = [];
    for (const weekNo of Array.from(set).sort((a, b) => a - b)) {
      const m = meta[weekNo] || {};
      const courses = [];
      for (const c of (map[weekNo] || map[String(weekNo)] || [])) {
        const weekday = parseInt(c.xqj, 10);
        const ps = parseInt(c.qsj, 10);
        const pe = parseInt(c.zzj, 10);
        const name = String(c.kcmc || "").trim();
        if (!(weekday >= 1 && weekday <= 7) || !Number.isFinite(ps) || !name) {
          continue;
        }
        const room = String(c.jxddmc || "").trim();
        courses.push({
          week: weekNo,
          weekday,
          weekdayName: WD[weekday - 1] || String(weekday),
          periodStart: ps,
          // 新版页用 `grid-area: qsj / … / zzj+1 / …` → zzj 是**闭区间**终点
          periodEnd: Number.isFinite(pe) ? Math.max(ps, pe) : ps,
          course: name,
          room,
          teacher: String(c.skjsxm || "").trim(),
          raw: room ? `${name} @ ${room}` : name,
        });
      }
      const range = [m.beginDate, m.endDate].filter(Boolean).join(" ~ ");
      weeks.push({ sid: weekNo, label: `第 ${weekNo} 教学周`, range, courses });
    }
    return weeks;
  }

  /** 易班课表页的网格容器（仅作导出时的 HTML 快照，便于事后排查）。 */
  function yzdxGridHtml() {
    try {
      for (const el of document.querySelectorAll("div")) {
        const cls = el.className;
        if (typeof cls === "string" && cls.indexOf("grid-cols-8") >= 0 &&
            cls.indexOf("grid-rows-12") >= 0) {
          return (el.outerHTML || "").slice(0, 80000);
        }
      }
    } catch (e) { /* 忽略 */ }
    return "";
  }

  /**
   * 由捕获数据构造完整导出 payload。数据为空时返回 null。
   * 手动采集与自动采集共用，避免两处逻辑漂移。
   */
  function buildYzdxPayload(data) {
    const weeks = buildYzdxWeeks(data);
    const rows = weeks.reduce((n, w) => n + w.courses.length, 0);
    if (!rows) return null;
    const cur = parseInt(data.current, 10);
    return collect(yzdxGridHtml(), {
      yzdxWeeks: weeks,
      touchedWeeks: weeks.map((w) => w.sid),
      emptyWeeks: weeks.filter((w) => !w.courses.length).map((w) => w.sid),
      metaOverride: {
        semester: String(data.semester || ""),
        semesterCode: yzdxSemesterCode(data.semester),
        currentWeek: Number.isFinite(cur) ? cur : 0,
        // 易班页面 DOM 里没有姓名/学号/班级，留空由同步脚本用 config.json 补
        className: "",
      },
    });
  }

  // ★ document-start：立刻挂钩子。必须在这里（页面自己的 JS 之前）执行，
  //   否则接口响应早就回来了，钩子捕不到。
  if (isYzdxApp()) installYzdxHook();

  /* ====================== iframe 穿透 ====================== */

  /**
   * 收集「本窗口 + 所有同源可访问子 iframe」的 document。
   *
   * 重要：**按 iframe 元素遍历**，而不是按 window.frames 下标。
   * 原因：window.frames 只包含"可访问的帧"，且顺序/数量可能与
   * document.querySelectorAll("iframe") 不一致 —— 曾因此错位，
   * 导致监听到了 iframe0 却漏掉真正的课表 iframe20。
   * 通过元素 contentDocument 访问最可靠；跨源会抛异常，静默跳过。
   */
  function collectDocuments(root) {
    const docs = [];
    const seen = new Set();
    const walk = (doc, depth) => {
      if (!doc || depth > 5 || seen.has(doc)) return;
      seen.add(doc);
      docs.push(doc);

      let frames = [];
      try {
        frames = Array.from(doc.querySelectorAll("iframe"));
      } catch (e) {
        frames = [];
      }
      for (const el of frames) {
        let child = null;
        try {
          child = el.contentDocument;        // 同源才有值
        } catch (e) {
          child = null;                      // 跨源
        }
        if (child) {
          walk(child, depth + 1);
          continue;
        }
        // contentDocument 为 null 时，尝试 contentWindow.document（少数浏览器）
        try {
          if (el.contentWindow && el.contentWindow.document) {
            walk(el.contentWindow.document, depth + 1);
          }
        } catch (e) { /* 跨源，忽略 */ }
      }
    };
    try {
      walk((root && root.document) || document, 0);
    } catch (e) { /* 忽略 */ }
    return docs;
  }

  /**
   * 统计「已填充课程」的单元格数。
   *
   * ★ v1.5.0 的核心修正：教务系统会先返回一张**空课表模板**
   *   （96 个空 <td class="cell">，课程内容由 JS 随后填充）。
   *   只按结构（class="cell" / data-jcIndex）判断，会在模板上**立即**
   *   判定"找到课表"，于是根本不等待填充 → 抓到的全是空格子 → 导出 0 条。
   *   实测判据（2026-09-23）：空模板 0 个，真课表 13 个。
   */
  function countFilledCells(root) {
    let n = 0;
    let cells = [];
    try {
      cells = root.querySelectorAll('[class*="cell"]');
    } catch (e) {
      return 0;
    }
    for (const td of cells) {
      if ((td.textContent || "").trim()) n++;
    }
    return n;
  }

  /** 至少这么多已填充单元格才算真课表。 */
  const MIN_FILLED_CELLS = 3;

  /** 字符串版：统计 HTML 中「已填充课表单元格」的数量（空模板为 0）。 */
  const NONEMPTY_CELL_RE =
    /<td[^>]*class\s*=\s*["'][^"']*\bcell\b[^"']*["'][^>]*>\s*[^<\s]/gi;

  function countFilledCellsInHtml(html) {
    return ((html || "").match(NONEMPTY_CELL_RE) || []).length;
  }

  /* ============ 新版「课表查询」页面（api/getKbxx，kbcx） ============ */

  /**
   * ★ v1.6.0：教务系统另有一个【课表查询】页（入口 `api/getKbxx`，
   *   静态资源在 `/jw/static/kbcx/`），结构与「我的课表」**完全不同**：
   *
   *     <table class="table">
   *       <thead><tr id="tablebt">
   *         <th><span>10月</span><span>节次</span></th>
   *         <th class="today"><span>05</span><span>一</span></th>   ← 星期只有单个汉字
   *         ...
   *       </tr></thead>
   *       <tbody>
   *         <tr class="row1" sid="1" name="rowkb">
   *           <td class="col1" rowspan="1">1</td>                  ← 节次列
   *           <td id="Cell41" rowspan="3" name="tdbox tdbox4">
   *             <div class="tdbox-wrap"><div name="kbdyg" class="tdbox tdbox4">
   *               <a class="cengbtn">
   *                 <span style="display:none" title="汪娟">…</span>
   *                 <p class="content-detail"
   *                    title="高等数学1(雁山理三区3-101)">高等数学1(雁山理三区3-101)汪娟</p>
   *               </a>
   *             </div></div>
   *           </td>
   *           ...
   *
   *   要点：
   *   1. **没有 `class="cell"`**，只有 `name="tdbox"` → 旧判据全部失效
   *   2. 已填充判据 = `p.content-detail` 的个数
   *   3. 格子 id 仍是 `Cell<星期><节次>`，rowspan 仍是连堂课
   *   4. **一次只渲染一周**（第 N 周 tab 带 class="active"），
   *      要拿全学期必须逐周切换（或按 `sid` 参数直取）
   *   5. 周次列表：`<p sid="6" class="active">第6周<span>10.05-10.11</span></p>`
   *   6. 表头日期会随周次变化 → 用它判断"周次是否已切换完成"
   */

  /** 新版课表行标志（`name="rowkb"`）。 */
  const KB_ROW_RE = /name\s*=\s*["']rowkb["']/i;
  /** 新版课程卡片（`p.content-detail`）—— 已填充判据。 */
  const KB_CARD_ALL_RE = /class\s*=\s*["'][^"']*\bcontent-detail\b[^"']*["']/gi;
  const KB_CARD_RE = /class\s*=\s*["'][^"']*\bcontent-detail\b/i;

  /** 某个 document 是否为新版「课表查询」页。 */
  function isKbcxDoc(doc) {
    if (!doc) return false;
    try {
      return !!doc.querySelector('tr[name="rowkb"], td[id^="Cell"][name*="tdbox"]');
    } catch (e) {
      return false;
    }
  }

  /** 在所有可达 document 中找到新版课表页。 */
  function findKbcxDoc() {
    for (const doc of collectDocuments(window)) {
      if (isKbcxDoc(doc)) return doc;
    }
    return null;
  }

  /**
   * 新版：找课表表格 —— **不要求有课程**。
   *
   * ★ v1.6.2：`findTablesIn()` 要求「已填充课程 ≥ MIN_FILLED_CELLS」，
   *   那个阈值是给旧版「空课表模板」用的。新版由服务端直接渲染，
   *   不存在空模板问题 —— 而**空周**（当周没课）的表格课程数就是 0，
   *   会被 `findTablesIn()` 判成"找不到表格"，进而被误报为「采集失败」。
   *   故新版单独用这个判据：只要表格有 `name="rowkb"` 行就算课表表格。
   */
  function findKbcxTableIn(doc) {
    if (!doc) return null;
    try {
      for (const t of doc.querySelectorAll("table")) {
        if (t.querySelector('tr[name="rowkb"]')) return t;
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  /** 新版：统计已填充的课程卡片数。 */
  function countKbcxFilledCells(root) {
    try {
      return root.querySelectorAll("p.content-detail").length;
    } catch (e) {
      return 0;
    }
  }

  /** 新版：字符串版已填充计数。 */
  function countKbcxFilledInHtml(html) {
    return ((html || "").match(KB_CARD_ALL_RE) || []).length;
  }

  /** 新版：页面上的周次 tab 列表（sid / 元素 / 日期范围）。 */
  function kbcxWeekTabs(doc) {
    const out = [];
    if (!doc) return out;
    let nodes = [];
    try {
      nodes = Array.from(doc.querySelectorAll("p[sid]"));
    } catch (e) {
      return out;
    }
    for (const p of nodes) {
      const label = (p.textContent || "").trim();
      if (!/^第\s*\d+\s*周/.test(label)) continue;
      const sid = parseInt(p.getAttribute("sid"), 10);
      if (!Number.isFinite(sid)) continue;
      const span = p.querySelector("span");
      out.push({
        sid,
        el: p,
        label: label.replace(/\s+/g, ""),
        range: span ? (span.textContent || "").trim() : "",
        active: /(^|\s)active(\s|$)/.test(p.getAttribute("class") || ""),
      });
    }
    return out;
  }

  /**
   * 表头签名（形如 `10月|节次|05|一|06|二|…`）。
   * 切换周次后表头日期会变 → 用它判断"是否已切到目标周"。
   */
  function kbcxHeaderSignature(doc) {
    if (!doc) return "";
    let ths = [];
    try {
      ths = Array.from(doc.querySelectorAll("tr#tablebt th, table thead th"));
    } catch (e) {
      return "";
    }
    return ths
      .map((t) => (t.textContent || "").replace(/\s+/g, ""))
      .join("|");
  }

  /** 新版：取表头日期数字（用于校验 API 返回的是不是目标周）。 */
  function kbcxHeaderDates(html) {
    const m = (html || "").match(
      /<tr[^>]*id\s*=\s*["']tablebt["'][^>]*>([\s\S]*?)<\/tr>/i);
    if (!m) return [];
    const out = [];
    for (const t of m[1].matchAll(/<span>\s*(\d{1,2})\s*<\/span>/g)) {
      out.push(t[1]);
    }
    return out;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 在某个 document 中找承载课表的表格（必须已填充课程）。 */
  function findTablesIn(doc) {
    const all = Array.from(doc.querySelectorAll("table"));

    // 0) 新版「课表查询」页：rows 带 name="rowkb"，已填充判据是课程卡片
    const kbcx = all.filter(
      (t) => t.querySelector('tr[name="rowkb"]') &&
             countKbcxFilledCells(t) >= MIN_FILLED_CELLS);
    if (kbcx.length) return kbcx;

    // 1) 优先：强智课表表格 —— 含 cell / jcIndex 标志，且有课程内容
    const strong = all.filter(
      (t) => t.querySelector('[class*="cell"], [data-jcindex], [data-jcIndex]') &&
             countFilledCells(t) >= MIN_FILLED_CELLS);
    if (strong.length) return strong;

    // 2) 兜底：通用启发（星期列 + 含「节」+ 单元格够多 + 有内容）
    return all.filter((t) => {
      const txt = t.innerText || "";
      return /星期[一二三四五六日天]|周[一二三四五六日天]/.test(txt) &&
             /\d+\s*[-~至]?\s*\d*\s*节|第\s*\d+\s*节/.test(txt) &&
             t.querySelectorAll("td").length >= 12 &&
             countFilledCells(t) >= MIN_FILLED_CELLS;
    });
  }

  /** 在所有可达 document 中找课表表格。 */
  function findScheduleTables() {
    for (const doc of collectDocuments(window)) {
      const t = findTablesIn(doc);
      if (t.length) return t;
    }
    return [];
  }

  /** 找到「含课表」的那个 document（优先当前页，其次 iframe）。 */
  function findScheduleDoc() {
    for (const doc of collectDocuments(window)) {
      if (findTablesIn(doc).length) return doc;
    }
    return null;
  }

  /* ====================== 数据提取 ====================== */

  function extractMeta() {
    // 姓名/学期等可能出现在课表 iframe 内，故汇总所有可达 document 的文本
    const text = collectDocuments(window)
      .map((d) => (d.body ? d.body.innerText : ""))
      .join("\n");
    const pick = (re, src) => {
      const m = (src || text).match(re);
      return m ? m[1].trim() : "";
    };
    // 姓名优先从标题取：「2026-2027学年第1学期张三的课表」
    const titleName = pick(/学年\s*第?\s*[12一二]\s*学期\s*([\u4e00-\u9fa5]{2,6})\s*的课表/);

    // 学期代号：新版「课表查询」页的 URL 里带 `xnxq=2026-2027-1`（页面
    // 正文只写「2026-2027-1」），比文本匹配可靠得多。
    let semesterCode = "";
    try {
      const q = new URL(location.href).searchParams.get("xnxq") || "";
      if (/^20\d{2}-\d{4}-\d$/.test(q)) semesterCode = q;
    } catch (e) { /* 忽略 */ }
    if (!semesterCode) {
      const m = text.match(/(20\d{2})\s*[-—]\s*(20\d{2})\s*学年\s*第?\s*([12一二])\s*学期/);
      if (m) {
        const n = m[3] === "一" ? 1 : m[3] === "二" ? 2 : m[3];
        semesterCode = `${m[1]}-${m[2]}-${n}`;
      }
    }

    // 新版：当前正在显示第几周（tab 的 active 项）
    let currentWeek = 0;
    const kdoc = findKbcxDoc();
    if (kdoc) {
      const act = kbcxWeekTabs(kdoc).find((t) => t.active);
      if (act) currentWeek = act.sid;
    }

    return {
      name: titleName || pick(/姓\s*名[：:\s]*([\u4e00-\u9fa5]{2,6})/),
      studentId: pick(/学\s*号[：:\s]*(\d{8,20})/),
      semester: pick(/(20\d{2}\s*[-—]\s*20\d{2}\s*学年\s*第?\s*[12]\s*学期)/),
      semesterCode,
      currentWeek,
      // ⚠ 新版「课表查询」页没有班级信息；若照旧用宽松正则，会从「备注」
      //   里的实践环节误抓到**别人的专业**（实测抓到
      //   `2026数据科学与大数据技术(无方向)`），故新版一律留空。
      className: kdoc
        ? ""
        : pick(/(20\d{2}[\u4e00-\u9fa5（）()A-Za-z0-9]{2,30}班?)/),
    };
  }

  /** 当前页（含 iframe）是否像「课表页」（用于给出清晰提示）。 */
  function looksLikeSchedulePage() {
    if (findScheduleTables().length) return true;
    if (/queryKbForXsd|xskb|pkgl|getKbxx|kbcx/i.test(location.href)) return true;
    const text = collectDocuments(window)
      .map((d) => (d.body ? d.body.innerText : ""))
      .join("\n");
    return /我的课表|学生课表|课表查询|学年学期/.test(text) &&
           /星期[一二三四五六日天]|周[一二三四五六日天]/.test(text);
  }

  /** 页面是否是「学期暂未发布」等空壳响应。 */
  function detectEmptyResponse() {
    for (const doc of collectDocuments(window)) {
      const txt = (doc.body ? doc.body.innerText : "") || "";
      if (/"ret"\s*:\s*-?\d+/.test(txt) && /学期暂未发布|暂未发布|无数据/.test(txt)) {
        return true;
      }
      if (/学期暂未发布/.test(txt)) return true;
    }
    return false;
  }

  /**
   * 等待课表表格出现（轮询，最多 timeoutMs 毫秒）。
   * 课表 iframe 是异步渲染的，用户往往在表格就绪前就点了采集。
   * 返回 true 表示已找到。
   */
  function waitForSchedule(timeoutMs, onTick) {
    const limit = timeoutMs || 8000;
    const step = 300;
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        // findScheduleTables 已要求「有已填充课程」，故这里会一直等到课程渲染出来
        if (findScheduleTables().length) return resolve(true);
        if (detectEmptyResponse()) return resolve(false);
        const elapsed = Date.now() - t0;
        if (elapsed >= limit) return resolve(false);
        if (onTick) {
          try { onTick(elapsed); } catch (e) { /* 忽略 UI 异常 */ }
        }
        setTimeout(tick, step);
      };
      tick();
    });
  }

  /**
   * 抓课表区完整 HTML（Python 端以此为准）。
   *
   * ★ v1.5.1 修正：**不要重复输出表格**。
   *   `doc.body.innerHTML` 本身**已经包含**课表表格，若再追加一遍
   *   `table.outerHTML`，pageHtml 里就会出现**两份表格** →
   *   解析端每门课被算 2 次（实测 16 条虚增为 35 条，并破坏连堂课合并）。
   *   故只在 body.innerHTML **不含**已填充表格时才追加。
   *
   * 找不到课表表格时返回 ""，不退回父页面外壳 —— 避免产出
   * 一个"看起来成功、实则 0 条"的误导性导出。
   */
  function grabScheduleHtml() {
    const tables = findScheduleTables();
    if (!tables.length) return "";
    const doc = findScheduleDoc();
    const head = doc && doc.body ? doc.body.innerHTML : "";
    const tblHtml = tables.map((t) => t.outerHTML)
                          .join("\n<!-- TABLE SPLIT -->\n");
    // body.innerHTML 已含已填充课表 → 直接用，避免表格出现两份
    if (head && countFilledCellsInHtml(head) >= MIN_FILLED_CELLS) {
      return head;
    }
    // 兜底：body 里没有（或只有空模板），用表格自身的 outerHTML
    return tblHtml;
  }

  /**
   * pageHtml 是否为**含课程内容**的课表（导出前的硬护栏）。
   *
   * 必须同时满足：① 有课表结构标志；② 有已填充的课程单元格。
   * 只看 ① 会放行「空模板」——那正是 v1.4.0 导出 0 条记录的原因。
   */
  function pageHasSchedule(html) {
    if (!html) return false;
    // 新版「课表查询」页：以课程卡片（p.content-detail）计数
    if (KB_ROW_RE.test(html)) {
      return countKbcxFilledInHtml(html) >= MIN_FILLED_CELLS;
    }
    if (!/data-jcindex|data-jcIndex|class\s*=\s*["'][^"']*\bcell\b/i.test(html)) {
      return false;
    }
    return countFilledCellsInHtml(html) >= MIN_FILLED_CELLS;
  }

  /* ============ 同源直取兜底（v1.4.0） ============ */

  const SCHEDULE_URL_RE = /queryKbForXsd|xskb|pkgl/i;

  /** 自己是否就站在课表页。 */
  function selfIsSchedulePage() {
    return SCHEDULE_URL_RE.test(location.href);
  }

  /**
   * 找出课表页的 URL。
   * 优先取同源 iframe 的 src（含 queryKbForXsd / xskb / pkgl），
   * 其次若当前页本身就是课表页则用当前 URL。
   */
  function findScheduleUrl() {
    for (const doc of collectDocuments(window)) {
      let frames = [];
      try {
        frames = Array.from(doc.querySelectorAll("iframe"));
      } catch (e) {
        continue;
      }
      for (const el of frames) {
        const src = el.getAttribute("src") || "";
        if (!SCHEDULE_URL_RE.test(src)) continue;
        try {
          return new URL(src, doc.baseURI || location.href).href;
        } catch (e) { /* 非法 src，忽略 */ }
      }
    }
    if (selfIsSchedulePage()) return location.href;
    return "";
  }

  /**
   * 同源直接拉取课表页 HTML。
   *
   * 为什么需要：课表 iframe 可能迟迟不渲染、或嵌在更深的层级里，
   * 导致 DOM 路径取不到表格。此时直接用浏览器登录态请求课表 URL
   * 最可靠 —— 请求会由浏览器自动带上 Cookie，脚本本身接触不到 Cookie。
   * 仅发往教务系统同源地址，不外传。
   */
  async function fetchScheduleHtml(timeoutMs) {
    const url = findScheduleUrl();
    if (!url) {
      log("同源直取：未找到课表 URL");
      return "";
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
    try {
      const res = await fetch(url, {
        credentials: "same-origin",
        signal: ctrl.signal,
      });
      if (!res.ok) {
        log("同源直取失败：HTTP " + res.status + " " + url);
        return "";
      }
      const text = await res.text();
      const filled = countFilledCellsInHtml(text);
      if (pageHasSchedule(text)) {
        log("同源直取成功", { url, len: text.length, filledCells: filled });
        return text;
      }
      if (/class\s*=\s*["'][^"']*\bcell\b/i.test(text)) {
        log("同源直取：服务端返回的是**空课表模板**（未填充课程）",
            { url, len: text.length, filledCells: filled });
      } else {
        log("同源直取：响应不含课表标志", { url, len: text.length });
      }
      return "";
    } catch (e) {
      log("同源直取异常", e);
      return "";
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 取得课表 HTML：先走 DOM（常规），失败再走同源直取（兜底）。
   * 返回 { html, how }，how ∈ {"dom","fetch",""}。
   */
  async function acquireScheduleHtml(timeoutMs, onTick) {
    const limit = timeoutMs || 8000;
    if (await waitForSchedule(limit, onTick)) {
      const dom = grabScheduleHtml();
      if (dom && pageHasSchedule(dom)) return { html: dom, how: "dom" };
    }
    const fetched = await fetchScheduleHtml(limit);
    if (fetched) return { html: fetched, how: "fetch" };
    return { html: "", how: "" };
  }

  /* ============ 新版「课表查询」全周次采集（v1.6.0） ============ */

  /**
   * 等新版课表表格出现（轮询）。返回承载表格的 document 或 null。
   */
  async function waitForKbcx(timeoutMs, onTick) {
    const limit = timeoutMs || 12000;
    const step = 300;
    const t0 = Date.now();
    while (Date.now() - t0 < limit) {
      const doc = findKbcxDoc();
      if (doc && findKbcxTableIn(doc)) return doc;   // 空周也算就绪
      if (onTick) onTick(Date.now() - t0);
      await sleep(step);
    }
    const doc = findKbcxDoc();
    return doc && findKbcxTableIn(doc) ? doc : null;
  }

  /** 新版：从页面里找出 `api/getKbxx` 的完整 URL（可加 sid 参数复用）。 */
  function kbcxApiBase(doc) {
    if (!doc) return "";
    try {
      for (const a of doc.querySelectorAll("a[href]")) {
        const h = a.getAttribute("href") || "";
        if (!/api\/getKbxx/i.test(h)) continue;
        return new URL(h.replace(/#.*$/, ""), doc.baseURI || location.href).href;
      }
      // 兜底：当前 URL 本身
      if (/api\/getKbxx/i.test(location.href)) {
        return location.href.replace(/#.*$/, "");
      }
    } catch (e) { /* 忽略 */ }
    return "";
  }

  function withQuery(url, key, val) {
    try {
      const u = new URL(url);
      u.searchParams.set(key, String(val));
      return u.href;
    } catch (e) {
      return "";
    }
  }

  /**
   * 请求文本（带重试）。
   *
   * 新版页面要逐周请求 19 次，偶发超时/失败会让某几周**静默丢失**
   * （实测首次采集缺了 5 周）。故失败自动重试，间隔递增。
   */
  async function fetchText(url, ms, retries) {
    if (!url) return "";
    const tries = Math.max(1, (retries || 0) + 1);
    for (let i = 0; i < tries; i++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms || 9000);
      try {
        const res = await fetch(url, {
          credentials: "same-origin",
          signal: ctrl.signal,
        });
        if (res.ok) return await res.text();
        log("请求失败：HTTP " + res.status, url.slice(0, 90));
      } catch (e) {
        log("请求异常（第 " + (i + 1) + "/" + tries + " 次）", e && e.message);
      } finally {
        clearTimeout(timer);
      }
      if (i < tries - 1) await sleep(400 * (i + 1));
    }
    return "";
  }

  /**
   * 探测「按 sid 参数直取指定周」是否可行。
   *
   * 新版页面点是周次 tab 会重新请求 `api/getKbxx`。若服务端接受
   * `&sid=N`，就能一次并发拿到全部周次（比反复点击快得多、也不改动
   * 用户当前页面状态）。做法：挑一个**不是当前周**的周次请求一次，
   * 看返回的表头日期是否真的变成了那一周。
   */
  async function probeSidParam(baseUrl, tabs, curDates) {
    if (!baseUrl) return false;
    const cur = tabs.find((t) => t.active);
    const target = tabs.find((t) => !cur || t.sid !== cur.sid);
    if (!target) return false;
    const html = await fetchText(withQuery(baseUrl, "sid", target.sid), 9000);
    if (!html || !KB_ROW_RE.test(html)) return false;
    const dates = kbcxHeaderDates(html);
    if (!dates.length) return false;
    // 日期确实变了 → sid 参数生效
    const changed = dates.join(",") !== (curDates || []).join(",");
    if (changed) {
      log("API 直取可用：sid 参数生效", { probe: target.sid, dates });
    } else {
      log("API 直取不可用：sid 参数未生效（返回仍是当前周）", { probe: target.sid });
    }
    return changed;
  }

  /** 新版：按 sid 逐周直取（串行，避免打爆教务服务器）。 */
  async function collectKbcxByApi(baseUrl, tabs, onProgress) {
    const out = [];
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      if (onProgress) onProgress(i + 1, tabs.length, tab);
      const html = await fetchText(withQuery(baseUrl, "sid", tab.sid), 9000, 2);
      if (!html) {
        log("第 " + tab.sid + " 周请求失败", { url: withQuery(baseUrl, "sid", tab.sid).slice(0, 110) });
        continue;
      }
      const m = html.match(
        /<table[^>]*class\s*=\s*["'][^"']*\btable\b[\s\S]*?<\/table>/i);
      if (!m) continue;
      out.push({
        sid: tab.sid, label: tab.label, range: tab.range, html: m[0],
        courses: extractWeekCourses(htmlToTable(m[0]), tab.sid),
      });
      await sleep(80);
    }
    return out;
  }

  /**
   * 新版：点击周次 tab 切到目标周（返回是否切换成功）。
   *
   * 事件可能绑在 `<p>` 上，也可能绑在父 `<li>` 上（不同版本实现不一），
   * 故先用 p 试、超时再试父元素，避免"点了没反应"。
   */
  async function switchWeekTo(doc, tab, timeoutMs) {
    const before = kbcxHeaderSignature(doc);
    if (!before) return false;

    const tryClick = (el) => {
      try {
        el.click();
        return true;
      } catch (e) {
        return false;
      }
    };
    const changed = () => kbcxHeaderSignature(doc) !== before;

    const limit = timeoutMs || 6000;
    const targets = [tab.el];
    if (tab.el.parentElement) targets.push(tab.el.parentElement);
    const per = Math.max(1200, Math.floor(limit / targets.length));

    for (const el of targets) {
      if (!tryClick(el)) continue;
      const t0 = Date.now();
      while (Date.now() - t0 < per) {
        await sleep(150);
        if (changed()) {
          await sleep(250);          // 再等一点，让内容渲染完
          return true;
        }
      }
      if (changed()) return true;    // 最后一次机会
    }
    return false;
  }

  /**
   * 新版：点击遍历周次（API 不可用时的兜底，也用于补采 API 漏掉的周）。
   *
   * @param visit  要访问的 tab 列表（通常 = 全部；补采时只传缺失的）
   * @param allTabs 页面上全部 tab（用于采集完切回原周次）
   *
   * 每项返回 `{sid, label, range, html, courses, skipped}`。
   * `skipped=true` 表示**切换失败**（该周状态未知）；切换成功但没有课程
   * 则是「确认该周无课」（courses 为空数组，skipped=false）。
   */
  async function collectKbcxByClicking(doc, visit, allTabs, onProgress) {
    const out = [];
    const pool = allTabs || visit;
    const startSid = (pool.find((t) => t.active) || {}).sid;

    for (let i = 0; i < visit.length; i++) {
      const tab = visit[i];
      if (onProgress) onProgress(i + 1, visit.length, tab);
      const ok = await switchWeekTo(doc, tab, 8000);
      if (!ok) {
        log("周次切换超时，跳过第 " + tab.sid + " 周");
        out.push({ sid: tab.sid, label: tab.label, range: tab.range,
                   html: "", courses: [], skipped: true });
        continue;
      }
      // 用 findKbcxTableIn（不要求有课程）—— 空周也要能识别成「无课」而非「失败」
      const tbl = findKbcxTableIn(doc);
      out.push({
        sid: tab.sid,
        label: tab.label,
        range: tab.range,
        html: tbl ? tbl.outerHTML : "",
        courses: tbl ? extractWeekCourses(tbl, tab.sid) : [],
        skipped: !tbl,
      });
    }

    // 切回用户原来的周次，别把人家页面留在最后一页
    if (startSid) {
      const back = pool.find((t) => t.sid === startSid);
      if (back) await switchWeekTo(doc, back, 6000);
    }
    return out;
  }

  /**
   * 把 `"课程名(教室)"` 拆成 { course, room }。
   *
   * ⚠ 不能简单取"第一个左括号之前" —— 课程名本身可能带括号，实测有
   *   `公共体育(1)-乒乓球(雁山公体乒乓球场)`。
   *   教室一定以「雁山/育才/王城」开头（GXNU 教室命名规则），故按它定位。
   */
  function splitCourseRoom(title) {
    const t = String(title || "").trim();
    const m = t.match(/\((雁山|育才|王城)/);
    if (m && typeof m.index === "number" && m.index > 0) {
      const i = m.index;
      return {
        course: t.slice(0, i).trim(),
        // ⚠ 只去掉**最外层**那一个右括号。教室名自身可能含括号，
        //   如 `雁山理二区2-305(6-10(双),14周 混合式教学场地(线上))`，
        //   若用 /\)+$/ 会把内层的也削掉。
        room: t.slice(i + 1).replace(/\)\s*$/, "").trim(),
      };
    }
    const i = t.lastIndexOf("(");
    if (i > 0 && t.endsWith(")")) {
      return { course: t.slice(0, i).trim(), room: t.slice(i + 1, -1).trim() };
    }
    return { course: t, room: "" };
  }

  /** 把 HTML 字符串解析成 DOM（用于从 API 响应里取结构化数据）。 */
  function htmlToTable(html) {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      return doc.querySelector("table");
    } catch (e) {
      return null;
    }
  }

  /** 从新版某周表格里提取结构化课程列表。 */
  function extractWeekCourses(table, sid) {
    const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    const out = [];
    if (!table) return out;
    for (const tr of Array.from(table.querySelectorAll('tr[name="rowkb"]'))) {
      const pStart = parseInt(tr.getAttribute("sid"), 10);
      if (!Number.isFinite(pStart)) continue;
      for (const td of Array.from(tr.querySelectorAll('td[id^="Cell"]'))) {
        const p = td.querySelector("p.content-detail");
        if (!p) continue;
        const idm = (td.getAttribute("id") || "").match(/^Cell(\d)(\d+)$/);
        if (!idm) continue;
        const weekday = parseInt(idm[1], 10);
        if (!(weekday >= 1 && weekday <= 7)) continue;
        const title = (p.getAttribute("title") || p.textContent || "").trim();
        if (!title) continue;
        const span = parseInt(td.getAttribute("rowspan") || "1", 10) || 1;
        const teacherEl = td.querySelector('span[title]');
        const teacher = teacherEl
          ? (teacherEl.getAttribute("title") || "").trim() : "";
        const sp = splitCourseRoom(title);
        out.push({
          week: sid,
          weekday,
          weekdayName: WEEKDAYS[weekday - 1] || String(weekday),
          periodStart: pStart,
          periodEnd: pStart + span - 1,
          course: sp.course,
          room: sp.room,
          teacher,
          raw: title,
        });
      }
    }
    return out;
  }

  /**
   * 把多周表格拼成一份 pageHtml。
   *
   * 用 HTML 注释标出每个表属于哪一周 —— Python 端据此还原 `weeks`：
   *   `<!-- GXNU-WEEKS [...] -->`    周次元信息（sid/标签/日期范围）
   *   `<!-- GXNU-WEEK 6 -->`         紧随其后的表属于第 6 周
   *   `<!-- GXNU-PRACTICE -->`       之后的实践环节（备注行）
   */
  function buildKbcxPageHtml(doc, weeks) {
    const meta = weeks.map((w) => ({
      sid: w.sid, label: w.label, range: w.range,
    }));
    const parts = [
      "<!-- GXNU-KBCX-EXPORT v" + VERSION + " -->",
      "<!-- GXNU-WEEKS " + JSON.stringify(meta) + " -->",
    ];
    for (const w of weeks) {
      parts.push("<!-- GXNU-WEEK " + w.sid + " -->");
      parts.push(w.html);
    }
    let bz = null;
    try { bz = doc.querySelector("#bzxx"); } catch (e) { bz = null; }
    if (bz && (bz.innerHTML || "").trim()) {
      parts.push("<!-- GXNU-PRACTICE -->");
      parts.push('<div id="bzxx">' + bz.innerHTML + "</div>");
    }
    return parts.join("\n");
  }

  /**
   * 采集新版课表为完整 pageHtml（全部周次）+ 结构化数据。
   *
   * 策略：
   *   1. 先探测 API 直取（快）
   *   2. **对 API 漏掉的周用点击补采**（实测 API 会静默丢几周）
   *   3. API 完全不可用 → 全量点击遍历
   *
   * 返回 `{html, weeks, skippedWeeks, emptyWeeks}`。
   * `weeks` 只含**成功采到表格**的周；`skippedWeeks` 是切换/请求失败的周
   * （状态未知）；`emptyWeeks` 是确认无课的周。
   */
  async function collectKbcxHtml(doc, onProgress) {
    const tabs = kbcxWeekTabs(doc);
    if (!tabs.length) {
      log("新版课表：未找到周次列表，退化为「只取当前周」");
      const tbl = findKbcxTableIn(doc);
      if (!tbl) return null;
      const courses = extractWeekCourses(tbl, 0);
      return {
        html: buildKbcxPageHtml(doc, [{
          sid: 0, label: "", range: "", html: tbl.outerHTML,
        }]),
        weeks: [{ sid: 0, label: "", range: "", courses }],
        skippedWeeks: [],
        emptyWeeks: courses.length ? [] : [0],
      };
    }

    const curDates = kbcxHeaderDates(
      (doc.body ? doc.body.innerHTML : "") || "");
    const baseUrl = kbcxApiBase(doc);

    let weeks = [];
    let how = "";
    if (baseUrl && (await probeSidParam(baseUrl, tabs, curDates))) {
      weeks = await collectKbcxByApi(baseUrl, tabs, onProgress);
      how = "api";
      // ⚠ API 直取会**静默丢周**（实测 19 周只回 14 周）。
      //   对缺失的周改用点击补采 —— 既能补回失败的数据，
      //   也能**确认**剩下的周是真的没课。
      const got = new Set(weeks.map((w) => w.sid));
      const missing = tabs.filter((t) => !got.has(t.sid));
      if (missing.length) {
        log(`API 直取缺 ${missing.length} 周（${missing.map((t) => t.sid).join(",")}）`
            + "，改用点击补采确认");
        const extra = await collectKbcxByClicking(doc, missing, tabs, onProgress);
        weeks = weeks.concat(extra);
      }
    } else {
      weeks = await collectKbcxByClicking(doc, tabs, tabs, onProgress);
      how = "click";
    }
    if (!weeks.length) return null;

    const skippedWeeks = weeks.filter((w) => w.skipped).map((w) => w.sid);
    const withTable = weeks.filter((w) => w.html && !w.skipped);
    const emptyWeeks = withTable
      .filter((w) => !(w.courses || []).length)
      .map((w) => w.sid);

    log("新版课表采集完成", {
      how,
      采到: withTable.length,
      空周: emptyWeeks.length,
      失败: skippedWeeks.length,
      tabs: tabs.length,
    });
    if (skippedWeeks.length) {
      console.warn("[课表采集器] 以下周次采集失败（状态未知，已跳过）："
                   + skippedWeeks.join(","));
    }

    return {
      html: buildKbcxPageHtml(doc, withTable),
      // payload 里不塞表格 HTML（太大），只留结构化数据
      weeks: withTable.map((w) => ({
        sid: w.sid, label: w.label, range: w.range,
        courses: w.courses || [],
      })),
      skippedWeeks,
      emptyWeeks,
    };
  }

  /**
   * 统一入口：自动分辨新旧两种课表页。
   * 返回 { html, how, kbcxWeeks, skippedWeeks, emptyWeeks }。
   */
  async function acquireAnyScheduleHtml(timeoutMs, onTick, onProgress) {
    const limit = timeoutMs || 15000;
    if (findKbcxDoc()) {
      const doc = await waitForKbcx(limit, onTick);
      if (doc) {
        const r = await collectKbcxHtml(doc, onProgress);
        if (r && r.html && (pageHasSchedule(r.html) || r.weeks.length)) {
          return {
            html: r.html, how: "kbcx", kbcxWeeks: r.weeks,
            skippedWeeks: r.skippedWeeks, emptyWeeks: r.emptyWeeks,
          };
        }
      }
    }
    const legacy = await acquireScheduleHtml(limit, onTick);
    return {
      html: legacy.html, how: legacy.how, kbcxWeeks: [],
      skippedWeeks: [], emptyWeeks: [],
    };
  }

  /** 采集失败时输出诊断，便于定位问题。 */
  function diagnostics() {
    const yz = isYzdxApp() ? yzdxCapture() : null;
    const out = [
      "URL: " + location.href,
      "是否顶层窗口: " + isTopWindow(),
      "页面类型: " + (isYzdxApp()
          ? (yz ? "易班「易知独秀」课表（dean/course，已捕获接口响应）"
                : "易班「易知独秀」（浏览器侧尚未捕获到接口响应）")
          : findKbcxDoc() ? "新版课表查询（api/getKbxx）"
          : findScheduleDoc() ? "旧版我的课表" : "未识别"),
    ];
    if (isYzdxApp()) {
      const W = pageWindow();
      const cap = W[YZDX_CAP_KEY];
      out.push("易班钩子已安装: " + !!W[YZDX_HOOK_KEY]);
      if (cap) {
        out.push("  捕获时间: " + (cap.at || "(无)"));
        out.push("  响应 code: " +
                 (cap.payload && cap.payload.code !== undefined
                    ? cap.payload.code : "(无)"));
        out.push("  捕获错误: " + (cap.error || "(无)"));
      } else {
        out.push("  捕获对象: (不存在 —— 钩子未赶上本次页面加载，刷新即可)");
      }
      if (yz) {
        out.push("  周次键数: " + Object.keys(yz.data.course || {}).length
                 + "，当前教学周: " + yz.data.current);
        out.push("  学期: " + (yz.data.semester || "(未提供)"));
      }
      return out.join("\n");
    }
    let i = 0;
    for (const doc of collectDocuments(window)) {
      let tables = "?", cells = "?", filled = "?", iframes = "?", here = "";
      try { tables = doc.querySelectorAll("table").length; } catch (e) {}
      try {
        cells = doc.querySelectorAll('[data-jcindex], [data-jcIndex], ' +
                                    '[class*="cell"], p.content-detail').length;
      } catch (e) {}
      try {
        filled = countFilledCells(doc) + countKbcxFilledCells(doc);
      } catch (e) {}
      try { iframes = doc.querySelectorAll("iframe").length; } catch (e) {}
      try { here = doc.location ? doc.location.href : ""; } catch (e) {}
      out.push(`  doc[${i++}] table=${tables} cell=${cells} filled=${filled} ` +
               `iframe=${iframes} ${here.slice(0, 100)}`);
    }
    const kdoc = findKbcxDoc();
    if (kdoc) {
      const tabs = kbcxWeekTabs(kdoc);
      const act = tabs.find((t) => t.active);
      out.push("课表查询页：周次 tab " + tabs.length + " 个，当前第 " +
               (act ? act.sid : "?") + " 周");
      out.push("  周次: " + tabs.map((t) => t.sid).join(","));
      out.push("  API 基址: " + (kbcxApiBase(kdoc) || "(未发现)").slice(0, 130));
      out.push("  表头日期: " +
               kbcxHeaderDates(kdoc.body ? kdoc.body.innerHTML : "").join(","));
    }
    out.push("课表 URL: " + (findScheduleUrl() || "(未发现)"));
    out.push("判定阈值: filled >= " + MIN_FILLED_CELLS + " 才算真课表");
    return out.join("\n");
  }

  /** 结构化提取（尽力而为；Python 端以 pageHtml 为准）。 */
  function extractStructured() {
    const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    const rows = [];

    // --- 新版「课表查询」页 ---
    const kdoc = findKbcxDoc();
    if (kdoc) {
      for (const table of findTablesIn(kdoc)) {
        for (const tr of Array.from(table.querySelectorAll('tr[name="rowkb"]'))) {
          const pStart = parseInt(tr.getAttribute("sid"), 10);
          if (!Number.isFinite(pStart)) continue;
          for (const td of Array.from(tr.querySelectorAll('td[id^="Cell"]'))) {
            const idm = (td.getAttribute("id") || "").match(/^Cell(\d)(\d+)$/);
            if (!idm) continue;
            const weekday = parseInt(idm[1], 10);
            if (!(weekday >= 1 && weekday <= 7)) continue;
            const p = td.querySelector("p.content-detail");
            if (!p) continue;
            const title = (p.getAttribute("title") || p.textContent || "").trim();
            if (!title) continue;
            const span = parseInt(td.getAttribute("rowspan") || "1", 10) || 1;
            rows.push({
              weekday,
              weekdayName: WEEKDAYS[weekday - 1] || String(weekday),
              periodStart: pStart,
              periodEnd: pStart + span - 1,
              text: title,
              lines: [title],
            });
          }
        }
      }
      if (rows.length) return rows;
    }

    // --- 旧版「我的课表」（强智表格） ---
    for (const table of findScheduleTables()) {
      for (const tr of Array.from(table.querySelectorAll("tr"))) {
        const cells = Array.from(tr.querySelectorAll("td, th"));
        if (cells.length < 3) continue;
        const head = (cells[0].innerText || "").trim();
        const pm = head.match(/第?\s*(\d+)\s*[-~至]?\s*(\d+)?\s*节/);
        const pStart = pm ? parseInt(pm[1], 10) : null;
        const pEnd = pm && pm[2] ? parseInt(pm[2], 10) : pStart;

        for (let i = 1; i < cells.length && i <= 7; i++) {
          const txt = (cells[i].innerText || "").trim();
          if (!txt || txt === "-" || txt === "—") continue;
          rows.push({
            weekday: i,
            weekdayName: WEEKDAYS[i - 1] || String(i),
            periodStart: pStart,
            periodEnd: pEnd,
            text: txt,
            lines: txt.split("\n").map((s) => s.trim()).filter(Boolean),
          });
        }
      }
    }
    return rows;
  }

  function collect(pageHtmlOverride, extra) {
    const ex = extra || {};
    // 易班页面的姓名/学期等信息不在 DOM 里，由调用方通过 metaOverride 注入
    const meta = Object.assign(extractMeta(), ex.metaOverride || {});
    const kdoc = findKbcxDoc();
    const yzdxWeeks = ex.yzdxWeeks || [];
    const weeksMeta = yzdxWeeks.length
      ? yzdxWeeks.map((w) => ({ sid: w.sid, label: w.label, range: w.range }))
      : kdoc
        ? kbcxWeekTabs(kdoc).map((t) => ({
            sid: t.sid, label: t.label, range: t.range,
          }))
        : [];
    return {
      schemaVersion: 1,
      collector: "gxnu-userscript",
      collectorVersion: VERSION,
      collectedAt: new Date().toISOString(),
      pageUrl: location.href,
      pageTitle: document.title,
      pageKind: yzdxWeeks.length ? "yzdx" : (kdoc ? "kbcx" : "xskb"),
      semester: meta.semester,
      semesterCode: meta.semesterCode,
      currentWeek: meta.currentWeek,
      weeks: weeksMeta,
      student: { name: meta.name, studentId: meta.studentId },
      className: meta.className,
      structuredRows: extractStructured(),
      /** 新版课表页：各周次的结构化课程（脚本端 DOM 解析，比字符串解析可靠） */
      kbcxWeeks: ex.kbcxWeeks || [],
      /**
       * 易班「易知独秀」课表页：各周次的结构化课程。
       * 字段形状与 `kbcxWeeks` 完全一致（见 buildYzdxWeeks 的说明），
       * 同步脚本两条来源走同一个解析器。
       */
      yzdxWeeks: yzdxWeeks,
      /** 本次数据覆盖到的**全部**周次（含该周无课的情况，用于识别"课被取消"） */
      touchedWeeks: ex.touchedWeeks || [],
      /** 采集失败的周次（状态未知，同步脚本不会据此删除既有数据） */
      skippedWeeks: ex.skippedWeeks || [],
      /** 确认无课的周次（页面正常但该周没有课程卡片） */
      emptyWeeks: ex.emptyWeeks || [],
      pageHtml: pageHtmlOverride || grabScheduleHtml(),
    };
  }

  /* ====================== 导出 ====================== */

  const pad = (n) => String(n).padStart(2, "0");

  function filename() {
    const d = new Date();
    const stamp =
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `course-schedule-${stamp}.json`;
  }

  function saveJson(payload, name) {
    const text = JSON.stringify(payload, null, 2);
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    if (typeof GM_download === "function") {
      try {
        GM_download({
          url,
          name,
          saveAs: false,
          onload: () => URL.revokeObjectURL(url),
          onerror: (e) => {
            log("GM_download 失败，回退到 <a download>", e);
            fallbackAnchor(url, name);
          },
        });
        return true;
      } catch (e) {
        log("GM_download 异常，回退", e);
      }
    }
    fallbackAnchor(url, name);
    return true;
  }

  function fallbackAnchor(url, name) {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ====================== 面板 UI ====================== */

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const box = document.createElement("div");
    box.id = PANEL_ID;
    box.innerHTML = `
      <div class="gxnu-hd">
        <span class="gxnu-title">📚 课表采集器</span>
        <button class="gxnu-x" title="收起">×</button>
      </div>
      <div class="gxnu-bd">
        <div class="gxnu-status">就绪</div>
        <button class="gxnu-btn gxnu-primary">采集并导出课表</button>
      </div>`;

    const style = document.createElement("style");
    style.textContent = `
      #${PANEL_ID} {
        position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
        width: 236px; font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        background: #ffffff; border: 1px solid #d7dbe0; border-radius: 10px;
        box-shadow: 0 6px 24px rgba(0,0,0,.14); overflow: hidden;
        color: #22252a;
      }
      #${PANEL_ID} .gxnu-hd {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 10px; background: #f4f6f8; border-bottom: 1px solid #e6e9ed;
      }
      #${PANEL_ID} .gxnu-title { font-weight: 600; font-size: 13px; }
      #${PANEL_ID} .gxnu-x {
        border: 0; background: transparent; font-size: 18px; line-height: 1;
        cursor: pointer; color: #8a9099; padding: 0 2px;
      }
      #${PANEL_ID} .gxnu-x:hover { color: #22252a; }
      #${PANEL_ID} .gxnu-bd { padding: 10px; }
      #${PANEL_ID} .gxnu-status {
        font-size: 12px; color: #5b6169; margin-bottom: 8px;
        min-height: 18px; word-break: break-all;
      }
      #${PANEL_ID} .gxnu-status.gxnu-ok  { color: #177245; }
      #${PANEL_ID} .gxnu-status.gxnu-err { color: #c0392b; }
      #${PANEL_ID} .gxnu-btn {
        width: 100%; padding: 7px 10px; border-radius: 6px; cursor: pointer;
        border: 1px solid #c8cdd4; background: #fff; font-size: 13px; color: #22252a;
      }
      #${PANEL_ID} .gxnu-btn:hover { background: #f7f8fa; }
      #${PANEL_ID} .gxnu-primary {
        background: #2f6fd0; border-color: #2f6fd0; color: #fff; font-weight: 600;
      }
      #${PANEL_ID} .gxnu-primary:hover { background: #2860b8; }
      #${PANEL_ID}.gxnu-collapsed { width: auto; }
      #${PANEL_ID}.gxnu-collapsed .gxnu-bd { display: none; }
      #${PANEL_ID}.gxnu-collapsed .gxnu-x { transform: rotate(45deg); }
      @media (prefers-color-scheme: dark) {
        #${PANEL_ID} { background:#26282c; border-color:#3a3d43; color:#e6e8ea; }
        #${PANEL_ID} .gxnu-hd { background:#2e3136; border-bottom-color:#3a3d43; }
        #${PANEL_ID} .gxnu-status { color:#a8aeb6; }
        #${PANEL_ID} .gxnu-btn { background:#2e3136; border-color:#474b52; color:#e6e8ea; }
        #${PANEL_ID} .gxnu-btn:hover { background:#3a3d43; }
        #${PANEL_ID} .gxnu-primary { background:#3b7dd8; border-color:#3b7dd8; }
      }`;
    document.head.appendChild(style);
    document.body.appendChild(box);

    const statusEl = box.querySelector(".gxnu-status");
    const setStatus = (t, cls) => {
      statusEl.textContent = t;
      statusEl.className = "gxnu-status" + (cls ? " " + cls : "");
    };

    box.querySelector(".gxnu-x").onclick = () =>
      box.classList.toggle("gxnu-collapsed");

    box.querySelector(".gxnu-primary").onclick = async () => {
      try {
        // ★ 易班「易知独秀」课表页：数据来自被捕获的接口响应，
        //   既不走 DOM 解析，也不自己发请求（见文件顶部 v1.7.0 说明）。
        //   它的判断必须放在最前面 —— 那一页没有 <table>，
        //   下面的 detectEmptyResponse / acquireAnyScheduleHtml 都不适用。
        if (isYzdxApp()) {
          setStatus("读取易班课表数据…");
          const got = yzdxCapture();
          if (!got) {
            setStatus("未捕获到课表数据：请确认已登录并停在课表页，"
                      + "然后刷新本页（F5）重试", "gxnu-err");
            return;
          }
          const zp = buildYzdxPayload(got.data);
          if (!zp) {
            setStatus("已捕获接口响应，但不含课程（该学期可能未发布）", "gxnu-err");
            return;
          }
          saveJson(zp, filename());
          const wk = (zp.yzdxWeeks || []).length;
          const rows = (zp.yzdxWeeks || [])
            .reduce((n, w) => n + (w.courses || []).length, 0);
          setStatus(`已导出（${rows} 条记录，${wk} 周）`, "gxnu-ok");
          log("易班课表导出完成", {
            rows, weeks: wk, semester: got.data.semester,
          });
          return;
        }

        if (detectEmptyResponse()) {
          setStatus("该页返回「学期暂未发布」，请切到「我的课表」页再采集", "gxnu-err");
          return;
        }
        setStatus("等待课表加载…");
        // 等**课程填充完成**（空模板不算）→ 等不到再同源直取课表页 URL
        // 新版「课表查询」页会逐周采集，故额外传进度回调
        const WAIT_MS = 15000;
        const res = await acquireAnyScheduleHtml(
          WAIT_MS,
          (ms) => {
            const left = Math.max(0, Math.ceil((WAIT_MS - ms) / 1000));
            setStatus(`等待课表加载…（课程尚未出现，剩余 ${left}s）`);
          },
          (i, total, tab) => {
            setStatus(`采集中…第 ${i}/${total} 周${tab && tab.label ? "（" + tab.label + "）" : ""}`);
          }
        );
        const { html, how } = res;
        if (!html) {
          const diag = diagnostics();
          console.warn("[课表采集器] 未取到已填充的课表，诊断信息：\n" + diag);
          setStatus("未找到已填充的课表。请打开「我的课表」/「课表查询」"
                    + "并确认表格里已经显示课程；诊断已打印到控制台（F12）", "gxnu-err");
          return;
        }

        setStatus("采集中…");
        const payload = collect(html, res);
        const n = payload.structuredRows.length;
        // 硬护栏：必须含**已填充**课程单元格，否则拒绝导出
        if (!pageHasSchedule(payload.pageHtml)) {
          const filled = countFilledCellsInHtml(payload.pageHtml) +
                         countKbcxFilledInHtml(payload.pageHtml);
          setStatus(`拒绝导出：课表未填充（非空单元格 ${filled} 个）`, "gxnu-err");
          log("采集被拒绝：pageHtml 无已填充课程", { filledCells: filled });
          return;
        }
        saveJson(payload, filename());
        const via = how === "fetch" ? "，同源直取"
                  : how === "kbcx" ? `，课表查询页（${(payload.kbcxWeeks || []).length} 周）`
                  : "";
        setStatus(`已导出（${n} 条记录${via}）`, "gxnu-ok");
        log("导出完成", { rows: n, htmlLen: payload.pageHtml.length, how });
      } catch (e) {
        setStatus("失败：" + e.message, "gxnu-err");
        console.error("[课表采集器] 采集失败", e);
      }
    };

    return { box, setStatus };
  }

  /* ====================== 自动采集（可选） ====================== */

  /**
   * 在你设定的「采集窗口」内自动导出一次（每天最多一次）。
   * 默认窗口：周日 12:00–23:59（与每周日同步任务对齐）。
   */
  function inAutoWindow() {
    const now = new Date();
    return now.getDay() === 0 && now.getHours() >= 12;
  }

  async function maybeAutoCollect(setStatus) {
    if (!inAutoWindow()) return;
    if (detectEmptyResponse()) return;
    try {
      const today = new Date().toISOString().slice(0, 10);
      let last = null;
      if (typeof GM_getValue === "function") {
        last = await GM_getValue(AUTO_KEY, null);
      } else if (typeof GM !== "undefined" && GM.getValue) {
        last = await GM.getValue(AUTO_KEY, null);
      } else {
        last = localStorage.getItem(AUTO_KEY);
      }
      if (last === today) {
        setStatus("今日已自动采集", "gxnu-ok");
        return;
      }

      let payload = null;
      let how = "";

      if (isYzdxApp()) {
        // 易班页：直接用钩子捕获到的接口响应（不读 token、不发额外请求）
        const got = yzdxCapture();
        if (!got) {
          log("自动采集跳过：未捕获易班课表数据（可能钩子未赶上，刷新即可）");
          return;
        }
        payload = buildYzdxPayload(got.data);
        if (!payload) {
          log("自动采集跳过：易班课表数据里没有任何课程");
          return;
        }
        how = "yzdx";
      } else {
        // 等待课表就绪；DOM 等不到就同源直取（新版课表页会逐周采集）
        const res = await acquireAnyScheduleHtml(15000);
        const html = res.html;
        if (!html) {
          log("自动采集跳过：未取到课表");
          return;
        }
        payload = collect(html, res);
        if (!pageHasSchedule(payload.pageHtml)) {
          log("自动采集跳过：pageHtml 无课表标志");
          return;
        }
        how = res.how;
      }

      saveJson(payload, filename());
      log("自动采集完成", { how });

      if (typeof GM_setValue === "function") {
        await GM_setValue(AUTO_KEY, today);
      } else if (typeof GM !== "undefined" && GM.setValue) {
        await GM.setValue(AUTO_KEY, today);
      } else {
        localStorage.setItem(AUTO_KEY, today);
      }
      setStatus("已自动导出", "gxnu-ok");
    } catch (e) {
      log("自动采集失败", e);
    }
  }

  /* ====================== 菜单命令 ====================== */

  function registerMenus() {
    if (typeof GM_registerMenuCommand !== "function") return;
    GM_registerMenuCommand("立即采集并导出课表", async () => {
      if (isYzdxApp()) {
        const got = yzdxCapture();
        const zp = got && buildYzdxPayload(got.data);
        if (!zp) {
          console.warn("[课表采集器] 诊断\n" + diagnostics());
          alert("未取到易班课表数据，未导出。\n"
                + "请确认已登录并停在「课表」页，然后刷新页面（F5）再试 ——\n"
                + "采集依赖页面加载时挂上的钩子，刷新后即可捕获。\n"
                + "诊断信息已打印到控制台（F12）。");
          return;
        }
        saveJson(zp, filename());
        const wk = (zp.yzdxWeeks || []).length;
        const rows = (zp.yzdxWeeks || [])
          .reduce((n, w) => n + (w.courses || []).length, 0);
        alert(`已导出：${filename()}\n`
              + `易班课表：${rows} 条排课记录，覆盖 ${wk} 个周次`);
        return;
      }
      const res = await acquireAnyScheduleHtml(15000);
      const { html, how } = res;
      if (!html) {
        console.warn("[课表采集器] 诊断\n" + diagnostics());
        alert("未找到课表表格，未导出。\n"
              + "请确认已打开「我的课表」或「课表查询」并等表格出现。\n"
              + "诊断信息已打印到控制台（F12）。");
        return;
      }
      const p = collect(html, res);
      if (!pageHasSchedule(p.pageHtml)) {
        alert("未找到课表表格，未导出。\n"
              + "请确认已打开「我的课表」或「课表查询」并等表格出现。");
        return;
      }
      saveJson(p, filename());
      const extra = how === "fetch" ? "\n（经同源直取取得）"
                  : how === "kbcx" ? "\n（课表查询页，已采 " +
                      (p.kbcxWeeks || []).length + " 个周次）"
                  : "";
      alert(`已导出：${filename()}\n结构化记录 ${p.structuredRows.length} 条` + extra);
    });
    GM_registerMenuCommand("诊断：输出页面结构到控制台", () => {
      const diag = diagnostics();
      console.log("[课表采集器] 诊断\n" + diag);
      alert("诊断信息已打印到控制台（F12 → Console）：\n\n" + diag);
    });
    GM_registerMenuCommand("重置自动采集标记", async () => {
      if (typeof GM_setValue === "function") {
        await GM_setValue(AUTO_KEY, null);
      } else if (typeof GM !== "undefined" && GM.setValue) {
        await GM.setValue(AUTO_KEY, null);
      } else {
        localStorage.removeItem(AUTO_KEY);
      }
      alert("已重置，刷新页面后会重新自动采集（若在窗口内）");
    });
  }

  /* ====================== 启动 ====================== */

  /** 是否为顶层窗口（面板只在顶层显示，避免每个 iframe 都冒一个）。 */
  function isTopWindow() {
    try {
      return window.top === window.self;
    } catch (e) {
      return false;                    // 跨源被拒 → 视为子帧
    }
  }

  /**
   * 监听同源 iframe 的 load 事件 —— 课表 iframe 是异步渲染的，
   * 加载完成后刷新面板状态（并把"未找到课表"纠正为就绪）。
   *
   * 注意：**按 iframe 元素遍历**，不用 window.frames 下标匹配
   * （两者顺序/数量可能不一致，曾导致漏监听真正的课表 iframe）。
   */
  /** 易班页的面板状态文案。 */
  function yzdxStatusText() {
    if (/\/login(\/|$)/.test(location.pathname)) {
      return { t: "易班登录页：登录后进入「课表」页即可采集", c: "" };
    }
    const got = yzdxCapture();
    if (!got) {
      return { t: "未捕获到课表接口响应 —— 请刷新本页（F5）", c: "gxnu-err" };
    }
    const weeks = buildYzdxWeeks(got.data);
    const rows = weeks.reduce((n, w) => n + w.courses.length, 0);
    if (!rows) {
      return { t: "已捕获接口响应，但该学期暂无课程安排", c: "gxnu-err" };
    }
    return {
      t: `已就绪（易班课表：${rows} 条记录 / ${weeks.length} 周）`,
      c: "gxnu-ok",
    };
  }

  function watchFrames(setStatus) {
    const refresh = () => {
      if (isYzdxApp()) {
        const s = yzdxStatusText();
        setStatus(s.t, s.c);
        return;
      }
      if (detectEmptyResponse()) {
        setStatus("该页返回「学期暂未发布」，请切到「我的课表」", "gxnu-err");
      } else if (findKbcxDoc() && findScheduleTables().length) {
        const tabs = kbcxWeekTabs(findKbcxDoc());
        setStatus(`已就绪（课表查询页，共 ${tabs.length} 个周次）`, "gxnu-ok");
      } else if (findScheduleTables().length) {
        setStatus("已就绪（找到课表）", "gxnu-ok");
      } else {
        setStatus("未找到课表，请在「我的课表」或「课表查询」页采集", "gxnu-err");
      }
    };
    const attach = (doc, depth) => {
      if (!doc || depth > 3) return;
      let frames = [];
      try {
        frames = Array.from(doc.querySelectorAll("iframe"));
      } catch (e) {
        return;
      }
      for (const el of frames) {
        if (!el.dataset.gxnuWatched) {
          el.dataset.gxnuWatched = "1";
          el.addEventListener("load", () => setTimeout(refresh, 600));
        }
        let child = null;
        try { child = el.contentDocument; } catch (e) { child = null; }
        if (child) attach(child, depth + 1);
      }
    };
    attach(document, 0);
    // 初次与延迟各刷新一次，覆盖已加载/稍后渲染两种情况
    setTimeout(refresh, 300);
    setTimeout(refresh, 2000);
    setTimeout(refresh, 5000);
    return refresh;
  }

  function boot() {
    // 子 iframe 内不建面板，但仍参与数据提取（供顶层跨帧读取）
    if (!isTopWindow()) {
      log("子帧已就绪（无面板），等待顶层采集 v" + VERSION);
      return;
    }
    const { setStatus } = buildPanel();
    registerMenus();
    const refreshStatus = watchFrames(setStatus);
    log("已就绪 v" + VERSION);
    // 易班页的接口响应在页面挂载后才回来 → 轮询几十秒，让面板状态自动更新
    if (isYzdxApp()) {
      let n = 0;
      const timer = setInterval(() => {
        refreshStatus();
        if (yzdxCapture() || ++n >= 40) clearInterval(timer);
      }, 1500);
    }
    // 延迟自动采集，等课表 iframe 渲染稳定
    setTimeout(() => maybeAutoCollect(setStatus), 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
