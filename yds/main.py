"""命令行入口。

用法：
    python -m yds --check              # 只抓取并打印，不写状态、不发信（排查解析用）
    python -m yds --dry-run            # 完整流程，但不发信、不写状态
    python -m yds                      # 抓取 -> 变更检测 -> 发信 -> 状态落盘
    python -m yds --preview out.html   # 把最近抓到的通知渲染成本地 HTML 预览
"""

from __future__ import annotations

import argparse
import atexit
import json
import logging
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from typing import Dict, List

import yaml

from . import fetch  # noqa: F401  (抓取统计 / 去重缓存由该模块统一维护)
from .ai.analyzer import analyze_notices
from .ai.body import backfill_bodies
from .ai.cache import AiCache
from .ai.client import AiConfig
from .config import settings
from .dispatch import dispatch
from .lock import RunLock
from .mailer import build_html, build_text, sort_notices
from .models import Notice
from .publish import (
    apply_analysis,
    build_payload,
    notices_from_state,
    payload_fingerprint,
    publish_notices,
)
from .personas import CONTEST_IDS
from .recipients import resolve_recipients, split_recipients, watched_contests
from .senders import build_client
from .schedule import (
    ReminderLog,
    ScheduleStore,
    find_schedule_notice,
    parse_schedule,
    schedule_year,
)
from .sources import BaseSource, build_sources
from .state import State
from .store import StateConflict, StateUnavailable, build_store
from .unsub import build_unsubscribe_url

log = logging.getLogger("yds")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")


def _push_state(store) -> None:
    """把本轮改过的状态写回对象存储。

    放在 atexit 里：main() 有十几个 return 分支（基线、追赶、无新内容、
    只有提醒……），逐个补 push 迟早漏一个，而漏掉就意味着下一轮重复发信。

    失败时落一个 `.state-push-failed` 标记：atexit 改不了退出码，
    由 CI 读这个文件把任务标红，避免"状态没写回但流水线是绿的"。
    """
    marker = os.path.join(DATA_DIR, ".state-push-failed")
    try:
        res = store.push(DATA_DIR)
        log.info(
            "状态已写回 R2：上传 %s 个，未变跳过 %s 个",
            len(res["uploaded"]), len(res["skipped"]),
        )
        if os.path.exists(marker):
            os.remove(marker)
    except StateConflict as exc:
        # 绝不覆盖别人的写入：宁可这轮状态滞后，也不能把对方的"已推送"标记冲掉
        log.error("状态写回冲突，保留远端版本（下一轮会重算）：%s", exc)
        _mark_push_failed(marker, f"conflict: {exc}")
    except Exception as exc:  # noqa: BLE001 - 写回失败不能影响已经发出的邮件
        log.error("状态写回 R2 失败，本轮状态可能滞后：%s", str(exc)[:200])
        _mark_push_failed(marker, str(exc)[:200])


def _mark_push_failed(path: str, reason: str) -> None:
    try:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(reason + "\n")
    except OSError:
        pass


def load_config(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def _load_zone_state(path: str) -> dict:
    """读取专区游标：offset 为下一轮起点，lastSweep 为最近一次全量扫描日期。"""
    try:
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh)
        return {
            "offset": max(0, int(raw.get("offset") or 0)),
            "lastSweep": str(raw.get("lastSweep") or ""),
        }
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return {"offset": 0, "lastSweep": ""}


