"""已推送记录的持久化。

GitHub Actions 每次都从干净环境跑，状态必须落盘并提交回仓库
（workflow 里 git commit data/seen.json 与 data/pending.json）。结构：

{
  "version": 2,
  "updated_at": "...",
  "count": 20,
  "publishedHash": "...",          # 上次同步给 Worker 的通知集指纹
  "checks": {"lastDetailCheck": "2026-11-05"},
  "seen": {
     "<uid>": {
        "title": "...", "url": "...", "date": "...", "notified": "...",
        "hash": "...",           # 列表页指纹，用于发现标题/日期/链接变更
        "detailHash": "..."      # 详情页指纹，每日抽检一次发现正文/附件变更
     }
  }
}

兼容：旧记录没有 hash / detailHash 时一律视为「未见变化」，
避免升级当天把历史通知全部当成更新重发；下一次真正变化时自动补齐。
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from typing import Dict, Iterable, List

from .models import Notice

log = logging.getLogger("yds")


class State:
    def __init__(self, path: str, keep: int = 800):
        self.path = path
        self.keep = keep
        self.data: Dict[str, dict] = {}
        self.checks: Dict[str, str] = {}
        self.published_hash = ""
        self.initialized = False
        self.corrupt = False
        self.load()

    def load(self) -> None:
        if not os.path.exists(self.path):
            log.info("状态文件不存在，按首次运行处理：%s", self.path)
            return
        try:
            with open(self.path, encoding="utf-8") as fh:
                raw = json.load(fh)
            if not isinstance(raw, dict):
                raise ValueError("根节点不是对象")
            self.data = raw.get("seen", {}) if isinstance(raw.get("seen"), dict) else {}
            self.checks = raw.get("checks", {}) if isinstance(raw.get("checks"), dict) else {}
            self.published_hash = str(raw.get("publishedHash") or "")
            # version 或已有记录任一存在，都说明不是首次运行：
            # 状态文件损坏被清空时不能误判成首次运行而给全体订阅者群发基线邮件
            self.initialized = bool(raw.get("version")) or bool(self.data)
            log.info("已加载历史记录 %s 条", len(self.data))
        except (json.JSONDecodeError, OSError, ValueError) as exc:
            log.error("状态文件损坏，本次不建立基线也不发信：%s", exc)
            self.data = {}
            self.initialized = True  # fail-closed：宁可停发，也不群发
            self.corrupt = True

    @property
    def is_first_run(self) -> bool:
        return not self.initialized

    def classify(self, notice: Notice) -> str:
        """new / changed / same —— changed 表示官网改了同一篇文章，需要重推。"""
        rec = self.data.get(notice.uid)
        if not rec:
            return "new"
        old = rec.get("hash")
        if not old:
            return "same"  # 兼容旧记录
        return "same" if old == notice.list_hash else "changed"

    def detail_changed(self, notice: Notice) -> bool:
        """每日详情抽检：只有存过 detailHash 的条目才具备比对基线。"""
        rec = self.data.get(notice.uid)
        if not rec or not rec.get("detailHash"):
            return False
        return rec["detailHash"] != notice.detail_hash

    def mark(self, notices: Iterable[Notice], when: datetime | None = None) -> None:
        stamp = (when or datetime.now(timezone.utc)).isoformat(timespec="seconds")
        for n in notices:
            self.data[n.uid] = {
                "title": n.title,
                "url": n.url,
                "date": n.date_text,
                "notified": stamp,
                "hash": n.list_hash,
                "detailHash": n.detail_hash,
            }
        self.initialized = True
        self._prune()

    def record_detail_baseline(self, notices: Iterable[Notice]) -> None:
        """每日抽检后只刷新 detailHash，不改 notified，也不触发推送。"""
        for n in notices:
            rec = self.data.get(n.uid)
            if rec:
                rec["detailHash"] = n.detail_hash

    def _prune(self) -> None:
        """只保留最近 keep 条，防止状态文件无限膨胀。"""
        if len(self.data) <= self.keep:
            return
        ordered = sorted(self.data.items(), key=lambda kv: kv[1].get("notified", ""), reverse=True)
        self.data = dict(ordered[: self.keep])

    def last_detail_check(self) -> str:
        return self.checks.get("lastDetailCheck", "")

    def touch_detail_check(self, day: str) -> None:
        self.checks["lastDetailCheck"] = day

    def set_published_hash(self, value: str) -> None:
        self.published_hash = value

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        payload = {
            "version": 2,
            "updated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
            "count": len(self.data),
            "publishedHash": self.published_hash,
            "checks": self.checks,
            "seen": self.data,
        }
        # 原子写：先写临时文件再 rename，避免 Action 中断留下半个 JSON
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.path) or ".", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, self.path)
        log.info("状态已保存：%s（%s 条）", self.path, len(self.data))


def load_pending(path: str) -> Dict[str, Dict[str, dict]]:
    """待发摘要池：{"daily": {uid: item}, "weekly": {uid: item}}。"""
    try:
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh)
        if isinstance(raw, dict):
            out = {}
            for key in ("daily", "weekly"):
                out[key] = raw.get(key) if isinstance(raw.get(key), dict) else {}
            return out
    except (OSError, json.JSONDecodeError):
        pass
    return {"daily": {}, "weekly": {}}


def save_pending(path: str, pending: Dict[str, Dict[str, dict]]) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(pending, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def pending_notices(pool: Dict[str, dict]) -> List[Notice]:
    return [Notice.from_feed_item(v) for v in pool.values()]
