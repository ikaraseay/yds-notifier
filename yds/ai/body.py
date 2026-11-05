"""历史通知正文的渐进式回填（仅在 AI 缓存未命中时触发）。

seen.json 只存标题 / URL / 发布日期，AI 无法据此判断公告里的真实事件日。
这里按 uid 逐个抓一次详情页，结果写进 ai.json 缓存，之后不再请求官网。
严格约束：host 白名单、只 http/https、超时、限条数、失败静默跳过。
"""

from __future__ import annotations

import logging
import re
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

log = logging.getLogger("yds")

# 与 fetch.py 的 UA 保持一致，避免被官网按 UA 区别对待
_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
_CONTENT_SELECTORS = (".articleContent", ".headlines-news-content", "article", ".content", "body")
_DROP_TAGS = ("script", "style", "nav", "footer", "header", "noscript", "iframe")


def _host_allowed(url: str, allowed_hosts) -> bool:
    try:
        p = urlparse(url)
    except ValueError:
        return False
    if p.scheme not in ("http", "https") or not p.hostname:
        return False
    hosts = {h.lower().strip() for h in (allowed_hosts or []) if h}
    if not hosts:
        return False  # 未配白名单时一律不抓，fail-closed
    host = p.hostname.lower()
    return any(host == h or host.endswith("." + h) for h in hosts)


def fetch_body(url: str, allowed_hosts, max_chars: int = 3000, timeout: int = 8) -> str:
    """返回清洗后的正文；任何失败返回空串，绝不影响主流程。"""
    if not url or not _host_allowed(url, allowed_hosts):
        return ""
    try:
        resp = requests.get(url, headers={"User-Agent": _UA}, timeout=timeout)
        resp.raise_for_status()
        resp.encoding = resp.apparent_encoding or resp.encoding
        soup = BeautifulSoup(resp.text, "html.parser")
        for tag in soup.find_all(_DROP_TAGS):
            tag.decompose()
        node = None
        for sel in _CONTENT_SELECTORS:
            node = soup.select_one(sel)
            if node and len(node.get_text(strip=True)) > 40:
                break
            node = None
        if node is None:
            return ""
        text = node.get_text(" ", strip=True)
        text = re.sub(r"\s+", " ", text)
        return text[:max_chars]
    except Exception as exc:  # noqa: BLE001 - 官网不可达属常态，静默降级
        log.debug("正文回填跳过 %s：%s", url, str(exc)[:100])
        return ""


def backfill_bodies(items: list, allowed_hosts, limit: int, max_chars: int) -> int:
    """对缺 body 的条目逐个回填，返回成功条数。原地修改 items。"""
    done = 0
    for item in items:
        if done >= limit:
            break
        if str(item.get("body") or "").strip():
            continue
        url = str(item.get("url") or "")
        if not url:
            continue
        body = fetch_body(url, allowed_hosts, max_chars=max_chars)
        if body:
            item["body"] = body
            done += 1
    return done