def _save_zone_state(path: str, offset: int, last_sweep: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(
            {"version": 1, "offset": offset, "lastSweep": last_sweep},
            fh, ensure_ascii=False,
        )
        fh.write("\n")
    os.replace(tmp, path)


def collect(sources: List[BaseSource], enrich: bool = True, workers: int = 0) -> List[Notice]:
    """抓取所有数据源，并按 uid 去重合并（多源可能报同一件事）。

    列表页与详情页都并发抓取：单轮 40 个请求串行要 37 秒，并发后降到 10 秒内。
    真正的限流在 `fetch` 层——同一主机最多 2 个在途请求，相同 URL 只抓一次，
    所以「变快」不会变成「给官网加压」。
    """
    pool = workers or max(2, min(6, int(os.environ.get("YDS_WORKERS", "6") or 6)))

    def safe_fetch(src: BaseSource) -> List[Notice]:
        try:
            return src.fetch()
        except Exception as exc:  # noqa: BLE001 - 单源失败不影响其他源
            log.error("[%s] 抓取整体失败：%s", src.name, exc)
            return []

    with ThreadPoolExecutor(max_workers=pool) as pool_ex:
        per_source = list(pool_ex.map(safe_fetch, sources))

        # 详情页是耗时大头（30 条 ≈ 27 秒），同样并发；`enrich_only` 已把
        # 不需要的条目过滤成 None，这里只处理真正要抓的那批。
        if enrich:
            tasks = [(src, item) for src, items in zip(sources, per_source) for item in items]
            enriched = list(pool_ex.map(lambda t: _safe_enrich(*t), tasks))
        else:
            enriched = [item for items in per_source for item in items]

    merged: Dict[str, Notice] = {}
    for item in enriched:
        if item is None:
            continue
        prev = merged.get(item.uid)
        if prev is None:
            merged[item.uid] = item
        elif len(item.attachments) > len(prev.attachments):
            item.source = f"{prev.source} / {item.source}"
            merged[item.uid] = item
    # 同一内容可能同时出现在「大赛通知」与「大赛文件」，按标题去重，
    # 保留附件 / 正文更完整的那条，避免同一件事发两遍。
    deduped: Dict[str, Notice] = {}
    for item in sorted(
        merged.values(),
        key=lambda x: (len(x.attachments), len(x.summary), len(x.raw_body)),
        reverse=True,
    ):
        deduped.setdefault(re.sub(r"\s+", "", item.title), item)
    return list(deduped.values())


def _safe_enrich(src: BaseSource, item: Notice):
    """单个详情页失败只丢这一条，不能让整轮抓取挂掉。"""
    try:
        return src.enrich(item)
    except Exception as exc:  # noqa: BLE001
        log.warning("[%s] 详情页处理失败 %s: %s", src.name, item.url, exc)
        return item


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
    parser.add_argument(
        "--backfill", action="store_true",
        help="只抓取并同步归档 / 日历数据，不发信、不标记已读（补齐历史用）",
    )
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
    fetch.reset_stats()

    # 只有会读-改-写状态的运行才需要独占：--check / --preview 是只读的，
    # --dry-run 也不落盘。其余模式（定时任务、--backfill）互相排斥，
    # 否则后写者会覆盖前者的 seen.json，导致下一轮重复发信。
    writes_state = not (args.check or args.preview or args.dry_run)
    run_lock = RunLock(os.path.join(ROOT, "data/.run.lock"))
    if writes_state and not run_lock.acquire():
        log.error("已有一个实例在运行（data/.run.lock 被占用），本轮跳过以免重复发信 / 覆盖状态")
        return 2

    # 状态后端：配置了 R2 就把 data/*.json 从对象存储拉下来（远端是唯一事实源），
    # 结束时由 atexit 统一写回。未配置时完全走本地文件，行为与改造前一致。
    store = build_store(settings)
    if store:
        try:
            pulled = store.pull(DATA_DIR)
        except StateUnavailable as exc:
            # 关键：本地 data/*.json 可能只是仓库里的陈旧副本。拿它当基线会把
            # 这些天推过的通知重新发一遍，所以配了 R2 却读不到就必须停。
            log.error("状态后端不可用，已中止（避免用陈旧状态重复群发）：%s", exc)
            return 2
        log.info(
            "状态后端：R2 %s/%s，拉取 %s 个对象", settings.r2_bucket, settings.r2_prefix, pulled,
        )
        if writes_state:
            atexit.register(_push_state, store)

    sender = build_client(cfg.get("mail") or {})
    static_to = args.to or settings.mail_to
    fallback_list_url = (
        f"{settings.public_base_url.rstrip('/')}/api/list" if settings.public_base_url else ""
    )
    recipients = resolve_recipients(
        static_to, settings.subscribe_api_url, settings.subscribe_api_token,
        fallback_url=fallback_list_url,
        personas=cfg.get("personas") or [],
    )

    # 赛事专区抓取范围 = 所有订阅者关注赛事的并集；没人限制时按 per_run 轮询。
    watched = watched_contests(recipients)
    zone_cfg = next(
        (s for s in (cfg.get("sources") or []) if s.get("key") == "cpipc_zones" and s.get("enabled", True)),
        {},
    )
    zone_all = [str(c) for c in (zone_cfg.get("contests") or []) if CONTEST_IDS.get(str(c))]
    zone_per_run = max(1, int(zone_cfg.get("per_run", 4)))
    zone_state_path = os.path.join(ROOT, "data/zones.json")
    zone_state = _load_zone_state(zone_state_path)
    zone_offset = zone_state["offset"] % len(zone_all) if zone_all else 0

    # 轮询保证「每轮只看 4 项」，但要靠好几轮才能覆盖 19 项；
    # 一旦 CI 被 GitHub 节流（实际常是几小时才跑一次），归档会长期缺赛事。
    # 因此每 sweep_days 天强制全量扫一遍，一次补齐所有专区。
    sweep_days = max(1, int(zone_cfg.get("sweep_days", 1)))
    today_iso = date.today().isoformat()
    sweep_due = (
        watched is None and bool(zone_all) and bool(zone_cfg)
        and (
            not zone_state["lastSweep"]
            or (date.today() - date.fromisoformat(zone_state["lastSweep"])).days >= sweep_days
        )
    )

    def make_sources():
        # 全量扫描：把 19 项赛事当作「全部关注」，per_run 自动等于总数、offset 归零
        if sweep_due:
            return build_sources(cfg, only_contests=set(zone_all), zone_offset=0)
        return build_sources(cfg, only_contests=watched, zone_offset=zone_offset)

    sources = make_sources()
    if not sources:
        log.error("没有启用任何数据源，请检查 %s", args.config)
        return 2
    if zone_cfg:
        if sweep_due:
            log.info("赛事专区：全量扫描 %s 项（上次全量：%s）", len(zone_all), zone_state["lastSweep"] or "从未")
        elif watched is None:
            log.info("赛事专区：无人限制赛事，按每轮 %s 项轮询（共 %s 项）", zone_per_run, len(zone_all))
        else:
            log.info("赛事专区：只抓订阅者关注的 %s 项赛事", len(watched or []))
    needs_send = not (args.check or args.preview or args.backfill)
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
    log.info("列表页共 %s 条（%s）", len(meta), fetch.stats_line())
    # 无人限制赛事时推进专区分片游标，保证几轮之后 19 项赛事都被扫过
    if zone_cfg and watched is None and zone_all:
        next_offset = 0 if sweep_due else (zone_offset + zone_per_run) % len(zone_all)
        next_sweep = today_iso if sweep_due else zone_state["lastSweep"]
        if not (args.check or args.preview or args.dry_run):
            _save_zone_state(zone_state_path, next_offset, next_sweep)
        log.info("赛事专区游标 %s → %s（下一轮从该位置继续）", zone_offset, next_offset)
    if not meta:
        # 官网改版 / 全站不可达时必须让 CI 变红，不能伪装成「无新公告」
        log.error("列表页 0 条：疑似官网改版或抓取全部失败，请检查数据源与解析器")
        return 1

    # --- 官方赛程：每周刷新一次，驱动日历与 T-30/T-7/T-3/T-1 提醒 ------------
    today_date = date.today()
    sched_cfg = cfg.get("schedule") or {}
    sched_enabled = bool(sched_cfg.get("enabled", True))
    sched_include = [str(x) for x in (sched_cfg.get("include") or [])]
    sched_horizons = [int(x) for x in (sched_cfg.get("horizons") or [30, 7, 3, 1])]
    schedule = ScheduleStore(os.path.join(ROOT, "data/schedule.json"))
    if sched_enabled and (schedule.empty or schedule.stale(int(sched_cfg.get("refresh_days", 7)))):
        target = find_schedule_notice(meta)
        if target:
            rows = []
            try:
                rows = parse_schedule(
                    fetch.get_text(target.url), schedule_year(target.title, today_date.year), target.url
                )
            except Exception as exc:  # noqa: BLE001 - 赛程失败不能影响通知主流程
                log.warning("赛程表解析失败，沿用旧缓存：%s", str(exc)[:160])
            if rows:
                schedule.replace(rows, schedule_year(target.title, today_date.year), target.url)
                if not args.check and not args.preview:
                    schedule.save()
                log.info("赛程表已更新：%s 项赛事（%s 年度）", len(rows), schedule.year)
        else:
            log.info("本轮列表中没有「赛程一览」，跳过刷新（沿用缓存 %s 项）", len(schedule.contests))

    reminder_pool = (
        schedule.reminders(today_date, sched_horizons, sched_include)
        if sched_enabled else []
    )
    rem_log = ReminderLog(os.path.join(ROOT, "data/reminders.json"))
    reminders = rem_log.pending(reminder_pool, today_date)

    state_path = args.state or os.path.join(ROOT, cfg.get("state_file", "data/seen.json"))
    state = State(state_path, keep=int(cfg.get("state_keep", 800)))
    if state.corrupt:
        log.error("状态文件损坏，已中止（避免误判首次运行而群发基线邮件）")
        return 2
    first_run = state.is_first_run

    changed_uids = set()
    candidates: List[Notice] = []
    # 扩充数据源后，专区里的上年旧通知会被当成「新条目」。
    # 超过 push_max_age_days 的只归档、不推送，避免首次升级群发陈年旧文。
    max_age = max(7, int(cfg.get("push_max_age_days", cfg.get("max_age_days", 60))))
    cutoff = today_date - timedelta(days=max_age)
    stale_skipped = 0
    for n in meta:
        kind = "new" if first_run else state.classify(n)
        if kind == "new" and n.published and n.published < cutoff:
            stale_skipped += 1
            continue
        if kind in ("new", "changed"):
            n.change_kind = kind
            candidates.append(n)
            if kind == "changed":
                changed_uids.add(n.uid)
    if stale_skipped:
        log.info("跳过 %s 条超过 %s 天的历史条目（仍会归档，不推送）", stale_skipped, max_age)

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
        detailed = collect(enrich_only(make_sources(), wanted))
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
            log.info("%s | %-8s | %-6s | %-12s | %s%s",
                     n.date_text, n.category, n.stage,
                     "/".join(n.audiences) or "-", flag, n.title)
        if reminders:
            log.info("--- 日程提醒（今日应发 %s 条）---", len(reminders))
            for n in reminders:
                log.info("%s | %s | %s", n.deadline, n.stage, n.title)
        return 0

    # --- 归档全集：列表页 + 本轮详情 + 历史重建 -------------------------------
    # detailed 带未截断正文，是 AI 判断真实事件日期的关键输入；历史条目则从
    # seen.json 重建，并靠 ai.json 缓存补回分析结果与正文。
    ai_cache = AiCache(os.path.join(ROOT, "data/ai.json"), keep=int(cfg.get("state_keep", 800)))
    all_items = {n.uid: n for n in meta}
    for n in detailed:
        all_items[n.uid] = n
    for n in notices_from_state(state, ai_cache):
        all_items.setdefault(n.uid, n)

    # --- AI 分析：批量 + 指纹缓存 + 渐进式历史回填 ----------------------------
    # 收敛后（所有 uid 都有缓存）无新公告时零 API 调用；提示词升版全量重算。
    if not args.dry_run and not args.preview:
        ai_cfg = AiConfig(
            enabled=settings.ai_enabled,
            api_key=settings.ai_api_key,
            base_url=settings.ai_base_url,
            model=settings.ai_model,
            thinking=settings.ai_thinking,
            temperature=settings.ai_temperature,
            max_tokens=settings.ai_max_tokens,
            timeout=settings.ai_timeout,
            batch_size=settings.ai_batch_size,
            max_body_chars=settings.ai_max_body_chars,
            prompt_version="",  # 实际版本由 prompts/manifest.yaml 的 active 决定
        )
        ai_inputs = [
            {
                "uid": n.uid,
                "title": n.title,
                "published": n.date_text if n.published else "",
                "url": n.url,
                "source": n.source,
                "category": n.category,
                "summary": n.summary,
                "body": n.raw_body or ai_cache.body_of(n.uid),
                "list_hash": n.list_hash,
                "detail_hash": n.detail_hash,
            }
            for n in all_items.values()
        ]
        # 只为「缓存也没有结果」的历史条目抓正文，每轮限量，收敛后不再请求官网
        hosts = sorted({
            h for s in (cfg.get("sources") or [])
            for h in (s.get("allowed_hosts") or [])
        })
        # body 构建时已尝试从缓存读回；仍为空才需要抓详情页。
        # 抓到的正文立刻入缓存，因此 AI 关闭 / 调用失败时也不会每 10 分钟重复抓官网。
        need = [i for i in ai_inputs if not i["body"]]
        got = backfill_bodies(
            need, hosts,
            max(0, int(cfg.get("ai_backfill_limit", 12))),
            settings.ai_max_body_chars,
        )
        if got:
            log.info("历史正文回填 %s 条", got)
        for i in ai_inputs:
            if i["body"]:
                ai_cache.put_body(i["uid"], i["body"])
        ai_result = analyze_notices(ai_inputs, ai_cfg, ai_cache)
        by_uid = {i["uid"]: i for i in ai_inputs}
        for n in all_items.values():
            # 本轮抓过详情的对象也要带上刚回填的正文，供规则降级抽日期
            match = by_uid.get(n.uid)
            if match and match["body"] and not n.raw_body:
                n.raw_body = match["body"]
            apply_analysis(n, ai_result.analyses.get(n.uid))
        ai_cache.prune()
        ai_cache.save()

    # --- 归档 / RSS / 日历的数据同步 -----------------------------------------
    # 与「本轮有没有新公告」无关：首次升级要回填历史，官网补充 / 延期也要更新归档。
    # 用内容指纹限流，只有真的变了才写 Worker KV；失败只告警，绝不阻断邮件主流程。
    archive_changed = False
    if not args.dry_run and not args.preview:
        payload = build_payload(
            list(all_items.values()),
            int(cfg.get("notices_limit", 200)),
            schedule=schedule.payload(sched_include) if sched_enabled else None,
        )
        fp = payload_fingerprint(payload)
        if fp != state.published_hash and publish_notices(payload):
            state.set_published_hash(fp)
            archive_changed = True

    if args.backfill:
        # 只补归档 / 日历数据：不写 seen（否则 CI 下一轮就不发邮件了）、不发信
        count = len(payload.get("notices", [])) if not args.dry_run else 0
        if not args.dry_run:
            state.save()
        log.info("backfill 完成：归档同步 %s 条，未发信、未标记已读", count)
        return 0

    if not merged and not args.preview and not reminders:
        # 没有新内容：只在抽检刷新过指纹或归档有更新时才落盘，避免每 10 分钟产生一次 git 提交
        if full_check or archive_changed:
            state.save()
        else:
            log.info("无新公告，结束（未抓取详情页推送）")
        return 0

    fresh = sort_notices(list(merged.values()))
    # 时间节点全部过去的通知不再写进邮件（含本轮新抓到的旧公告）。
    # 仍要标已读，否则每轮都会被当成「新通知」重复处理。
    expired = [n for n in fresh if n.is_expired]
    if expired:
        log.info("跳过 %s 条已结束的通知（时间节点均已过去）", len(expired))
        state.mark(expired)
        fresh = [n for n in fresh if not n.is_expired]
    catchup_dropped = 0
    if first_run and cfg.get("on_first_run", "baseline") == "baseline":
        fresh = fresh[: int(cfg.get("baseline_size", 8))]
        log.info("首次运行，建立基线（%s 条），本轮推送最近 %s 条", len(meta), len(fresh))
    elif len(fresh) > int(cfg.get("catchup_threshold", 15)):
        # 扩充数据源 / 长时间停摆后，单轮会出现几十条「新条目」。
        # 一次性全发既吵又容易进垃圾箱：只推最近 N 条，其余静默归档。
        size = max(1, int(cfg.get("catchup_size", 8)))
        catchup_dropped = max(0, len(fresh) - size)
        log.info(
            "单轮新增 %s 条超过阈值 %s，按追赶模式只推最近 %s 条，其余 %s 条静默归档",
            len(fresh), cfg.get("catchup_threshold", 15), size, catchup_dropped,
        )
        fresh = fresh[:size]

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

    if not fresh and not reminders:
        if expired:
            # 全部过期时也要落盘「已读」，否则下一轮会把它们再当初次发现
            state.save()
        log.info("没有新通知，本轮不发信")
        return 0

    log.info("本轮待推 %s 条（新增 %s / 更新 %s），日程提醒 %s 条",
             len(fresh), len(fresh) - len(changed_uids), len(changed_uids), len(reminders))
    for n in fresh:
        log.info("  %s %s | %s", "【更新】" if n.change_kind == "changed" else "+", n.date_text, n.title)

    if args.dry_run:
        sample = build_unsubscribe_url(
            settings.unsub_url, settings.unsub_secret, recipients[0].email
        )
        print(build_text(fresh, site=settings.site_name, unsubscribe_url=sample))
        if reminders:
            print("\n===== 日程提醒（独立一封）=====")
            print(build_text(reminders, site=settings.site_name, unsubscribe_url=sample))
        log.info("dry-run 结束，未发信、未更新状态")
        return 0

    # --- 发信编排：即时 / 日报 / 周报 / 暂停 --------------------------------
    pending_path = os.path.join(ROOT, "data/pending.json")
    result = dispatch(
        sender=sender, notices=fresh, recipients=recipients, cfg=cfg,
        pending_path=pending_path, reminders=reminders,
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

    # 提醒是时点性的：发送成功才记账，失败下轮重试
    if reminders:
        rem_log.mark(reminders, today_date)
        rem_log.prune(today_date)
        rem_log.save()
        log.info("已记录 %s 条日程提醒，避免重复发送", len(reminders))

    # 首次运行要把未推送的历史条目也标为已读；尽量用抓过详情的版本存指纹
    if first_run:
        all_marked = dict(merged)
        for n in meta:
            all_marked.setdefault(n.uid, n)
        state.mark(list(all_marked.values()))
    elif catchup_dropped:
        # 追赶模式：未推送的条目也要标已读，否则下一轮会继续补发，形成连续轰炸
        state.mark(list(merged.values()))
    else:
        state.mark(fresh)
    state.save()
    return 0


if __name__ == "__main__":
    sys.exit(main())
