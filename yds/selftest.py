"""离线自测：配置、退订签名契约、收件人校验、变更检测、摘要池、归档载荷。

    python -m yds.selftest

不发网络请求、不需要真实密钥。修改 yds/unsub.py 或 worker/src/security.ts
后请分别运行本自测与 `cd worker && npm test`，防止跨端签名再次漂移。
**任何一项 FAIL 都会让进程返回非零**，CI 会因此变红。
"""

from __future__ import annotations

import hashlib
import hmac
import re
import sys
import tempfile
import time
from datetime import date
from pathlib import Path

from .config import derive_base_url, settings
from .mailer import build_html, build_text
from .models import Attachment, Notice
from .publish import build_payload, extract_deadline, payload_fingerprint
from .recipients import Recipient, _valid
from .state import State, load_pending, pending_notices, save_pending
from .unsub import build_list_unsubscribe_headers, build_unsubscribe_url, make_email_token

PASS = 0
FAIL = 0


def check(name: str, cond: bool, extra: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  PASS", name)
    else:
        FAIL += 1
        print("  FAIL", name, extra)


def _notice(title: str = "关于报名的通知", uid: str = "u1", **kw) -> Notice:
    return Notice(
        source="研创网", source_key="cpipc", title=title,
        url=f"https://cpipc.acge.org.cn/cw/hp/6/{uid}",
        uid=uid, **kw,
    )


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
    check("归档同步 URL 由生效域名派生", settings.notices_api_url.endswith("/api/notices") or not settings.public_base_url)

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

    print("\n[5] 内容变更检测（列表页指纹 / 详情页抽检）")
    with tempfile.TemporaryDirectory() as tmp:
        path = str(Path(tmp) / "seen.json")
        st = State(path)
        n = _notice()
        check("新条目判为 new", st.classify(n) == "new")
        st.mark([n])
        check("mark 后判为 same", st.classify(n) == "same")
        check("详情页基线不触发更新", not st.detail_changed(n))
        n2 = _notice("关于报名的通知（更正）")
        check("标题 / 日期变更判为 changed", st.classify(n2) == "changed")
        n3 = _notice(summary="新增附件说明", attachments=[Attachment("名单.pdf", "https://x/a.pdf")])
        check("正文 / 附件变更被每日抽检发现", st.detail_changed(n3))
        st.save()
        st2 = State(path)
        check("重新加载后仍判为 same", st2.classify(n) == "same")
        check("状态带 version 与指纹", st2.initialized and bool(st2.data["u1"].get("hash")))
        st2.record_detail_baseline([n3])
        check("刷新基线后不再重复报更新", not st2.detail_changed(n3))
        st2.touch_detail_check("2026-11-05")
        check("抽检日期可持久化", st2.last_detail_check() == "2026-11-05")
        # 兼容旧记录：没有 hash 时不重发
        Path(path).write_text('{"version":1,"seen":{"old":{"title":"旧","url":"x"}}}', encoding="utf-8")
        old = State(path)
        check("旧格式记录视为 same（升级不群发）", old.classify(_notice(uid="old")) == "same")
        Path(path).write_text("{ broken", encoding="utf-8")
        broken = State(path)
        check("损坏文件 fail-closed 不重建基线", broken.corrupt and not broken.is_first_run)

    print("\n[6] 频率与暂停分流")
    check("即时用户不进摘要池", Recipient(email="a@qq.com").digest_key == "")
    check("日报用户进 daily 池", Recipient(email="b@qq.com", frequency="daily").digest_key == "daily")
    check("周报用户进 weekly 池", Recipient(email="c@qq.com", frequency="weekly").digest_key == "weekly")
    paused = Recipient(email="d@qq.com", paused_until="2099-01-01")
    check("暂停中判定为真", paused.is_paused(date(2026, 11, 5)))
    check("暂停用户进 daily 池补发", paused.digest_key == "daily")

    print("\n[7] 归档 / RSS / 日历载荷")
    d = _notice("报名截止 2026年11月25日的通知")
    check("抽出报名截止日", extract_deadline(d) == "2026-11-25", extract_deadline(d))
    payload = build_payload([d], limit=10)
    check("载荷含 deadline", payload["notices"][0]["deadline"] == "2026-11-25")
    check("载荷指纹稳定", payload_fingerprint(payload) == payload_fingerprint(build_payload([d], 10)))
    d.title = "报名截止延期的通知"
    check("标题变化导致指纹改变", payload_fingerprint(payload) != payload_fingerprint(build_payload([d], 10)))
    back = Notice.from_feed_item(d.to_feed_item())
    check("feed item 可还原成 Notice", back.uid == d.uid and back.title == d.title)

    print("\n[8] 摘要池持久化")
    with tempfile.TemporaryDirectory() as tmp:
        pp = str(Path(tmp) / "pending.json")
        pool = load_pending(pp)
        check("空池含 daily / weekly", set(pool) == {"daily", "weekly"})
        pool["daily"]["u1"] = _notice().to_feed_item()
        save_pending(pp, pool)
        again = load_pending(pp)
        check("池写入后可读取", "u1" in again["daily"])
        check("池条目可还原", pending_notices(again["daily"])[0].uid == "u1")

    print("\n[9] 更新通知的邮件标记")
    upd = _notice("评审名单更正", change_kind="changed")
    check("纯文本带【更新】", "【更新】" in build_text([upd]))
    check("HTML 带更新角标", ">更新</span>" in build_html([upd]))
    check("头部文案区分更新", "有更新" in build_html([upd]))

    print("\n[10] 归档同步不会被「无新公告」提前返回跳过")
    # 回归守卫：同步曾写在 `if not fresh: return 0` 之后，导致没有新公告时
    # 归档/RSS/日历永远为空。这里只做静态顺序校验，不联网、不发信。
    src = (Path(__file__).with_name("main.py")).read_text(encoding="utf-8")
    sync_at = src.find("publish_notices(payload)")
    early_at = src.find("if not merged and not args.preview")
    check("主流程中存在归档同步调用", sync_at > 0)
    check("同步位于无新公告提前返回之前", 0 < sync_at < early_at)
    check("同步结果会写入状态指纹", "archive_changed = True" in src)

    print(f"\n结果：{PASS} 项通过，{FAIL} 项失败")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
