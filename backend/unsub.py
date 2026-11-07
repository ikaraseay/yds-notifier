"""退订链接生成 —— 与 Cloudflare Worker 共用同一套签名契约。

    token = "<exp>.<sig>"
    sig   = hex(hmac_sha256(UNSUB_SECRET, f"unsub:{email}:{exp}"))[:32]
    exp   = Unix 秒级过期时间

重要：早期版本用 exp=0 表示「永久有效」，但 Worker 端的过期判断
`ts * 1000 < Date.now()` 会把 0 判成已过期，导致所有退订链接失效。
现在双方统一为「带过期时间的按邮箱链接」：

- 只签发给单个邮箱，改 URL 里的 email 即校验失败
- 默认 180 天有效（邮件可能长期躺在收件箱，太短会失效）
- 不再签发「全局停用定时任务」的旧版 token（见 docs/安全评审报告.md S-02）

改这里必须同步改 Worker 的 `src/security.ts::verifyUnsubToken`，
并跑 `python -m backend.selftest` 与 `npm test` 做跨端签名一致性验证。
"""

from __future__ import annotations

import hashlib
import hmac
import time
from urllib.parse import quote

from .config import settings


def _sign(secret: str, message: str) -> str:
    return hmac.new(secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()[:32]


def make_email_token(
    secret: str, email: str, ttl_days: int | None = None, purpose: str = "unsub"
) -> str:
    """签发绑定邮箱的 token。

    `purpose` 是签名域：退订用 `unsub`，个人日历用 `cal`。两者互不通用，
    这样一条日历链接泄漏也无法被拿去退订。
    """
    days = ttl_days if ttl_days is not None else settings.unsub_ttl_days
    exp = int(time.time()) + max(1, days) * 86400
    return f"{exp}.{_sign(secret, f'{purpose}:{email.lower()}:{exp}')}"


def build_unsubscribe_url(base: str, secret: str, email: str, ttl_days: int | None = None) -> str:
    """生成 `https://.../unsubscribe?email=..&token=..`。

    base / secret / email 任一为空都返回空串 —— 调用方据此决定不放退订按钮，
    绝不降级成「全局退订」或「无签名链接」。
    """
    if not base or not secret or not email:
        return ""
    token = make_email_token(secret, email, ttl_days)
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}email={quote(email.lower())}&token={token}"


def build_list_unsubscribe_headers(url: str) -> dict:
    """RFC 8058 一键退订头（Gmail / Outlook 会在邮件顶部显示原生退订按钮）。"""
    if not url:
        return {}
    return {"List-Unsubscribe": f"<{url}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"}


# 日历订阅是「加一次、长期用」的链接，TTL 给足 10 年；
# Worker 端按 purpose=cal 单独放宽上限，退订 token 的 180 天规则不受影响。
CAL_TOKEN_DAYS = 3650


def build_calendar_url(
    base: str, secret: str, email: str, ttl_days: int | None = None
) -> str:
    """生成绑定邮箱的日历订阅地址 `https://.../calendar.ics?email=..&token=..`。

    Worker 会校验签名并读出该用户的角色 / 赛事偏好，只把他关心的事件写进 ICS。
    任一参数缺失都返回空串 —— 调用方据此不放日历链接，绝不发无签名链接。
    """
    if not base or not secret or not email:
        return ""
    token = make_email_token(secret, email, ttl_days or CAL_TOKEN_DAYS, purpose="cal")
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}email={quote(email.lower())}&token={token}"
