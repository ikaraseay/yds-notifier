"""把通知元数据同步给 Cloudflare Worker，供 /archive、/feed.xml、/calendar.ics 使用。

设计约束：
- 只推公开字段（含 AI 分析结果），不含邮箱、密钥或抓取到的原始正文。
- 用同一枚 SUBSCRIBE_API_TOKEN 做 Bearer 鉴权，不新增 Secret。
- 内容指纹不变就跳过，避免每轮写一次 KV（免费版 1000 写/天）。
- 这是附加能力：同步失败只记录告警，绝不阻断邮件主流程。
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import List, Sequence

import requests

from .config import settings
from .models import Notice, parse_cn_date

log = logging.getLogger("yds")

# 「截止 / 延期 / 赛程」附近出现日期时，视为日历事件；否则退化为发布日期事件
_DEADLINE_HINT = re.compile(
    r"截止|截至|期限|报名结束|提交结束|延期至|延长至|结束时间|赛程|时间安排|举行|开赛|"
    r"答辩|公示期|缴费|提交材料|报到|开幕|决赛|初审|评审|领取"
)
# 任意中文/数字日期写法，用于全文兜底（配合附近的提示词过滤误报）
_ANY_DATE = re.compile(
    r"\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?"
    r"|(?<!\d)\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?"
)
_DATE_WINDOW = 60
_MAX_PAST_DAYS = 30
_MAX_FUTURE_DAYS = 730


_FULL_YEAR = re.compile(r"\d{4}\s*[-/年.]\s*\d{1,2}")


def _plausible(d, notice: Notice) -> bool:
    """过滤发布日期、历史引用与离谱的未来日期。"""
    pub = notice.published
    if not pub:
        return True
    if d == pub:
        return False
    return pub - timedelta(days=_MAX_PAST_DAYS) <= d <= pub + timedelta(days=_MAX_FUTURE_DAYS)


def _resolve(text: str, notice: Notice):
    """解析并对「无年份 + 早于发布日期」的写法进位到下一年。"""
    base_year = notice.published.year if notice.published else None
    d = parse_cn_date(text, base_year)
    if not d:
        return None
    if not _FULL_YEAR.search(text) and notice.published:
        if d < notice.published - timedelta(days=_MAX_PAST_DAYS):
            try:
                d = d.replace(year=d.year + 1)
            except ValueError:
                pass
    return d


def extract_deadline(notice: Notice) -> str:
    """从标题 / 摘要 / 正文中抽一个真实事件日（YYYY-MM-DD），抽不到返回空串。

    相比旧版的三处修正：
    1. 关键词**前后双向**取窗口 —— 「决赛于 8 月 10 日举行」的日期在关键词之前也能命中；
    2. 全文兜底，但要求日期附近仍有提示词，避免把历史年份当事件；
    3. 无年份时以**公告发布日期**补年，并排除发布日期本身。
    """
    texts = [notice.title, notice.summary, notice.raw_body]

    # 第一轮：关键词附近（双向窗口）优先
    for text in texts:
        if not text:
            continue
        for m in _DEADLINE_HINT.finditer(text):
            window = text[max(0, m.start() - _DATE_WINDOW): m.end() + _DATE_WINDOW]
            d = _resolve(window, notice)
            if d and _plausible(d, notice):
                return d.isoformat()

    # 第二轮：整段里只要出现过提示词，就扫描全文所有日期（不受窗口长度限制），
    # 靠 _plausible 排除发布日期与历史引用。修掉旧版「42 字外必漏」的问题。
    for text in texts:
        if not text or not _DEADLINE_HINT.search(text):
            continue
        for m in _ANY_DATE.finditer(text):
            d = _resolve(m.group(0), notice)
            if d and _plausible(d, notice):
                return d.isoformat()
    return ""


def _fallback_event(date_str: str, stage: str = "") -> dict:
    return {
        "date": date_str,
        "evidence": "",
        "label": f"{stage}截止" if stage in ("报名", "提交作品", "缴费") else "截止 / 日程",
        "kind": "deadline",
        "location": "",
        "confidence": 0.0,
    }


def build_payload(
    notices: Sequence[Notice],
    limit: int = 200,
    schedule: Sequence[dict] | None = None,
) -> dict:
    def event_day(n: Notice) -> str:
        if n.ai_events:
            return str(n.ai_events[0].get("date") or "")
        return n.deadline or n.date_text

    ordered = sorted(notices, key=lambda n: (event_day(n), n.title), reverse=True)[: max(1, limit)]
    items = []
    for n in ordered:
        if not n.deadline:
            n.deadline = extract_deadline(n)
        # AI 关闭或失败时，用规则抽出的日期生成一个等价事件，日历不会退回发布日期
        if not n.ai_events and n.deadline:
            n.ai_events = [_fallback_event(n.deadline, n.stage)]
        items.append(n.to_feed_item())
    payload = {
        "site": settings.site_name,
        "baseUrl": settings.public_base_url,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "notices": items,
    }
    if schedule:
        # 官方赛程单独成段：日历据此提前展示「报名截止 / 提交截止 / 决赛」
        payload["schedule"] = list(schedule)
    return payload


def payload_fingerprint(payload: dict) -> str:
    """AI 结果、人员视角或赛程变化都要触发重推，否则线上不会刷新。"""
    rows = []
    for i in payload.get("notices", []):
        events = [[e.get("date"), e.get("label"), e.get("kind")]
                  for e in (i.get("aiEvents") or []) if isinstance(e, dict)]
        rows.append([
            i.get("uid"), i.get("title"), i.get("date"), i.get("deadline"),
            i.get("changeKind"), i.get("aiCategory"), i.get("aiSummary"),
            i.get("aiUrgency"), events,
            i.get("contest"), i.get("stage"), i.get("audiences"), i.get("action"),
        ])
    sched = sorted(
        (str(s.get("contest") or ""), str(s.get("signupEnd") or ""),
         str(s.get("submitEnd") or ""), str(s.get("finalStart") or ""))
        for s in (payload.get("schedule") or []) if isinstance(s, dict)
    )
    raw = json.dumps([rows, sched], ensure_ascii=False, sort_keys=True)
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


def notices_from_state(state, ai_cache=None) -> List[Notice]:
    """从 seen.json 的轻量记录重建归档条目（首次升级时也能立即有内容）。

    若传入 ai_cache，会把历史 AI 分析结果回填到重建对象上 —— 这是历史通知
    日历事件日期不再退化为发布日期的关键。
    """
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
        if not n.title:
            continue
        if ai_cache is not None:
            apply_analysis(n, _cached(ai_cache, uid))
        if not n.deadline:
            n.deadline = extract_deadline(n)
        out.append(n)
    return out


def _cached(ai_cache, uid: str):
    """按 uid 取缓存（忽略 inputHash，历史重建时内容指纹不可得）。"""
    rec = (ai_cache.items or {}).get(uid)
    if isinstance(rec, dict) and isinstance(rec.get("analysis"), dict):
        return rec["analysis"]
    return None


def apply_analysis(notice: Notice, analysis: dict | None) -> None:
    """把 AI 结果写回 Notice；无结果时保留规则降级路径。"""
    if not analysis:
        return
    from .ai.schema import AiAnalysis

    a = AiAnalysis.from_dict(analysis)
    if a.fallback:
        # 模型漏答 / 空结果：只记版本，分类继续走关键词规则，不覆盖
        notice.ai_version = a.version
        return
    notice.ai_category = a.category
    notice.ai_summary = a.summary
    notice.ai_urgency = a.urgency
    notice.ai_reason = a.reason
    notice.ai_confidence = a.confidence
    notice.ai_version = a.version
    notice.ai_events = [e.__dict__ for e in a.events]
    # 视角字段：模型给了就覆盖规则推断，没给则保留 __post_init__ 的规则结果
    if a.contest:
        notice.contest = a.contest
    if a.stage:
        notice.stage = a.stage
    if a.audiences:
        notice.audiences = list(a.audiences)
    if a.action:
        notice.action = a.action
    if a.events and not notice.deadline:
        notice.deadline = a.events[0].date
