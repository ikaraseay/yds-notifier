"""收件人名单与栏目偏好。

来源有两个：
1. `MAIL_TO` 环境变量 / config/config.yaml —— 站长自己，默认收全部栏目
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
from typing import Dict, FrozenSet, List, Optional, Sequence

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
ALL_AUDIENCES = ("student", "advisor", "admin", "organizer")


@dataclass
class Recipient:
    """一个收件人及其订阅的栏目 / 人员视角。

    `categories is None` 表示不限制（站长邮箱，或偏好字段缺失时的降级行为）。
    `audiences` 同理：None 表示收全部视角，否则只收命中的视角。
    """

    email: str
    categories: Optional[FrozenSet[str]] = None
    frequency: str = "instant"   # instant | daily | weekly
    paused_until: str = ""       # YYYY-MM-DD，含当天
    audiences: Optional[FrozenSet[str]] = None
    contests: Optional[FrozenSet[str]] = None   # None = 全部赛事
    label: str = ""              # 人物角色备注，仅用于日志

    def wants(self, category: str) -> bool:
        if self.categories is None:
            return True
        key = CATEGORY_TO_KEY.get(category)
        # 映射不到的陌生分类：宁可漏发也不误发，避免打扰
        return bool(key) and key in self.categories

    def wants_notice(self, notice) -> bool:
        """栏目偏好 + 人员视角 + 关注赛事三重过滤。"""
        if not self.wants(notice.category):
            return False
        if self.audiences is not None and not (self.audiences & set(notice.audiences or [])):
            return False
        # 赛事为空的是全站级通知（赛程一览、年度启动等），不因赛事筛选被丢掉
        contest = getattr(notice, "contest", "") or ""
        if self.contests is not None and contest and contest not in self.contests:
            return False
        return True

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


def _parse_audiences(item: dict) -> Optional[FrozenSet[str]]:
    """角色开关：兼容数组（新接口）与对象（prefs.audiences）两种形态。

    字段存在但全部为 false 时返回空集合 —— 表示用户明确不想收任何角色，
    与字段缺失（None = 不限制）区分开。
    """
    prefs = item.get("prefs") if isinstance(item.get("prefs"), dict) else {}
    raw = item.get("audiences")
    if raw is None and "audiences" in prefs:
        raw = prefs.get("audiences")
    if raw is None:
        return None
    if isinstance(raw, dict):
        return frozenset(k for k, v in raw.items() if v is True and k in ALL_AUDIENCES)
    if isinstance(raw, list):
        return frozenset(a for a in raw if a in ALL_AUDIENCES)
    return None


def _parse_contests(item: dict) -> Optional[FrozenSet[str]]:
    """关注赛事：空数组 = 全部赛事（返回 None 表示不做限制）。"""
    prefs = item.get("prefs") if isinstance(item.get("prefs"), dict) else {}
    raw = item.get("contests")
    if raw is None and "contests" in prefs:
        raw = prefs.get("contests")
    if not isinstance(raw, list):
        return None
    picked = frozenset(str(c).strip() for c in raw if str(c).strip())
    return picked or None


def fetch_subscribers(
    api_url: str, token: str, timeout: int = 20, fallback_url: str = ""
) -> List[Recipient]:
    """从 Worker 拉取已登录的订阅者及其栏目偏好。

    自定义域可能被 WAF 托管质询拦截（机房 IP），失败时自动试 workers.dev 或反向兜底。
    网页服务不可用时降级为只用 MAIL_TO，不阻断核心推送。
    """
    if not api_url or not token:
        return []
    urls = [api_url]
    if fallback_url and fallback_url not in urls:
        urls.append(fallback_url)
    data = None
    for endpoint in urls:
        try:
            resp = requests.get(
                endpoint,
                headers={"Authorization": f"Bearer {token}"},
                timeout=timeout,
            )
            resp.raise_for_status()
            data = resp.json()
            break
        except Exception as exc:  # noqa: BLE001 - 网页服务不可用不应阻断推送
            log.warning("拉取订阅名单失败（%s）：%s", endpoint, str(exc)[:120])
    if data is None:
        log.warning("订阅名单全部入口不可用，仅使用 MAIL_TO")
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
                audiences=_parse_audiences(item),
                contests=_parse_contests(item),
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
    static_raw: str,
    api_url: str = "",
    token: str = "",
    fallback_url: str = "",
    personas: Optional[List[dict]] = None,
) -> List[Recipient]:
    """合并静态收件人、人员视角邮箱与网页订阅者，去重后保持稳定顺序。

    静态收件人（站长）不受栏目 / 视角限制，永远收全量；
    同一邮箱出现在多处时以全量为准，避免同一个人收到两版邮件。
    """
    seen = set()
    ordered: List[Recipient] = []

    for e in split_recipients(static_raw):
        if e in seen or not _valid(e):
            continue
        seen.add(e)
        ordered.append(Recipient(email=e, categories=None))

    # 人员视角专用邮箱（config/config.yaml 的 personas[].mail_to）
    for p in (personas or []):
        if not isinstance(p, dict):
            continue
        key = str(p.get("key") or "")
        if key not in ALL_AUDIENCES:
            continue
        for e in split_recipients(str(p.get("mail_to") or "")):
            if e in seen or not _valid(e):
                continue
            seen.add(e)
            raw_contests = p.get("contests")
            contests = (
                frozenset(str(c) for c in raw_contests if str(c).strip())
                if isinstance(raw_contests, list) and raw_contests else None
            )
            ordered.append(Recipient(
                email=e,
                categories=None,
                audiences=frozenset({key}),
                contests=contests,
                label=str(p.get("name") or key),
            ))

    for r in fetch_subscribers(api_url, token, fallback_url=fallback_url):
        if r.email in seen:
            continue
        seen.add(r.email)
        ordered.append(r)

    return ordered


def watched_contests(recipients: Sequence[Recipient]) -> Optional[FrozenSet[str]]:
    """所有收件人关注的赛事并集。

    任一收件人不限制赛事（None）时返回 None，表示「可能关心全部」，
    调用方据此决定是否轮询所有赛事专区。
    """
    union = set()
    for r in recipients:
        if r.contests is None:
            return None
        union |= set(r.contests)
    return frozenset(union)
