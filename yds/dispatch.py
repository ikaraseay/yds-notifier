"""发信编排：即时推送 / 日报 / 周报 / 暂停，以及「发信成功才标已读」的事务边界。

关键约定：
- 即时用户在本轮直接收到；日报/周报/暂停用户先把条目放进 data/pending.json 池，
  到点再合并成一封摘要。池写入成功即视为已处理，不会重复推送。
- 单封失败只记录失败邮箱；**只要还有一个即时收件人失败，整批就不写 seen.json**，
  下一轮会重发（配合 Resend Idempotency-Key 可进一步避免重复）。
- 摘要池只在发送成功后清空，失败则保留到下个窗口重试。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Sequence

from .config import settings
from .mailer import build_html, build_subject, build_text, sort_notices
from .models import Notice
from .personas import AUDIENCE_NAMES, DEADLINE_STAGES, primary_audience
from .recipients import Recipient
from .senders import BaseSender
from .state import load_pending, pending_notices, save_pending
from .unsub import build_calendar_url, build_list_unsubscribe_headers, build_unsubscribe_url

log = logging.getLogger("yds")


@dataclass
class DispatchResult:
    sent: int = 0
    failed: List[str] = field(default_factory=list)
    digest_sent: Dict[str, int] = field(default_factory=dict)
    digest_failed: int = 0
    pool_changed: bool = False


def _chunks(items: Sequence[Notice], size: int) -> List[List[Notice]]:
    return [list(items[i: i + size]) for i in range(0, len(items), size)]


def _subject(batch: Sequence[Notice], label: str, prefix: str) -> str:
    head = f"{prefix}{label}"
    return build_subject(batch, head)


def _send_one(
    sender: BaseSender,
    rcpt: Recipient,
    batch: Sequence[Notice],
    subject: str,
    repo_url: str,
    compact_low: bool = False,
) -> None:
    mine = [n for n in batch if rcpt.wants_notice(n)]
    if not mine:
        return
    unsub_ready = bool(settings.unsub_url and settings.unsub_secret)
    unsub_for = (
        build_unsubscribe_url(settings.unsub_url, settings.unsub_secret, rcpt.email)
        if unsub_ready else ""
    )
    # 只订阅单一角色时发该角色专版（按赛事分组 + 赛事日历链接）；
    # 订阅多个角色时发综合版，邮件内仍按角色分区。
    auds = rcpt.audiences or frozenset()
    persona = primary_audience(auds) if len(auds) == 1 else ""
    if persona:
        # 角色版邮件在主题上直接标出来，收件人一眼知道这是哪一版
        subject = f"〔{AUDIENCE_NAMES.get(persona, persona)}〕{subject}"
    base = (settings.public_base_url or "").rstrip("/")
    public_cal = f"{base}/calendar.ics" if base else ""
    # 个人日历：签名绑定邮箱，Worker 端据此按该用户的角色 / 赛事偏好过滤事件。
    # 签发失败（没配 secret）时退回公开日历，绝不发无签名链接冒充个人版。
    personal_cal = (
        build_calendar_url(public_cal, settings.unsub_secret, rcpt.email)
        if public_cal and settings.unsub_secret else ""
    )
    html_body = build_html(
        mine,
        site=settings.site_name,
        repo_url=repo_url,
        unsubscribe_url=unsub_for,
        issue_url=f"{repo_url}/issues" if repo_url else "",
        compact_low=compact_low,
        persona=persona,
        calendar_url=personal_cal or public_cal,
        archive_url=f"{base}/archive" if base else "",
    )
    text_body = build_text(mine, site=settings.site_name, unsubscribe_url=unsub_for)
    sender.send(
        [rcpt.email], subject, text_body, html_body,
        build_list_unsubscribe_headers(unsub_for),
    )


def _label_for(batch: Sequence[Notice]) -> str:
    return "通知更新" if any(n.change_kind == "changed" for n in batch) else "新通知"


def _is_urgent(n: Notice) -> bool:
    """紧急判定：AI 判 critical，或规则识别出 7 天内截止（无 AI 时仍生效）。"""
    if n.ai_urgency == "critical":
        return True
    if n.is_low_value or n.stage not in DEADLINE_STAGES:
        return False
    days = n.days_to_deadline
    return days is not None and days <= 7


def dispatch(
    *,
    sender: BaseSender,
    notices: Sequence[Notice],
    recipients: Sequence[Recipient],
    cfg: dict,
    pending_path: str,
    dry_run: bool = False,
    reminders: Sequence[Notice] = (),
) -> DispatchResult:
    result = DispatchResult()
    if not notices and not reminders:
        return result
    if not recipients:
        return result

    prefix = cfg.get("subject_prefix", "【研电赛】")
    max_notify = max(1, int(cfg.get("max_notify", 25)))
    digest_hour = int(cfg.get("digest_hour", 8))
    repo_url = settings.repo_url
    fresh = sort_notices(notices)

    # 1) 按频率分流
    instant = [r for r in recipients if not r.digest_key]
    digest_users: Dict[str, List[Recipient]] = {"daily": [], "weekly": []}
    for r in recipients:
        key = r.digest_key
        if key:
            digest_users[key].append(r)

    # AI 判为 critical，或规则识别出 7 天内截止的通知走「紧急快报」：
    # 无视日报/周报设置立即送达，也不进摘要池，避免同一条被发两次。
    # 暂停中的用户仍然不打扰。
    urgent = [n for n in fresh if _is_urgent(n)]

    pending = load_pending(pending_path)
    # 2) 有摘要用户时把本轮条目入池（两边都放，各自独立消费）
    if digest_users["daily"] or digest_users["weekly"]:
        for key in ("daily", "weekly"):
            if not digest_users[key]:
                continue
            for n in fresh:
                if _is_urgent(n):
                    continue
                if n.uid not in pending[key]:
                    pending[key][n.uid] = n.to_feed_item()
                    result.pool_changed = True

    # 3) 即时发送
    for batch in _chunks(fresh, max_notify):
        subject = _subject(batch, _label_for(batch), prefix)
        for rcpt in instant:
            mine = [n for n in batch if rcpt.wants_notice(n)]
            if not mine:
                log.info("%s 本轮通知不符合其栏目 / 视角偏好，跳过", rcpt.email)
                continue
            if dry_run:
                log.info("[dry-run] 将发送：%s -> %s（%s 条）", subject, rcpt.email, len(mine))
                continue
            try:
                _send_one(sender, rcpt, batch, subject, repo_url)
                result.sent += 1
            except Exception as exc:  # noqa: BLE001 - 单个收件人失败不阻断其他人
                log.error("发送给 %s 失败：%s", rcpt.email, exc)
                result.failed.append(rcpt.email)

    # 3b) 紧急快报：给原本要等摘要的用户也立刻送一份（不绕过暂停）
    if urgent:
        subject = _subject(urgent, "紧急快报", prefix)
        for rcpt in recipients:
            if not rcpt.digest_key or rcpt.is_paused():
                continue
            if not any(rcpt.wants_notice(n) for n in urgent):
                continue
            if dry_run:
                log.info("[dry-run] 紧急快报：%s -> %s", subject, rcpt.email)
                continue
            try:
                _send_one(sender, rcpt, urgent, subject, repo_url)
                result.sent += 1
            except Exception as exc:  # noqa: BLE001
                log.error("紧急快报发送给 %s 失败：%s", rcpt.email, exc)
                if rcpt.email not in result.failed:
                    result.failed.append(rcpt.email)

    # 3c) 官方赛程提醒：T-30 / T-7 / T-3 / T-1 独立成一封，
    #     不写入 seen.json 与摘要池（提醒是时点性的，过期即失效）。
    if reminders:
        for batch in _chunks(list(reminders), max_notify):
            subject = _subject(batch, "日程提醒", prefix)
            for rcpt in recipients:
                if rcpt.is_paused():
                    continue
                if not any(rcpt.wants_notice(n) for n in batch):
                    continue
                if dry_run:
                    log.info("[dry-run] 日程提醒：%s -> %s（%s 条）", subject, rcpt.email, len(batch))
                    continue
                try:
                    _send_one(sender, rcpt, batch, subject, repo_url)
                    result.sent += 1
                except Exception as exc:  # noqa: BLE001
                    log.error("日程提醒发送给 %s 失败：%s", rcpt.email, exc)
                    if rcpt.email not in result.failed:
                        result.failed.append(rcpt.email)

    # 4) 摘要窗口：每天 digest_hour 的第一个 10 分钟；周报只在周一
    now = datetime.now()
    in_window = now.hour == digest_hour and now.minute < 10
    due = {"daily": in_window, "weekly": in_window and now.weekday() == 0}

    for key, users in digest_users.items():
        if not users or not due[key] or not pending[key]:
            continue
        pool = pending_notices(pending[key])
        if dry_run:
            log.info("[dry-run] 将发送 %s 摘要：%s 条 -> %s 人", key, len(pool), len(users))
            continue
        failures = 0
        label = "每日摘要" if key == "daily" else "每周摘要"
        for batch in _chunks(pool, max_notify):
            subject = _subject(batch, label, prefix)
            for rcpt in users:
                if not any(rcpt.wants_notice(n) for n in batch):
                    continue
                try:
                    _send_one(sender, rcpt, batch, subject, repo_url, compact_low=True)
                    result.sent += 1
                except Exception as exc:  # noqa: BLE001
                    # 摘要失败不阻断主流程状态写入：条目仍在池里，下个窗口会重试，
                    # 若因此不 mark，即时用户反而会在下一轮收到重复邮件。
                    log.error("%s 摘要发送给 %s 失败：%s", key, rcpt.email, exc)
                    failures += 1
                    result.digest_failed += 1
        if failures == 0:
            # 成功才清池；失败保留到下个窗口重试
            pending[key] = {}
            result.pool_changed = True
            result.digest_sent[key] = len(pool)
            log.info("%s 已发送 %s 条 -> %s 人，池已清空", label, len(pool), len(users))
        else:
            log.warning("%s 有 %s 个收件人失败，池保留待重试", label, failures)

    if result.pool_changed and not dry_run:
        save_pending(pending_path, pending)

    return result
