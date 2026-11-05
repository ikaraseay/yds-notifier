"""官方「各主题赛事赛程一览」解析与日程提醒。

为什么需要它：研电赛是季节性赛事，官网两三个月才发一条通知，
只靠「新公告」推送，用户一年里有大半时间收不到任何有用信息。
而研创网每年发布的《各主题赛事赛程一览》包含 20 项赛事的
报名 / 提交作品 / 决赛时间，是**确定性数据**，不依赖 AI，
可以稳定驱动三件事：

1. 日历里提前出现报名截止、提交截止、决赛周；
2. 截止前 T-30 / T-7 / T-3 / T-1 的提醒邮件；
3. 归档页按赛事展示「当前处于哪个阶段」。

数据落盘 `data/schedule.json`，每周最多刷新一次。
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Dict, Iterable, List, Optional, Sequence

from bs4 import BeautifulSoup

from .models import Notice
from .personas import (
    action_for,
    infer_audiences,
    normalize_contest,
)

log = logging.getLogger("yds")

_RANGE_DATE = re.compile(r"(\d{1,2})\s*月\s*(\d{1,2})\s*日")
# 「8月11日-15日」这种只写结束日的范围
_DAY_END = re.compile(r"(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*[-–—~至]\s*(\d{1,2})\s*日")
_YEAR = re.compile(r"(20\d{2})\s*年度?")

# 赛程字段 → (中文标签, 阶段)
FIELDS = (
    ("signup_end", "报名截止", "报名"),
    ("submit_end", "提交作品截止", "提交作品"),
    ("final_start", "决赛开始", "决赛"),
)


@dataclass
class ContestSchedule:
    contest: str = ""
    signup_start: str = ""
    signup_end: str = ""
    submit_start: str = ""
    submit_end: str = ""
    final_start: str = ""
    final_end: str = ""
    source_url: str = ""

    def to_dict(self) -> dict:
        return {
            "contest": self.contest,
            "signupStart": self.signup_start,
            "signupEnd": self.signup_end,
            "submitStart": self.submit_start,
            "submitEnd": self.submit_end,
            "finalStart": self.final_start,
            "finalEnd": self.final_end,
            "sourceUrl": self.source_url,
        }

    @classmethod
    def from_dict(cls, raw: dict) -> "ContestSchedule":
        return cls(
            contest=str(raw.get("contest") or ""),
            signup_start=str(raw.get("signupStart") or ""),
            signup_end=str(raw.get("signupEnd") or ""),
            submit_start=str(raw.get("submitStart") or ""),
            submit_end=str(raw.get("submitEnd") or ""),
            final_start=str(raw.get("finalStart") or ""),
            final_end=str(raw.get("finalEnd") or ""),
            source_url=str(raw.get("sourceUrl") or ""),
        )


def _ranges(cell: str, year: int) -> tuple[str, str]:
    """把「6月27日-10月23日」「12月26日-27日」解析成两个 ISO 日期。

    跨年处理：结束月份小于开始月份时，结束日进位到次年（12 月报名、1 月截止）。
    """
    text = (cell or "").strip()
    m_end = _DAY_END.search(text)
    if m_end:
        s_m, s_d, e_d = int(m_end.group(1)), int(m_end.group(2)), int(m_end.group(3))
        try:
            start = date(year, s_m, s_d)
            end = date(year, s_m, e_d)
        except ValueError:
            return "", ""
        if end < start:
            end = end.replace(month=end.month + 1) if end.month < 12 else end.replace(year=end.year + 1, month=1)
        return start.isoformat(), end.isoformat()
    hits = _RANGE_DATE.findall(text)
    if not hits:
        return "", ""
    start_m, start_d = int(hits[0][0]), int(hits[0][1])
    end_m, end_d = (int(hits[1][0]), int(hits[1][1])) if len(hits) > 1 else (start_m, start_d)
    start_y = year
    end_y = year + 1 if end_m < start_m else year
    try:
        start = date(start_y, start_m, start_d)
        end = date(end_y, end_m, end_d)
    except ValueError:
        return "", ""
    if end < start:
        end = end.replace(year=end.year + 1)
    return start.isoformat(), end.isoformat()


def parse_schedule(html: str, year: int, source_url: str = "") -> List[ContestSchedule]:
    """解析赛程一览详情页里的表格；无表格返回空列表（调用方保留旧缓存）。"""
    soup = BeautifulSoup(html or "", "html.parser")
    table = soup.find("table")
    if table is None:
        return []
    out: List[ContestSchedule] = []
    for row in table.find_all("tr"):
        cells = [c.get_text(" ", strip=True) for c in row.find_all(["td", "th"])]
        if len(cells) < 5:
            continue
        if cells[0] in ("序号", "") and cells[1] in ("主题赛事", ""):
            continue
        name = normalize_contest(cells[1]) or cells[1].strip()
        if not name or not any(ch in name for ch in ("大赛", "竞赛")):
            continue
        s1, e1 = _ranges(cells[2], year)
        s2, e2 = _ranges(cells[3], year)
        s3, e3 = _ranges(cells[4], year)
        out.append(ContestSchedule(
            contest=name,
            signup_start=s1, signup_end=e1,
            submit_start=s2, submit_end=e2,
            final_start=s3, final_end=e3,
            source_url=source_url,
        ))
    return out


def schedule_year(notice_title: str, fallback: int | None = None) -> int:
    m = _YEAR.search(notice_title or "")
    if m:
        return int(m.group(1))
    return fallback or datetime.now().year


def find_schedule_notice(notices: Iterable[Notice]) -> Optional[Notice]:
    """从「大赛通知」列表里找到当年的赛程一览（标题含「赛程」与「一览」）。"""
    cands = [n for n in notices if "赛程" in n.title and ("一览" in n.title or "安排" in n.title)]
    if not cands:
        return None
    year = str(datetime.now().year)
    # 列表里可能同时有往年赛程，优先取标题带当前年份的
    for n in cands:
        if year in n.title:
            return n
    return max(cands, key=lambda n: n.published or date.min)


class ScheduleStore:
    """`data/schedule.json` 的读写与提醒生成。"""

    def __init__(self, path: str, keep_days: int = 400):
        self.path = path
        self.keep_days = keep_days
        self.year = 0
        self.updated_at = ""
        self.source_url = ""
        self.contests: List[ContestSchedule] = []
        self.load()

    def load(self) -> None:
        try:
            with open(self.path, encoding="utf-8") as fh:
                raw = json.load(fh)
            if not isinstance(raw, dict):
                return
            self.year = int(raw.get("year") or 0)
            self.updated_at = str(raw.get("updatedAt") or "")
            self.source_url = str(raw.get("sourceUrl") or "")
            self.contests = [
                ContestSchedule.from_dict(c)
                for c in (raw.get("contests") or [])
                if isinstance(c, dict) and c.get("contest")
            ]
        except (OSError, ValueError, json.JSONDecodeError):
            pass

    @property
    def empty(self) -> bool:
        return not self.contests

    def stale(self, days: int = 7) -> bool:
        if not self.updated_at:
            return True
        try:
            last = datetime.fromisoformat(self.updated_at)
        except ValueError:
            return True
        return (datetime.now(timezone.utc) - last) > timedelta(days=days)

    def replace(self, contests: Sequence[ContestSchedule], year: int, source_url: str) -> bool:
        if not contests:
            return False
        self.contests = list(contests)
        self.year = year
        self.source_url = source_url
        self.updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        return True

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        payload = {
            "version": 1,
            "year": self.year,
            "updatedAt": self.updated_at,
            "sourceUrl": self.source_url,
            "contests": [c.to_dict() for c in self.contests],
        }
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.path) or ".", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, self.path)

    def payload(self, include: Sequence[str] | None = None) -> List[dict]:
        """同步给 Worker 的赛程（只发日期，不含内部字段）。"""
        names = set(include or [])
        rows = [c.to_dict() for c in self.contests if not names or c.contest in names]
        return rows

    def reminders(
        self,
        today: date | None = None,
        horizons: Sequence[int] = (30, 7, 3, 1),
        include: Sequence[str] | None = None,
    ) -> List[Notice]:
        """生成落在提醒窗口内的日程通知（同一截止日同一天只生成一条）。"""
        today = today or date.today()
        names = set(include or [])
        out: List[Notice] = []
        seen_days: set = set()
        for c in self.contests:
            if names and c.contest not in names:
                continue
            for field_name, label, stage in FIELDS:
                end = getattr(c, field_name, "")
                if not end:
                    continue
                # 报名与提交常常同一天截止，只保留第一条（报名截止），避免同天两封提醒
                if (c.contest, end) in seen_days:
                    continue
                try:
                    target = date.fromisoformat(end)
                except ValueError:
                    continue
                days = (target - today).days
                if days not in horizons:
                    continue
                seen_days.add((c.contest, end))
                key = f"sched:{c.contest}:{field_name}:{end}:d{days}"
                title = f"{label}还有 {days} 天：{c.contest}"
                summary = (
                    f"官方赛程显示，{c.contest}{label}为 {end}，"
                    f"距今 {days} 天。请按通知要求提前准备。"
                )
                out.append(Notice(
                    source="官方赛程",
                    source_key="schedule",
                    title=title,
                    url=c.source_url,
                    published=today,
                    summary=summary,
                    uid=key,
                    deadline=end,
                    contest=c.contest,
                    stage=stage,
                    audiences=infer_audiences(stage, title),
                    action=action_for(stage),
                    ai_events=[{
                        "date": end,
                        "evidence": "",
                        "label": label,
                        "kind": "deadline",
                        "location": "",
                        "confidence": 1.0,
                    }],
                ))
        return out


class ReminderLog:
    """已发送提醒的去重记录，避免每 10 分钟重复提醒同一天。"""

    def __init__(self, path: str):
        self.path = path
        self.sent: Dict[str, str] = {}
        self.load()

    def load(self) -> None:
        try:
            with open(self.path, encoding="utf-8") as fh:
                raw = json.load(fh)
            if isinstance(raw, dict) and isinstance(raw.get("sent"), dict):
                self.sent = {str(k): str(v) for k, v in raw["sent"].items()}
        except (OSError, ValueError, json.JSONDecodeError):
            pass

    def pending(self, notices: Sequence[Notice], today: date) -> List[Notice]:
        day = today.isoformat()
        return [n for n in notices if self.sent.get(n.uid) != day]

    def mark(self, notices: Sequence[Notice], today: date) -> None:
        day = today.isoformat()
        for n in notices:
            self.sent[n.uid] = day

    def prune(self, today: date, keep_days: int = 60) -> None:
        cutoff = (today - timedelta(days=keep_days)).isoformat()
        self.sent = {k: v for k, v in self.sent.items() if v >= cutoff}

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.path) or ".", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "sent": self.sent}, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, self.path)
