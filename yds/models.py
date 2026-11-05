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

    @property
    def date_text(self) -> str:
        return self.published.isoformat() if self.published else "日期未知"

    @property
    def category(self) -> str:
        """按标题关键词粗分类，仅用于排序和邮件分组。

        注意判断顺序：先看「冲刺/回顾」类（倒计时、圆满落幕），
        它们虽然含「总决赛」字样但含金量低，不应混进决赛组。
        """
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
        """越大越重要。倒计时/回顾类降权，通知类升权。"""
        score = 0
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


def parse_cn_date(text: str) -> Optional[date]:
    """尽力从文本里解析日期，支持 2026-08-13 / 2026年8月13日 / 08-13 等。"""
    if not text:
        return None
    text = text.strip()
    m = re.search(r"(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})", text)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    m = re.search(r"(\d{1,2})\s*[-/月]\s*(\d{1,2})", text)
    if m:
        try:
            return date(datetime.now().year, int(m.group(1)), int(m.group(2)))
        except ValueError:
            return None
    return None


def clean_text(text: str, limit: int = 220) -> str:
    text = re.sub(r"<[^>]+>", "", text or "")
    text = re.sub(r"&nbsp;|&amp;|&lt;|&gt;|&quot;", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"
