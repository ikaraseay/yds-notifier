"""命令行入口。

用法：
    python -m yds --check              # 只抓取并打印，不写状态、不发信（排查解析用）
    python -m yds --dry-run            # 完整流程，但不发信、不写状态
    python -m yds                      # 抓取 -> 变更检测 -> 发信 -> 状态落盘
    python -m yds --preview out.html   # 把最近抓到的通知渲染成本地 HTML 预览
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import date
from typing import Dict, List

import yaml

from . import fetch  # noqa: F401  (提前初始化 session)
from .config import settings
from .dispatch import dispatch
from .mailer import build_html, build_text, sort_notices
from .models import Notice
from .publish import build_payload, notices_from_state, payload_fingerprint, publish_notices
from .recipients import resolve_recipients, split_recipients
from .senders import build_client
from .sources import BaseSource, build_sources
from .state import State
from .unsub import build_unsubscribe_url

log = logging.getLogger("yds")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_config(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def collect(sources: List[BaseSource], enrich: bool = True) -> List[Notice]:
    """抓取所有数据源，并按 uid 去重合并（多源可能报同一件事）。"""
    merged: Dict[str, Notice] = {}
    for src in sources:
        try:
            items = src.fetch()
        except Exception as exc:  # noqa: BLE001 - 单源失败不影响其他源
            log.error("[%s] 抓取整体失败：%s", src.name, exc)
            continue
        for item in items:
            if enrich:
                item = src.enrich(item)
                if item is None:
                    continue
            prev = merged.get(item.uid)
            if prev is None:
                merged[item.uid] = item
            elif len(item.attachments) > len(prev.attachments):
                item.source = f"{prev.source} / {item.source}"
                merged[item.uid] = item
    return list(merged.values())


def collect_meta(sources: List[BaseSource]) -> List[Notice]:
    """只抓列表页：高频轮询下先判断有没有变化，再决定是否抓详情。"""
    return collect(sources, enrich=False)


def enrich_only(sources: List[BaseSource], wanted: set) -> List[BaseSource]:
    """包一层：让数据源只对指定 uid 抓详情页，其余条目直接丢弃。"""
    for src in sources:
        original = src.enrich

        def limited(notice, _orig=original, _wanted=wanted):
            if notice.uid not in _wanted:
                return None
            return _orig(notice)

        src.enrich = limited  # type: ignore[method-assign]
    return sources


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="yds", description="研电赛通知邮件订阅器")
    parser.add_argument("--config", default=os.path.join(ROOT, "config.yaml"))
    parser.add_argument("--state", default=None, help="覆盖状态文件路径")
    parser.add_argument("--check", action="store_true", help="只抓取并打印结果")
    parser.add_argument("--dry-run", action="store_true", help="不真正发信、不写状态")
    parser.add_argument("--preview", metavar="FILE", help="导出一份 HTML 预览")
    parser.add_argument("--max-notify", type=int, default=0, help="单封邮件的最大条目数")
    parser.add_argument("--to", default="", help="临时覆盖收件人，测试时用")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    cfg = load_config(args.config)
    if args.max_notify:
        cfg["max_notify"] = args.max_notify
    sources = build_sources(cfg)
    if not sources:
        log.error("没有启用任何数据源，请检查 %s", args.config)
        return 2

    sender = build_client(cfg.get("mail") or {})
    static_to = args.to or settings.mail_to
    fallback_list_url = (
        f"{settings.public_base_url.rstrip('/')}/api/list" if settings.public_base_url else ""
    )
    recipients = resolve_recipients(
        static_to, settings.subscribe_api_url, settings.subscribe_api_token,
        fallback_url=fallback_list_url,
    )
    needs_send = not (args.check or args.preview)
    if needs_send:
        if not recipients:
            log.error("收件人为空：请在 .env 填写 MAIL_TO，或在 CI 配置同名 Secret")
            return 2
        warn = settings.mail_preflight()
        if warn:
            log.error("发信配置不完整：%s", warn)
            return 2

    # --- 第一轮：只抓列表页 -------------------------------------------------
    log.info("开始探测，共 %s 个数据源", len(sources))
    meta = collect_meta(sources)
    log.info("列表页共 %s 条", len(meta))
    if not meta:
        # 官网改版 / 全站不可达时必须让 CI 变红，不能伪装成「无新公告」
        log.error("列表页 0 条：疑似官网改版或抓取全部失败，请检查数据源与解析器")
        return 1

    state_path = args.state or os.path.join(ROOT, cfg.get("state_file", "data/seen.json"))
    state = State(state_path, keep=int(cfg.get("state_keep", 800)))
    if state.corrupt:
        log.error("状态文件损坏，已中止（避免误判首次运行而群发基线邮件）")
        return 2
    first_run = state.is_first_run

    changed_uids = set()
    candidates: List[Notice] = []
    for n in meta:
        kind = "new" if first_run else state.classify(n)
        if kind in ("new", "changed"):
            n.change_kind = kind
            candidates.append(n)
            if kind == "changed":
                changed_uids.add(n.uid)

    # --- 每日一次详情抽检：发现同一文章 ID 下的正文 / 附件修订 ---------------
    today = date.today().isoformat()
    full_check = bool(
        not first_run and not args.check and not args.preview
        and state.last_detail_check() != today
    )
    check_uids: set = set()
    if full_check:
        limit = max(1, int(cfg.get("full_check_limit", 30)))
        seen = [n for n in meta if state.classify(n) == "same"]
        check_uids = {n.uid for n in sorted(seen, key=lambda x: x.date_text, reverse=True)[:limit]}
        log.info("每日详情抽检 %s 条（用于发现正文 / 附件更新）", len(check_uids))

    # --- 第二轮：只抓候选 + 抽检条目的详情页 --------------------------------
    wanted = {n.uid for n in candidates} | check_uids
    detailed: List[Notice] = []
    if wanted:
        log.info("开始抓详情：候选 %s 条 + 抽检 %s 条", len(candidates), len(check_uids))
        detailed = collect(enrich_only(build_sources(cfg), wanted))
    detail_by_uid = {n.uid: n for n in detailed}

    merged: Dict[str, Notice] = {}
    for n in candidates:
        d = detail_by_uid.get(n.uid)
        if d:
            d.change_kind = n.change_kind
            merged[n.uid] = d
        else:
            merged[n.uid] = n

    for uid in check_uids:
        d = detail_by_uid.get(uid)
        if d and state.detail_changed(d):
            d.change_kind = "changed"
            merged[uid] = d
            changed_uids.add(uid)
            log.info("检测到内容更新：%s", d.title)

    if detailed:
        state.record_detail_baseline(detailed)
    if full_check:
        state.touch_detail_check(today)

    if args.check:
        for n in sort_notices(list(merged.values()) or meta):
            flag = "【更新】" if n.change_kind == "changed" else ""
            log.info("%s | %-8s | %-14s | %s%s", n.date_text, n.category, n.source, flag, n.title)
        return 0

    # --- 归档 / RSS / 日历的数据同步 -----------------------------------------
    # 与「本轮有没有新公告」无关：首次升级要回填历史，官网补充 / 延期也要更新归档。
    # 用内容指纹限流，只有真的变了才写 Worker KV；失败只告警，绝不阻断邮件主流程。
    archive_changed = False
    if not args.dry_run and not args.preview:
        all_items = {n.uid: n for n in meta}
        for n in notices_from_state(state):
            all_items.setdefault(n.uid, n)
        payload = build_payload(list(all_items.values()), int(cfg.get("notices_limit", 200)))
        fp = payload_fingerprint(payload)
        if fp != state.published_hash and publish_notices(payload):
            state.set_published_hash(fp)
            archive_changed = True

    if not merged and not args.preview:
        # 没有新内容：只在抽检刷新过指纹或归档有更新时才落盘，避免每 10 分钟产生一次 git 提交
        if full_check or archive_changed:
            state.save()
        else:
            log.info("无新公告，结束（未抓取详情页推送）")
        return 0

    fresh = sort_notices(list(merged.values()))
    if first_run and cfg.get("on_first_run", "baseline") == "baseline":
        fresh = fresh[: int(cfg.get("baseline_size", 8))]
        log.info("首次运行，建立基线（%s 条），本轮推送最近 %s 条", len(meta), len(fresh))

    if args.preview:
        preview_email = (split_recipients(static_to) or [""])[0]
        preview_unsub = build_unsubscribe_url(settings.unsub_url, settings.unsub_secret, preview_email)
        body = build_html(
            (fresh or meta)[:30], site=settings.site_name, unsubscribe_url=preview_unsub,
        )
        with open(args.preview, "w", encoding="utf-8") as fh:
            fh.write(body)
        log.info("预览已写入 %s", args.preview)
        return 0

    if not fresh:
        log.info("没有新通知，本轮不发信")
        return 0

    log.info("本轮待推 %s 条（新增 %s / 更新 %s）", len(fresh), len(fresh) - len(changed_uids), len(changed_uids))
    for n in fresh:
        log.info("  %s %s | %s", "【更新】" if n.change_kind == "changed" else "+", n.date_text, n.title)

    if args.dry_run:
        sample = build_unsubscribe_url(
            settings.unsub_url, settings.unsub_secret, recipients[0].email
        )
        print(build_text(fresh, site=settings.site_name, unsubscribe_url=sample))
        log.info("dry-run 结束，未发信、未更新状态")
        return 0

    # --- 发信编排：即时 / 日报 / 周报 / 暂停 --------------------------------
    pending_path = os.path.join(ROOT, "data/pending.json")
    result = dispatch(
        sender=sender, notices=fresh, recipients=recipients, cfg=cfg,
        pending_path=pending_path,
    )
    log.info(
        "完成：%s 条通知 × %s 个收件人，成功发出 %s 封，摘要 %s",
        len(fresh), len(recipients), result.sent, result.digest_sent or "无",
    )

    if result.failed:
        # 关键事务边界：有即时收件人失败就不写 seen，下一轮会重发
        log.error("以下收件人发送失败（本轮不标记已读，下轮重试）：%s", ", ".join(result.failed))
        state.save()  # 只保存抽检指纹 / 归档指纹，不保存 mark
        return 1

    # 首次运行要把未推送的历史条目也标为已读；尽量用抓过详情的版本存指纹
    if first_run:
        all_marked = dict(merged)
        for n in meta:
            all_marked.setdefault(n.uid, n)
        state.mark(list(all_marked.values()))
    else:
        state.mark(fresh)
    state.save()
    return 0


if __name__ == "__main__":
    sys.exit(main())
