from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import List, Optional

# 关键词 -> 分组标签，命中越多越靠前排序，用于邮件分区与打分
HIGH_PRIORITY = (
    "报名", "开赛", "启动", "通知", "章程", "参赛说明", "赛题", "日程", "时间",
    "初赛", "决赛", "总决赛", "评审", "晋级", "名单", "公示", "成绩", "证书",
    "截止", "延长", "变更", "调整", "缴费", "报销",
)
LOW_PRIORITY = ("倒计时", "回顾", "圆满", "闭幕", "开幕", "风采", "侧记", "花絮")

# AI 紧急度参与排序：critical 置顶并触发「紧急快报」通道
URGENCY_BONUS = {"critical": 100, "high": 20, "normal": 0, "low": -20}
VALID_CATEGORIES = ("报名参赛", "评审与名单", "决赛与收官", "赛事动态", "其他通知")


@dataclass
class Attachment:
    name: str
    url: str


@dataclass
class Notice:
    source: str                    # 数据源显示名，如「研创网·研电赛」
    source_key: str                # 数据源机器名，如 cpi pc
    title: str
    url: str
    published: Optional[date] = None
    summary: str = ""
    attachments: List[Attachment] = field(default_factory=list)
    uid: str = ""                  # 去重主键：源+id/url
    is_new: bool = False
    change_kind: str = "new"       # new | changed（官网修订同一篇文章时重推）
    deadline: str = ""             # 规则兜底抽出的截止日（YYYY-MM-DD），AI 关闭时仍可用

    # --- AI 分析结果（全部独立字段，绝不写回 summary，否则 detail_hash 会每天误报更新）---
    raw_body: str = ""             # 详情页未截断正文，仅作 AI 输入；不进 payload / seen.json
    ai_category: str = ""          # 限定在 VALID_CATEGORIES 内
    ai_summary: str = ""           # 一句话摘要
    ai_urgency: str = ""           # critical | high | normal | low
    ai_reason: str = ""            # 判断依据（审计用）
    ai_events: List[dict] = field(default_factory=list)  # 已归一化的真实事件日
    ai_confidence: float = 0.0
    ai_version: str = ""           # 提示词版本，升版触发缓存失效

    @property
    def date_text(self) -> str:
        return self.published.isoformat() if self.published else "日期未知"

    @property
    def list_hash(self) -> str:
        """列表页字段指纹：零额外请求即可发现改标题 / 延期 / 换链接。"""
        raw = f"{self.title}|{self.date_text}|{self.url}|{self.source_key}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]

    @property
    def detail_hash(self) -> str:
        """详情页字段指纹：每日抽检一次，用于发现正文 / 附件变化。"""
        atts = "|".join(f"{a.name}:{a.url}" for a in self.attachments)
        raw = f"{self.title}|{self.date_text}|{self.summary}|{atts}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]

    def to_feed_item(self) -> dict:
        """同步给 Worker 的公开字段（归档 / RSS / 日历共用）。"""
        return {
            "uid": self.uid,
            "title": self.title,
            "url": self.url,
            "date": self.date_text,
            "category": self.category,
            "source": self.source,
            "summary": self.summary,
            "deadline": self.deadline,
            "attachments": [{"name": a.name, "url": a.url} for a in self.attachments],
            "changeKind": self.change_kind,
            # AI 字段：Worker 侧 feed.ts 的 normalizeNotice 白名单必须同步
            "aiCategory": self.ai_category,
            "aiSummary": self.ai_summary,
            "aiUrgency": self.ai_urgency,
            "aiReason": self.ai_reason,
            "aiEvents": self.ai_events[:4],
            "aiConfidence": self.ai_confidence,
            "aiVersion": self.ai_version,
        }

    @classmethod
    def from_feed_item(cls, raw: dict) -> "Notice":
        """从待发摘要池恢复（字段不足时按最小可用信息构造）。"""
        published = parse_cn_date(str(raw.get("date") or ""))
        return cls(
            source=str(raw.get("source") or ""),
            source_key="",
            title=str(raw.get("title") or ""),
            url=str(raw.get("url") or ""),
            published=published,
            summary=str(raw.get("summary") or ""),
            attachments=[Attachment(str(a.get("name") or ""), str(a.get("url") or ""))
                         for a in (raw.get("attachments") or []) if isinstance(a, dict)],
            uid=str(raw.get("uid") or ""),
            change_kind=str(raw.get("changeKind") or "new"),
            deadline=str(raw.get("deadline") or ""),
            ai_category=str(raw.get("aiCategory") or ""),
            ai_summary=str(raw.get("aiSummary") or ""),
            ai_urgency=str(raw.get("aiUrgency") or ""),
            ai_reason=str(raw.get("aiReason") or ""),
            ai_events=[e for e in (raw.get("aiEvents") or []) if isinstance(e, dict)][:4],
            ai_confidence=(float(raw["aiConfidence"])
                           if isinstance(raw.get("aiConfidence"), (int, float)) else 0.0),
            ai_version=str(raw.get("aiVersion") or ""),
        )

    @property
    def category(self) -> str:
        """AI 分类优先，否则按标题关键词粗分类。

        限定在既有 5 类内，保证 recipients.wants() 的映射永远有效，不会漏发。
        注意判断顺序：先看「冲刺/回顾」类（倒计时、圆满落幕），
        它们虽然含「总决赛」字样但含金量低，不应混进决赛组。
        """
        if self.ai_category in VALID_CATEGORIES:
            return self.ai_category
        if any(k in self.title for k in LOW_PRIORITY):
            return "赛事动态"
        if any(k in self.title for k in ("报名", "开赛", "章程", "参赛说明", "赛题")):
            return "报名参赛"
        if any(k in self.title for k in ("评审", "晋级", "名单", "公示", "成绩", "答辩", "复核")):
            return "评审与名单"
        if any(k in self.title for k in ("决赛", "证书", "颁奖", "报销", "开票", "发票")):
            return "决赛与收官"
        return "其他通知"

    @property
    def weight(self) -> int:
        """越大越重要。AI 紧急度优先于关键词打分。"""
        score = URGENCY_BONUS.get(self.ai_urgency, 0)
        for k in HIGH_PRIORITY:
            if k in self.title:
                score += 2
        for k in LOW_PRIORITY:
            if k in self.title:
                score -= 3
        return score


