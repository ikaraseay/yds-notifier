"""收件人名单与栏目偏好。

来源有两个：
1. `MAIL_TO` 环境变量 / config.yaml —— 站长自己，默认收全部栏目
2. Cloudflare Worker 的 `/api/list` —— 网页登录过的订阅者，各自带栏目偏好

后者需要 `SUBSCRIBE_API_URL` + `SUBSCRIBE_API_TOKEN`，拉取失败时降级为只用 MAIL_TO，
保证网页服务挂了也不影响核心推送。

栏目偏好 key 与 Worker 端 `src/auth.ts` 的 CATEGORIES 一一对应：
    registration 报名参赛 / review 评审与名单 / final 决赛与收官 / updates 赛事动态
`Notice.category` 是中文名，靠 `CATEGORY_TO_KEY` 映射过去。
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import date
from typing import Dict, FrozenSet, List, Optional

import requests

log = logging.getLogger("yds")

EMAIL_MAX = 254

# 通知分类（中文）→ 栏目 key
CATEGORY_TO_KEY: Dict[str, str] = {
    "报名参赛": "registration",
    "评审与名单": "review",
    "决赛与收官": "final",
    "赛事动态": "updates",
    "其他通知": "review",  # 归入"评审与名单"，与其他通知都偏信息型
}

ALL_CATEGORIES = ("registration", "review", "final", "updates")


@dataclass
class Recipient:
    """一个收件人及其订阅的栏目。

    `categories is None` 表示不限制（站长邮箱，或偏好字段缺失时的降级行为）。
    """

    email: str
    categories: Optional[FrozenSet[str]] = None
    frequency: str = "instant"   # instant | daily | weekly
    paused_until: str = ""       # YYYY-MM-DD，含当天

    def wants(self, category: str) -> bool:
        if self.categories is None:
            return True
        key = CATEGORY_TO_KEY.get(category)
        # 映射不到的陌生分类：宁可漏发也不误发，避免打扰
        return bool(key) and key in self.categories

    def is_paused(self, today: date | None = None) -> bool:
        if not self.paused_until:
            return False
        return (today or date.today()).isoformat() <= self.paused_until

    @property
    def digest_key(self) -> str:
        """即时用户返回空串；暂停中的用户一律进日报池，恢复后随摘要补上。"""
        if self.is_paused():
            return "daily"
        return self.frequency if self.frequency in ("daily", "weekly") else ""


def split_recipients(raw: str) -> List[str]:
    return [x.strip().lower() for x in (raw or "").replace(";", ",").split(",") if x.strip()]


# 与 Worker 端 normalizeEmail() 完全一致的规则（小写后匹配）
_EMAIL_RE = re.compile(r"^[a-z0-9._%+\-]+@[a-z0-9\-]+(\.[a-z0-9\-]+)*\.[a-z]{2,}$")


def _valid(email: str) -> bool:
    """严格校验，尤其拒绝 CR/LF —— SMTP 模式下收件人会拼进 To: 头。"""
    if not email or len(email) > EMAIL_MAX:
        return False
    if any(c in email for c in "\r\n\t\x00"):  # 防邮件头注入
        return False
    return bool(_EMAIL_RE.fullmatch(email.lower()))


def _parse_prefs(raw) -> Optional[FrozenSet[str]]:
    """把 `{registration: true, updates: false}` 解析成启用的栏目集合。"""
    if not isinstance(raw, dict):
        return None
    return frozenset(k for k in ALL_CATEGORIES if raw.get(k) is True)


def fetch_subscribers(api_url: str, token: str, timeout: int = 20) -> List[Recipient]:
    """从 Worker 拉取已登录的订阅者及其栏目偏好。"""
    if not api_url or not token:
        return []
    try:
        resp = requests.get(
            api_url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=timeout,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:  # noqa: BLE001 - 网页服务不可用不应阻断推送
        log.warning("拉取订阅名单失败，仅使用 MAIL_TO：%s", exc)
        return []

    if not isinstance(data, dict):
        log.warning("订阅名单格式异常，已忽略")
        return []

    subs = data.get("subscribers")
    out: List[Recipient] = []
    if isinstance(subs, list):
        # 新版：带偏好
        for item in subs:
            if not isinstance(item, dict):
                continue
            email = str(item.get("email", "")).strip().lower()
            if not _valid(email):
                continue
            freq = str(item.get("frequency") or "instant").lower()
            if freq not in ("instant", "daily", "weekly"):
                freq = "instant"
            paused = str(item.get("pausedUntil") or "")
            if paused and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", paused):
                paused = ""
            out.append(Recipient(
                email=email,
                categories=_parse_prefs(item.get("prefs")),
                frequency=freq,
                paused_until=paused,
            ))
    else:
        # 旧版：只有邮箱列表，按不限栏目处理
        for e in data.get("emails") or []:
            email = str(e).strip().lower()
            if _valid(email):
                out.append(Recipient(email=email, categories=None))

    log.info("从订阅服务拿到 %s 个订阅者", len(out))
    return out


def resolve_recipients(
    static_raw: str, api_url: str = "", token: str = ""
) -> List[Recipient]:
    """合并静态收件人与网页订阅者，去重后保持稳定顺序。

    静态收件人（站长）不受栏目限制，永远收全量；同一邮箱出现在两处时以全量为准。
    """
    seen = set()
    ordered: List[Recipient] = []

    for e in split_recipients(static_raw):
        if e in seen or not _valid(e):
            continue
        seen.add(e)
        ordered.append(Recipient(email=e, categories=None))

    for r in fetch_subscribers(api_url, token):
        if r.email in seen:
            continue
        seen.add(r.email)
        ordered.append(r)

    return ordered
