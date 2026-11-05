from __future__ import annotations

import logging
import time
from typing import Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

log = logging.getLogger("yds")

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0 Safari/537.36"
)

_session: Optional[requests.Session] = None


def session() -> requests.Session:
    """复用一个带重试的 Session：GitHub Actions 出口网络偶发抖动很常见。"""
    global _session
    if _session is not None:
        return _session

    s = requests.Session()
    s.headers.update(
        {
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9",
        }
    )
    retry = Retry(
        total=3,
        backoff_factor=1.5,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET", "HEAD"}),
    )
    adapter = HTTPAdapter(max_retries=retry, pool_maxsize=8)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    _session = s
    return s


def get_text(url: str, *, timeout: int = 25, tries: int = 2) -> str:
    """GET 页面并返回解码后的 HTML。

    站点是 GBK/UTF-8 混用的老系统，这里以 UTF-8 为主、失败时回退 apparent_encoding。
    """
    last_err: Optional[Exception] = None
    for attempt in range(1, tries + 1):
        try:
            resp = session().get(url, timeout=timeout)
            resp.raise_for_status()
            if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
                resp.encoding = resp.apparent_encoding or "utf-8"
            return resp.text
        except Exception as exc:  # noqa: BLE001 - 网络层异常统一重试
            last_err = exc
            log.warning("抓取失败(%s/%s) %s: %s", attempt, tries, url, exc)
            if attempt < tries:
                time.sleep(2 * attempt)
    raise RuntimeError(f"无法抓取 {url}: {last_err}")
