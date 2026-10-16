#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
sync_course_schedule.py
=======================
把教务系统的课表同步到 Obsidian，**只在课表发生变更时提醒**。

数据源
------
优先读取油猴脚本「GXNU 课表采集器」(`gxnu-course-collector.user.js`) 导出的
`course-schedule-*.json`；若没有，则回退到 **Edge 默认下载目录**（`~/Downloads`）
里的原始网页文件，支持三种格式：

1. `course-schedule-*.json` —— 油猴脚本导出（含课表区 HTML）
2. `*.mhtml` —— Edge「网页另存为单个文件」，从中定位 `queryKbForXsd` 分区
3. `*.html` —— 直接另存的课表页

**不改动浏览器下载路径**：脚本只读默认下载目录，不写入、不搬迁用户的下载文件。

为何不用 Cookie 抓取
--------------------
实测（2026-09-22）：新版 Edge 启用 App-Bound Encryption，Cookie 值前缀为
`v20`，其密钥 `app_bound_encrypted_key` 前缀 `APPB`，受双层 DPAPI +
浏览器进程身份绑定保护，**无法离线解密**。故改由浏览器自身导出数据。

设计要点
--------
1. 只读 Edge 默认下载目录（+ 采集器 JSON 目录），用 sha256 记录已消费项。
2. 只做「增量比较」：解析结果与上次状态对比，**有变更才提示**。
3. 变更前自动备份到 课表/.backup/（备份目录只增不删）。
4. 首次运行建立基线，不算变更。
5. 隐私：不输出 Cookie/学号到日志；学号仅用于生成文件头。

退出码
------
0 = 正常（无变更 / 首次建基线）
1 = 有变更（已更新）
2 = 未找到可用导出文件（需先在浏览器另存课表页）
3 = 解析失败
4 = 检测到目标文件含手工内容，已中止写入

用法
----
    python sync_course_schedule.py                # 完整同步
    python sync_course_schedule.py --list-exports # 查看候选文件
    python sync_course_schedule.py --dry-run      # 只比对不动文件
    python sync_course_schedule.py --show-current # 打印当前周课表
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import re
import shutil
import sys
from dataclasses import dataclass, asdict, field, replace
from datetime import datetime, date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# Obsidian Vault 路径：优先取环境变量 KB_VAULT，缺省为本机 ~/Documents/Obsidian Vault
VAULT = Path(os.environ.get("KB_VAULT") or (Path.home() / "Documents" / "Obsidian Vault"))
KB_DIR = VAULT / "课表"
BACKUP_DIR = KB_DIR / ".backup"
STATE_FILE = HERE / "schedule_state.json"
LOG_FILE = HERE / "sync_log.jsonl"

# 课表页 URL（供人工另存时参考；数据由浏览器导出，脚本不直接请求）
SEMESTER = "2026-2027-1"

# 渲染格式版本号。**改动 render_* 输出结构时必须 +1**，
# 否则课表条目没变 → 状态判定「无变更」→ 新格式永远不落地。
#   1: 原始单视图（课程汇总 + 逐周混在一个文件）
#   2: 拆成两个视图；逐周表加「日期」列
#   3: 逐周视图只保留「本周及之后」，本周置顶（已过完的周不再渲染）
#   4: 周视图改为**网格表**（7 列 × 12 节，仿手机课表 App）；
#      新增「月视图」（逐日排列）；原 `_按周次.md` 更名 `_周视图.md`
RENDER_VERSION = 4
SCHEDULE_PAGE_URL = (
    "https://jwjx.gxnu.edu.cn/jw/admin/xsd/pkgl/xskb/queryKbForXsd"
    f"?xnxq={SEMESTER}"
)
# 入口页（原 sdpkkbList 已返回「学期暂未发布」，改用 admin 首页进入）
PORTAL_URL = "https://jwjx.gxnu.edu.cn/jw/admin"

# 本地配置（学号等页面 DOM 中不出现的信息，从 config.json 读取）
CONFIG_FILE = HERE / "config.json"


def load_config() -> dict:
    """读取本地配置；缺省时返回空 dict（不报错）。"""
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


# 校历第 1 周周一（用于计算当前周次）
WEEK1_MONDAY = date(2026, 8, 31)

# 节次时间表 —— **必须按校区取值**（两校区作息不同）
# 来源：《广西师范大学作息时间表》
#
#   王城、育才校区：第一、二节 8:00-9:20；第四节 10:30-11:10；
#                   第五节 11:20-12:00；第六节 14:30-15:10 …
#   雁山校区：      第一、二节 8:20-9:40；第四、五节 10:40-12:00；
#                   第六节 14:10-14:50 …
#
# 早期版本只写了王城/育才一套，导致雁山学生看到的每节课时间全部偏早
# （如第 1 节误显示 8:00-8:40，实际应为 8:20-9:00）。
PERIOD_TIMES_YANSHAN = {
    1: "8:20-9:00", 2: "9:00-9:40", 3: "9:50-10:30", 4: "10:40-11:20",
    5: "11:20-12:00", 6: "14:10-14:50", 7: "15:00-15:40", 8: "15:50-16:30",
    9: "16:40-17:20", 10: "19:10-19:50", 11: "20:00-20:40", 12: "20:50-21:30",
}
PERIOD_TIMES_YUCAI = {          # 育才 / 王城校区
    1: "8:00-8:40", 2: "8:40-9:20", 3: "9:30-10:10", 4: "10:30-11:10",
    5: "11:20-12:00", 6: "14:30-15:10", 7: "15:20-16:00", 8: "16:10-16:50",
    9: "17:00-17:40", 10: "19:30-20:10", 11: "20:20-21:00", 12: "21:10-21:50",
}
# 兼容旧引用（默认取王城/育才）
PERIOD_TIMES = PERIOD_TIMES_YUCAI


def period_times_for(campus: str) -> dict[int, str]:
    """按校区返回节次时间表。含「雁山」即用雁山作息，否则用育才/王城。"""
    return PERIOD_TIMES_YANSHAN if "雁山" in (campus or "") else PERIOD_TIMES_YUCAI


def fmt_periods(periods: list[int]) -> str:
    """把节次列表格式化为区间串：单节写 '8'，连堂写 '3-5'。"""
    if not periods:
        return "-"
    lo, hi = min(periods), max(periods)
    return str(lo) if lo == hi else f"{lo}-{hi}"


def fmt_period_time(periods: list[int], campus: str = "") -> str:
    """把节次列表格式化为起止时间串，如 '9:50-12:00'。需传校区以取正确作息。"""
    if not periods:
        return "-"
    times = period_times_for(campus)
    lo, hi = min(periods), max(periods)
    start = times.get(lo, "?").split("-")[0]
    end = times.get(hi, "?").split("-")[-1]
    return f"{start}-{end}"


def fmt_weeks(weeks: list[int]) -> str:
    """把周次列表压缩成可读串。

    连续区间合并为 'a-b'；若构成步长 2 的等差序列（且 ≥3 项）则标注单/双周。
    例：[4,5,6,7,8,9] → '4-9周'；[7,9,11,13] → '7-13(单)周'；
        [5,7,8,...,17] → '5,7-17周'
    """
    ws = sorted({w for w in (weeks or []) if w > 0})
    if not ws:
        return ""
    if len(ws) >= 3 and ws == list(range(ws[0], ws[-1] + 1, 2)):
        label = "单" if ws[0] % 2 == 1 else "双"
        return f"{ws[0]}-{ws[-1]}({label})周"
    segs: list[tuple[int, int]] = []
    start = prev = ws[0]
    for w in ws[1:]:
        if w == prev + 1:
            prev = w
            continue
        segs.append((start, prev))
        start = prev = w
    segs.append((start, prev))
    parts = [str(a) if a == b else f"{a}-{b}" for a, b in segs]
    return ",".join(parts) + "周"

WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
# 周视图表头用的星期中文名（列头写作「周一」/「星期日」）
WEEKDAY_CN = ["一", "二", "三", "四", "五", "六", "日"]

# 全角 → 半角映射（只处理课表里实际会出现的符号）
_FULL2HALF_MAP = str.maketrans({
    "（": "(", "）": ")", "，": ",", "：": ":", "；": ";",
    "　": " ", "－": "-", "～": "~",
})


def _norm_text(s: str) -> str:
    """课表文本归一化：全角标点转半角、压缩空白。

    教务系统的**同一门课在不同页面写法不一致** —— 实测「我的课表」页写作
    `公共体育（1）-乒乓球`（全角括号），而「课表查询」页写作
    `公共体育(1)-乒乓球`（半角）。不归一化会导致同一门课被判定为
    「新增 + 移除」，产生虚假变更提醒。
    """
    t = str(s or "").translate(_FULL2HALF_MAP)
    return re.sub(r"[ \t\u3000]+", " ", t).strip()


# 教室名的校区前缀：**新旧页面写法不一致** —— 实测同一间教室，
# 「我的课表」写作 `雁山学生探究性自主学习`，「课表查询」写作
# `学生探究性自主学习`。比较时统一去掉前缀，否则同一门课会被报成
# 「新增 + 移除」。（key 的第 6 段才是教室，`|` 后紧跟的校区名只可能属于它。）
_ROOM_CAMPUS_PREFIX_RE = re.compile(r"\|(雁山|育才|王城)")


def _norm_key_text(k: str) -> str:
    """比较用归一化：`_norm_text` + 去掉所有空白 + 去掉教室的校区前缀。"""
    t = re.sub(r"\s+", "", _norm_text(k))
    return _ROOM_CAMPUS_PREFIX_RE.sub("|", t)


@dataclass
class CourseEntry:
    """一条排课记录（课程 + 时间 + 教室 的唯一组合）。"""
    course: str
    teacher: str
    weekday: int          # 1-7
    periods: list[int]    # 如 [3,4,5]
    weeks: list[int]      # 展开后的周次列表
    room: str
    raw_weeks: str = ""   # 原始的周次描述串（便于保真还原）

    def __post_init__(self) -> None:
        # 统一全角/半角与空白：两个教务页面写法不一致，
        # 不归一化会让同一门课被当成两条（虚假变更）。
        self.course = _norm_text(self.course)
        self.teacher = _norm_text(self.teacher)
        self.room = _norm_text(self.room)

    @property
    def key(self) -> str:
        """用于变更比较的稳定标识。"""
        wk = ",".join(str(w) for w in sorted(self.weeks))
        pd = ",".join(str(p) for p in sorted(self.periods))
        return f"{self.weekday}|{self.course}|{self.teacher}|{pd}|{wk}|{self.room}"


@dataclass
class Schedule:
    semester: str = SEMESTER
    name: str = ""
    student_id: str = ""
    campus: str = ""
    entries: list[CourseEntry] = field(default_factory=list)
    practices: list[str] = field(default_factory=list)
    fetched_at: str = ""
    # 本次数据覆盖了哪些周次。新版「课表查询」页一次只给一周，
    # 拿到的是「部分周次」→ 主流程需与既有课表合并，不能整体覆盖
    # （见 apply_partial_merge）。
    touched_weeks: list[int] = field(default_factory=list)

    def to_state(self) -> dict:
        return {
            "semester": self.semester,
            "fetched_at": self.fetched_at,
            "entry_count": len(self.entries),
            "keys": sorted(e.key for e in self.entries),
            # 完整条目：新版单周数据需要与既有课表合并，
            # 只有 keys 无法还原条目，故一并存下。
            "entries": [asdict(e) for e in self.entries],
            "render_version": RENDER_VERSION,
        }


# --- 周次解析 --------------------------------------------------------------
def parse_weeks(text: str) -> list[int]:
    """把周次描述解析为周次列表。

    支持形式：
      "4,5,6-8"          → [4,5,6,7,8]
      "5,7-16"           → [5,7,...,16]
      "4-16周"           → [4..16]
      "7-13(单)周"       → [7,9,11,13]     单周
      "8-14(双)周"       → [8,10,12,14]    双周
    """
    text = (text or "").strip()
    if not text or text in {"—", "-", "无"}:
        return []
    weeks: set[int] = set()
    for part in re.split(r"[,，、;\s]+", text):
        part = part.strip()
        if not part:
            continue
        # 识别单双周标记
        is_odd = "单" in part
        is_even = "双" in part
        cleaned = re.sub(r"[（(]?[单双][）)]?", "", part)
        cleaned = cleaned.replace("第", "").replace("周", "").strip()
        if not cleaned:
            continue
        m = re.match(r"^(\d+)\s*[-~至]\s*(\d+)$", cleaned)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            rng = range(min(a, b), max(a, b) + 1)
            if is_odd:
                rng = [w for w in rng if w % 2 == 1]
            elif is_even:
                rng = [w for w in rng if w % 2 == 0]
            weeks.update(rng)
        else:
            m2 = re.match(r"^(\d+)$", cleaned)
            if m2:
                weeks.add(int(m2.group(1)))
    return sorted(weeks)


