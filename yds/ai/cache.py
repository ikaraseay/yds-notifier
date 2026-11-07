"""AI 分析结果缓存（data/ai.json）。

为什么单独一个文件：AI 在 GitHub Actions 的 Python 进程内运行，结果必须被下一轮
Python 进程直接读回；seen.json 与去重/抽检逻辑强耦合，混入 AI 字段会污染语义，
而 Worker KV 是「对外发布产物」且写入要占免费额度，不适合做分析缓存。

结构：
{
  "version": 1,
  "updatedAt": "...",
  "items": {
    "<uid>": {"inputHash": "...", "analysis": {...}, "model": "...", "at": "..."}
  }
}
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from typing import Dict, Optional

log = logging.getLogger("yds")


class AiCache:
    def __init__(self, path: str, keep: int = 800):
        self.path = path
        self.keep = keep
        self.items: Dict[str, dict] = {}
        self.changed = False
        self.load()

    def load(self) -> None:
        if not os.path.exists(self.path):
            return
        try:
            with open(self.path, encoding="utf-8") as fh:
                raw = json.load(fh)
            if not isinstance(raw, dict):
                raise ValueError("根节点不是对象")
            data = raw.get("items")
            self.items = data if isinstance(data, dict) else {}
            log.info("已加载 AI 分析结果 %s 条", len(self.items))
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            # 损坏时按空缓存处理（会重新分析），但绝不影响发信
            log.warning("AI 缓存损坏，按空缓存处理：%s", exc)
            self.items = {}

    def get(self, uid: str, input_hash: str, version: str) -> Optional[dict]:
        rec = self.items.get(uid)
        if not isinstance(rec, dict):
            return None
        if rec.get("inputHash") != input_hash:
            return None
        analysis = rec.get("analysis")
        if not isinstance(analysis, dict):
            return None
        # 提示词升版强制失效
        if str(analysis.get("version") or "") != version:
            return None
        return analysis

    def put(self, uid: str, input_hash: str, analysis: dict, model: str, body: str = "") -> None:
        self.items[uid] = {
            "inputHash": input_hash,
            "analysis": analysis,
            "model": model,
            # 存正文是为了让下一轮「从 seen.json 重建的历史条目」能算出同一个
            # inputHash，避免每轮重复抓详情页、重复调用模型。
            "body": body[:3000],
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        self.changed = True

    def body_of(self, uid: str) -> str:
        rec = self.items.get(uid)
        return str(rec.get("body") or "") if isinstance(rec, dict) else ""

    def put_body(self, uid: str, body: str) -> None:
        """只缓存正文（AI 未启用 / 调用失败时也生效），避免每轮重复抓详情页。"""
        if not body:
            return
        trimmed = body[:3000]
        rec = self.items.get(uid)
        if not isinstance(rec, dict):
            rec = {}
            self.items[uid] = rec
        elif rec.get("body") == trimmed:
            return  # 内容没变不标脏，避免每轮产生一次无意义的状态写回
        rec["body"] = trimmed
        rec.setdefault("at", datetime.now(timezone.utc).isoformat(timespec="seconds"))
        self.changed = True

    def prune(self) -> None:
        if len(self.items) <= self.keep:
            return
        ordered = sorted(self.items.items(), key=lambda kv: str(kv[1].get("at") or ""), reverse=True)
        self.items = dict(ordered[: self.keep])
        self.changed = True

    def save(self) -> None:
        if not self.changed:
            return
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        payload = {
            "version": 1,
            "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "items": self.items,
        }
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.path) or ".", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, self.path)
        self.changed = False
        log.info("AI 分析结果已保存：%s（%s 条）", self.path, len(self.items))
