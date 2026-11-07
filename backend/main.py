"""命令行入口。

用法：
    python -m backend --check              # 只抓取并打印，不写状态、不发信（排查解析用）
    python -m backend --dry-run            # 完整流程，但不发信、不写状态
    python -m backend                      # 抓取 -> 变更检测 -> 发信 -> 状态落盘
    python -m backend --preview out.html   # 把最近抓到的通知渲染成本地 HTML 预览
"""

from __future__ import annotations

import argparse
import atexit
import logging
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from typing import Dict, List

import yaml

from . import fetch  # noqa: F401  (抓取统计 / 去重缓存由该模块统一维护)
from .ai.analyzer import analyze_notices
from .ai.body import backfill_bodies
from .ai.cache import AiCache
from .ai.client import AiConfig
from .config import settings
from .contests import plan as plan_contest_scan, save_state as save_contest_state
from .dispatch import dispatch
from .lock import RunLock
from .mailer import build_html, build_text, sort_notices
from .models import Notice, by_recency
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
from .store import STATE_FILES, StateConflict, StateUnavailable, build_store
from .unsub import build_unsubscribe_url

log = logging.getLogger("yds")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")

# 只读模式（--check / --dry-run / --preview）仍需要远端真实状态才能正确判断
# 「哪些是新通知」，但 pull() 会用 R2 对象覆盖本地 data/*.json。为了让
# `python -m backend --check` 不污染工作区，运行前把本地状态记在内存里，
# 退出时还原。放在 atexit 里，覆盖 main() 的所有提前 return 分支。
_LOCAL_STATE_BACKUP: Dict[str, bytes | None] = {}


def _snapshot_local_state() -> None:
    for name in STATE_FILES:
        try:
            with open(os.path.join(DATA_DIR, name), "rb") as fh:
                _LOCAL_STATE_BACKUP[name] = fh.read()
        except OSError:
            _LOCAL_STATE_BACKUP[name] = None


def _restore_local_state() -> None:
    if not _LOCAL_STATE_BACKUP:
        return
    for name, blob in _LOCAL_STATE_BACKUP.items():
        path = os.path.join(DATA_DIR, name)
        try:
            if blob is None:
                if os.path.exists(path):
                    os.remove(path)
            else:
                with open(path, "wb") as fh:
                    fh.write(blob)
        except OSError as exc:
            log.warning("只读模式恢复本地状态失败 %s：%s", name, exc)
    _LOCAL_STATE_BACKUP.clear()


def _ai_config() -> AiConfig:
    """AI 客户端配置，赛事状态判定与通知分析共用同一份。"""
    return AiConfig(
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
        prompt_version="",  # 实际版本由 backend/prompts/manifest.yaml 的 active 决定
    )


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
    """只抓列表页：先判断有没有变化，再决定是否抓详情。"""
    return collect(sources, enrich=False)


