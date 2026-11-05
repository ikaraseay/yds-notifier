"""命令行入口。

用法：
    python -m yds --check              # 只抓取并打印，不写状态、不发信（排查解析用）
    python -m yds --dry-run            # 完整流程，但邮件不真正发送（写状态可选）
    python -m yds                      # 正常运行：抓取 -> 对比 -> 发信 -> 更新 data/seen.json
    python -m yds --preview out.html   # 把最近抓到的通知渲染成本地 HTML 预览
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from typing import Dict, List

import yaml

from . import fetch  # noqa: F401  (提前初始化 session)
from .config import settings
from .mailer import build_html, build_subject, build_text, sort_notices
from .models import Notice
from .senders import build_client
from .recipients import resolve_recipients, split_recipients
from .sources import BaseSource, build_sources
from .state import State
from .unsub import build_list_unsubscribe_headers, build_unsubscribe_url

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
                if item is None:  # enrich_only 过滤掉的非候选条目
                    continue
            prev = merged.get(item.uid)
            if prev is None:
                merged[item.uid] = item
            else:
                # 同一通知多源出现时，保留附件更全的那份，并拼接来源
                if len(item.attachments) > len(prev.attachments):
                    item.source = f"{prev.source} / {item.source}"
                    merged[item.uid] = item
    return list(merged.values())


def collect_meta(sources: List[BaseSource]) -> List[Notice]:
    """只抓列表页，不抓详情页。

    高频轮询（每 10 分钟）用这个：研创网列表页本身带标题、日期和文章 id，
    一次请求 0.3 秒即可判断有没有新公告，对源站压力极小。
    """
    return collect(sources, enrich=False)


def enrich_only(sources: List[BaseSource], wanted: set) -> List[BaseSource]:
    """包一层：让数据源只对候选 uid 抓详情页，其余条目直接丢弃。"""
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
    parser.add_argument("--dry-run", action="store_true", help="不真正发信")
    parser.add_argument("--preview", metavar="FILE", help="导出一份 HTML 预览")
    parser.add_argument("--max-notify", type=int, default=0, help="单封邮件的最大条目数（默认取 config.yaml）")
    parser.add_argument("--to", default="", help="临时覆盖收件人，测试时用")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    cfg = load_config(args.config)
    sources = build_sources(cfg)
    if not sources:
        log.error("没有启用任何数据源，请检查 %s", args.config)
        return 2

    # --- 第一轮：只抓列表页，快速判断有没有新公告 -------------------------
    # 发信配置预检放在最前面：高频轮询下配置错了要立刻暴露，
    # 而不是抓完详情、写完状态才发现发不出去
    sender = build_client(cfg.get("mail") or {})
    static_to = args.to or settings.mail_to
    recipients = resolve_recipients(
        static_to,
        settings.subscribe_api_url,
        settings.subscribe_api_token,
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

    log.info("开始探测，共 %s 个数据源", len(sources))
    meta = collect_meta(sources)
    log.info("列表页共 %s 条", len(meta))

    state_path = args.state or os.path.join(ROOT, cfg.get("state_file", "data/seen.json"))
    state = State(state_path, keep=int(cfg.get("state_keep", 800)))
    first_run = state.is_first_run

    if first_run:
        pending = meta
    else:
        pending = [n for n in meta if not state.has(n)]

    # 没有新内容就立即退出：高频轮询下 99% 的运行都走这条路径，省时间也省源站带宽
    if not pending and not args.check:
        log.info("无新公告，结束（未抓取详情页）")
        return 0

    # --- 第二轮：只对候选条目抓详情页，补摘要与附件 -----------------------
    log.info("发现 %s 条候选，开始抓详情", len(pending))
    notices = collect(enrich_only(sources, {n.uid for n in pending}))
    if len(notices) < len(pending):
        log.warning("详情抓取覆盖 %s/%s 条，缺失的仍会按列表页信息推送", len(notices), len(pending))

    if args.check:
        for n in sort_notices(notices):
            log.info("%s | %-8s | %-14s | %s", n.date_text, n.category, n.source, n.title)
            if n.attachments:
                for a in n.attachments:
                    log.info("      附件: %s", a.name)
        return 0

    if first_run and cfg.get("on_first_run", "baseline") == "baseline":
        # 首次运行：把现存通知全部记为已读，只发一封汇总，避免一次涌入上百封
        latest = sort_notices(notices)[: int(cfg.get("baseline_size", 8))]
        state.mark(meta)
        state.save()
        log.info("首次运行，已建立基线（%s 条），本轮推送最近 %s 条", len(meta), len(latest))
        fresh = latest
        subject_prefix = cfg.get("subject_prefix", "【研电赛】") + "首次订阅确认"
    else:
        fresh = sort_notices(notices)
        subject_prefix = cfg.get("subject_prefix", "【研电赛】") + "新通知"

    if args.preview:
        preview_email = (split_recipients(static_to) or [""])[0]
        preview_unsub = build_unsubscribe_url(
            settings.unsub_url, settings.unsub_secret, preview_email
        )
        body = build_html(
            sort_notices(notices)[:30],
            site=settings.site_name,
            unsubscribe_url=preview_unsub,
        )
        with open(args.preview, "w", encoding="utf-8") as fh:
            fh.write(body)
        log.info("预览已写入 %s", args.preview)
        # 预览只是渲染样张，不应继续走发信与状态写入
        return 0

    if not fresh:
        log.info("没有新通知，本轮不发信")
        return 0

    log.info("发现 %s 条新通知", len(fresh))
    for n in fresh:
        log.info("  + %s | %s", n.date_text, n.title)

    site = settings.site_name
    repo_url = settings.repo_url
    issue_url = f"{repo_url}/issues" if repo_url else ""

    # 退订链接按收件人单独签发；没有配置就干脆不出现退订按钮，
    # 不降级成「全局停用」或「无签名链接」（见安全评审报告 S-02）
    unsub_base = settings.unsub_url
    unsub_secret = settings.unsub_secret
    unsub_ready = bool(unsub_base and unsub_secret)
    if not unsub_ready:
        log.warning("未配置 UNSUB_SECRET 或对外域名（CUSTOM_DOMAIN / WORKERS_DEV_URL），邮件里不会出现退订按钮")

    # 分批发信，单封不超过 max-notify
    max_notify = max(1, args.max_notify or int(cfg.get("max_notify", 25)))
    batches = [fresh[i : i + max_notify] for i in range(0, len(fresh), max_notify)]
    log.info("发信通道：%s（%s）", sender.provider, sender.from_header)

    if args.dry_run:
        for idx, batch in enumerate(batches, 1):
            suffix = f"（{idx}/{len(batches)}）" if len(batches) > 1 else ""
            subject = build_subject(batch, subject_prefix) + suffix
            for rcpt in recipients:
                mine = [n for n in batch if rcpt.wants(n.category)]
                log.info(
                    "[dry-run] 将发送：%s -> %s（%s 条，原 %s 条）",
                    subject, rcpt.email, len(mine), len(batch),
                )
        sample_unsub = (
            build_unsubscribe_url(unsub_base, unsub_secret, recipients[0].email)
            if unsub_ready else ""
        )
        if sample_unsub:
            log.info("[dry-run] 退订链接示例：%s", sample_unsub)
        print(build_text(fresh, site=site, unsubscribe_url=sample_unsub))
        log.info("dry-run 结束，未发信、未更新状态")
        return 0

    ok = 0
    failed: List[str] = []
    for idx, batch in enumerate(batches, 1):
        suffix = f"（{idx}/{len(batches)}）" if len(batches) > 1 else ""
        subject = build_subject(batch, subject_prefix) + suffix
        # 每封邮件独立渲染：收件人不同，退订链接必须绑定到具体邮箱
        for rcpt in recipients:
            # 按收件人勾选的栏目过滤：只发他关心的分类
            mine = [n for n in batch if rcpt.wants(n.category)]
            if not mine:
                log.info("%s 本轮通知不符合其栏目偏好，跳过", rcpt.email)
                continue
            unsub_for = (
                build_unsubscribe_url(unsub_base, unsub_secret, rcpt.email)
                if unsub_ready else ""
            )
            html_body = build_html(
                mine, site=site, repo_url=repo_url,
                unsubscribe_url=unsub_for, issue_url=issue_url,
            )
            text_body = build_text(mine, site=site, unsubscribe_url=unsub_for)
            try:
                sender.send(
                    [rcpt.email], subject, text_body, html_body,
                    build_list_unsubscribe_headers(unsub_for),
                )
                ok += 1
            except Exception as exc:  # noqa: BLE001 - 单个收件人失败不阻断其他人
                log.error("发送给 %s 失败：%s", rcpt.email, exc)
                failed.append(rcpt.email)
        state.mark(batch)

    state.save()
    log.info("完成：%s 条通知 × %s 个收件人，成功 %s 次", len(fresh), len(recipients), ok)
    if failed:
        log.error("以下收件人发送失败：%s", ", ".join(failed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
