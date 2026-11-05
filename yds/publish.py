"""把通知元数据同步给 Cloudflare Worker，供 /archive、/feed.xml、/calendar.ics 使用。

设计约束：
- 只推公开字段（标题、链接、日期、分类、来源、截止日、附件），不含邮箱或密钥。
- 用同一枚 SUBSCRIBE_API_TOKEN 做 Bearer 鉴权，不新增 Secret。
- 内容指纹不变就跳过，避免每 10 分钟写一次 KV（免费版 1000 写/天）。
- 这是附加能力：同步失败只记录告警，绝不阻断邮件主流程。
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import datetime, timezone
from typing import List, Sequence

import requests

from .config import settings
from .models import Notice, parse_cn_date

log = logging.getLogger("yds")

# 「截止 / 延期 / 赛程」附近出现日期时，视为日历事件；否则退化为发布日期事件
_DEADLINE_HINT = re.compile(
    r"截止|截至|期限|报名结束|提交结束|延期至|延长至|结束时间|赛程|时间安排|举行|开赛|答辩时间"
)
_DATE_WINDOW = 42


def extract_deadline(notice: Notice) -> str:
    """从标题与摘要里尽力抽一个 YYYY-MM-DD；抽不到返回空串。"""
    for text in (notice.title, notice.summary):
        if not text:
            continue
        for m in _DEADLINE_HINT.finditer(text):
            window = text[m.start(): m.start() + _DATE_WINDOW]
            d = parse_cn_date(window)
            if d:
                return d.isoformat()
    # 标题里直接写日期但没有关键词时，也可用作事件日
    d = parse_cn_date(notice.title)
    return d.isoformat() if d else ""


def build_payload(notices: Sequence[Notice], limit: int = 200) -> dict:
    ordered = sorted(
        notices,
        key=lambda n: (n.deadline or n.date_text, n.title),
        reverse=True,
    )[: max(1, limit)]
    items = []
    for n in ordered:
        if not n.deadline:
            n.deadline = extract_deadline(n)
        items.append(n.to_feed_item())
    return {
        "site": settings.site_name,
        "baseUrl": settings.public_base_url,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "notices": items,
    }


def payload_fingerprint(payload: dict) -> str:
    raw = json.dumps(
        [
            [i.get("uid"), i.get("title"), i.get("date"), i.get("deadline"), i.get("changeKind")]
            for i in payload.get("notices", [])
        ],
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def publish_notices(payload: dict, timeout: int = 20) -> bool:
    url = settings.notices_api_url
    token = settings.subscribe_api_token
    if not settings.publish_notices:
        log.info("PUBLISH_NOTICES=false，跳过归档同步")
        return False
    if not url or not token:
        log.warning("未配置 NOTICES_API_URL / SUBSCRIBE_API_TOKEN，跳过归档同步")
        return False
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    urls = settings.api_candidates(url, "/api/notices")
    last = "无可用入口"
    for endpoint in urls:
        try:
            resp = requests.post(endpoint, data=body, headers=headers, timeout=timeout)
            if resp.status_code in (200, 201, 202, 204):
                log.info("归档数据已同步（%s）：%s 条", endpoint, len(payload.get("notices", [])))
                return True
            last = f"HTTP {resp.status_code} {resp.text[:100]}"
        except requests.RequestException as exc:
            last = str(exc)[:120]
        log.warning("归档同步入口 %s 失败：%s，尝试下一个", endpoint, last)
    # 附加能力：同步失败只告警，绝不阻断邮件主流程
    log.warning("归档同步全部入口失败（不影响发信）：%s", last)
    return False


def notices_from_state(state) -> List[Notice]:
    """从 seen.json 的轻量记录重建归档条目（首次升级时也能立即有内容）。"""
    out: List[Notice] = []
    for uid, rec in (state.data or {}).items():
        if not isinstance(rec, dict):
            continue
        n = Notice(
            source="",
            source_key="",
            title=str(rec.get("title") or ""),
            url=str(rec.get("url") or ""),
            published=parse_cn_date(str(rec.get("date") or "")),
            uid=uid,
        )
        if n.title:
            n.deadline = extract_deadline(n)
            out.append(n)
    return out