def pick_detail_checks(items: List[Notice], state, limit: int, today: date) -> List[str]:
    """挑出今天要复核详情页的条目：最近的、且最久没复核的优先。

    候选限于「已读、发布不超过 30 天」的条目（更早的正文修订意义很小）。
    排序为先按发布时间倒序、再按上次复核日期稳定升序（空串=从未复核排最前），
    这样抽检在一圈内覆盖全部近期条目，而不是每天重复同一批最近通知。
    """
    cutoff = today - timedelta(days=30)
    recent = [
        n for n in items
        if state.classify(n) == "same" and (not n.published or n.published >= cutoff)
    ]
    ordered = sorted(recent, key=lambda x: x.date_text, reverse=True)
    ordered.sort(key=lambda x: state.detail_checked_at(x.uid))
    return [n.uid for n in ordered[:limit]]


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
    parser.add_argument("--config", default=os.path.join(ROOT, "config/config.yaml"))
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
    # .env 由 config 模块加载；fetch 在它之前就已 import，这里补读一次，
    # 保证本地运行时 RESPECT_ROBOTS / CRAWLER_UA 也能生效（CI 直接注入则等价）。
    fetch.configure_from_env()
    fetch.reset_stats()
    ai_cfg = _ai_config()

    # 只读模式不写状态、不占运行锁；其余模式（定时任务、--backfill）互斥，
    # 否则后写者会覆盖前者的 seen.json。
    read_only = bool(args.check or args.preview or args.dry_run)
    writes_state = not read_only
    run_lock = RunLock(os.path.join(ROOT, "data/.run.lock"))
    if writes_state and not run_lock.acquire():
        log.error("已有一个实例在运行（data/.run.lock 被占用），本轮跳过以免重复发信 / 覆盖状态")
        return 2

    # 状态后端：R2 是唯一事实源，运行前把状态对象拉到本地，运行后由 atexit 写回。
    # 只读模式只用远端状态做判定，退出时还原本地 data/*.json。
    store = build_store(settings)
    if store:
        if read_only:
            _snapshot_local_state()
            atexit.register(_restore_local_state)
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

    # 赛事专区抓取范围 = 所有订阅者关注赛事的并集 ∩ 本轮该扫的赛事。
    # AI 判定为「已结束」的赛事默认 14 天才扫一次，进行中的每轮都扫。
    watched = watched_contests(recipients)
    zone_cfg = next(
        (s for s in (cfg.get("sources") or []) if s.get("key") == "cpipc_zones" and s.get("enabled", True)),
        {},
    )
    zone_all = [str(c) for c in (zone_cfg.get("contests") or []) if CONTEST_IDS.get(str(c))]
    candidates = sorted(set(zone_all) if watched is None else set(watched or []))
    scan = plan_contest_scan(
        data_dir=DATA_DIR,
        contests=candidates,
        cfg=cfg.get("contest_status") or {},
        today=date.today(),
        ai_cfg=ai_cfg,
    )
    log.info(
        "赛事状态：共 %s 项，本轮扫 %s 项（AI 判定 %s 项 / 已结束 %s 项，其中 %s 项到期复扫%s）",
        len(candidates), len(scan.selection), scan.classified, scan.ended,
        scan.due_ended, " / AI 不可用" if scan.ai_failed else "",
    )
    zone_selection = set(scan.selection)

    # 每天两轮（北京时间 10:00 / 20:00）。第一轮扫全部源；第二轮只扫高变化源
    # （runs: twice），年度通知 / 大赛文件 / 学会公告这类栏目一天最多一条，
    # 抓两遍只是重复请求。GitHub 的 schedule 常延后 1–3 小时，所以 18:00 前
    # 都按第一轮处理；只读模式与 --backfill 一律按第一轮跑，方便人工补齐数据。
    first_pass = read_only or bool(args.backfill) or datetime.now().hour < 18

    def make_sources():
        # 详情抓取阶段重建数据源时必须复用同一份赛事选择，避免扫到本轮跳过的专区
        return build_sources(cfg, only_contests=zone_selection, first_pass=first_pass)

    sources = make_sources()
    if not sources:
        log.error("没有启用任何数据源，请检查 %s", args.config)
        return 2
    if not first_pass:
        log.info("本轮为当天第二轮：只抓高变化源（runs: twice），年度栏目 / 学会公告留到明早")
    if zone_cfg:
        if watched is None:
            log.info("赛事专区：每轮扫描 %s / %s 项（进行中每天扫，已结束按 14 天复扫）",
                     len(zone_selection), len(zone_all))
        else:
            log.info("赛事专区：订阅者关注 %s 项，本轮扫描 %s 项", len(watched or []), len(zone_selection))
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
    robots_note = fetch.robots_summary()
    if robots_note:
        log.warning("%s（RESPECT_ROBOTS=%s）", robots_note, fetch.RESPECT_ROBOTS)
    if not meta:
        # 官网改版 / 全站不可达时必须让 CI 变红，不能伪装成「无新公告」
        log.error("列表页 0 条：疑似官网改版或抓取全部失败，请检查数据源与解析器")
        return 1
    # 抓取成功才记账：否则本轮没扫到的「已结束赛事」会被误记为已扫、白等 14 天
    if writes_state and not args.backfill:
        save_contest_state(os.path.join(DATA_DIR, "zones.json"), scan.state)

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
                    if writes_state:
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
    max_age = max(7, int(cfg.get("push_max_age_days", 14)))
    cutoff = today_date - timedelta(days=max_age)
    stale_skipped = 0
    stale_items: List[Notice] = []
    stale_marked = False
    for n in meta:
        kind = "new" if first_run else state.classify(n)
        if kind == "new" and n.published and n.published < cutoff:
            stale_skipped += 1
            stale_items.append(n)
            continue
        if kind in ("new", "changed"):
            n.change_kind = kind
            candidates.append(n)
            if kind == "changed":
                changed_uids.add(n.uid)
    if stale_skipped:
        log.info("跳过 %s 条超过 %s 天的历史条目（仍会归档，不推送）", stale_skipped, max_age)
        if writes_state and stale_items:
            # 超龄条目也标已读：不标的话每轮都会重新判一遍「新增后被跳过」，
            # 而且未来一旦放宽 push_max_age_days，这些条目会瞬间涌入邮件。
            state.mark(stale_items)
            stale_marked = True

    # --- 每日一次详情抽检：发现同一文章 ID 下的正文 / 附件修订 ---------------
    today = date.today().isoformat()
    full_check = bool(
        writes_state and not first_run
        and state.last_detail_check() != today
    )
    check_uids: set = set()
    if full_check:
        limit = max(1, int(cfg.get("full_check_limit", 12)))
        check_uids = set(pick_detail_checks(meta, state, limit, date.today()))
        log.info("每日详情抽检 %s 条（按上次复核时间轮转，用于发现正文 / 附件更新）", len(check_uids))

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
        state.record_detail_baseline(detailed, today)
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
        # 抓到的正文立刻入缓存，因此 AI 关闭 / 调用失败时也不会每轮重复抓官网。
        # 只在当天第一轮回填：历史正文不急于当天补完，第二轮再抓一遍纯属重复请求。
        need = [i for i in ai_inputs if not i["body"]]
        got = backfill_bodies(
            need, hosts,
            max(0, int(cfg.get("ai_backfill_limit", 12))) if first_pass else 0,
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
    payload_count = 0
    if not args.dry_run and not args.preview:
        payload = build_payload(
            list(all_items.values()),
            int(cfg.get("notices_limit", 200)),
            schedule=schedule.payload(sched_include) if sched_enabled else None,
        )
        payload_count = len(payload.get("notices", []))
        fp = payload_fingerprint(payload)
        if fp != state.published_hash and publish_notices(payload):
            state.set_published_hash(fp)
            archive_changed = True

    if args.backfill:
        # 只同步归档 / 日历：不调用 state.mark()（不新增已读记录），不发信。
        if writes_state:
            state.save()
        log.info("backfill 完成：归档同步 %s 条，未发信、未标记已读", payload_count)
        return 0

    if not merged and not args.preview and not reminders:
        # 没有新内容：只在抽检刷新过指纹 / 归档有更新 / 刚标了超龄条目时落盘
        if writes_state and (full_check or archive_changed or stale_marked):
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
    # 追赶 / 基线截断按「发布时间」挑最近 N 条，再按重要度排展示顺序。
    # 只按重要度截断会把陈年旧文（决赛、截止等高权重条目）顶进邮件——
    # 2026-11-06 的实发事故就是这么发生的。
    if first_run and cfg.get("on_first_run", "baseline") == "baseline":
        size = int(cfg.get("baseline_size", 8))
        fresh = sort_notices(by_recency(fresh)[:size])
        log.info("首次运行，建立基线（%s 条），本轮推送最近 %s 条", len(meta), len(fresh))
    elif len(fresh) > int(cfg.get("catchup_threshold", 10)):
        # 扩充数据源 / 长时间停摆后，单轮会出现几十条「新条目」。
        # 一次性全发既吵又容易进垃圾箱：只推最近 N 条（按发布时间），其余静默归档。
        size = max(1, int(cfg.get("catchup_size", 8)))
        catchup_dropped = max(0, len(fresh) - size)
        log.info(
            "单轮新增 %s 条超过阈值 %s，按追赶模式只推最近 %s 条（按发布时间），其余 %s 条静默归档",
            len(fresh), cfg.get("catchup_threshold", 10), size, catchup_dropped,
        )
        fresh = sort_notices(by_recency(fresh)[:size])

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
        if expired and writes_state:
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

    if result.instant_failed:
        # 关键事务边界：即时通知有收件人失败就不写 seen，下一轮整批重试
        log.error(
            "以下收件人的即时通知发送失败（本轮不标记已读，下轮重试）：%s",
            ", ".join(result.instant_failed),
        )
        state.save()  # 只保存抽检指纹 / 归档指纹，不保存 mark
        return 1

    other_failed = [e for e in result.failed if e not in result.instant_failed]
    if other_failed:
        # 紧急快报 / 日程提醒失败按各自机制重试，不影响本轮 seen 事务
        log.warning("快报或日程提醒发送失败（不阻断本轮）：%s", ", ".join(other_failed))

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
