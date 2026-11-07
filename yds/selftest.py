"""离线自测：配置、退订签名契约、收件人校验、变更检测、摘要池、归档载荷。

    python -m yds.selftest

不发网络请求、不需要真实密钥。修改 yds/unsub.py 或 worker/src/security.ts
后请分别运行本自测与 `cd worker && npm test`，防止跨端签名再次漂移。
**任何一项 FAIL 都会让进程返回非零**，CI 会因此变红。
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import re
import sys
import tempfile
import time
from datetime import date, timedelta
from pathlib import Path

from .ai.analyzer import analyze_notices
from .ai.cache import AiCache
from .ai.client import AiClient, AiClientError, AiConfig
from .ai.prompts import load_examples, load_prompt, load_schema, render, user_payload
from .ai.schema import CATEGORIES, input_hash, parse_evidence_date, validate_response
from .config import derive_base_url, derive_internal_base, settings
from . import fetch as fetch_mod
from .robots import parse as parse_robots
from .mailer import build_html, build_subject, build_text, sort_notices
from .lock import RunLock
from .models import Attachment, Notice, by_recency
from .personas import (
    AUDIENCES,
    CONTEST_IDS,
    CONTESTS,
    STAGES,
    infer_audiences,
    infer_contest,
    infer_stage,
)
from .publish import apply_analysis, build_payload, extract_deadline, payload_fingerprint
from .recipients import (
    Recipient,
    _parse_audiences,
    _parse_contests,
    _valid,
    watched_contests,
)
from .schedule import ContestSchedule, ReminderLog, ScheduleStore, parse_schedule
from .sources import CpipcZonesSource, build_sources
from .state import State, load_pending, pending_notices, save_pending
from .store import R2StateStore, StateConflict, StateUnavailable
from .unsub import (
    build_calendar_url,
    build_list_unsubscribe_headers,
    build_unsubscribe_url,
    make_email_token,
)

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

    print("\n[1a] 发件人显示名带 [非官方]")
    from .senders import unofficial_sender_name  # 延迟导入：避免 selftest 顶部拉进网络依赖

    check("补上后缀", unofficial_sender_name("研电赛通知") == "研电赛通知 [非官方]")
    check("幂等（不会叠加）", unofficial_sender_name("研电赛通知 [非官方]") == "研电赛通知 [非官方]")
    check("空名有兜底", unofficial_sender_name("  ") == "研电赛通知 [非官方]")

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
    dev = "https://w.workers.dev"
    pub = "https://notice.example.com"
    check("机器接口优先 workers.dev", derive_internal_base(dev, pub) == dev)
    check("无 workers.dev 时回退对外地址", derive_internal_base("", pub) == pub)
    check("非 workers.dev 地址不被误用", derive_internal_base("https://evil.example", pub) == pub)
    cand = settings.api_candidates("https://w.workers.dev/api/notices", "/api/notices")
    check("接口候选优先主入口", cand[0] == "https://w.workers.dev/api/notices", str(cand))
    check(
        "接口候选含自定义域兜底",
        f"{settings.public_base_url}/api/notices" in cand,
        str(cand),
    )
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

    # 详情抽检按「上次复核时间」轮转：避免每天重复抽同一批最近通知
    from .main import pick_detail_checks
    with tempfile.TemporaryDirectory() as tmp:
        st3 = State(str(Path(tmp) / "seen.json"))
        today = date(2026, 11, 7)
        pool = []
        for i in range(5):
            it = _notice(f"抽检候选 {i}", uid=f"ck{i}", published=today - timedelta(days=i))
            st3.mark([it])
            pool.append(it)
        check("抽检优先未复核的最近条目", pick_detail_checks(pool, st3, 2, today) == ["ck0", "ck1"])
        st3.record_detail_baseline([pool[0], pool[1]], today.isoformat())
        check("按条记录复核日期", st3.detail_checked_at("ck0") == today.isoformat())
        check("已复核条目排到队尾",
              pick_detail_checks(pool, st3, 2, today) == ["ck2", "ck3"],
              str(pick_detail_checks(pool, st3, 2, today)))
        check("从未复核的条目优先于复核过的",
              pick_detail_checks(pool, st3, 5, today)[:3] == ["ck2", "ck3", "ck4"])
        old_doc = _notice("两个月前的旧文", uid="ckold", published=today - timedelta(days=60))
        st3.mark([old_doc])
        check("超 30 天的旧文不进抽检",
              "ckold" not in pick_detail_checks(pool + [old_doc], st3, 10, today))

    print("\n[6] 频率与暂停分流")
    check("即时用户不进摘要池", Recipient(email="a@qq.com").digest_key == "")
    check("日报用户进 daily 池", Recipient(email="b@qq.com", frequency="daily").digest_key == "daily")
    check("周报用户进 weekly 池", Recipient(email="c@qq.com", frequency="weekly").digest_key == "weekly")
    paused = Recipient(email="d@qq.com", paused_until="2099-01-01")
    check("暂停中判定为真", paused.is_paused(date(2026, 11, 5)))
    check("暂停用户进 daily 池补发", paused.digest_key == "daily")
    # 每天两轮（10:00 / 20:00）：只有上午那轮发摘要，晚上那轮不发
    from datetime import datetime as _dt
    from .dispatch import in_digest_window
    check("10:00 在摘要窗口", in_digest_window(_dt(2026, 11, 7, 10, 0), 10))
    check("上午轮延迟到 17:30 仍在窗口", in_digest_window(_dt(2026, 11, 7, 17, 30), 10))
    check("延迟到 18:00 超出窗口", not in_digest_window(_dt(2026, 11, 7, 18, 0), 10))
    check("09:59 不在窗口", not in_digest_window(_dt(2026, 11, 7, 9, 59), 10))
    check("20:00 那轮不发第二次摘要", not in_digest_window(_dt(2026, 11, 7, 20, 0), 10))
    check("默认窗口按 10 点算", in_digest_window(_dt(2026, 11, 7, 10, 0)))

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

    print("\n[9b] 角色分区只列出订阅者勾选的角色")
    stu = _notice("报名通知", uid="p1", audiences=["student"])
    adm = _notice("培养单位审核通知", uid="p2", audiences=["admin"])
    only_stu = build_html([stu], audiences=["student"])
    check("只显示勾选的角色", "参赛学生" in only_stu and "指导教师" not in only_stu)
    check("组标题就是角色名", "你需要做什么" not in only_stu and "请关注" not in only_stu)
    check("卡片不再写「要做什么：」", "要做什么" not in only_stu)
    check("纯文本也不再写「要做什么：」", "要做什么" not in build_text([stu]))
    no_roles = build_html([stu, adm])
    check("未设置角色时展示全部", "参赛学生" in no_roles and "培养单位" in no_roles)
    shared = _notice("报名与审核都相关的通知", uid="p4", audiences=["student", "advisor"])
    card_only = build_html([shared], audiences=["student"])
    check("卡片「面向」只列勾选角色", "面向：参赛学生" in card_only and "指导教师" not in card_only)
    both = _notice("报名与审核都相关的通知", uid="p3", audiences=["student", "admin"])
    overlap = build_html([both], audiences=["student", "admin"])
    head = overlap.split("按赛事汇总")[0]
    check("同一通知在适用的多个角色下都出现", head.count(both.title) == 2,
          str(head.count(both.title)))
    check("两个角色标题都在", "参赛学生" in head and "培养单位" in head)
    # 回归守卫：勾选全部视角时不能再折叠成只剩「参赛学生」
    org = _notice("承办方赛区安排", uid="p5", audiences=["organizer"])
    all_roles = build_html([both, org, shared], audiences=list(AUDIENCES))
    all_head = all_roles.split("按赛事汇总")[0]
    check("勾选全角色时四个视角都在", all(
        name in all_head for name in ("参赛学生", "指导教师", "培养单位", "分赛区")
    ), all_head[:120])

    print("\n[9c] 已结束的通知不再写进邮件")
    old = _notice("数学建模赛题下载提醒", uid="e1", audiences=["student"])
    old.ai_events = [{"date": "2026-09-27", "label": "MD5 提交截止"},
                     {"date": "2026-09-28", "label": "论文上传截止"}]
    check("时间节点全过去判为已结束", old.is_expired is True)
    soon = _notice("公示结果", uid="e2", audiences=["student"])
    soon.ai_events = [{"date": (date.today() + timedelta(days=3)).isoformat(),
                       "label": "反馈异议截止"}]
    check("还有未来节点则保留", soon.is_expired is False)
    dateless = _notice("没有日期的旧通知", uid="e3")
    dateless.published = date.today() - timedelta(days=60)
    check("无日期按发布日兜底", dateless.is_expired is True)
    fresh_note = _notice("没有日期的新通知", uid="e4")
    fresh_note.published = date.today() - timedelta(days=2)
    check("近期无日期通知保留", fresh_note.is_expired is False)

    print("\n[9d] 追赶 / 基线截断按发布时间挑最近 N 条")
    # 回归守卫：2026-11-06 实发事故——追赶模式按重要度截断，把 9 月的
    # 决赛 / 截止类高权重旧文顶进了邮件。截断必须按时间，展示才按重要度。
    new_low = _notice("报名缴费截止通知", uid="c1", audiences=["student"])
    new_low.published = date.today() - timedelta(days=1)
    old_high = _notice("决赛结果公示", uid="c2", audiences=["student"])
    old_high.published = date.today() - timedelta(days=50)
    mid = _notice("评审名单", uid="c3", audiences=["student"])
    mid.published = date.today() - timedelta(days=5)
    picked = sort_notices(by_recency([new_low, old_high, mid])[:2])
    titles = [n.title for n in picked]
    check("截断挑最近两条", set(titles) == {new_low.title, mid.title}, str(titles))
    check("陈年旧文被截掉", old_high.title not in titles)
    check("展示顺序按重要度", titles[0] == new_low.title, str(titles))
    nod = _notice("无日期通知", uid="c4")
    check("无日期通知垫底", by_recency([nod, new_low])[0] is new_low)
    # 静态守卫：超龄条目也要标已读，否则每轮重复判「新增后跳过」，
    # 将来放宽 push_max_age_days 时还会瞬间涌入邮件。
    src_main = (Path(__file__).with_name("main.py")).read_text(encoding="utf-8")
    check("超龄条目标已读的代码在位", "state.mark(stale_items)" in src_main)
    check("无新公告分支会保存超龄标记", "stale_marked" in src_main)

    print("\n[9e] robots.txt 判定与抓取策略")
    all_blocked = parse_robots("User-agent: *\nDisallow: /\n", ua_token="yds-notifier/1.0")
    check("Disallow: / 时全站禁止", not all_blocked.allows("/cw/contestNews/list/6/1"))
    empty_rules = parse_robots("User-agent: *\nDisallow:\n")
    check("空 Disallow 表示不限制", empty_rules.allows("/anything"))
    check("空内容视为无规则", parse_robots("").empty)
    parts = parse_robots(
        "User-agent: *\nDisallow: /cw/\nAllow: /cw/contestNews/\n",
    )
    check("最长匹配优先（Allow 覆盖父目录）", parts.allows("/cw/contestNews/list/6/1"))
    check("父目录仍被禁止", not parts.allows("/cw/pw/notice/list/1"))
    suffix = parse_robots("User-agent: *\nDisallow: /*.pdf$\n")
    check("通配 + $ 结尾", not suffix.allows("/files/a.pdf"))
    check("$ 只锚定结尾", suffix.allows("/files/a.pdf.html"))
    specific = parse_robots(
        "User-agent: *\nDisallow: /\n\nUser-agent: yds-notifier\nDisallow: /private/\n",
        ua_token="yds-notifier/1.0",
    )
    check("专属 UA 组优先于 *", specific.allows("/public/x") and not specific.allows("/private/x"))
    check("抓取标识不伪装浏览器", "Mozilla" not in fetch_mod.UA and "yds-notifier" in fetch_mod.UA)
    # HTTP 头按 latin-1 编码：UA 里有中文会让每次请求直接抛错（曾把整轮抓取打挂）
    check("抓取标识是纯 ASCII", all(ord(ch) < 128 for ch in fetch_mod.UA), fetch_mod.UA)
    check("中文 UA 会被收敛成 ASCII", all(
        ord(ch) < 128 for ch in fetch_mod._ascii_ua("测试 中文/1.0"))
    )
    # 策略开关：enforce 一个字节都不请求，warn 只提示，off 完全不校验
    fetch_mod.reset_stats()
    fetch_mod._robots_cache["blocked.test"] = parse_robots("User-agent: *\nDisallow: /\n")
    fetch_mod.set_respect_robots("enforce")
    check("enforce 下拒绝被禁地址", not fetch_mod.robots_allows("https://blocked.test/a"))
    check("enforce 下不发起请求（返回空串）", fetch_mod.get_text("https://blocked.test/a") == "")
    fetch_mod.set_respect_robots("warn")
    check("warn 下只提示不拦截", fetch_mod.robots_allows("https://blocked.test/a"))
    fetch_mod.set_respect_robots("off")
    check("off 下不校验", fetch_mod.robots_allows("https://blocked.test/a"))
    check("汇总行列出主机与次数", "blocked.test" in fetch_mod.robots_summary())
    fetch_mod.set_respect_robots("enforce")

    print("\n[9f] 赛事状态 AI 判定与低频扫描")
    from .contests import (
        collect_evidence, classify, load_state, plan, save_state,
    )

    class FakeAI:
        def __init__(self, payload): self.payload = payload
        def complete(self, system, user): return json.dumps(self.payload, ensure_ascii=False)

    aiconf = AiConfig(enabled=True, api_key="x", base_url="http://x", model="m",
                      thinking=False, temperature=0, max_tokens=200, timeout=1,
                      batch_size=10, max_body_chars=200, prompt_version="")
    with tempfile.TemporaryDirectory() as tmp:
        names = ["已结束赛事", "进行中赛事"]
        Path(tmp, "schedule.json").write_text(json.dumps({"contests": [
            {"contest": "已结束赛事", "finalEnd": "2026-09-01"},
            {"contest": "进行中赛事", "finalEnd": "2026-12-20"},
        ]}, ensure_ascii=False), encoding="utf-8")
        Path(tmp, "ai.json").write_text(json.dumps({"items": {
            "u1": {"analysis": {"contest": "已结束赛事", "stage": "公示",
                                 "events": [{"date": "2026-09-01", "label": "决赛"}]}},
            "u2": {"analysis": {"contest": "进行中赛事", "stage": "决赛",
                                 "events": [{"date": "2026-12-20", "label": "决赛"}]}},
        }}, ensure_ascii=False), encoding="utf-8")
        Path(tmp, "seen.json").write_text(json.dumps({"seen": {
            "u1": {"title": "获奖名单公布", "date": "2026-09-02"},
            "u2": {"title": "决赛通知", "date": "2026-11-01"},
        }}, ensure_ascii=False), encoding="utf-8")
        today = date(2026, 11, 7)
        evidence = collect_evidence(tmp, names, today)
        check("证据算出未来节点数", [e["futureNodes"] for e in evidence] == [0, 1],
              str([e["futureNodes"] for e in evidence]))
        ai_out = {"contests": [
            {"name": "已结束赛事", "ended": True, "reason": "决赛已过"},
            {"name": "进行中赛事", "ended": True, "reason": "模型误判"},
            {"name": "不存在的赛事", "ended": True, "reason": "应被丢弃"},
        ]}
        verdicts = classify(evidence, today, aiconf, client=FakeAI(ai_out))
        check("已结束赛事判为结束", verdicts["已结束赛事"]["ended"] is True)
        check("有未来节点强制进行中", verdicts["进行中赛事"]["ended"] is False)
        check("模型输出的未知赛事被丢弃", len(verdicts) == 2)
        check("证据标记全部节点已过", evidence[0]["allPast"] is True)
        check("证据算出距最晚节点天数", evidence[0]["daysSinceLastNode"] == 67,
              str(evidence[0]["daysSinceLastNode"]))
        check("获奖名单算作收尾公告", evidence[0]["closingNotices"] >= 1)

        first = plan(data_dir=tmp, contests=names, cfg={}, today=today,
                     ai_cfg=aiconf, client=FakeAI(ai_out))
        check("首轮判定 2 项", first.classified == 2, str(first.classified))
        check("首轮仍扫全部（首次到期）", set(first.selection) == set(names))
        save_state(str(Path(tmp, "zones.json")), first.state)

        reloaded = load_state(str(Path(tmp, "zones.json")))
        check("状态可持久化", reloaded["contests"]["已结束赛事"]["ended"] is True)
        # 显式传 30：验证周期可配置（线上默认是 14 天）
        second = plan(data_dir=tmp, contests=names,
                      cfg={"ended_scan_days": 30}, today=today,
                      ai_cfg=aiconf, client=FakeAI(ai_out))
        check("同周期内已结束赛事不再扫", second.selection == ["进行中赛事"], str(second.selection))
        monthly = plan(data_dir=tmp, contests=names,
                       cfg={"ended_scan_days": 30}, today=date(2026, 12, 8),
                       ai_cfg=aiconf, client=FakeAI(ai_out))
        check("显式 30 天时满期复扫", set(monthly.selection) == set(names), str(monthly.selection))
        check("到期复扫计数", monthly.due_ended == 1, str(monthly.due_ended))

    # 11 月事故回归：收尾公告不能一票否决「已结束」判定；
    # 通知里的未来日期必须像官方赛程节点一样被硬约束。
    with tempfile.TemporaryDirectory() as tmp:
        names2 = ["刚公示赛事", "仍有公示期赛事", "无赛程赛事"]
        Path(tmp, "schedule.json").write_text(json.dumps({"contests": [
            {"contest": "刚公示赛事", "finalEnd": "2026-09-01"},
            {"contest": "仍有公示期赛事", "finalEnd": "2026-10-20"},
        ]}, ensure_ascii=False), encoding="utf-8")
        Path(tmp, "ai.json").write_text(json.dumps({"items": {
            "v1": {"analysis": {"contest": "刚公示赛事", "stage": "公示",
                                "events": [{"date": "2026-09-01", "label": "决赛"}]}},
            "v2": {"analysis": {"contest": "仍有公示期赛事", "stage": "公示",
                                "events": [{"date": "2026-11-20", "label": "异议反馈截止"}]}},
            "v3": {"analysis": {"contest": "无赛程赛事", "stage": "公示",
                                "events": []}},
        }}, ensure_ascii=False), encoding="utf-8")
        Path(tmp, "seen.json").write_text(json.dumps({"seen": {
            "v1": {"title": "获奖名单公示", "date": "2026-09-02"},
            "v2": {"title": "决赛结果公示", "date": "2026-10-27"},
            "v3": {"title": "往届获奖公示与赛题宣讲回顾", "date": "2026-10-23"},
        }}, ensure_ascii=False), encoding="utf-8")
        ev2 = collect_evidence(tmp, names2, date(2026, 11, 7))
        check("公示通知本身不产生未来节点", ev2[0]["futureEventCount"] == 0)
        check("公示截止日算未来事件", ev2[1]["futureEventCount"] == 1)
        conservative = {"contests": [
            {"name": "刚公示赛事", "ended": False, "reason": "公示期未明确截止，后续事项未收尾"},
            {"name": "仍有公示期赛事", "ended": True, "reason": "决赛已结束"},
            {"name": "无赛程赛事", "ended": True, "reason": "仅见往届公示，推测已结束"},
        ]}
        v2 = classify(ev2, date(2026, 11, 7), aiconf, client=FakeAI(conservative))
        check("模型保守误判被代码纠正为已结束", v2["刚公示赛事"]["ended"] is True)
        check("纠正后理由写明依据", "已结束" in v2["刚公示赛事"]["reason"])
        check("通知里的未来截止日强制进行中", v2["仍有公示期赛事"]["ended"] is False)
        check("未来事件理由写明硬约束", "未来时间节点" in v2["仍有公示期赛事"]["reason"])
        check("缺少官方赛程时强制进行中", v2["无赛程赛事"]["ended"] is False)
        check("缺赛程理由写明 fail-open", "官方赛程缺少" in v2["无赛程赛事"]["reason"])

    from .ai.prompts import load_prompt
    spec = load_prompt("contest_status")
    check("提示词把收尾公告定义为结束证据", "收尾信号" in spec.system)
    check("提示词要求 allPast 判已结束", "allPast" in spec.system and "ended: true" in spec.system)

    # 配置联动守卫：复扫间隔超过推送窗口时，复扫才发现的通知只会归档、不推送。
    # 2026-11-07 起三个周期统一为 14 天（判定复核 / 复扫 / 推送窗口）。
    import yaml
    from .contests import DEFAULT_CHECK_DAYS, DEFAULT_ENDED_SCAN_DAYS
    cfg_yaml = yaml.safe_load(
        (Path(__file__).resolve().parent.parent / "config.yaml").read_text(encoding="utf-8")
    )
    check("判定复核周期默认 14 天", DEFAULT_CHECK_DAYS == 14, str(DEFAULT_CHECK_DAYS))
    check("复扫间隔默认 14 天", DEFAULT_ENDED_SCAN_DAYS == 14, str(DEFAULT_ENDED_SCAN_DAYS))
    check("配置与代码默认值一致",
          cfg_yaml["contest_status"]["check_days"] == DEFAULT_CHECK_DAYS
          and cfg_yaml["contest_status"]["ended_scan_days"] == DEFAULT_ENDED_SCAN_DAYS)
    check("推送窗口为 14 天", cfg_yaml["push_max_age_days"] == 14)
    check("复扫间隔不超过推送窗口",
          cfg_yaml["contest_status"]["ended_scan_days"] <= cfg_yaml["push_max_age_days"])

    # 每天两轮的分工：更新慢的源只在上午那轮抓，第二轮不再请求它们。
    cfg_two = {"sources": [
        {"key": "cpipc", "contest": 6, "max_pages": 1, "runs": "twice"},
        {"key": "cpipc_pw", "channel": "notice", "max_pages": 1, "runs": "daily"},
        {"key": "cpipc_pw", "channel": "document", "max_pages": 1, "runs": "daily"},
        {"key": "cie", "max_pages": 2, "runs": "daily"},
    ]}
    pass_one = build_sources(cfg_two, first_pass=True)
    pass_two = build_sources(cfg_two, first_pass=False)
    check("第一轮扫全部源", len(pass_one) == 4, str(len(pass_one)))
    check("第二轮只扫高变化源", [s.key for s in pass_two] == ["cpipc"],
          str([s.key for s in pass_two]))
    check("第二轮不含年度栏目与学会公告",
          all(getattr(s, "channel", "") != "notice" for s in pass_two) and len(pass_two) == 1)
    check("runs 缺省视为两轮都扫",
          len(build_sources({"sources": [{"key": "cpipc", "contest": 6}]}, first_pass=False)) == 1)

    # 配置与调度的一致性：两轮时刻、摘要窗口、页数都要对得上
    src_cfg = cfg_yaml["sources"]
    daily_keys = [
        s.get("channel") or s["key"] for s in src_cfg
        if str(s.get("runs", "twice")).lower() == "daily"
    ]
    check("年度栏目 / 大赛文件 / 学会公告只扫一轮",
          sorted(daily_keys) == ["cie", "document", "notice"], str(sorted(daily_keys)))
    zones_src = next(s for s in src_cfg if s["key"] == "cpipc_zones")
    check("赛事专区两轮都扫", str(zones_src.get("runs", "twice")) == "twice")
    check("所有源只取 1–2 页", all(int(s.get("max_pages", 1)) <= 2 for s in src_cfg),
          str([s.get("max_pages") for s in src_cfg]))
    wf = yaml.safe_load(
        (Path(__file__).resolve().parent.parent / ".github/workflows/notify.yml").read_text(encoding="utf-8")
    )
    cron = wf[True]["schedule"][0]["cron"]
    check("定时任务每天两轮", cron == "0 2,12 * * *", cron)
    first_utc = int(cron.split()[1].split(",")[0])
    check("首轮 UTC 时刻换算后等于 digest_hour",
          (first_utc + 8) % 24 == cfg_yaml["digest_hour"],
          f"{first_utc}+8 vs {cfg_yaml['digest_hour']}")
    check("第二轮不与摘要窗口重叠",
          not in_digest_window(_dt(2026, 11, 7, 20, 0), cfg_yaml["digest_hour"]))

    # AI 失败必须 fail-open：全部按进行中扫描，不缓存判定
    with tempfile.TemporaryDirectory() as tmp:
        class FailAI:
            def complete(self, system, user): raise AiClientError("网络不可用")
        failed = plan(data_dir=tmp, contests=["甲", "乙"], cfg={},
                      today=date(2026, 11, 7), ai_cfg=aiconf, client=FailAI())
        check("AI 失败时全部按进行中扫描", set(failed.selection) == {"甲", "乙"})
        check("AI 失败标记", failed.ai_failed is True)
        off = plan(data_dir=tmp, contests=["甲", "乙"], cfg={"enabled": False},
                   today=date(2026, 11, 7), ai_cfg=aiconf, client=FailAI())
        check("关闭判定后不改变扫描范围", set(off.selection) == {"甲", "乙"})
    # 旧版轮询状态（version=1）应被丢弃而不是误读
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, "zones.json").write_text('{"version":1,"offset":4,"lastSweep":"2026-11-07"}',
                                           encoding="utf-8")
        check("旧轮询状态被安全丢弃", load_state(str(Path(tmp, "zones.json")))["contests"] == {})

    print("\n[9g] 只读模式 / 抓取合规 / 事务边界 / 默认值")
    src_main = (Path(__file__).with_name("main.py")).read_text(encoding="utf-8")
    src_body = (Path(__file__).with_name("ai") / "body.py").read_text(encoding="utf-8")
    src_dispatch = (Path(__file__).with_name("dispatch.py")).read_text(encoding="utf-8")
    check("只读模式统一判定", "read_only = bool(args.check or args.preview or args.dry_run)" in src_main)
    check("只读模式会还原本地状态",
          "_snapshot_local_state" in src_main and "_restore_local_state" in src_main)
    check("详情抽检只在写状态模式", "writes_state and not first_run" in src_main)
    check("正文回填走统一抓取层", "fetch.get_text" in src_body)
    check("正文回填不再伪装浏览器", "Mozilla" not in src_body and "requests.get" not in src_body)
    check("正文回填保留主机白名单", "_host_allowed" in src_body)
    check("即时失败与快报失败分开记账",
          "instant_failed" in src_dispatch and "result.instant_failed" in src_main)
    check("推送窗口默认值对齐 config", 'cfg.get("push_max_age_days", 14)' in src_main)
    check("追赶阈值默认值对齐 config", 'cfg.get("catchup_threshold", 10)' in src_main)

    from . import main as main_mod
    from .schedule import ScheduleStore
    with tempfile.TemporaryDirectory() as tmp:
        origin = main_mod.DATA_DIR
        main_mod.DATA_DIR = tmp
        try:
            seen = Path(tmp, "seen.json")
            seen.write_text('{"seen":{}}', encoding="utf-8")
            main_mod._snapshot_local_state()
            seen.write_text('{"seen":{"x":1}}', encoding="utf-8")
            main_mod._restore_local_state()
            check("只读模式退出后还原本地状态", '"x"' not in seen.read_text(encoding="utf-8"))
        finally:
            main_mod.DATA_DIR = origin
        st = ScheduleStore(str(Path(tmp, "schedule.json")))
        st.updated_at = "2026-11-01T00:00:00"  # 无时区时间戳
        check("无时区赛程时间戳不崩溃", isinstance(st.stale(7), bool))

    print("\n[10] 归档同步不会被「无新公告」提前返回跳过")
    # 回归守卫：同步曾写在 `if not fresh: return 0` 之后，导致没有新公告时
    # 归档/RSS/日历永远为空。这里只做静态顺序校验，不联网、不发信。
    src = (Path(__file__).with_name("main.py")).read_text(encoding="utf-8")
    sync_at = src.find("publish_notices(payload)")
    early_at = src.find("if not merged and not args.preview")
    check("主流程中存在归档同步调用", sync_at > 0)
    check("同步位于无新公告提前返回之前", 0 < sync_at < early_at)
    check("同步结果会写入状态指纹", "archive_changed = True" in src)

    print("\n[11] 提示词目录与输出契约")
    spec = load_prompt("notices")
    check("提示词版本 = v2", spec.version == "v2", spec.version)
    check("system 含 json（DeepSeek 前置条件）", "json" in spec.system.lower())
    check("system 声明不可信数据", "不可信" in spec.system)
    check("system 禁止模型换算日期", "换算" in spec.system and "原样复制" in spec.system)
    check("system 禁止把发布日期当事件日", "发布日期" in spec.system and "禁止" in spec.system)
    check("模板变量替换", render("今天 {{today}} / {{uid}}", today="2026-11-06", uid="u1")
          == "今天 2026-11-06 / u1")
    try:
        render("缺少 {{missing}}")
        check("缺变量时报错", False)
    except Exception:
        check("缺变量时报错", True)
    schema = load_schema(spec)
    check("schema 是 draft-07 对象", schema.get("type") == "object"
          and "draft-07" in str(schema.get("$schema")))
    check("schema 分类白名单与代码一致",
          set(schema["properties"]["notices"]["items"]["properties"]["category"]["enum"])
          == set(CATEGORIES))
    check("schema 阶段白名单与 personas 一致",
          set(schema["properties"]["notices"]["items"]["properties"]["stage"]["enum"])
          == set(STAGES) | {""})
    check("schema 人群白名单与 personas 一致",
          set(schema["properties"]["notices"]["items"]["properties"]["audiences"]["items"]["enum"])
          == set(AUDIENCES))
    check("user 模板渲染出输入", "u-abc" in user_payload(
        spec, [{"uid": "u-abc", "title": "通知", "body": ""}], "2026-11-06"))
    examples = load_examples(spec)
    check("离线回归样本 >= 5 条", len(examples) >= 5, str(len(examples)))

    print("\n[12] AI 输出校验（模型提议、代码决定）")
    for case in examples:
        got = validate_response(
            {"notices": [case["response"]]}, [case["input"]], "notices:v2"
        )
        row = got.get(case["input"]["uid"], {})
        evs = row.get("events") or []
        exp = case["expect"]
        if "events" in exp:
            check(f"{case['name']}：事件数", len(evs) == exp["events"],
                  f"got {len(evs)} expect {exp['events']}")
        if "date" in exp and evs:
            check(f"{case['name']}：日期", evs[0]["date"] == exp["date"], evs[0]["date"])
        if "urgency" in exp:
            check(f"{case['name']}：紧急度", row.get("urgency") == exp["urgency"],
                  str(row.get("urgency")))
        if "category" in exp:
            check(f"{case['name']}：分类", row.get("category") == exp["category"],
                  str(row.get("category")))
        if "contest" in exp:
            check(f"{case['name']}：赛事", row.get("contest") == exp["contest"],
                  str(row.get("contest")))
        if "stage" in exp:
            check(f"{case['name']}：阶段", row.get("stage") == exp["stage"],
                  str(row.get("stage")))
        if "audiences" in exp:
            check(f"{case['name']}：人群", row.get("audiences") == exp["audiences"],
                  str(row.get("audiences")))
    check("全年份日期直接解析", parse_evidence_date("2026年11月25日", "2026-08-05") == "2026-11-25")
    check("无年份以发布日期补年", parse_evidence_date("8 月 10 日", "2026-08-05") == "2026-08-10")
    check("跨年公告进位到下一年", parse_evidence_date("1 月 10 日", "2026-12-20") == "2027-01-10")
    check("无效短语返回空", parse_evidence_date("下周一", "2026-08-05") == "")

    print("\n[13] AI 缓存与幂等")
    with tempfile.TemporaryDirectory() as tmp:
        cache = AiCache(str(Path(tmp) / "ai.json"))
        h = input_hash({"uid": "u1", "title": "通知", "published": "2026-08-05",
                        "url": "https://x/1", "body": "正文"}, "notices:v1")
        check("input_hash 稳定", h == input_hash(
            {"uid": "u1", "title": "通知", "published": "2026-08-05",
             "url": "https://x/1", "body": "正文"}, "notices:v1"))
        check("提示词升版改变 hash", h != input_hash(
            {"uid": "u1", "title": "通知", "published": "2026-08-05",
             "url": "https://x/1", "body": "正文"}, "notices:v2"))
        cache.put("u1", h, {"uid": "u1", "category": "报名参赛", "version": "notices:v1"},
                  "deepseek-flash", body="正文")
        check("缓存命中", (cache.get("u1", h, "notices:v1") or {}).get("category") == "报名参赛")
        check("缓存正文可读回", cache.body_of("u1") == "正文")
        check("版本不匹配失效", cache.get("u1", h, "notices:v2") is None)
        check("内容指纹不匹配失效", cache.get("u1", "other", "notices:v1") is None)
        cache.save()
        again = AiCache(str(Path(tmp) / "ai.json"))
        check("落盘后可读回", (again.get("u1", h, "notices:v1") or {}).get("category") == "报名参赛")
        off = AiConfig(enabled=False, api_key="", base_url="https://api.deepseek.com",
                       model="deepseek-flash", thinking=False, temperature=0.1,
                       max_tokens=4096, timeout=60, batch_size=8,
                       max_body_chars=3000, prompt_version="")
        item = {"uid": "u2", "title": "新通知", "published": "2026-11-06",
                "url": "https://x/2", "body": ""}
        res = analyze_notices([item], off, AiCache(str(Path(tmp) / "off.json")))
        check("AI 关闭时零 API 调用", res.calls == 0 and res.analyzed == 0)
        cache2 = AiCache(str(Path(tmp) / "body.json"))
        cache2.put_body("u9", "正文")
        cache2.save()
        check("正文缓存不重复标脏", AiCache(str(Path(tmp) / "body.json")).changed is False)
        check("正文缓存可读回", AiCache(str(Path(tmp) / "body.json")).body_of("u9") == "正文")

    print("\n[13b] OpenAI 兼容客户端（离线 mock，验证 DeepSeek 特有参数）")
    from unittest.mock import MagicMock

    cfg = AiConfig(enabled=True, api_key="sk-test", base_url="https://api.deepseek.com",
                   model="deepseek-flash", thinking=False, temperature=0.1,
                   max_tokens=4096, timeout=60, batch_size=8,
                   max_body_chars=3000, prompt_version="")
    cli = AiClient(cfg)
    fake = MagicMock()
    ok_resp = MagicMock()
    ok_resp.choices = [MagicMock(message=MagicMock(content='{"notices": []}'))]
    ok_resp.usage = MagicMock(prompt_tokens=100, completion_tokens=20)
    fake.chat.completions.create.return_value = ok_resp
    cli._client = fake
    check("客户端返回 JSON 文本", cli.complete("sys", "user") == '{"notices": []}')
    kwargs = fake.chat.completions.create.call_args.kwargs
    check("使用 response_format json_object",
          kwargs.get("response_format") == {"type": "json_object"})
    check("默认关闭 thinking",
          (kwargs.get("extra_body") or {}).get("thinking") == {"type": "disabled"})
    check("模型 = deepseek-flash", kwargs.get("model") == "deepseek-flash")
    check("统计 token 用量", cli.prompt_tokens == 100 and cli.completion_tokens == 20)
    blank = MagicMock()
    blank.choices = [MagicMock(message=MagicMock(content="   "))]
    blank.usage = None
    blank_client = AiClient(cfg)
    blank_client._client = MagicMock()
    blank_client._client.chat.completions.create.return_value = blank
    try:
        blank_client.complete("sys", "user")
        check("空白 content 判空并失败", False)
    except AiClientError:
        check("空白 content 判空并失败", True)
    check("空白 content 触发重试", blank_client._client.chat.completions.create.call_count == 2)

    print("\n[14] 规则日期抽取修复（AI 关闭时的兜底）")
    n1 = _notice("关于全国总决赛日程安排的通知", uid="r1")
    n1.published = date(2026, 8, 5)
    n1.raw_body = "第二十一届研电赛全国总决赛决赛于 8 月 10 日在桐乡举行，请各参赛队提前到场。"
    check("日期在关键词之后也能抽到", extract_deadline(n1) == "2026-08-10", extract_deadline(n1))
    n2 = _notice("关于决赛延期的补充通知", uid="r2")
    n2.published = date(2026, 12, 20)
    n2.raw_body = "原定赛程调整，决赛改于 1 月 10 日举行，其余安排不变。"
    check("跨年规则抽取补对年份", extract_deadline(n2) == "2027-01-10", extract_deadline(n2))
    n3 = _notice("赛场花絮", uid="r3")
    n3.published = date(2026, 8, 6)
    n3.raw_body = "本通知发布于 2026-08-06，回顾精彩瞬间。"
    check("不把发布日期当事件日", extract_deadline(n3) == "", extract_deadline(n3))
    long_pad = "相关事项说明与联系方式如下，" * 6
    n4 = _notice("报名通知", uid="r4")
    n4.published = date(2026, 8, 1)
    n4.raw_body = "报名截止" + long_pad + "2026年11月25日，逾期系统关闭。"
    check("超过旧 42 字窗口仍能抽到", extract_deadline(n4) == "2026-11-25", extract_deadline(n4))

    print("\n[15] AI 结果贯通载荷与邮件")
    n5 = _notice("报名通知", uid="r5")
    n5.published = date(2026, 11, 1)
    before = n5.summary
    apply_analysis(n5, {
        "uid": "r5", "category": "报名参赛", "summary": "11 月 25 日报名截止",
        "urgency": "critical", "reason": "临近截止", "version": "notices:v1",
        "confidence": 0.95,
        "events": [{"date": "2026-11-25", "evidence": "2026年11月25日",
                    "label": "报名截止", "kind": "deadline", "location": "", "confidence": 0.9}],
    })
    check("AI 摘要不覆盖原 summary", n5.summary == before)
    check("AI 分类生效", n5.category == "报名参赛")
    check("critical 权重最高", n5.weight > 100)
    check("critical 主题带标记", "【重要】" in build_subject([n5], "【研电赛】"))
    check("纯文本含 AI 摘要", "11 月 25 日报名截止" in build_text([n5]))
    check("纯文本含事件日", "报名截止：2026-11-25" in build_text([n5]))
    check("HTML 含事件日", "2026-11-25" in build_html([n5]))
    payload = build_payload([n5])
    item5 = payload["notices"][0]
    check("载荷含 aiEvents", item5["aiEvents"][0]["date"] == "2026-11-25")
    check("载荷含 aiUrgency", item5["aiUrgency"] == "critical")
    check("载荷不含正文", "rawBody" not in item5 and "body" not in item5)
    fp1 = payload_fingerprint(payload)
    item5["aiEvents"][0]["date"] = "2026-12-01"
    check("AI 事件日变化触发重推", payload_fingerprint(payload) != fp1)
    fallback = _notice("关于决赛的通知", uid="r6")
    fallback.published = date(2026, 8, 5)
    fallback.raw_body = "决赛于 8 月 10 日举行。"
    fb_item = build_payload([fallback])["notices"][0]
    check("AI 关闭时仍有等价事件", fb_item["aiEvents"][0]["date"] == "2026-08-10")

    print("\n[16] 赛事 / 阶段 / 人员视角")
    check("研电赛简称归一", infer_contest("第二十一届研电赛报名通知") == "电子设计竞赛")
    check("EDA 优先于创芯", infer_contest("创芯大赛—EDA精英挑战赛") == "EDA精英挑战赛")
    check("识别不出时留空（不硬猜研电赛）", infer_contest("某通知") == "")
    check("报名阶段", infer_stage("关于报名截止时间延长的通知") == "报名")
    check("资格审查阶段", infer_stage("关于做好参赛资格审核工作的通知") == "资格审查")
    check("回顾类判为动态", infer_stage("全国总决赛圆满落幕") == "动态")
    check("报销优先于决赛", infer_stage("总决赛报销所需文件") == "报销")
    aud = infer_audiences("资格审查", "请各研究生培养单位完成审核")
    check("培养单位进入管理员视角", "admin" in aud, str(aud))
    check("动态不打扰管理员", "admin" not in infer_audiences("动态", "总决赛圆满落幕"))
    auto = Notice(source="测试", source_key="t", title="关于报名截止的通知", url="https://x/1")
    check("构造时自动补全视角字段", auto.stage == "报名" and "student" in auto.audiences
          and bool(auto.action))
    check("低价值动态标记", auto.is_low_value is False)
    check("倒计时判为低价值", _notice("倒计时3天丨总决赛即将开幕").is_low_value is True)
    future = _notice("报名通知", uid="f1")
    future.deadline = (date.today() + timedelta(days=5)).isoformat()
    check("距截止天数计算", future.days_to_deadline == 5, str(future.days_to_deadline))
    r_student = Recipient(email="a@b.com", audiences=frozenset({"student"}))
    r_admin = Recipient(email="c@d.com", audiences=frozenset({"admin"}))
    check("视角过滤命中", r_student.wants_notice(auto) and not r_admin.wants_notice(auto))
    check("未设置视角收全量", Recipient(email="e@f.com").wants_notice(auto))

    print("\n[17] 官方赛程解析与提醒")
    table = """
    <table>
      <tr><td>序号</td><td>主题赛事</td><td>报名时间</td><td>提交作品时间</td><td>决赛时间</td></tr>
      <tr><td>4</td><td>电子设计竞赛</td><td>4月3日-6月20日</td><td>4月3日-6月20日</td><td>8月11日-15日</td></tr>
      <tr><td>9</td><td>公共管理案例大赛</td><td>12月20日-1月10日</td><td>1月13日-3月31日</td><td>6月13日-14日</td></tr>
      <tr><td>10</td><td>未来飞行器创新大赛</td><td>各赛道赛程安排不同</td><td></td><td></td></tr>
    </table>"""
    rows = parse_schedule(table, 2026, "https://cpipc.acge.org.cn/x")
    check("解析出 3 行赛事", len(rows) == 3, str(len(rows)))
    edc = next(r for r in rows if r.contest == "电子设计竞赛")
    check("报名时间范围", edc.signup_start == "2026-04-03" and edc.signup_end == "2026-06-20")
    check("决赛单日期补全", edc.final_start == "2026-08-11" and edc.final_end == "2026-08-15")
    pm = next(r for r in rows if "公共管理" in r.contest)
    check("跨年报名进位", pm.signup_start == "2026-12-20" and pm.signup_end == "2027-01-10")
    check("无日期不瞎猜", rows[2].signup_end == "" and rows[2].final_start == "")
    with tempfile.TemporaryDirectory() as tmp:
        store = ScheduleStore(str(Path(tmp) / "schedule.json"))
        check("空缓存标记 stale", store.empty and store.stale())
        store.replace(rows, 2026, "https://cpipc.acge.org.cn/x")
        store.save()
        again = ScheduleStore(str(Path(tmp) / "schedule.json"))
        check("赛程落盘可读回", len(again.contests) == 3 and again.year == 2026)
        rem = again.reminders(date(2026, 6, 13), [7], ["电子设计竞赛"])
        check("T-7 生成报名截止提醒", len(rem) == 1 and rem[0].stage == "报名", str(len(rem)))
        check("提醒带截止日", rem[0].deadline == "2026-06-20")
        check("提醒面向学生", "student" in rem[0].audiences, str(rem[0].audiences))
        check("提醒不带低价值标记", rem[0].is_low_value is False)
        check("未到窗口不提醒", not again.reminders(date(2026, 6, 10), [7], ["电子设计竞赛"]))
        log = ReminderLog(str(Path(tmp) / "reminders.json"))
        check("首次提醒待发", len(log.pending(rem, date(2026, 6, 13))) == 1)
        log.mark(rem, date(2026, 6, 13))
        check("同日不重复提醒", not log.pending(rem, date(2026, 6, 13)))
        log.save()
        check("提醒日志落盘", len(ReminderLog(str(Path(tmp) / "reminders.json")).sent) == 1)
        store_payload = again.payload(["电子设计竞赛"])
        check("赛程载荷只含指定赛事", len(store_payload) == 1
              and store_payload[0]["contest"] == "电子设计竞赛")
        with_sched = build_payload([n5], schedule=store_payload)
        check("载荷含 schedule", with_sched.get("schedule") and len(with_sched["schedule"]) == 1)
        fp = payload_fingerprint(with_sched)
        with_sched["schedule"][0]["signupEnd"] = "2026-06-27"
        check("赛程变化触发重推", payload_fingerprint(with_sched) != fp)

    print("\n[18] 后台角色 / 赛事偏好与赛事专区")

    # 赛事清单已收敛到 shared/contests.json：这里验证「两端确实都读它」，
    # 而不是像旧版那样去解析 TypeScript 源码文本比对。
    contract = json.loads(
        (Path(__file__).resolve().parent.parent / "shared/contests.json").read_text(encoding="utf-8")
    )
    names = [c["name"] for c in contract["contests"]]
    check("赛事契约与 Python 常量一致", tuple(names) == tuple(CONTESTS),
          f"{len(names)} vs {len(CONTESTS)}")
    check("赛事契约无重复", len(set(names)) == len(names))
    auth_ts = (Path(__file__).resolve().parent.parent / "worker/src/auth.ts").read_text(encoding="utf-8")
    check("Worker 从契约文件读取赛事", "shared/contests.json" in auth_ts,
          "auth.ts 应 import 契约，而不是自带一份清单")
    check("赛事契约的专区 id 与 Python 映射一致",
          {c["name"]: c["zoneId"] for c in contract["contests"]} == dict(CONTEST_IDS))

    r1 = Recipient(
        email="s@x.com",
        audiences=frozenset({"student"}),
        contests=frozenset({"电子设计竞赛"}),
    )
    n_edc = _notice("报名通知", uid="z1")
    n_edc.contest = "电子设计竞赛"
    n_ai = _notice("人工智能大赛通知", uid="z2")
    n_ai.contest = "人工智能创新大赛"
    n_gen = _notice("2026年度赛程一览", uid="z3")
    n_gen.contest = ""
    check("关注赛事命中", r1.wants_notice(n_edc))
    check("未关注赛事被过滤", not r1.wants_notice(n_ai))
    check("全站通知不因赛事过滤丢失", r1.wants_notice(n_gen))
    check("角色不匹配也过滤", not Recipient(email="a@x.com", audiences=frozenset({"admin"})).wants_notice(n_edc))

    check("解析 role 对象", _parse_audiences({"audiences": {"student": True, "admin": False}})
          == frozenset({"student"}))
    check("解析 role 数组", _parse_audiences({"audiences": ["advisor"]}) == frozenset({"advisor"}))
    check("空赛事数组 = 全部", _parse_contests({"contests": []}) is None)
    check("解析赛事数组", _parse_contests({"contests": ["电子设计竞赛"]})
          == frozenset({"电子设计竞赛"}))
    check("关注赛事并集", watched_contests([
        Recipient(email="1@x.com", contests=frozenset({"电子设计竞赛"})),
        Recipient(email="2@x.com", contests=frozenset({"人工智能创新大赛"})),
    ]) == frozenset({"电子设计竞赛", "人工智能创新大赛"}))
    check("任一不限则返回 None", watched_contests([
        Recipient(email="3@x.com", contests=frozenset({"电子设计竞赛"})),
        Recipient(email="4@x.com"),
    ]) is None)

    zones = CpipcZonesSource(
        contests=["电子设计竞赛", "创“芯”大赛", "人工智能创新大赛"], per_run=2, offset=1
    )
    check("专区按 offset 轮询", zones.contests == ["创“芯”大赛", "人工智能创新大赛"], str(zones.contests))
    cfg_zones = {"sources": [{
        "key": "cpipc_zones", "enabled": True, "per_run": 4,
        "contests": ["电子设计竞赛", "人工智能创新大赛"],
    }]}
    only = build_sources(cfg_zones, only_contests={"人工智能创新大赛"})
    check("只抓订阅者关注的赛事", only and only[0].contests == ["人工智能创新大赛"],
          str([s.contests for s in only]))
    check("无人关注时跳过专区源", build_sources(cfg_zones, only_contests=set()) == [])
    # 每轮全量扫：一轮必须覆盖所有可扫专区（19 个），不靠游标分片；
    # 20 项赛事里「乡村振兴」没有独立专区（zoneId 为空）。
    all_zones = [c for c, cid in CONTEST_IDS.items() if cid]
    cfg_all = {"sources": [{
        "key": "cpipc_zones", "enabled": True, "contests": all_zones,
    }]}
    full = build_sources(cfg_all, only_contests=set(all_zones))
    check("一轮全量扫覆盖全部 19 个专区",
          full and len(full[0].contests) == 19, str(len(full[0].contests) if full else 0))
    check("一轮全量扫无重复专区",
          len(set(full[0].contests)) == len(full[0].contests))
    check("无专区赛事不会进入扫描列表", "乡村振兴科技强农+创新大赛" not in full[0].contests)
    check("全量扫不使用轮询游标",
          full[0].offset == 0 and full[0].per_run == 19,
          f"offset={full[0].offset} per_run={full[0].per_run}")

    html = build_html(
        [n_edc, n_ai],
        persona="student",
        calendar_url="https://x.example/calendar.ics",
        archive_url="https://x.example/archive",
    )
    check("角色版按赛事分组", "电子设计竞赛" in html and "人工智能创新大赛" in html)
    check("赛事日历链接带 contest", "calendar.ics?contest=" in html)
    check("赛事日历链接带角色", "audience=student" in html)
    check("赛事列表链接带 contest", "archive?contest=" in html)

    print("\n[20] 个人日历与按偏好过滤")

    cal = build_calendar_url("https://x.example/calendar.ics", "s3cret", "Stu@QQ.com")
    check("个人日历链接非空", cal.startswith("https://x.example/calendar.ics?"), cal[:60])
    check("个人日历带邮箱", "email=stu%40qq.com" in cal, cal[:80])
    check("个人日历带 token", "token=" in cal and cal.count(".") >= 1)
    check("缺参会返回空串", build_calendar_url("", "s3cret", "a@b.com") == "")
    check("缺密钥返回空串", build_calendar_url("https://x/calendar.ics", "", "a@b.com") == "")

    # 用途隔离：同一邮箱同一时刻，cal 与 unsub 的签名必须不同
    cal_tok = make_email_token("s3cret", "a@b.com", 3650, purpose="cal")
    unsub_tok = make_email_token("s3cret", "a@b.com", 3650, purpose="unsub")
    check("cal 与 unsub 签名不同", cal_tok.split(".")[1] != unsub_tok.split(".")[1])
    exp = cal_tok.split(".")[0]
    want = hmac.new(b"s3cret", f"cal:a@b.com:{exp}".encode(), hashlib.sha256).hexdigest()[:32]
    check("cal 签名可被 Worker 复算", cal_tok.split(".")[1] == want)

    # 已带 query 的 base 要正确续接，不能出现两个问号
    cal2 = build_calendar_url("https://x.example/calendar.ics?from=mail", "s3cret", "a@b.com")
    check("已有 query 时用 & 续接", cal2.count("?") == 1 and "&email=" in cal2, cal2[:80])

    # 邮件里的赛事链接：base 带签名参数时也要用 & 拼，且 URL 合法
    html2 = build_html(
        [n_edc], persona="student",
        calendar_url="https://x.example/calendar.ics?email=a%40b.com&token=1.abc",
        archive_url="https://x.example/archive",
    )
    check("赛事日历链接续接正确", "token=1.abc&amp;contest=" in html2)
    check("邮件页脚含我的日历", html2.count("我的日历") >= 1)

    print("\n[21] 单实例运行锁")
    lock_path = os.path.join(tempfile.mkdtemp(), "run.lock")
    first, second = RunLock(lock_path), RunLock(lock_path)
    check("首个实例拿到锁", first.acquire() is True)
    check("第二个实例被拒绝（防重复发信）", second.acquire() is False)
    first.release()
    check("释放后可再次获取", second.acquire() is True)
    second.release()

    print("\n[22] 状态对象存储（R2）")

    class FakeS3:
        """最小 S3 桩：够验证 gzip、ETag 条件写、未变跳过这三件事。"""

        def __init__(self):
            self.objects = {}
            self.puts = []
            self.fail_precondition = False

        def get_object(self, Bucket, Key):
            if Key not in self.objects:
                raise RuntimeError("NoSuchKey: %s" % Key)
            body, etag = self.objects[Key]
            return {"Body": io.BytesIO(body), "ETag": '"%s"' % etag}

        def put_object(self, Bucket, Key, Body, **kw):
            if self.fail_precondition:
                raise RuntimeError("PreconditionFailed: If-Match did not match")
            etag = hashlib.md5(Body).hexdigest()[:12]
            self.objects[Key] = (Body, etag)
            self.puts.append((Key, kw))
            return {"ETag": '"%s"' % etag}

    fake = FakeS3()
    src = tempfile.mkdtemp()
    with open(os.path.join(src, "seen.json"), "w", encoding="utf-8") as fh:
        json.dump({"version": 2, "seen": {"a": 1}}, fh)
    with open(os.path.join(src, "schedule.json"), "w", encoding="utf-8") as fh:
        json.dump({"contests": []}, fh)

    st = R2StateStore(bucket="bucket", prefix="state", client=fake)
    check("R2 存储可用", st.enabled)
    res = st.push(src)
    check("首次上传全部对象", sorted(res["uploaded"]) == ["schedule.json", "seen.json"], str(res))
    body = fake.objects["state/seen.json.gz"][0]
    check("远端对象是 gzip", body[:2] == b"\x1f\x8b")
    check("上传声明了 gzip 编码",
          fake.puts[0][1].get("ContentEncoding") == "gzip")
    check("首次上传不带 If-Match（对象还不存在）", "IfMatch" not in fake.puts[0][1])
    check("首次写回落下初始化标记", "state/_ready.json" in fake.objects)

    dst = tempfile.mkdtemp()
    st2 = R2StateStore(bucket="bucket", prefix="state", client=fake)
    check("拉取对象数", st2.pull(dst) == 2)
    with open(os.path.join(dst, "seen.json"), encoding="utf-8") as fh:
        check("拉取内容与上传一致", json.load(fh)["seen"] == {"a": 1})

    res = st2.push(dst)
    check("内容未变零上传", res["uploaded"] == [] and len(res["skipped"]) == 2, str(res))

    with open(os.path.join(dst, "seen.json"), "w", encoding="utf-8") as fh:
        json.dump({"version": 2, "seen": {"a": 2}}, fh)
    res = st2.push(dst)
    check("只传变化的对象", res["uploaded"] == ["seen.json"], str(res))
    check("二次上传带 If-Match", fake.puts[-1][1].get("IfMatch"))

    with open(os.path.join(dst, "schedule.json"), "w", encoding="utf-8") as fh:
        json.dump({"contests": [1]}, fh)
    fake.fail_precondition = True
    try:
        st2.push(dst)
        check("条件写冲突应抛错", False, "没有抛 StateConflict")
    except StateConflict:
        check("条件写冲突抛 StateConflict（不覆盖他人写入）", True)

    check("未配置 bucket 时不启用", R2StateStore(bucket="", client=fake).enabled is False)

    class BrokenS3(FakeS3):
        def get_object(self, Bucket, Key):
            raise RuntimeError("AccessDenied: no permission")

    try:
        R2StateStore(bucket="b", prefix="state", client=BrokenS3()).pull(tempfile.mkdtemp())
        check("读不到状态应中止", False, "没有抛 StateUnavailable")
    except StateUnavailable:
        check("读不到状态抛 StateUnavailable（避免用陈旧状态重发）", True)

    # 桶被清空：初始化标记还在、状态对象全没了 → 不能当成首次运行
    emptied = FakeS3()
    emptied.objects["state/_ready.json"] = (b"{}", "ready")
    try:
        R2StateStore(bucket="bucket", prefix="state", client=emptied).pull(tempfile.mkdtemp())
        check("桶被清空应中止", False, "没有抛 StateUnavailable")
    except StateUnavailable:
        check("桶被清空时中止（不拿陈旧本地状态当基线）", True)

    print(f"\n结果：{PASS} 项通过，{FAIL} 项失败")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
