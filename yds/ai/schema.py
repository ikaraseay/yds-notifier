"""输出校验与「模型提议、代码决定」的日期归一化。

模型只负责：判断有没有事件、原样复制日期短语（evidence）。
代码负责：校验短语真实存在、解析日期、以**公告发布日期**（不是今天）补年、
校验合理性、输出严格 YYYY-MM-DD。任何一步不过就丢弃该事件，绝不猜。
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional

CATEGORIES = ("报名参赛", "评审与名单", "决赛与收官", "赛事动态", "其他通知")
URGENCIES = ("critical", "high", "normal", "low")
EVENT_KINDS = ("deadline", "event", "notice", "other")

MIN_EVENT_CONFIDENCE = 0.5
MAX_EVENTS = 4
MAX_PAST_DAYS = 30      # 事件早于发布日期 30 天以上 → 视为历史引用
MAX_FUTURE_DAYS = 730   # 事件晚于发布日期 2 年以上 → 视为误读


@dataclass
class AiEvent:
    date: str = ""          # 归一化后的 YYYY-MM-DD
    evidence: str = ""      # 原文日期短语（可审计）
    label: str = ""
    kind: str = "event"
    location: str = ""
    confidence: float = 0.0


@dataclass
class AiAnalysis:
    uid: str = ""
    category: str = "其他通知"
    summary: str = ""
    urgency: str = "normal"
    reason: str = ""
    events: List[AiEvent] = field(default_factory=list)
    confidence: float = 0.0
    version: str = ""
    fallback: bool = False  # True 表示来自规则降级，不是模型结果

    def to_dict(self) -> dict:
        d = asdict(self)
        d["events"] = [asdict(e) for e in self.events]
        return d

    @classmethod
    def from_dict(cls, raw: dict) -> "AiAnalysis":
        events = []
        for e in (raw.get("events") or []):
            if isinstance(e, dict):
                events.append(AiEvent(
                    date=str(e.get("date") or ""),
                    evidence=str(e.get("evidence") or ""),
                    label=str(e.get("label") or ""),
                    kind=str(e.get("kind") or "event"),
                    location=str(e.get("location") or ""),
                    confidence=_num(e.get("confidence"), 0.0),
                ))
        return cls(
            uid=str(raw.get("uid") or ""),
            category=str(raw.get("category") or "其他通知"),
            summary=str(raw.get("summary") or ""),
            urgency=str(raw.get("urgency") or "normal"),
            reason=str(raw.get("reason") or ""),
            events=events,
            confidence=_num(raw.get("confidence"), 0.0),
            version=str(raw.get("version") or ""),
            fallback=bool(raw.get("fallback")),
        )


def _num(v, default: float) -> float:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return default
    return min(1.0, max(0.0, n))


def _text(v, limit: int) -> str:
    if not isinstance(v, str):
        return ""
    return v.strip()[:limit]


def input_hash(item: dict, prompt_version: str) -> str:
    """缓存键：内容或提示词任一变化都会触发重算。

    只用「历史重建后依然拿得到」的稳定字段：uid / 标题 / 发布日期 / URL /
    正文前缀 / 提示词版本。不能用 detail_hash —— seen.json 重建的对象没有
    summary 与附件，detail_hash 每轮都不同，会导致缓存永远 miss、重复计费。
    """
    raw = "|".join([
        prompt_version,
        str(item.get("uid") or ""),
        str(item.get("title") or ""),
        str(item.get("published") or ""),
        str(item.get("url") or ""),
        str(item.get("body") or "")[:500],
    ])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def source_text(item: dict) -> str:
    """evidence 必须能在这些字段里逐字找到（模型输入即这些内容）。"""
    return "\n".join(
        str(item.get(k) or "") for k in ("title", "summary", "body")
    )


_FULL_DATE = re.compile(r"(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})")
_SHORT_DATE = re.compile(r"(?<!\d)(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?")


def parse_evidence_date(evidence: str, published: str) -> str:
    """把原文日期短语解析成 YYYY-MM-DD；失败返回空串。

    无年份时以**公告发布日期**为锚补年：若补出的日期明显早于发布日期
    （如 12 月发布、次年 1 月开赛），自动进位到下一年。
    """
    if not evidence:
        return ""
    pub = _parse_iso(published)
    base_year = pub.year if pub else datetime.now().year
    text = evidence.strip()

    m = _FULL_DATE.search(text)
    if m:
        d = _mkdate(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        return d.isoformat() if d else ""

    m = _SHORT_DATE.search(text)
    if m:
        d = _mkdate(base_year, int(m.group(1)), int(m.group(2)))
        if d and pub and d < pub - timedelta(days=MAX_PAST_DAYS):
            d = _mkdate(base_year + 1, int(m.group(1)), int(m.group(2)))
        return d.isoformat() if d else ""
    return ""


def _parse_iso(s: str) -> Optional[date]:
    try:
        return date.fromisoformat((s or "")[:10])
    except (ValueError, TypeError):
        return None


def _mkdate(y: int, m: int, d: int) -> Optional[date]:
    try:
        return date(y, m, d)
    except (ValueError, TypeError):
        return None


def _normalized(text: str) -> str:
    """忽略空白差异后比对 evidence 是否真的出现在正文里。"""
    return re.sub(r"\s+", "", text or "")


def validate_event(raw, item: dict, published: str) -> Optional[AiEvent]:
    if not isinstance(raw, dict):
        return None
    evidence = _text(raw.get("evidence"), 60)
    if len(evidence) < 4:
        return None
    if _normalized(evidence) not in _normalized(source_text(item)):
        return None  # 模型编造 / 改写了日期短语

    confidence = _num(raw.get("confidence"), 0.0)
    if confidence < MIN_EVENT_CONFIDENCE:
        return None
    kind = str(raw.get("kind") or "event")
    if kind not in EVENT_KINDS:
        kind = "other"

    resolved = parse_evidence_date(evidence, published)
    if not resolved:
        return None
    pub = _parse_iso(published)
    ev_date = _parse_iso(resolved)
    if not ev_date:
        return None
    if pub:
        if ev_date < pub - timedelta(days=MAX_PAST_DAYS):
            return None
        if ev_date > pub + timedelta(days=MAX_FUTURE_DAYS):
            return None
        # 发布日期本身不是事件；日历无真实事件时自有 deadline/date 兜底
        if ev_date == pub and kind != "deadline":
            return None

    return AiEvent(
        date=resolved,
        evidence=evidence,
        label=_text(raw.get("label"), 40),
        kind=kind,
        location=_text(raw.get("location"), 100),
        confidence=confidence,
    )


def validate_response(payload, items: List[dict], version: str) -> Dict[str, dict]:
    """把模型输出收敛成 {uid: analysis_dict}；任何不合规字段静默降级。

    只接受输入里出现过的 uid，杜绝模型新增条目。
    """
    by_uid = {str(i.get("uid") or ""): i for i in items}
    out: Dict[str, dict] = {}
    if not isinstance(payload, dict):
        return out
    rows = payload.get("notices")
    if not isinstance(rows, list):
        return out

    for row in rows:
        if not isinstance(row, dict):
            continue
        uid = str(row.get("uid") or "")
        item = by_uid.get(uid)
        if not item or uid in out:
            continue
        published = str(item.get("published") or "")

        events: List[AiEvent] = []
        raw_events = row.get("events")
        if isinstance(raw_events, list):
            for raw in raw_events[:MAX_EVENTS]:
                ev = validate_event(raw, item, published)
                if ev and ev.date not in {e.date for e in events}:
                    events.append(ev)

        category = str(row.get("category") or "")
        if category not in CATEGORIES:
            category = "其他通知"
        urgency = str(row.get("urgency") or "")
        if urgency not in URGENCIES:
            urgency = "normal"

        analysis = AiAnalysis(
            uid=uid,
            category=category,
            summary=_text(row.get("summary"), 160),
            urgency=urgency,
            reason=_text(row.get("reason"), 120),
            events=events,
            confidence=_num(row.get("confidence"), 0.0),
            version=version,
        )
        out[uid] = analysis.to_dict()
    return out


def parse_json_object(content: str) -> dict:
    """解析模型输出；容忍首尾 Markdown 代码块，但不容忍非对象。"""
    s = (content or "").strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\s*", "", s)
        s = re.sub(r"\s*```$", "", s)
    data = json.loads(s)
    if not isinstance(data, dict):
        raise ValueError("AI 输出根节点不是 JSON 对象")
    return data
