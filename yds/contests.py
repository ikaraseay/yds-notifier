"""赛事状态判定（AI）与「已结束赛事低频扫描」编排。

默认策略：

- 每天第一轮抓取前，用 AI 判断各赛事本年度赛程是否结束；判定结果缓存
  `check_days` 天（默认 14 天），一次调用批量判 19 项，约每两周 1 次 API 调用。
- 判定为「已结束」的赛事默认每 `ended_scan_days` 天（14 天）才扫一次；
  进行中的仍每天扫。两个周期与 `push_max_age_days` 对齐，避免复扫才
  发现的通知因超龄只归档、不推送。
- 模型提议、代码决定：官方赛程里只要还有未来节点就强制判为「进行中」，
  AI 不可用 / 输出异常时一律按「进行中」处理（宁可多扫，不能漏通知）。

判定输入全部来自本地状态文件（ai.json / seen.json / schedule.json），
不额外请求官网，因此可以在构造数据源之前完成。
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from dataclasses import dataclass, field
from datetime import date
from typing import Dict, List, Optional, Sequence

from .ai.client import AiClient, AiClientError, AiConfig
from .ai.prompts import PromptError, load_prompt, render
from .ai.schema import parse_json_object

log = logging.getLogger("yds")

STATE_VERSION = 2
DEFAULT_CHECK_DAYS = 14
DEFAULT_ENDED_SCAN_DAYS = 14
MAX_EVIDENCE_NOTICES = 6
# 赛后收尾类公告：它们是「赛事已结束」的证据，不是「仍在进行」的证据。
# 旧提示词把「公示 / 获奖名单 / 报销」一律当作未收尾，导致 11 月还有
# 大量 8–10 月就已完赛的赛事被判成进行中。
CLOSING_WORDS = (
    "公示", "获奖", "名单", "证书", "报销", "落幕", "回顾", "揭晓",
    "等级奖", "结果", "圆满", "总结", "收官",
)


@dataclass
class ScanPlan:
    """本轮要扫的赛事，以及判定统计（供日志与自测）。"""

    selection: List[str] = field(default_factory=list)
    state: dict = field(default_factory=dict)
    classified: int = 0
    ended: int = 0
    due_ended: int = 0
    ai_failed: bool = False


def _read_json(path: str, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError, json.JSONDecodeError):
        return default


def load_state(path: str) -> dict:
    raw = _read_json(path, {})
    if not isinstance(raw, dict) or raw.get("version") != STATE_VERSION:
        # 旧版 zones.json 存的是轮询游标，直接丢弃，不迁移
        return {"version": STATE_VERSION, "contests": {}}
    contests = raw.get("contests")
    return {
        "version": STATE_VERSION,
        "updatedAt": str(raw.get("updatedAt") or ""),
        "contests": contests if isinstance(contests, dict) else {},
    }


def save_state(path: str, state: dict) -> None:
    state = dict(state)
    state["version"] = STATE_VERSION
    state["updatedAt"] = date.today().isoformat()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def _iso_day(value) -> str:
    text = str(value or "")[:10]
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError:
        return ""


def collect_evidence(data_dir: str, contests: Sequence[str], today: date) -> List[dict]:
    """把本地缓存整理成给模型的紧凑证据（不联网）。"""
    ai = _read_json(os.path.join(data_dir, "ai.json"), {}) or {}
    items = ai.get("items") if isinstance(ai, dict) else {}
    items = items if isinstance(items, dict) else {}
    seen = _read_json(os.path.join(data_dir, "seen.json"), {}) or {}
    seen = seen.get("seen") if isinstance(seen, dict) else {}
    seen = seen if isinstance(seen, dict) else {}
    sched = _read_json(os.path.join(data_dir, "schedule.json"), {}) or {}
    rows = sched.get("contests") if isinstance(sched, dict) else []
    rows = rows if isinstance(rows, list) else []

    schedule_by_name: Dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = str(row.get("contest") or "").strip()
        if not name:
            continue
        schedule_by_name[name] = {
            k: v for k, v in row.items()
            if k.endswith(("Start", "End")) and _iso_day(v)
        }

    grouped: Dict[str, list] = {c: [] for c in contests}
    for uid, rec in items.items():
        if not isinstance(rec, dict):
            continue
        analysis = rec.get("analysis") or {}
        if not isinstance(analysis, dict):
            continue
        name = str(analysis.get("contest") or "").strip()
        if name not in grouped:
            continue
        old = seen.get(uid) if isinstance(seen.get(uid), dict) else {}
        events = []
        for ev in (analysis.get("events") or [])[:4]:
            if isinstance(ev, dict) and _iso_day(ev.get("date")):
                events.append({"date": _iso_day(ev.get("date")),
                               "label": str(ev.get("label") or "")[:24]})
        grouped[name].append({
            "date": _iso_day(old.get("date")),
            "title": str(old.get("title") or "")[:80],
            "stage": str(analysis.get("stage") or "")[:12],
            "events": events,
        })

    out = []
    for name in contests:
        notes = sorted(grouped[name], key=lambda x: x.get("date") or "", reverse=True)
        notes = [n for n in notes if n["title"]][:MAX_EVIDENCE_NOTICES]
        schedule = schedule_by_name.get(name, {})
        future_nodes = [
            _iso_day(v) for v in schedule.values()
            if _iso_day(v) and date.fromisoformat(_iso_day(v)) >= today
        ]
        # 通知里抽出的未来事件（公示截止、异议反馈、证书下载开放日…）同样
        # 是硬约束：由代码算好，避免模型用「公示期未明确截止」自由心证。
        future_events = sorted(
            ({"date": _iso_day(ev["date"]), "label": str(ev.get("label") or "")[:24]}
             for n in notes for ev in n["events"]
             if _iso_day(ev.get("date")) and date.fromisoformat(_iso_day(ev["date"])) >= today),
            key=lambda x: x["date"],
        )[:4]
        closing = sum(
            1 for n in notes
            if any(w in (n["title"] + " " + n["stage"]) for w in CLOSING_WORDS)
        )
        last_node = max((_iso_day(v) for v in schedule.values() if _iso_day(v)), default="")
        out.append({
            "name": name,
            "schedule": schedule,
            "futureNodes": len(future_nodes),
            "lastNode": last_node,
            "daysSinceLastNode": (today - date.fromisoformat(last_node)).days if last_node else -1,
            "futureEvents": future_events,
            "futureEventCount": len(future_events),
            "closingNotices": closing,
            "allPast": not future_nodes and not future_events,
            "hasSchedule": bool(schedule),
            "hasEvidence": bool(schedule) or bool(notes),
            "recentNotices": notes,
        })
    return out


def classify(
    evidence: List[dict],
    today: date,
    ai_cfg: AiConfig,
    client: Optional[AiClient] = None,
) -> Dict[str, dict]:
    """一次 AI 调用判定所有待复核赛事；失败返回空字典（调用方按进行中处理）。

    代码侧强约束：官方赛程仍有未来节点 → 强制判为进行中。
    """
    if not evidence or not ai_cfg.usable:
        return {}
    try:
        spec = load_prompt("contest_status")
        payload = render(
            spec.user,
            today=today.isoformat(),
            evidence=json.dumps(evidence, ensure_ascii=False, separators=(",", ":")),
        )
        raw = (client or AiClient(ai_cfg)).complete(spec.system, payload)
        data = parse_json_object(raw)
        rows = data.get("contests")
        if not isinstance(rows, list):
            raise ValueError("输出缺少 contests 数组")
    except (AiClientError, PromptError, ValueError, OSError, TypeError) as exc:
        log.warning("赛事状态 AI 判定失败，本轮按「全部进行中」处理：%s", str(exc)[:160])
        return {}

    by_name = {str(e["name"]): e for e in evidence}
    verdicts: Dict[str, dict] = {}
    forced_active = forced_ended = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or "").strip()
        if name not in by_name:
            continue
        e = by_name[name]
        ended = bool(row.get("ended"))
        reason = str(row.get("reason") or "")[:120]
        if e["futureNodes"] > 0 or e.get("futureEventCount", 0) > 0:
            if ended:
                forced_active += 1
            ended = False
            reason = "仍有未来时间节点，按进行中处理"
        elif not e.get("hasSchedule", bool(e.get("schedule"))):
            # 官方赛程表没有该赛事的年度节点时，只有零散通知不足以区分
            # 「本届收尾」和「下届预热」，按 fail-open 保持每天扫描。
            if ended:
                forced_active += 1
            ended = False
            reason = "官方赛程缺少该赛事节点，按进行中处理"
        elif (
            not ended and e.get("allPast") and e.get("hasEvidence")
            and e.get("closingNotices", 0) > 0
            and e.get("daysSinceLastNode", -1) >= 21
        ):
            # 对称兜底：赛程最晚节点已过 3 周、通知里没有任何未来日期、
            # 且已出现收尾公告，模型仍因「公示期未明确截止」判进行中时，
            # 由代码纠正。避免模型保守导致降频永远不生效。
            ended = True
            reason = f"赛程 {e.get('lastNode')} 已结束且无未来节点，按已结束处理"
            forced_ended += 1
        verdicts[name] = {"ended": ended, "reason": reason}
    if forced_active or forced_ended:
        log.info(
            "赛事状态：代码纠正 %s 项「判进行中→已结束」、%s 项「判已结束→进行中」",
            forced_ended, forced_active,
        )
    return verdicts


def plan(
    *,
    data_dir: str,
    contests: Sequence[str],
    cfg: dict,
    today: date,
    ai_cfg: AiConfig,
    client: Optional[AiClient] = None,
) -> ScanPlan:
    """返回本轮应扫描的赛事集合与更新后的状态（调用方负责 save_state）。"""
    cfg = cfg if isinstance(cfg, dict) else {}
    enabled = bool(cfg.get("enabled", True))
    check_days = max(1, int(cfg.get("check_days", DEFAULT_CHECK_DAYS) or DEFAULT_CHECK_DAYS))
    scan_days = max(1, int(cfg.get("ended_scan_days", DEFAULT_ENDED_SCAN_DAYS) or DEFAULT_ENDED_SCAN_DAYS))
    state_path = os.path.join(data_dir, "zones.json")
    state = load_state(state_path)
    entries = state["contests"]

    def _stale(entry: dict) -> bool:
        checked = _iso_day(entry.get("checkedAt"))
        if not checked:
            # 判定失败后当天不再重试，避免每天消耗一次 API 调用
            return _iso_day(entry.get("lastAttempt")) != today.isoformat()
        return (today - date.fromisoformat(checked)).days >= check_days

    stale = [c for c in contests if _stale(entries.get(c) or {})]
    result = ScanPlan(state=state)
    if enabled and stale and ai_cfg.usable:
        evidence = collect_evidence(data_dir, stale, today)
        verdicts = classify(evidence, today, ai_cfg, client=client)
        if verdicts:
            for name, v in verdicts.items():
                entries[name] = {
                    **entries.get(name, {}),
                    "ended": bool(v["ended"]),
                    "reason": v["reason"],
                    "checkedAt": today.isoformat(),
                }
            result.classified = len(verdicts)
        else:
            result.ai_failed = True
            for name in stale:
                entries[name] = {**entries.get(name, {}), "lastAttempt": today.isoformat()}
    elif not enabled or not ai_cfg.usable:
        # 关闭判定 / 未配置 AI：全部按进行中处理，不改变扫描行为
        if stale:
            log.info("赛事状态判定未启用（enabled=%s，AI 可用=%s），全部赛事按进行中处理",
                     enabled, ai_cfg.usable)

    selection: List[str] = []
    for name in contests:
        entry = entries.get(name) or {}
        if not enabled or not entry.get("ended"):
            selection.append(name)
            continue
        result.ended += 1
        last = _iso_day(entry.get("lastScan"))
        if not last or (today - date.fromisoformat(last)).days >= scan_days:
            selection.append(name)
            entry["lastScan"] = today.isoformat()
            entries[name] = entry
            result.due_ended += 1
    result.selection = selection
    return result
