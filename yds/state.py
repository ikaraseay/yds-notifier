"""已推送记录的持久化。

GitHub Actions 是每次都从干净环境跑的，因此状态必须落盘并提交回仓库
（workflow 里会 git commit data/seen.json）。结构：

{
  "version": 1,
  "updated_at": "2026-11-05T12:00:00+08:00",
  "seen": {
     "<uid>": {"title": "...", "url": "...", "date": "2026-08-13", "notified": "2026-11-05T.."}
  }
}
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from typing import Dict, Iterable

from .models import Notice

log = logging.getLogger("yds")


class State:
    def __init__(self, path: str, keep: int = 800):
        self.path = path
        self.keep = keep
        self.data: Dict[str, dict] = {}
        self.load()

    def load(self) -> None:
        if not os.path.exists(self.path):
            log.info("状态文件不存在，按首次运行处理：%s", self.path)
            return
        try:
            with open(self.path, encoding="utf-8") as fh:
                raw = json.load(fh)
            self.data = raw.get("seen", {}) if isinstance(raw, dict) else {}
            log.info("已加载历史记录 %s 条", len(self.data))
        except (json.JSONDecodeError, OSError) as exc:
            log.error("状态文件损坏，将重建：%s", exc)
            self.data = {}

    @property
    def is_first_run(self) -> bool:
        return not self.data

    def has(self, notice: Notice) -> bool:
        return notice.uid in self.data

    def mark(self, notices: Iterable[Notice], when: datetime | None = None) -> None:
        stamp = (when or datetime.now(timezone.utc)).isoformat(timespec="seconds")
        for n in notices:
            self.data[n.uid] = {
                "title": n.title,
                "url": n.url,
                "date": n.date_text,
                "notified": stamp,
            }
        self._prune()

    def _prune(self) -> None:
        """只保留最近 keep 条，防止状态文件无限膨胀。"""
        if len(self.data) <= self.keep:
            return
        ordered = sorted(self.data.items(), key=lambda kv: kv[1].get("notified", ""), reverse=True)
        self.data = dict(ordered[: self.keep])

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        payload = {
            "version": 1,
            "updated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
            "count": len(self.data),
            "seen": self.data,
        }
        # 原子写：先写临时文件再 rename，避免 Action 中断留下半个 JSON
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.path) or ".", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, self.path)
        log.info("状态已保存：%s（%s 条）", self.path, len(self.data))