def current_week(today: date | None = None) -> int:
    """按校历推算当前教学周次（第 1 周起始日为 WEEK1_MONDAY）。"""
    today = today or date.today()
    delta = (today - WEEK1_MONDAY).days
    return delta // 7 + 1


# --- HTML 解析 -------------------------------------------------------------
def parse_schedule_html(html: str) -> Schedule:
    """解析教务课表页 HTML → Schedule。

    自动分辨两种教务页面：
      · 旧版「我的课表」(`queryKbForXsd`) —— 表格含 `class="cell"` / `data-jcindex`
      · 新版「课表查询」(`api/getKbxx`)   —— 表格行含 `name="rowkb"`，
        课程在 `p.content-detail` 里（**没有** `class="cell"`）
      · 易班「易知独秀」(`/yzdx/dean/course`) —— CSS Grid，课程卡片
        以 `grid-area` 定位（连 `<table>` 都没有）

    旧版再按「网格 → 列表」双策略解析，并对结果做完整性校验。
    """
    if _is_yzdx_html(html):
        return parse_yzdx_schedule(html)
    if _is_kbcx_html(html):
        return parse_kbcx_schedule(html)

    try:
        from bs4 import BeautifulSoup
    except ImportError as exc:
        raise ImportError(
            "缺少 beautifulsoup4。请安装：<venv>/Scripts/pip install beautifulsoup4 lxml"
        ) from exc

    soup = BeautifulSoup(html, "lxml")
    sched = Schedule(fetched_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"))

    # 学生信息（姓名/学号/校区）—— 尝试从页面文本中提取
    page_text = soup.get_text("\n")
    # 标题形态：「2026-2027学年第1学期张三的课表」
    m = re.search(r"学年\s*第?\s*[12一二]\s*学期\s*([\u4e00-\u9fa5]{2,6})\s*的课表",
                  page_text)
    if not m:
        m = re.search(r"姓\s*名[：:\s]*([\u4e00-\u9fa5]{2,6})", page_text)
    if m:
        sched.name = m.group(1)
    m = re.search(r"学\s*号[：:\s]*(\d{8,20})", page_text)
    if m:
        sched.student_id = m.group(1)
    # 校区：页面有「上课校区：」下拉，默认选中项在文本流里不易定位；
    # 由课程教室里的「雁山/育才/王城」前缀反推，见下方 _detect_campus。

    # --- 策略 1: 网格表格（常见于强智/教务系统课表页） ---
    tables = soup.find_all("table")
    for table in tables:
        entries = _parse_grid_table(table)
        if entries:
            sched.entries.extend(entries)

    if not sched.entries:
        # --- 策略 2: 卡片/列表式 ---
        sched.entries = _parse_list_style(soup)

    # 去重（pageHtml 里表格可能重复出现）+ 合并连堂课
    sched.entries = merge_entries(_dedupe_entries(sched.entries))

    # 实践环节（在「备注」行，格式：实践环节： 课程； 教师； 周次； 班级；）
    sched.practices = _parse_practices(soup)

    # 校区：由教室前缀反推（雁山/育才/王城）
    if sched.entries and not sched.campus:
        sched.campus = _detect_campus(sched.entries)
    return sched


def _detect_campus(entries: list[CourseEntry]) -> str:
    """从教室名的前缀推断校区。"""
    tally: dict[str, int] = {}
    for e in entries:
        for c in ("雁山", "育才", "王城"):
            if e.room.startswith(c) or f" {c}" in e.room:
                tally[c] = tally.get(c, 0) + 1
    if not tally:
        return ""
    return max(tally, key=tally.get)


def _parse_practices(soup) -> list[str]:
    """从「备注」行提取实践环节条目。

    原始 HTML 形态（跳过分行空白后）：
        实践环节： 军事技能； 符佳聪； 1-2周； 2026软件工程(无方向)；
    多条之间以 <br> 分隔。返回统一格式的字符串列表。
    """
    items: list[str] = []
    for tr in soup.find_all("tr"):
        if "备注" not in tr.get_text():
            continue
        for td in tr.find_all("td"):
            raw = str(td)
            for seg in re.split(r"<br\s*/?>", raw, flags=re.I):
                text = re.sub(r"<[^>]+>", "", seg)
                text = re.sub(r"\s+", " ", text).strip()
                if "实践环节" not in text:
                    continue
                body = text.split("实践环节", 1)[1].lstrip("：: ")
                fields = [f.strip() for f in body.split("；") if f.strip()]
                if not fields:
                    continue
                course = fields[0]
                teacher = fields[1] if len(fields) > 1 else ""
                weeks = fields[2] if len(fields) > 2 else ""
                classes = fields[3] if len(fields) > 3 else ""
                line = f"{course}｜"
                line += (teacher or "—") + "｜"
                line += f"**{weeks}**｜" if weeks else "**—**｜"
                line += (classes or "—")
                if line not in items:
                    items.append(line)
    return items


def _dedupe_entries(entries: list[CourseEntry]) -> list[CourseEntry]:
    """按「完整指纹」去重。

    为什么需要：采集器导出的 pageHtml 里，课表表格可能出现**两份**
    （`doc.body.innerHTML` 已含表格，脚本又追加了一次 table 的 outerHTML）。
    实测（2026-09-23）：`<table>` = 2，导致每门课被解析 2 次、
    条目从 16 条虚增到 35 条，且破坏连堂课合并。

    指纹含节次与周次，因此只会剔除**完全相同**的重复项，
    不会影响同一门课在不同周次/节次下的正常多条记录。
    """
    seen: set[tuple] = set()
    out: list[CourseEntry] = []
    for e in entries:
        sig = (e.weekday, e.course, e.teacher, e.room,
               tuple(sorted(e.periods)), tuple(sorted(e.weeks)))
        if sig in seen:
            continue
        seen.add(sig)
        out.append(e)
    return out


def merge_entries(entries: list[CourseEntry]) -> list[CourseEntry]:
    """合并同一门连堂课被教务系统拆成的多条记录。

    问题背景
    --------
    教务系统的课表网格**不代表**课程的逻辑分块。同一门连堂课常被拆成
    多个单元格，且各单元格的周次还可能有 1 周出入。实测（2026-09-23）：

        Cell51  周五 第1节    rowspan=1  软件工程专业导读 陶小梅 4-9周
        Cell52  周五 第2-3节  rowspan=2  软件工程专业导读 陶小梅 4-8周

    旧实现把「周次」纳入分组键，这两条因周次不同而被判为两组，
    于是课表里出现「周五 1」「周五 2-3」两行 —— 与用户认知的
    「连堂课 第1-3节」不符。

    合并规则
    --------
    1. 分组键为 (星期, 课程, 教师, 教室) —— **不含周次**。
    2. 组内按起始节次排序，**节次首尾相接**（next.start == cur.end + 1）
       才合并；有断档则保持独立。
    3. 周次取**并集**，且仅当两组周次相等或互为子集时才合并
       （避免把「1-8周」和「9-16周」这种真正不同的安排错误粘在一起）。
       例：{4..8} ⊆ {4..9} → 合并为 4-9周。
    """
    groups: dict[tuple, list[CourseEntry]] = {}
    for e in entries:
        groups.setdefault(_merge_key(e), []).append(e)

    merged: list[CourseEntry] = []
    for _, group in groups.items():
        group.sort(key=lambda x: (min(x.periods or [99]), max(x.periods or [0])))
        cur: CourseEntry | None = None
        for e in group:
            if cur is None:
                cur = e
                continue
            if _can_merge(cur, e):
                weeks = sorted(set(cur.weeks) | set(e.weeks))
                periods = sorted(set(cur.periods) | set(e.periods))
                # 周次被扩大时才重算 raw_weeks，否则保留原始表述（含单/双周）
                raw = (cur.raw_weeks
                       if set(weeks) == set(cur.weeks) else fmt_weeks(weeks))
                cur = CourseEntry(
                    course=cur.course, teacher=cur.teacher,
                    weekday=cur.weekday, periods=periods, weeks=weeks,
                    room=cur.room, raw_weeks=raw)
            else:
                merged.append(cur)
                cur = e
        if cur is not None:
            merged.append(cur)

    # 稳定排序：星期 -> 起始节次 -> 课程名
    merged.sort(key=lambda e: (e.weekday,
                               min(e.periods) if e.periods else 99,
                               e.course))
    return merged


def _merge_key(e: CourseEntry) -> tuple:
    """连堂课归组键：同星期 + 同课程 + 同教师 + 同教室（**不含周次**）。"""
    return (e.weekday, e.course, e.teacher, e.room)


def _can_merge(a: CourseEntry, b: CourseEntry) -> bool:
    """节次首尾相接，且周次相等或互为子集时可合并。"""
    if not a.periods or not b.periods:
        return False
    if min(b.periods) != max(a.periods) + 1:
        return False
    sa, sb = set(a.weeks), set(b.weeks)
    if not sa or not sb:
        return sa == sb
    return sa == sb or sa <= sb or sb <= sa


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()


def cell_lines(td) -> list[str]:
    """提取单元格文本，<br>/<p>/<div> 均视为换行分隔。

    BeautifulSoup 的 get_text("\n") 不会为 <br> 插入换行，
    必须先把 <br> 替换成换行符，否则字段会粘成一整串。
    """
    node = copy.copy(td)
    for br in node.find_all(["br", "hr"]):
        br.replace_with("\n")
    for blk in node.find_all(["p", "div", "li"]):
        blk.insert_after("\n")
    text = node.get_text(" ")
    out: list[str] = []
    for line in text.split("\n"):
        line = _clean(line)
        if line and line not in {"-", "—", "\xa0"}:
            out.append(line)
    return out


def _weekday_from_header(text: str) -> int:
    """把表头文字转成星期序号（1=周一）。真实页面用「星期一」。"""
    t = _clean(text)
    m = re.search(r"(?:星期|周)\s*([一二三四五六日天])", t)
    if not m:
        return 0
    ch = m.group(1)
    return "一二三四五六日".index(ch) + 1 if ch != "天" else 7


def _split_course_blocks(lines: list[str]) -> list[list[str]]:
    """把单元格的多行内容切成若干「课程块」。

    真实单元格结构（实测）:
        雁山                      ← 校区（固定第 1 行）
        高等数学1                  ← 课程名
        汪娟 4-16周                ← 教师 + 周次（同一行！）
        雁山理三区3-101            ← 教室
        考试                      ← 考核方式
        261KB0700301112          ← 课程代码

    同一格可能出现多个课程块，例如：
        [雁山, 程序设计基础, 唐振军 12-17周, ...机房, 考试, 261ZB...]
        [雁山, 程序设计基础, 俞春强 5-11周,  ...机房, 考试, 261ZB...]

    切分依据：**课程代码行**（形如 261ZB2300350102）标志一个块的结束。
    实际实现：按「代码行」切，代码行归入前一块。
    """
    if not lines:
        return []

    blocks: list[list[str]] = []
    cur: list[str] = []
    for line in lines:
        cur.append(line)
        # 课程代码 = 字母+数字组合（如 261ZB2300350102 / 261KB0700301112）
        if re.fullmatch(r"[0-9]{2,}[A-Z]{1,4}[0-9]{4,}", line.strip()):
            blocks.append(cur)
            cur = []
    if cur:
        # 残留内容并入最后一块（可能是不含代码的简写块）
        if blocks:
            blocks[-1].extend(cur)
        else:
            blocks.append(cur)
    return blocks


def _parse_course_block(block: list[str], weekday: int,
                        periods: list[int]) -> CourseEntry | None:
    """从单个课程块中抽取字段。

    字段顺序（真实页面）：校区 / 课程名 / 教师 周次 / 教室 / 考核 / 代码
    """
    lines = [l for l in block if l.strip()]
    if not lines:
        return None

    campus = ""
    course = ""
    teacher = ""
    weeks_raw = ""
    room = ""

    for i, line in enumerate(lines):
        # 教师 + 周次：形如 "汪娟 4-16周" 或 "俞春强 5,7-16周"
        m = re.match(r"^([\u4e00-\u9fa5、,，]{2,20})\s+(.+周.*)$", line)
        if m and not teacher:
            teacher = m.group(1).strip()
            weeks_raw = m.group(2).strip()
            continue
        # 纯周次行（兜底，无教师）
        if re.search(r"^\s*[\d,，\-~、\s]+周", line) and not weeks_raw:
            weeks_raw = line
            continue
        # 教室（含线上/混合式/自主学习等特殊场地）
        if re.search(r"教室|机房|楼|场$|区\s*[\d\-]|线上|混合式|自主学习", line) \
                and not room:
            room = line
            continue
        # 考核方式 / 课程代码，跳过
        if re.fullmatch(r"(考试|考查|测试|其他|笔试|机试)", line):
            continue
        if re.fullmatch(r"[0-9A-Z]{8,}", line):
            continue
        # 校区（短中文且不是课程名）
        if not campus and re.fullmatch(r"[\u4e00-\u9fa5]{2,6}", line) \
                and line.endswith(("山", "区", "园", "城")):
            campus = line
            continue
        # 剩下最先出现的作为课程名
        if not course:
            course = line
            continue

    if not course:
        return None

    weeks = parse_weeks(weeks_raw)
    full_room = f"{campus}{room}" if campus and room and campus not in room else room
    return CourseEntry(course=course, teacher=teacher, weekday=weekday,
                       periods=list(periods), weeks=weeks, room=full_room,
                       raw_weeks=weeks_raw)


def _parse_grid_table(table) -> list[CourseEntry]:
    """解析真实教务课表网格（GXNU 强智教务，实测结构）。

    真实表格形态
    ------------
    <table id="3" class="table-bordered">
      <thead><tr>
        <th></th><th>节次</th>
        <th>星期一</th>...<th>星期日</th>      ← 表头用「星期一」
      </tr></thead>
      <tbody>
        <tr>
          <td class="time-sw" rowspan="5">上午</td>   ← 时段分段列，跳过
          <td class="time-sw" data-jcindex="1">1</td>  ← 节次列，jcindex = 真实节次
          <td class="cell" id="Cell11">...</td>
          <td class="cell" id="Cell41" rowspan="3">雁山<br>高等数学1<br>汪娟 4-16周<br>...</td>
        </tr>
        ...

    核心规则
    --------
    1. **节次**取自该行的 `data-jcindex`（1..12），而非行序号
       （首列「上午/下午/晚上」用 rowspan 占行，会打乱行序号）。
    2. **跨节数** = 课程单元格的 `rowspan`。
       连堂课只在**首个节次行**出现，后续行该列被 rowspan 占位。
       故节次范围 = [jcindex, jcindex + rowspan - 1]。
    3. **星期**取自单元格 id `Cell<星期><节次>`（星期为 1 位，节次可能 2 位），
       比按列索引推算更可靠（rowspan 会导致列错位）。
    4. 单元格 id 的节次部分可与 jcindex 交叉校验。
    """
    entries: list[CourseEntry] = []
    rows = table.find_all("tr")

    # 表头 → 列索引映射（作为 id 解析失败时的兜底）
    weekday_of_col: dict[int, int] = {}
    for idx, th in enumerate(table.find_all("th")):
        wd = _weekday_from_header(_clean(th.get_text()))
        if wd:
            weekday_of_col[idx] = wd

    for tr in rows:
        cells = tr.find_all(["td", "th"])
        if not cells:
            continue

        # --- 取本行节次（data-jcindex 优先） ---
        row_period = None
        for c in cells:
            jc = c.get("data-jcindex")
            if jc and str(jc).strip().isdigit():
                row_period = int(str(jc).strip())
                break
        if row_period is None:
            # 兜底：找纯数字的 time-sw 单元格
            for c in cells:
                cls = c.get("class") or []
                if "time-sw" in cls or "time-xw" in cls or "time-ws" in cls:
                    txt = _clean(c.get_text())
                    if re.fullmatch(r"\d{1,2}", txt):
                        row_period = int(txt)
                        break
        if row_period is None:
            continue  # 表头行 / 备注行

        # --- 提取课程单元格 ---
        for col_idx, cell in enumerate(cells):
            cls = cell.get("class") or []
            if "cell" not in cls:
                continue

            lines = cell_lines(cell)
            if not lines:
                continue

            # 星期：优先解析 id="Cell<星期><节次>"
            weekday = 0
            cid = cell.get("id") or ""
            m = re.match(r"Cell(\d)(\d+)$", cid)
            if m:
                weekday = int(m.group(1))
                # 交叉校验：id 里的节次应与行节次一致（不一致则以 id 为准）
                id_period = int(m.group(2))
                if id_period != row_period:
                    row_period_for_cell = id_period
                else:
                    row_period_for_cell = row_period
            else:
                weekday = weekday_of_col.get(col_idx, 0)
                row_period_for_cell = row_period

            if not (1 <= weekday <= 7):
                continue

            # 跨节数
            try:
                span = int(cell.get("rowspan", 1))
            except (TypeError, ValueError):
                span = 1
            span = max(span, 1)
            periods = list(range(row_period_for_cell,
                                 row_period_for_cell + span))

            for block in _split_course_blocks(lines):
                e = _parse_course_block(block, weekday, periods)
                if e:
                    entries.append(e)

    return entries


# --- 新版「课表查询」页解析（api/getKbxx）----------------------------------
def _split_course_room(title: str) -> tuple[str, str]:
    """把 `"课程名(教室)"` 拆成 (课程名, 教室)。

    ⚠ 不能取「第一个左括号之前」—— 课程名本身可能带括号，实测有
      `公共体育(1)-乒乓球(雁山公体乒乓球场)`。
      教室一定以「雁山/育才/王城」开头（GXNU 教室命名规则），故按它定位；
      取不到时退回「最后一个左括号」。
    """
    t = (title or "").strip()
    m = re.search(r"\((雁山|育才|王城)", t)
    if m and m.start() > 0:
        i = m.start()
        # 只去掉最外层那一个右括号（教室名自身可能含括号）
        return t[:i].strip(), re.sub(r"\)\s*$", "", t[i + 1:]).strip()
    i = t.rfind("(")
    if i > 0 and t.endswith(")"):
        return t[:i].strip(), t[i + 1:-1].strip()
    return t, ""


def _kbcx_active_week(soup) -> int:
    """从周次列表取当前显示的是第几周（active 项）。"""
    for p in soup.find_all("p"):
        if "active" not in (p.get("class") or []):
            continue
        txt = _clean(p.get_text(" ", strip=True))
        if not re.match(r"^第\s*\d+\s*周", txt):
            continue
        raw = str(p.get("sid") or "").strip()
        if raw.isdigit():
            return int(raw)
    return 0


def _parse_kbcx_table(table, weeks: list[int]) -> list[CourseEntry]:
    """解析新版「课表查询」页的单张（单周）表格。"""
    entries: list[CourseEntry] = []
    for tr in table.find_all("tr"):
        if "rowkb" not in (tr.get("name") or ""):
            continue
        raw_p = str(tr.get("sid") or "").strip()
        if not raw_p.isdigit():
            continue
        p_start = int(raw_p)
        for td in tr.find_all("td"):
            m = re.match(r"Cell(\d)(\d+)$", td.get("id") or "")
            if not m:
                continue
            weekday = int(m.group(1))
            if not 1 <= weekday <= 7:
                continue
            card = td.find("p", class_="content-detail")
            if card is None:
                continue
            title = (card.get("title") or card.get_text(" ", strip=True)).strip()
            if not title:
                continue
            try:
                span = int(str(td.get("rowspan") or "1").strip())
            except ValueError:
                span = 1
            span = max(span, 1)
            course, room = _split_course_room(title)
            teacher = ""
            sp = td.find("span", attrs={"title": True})
            if sp is not None:
                teacher = (sp.get("title") or "").strip()
            entries.append(CourseEntry(
                course=course, teacher=teacher, weekday=weekday,
                periods=list(range(p_start, p_start + span)),
                weeks=list(weeks), room=room))
    return entries


def _split_week_segments(html: str) -> list[tuple[int, str]]:
    """按 `<!-- GXNU-WEEK n -->` 注释把采集器导出的多周 HTML 切开。"""
    parts = _KB_WEEK_MARK_RE.split(html or "")
    if len(parts) < 3:
        return []
    out: list[tuple[int, str]] = []
    for i in range(1, len(parts) - 1, 2):
        raw = parts[i]
        if not raw.isdigit():
            continue
        out.append((int(raw), parts[i + 1]))
    return out


def parse_kbcx_schedule(html: str) -> Schedule:
    """解析新版「课表查询」页（api/getKbxx）的 HTML。"""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "lxml")
    sched = Schedule(fetched_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"))

    m = re.search(r"[?&]xnxq=(\d{4}-\d{4}-\d)", html)
    if m:
        sched.semester = m.group(1)

    segments = _split_week_segments(html)
    touched: set[int] = set()
    if segments:
        for sid, seg in segments:
            seg_soup = BeautifulSoup(seg, "lxml")
            for table in seg_soup.find_all("table"):
                got = _parse_kbcx_table(table, [sid])
                if got:
                    sched.entries.extend(got)
                    touched.add(sid)
    else:
        # 手动另存/单周页面：周次取自 active tab
        w = _kbcx_active_week(soup)
        weeks = [w] if w else []
        for table in soup.find_all("table"):
            got = _parse_kbcx_table(table, weeks)
            if got:
                sched.entries.extend(got)
                if w:
                    touched.add(w)

    sched.entries = coalesce_weeks(merge_entries(_dedupe_entries(sched.entries)))
    sched.practices = _parse_practices(soup)
    if sched.entries and not sched.campus:
        sched.campus = _detect_campus(sched.entries)
    # 本次数据覆盖了哪些周次。少于全部周次 → 是「单周/部分周」数据，
    # 主流程必须与既有课表合并，不能整体覆盖（否则会丢掉其他周）。
    sched.touched_weeks = sorted(touched)
    return sched


# --- 易班「易知独秀」课表页（/yzdx/dean/course，CSS Grid 无 table）----------
#
# 页面不是 <table>，是 Tailwind CSS Grid。课程卡片结构（实测 2026-10-10）：
#   <div class="...rounded-md..." style="grid-area: 3 / 2 / 6 / 3; ...">
#     <p><span>课程名</span><span> @ 教室</span></p>
#   </div>
# `grid-area: qsj / xqj+1 / zzj+1 / xqj+2`（row-start/col-start/row-end/col-end）：
#   起始节 = qsj，终止节 = zzj+1-1 = zzj（row-end 不含），
#   星期 = xqj+1-1 = xqj（grid 第 1 列是节次标签，第 2 列才是周一）。
# ⚠ DOM 里**没有教师名**（只在点击课程后的详情弹窗里）→ teacher 留空，
#   由 merge_partial_weeks 从既有课表按 (星期, 课程, 节次) 继承补全。
# ⚠ 一次只渲染当前周（切周是纯前端行为），MHTML 另存只能拿到一周，
#   故 touched_weeks 只含当前周 → 主流程走部分合并。
_YZDX_GRID_AREA_RE = re.compile(
    r"grid-area:\s*(\d+)\s*/\s*(\d+)\s*/\s*(\d+)\s*/\s*(\d+)", re.I)
_YZDX_CURRENT_WEEK_RE = re.compile(r"第\s*(\d+)\s*教学周")
_YZDX_SEMESTER_RE = re.compile(
    r"(\d{4}\s*[-~至]\s*\d{4})\s*学年\s*第?\s*([12一二])\s*学期")


def _is_yzdx_html(html: str) -> bool:
    """是否易班「易知独秀」课表页（CSS Grid，以 grid-area 定位课程）。"""
    html = html or ""
    return (bool(_YZDX_GRID_AREA_RE.search(html))
            and bool(_YZDX_CURRENT_WEEK_RE.search(html)))


def _parse_yzdx_course(div) -> tuple[str, str] | None:
    """从易班课程卡片 <div> 提取 (课程名, 教室)；无课程名返回 None。

    卡片 <p> 内两个 <span>：第一个是课程名，第二个是「 @ 教室」。
    无教室时第二个 span 是 ``<span style="display: none;"> @ </span>``。
    """
    spans = div.find_all("span")
    if not spans:
        return None
    course = _clean(spans[0].get_text())
    if not course:
        return None
    room = ""
    if len(spans) >= 2:
        room_span = spans[1]
        style = (room_span.get("style") or "").lower()
        if "display" in style and "none" in style:
            room = ""
        else:
            room = re.sub(r"^\s*@\s*", "", _clean(room_span.get_text())).strip()
    return course, room


def parse_yzdx_schedule(html: str) -> Schedule:
    """解析易班「易知独秀」课表页 HTML → Schedule（仅当前周，teacher 留空）。"""
    try:
        from bs4 import BeautifulSoup
    except ImportError as exc:
        raise ImportError(
            "缺少 beautifulsoup4。请安装：<venv>/Scripts/pip install beautifulsoup4 lxml"
        ) from exc

    soup = BeautifulSoup(html, "lxml")
    sched = Schedule(fetched_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"))

    page_text = soup.get_text(" ")
    # 学期名（页面标题「2026-2027学年 第1学期 课程表」）
    m = _YZDX_SEMESTER_RE.search(page_text)
    if m:
        yy = m.group(1).replace(" ", "").replace("~", "-").replace("至", "-")
        term = "1" if m.group(2) in {"1", "一"} else "2"
        sched.semester = f"{yy}-{term}"
    # 当前周（「第 6 教学周」）
    m = _YZDX_CURRENT_WEEK_RE.search(page_text)
    current_week = int(m.group(1)) if m else 0

    entries: list[CourseEntry] = []
    for div in soup.find_all("div", style=True):
        style = div.get("style") or ""
        gm = _YZDX_GRID_AREA_RE.search(style)
        if not gm:
            continue
        row_start, col_start, row_end, col_end = (int(x) for x in gm.groups())
        weekday = col_start - 1            # 第 1 列节次，第 2 列=周一
        p_start, p_end = row_start, row_end - 1
        if not 1 <= weekday <= 7 or p_end < p_start:
            continue
        parsed = _parse_yzdx_course(div)
        if not parsed:
            continue
        course, room = parsed
        entries.append(CourseEntry(
            course=course, teacher="", weekday=weekday,
            periods=list(range(p_start, p_end + 1)),
            weeks=[current_week] if current_week else [], room=room))

    sched.entries = coalesce_weeks(merge_entries(_dedupe_entries(entries)))
    if sched.entries:
        sched.campus = _detect_campus(sched.entries)
    if current_week:
        sched.touched_weeks = [current_week]
    return sched


def schedule_from_kbcx_weeks(weeks: list[dict]) -> Schedule:
    """从采集器给出的 `kbcxWeeks` 结构化字段直接构建 Schedule。

    浏览器端用 DOM 解析，比 Python 再解析 HTML 字符串可靠，故优先走这里。
    `weeks` 形如 ``[{sid, label, range, courses:[{week, weekday, periodStart,
    periodEnd, course, room, teacher, raw}]}]``。
    """
    sched = Schedule(fetched_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    touched: set[int] = set()
    for w in weeks or []:
        if not isinstance(w, dict):
            continue
        raw_sid = w.get("sid")
        try:
            sid = int(raw_sid)
        except (TypeError, ValueError):
            sid = 0
        courses = w.get("courses") or []
        if not courses:
            continue
        if sid > 0:
            touched.add(sid)
        for c in courses:
            if not isinstance(c, dict):
                continue
            try:
                weekday = int(c.get("weekday"))
                p_start = int(c.get("periodStart"))
                p_end = int(c.get("periodEnd") or p_start)
            except (TypeError, ValueError):
                continue
            if not 1 <= weekday <= 7:
                continue
            course = str(c.get("course") or "").strip()
            if not course:
                continue
            # 课程条目自身的 week 优先（同一份数据里可能混多周）
            try:
                own = int(c.get("week"))
            except (TypeError, ValueError):
                own = sid
            wks = [own] if own else ([sid] if sid else [])
            if own:
                touched.add(own)
            sched.entries.append(CourseEntry(
                course=course,
                teacher=str(c.get("teacher") or "").strip(),
                weekday=weekday,
                periods=list(range(p_start, max(p_start, p_end) + 1)),
                weeks=wks,
                room=str(c.get("room") or "").strip()))
    sched.entries = coalesce_weeks(merge_entries(_dedupe_entries(sched.entries)))
    if sched.entries:
        sched.campus = _detect_campus(sched.entries)
    sched.touched_weeks = sorted(touched)
    return sched


def _parse_list_style(soup) -> list[CourseEntry]:
    """解析列表/卡片式课表（备用策略）。"""
    entries: list[CourseEntry] = []
    for row in soup.find_all("tr"):
        cells = [_clean(td.get_text()) for td in row.find_all(["td", "th"])]
        if len(cells) < 4:
            continue
        joined = " | ".join(cells)
        if not re.search(r"周[一二三四五六日天]", joined):
            continue
        wm = re.search(r"周([一二三四五六日天])", joined)
        if not wm:
            continue
        wd = "一二三四五六日".index(wm.group(1)) + 1
        entries.append(CourseEntry(
            course=cells[1] if len(cells) > 1 else "",
            teacher=cells[2] if len(cells) > 2 else "",
            weekday=wd, periods=[], weeks=[], room=cells[-1]))
    return entries


# --- 变更比对 --------------------------------------------------------------
def diff_schedules(old: dict, new: Schedule) -> dict:
    """比较新旧课表，返回增/删/改明细。

    比较用**归一化后的 key**：旧 state 里可能存着全角写法
    （`公共体育（1）`），而新数据是半角（`公共体育(1)`），
    不归一化会把同一门课报成「新增 + 移除」。
    """
    old_norm = {_norm_key_text(k): k for k in old.get("keys", [])}
    new_norm = {_norm_key_text(e.key): e.key for e in new.entries}

    added = sorted(new_norm[k] for k in new_norm.keys() - old_norm.keys())
    removed = sorted(old_norm[k] for k in old_norm.keys() - new_norm.keys())

    def human(k: str) -> str:
        p = k.split("|")
        if len(p) < 6:
            return k
        wd, course, teacher, pd, wk, room = p[:6]
        try:
            wd_name = WEEKDAY_NAMES[int(wd) - 1]
        except (ValueError, IndexError):
            wd_name = f"周{wd}"
        return f"{wd_name} {course}（{teacher}）第{pd}节 周次[{wk}] @{room}"

    return {
        "changed": bool(added or removed),
        "added": [human(k) for k in added],
        "removed": [human(k) for k in removed],
        "added_count": len(added),
        "removed_count": len(removed),
    }


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_state(sched: Schedule) -> None:
    STATE_FILE.write_text(
        json.dumps(sched.to_state(), ensure_ascii=False, indent=2),
        encoding="utf-8")


def entries_from_state(state: dict) -> list[CourseEntry]:
    """从 state 还原完整课程条目（新版单周数据合并时必需）。

    两级来源：
      1. `entries` 字段（新版本 state 直接存下完整条目）
      2. `keys` 字段（老 state 只有 keys —— 但 key 的格式
         `星期|课程|教师|节次|周次|教室` **本就包含全部信息**，可完整还原）
    """
    out: list[CourseEntry] = []
    for d in (state or {}).get("entries") or []:
        if not isinstance(d, dict):
            continue
        try:
            e = CourseEntry(
                course=str(d.get("course") or ""),
                teacher=str(d.get("teacher") or ""),
                weekday=int(d.get("weekday") or 0),
                periods=[int(x) for x in (d.get("periods") or [])],
                weeks=[int(x) for x in (d.get("weeks") or [])],
                room=str(d.get("room") or ""),
                raw_weeks=str(d.get("raw_weeks") or ""),
            )
        except (TypeError, ValueError):
            continue
        if e.course and 1 <= e.weekday <= 7:
            out.append(e)
    if out:
        return out

    # 兜底：从 keys 还原（key = 星期|课程|教师|节次|周次|教室）
    for k in (state or {}).get("keys") or []:
        parts = str(k).split("|")
        if len(parts) < 6:
            continue
        try:
            weekday = int(parts[0])
            periods = [int(x) for x in parts[3].split(",") if x.strip()]
            weeks = [int(x) for x in parts[4].split(",") if x.strip()]
        except ValueError:
            continue
        if not (1 <= weekday <= 7) or not parts[1]:
            continue
        out.append(CourseEntry(
            course=parts[1], teacher=parts[2], weekday=weekday,
            periods=periods, weeks=weeks,
            room="|".join(parts[5:])))      # 教室名理论上不含 |，保险起见拼接
    return out


def weeks_from_state(state: dict) -> set[int]:
    """从 state 推断既有课表覆盖了哪些周次（keys 里带周次列）。"""
    out: set[int] = set()
    for k in (state or {}).get("keys") or []:
        parts = str(k).split("|")
        if len(parts) < 5:
            continue
        for w in parts[4].split(","):
            if w.strip().isdigit():
                out.add(int(w.strip()))
    return out


def coalesce_weeks(entries: list[CourseEntry]) -> list[CourseEntry]:
    """把「同课、同时间、同教师、同教室，仅周次不同」的条目合并为一条。

    新版「课表查询」页是**按周**给数据的：同一门课在第 6 周和第 7 周会各
    出现一条，`weeks` 分别是 `[6]` 和 `[7]`。若不合并，与旧格式
    （一条写 `weeks=[5..15]`）比对时会报出一堆虚假的「新增 + 移除」。

    分组键含 `periods`：节次不同说明是不同安排，不能合并。
    """
    groups: dict[tuple, CourseEntry] = {}
    order: list[tuple] = []
    for e in entries:
        sig = (e.weekday, e.course, e.teacher, e.room,
               tuple(sorted(int(p) for p in e.periods)))
        if sig not in groups:
            groups[sig] = replace(e, weeks=sorted(set(int(w) for w in e.weeks)))
            order.append(sig)
        else:
            g = groups[sig]
            g.weeks = sorted(set(g.weeks) | set(int(w) for w in e.weeks))
            if not g.raw_weeks and e.raw_weeks:
                g.raw_weeks = e.raw_weeks
    return [groups[s] for s in order]


def merge_partial_weeks(new: list[CourseEntry], old: list[CourseEntry],
                        touched: list[int]) -> list[CourseEntry]:
    """把「只覆盖部分周次」的新数据合并进既有课表。

    新版「课表查询」页一次只渲染一周（手动另存 MHTML 也只能拿到一周），
    若直接整体覆盖会**丢掉未涉及的周次**。规则：
      · 只替换 `touched` 周次里的安排（含"某周取消了某门课"的情况）
      · 其余周次原样保留（从旧条目里裁剪出未被触及的周次）
      · 最后把同课不同周的碎片合并回去（否则会被判成虚假变更）
    """
    tw = {int(w) for w in (touched or [])}
    if not tw:
        return coalesce_weeks(merge_entries(_dedupe_entries(list(new))))
    # 易班 MHTML 等来源不含教师名 → 从既有课表按 (星期, 课程, 节次) 继承，
    # 避免合并时把已有课表的教师名冲成空。
    teacher_map: dict[tuple, str] = {}
    for e in old:
        if e.teacher:
            teacher_map.setdefault(
                (e.weekday, e.course, tuple(sorted(e.periods))), e.teacher)
    if teacher_map:
        new = [
            replace(e, teacher=teacher_map[(e.weekday, e.course,
                                            tuple(sorted(e.periods)))])
            if (not e.teacher and (e.weekday, e.course,
                                   tuple(sorted(e.periods))) in teacher_map)
            else e
            for e in new
        ]
    kept: list[CourseEntry] = []
    for e in old:
        rest = [w for w in e.weeks if w not in tw]
        if not rest:
            continue                    # 该条目只属于被覆盖的周次 → 弃用
        kept.append(replace(e, weeks=rest))
    merged = merge_entries(_dedupe_entries(kept + list(new)))
    return coalesce_weeks(merged)


def schedule_from_meta(html: str, meta: dict) -> Schedule:
    """按数据源类型解析课表。

    优先用采集器给出的结构化周数据（`kbcxWeeks` / `yzdxWeeks`，浏览器侧解析
    更可靠），没有或解析不出条目时回退到解析 HTML 字符串。
    """
    weeks = (meta or {}).get("kbcx_weeks") or []
    if weeks:
        sched = schedule_from_kbcx_weeks(weeks)
        if sched.entries:
            # 采集器显式给出「本次覆盖了哪些周」时以它为准：结构化周数据里的
            # **空周会被 schedule_from_kbcx_weeks 跳过**，只靠条目反推的话
            # 那些周就不算"被覆盖"，于是某门课被取消时旧条目会残留下来。
            tw: set[int] = set()
            for w in ((meta or {}).get("touched_weeks") or []):
                try:
                    tw.add(int(w))
                except (TypeError, ValueError):
                    continue
            if tw:
                sched.touched_weeks = sorted(tw)
            return sched
    return parse_schedule_html(html)


def apply_partial_merge(sched: Schedule) -> str:
    """新版单周数据 → 与既有课表合并，返回说明串（无需合并时为空串）。

    触发条件：本次数据带 `touched_weeks`（说明是分周来源），
    且既有课表里存在**本次未覆盖**的周次 —— 此时整体覆盖会丢数据。
    """
    if not sched.touched_weeks:
        return ""
    state = load_state()
    tw = {int(w) for w in sched.touched_weeks}
    old_weeks = weeks_from_state(state)
    missing = old_weeks - tw
    if not missing:
        return ""              # 已有数据全在本次覆盖范围内 → 无需合并
    old = entries_from_state(state)
    if not old:
        # 拿不到既有条目（理论上有 keys 就能还原）→ 不能安全合并，交由调用方处理
        raise RuntimeError(
            "本次只覆盖第 " + "、".join(str(w) for w in sorted(tw)) + " 周，"
            "但无法从 history 还原既有课表条目，整体覆盖会丢失其他周次。\n"
            "  建议：先用「我的课表」页或油猴脚本采一次全学期课表，再采单周数据。")
    before = len(sched.entries)
    sched.entries = merge_partial_weeks(sched.entries, old, sched.touched_weeks)
    tw_s = "、".join(str(w) for w in sched.touched_weeks)
    miss = "、".join(str(w) for w in sorted(missing))
    return (f"  数据只覆盖第 {tw_s} 周，已与既有课表合并"
            f"（{before} → {len(sched.entries)} 条，保留第 {miss} 周）")


def log_run(record: dict) -> None:
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


# --- 渲染 Markdown ---------------------------------------------------------
# 周视图网格的样式（Obsidian 里 HTML 表格默认很素，这段让它接近手机课表 App）
GRID_CSS = """<style>
.gxnu-tt { border-collapse: collapse; width: 100%; font-size: 12px; }
.gxnu-tt th, .gxnu-tt td {
  border: 1px solid var(--background-modifier-border);
  padding: 3px 4px; text-align: center; vertical-align: middle;
  line-height: 1.35;
}
.gxnu-tt th { background: var(--background-secondary); font-weight: 600; }
.gxnu-tt .gxnu-th-p { width: 62px; font-size: 11px; color: var(--text-muted); }
.gxnu-tt .gxnu-date { font-size: 11px; color: var(--text-muted); font-weight: 400; }
.gxnu-tt td { background: var(--background-primary); }
.gxnu-tt td b { color: var(--text-normal); }
.gxnu-tt .gxnu-break td {
  background: var(--background-secondary-alt, var(--background-secondary));
  color: var(--text-muted); font-size: 11px; padding: 1px;
}
</style>"""


def render_common_head(sched: Schedule, title: str, css: bool = False) -> list[str]:
    """几个课表文件共用的 YAML front matter + 标题 + 头部元信息。

    注意：`- **姓名**：…` 这一行会被用户在 Obsidian 中用 Meld Encrypt
    加密成 `🔐…🔐`，写入时由 `apply_protected()` 替换回密文，此处照常生成。

    `css=True` 时附带周视图网格的样式（仅周视图需要）。
    """
    lines: list[str] = []
    lines.append("---")
    lines.append("tags: [gxnu, 课表]")
    lines.append(f"semester: {sched.semester}")
    lines.append(f"updated: {datetime.now():%Y-%m-%d}")
    lines.append("source: sync_course_schedule.py（自动同步）")
    lines.append("---")
    lines.append("")
    if css:
        lines.append(GRID_CSS)
        lines.append("")
    lines.append(f"# {title}")
    lines.append("")
    if sched.name:
        lines.append(f"- **姓名**：{sched.name}"
                     + (f"　**学号**：{sched.student_id}" if sched.student_id else "")
                     + (f"　**校区**：{sched.campus}" if sched.campus else ""))
    lines.append(f"- **当前校历周次**：第 {current_week()} 周")
    lines.append(f"- **最近同步**：{sched.fetched_at}")
    lines.append("")
    return lines


def week_dates(w: int) -> dict[int, str]:
    """返回第 w 周「星期几 → 该日日期串(MM.DD)」的映射。

    校历第 1 周周一 = WEEK1_MONDAY，第 w 周周一 = 该日 + (w-1) 周。
    """
    mon = WEEK1_MONDAY + timedelta(weeks=w - 1)
    return {d: f"{mon + timedelta(days=d - 1):%m.%d}" for d in range(1, 8)}


# --- 周视图网格（与手机端课表 App 的排列一致） -----------------------------
#
# 版面仿照小米 AI 课表：
#   ┌ 第 5 周（09.28-10.04）
#   │ 周一 09.28 │ 周二 09.29 │ … │ 周日 10.04     ← 表头（星期 + 日期）
#   ├ 1  8:20-9:00 │ 格子：课程 / @教室 / 教师
#   │ 2  …
#
# 要点：
# - 整周网格只出现**一次**日期（在表头），格子里不再重复日期
# - 连堂课（节次相邻且同课同教室）纵向合并，用 HTML rowspan
# - 第 5 节后插「午休」、第 9 节后插「晚休」分隔行
# - 一个格子放不下完整信息 → 完整信息统一列在下方「课程详情」

# 一天里节次最多的第几节（雁山作息共 12 节）
MAX_PERIOD = 12

# 午休 / 晚休分隔行插在这些节次之后
BREAK_AFTER = {5: "午休", 9: "晚休"}


def _period_time_short(p: int, campus: str) -> str:
    """单个节次的时间串，如 '8:20-9:00'。"""
    return period_times_for(campus).get(p, "?")


def _period_time_lines(p: int, campus: str) -> list[str]:
    """把节次时间拆成起止两行（手机上常见的紧凑排法）。"""
    t = _period_time_short(p, campus)
    if "-" not in t:
        return [t]
    a, b = t.split("-", 1)
    return [a.strip(), b.strip()]


def _grid_cell_html(e: CourseEntry, campus: str) -> str:
    """把一个课程条目渲染成表格单元格内容（`<br>` 分隔）。

    仿手机版面三行：课程名 / @教室 / 教师。
    教室名去掉「雁山」前缀并做紧凑化（理二区2-202 → 理二2-202），
    避免在窄列里被截断。
    """
    parts: list[str] = [f"<b>{_esc(e.course)}</b>"]

    room = e.room or ""
    for pre in ("雁山", "育才", "王城"):
        if room.startswith(pre):
            room = room[len(pre):]
            break
    room = room.replace("区", "")
    if len(room) > 14:
        room = room[:13] + "…"
    if room:
        parts.append(f"@{_esc(room)}")

    if e.teacher:
        tc = e.teacher if len(e.teacher) <= 6 else e.teacher[:5] + "…"
        parts.append(_esc(tc))
    return "<br>".join(parts)


def _slot_of(entries: list[CourseEntry], weekday: int, p: int) -> CourseEntry | None:
    """找出占用 (星期, 节次) 的那条课程（连堂课任一节都命中）。"""
    for e in entries:
        if e.weekday == weekday and p in e.periods:
            return e
    return None


def render_week_table(entries: list[CourseEntry], week: int,
                      campus: str) -> list[str]:
    """渲染某一周的周视图网格（HTML 表格，Obsidian 可正常渲染）。

    `entries` 应只包含该周有课的条目。
    """
    dates = week_dates(week)
    lines: list[str] = []

    lines.append('<table class="gxnu-tt">')

    # ---- 表头：星期 + 日期 ----
    head = ['<tr><th class="gxnu-th-p">节次</th>']
    for d in range(1, 8):
        head.append(f'<th>周{WEEKDAY_CN[d - 1]}<br>'
                    f'<span class="gxnu-date">{dates[d]}</span></th>')
    head.append("</tr>")
    lines.append("".join(head))

    # ---- 12 个节次行 ----
    for p in range(1, MAX_PERIOD + 1):
        tlines = _period_time_lines(p, campus)
        tcell = "".join(f"<br>{_esc(x)}" for x in tlines)
        row = [f'<th class="gxnu-th-p">{p}{tcell}</th>']

        for d in range(1, 8):
            e = _slot_of(entries, d, p)
            if e is None:
                row.append("<td></td>")
                continue
            lo, hi = min(e.periods), max(e.periods)
            if p == lo:
                span = hi - lo + 1
                rs = f' rowspan="{span}"' if span > 1 else ""
                row.append(f"<td{rs}>{_grid_cell_html(e, campus)}</td>")
            # p > lo 的格子由 rowspan 覆盖，不再输出 <td>

        lines.append("<tr>" + "".join(row) + "</tr>")

        # 分隔行（午休 / 晚休）
        if p in BREAK_AFTER:
            lines.append(f'<tr class="gxnu-break"><td colspan="8">'
                         f'{_esc(BREAK_AFTER[p])}</td></tr>')

    lines.append("</table>")
    return lines


def _esc(s: str) -> str:
    """HTML 转义（课程名里偶有 & < > 等字符）。"""
    return (str(s or "").replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;"))


def render_week_details(entries: list[CourseEntry], campus: str) -> list[str]:
    """周视图下方的「完整信息」列表（格子里放不下的教师名 + 完整教室）。"""
    if not entries:
        return []
    lines = ["<details>", "<summary>课程详情（完整教室 / 教师）</summary>", ""]
    lines.append("| 节次 | 时间 | 课程 | 教师 | 教室 |")
    lines.append("|---|---|---|---|---|")
    for e in sorted(entries, key=lambda x: (x.weekday, min(x.periods or [99]))):
        wd = WEEKDAY_NAMES[e.weekday - 1] if 1 <= e.weekday <= 7 else str(e.weekday)
        pd = fmt_periods(e.periods)
        t = fmt_period_time(e.periods, entry_campus(e, campus))
        lines.append(f"| {wd} {pd} | {t} | {e.course} | {e.teacher} | {e.room} |")
    lines.append("")
    lines.append("</details>")
    return lines


def render_by_week(sched: Schedule) -> str:
    """`课表_<学期>_周视图.md`：与手机端课表 App 相同的**周视图网格**。

    每周一张 7 列 × 12 节 的网格表，表头为「星期 + 日期」，
    连堂课纵向合并，第 5/9 节后标注午休/晚休。

    只渲染**本周及之后**的周次（已过完的周自动省略，本周置顶）。
    历史周次仍完整保存在 `课表/.backup/` 的历次备份里，需要回看可去那里找。
    """
    ws = current_week()
    lines = render_common_head(
        sched, f"{sched.semester} 学年第 1 学期课表（周视图）", css=True)
    lines.append("## 周视图")
    lines.append("")

    all_weeks = sorted({w for e in sched.entries for w in e.weeks}) or [ws]
    # 去掉已过完的周（只保留本周及之后）
    upcoming = [w for w in all_weeks if w >= ws]
    if not upcoming:
        # 学期已结束（当前周超出所有排课周次）：回退为渲染最后一周，避免空文件
        upcoming = [all_weeks[-1]]

    for w in upcoming:
        start = WEEK1_MONDAY + timedelta(weeks=w - 1)
        end = start + timedelta(days=6)
        mark = "　**← 本周**" if w == ws else ""
        lines.append(f"### 第 {w} 周（{start:%m.%d}-{end:%m.%d}）{mark}")
        lines.append("")
        items = [e for e in sched.entries if w in e.weeks]
        if not items:
            lines.append("本周无课程安排。")
            lines.append("")
            continue
        campus = sched.campus or _detect_campus(items)
        lines.extend(render_week_table(items, w, campus))
        lines.append("")
        lines.extend(render_week_details(items, campus))
        lines.append("")
    return "\n".join(lines)


def render_summary(sched: Schedule) -> str:
    """`课表_<学期>.md`：课程汇总 + 实践环节 + 节次时间表。

    与 `render_by_week` 分开，两个文件才真正是**不同视图**（此前两者
    复用同一函数，内容完全重复）。
    """
    lines = render_common_head(
        sched, f"{sched.semester} 学年第 1 学期课表（课程汇总）")

    lines.append("## 一、课程汇总")
    lines.append("")
    lines.append("| 课程 | 教师 | 星期 | 节次 | 时间 | 周次 | 教室 |")
    lines.append("|---|---|---|---|---|---|---|")
    for e in sorted(sched.entries, key=lambda x: (x.course, x.weekday)):
        wd = WEEKDAY_NAMES[e.weekday - 1] if 1 <= e.weekday <= 7 else str(e.weekday)
        pd = fmt_periods(e.periods)
        t = fmt_period_time(e.periods, entry_campus(e, sched.campus))
        wk = e.raw_weeks or (",".join(map(str, e.weeks)) if e.weeks else "-")
        lines.append(f"| {e.course} | {e.teacher} | {wd} | {pd} | {t} "
                     f"| {wk} | {e.room} |")
    lines.append("")

    if sched.practices:
        lines.append("## 二、实践环节")
        lines.append("")
        for p in sched.practices:
            lines.append(f"- {p}")
        lines.append("")

    # 节次时间表 —— 按校区展示（两校区作息不同）
    campus_label = sched.campus or "育才/王城"
    times = period_times_for(sched.campus)
    lines.append(f"## 附：节次时间表（{campus_label}校区）")
    lines.append("")
    lines.append("| 节次 | 时间 | 节次 | 时间 |")
    lines.append("|---|---|---|---|")
    for i in range(1, 7):
        lines.append(f"| 第{i}节 | {times[i]} | 第{i+6}节 | {times[i+6]} |")
    lines.append("")
    if not sched.campus:
        lines.append("> 未识别到校区，以上为育才/王城校区作息；"
                     "雁山校区请以学校通知为准。")
        lines.append("")
    return "\n".join(lines)


def entry_campus(e: CourseEntry, default: str = "") -> str:
    """从教室名前缀判断单条课程所在校区，取不到则回退到默认校区。"""
    for c in ("雁山", "育才", "王城"):
        if (e.room or "").startswith(c):
            return c
    return default


# --- 数据源：Edge 默认下载目录（只读） -------------------------------------
# 采集方式（任选其一，都落在 Edge 默认下载目录 ~/Downloads）：
#   A. 油猴脚本「GXNU 课表采集器」→ course-schedule-*.json（首选，最稳）
#   B. Edge 菜单「另存为 → 单个文件(*.mhtml)」→ 广西师范大学综合教务管理系统-*.mhtml
#   C. Edge 菜单「另存为 → 网页，仅 HTML」→ *.html
#
# 关键约束：**不修改浏览器下载路径**，本脚本仅只读扫描默认下载目录。
SEARCH_DIRS = [
    KB_DIR / "_inbox",                     # 可选的人工投放点
    Path.home() / "Downloads" / "course-schedule",
    Path.home() / "Downloads",             # Edge 默认下载目录
]
INGEST_LOG = HERE / "ingested.json"

# 与课表内容强相关的文件名特征（用于在下载目录里筛掉无关 html/mhtml）
_SCHEDULE_NAME_HINT = re.compile(
    r"course-schedule|综合教务|教务管理|课表|kebiao|xskb|queryKb", re.I)


def _looks_like_schedule_name(p: Path) -> bool:
    return bool(_SCHEDULE_NAME_HINT.search(p.name))


# 「非空课表单元格」的正则：<td ... class="...cell..." ...> 后紧跟非空白内容。
# 课表页会先返回一张**空模板**（96 个空 <td class="cell">），课程随后由 JS 填充。
# 只按结构（class="cell" / data-jcindex）判断会把空模板误判为有效课表，
# 导致导出 0 条记录。实测判据（2026-09-23）：
#   空模板 → 非空 cell = 0；真课表 → 13。其余特征（\d+周、data-jcIndex）两者皆有。
_NONEMPTY_CELL_RE = re.compile(
    r"<td[^>]*class\s*=\s*[\"'][^\"']*\bcell\b[^\"']*[\"'][^>]*>\s*[^<\s]",
    re.I)

# 判定阈值：至少这么多非空单元格才算真课表
MIN_FILLED_CELLS = 3


def _count_filled_cells(html: str) -> int:
    """统计「非空课表单元格」数量，用于区分空模板与真课表。"""
    return len(_NONEMPTY_CELL_RE.findall(html or ""))


# --- 新版「课表查询」页（api/getKbxx，静态资源在 /jw/static/kbcx/）----------
#
# 结构与「我的课表」完全不同：**没有 `class="cell"`**，
# 表格行是 `<tr name="rowkb" sid="<节次>">`，格子是
# `<td id="Cell<星期><节次>" name="tdbox tdbox<星期>" rowspan="N">`，
# 课程内容放在 `<p class="content-detail" title="课程名(教室)">` 里。
# 故「已填充」判据改用课程卡片计数。
_KB_ROW_RE = re.compile(r"<tr[^>]*name\s*=\s*[\"']rowkb[\"']", re.I)
_KB_CARD_RE = re.compile(
    r"class\s*=\s*[\"'][^\"']*\bcontent-detail\b[^\"']*[\"']", re.I)
# 采集器导出时用该注释标出「紧随其后的表属于第几周」
_KB_WEEK_MARK_RE = re.compile(r"<!--\s*GXNU-WEEK\s+(\d+)\s*-->", re.I)


def _count_kbcx_cards(html: str) -> int:
    """统计新版页面的课程卡片数。"""
    return len(_KB_CARD_RE.findall(html or ""))


def _is_kbcx_html(html: str) -> bool:
    """是否为新版「课表查询」页的课表（以 `name="rowkb"` 行为标志）。"""
    return bool(_KB_ROW_RE.search(html or ""))


# 易班页 CSS Grid 的课程卡片计数（以 grid-area 定位的 div），
# 用于「已填充」判据 —— 易班页连 <table> 都没有，任何表格判据都失效。
_YZDX_CARD_COUNT_RE = re.compile(r"grid-area:\s*\d+\s*/\s*\d+", re.I)


def _count_yzdx_cards(html: str) -> int:
    """统计易班页 CSS Grid 的课程卡片数。"""
    return len(_YZDX_CARD_COUNT_RE.findall(html or ""))


def _has_schedule_content(html: str) -> bool:
    """课表内容判定：必须存在**已填充**的课程单元格，而非只有空表格骨架。"""
    html = html or ""
    if _is_kbcx_html(html):
        return _count_kbcx_cards(html) >= MIN_FILLED_CELLS
    if _is_yzdx_html(html):
        return _count_yzdx_cards(html) >= MIN_FILLED_CELLS
    return _count_filled_cells(html) >= MIN_FILLED_CELLS


def _structured_weeks(obj: dict) -> list:
    """取采集器导出的**结构化周数据**（两种来源共用同一字段形状）。

    字段形状（`{sid,label,range,courses:[{week,weekday,periodStart,periodEnd,
    course,room,teacher,raw}]}`）由 `schedule_from_kbcx_weeks()` 消费：

      · `kbcxWeeks` —— 教务系统新版「课表查询」页（api/getKbxx，逐周采集）
      · `yzdxWeeks` —— 易班「易知独秀」课表页（/yzdx/dean/course，接口一次给全学期）

    只认「**含课程**」的周 —— 空周不构成"有课表内容"，避免空壳导出被放行。
    """
    for key in ("kbcxWeeks", "yzdxWeeks"):
        weeks = obj.get(key)
        if not isinstance(weeks, list):
            continue
        if any(isinstance(w, dict) and (w.get("courses") or []) for w in weeks):
            return weeks
    return []


def _is_valid_json_export(p: Path) -> bool:
    """判断 JSON 是否为「含课表内容」的采集器导出（排除空壳/空模板）。"""
    try:
        raw = p.read_bytes()
        if len(raw) > 8 * 1024 * 1024:      # 采集器导出不含大图，>8MB 必非
            return False
        obj = json.loads(raw.decode("utf-8"))
    except Exception:
        return False
    if not isinstance(obj, dict):
        return False
    if obj.get("collector") != "gxnu-userscript":
        return False
    # 结构化周数据（易班课表页 / 教务新版课表查询页）：采集器已在浏览器側
    # 解析出课程，不依赖 pageHtml 的结构特征 —— 这两类页面本来就没有
    # `class="cell"` / `name="rowkb"`（易班页是 CSS Grid，连 <table> 都没有）。
    if _structured_weeks(obj):
        return True
    html = obj.get("pageHtml") or ""
    # 硬要求：必须有**已填充**的课程单元格（空模板一律判无效）
    return _has_schedule_content(html)


def _is_valid_mhtml(p: Path) -> bool:
    """判断 mhtml 是否含教务课表分区（而非首页/无关页）。"""
    try:
        if p.stat().st_size < 20_000:
            return False
        with p.open("rb") as fh:
            head = fh.read(4 * 1024 * 1024)
    except Exception:
        return False
    if (b"queryKbForXsd" in head or b"data-jcindex" in head
            or b"getKbxx" in head or b'name="rowkb"' in head):
        return True
    # 易班「易知独秀」课表页（/yzdx/dean/course）：CSS Grid，无 <table>，
    # 课程卡片以 `grid-area: qsj / xqj+1 / zzj+1 / xqj+2` 定位。
    return (b"grid-area" in head
            and (b"/yzdx/" in head or b"yiban.gxnu.edu.cn" in head))


def _is_valid_html(p: Path) -> bool:
    try:
        if p.stat().st_size < 2_000:
            return False
        with p.open("rb") as fh:
            head = fh.read(1024 * 1024)
    except Exception:
        return False
    text = head.decode("utf-8", errors="ignore")
    # 必须有课表结构标志，**且**存在已填充的课程单元格（排除空模板）
    if not re.search(r"data-jcindex|data-jcIndex|class\s*=\s*[\"'][^\"']*\bcell\b"
                     r"|name\s*=\s*[\"']rowkb[\"']",
                     text, re.I):
        return False
    return _has_schedule_content(text)


def find_exports() -> list[Path]:
    """扫描候选课表文件并做内容校验，按修改时间倒序返回。

    校验要点：排除「学期暂未发布」之类的空壳导出与无关网页。

    注意 JSON 用 `*.json` 宽匹配而非 `course-schedule-*.json`：
    Tampermonkey 的 GM_download 走 blob URL 时，浏览器常把文件存成
    **UUID 名**（如 `56f6057b-52d3-4573-9c7d-5de4b79aa529.json`），
    脚本设定的文件名不生效。实测（2026-09-23）因此一直扫不到导出文件。
    内容校验会检查 `collector == "gxnu-userscript"`，无关 JSON 会被快速排除。
    """
    found: dict[str, Path] = {}
    for d in SEARCH_DIRS:
        if not d.is_dir():
            continue
        for pat in ("course-schedule-*.json", "*.json",
                    "*.mhtml", "*.html", "*.htm"):
            for p in d.glob(pat):
                try:
                    if str(p.resolve()) in found:
                        continue
                except OSError:
                    continue
                found[str(p.resolve())] = p

    valid: list[Path] = []
    for p in found.values():
        suffix = p.suffix.lower()
        try:
            if suffix == ".json":
                ok = _is_valid_json_export(p)
            elif suffix in (".mhtml", ".mht"):
                ok = _is_valid_mhtml(p)
            elif suffix in (".html", ".htm"):
                # 只接受文件名相关或内容含课表表格的
                ok = _looks_like_schedule_name(p) and _is_valid_html(p)
            else:
                ok = False
        except Exception:
            ok = False
        if ok:
            valid.append(p)
    return sorted(valid, key=lambda p: p.stat().st_mtime, reverse=True)


def load_ingested() -> dict:
    if INGEST_LOG.exists():
        try:
            return json.loads(INGEST_LOG.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def mark_ingested(path: Path, digest: str) -> None:
    data = load_ingested()
    data[str(path.resolve())] = {
        "sha256": digest,
        "consumed_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    INGEST_LOG.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                          encoding="utf-8")


# --- 三种格式 → 统一 HTML 抽取 ---------------------------------------------
def _html_from_json(p: Path) -> tuple[str, dict]:
    obj = json.loads(p.read_text(encoding="utf-8"))
    html = obj.get("pageHtml") or ""
    meta = {
        "collected_at": obj.get("collectedAt", ""),
        "semester": obj.get("semester", ""),
        "student": obj.get("student", {}) or {},
        "source_type": "json",
        # 新版「课表查询」页 / 易班「易知独秀」课表页：采集器已用浏览器 DOM
        # 解析出结构化周数据，比 Python 再解析 HTML 字符串可靠，故优先使用。
        "page_kind": obj.get("pageKind", ""),
        "kbcx_weeks": _structured_weeks(obj),
        "current_week": obj.get("currentWeek") or 0,
        # 本次数据覆盖到的**全部**周次（易班接口按周给数据，含该周无课的情况）。
        # 显式给出可让「某门课被取消」也能被识别，而不只是"新增"。
        "touched_weeks": obj.get("touchedWeeks") or [],
        # 采集器如实报告的「没采到」的周次 —— 这些周状态未知，
        # 同步时**保持原样**，绝不当成"该周无课"去清空。
        "skipped_weeks": obj.get("skippedWeeks") or [],
        "empty_weeks": obj.get("emptyWeeks") or [],
    }
    return html, meta


def _html_from_mhtml(p: Path) -> tuple[str, dict]:
    """从 MHTML 中定位教务课表分区并取出其 HTML。

    支持两种教务页面：
      · 旧版「我的课表」→ 分区 URL 含 `queryKbForXsd`
      · 新版「课表查询」→ 分区 URL 含 `api/getKbxx`（静态资源在 /jw/static/kbcx/）
    """
    import email as _email

    msg = _email.message_from_bytes(p.read_bytes())
    best_html, best_loc = "", ""
    best_score, best_len = -1, 0
    fallback_html, fallback_len = "", 0

    for part in msg.walk():
        if part.get_content_type() != "text/html":
            continue
        loc = part.get("Content-Location", "") or ""
        payload = part.get_payload(decode=True) or b""
        if not payload:
            continue
        text = payload.decode("utf-8", errors="ignore")
        score = 0
        if "queryKbForXsd" in loc:
            score += 100
        if "getKbxx" in loc:
            score += 100
        if "/yzdx/" in loc or "yiban" in loc:
            score += 100           # 易班「易知独秀」课表页
        if "data-jcindex" in text:
            score += 50
        if 'class="cell"' in text:
            score += 30
        if 'name="rowkb"' in text:
            score += 60            # 新版课表行标志
        if "content-detail" in text:
            score += 20
        if "grid-area" in text:
            score += 60            # 易班页 CSS Grid 课程卡片
        if len(text) > 5000:
            score += 10
        # 先比得分，得分相同再取更长的一份
        if score > 0 and (score > best_score
                          or (score == best_score and len(text) > best_len)):
            best_html, best_loc = text, loc
            best_score, best_len = score, len(text)
        if "周" in text and len(text) > fallback_len:
            fallback_html, fallback_len = text, len(text)

    if best_html:
        return best_html, {"source_type": "mhtml", "part_location": best_loc,
                           "collected_at": "", "kbcx_weeks": []}
    if fallback_html:
        return fallback_html, {"source_type": "mhtml", "part_location": "",
                               "collected_at": "", "kbcx_weeks": []}
    raise RuntimeError(f"MHTML 中未找到课表分区: {p}")


def _html_from_html(p: Path) -> tuple[str, dict]:
    raw = p.read_bytes()
    text = raw.decode("utf-8", errors="ignore")
    if "charset=gb" in text[:2000].lower() or "charset=\"gb" in text[:2000].lower():
        text = raw.decode("gb18030", errors="ignore")
    return text, {"source_type": "html", "collected_at": "", "kbcx_weeks": []}


def _extract_html(p: Path) -> tuple[str, dict]:
    suffix = p.suffix.lower()
    if suffix == ".json":
        return _html_from_json(p)
    if suffix in (".mhtml", ".mht"):
        return _html_from_mhtml(p)
    return _html_from_html(p)


def pick_fresh_export(force: bool = False) -> tuple[Path, str, dict]:
    """挑一份待处理文件，返回 (路径, 课表HTML, 元信息)。

    优先取「未消费过」的最新文件；若都已消费，返回最新一份并标记
    already_ingested=True（由调用方决定是否强制重写）。
    """
    import hashlib

    exports = find_exports()
    if not exports:
        raise FileNotFoundError(
            "未找到可用的课表文件。\n"
            "  查找目录（只读，不修改下载路径）：\n"
            + "\n".join(f"    - {d}" for d in SEARCH_DIRS)
            + "\n  获取方式（任选其一）：\n"
              "    A. 油猴脚本「GXNU 课表采集器」→ 点击采集，导出 course-schedule-*.json\n"
              "    B. Edge 打开课表页 → Ctrl+S → 另存为「单个文件(*.mhtml)」\n"
              "    C. Edge 打开课表页 → Ctrl+S → 另存为「网页，仅 HTML」\n"
              "  ⚠ 课表页地址（注意：是 /jw/admin?sfjrxk=1 里的「我的课表」iframe）：\n"
              f"    {SCHEDULE_PAGE_URL}\n"
              "  ⚠ 若采集出的文件里没有课表表格（脚本会自动识别并跳过），\n"
              "    说明采集时停在父页面（只有导航壳），请切到「我的课表」标签页再采集。")

    ingested = load_ingested()

    for p in exports:
        raw = p.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        rec = ingested.get(str(p.resolve()))
        if force or not rec or rec.get("sha256") != digest:
            html, meta = _extract_html(p)
            meta.update(source_file=str(p), sha256=digest,
                        already_ingested=False)
            return p, html, meta

    # 全部已消费过 → 返回最新一份
    latest = exports[0]
    raw = latest.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    html, meta = _extract_html(latest)
    meta.update(source_file=str(latest), sha256=digest, already_ingested=True)
    return latest, html, meta


def fetch_html(force: bool = False) -> tuple[str, dict]:
    """取得课表 HTML 与元信息，返回 (html, meta)。"""
    path, html, meta = pick_fresh_export(force=force)
    # 采集器已给出结构化周数据时，HTML 仅作备份，不强制长度校验
    has_weeks = bool(meta.get("kbcx_weeks"))
    if not has_weeks and (not html or len(html) < 200):
        raise RuntimeError(
            f"文件缺少有效课表内容: {path}\n"
            "  可能是另存时不在课表页，请重新采集。")
    # 二次护栏：拿到的是「空课表模板」（有表格骨架、无课程内容）时拒绝解析，
    # 否则会静默产出 0 条课表并覆盖已有文件。
    if not has_weeks and not _has_schedule_content(html):
        if _is_kbcx_html(html):
            filled = _count_kbcx_cards(html)
        elif _is_yzdx_html(html):
            filled = _count_yzdx_cards(html)
        else:
            filled = _count_filled_cells(html)
        raise RuntimeError(
            f"课表内容为空模板（已填充课程 {filled} 个，"
            f"少于 {MIN_FILLED_CELLS}）: {path}\n"
            "  原因通常是采集时课程数据尚未渲染完成。\n"
            "  请打开「我的课表」/「课表查询」，等表格**出现课程**后重新采集。")
    meta["structured_rows"] = 0
    return html, meta


def backup_existing() -> list[Path]:
    """备份目标目录下已有的课表 md 文件。

    注意：备份目录保留最近 N 份，不自动清理 —— 手工维护的笔记被覆盖时，
    这里是唯一的回退点。
    """
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    saved: list[Path] = []
    for f in KB_DIR.glob("课表_*.md"):
        dst = BACKUP_DIR / f"{f.stem}.{stamp}{f.suffix}"
        shutil.copy2(f, dst)
        saved.append(dst)
    return saved


def guard_manual_edits() -> bool:
    """检查目标文件是否被手工编辑过（含自动生成标记之外的内容）。

    返回 True 表示可以安全覆盖，False 表示检测到手工内容需确认。
    判定方式：文件里存在自动生成文件不会出现的「自定义小节」。
    """
    target = KB_DIR / f"课表_{SEMESTER}_周视图.md"
    if not target.exists():
        return True
    content = _read_all_targets_text()
    if not content:
        return True
    # 自动生成的文件带有固定来源标记；缺失说明已被改写
    if "source: sync_course_schedule.py" not in content:
        return False
    # 自动生成的文件不含这些人工小节
    for marker in ("其他提醒", "备注", "人工", "TODO"):
        if marker in content:
            return False
    # 去掉加密行后再查注入痕迹：Meld 密文本就是长 base64 串，不去掉会误报。
    # 加密行本身**不算**阻挡条件 —— 它们会被 apply_protected 原样保留。
    masked = "\n".join(
        ln for ln in content.split("\n")
        if not _MELD_ENCRYPT_LINE.search(ln))
    if _INJECTION_HINT.search(masked):
        return False
    return True


# Meld Encrypt 插件的加密标记：🔐<密文>🔐（v2.4.5 main.js 中 /🔐(.*?)🔐/g）
# 单行版（用于逐行识别需要原样保留的加密行）
_MELD_ENCRYPT_LINE = re.compile(r"🔐.*🔐")
# 文件级版（跨行探测）
_MELD_ENCRYPT_HINT = re.compile(r"🔐.*?🔐", re.S)
# 其他外部工具注入痕迹：连续 60+ 无空白字符的疑似 base64 长串
_INJECTION_HINT = re.compile(
    r"(?<![A-Za-z0-9+/=])[A-Za-z0-9+/=]{60,}(?![A-Za-z0-9+/=])")

# 允许自动保留的加密行数上限。超过则说明加密的不只是一行个人信息，
# 很可能包含整段笔记 —— 此时应停下让人工确认，避免误伤。
MAX_PROTECTED_LINES = 3


def _read_file_text(name: str) -> str:
    try:
        return (KB_DIR / name).read_text(encoding="utf-8")
    except Exception:
        return ""


def _read_target_text() -> str:
    """读取周视图课表文件内容，用于注入/手工内容检测。"""
    return _read_file_text(f"课表_{SEMESTER}_周视图.md")


def _all_target_names() -> list[str]:
    """所有当前目标文件名 + 旧文件名（旧名也要参与加密行保留与安全检查）。"""
    return [n for n, _ in TARGETS] + LEGACY_TARGETS


def _read_all_targets_text() -> str:
    """合并读取所有目标文件内容（含旧名），用于全局安全检查。"""
    return "\n".join(_read_file_text(n) for n in _all_target_names())


def extract_protected_lines(name: str = "") -> list[str]:
    """取出目标文件里由 Meld Encrypt 加密的行（形如 `🔐<密文>🔐`）。

    这是**用户刻意加密的私有数据**（实测为姓名/学号/校区那一行），
    同步重写时必须原样搬回去，否则等于把用户的加密内容删掉。

    不传 name 时合并所有目标文件（用于安全检查计数）；
    传 name 时只取该文件自身的加密行 —— 两文件的密文不同（随机 IV），
    按文件各自保留才不会互相串入。
    """
    names = [name] if name else _all_target_names()
    out: list[str] = []
    for n in names:
        for ln in _read_file_text(n).split("\n"):
            t = ln.strip()
            if t and _MELD_ENCRYPT_LINE.search(t) and t not in out:
                out.append(t)
    return out


def count_protected_lines() -> int:
    """统计需要保留的加密行数（用于判断是否超出安全上限）。"""
    return len(extract_protected_lines())


def apply_protected(content: str, target_name: str = "") -> str:
    """把**该文件自身的**加密行原样插回内容头部原位。

    自动生成的 `- **姓名**：…` 行会被加密行**替换**（这正是用户加密它的原因）。
    若正文没有姓名行，则在「当前校历周次」前插入。

    新文件（如 v4 新增的 `_周视图.md`）首次写入时自身还没有加密行，
    此时回退到**同名旧文件**（`_按周次.md`）去取，保证用户加密的隐私行
    在改名过程中不丢失。
    """
    protected = extract_protected_lines(target_name)
    if not protected and target_name:
        legs = _legacy_of(target_name)
        for lg in legs:
            protected = extract_protected_lines(lg)
            if protected:
                break
    if not protected:
        return content
    return _inject_protected(content, protected)


def _legacy_of(name: str) -> list[str]:
    """给定新文件名，返回它可能对应的旧文件名列表（用于继承加密行）。"""
    out: list[str] = []
    if name.endswith("_周视图.md"):
        out.append(name.replace("_周视图.md", "_按周次.md"))
    return out


def render_month(sched: Schedule) -> str:
    """`课表_<学期>_月视图.md`：按**日期**逐日排列（含周末，无课日标注无课）。

    与周视图互补：周视图看「一周的格子」，月视图看「这个月每天上什么」，
    适合考前 / 调课时快速扫一遍。
    """
    lines = render_common_head(
        sched, f"{sched.semester} 学年第 1 学期课表（月视图）")
    lines.append("## 月视图")
    lines.append("")

    # 日期 → 该日课程（按「距第 1 周周一的天数」索引，跨月自然衔接）
    by_day: dict[int, list[CourseEntry]] = {}
    for e in sched.entries:
        for w in e.weeks:
            mon = WEEK1_MONDAY + timedelta(weeks=w - 1)
            d = mon + timedelta(days=e.weekday - 1)
            by_day.setdefault((d - WEEK1_MONDAY).days, []).append(e)

    if not by_day:
        lines.append("本学期暂无课程安排。")
        lines.append("")
        return "\n".join(lines)

    today = date.today()
    first = min(by_day)
    last = max(by_day)

    cur_month = None
    d0 = first
    while d0 <= last:
        day = WEEK1_MONDAY + timedelta(days=d0)
        ws = d0 // 7 + 1

        # 换月时起一个新的月份小节
        key = (day.year, day.month)
        if key != cur_month:
            cur_month = key
            if d0 != first:
                lines.append("")
            lines.append(f"### {day.year} 年 {day.month} 月")
            lines.append("")

        items = by_day.get(d0, [])
        wd = WEEKDAY_NAMES[day.weekday()]
        flag = "　**← 今天**" if day == today else ""
        if not items:
            lines.append(f"- **{day:%m.%d}（{wd}）** 第 {ws} 周　— 无课{flag}")
            d0 += 1
            continue

        lines.append(f"- **{day:%m.%d}（{wd}）** 第 {ws} 周{flag}")
        for e in sorted(items, key=lambda x: min(x.periods or [99])):
            pd = fmt_periods(e.periods)
            t = fmt_period_time(e.periods, entry_campus(e, sched.campus))
            lines.append(f"    - 第 {pd} 节　{t}　**{e.course}**"
                         f"　{e.teacher}　{e.room}")
        d0 += 1
    lines.append("")
    return "\n".join(lines)


# 两个输出文件 → 各自使用的渲染器（三文件是**不同视图**）
TARGETS: list[tuple[str, object]] = [
    (f"课表_{SEMESTER}_周视图.md", render_by_week),    # 周视图网格（仿手机）
    (f"课表_{SEMESTER}_月视图.md", render_month),      # 逐日排列
    (f"课表_{SEMESTER}.md", render_summary),           # 课程汇总视图
]

# 旧文件名（v3 之前叫「按周次」）。首次运行时会自动迁移/清理。
LEGACY_TARGETS: list[str] = [f"课表_{SEMESTER}_按周次.md"]


def write_targets(sched: Schedule) -> list[Path]:
    """写入各目标文件：各自渲染 + 各自保留加密行。返回写入的路径。"""
    written: list[Path] = []
    for name, renderer in TARGETS:
        content = apply_protected(renderer(sched), name)
        path = KB_DIR / name
        path.write_text(content, encoding="utf-8")
        written.append(path)
    _migrate_legacy_targets()
    return written


def _inject_protected(content: str, protected: list[str]) -> str:
    """把加密行插到「当前校历周次」之前（内容里尚无加密行时使用）。"""
    out: list[str] = []
    inserted = False
    for ln in content.split("\n"):
        if not inserted and (ln.startswith("- **姓名**")
                            or ln.startswith("- **当前校历周次**")):
            out.extend(protected)
            inserted = True
            if ln.startswith("- **姓名**"):
                continue
        out.append(ln)
    if not inserted:
        out.extend(["", *protected])
    return "\n".join(out)


def _migrate_legacy_targets() -> list[Path]:
    """把旧文件名（`_按周次.md`）里的**加密行**迁到新文件，再归档旧文件。

    v4 起周视图改名为 `_周视图.md`。旧文件里可能留有用户加密的隐私行
    （Meld Encrypt），必须保证它被新文件继承，不能随旧文件一起消失。
    旧文件本身移到备份目录而非删除（备份目录只增不删）。
    """
    moved: list[Path] = []
    for legacy in LEGACY_TARGETS:
        old = KB_DIR / legacy
        if not old.exists():
            continue
        # 旧文件的加密行 → 补进新周视图文件（若新文件里还没有）
        prot = extract_protected_lines(legacy)
        new_name = f"课表_{SEMESTER}_周视图.md"
        txt = _read_file_text(new_name)
        miss = [p for p in prot if p and p not in txt]
        if miss:
            (KB_DIR / new_name).write_text(
                _inject_protected(txt, miss), encoding="utf-8")
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        dest = BACKUP_DIR / f"{legacy}.migrated-{datetime.now():%Y%m%d-%H%M%S}"
        shutil.move(str(old), str(dest))
        moved.append(dest)
    return moved


# --- 主流程 ---------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="同步广西师大课表到 Obsidian")
    ap.add_argument("--dry-run", action="store_true",
                    help="只比对，不写入任何文件")
    ap.add_argument("--show-current", action="store_true",
                    help="基于最近导出文件打印当前周课表后退出")
    ap.add_argument("--force", action="store_true",
                    help="忽略已消费记录，并用最新导出文件强制重写")
    ap.add_argument("--list-exports", action="store_true",
                    help="列出找到的所有导出文件及其消费状态")
    args = ap.parse_args()

    if args.list_exports:
        exports = find_exports()
        if not exports:
            print("未找到任何可用课表文件。查找目录（只读）：")
            for d in SEARCH_DIRS:
                print(f"  - {d}")
            return 2
        ingested = load_ingested()
        print(f"共找到 {len(exports)} 个可用课表文件：")
        for p in exports:
            rec = ingested.get(str(p.resolve()))
            stamp = datetime.fromtimestamp(p.stat().st_mtime)
            state = "已消费" if rec else "待处理"
            size_kb = p.stat().st_size / 1024
            print(f"  [{state}] {p.name}  ({size_kb:.0f} KB, "
                  f"修改于 {stamp:%Y-%m-%d %H:%M:%S})")
            print(f"           {p}")
        return 0

    ws = current_week()
    print(f"=== 课表同步 {datetime.now():%Y-%m-%d %H:%M:%S} ===")
    print(f"学期 {SEMESTER}｜校历第 {ws} 周")

    if args.show_current:
        try:
            html, meta = fetch_html(force=False)
            sched = schedule_from_meta(html, meta)
            apply_partial_merge(sched)
        except Exception as exc:
            print(f"[FAIL] {exc}")
            return 2
        items = [e for e in sched.entries if ws in e.weeks]
        if not items:
            print(f"第 {ws} 周无课程安排。")
            return 0
        print(f"第 {ws} 周共 {len(items)} 条：")
        for e in items:
            wd = WEEKDAY_NAMES[e.weekday - 1]
            pd = fmt_periods(e.periods)
            print(f"  {wd} 第{pd}节  {e.course}（{e.teacher}）  {e.room}")
        return 0

    # 1) 读取油猴脚本导出的课表
    try:
        html, meta = fetch_html(force=args.force)
    except FileNotFoundError as exc:
        print(f"[FAIL] 未找到导出文件：{exc}")
        log_run({"ts": datetime.now().isoformat(), "status": "no_export",
                 "error": str(exc)})
        return 2
    except Exception as exc:
        print(f"[FAIL] 读取导出失败: {type(exc).__name__}: {exc}")
        log_run({"ts": datetime.now().isoformat(), "status": "read_error",
                 "error": str(exc)})
        return 2

    print(f"数据源: {Path(meta['source_file']).name}"
          f"（类型 {meta.get('source_type', '?')}"
          + (f", 采集于 {meta['collected_at']}" if meta.get("collected_at") else "")
          + "）")
    if meta["already_ingested"]:
        print("  提示：该文件此前已处理过，内容未变化。")
    stu = meta.get("student") or {}
    if stu.get("name"):
        print(f"  学生：{stu.get('name')}"
              + (f"  学号：{stu.get('studentId')}" if stu.get("studentId") else ""))
    if meta.get("semester"):
        print(f"  学期：{meta['semester']}")

    # 2) 解析
    try:
        sched = schedule_from_meta(html, meta)
    except Exception as exc:
        print(f"[FAIL] 解析失败: {type(exc).__name__}: {exc}")
        log_run({"ts": datetime.now().isoformat(), "status": "parse_error",
                 "error": str(exc)})
        return 3

    # 2b) 新版「课表查询」页一次只给一周 → 与既有课表合并，避免丢掉其他周
    try:
        note = apply_partial_merge(sched)
        if note:
            print(note)
    except RuntimeError as exc:
        print(f"[STOP] {exc}")
        log_run({"ts": datetime.now().isoformat(),
                 "status": "partial_merge_unavailable",
                 "touched_weeks": sched.touched_weeks})
        return 6
    except Exception as exc:
        print(f"  [WARN] 部分周次合并异常，按整体覆盖处理: {exc}")

    # 2c) 采集器报告的「没采到」的周次 —— 如实转达，别让用户以为课表就长这样
    skipped = meta.get("skipped_weeks") or []
    if skipped:
        print(f"  ⚠ 采集器报告 {len(skipped)} 个周次未采到"
              f"（第 {'、'.join(str(w) for w in skipped)} 周），这些周的安排保持原样。")
    empty = meta.get("empty_weeks") or []
    if empty:
        print(f"  · 第 {'、'.join(str(w) for w in empty)} 周确认无课程。")

    # 用导出文件里的元信息补全
    if not sched.name and stu.get("name"):
        sched.name = stu["name"]
    if not sched.student_id and stu.get("studentId"):
        sched.student_id = stu["studentId"]
    # 再从本地 config.json 补全（学号不在页面 DOM 里，只能手动配一次）
    cfg = load_config()
    if not sched.name and cfg.get("name"):
        sched.name = cfg["name"]
    if not sched.student_id and cfg.get("student_id"):
        sched.student_id = cfg["student_id"]
    if not sched.campus and cfg.get("campus"):
        sched.campus = cfg["campus"]

    print(f"解析到 {len(sched.entries)} 条排课记录")
    if not sched.entries:
        print("[WARN] 未解析出任何课程 —— 导出内容可能不含课表表格。")
        log_run({"ts": datetime.now().isoformat(), "status": "empty_parse",
                 "source": meta["source_file"]})
        return 3

    # 3) 变更比对
    old = load_state()
    is_first_run = not old
    delta = diff_schedules(old, sched)
    # 渲染格式升级也要重写（否则条目没变就永远不落地新格式）
    render_stale = bool(old) and old.get("render_version") != RENDER_VERSION

    # 首次运行：建立基线，不算"变更"
    if is_first_run:
        print(f"解析成功，共 {len(sched.entries)} 条排课记录。")
        if args.dry_run:
            print("\n[dry-run] 未写入任何文件。")
            return 0
        saved = backup_existing()
        if saved:
            print(f"已备份 {len(saved)} 个原文件 -> {BACKUP_DIR}")
        out = write_targets(sched)[0]
        save_state(sched)
        mark_ingested(Path(meta["source_file"]), meta["sha256"])
        print(f"✓ 已建立基线并写入: {out.name}")
        log_run({"ts": datetime.now().isoformat(), "status": "baseline",
                 "entry_count": len(sched.entries),
                 "source": Path(meta["source_file"]).name})
        return 0

    if not delta["changed"]:
        if not render_stale:
            print("✓ 课表无变更。")
            # 仍记录已消费，避免下次重复处理同一份导出
            mark_ingested(Path(meta["source_file"]), meta["sha256"])
            log_run({"ts": datetime.now().isoformat(), "status": "unchanged",
                     "entry_count": len(sched.entries),
                     "source": Path(meta["source_file"]).name})
            if not args.force:
                return 0
        else:
            print(f"⚠ 课表内容未变，但渲染格式已升级"
                  f"（v{old.get('render_version')} → v{RENDER_VERSION}），重写输出。")
    else:
        print(f"⚠ 检测到变更：新增 {delta['added_count']} 条，"
              f"移除 {delta['removed_count']} 条")
        for x in delta["added"][:10]:
            print(f"   + {x}")
        for x in delta["removed"][:10]:
            print(f"   - {x}")

    if args.dry_run:
        print("\n[dry-run] 未写入任何文件。")
        return 1

    # 4) 安全检查：目标文件是否被手工编辑过
    if not guard_manual_edits() and not args.force:
        print("[STOP] 检测到目标文件含有手工内容（非自动生成）。")
        print(f"       文件：{KB_DIR / f'课表_{SEMESTER}_周视图.md'}")
        print("       为避免覆盖你的笔记，已中止写入。")
        print("       原文件已备份到 .backup/；确认可覆盖请加 --force 重跑。")
        log_run({"ts": datetime.now().isoformat(), "status": "blocked_manual",
                 "added": delta["added"], "removed": delta["removed"]})
        return 4

    # 4b) 加密内容保护：Meld Encrypt 加密行会被 apply_protected 原样保留。
    #     但加密行过多时说明加密的远不止一行个人信息（可能是整段笔记），
    #     此时停下让人工确认，避免误伤 —— 该判断不受 --force 影响。
    n_protected = count_protected_lines()
    if n_protected > MAX_PROTECTED_LINES:
        print(f"[STOP] 目标文件含 {n_protected} 行 Meld Encrypt 加密内容"
              f"（上限 {MAX_PROTECTED_LINES}）。")
        print("       加密范围超出「个人信息行」的预期，自动同步无法安全保留。")
        print("       请先在 Obsidian 中确认这些加密内容的归属后再同步。")
        log_run({"ts": datetime.now().isoformat(), "status": "blocked_encrypted",
                 "protected_lines": n_protected})
        return 5

    # 5) 备份 + 写入
    saved = backup_existing()
    if saved:
        print(f"已备份 {len(saved)} 个原文件 -> {BACKUP_DIR}")

    outs = write_targets(sched)
    save_state(sched)
    mark_ingested(Path(meta["source_file"]), meta["sha256"])

    print(f"✓ 已更新 {len(outs)} 个文件：")
    for p in outs:
        print(f"   · {p.name}")
    log_run({"ts": datetime.now().isoformat(), "status": "updated",
             "added": delta["added"], "removed": delta["removed"],
             "entry_count": len(sched.entries),
             "source": Path(meta["source_file"]).name})
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
