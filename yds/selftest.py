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
from datetime import date, timedelta
from pathlib import Path

from .ai.analyzer import analyze_notices
from .ai.cache import AiCache
from .ai.client import AiClient, AiClientError, AiConfig
from .ai.prompts import load_examples, load_prompt, load_schema, render, user_payload
from .ai.schema import CATEGORIES, input_hash, parse_evidence_date, validate_response
from .config import derive_base_url, derive_internal_base, settings
from .mailer import build_html, build_subject, build_text
from .models import Attachment, Notice
from .personas import AUDIENCES, STAGES, infer_audiences, infer_contest, infer_stage
from .publish import apply_analysis, build_payload, extract_deadline, payload_fingerprint
from .recipients import Recipient, _valid
from .schedule import ContestSchedule, ReminderLog, ScheduleStore, parse_schedule
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

    print(f"\n结果：{PASS} 项通过，{FAIL} 项失败")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