def make_uid(source_key: str, ident: str) -> str:
    """生成稳定去重键。

    优先使用站点自身的文章 id（URL 里那段），它不随分页参数变化；
    没有 id 时退化为标题的哈希，避免因 URL 带有随机 query 而重复推送。
    """
    raw = f"{source_key}::{ident.strip().lower()}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


_ID_PATTERNS = (
    re.compile(r"/([0-9a-f]{32})(?:\?|$)"),          # 研创网 uuid
    re.compile(r"/(\d{3,8})\.html"),                  # 学会站数字 id
)


def extract_ident(url: str, fallback: str) -> str:
    for pat in _ID_PATTERNS:
        m = pat.search(url)
        if m:
            return m.group(1)
    return fallback


def parse_cn_date(text: str, base_year: int | None = None) -> Optional[date]:
    """尽力从文本里解析日期，支持 2026-08-13 / 2026年8月13日 / 08-13 等。

    `base_year` 用于无年份写法：传公告发布日期的年份，可避免跨年公告
    （12 月发布、次年 1 月开赛）被补成当前年而算错。
    """
    if not text:
        return None
    text = text.strip()
    m = re.search(r"(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})", text)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    m = re.search(r"(\d{1,2})\s*[-/月.]\s*(\d{1,2})", text)
    if m:
        try:
            return date(base_year or datetime.now().year, int(m.group(1)), int(m.group(2)))
        except ValueError:
            return None
    return None


def clean_text(text: str, limit: int = 220) -> str:
    text = re.sub(r"<[^>]+>", "", text or "")
    text = re.sub(r"&nbsp;|&amp;|&lt;|&gt;|&quot;", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"
