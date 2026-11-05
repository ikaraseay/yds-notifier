"""离线自测：配置加载、退订签名契约、收件人校验。

    python -m yds.selftest

不发网络请求、不需要真实密钥。修改 yds/unsub.py 或 worker/src/security.ts
后请分别运行本自测与 `cd worker && npm test`，防止跨端签名再次漂移。
"""

from __future__ import annotations

import hashlib
import hmac
import re
import sys
import time

from .config import derive_base_url, settings
from .recipients import _valid
from .unsub import build_list_unsubscribe_headers, build_unsubscribe_url, make_email_token

PASS = 0


def check(name: str, cond: bool, extra: str = "") -> None:
    global PASS
    if cond:
        PASS += 1
        print("  PASS", name)
    else:
        print("  FAIL", name, extra)


def main() -> int:
    print("\n[1] 配置加载")
    check("SITE_NAME 有默认值", bool(settings.site_name))
    check("MAIL_PROVIDER 合法", settings.mail_provider in ("resend", "smtp"))
    check("MAIL_FROM_ADDRESS 是纯地址", "@" in settings.mail_from_address and "<" not in settings.mail_from_address)
    check("UNSUB_TTL_DAYS >= 1", settings.unsub_ttl_days >= 1)

    print("\n[1b] 域名派生（自定义域名 / workers.dev）")
    check(
        "显式 PUBLIC_BASE_URL 优先",
        derive_base_url("https://a.example.com/", "b.example.com", "https://w.workers.dev")
        == "https://a.example.com",
    )
    check(
        "CUSTOM_DOMAIN 自动补 https",
        derive_base_url("", "notice.example.com", "https://w.workers.dev")
        == "https://notice.example.com",
    )
    check(
        "清洗带 scheme/斜杠的自定义域",
        derive_base_url("", "https://notice.example.com/", "https://w.workers.dev")
        == "https://notice.example.com",
    )
    check(
        "无自定义域时回退 workers.dev",
        derive_base_url("", "", "https://w.workers.dev") == "https://w.workers.dev",
    )
    check("三者都为空返回空串", derive_base_url() == "")
    check("退订 URL 由生效域名派生", settings.unsub_url.endswith("/unsubscribe") or not settings.public_base_url)
    check("名单 URL 由生效域名派生", settings.subscribe_api_url.endswith("/api/list") or not settings.public_base_url)

    print("\n[2] 退订 token 契约（与 Worker 的 verifyUnsubToken 对齐）")
    secret = "test-secret-123"
    email = "Alice@QQ.com"
    token = make_email_token(secret, email, ttl_days=7)
    exp_str, sig = token.split(".")
    exp = int(exp_str)
    expect_sig = hmac.new(
        secret.encode(), f"unsub:{email.lower()}:{exp}".encode(), hashlib.sha256
    ).hexdigest()[:32]
    check("格式为 <exp>.<32位hex>", bool(re.fullmatch(r"\d+\.[0-9a-f]{32}", token)), token)
    check("exp 是未来时间", exp > time.time())
    check("exp 不超过 TTL + 容差", exp <= time.time() + 7 * 86400 + 5)
    check("签名消息为 unsub:<小写邮箱>:<exp>", sig == expect_sig)
    check("不同邮箱签名不同", make_email_token(secret, "bob@qq.com", 7) != token)
    check("exp=0 的旧链接不会再被签发", not token.startswith("0."))

    print("\n[3] 退订 URL 与一键退订头")
    base = "https://yds.example.workers.dev/unsubscribe"
    url = build_unsubscribe_url(base, secret, email, ttl_days=7)
    check("带 email 与 token", "email=alice%40qq.com" in url and "token=" in url)
    check("RFC 8058 头完整", set(build_list_unsubscribe_headers(url)) == {
        "List-Unsubscribe", "List-Unsubscribe-Post"
    })
    check("缺 secret 不降级成无签名链接", build_unsubscribe_url(base, "", email) == "")
    check("缺 email 不生成全局退订", build_unsubscribe_url(base, secret, "") == "")
    check("空 URL 不产生退订头", build_list_unsubscribe_headers("") == {})

    print("\n[4] 收件人校验（邮件头注入防护）")
    check("正常邮箱通过", _valid("alice@qq.com"))
    check("拒绝 CRLF", not _valid("alice@qq.com\r\nBcc: attacker@evil.com"))
    check("拒绝含空格", not _valid("alice @qq.com"))
    check("拒绝无域名后缀", not _valid("alice@localhost"))
    check("拒绝超长地址", not _valid("a" * 250 + "@qq.com"))

    print(f"\n结果：{PASS} 项通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
