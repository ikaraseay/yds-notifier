"""AI 分析编排：唯一调用入口。

流程：输入纯数据 → 按内容指纹命中缓存 → 未命中的组批 → 一次 /chat/completions
→ 结构校验 + 日期确定性归一化 → 写缓存。任何失败都只告警，绝不阻断发信。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import date
from typing import Dict, List, Sequence

from .cache import AiCache
from .client import AiClient, AiClientError, AiConfig
from .prompts import PromptError, PromptSpec, load_prompt, user_payload
from .schema import AiAnalysis, input_hash, parse_json_object, validate_response

log = logging.getLogger("yds")


@dataclass
class AnalyzeResult:
    analyses: Dict[str, dict] = field(default_factory=dict)
    cached: int = 0
    analyzed: int = 0
    calls: int = 0
    failed_batches: int = 0
    enabled: bool = False


def build_input(item: dict, max_body_chars: int) -> dict:
    """只保留模型需要的字段并截断正文，避免把附件 URL / 内部字段喂给模型。"""
    body = str(item.get("body") or "")[:max_body_chars]
    return {
        "uid": str(item.get("uid") or ""),
        "title": str(item.get("title") or "")[:300],
        "published": str(item.get("published") or ""),
        "source": str(item.get("source") or "")[:100],
        "category": str(item.get("category") or ""),
        "summary": str(item.get("summary") or "")[:600],
        "body": body,
    }


def analyze_notices(
    items: Sequence[dict],
    cfg: AiConfig,
    cache: AiCache,
    spec: PromptSpec | None = None,
) -> AnalyzeResult:
    """返回 {uid: analysis_dict}；调用方负责把结果写回 Notice 并保存缓存。"""
    result = AnalyzeResult(enabled=cfg.usable)
    if not items:
        return result

    try:
        prompt = spec or load_prompt("notices")
    except PromptError as exc:
        log.error("提示词加载失败，AI 分析跳过：%s", exc)
        return result

    version = prompt.cache_key
    hashes: Dict[str, str] = {}
    todo: List[dict] = []
    for item in items:
        uid = str(item.get("uid") or "")
        if not uid:
            continue
        h = input_hash(item, version)
        hashes[uid] = h
        hit = cache.get(uid, h, version)
        if hit:
            result.analyses[uid] = hit
            result.cached += 1
        elif cfg.usable:
            todo.append(item)

    if not cfg.usable:
        log.info("AI 未启用（开关关闭或缺少 AI_API_KEY），命中缓存 %s 条，其余走规则降级",
                 result.cached)
        return result
    if not todo:
        log.info("AI 结果全部命中缓存（%s 条），本轮零 API 调用", result.cached)
        return result

    client = AiClient(cfg)
    today = date.today().isoformat()
    log.info("AI 分析：待处理 %s 条，缓存命中 %s 条，批量大小 %s",
             len(todo), result.cached, cfg.batch_size)

    for start in range(0, len(todo), max(1, cfg.batch_size)):
        batch = todo[start: start + max(1, cfg.batch_size)]
        payload = [build_input(i, cfg.max_body_chars) for i in batch]
        try:
            content = client.complete(prompt.system, user_payload(prompt, payload, today))
            parsed = validate_response(parse_json_object(content), payload, version)
            # 模型漏答的条目也写一份空缓存，否则每轮都会为它重新调用一次
            for item in payload:
                uid = str(item.get("uid") or "")
                if uid and uid not in parsed:
                    parsed[uid] = AiAnalysis(uid=uid, version=version, fallback=True).to_dict()
        except (AiClientError, ValueError, json.JSONDecodeError) as exc:
            log.warning("AI 批次 %s 失败（不影响发信）：%s", start // cfg.batch_size + 1, str(exc)[:200])
            result.failed_batches += 1
            continue
        body_by_uid = {str(i.get("uid") or ""): str(i.get("body") or "") for i in payload}
        for uid, analysis in parsed.items():
            result.analyses[uid] = analysis
            cache.put(uid, hashes[uid], analysis, cfg.model, body=body_by_uid.get(uid, ""))
            result.analyzed += 1

    result.calls = client.calls
    if result.calls:
        log.info("AI 完成：%s 次调用，新增 %s 条，prompt %s tokens / completion %s tokens",
                 result.calls, result.analyzed, client.prompt_tokens, client.completion_tokens)
    return result
