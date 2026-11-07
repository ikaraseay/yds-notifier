"""HTTP 抓取层：robots.txt 校验、会话复用、重试、进程内去重与并发限流。

单轮要访问 13 个列表页 + 若干详情页。为了既快又不打疼官网，这里做四件事：

1. **robots.txt 校验**：每主机取一次 robots.txt，命中 `Disallow` 的地址直接跳过，
   一个字节都不请求（`RESPECT_ROBOTS=enforce`，默认）。取不到 robots.txt 时
   按放行处理，避免官网抖一下就整轮停摆。
2. **线程本地 Session**：多线程抓取时各自持有连接池，避免 requests.Session
   在多线程下共享连接引发的偶发乱序 / 连接复用问题。
3. **同 URL 合并（single-flight）**：研电赛专区（cpipc）与专区轮询（cpipc_zones）
   会命中同一个列表页地址，同一轮只真正请求一次，其余线程等待并复用结果。
4. **每主机并发上限**：cpipc.acge.org.cn 同时最多 2 个在途请求，全局并发由
   调用方的线程池控制。宁可多花几秒，也不给官方站点制造瞬时压力。

`STATS` 记录本轮真实请求数 / 合并命中数，供日志与自测断言使用。
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Dict, Optional

import requests
from requests.adapters import HTTPAdapter
from urllib.parse import urlparse
from urllib3.util.retry import Retry

from .robots import RobotsRules, parse as parse_robots

log = logging.getLogger("yds")

# 抓取标识：如实声明自己是谁，不伪装浏览器。
# 自定义用 CRAWLER_UA 覆盖（例如自建实例带上自己的联系方式）。
# 注意必须是纯 ASCII：HTTP 头按 latin-1 编码，中文会直接让整轮抓取抛错。
DEFAULT_UA = "yds-notifier/1.0 (+https://github.com/ikaraseay/yds-notifier)"


def _ascii_ua(value: str) -> str:
    """把 UA 收敛成可打印 ASCII；空值或非法值回退到默认标识。"""
    cleaned = "".join(ch for ch in value or "" if 32 <= ord(ch) < 127).strip()
    return cleaned or DEFAULT_UA


UA = _ascii_ua(os.environ.get("CRAWLER_UA") or DEFAULT_UA)

# robots.txt 处理策略：enforce（默认，命中 Disallow 即跳过）/ warn（只记日志）/ off
_MODE_ENV = (os.environ.get("RESPECT_ROBOTS") or "enforce").strip().lower()
RESPECT_ROBOTS = _MODE_ENV if _MODE_ENV in ("enforce", "warn", "off") else "enforce"

# 每个主机允许的最大并发请求数。官方站点是老旧 Java 系统，2 已足够快也足够礼貌。
PER_HOST_LIMIT = 2

_tls = threading.local()
_host_gates: Dict[str, threading.Semaphore] = {}
_gate_lock = threading.Lock()

_memo: Dict[str, str] = {}          # url -> html（仅本轮有效）
_inflight: Dict[str, threading.Event] = {}
_memo_lock = threading.Lock()

# robots.txt 每个主机只取一次（进程内缓存）
_robots_cache: Dict[str, Optional[RobotsRules]] = {}
_robots_blocked: Dict[str, int] = {}
_robots_lock = threading.Lock()
_robots_guard = threading.Lock()
_robots_locks: Dict[str, threading.Lock] = {}

STATS = {"requests": 0, "shared": 0, "errors": 0, "retries": 0, "robots": 0}


def reset_stats() -> None:
    """每轮开始时清空去重缓存与计数（测试里也用它隔离用例）。"""
    with _memo_lock:
        _memo.clear()
        _inflight.clear()
    with _robots_lock:
        _robots_cache.clear()
        _robots_blocked.clear()
    with _robots_guard:
        _robots_locks.clear()
    for k in STATS:
        STATS[k] = 0


def set_respect_robots(mode: str) -> None:
    """切换 robots.txt 策略（enforce / warn / off），测试与自建实例用。"""
    global RESPECT_ROBOTS
    value = (mode or "").strip().lower()
    RESPECT_ROBOTS = value if value in ("enforce", "warn", "off") else "enforce"


def robots_summary() -> str:
    """本轮被 robots.txt 挡下的地址数，供主流程日志一行汇总。"""
    if not _robots_blocked:
        return ""
    hosts = "、".join(f"{h}（{n}）" for h, n in sorted(_robots_blocked.items()))
    return f"robots.txt 限制 {sum(_robots_blocked.values())} 个地址：{hosts}"


def _robots_for(host: str) -> Optional[RobotsRules]:
    """取主机的 robots.txt 规则；取不到返回 None（按放行处理）。

    并发抓取时同一主机的 robots.txt 只真正请求一次：先查缓存，
    再按主机加锁，避免 13 个线程同时打 /robots.txt。
    """
    with _robots_lock:
        if host in _robots_cache:
            return _robots_cache[host]
    with _robots_guard:
        host_lock = _robots_locks.setdefault(host, threading.Lock())
    with host_lock:
        with _robots_lock:
            if host in _robots_cache:
                return _robots_cache[host]
        rules: Optional[RobotsRules] = None
        url = f"https://{host}/robots.txt"
        try:
            STATS["robots"] += 1
            resp = requests.get(
                url, timeout=10,
                headers={"User-Agent": UA, "Accept": "text/plain,*/*;q=0.8"},
            )
            if resp.status_code == 200:
                rules = parse_robots(resp.text, ua_token=UA)
                log.info(
                    "robots.txt：%s 共 %s 条规则（%s）",
                    host, len(rules.rules), RESPECT_ROBOTS,
                )
            elif resp.status_code >= 500:
                log.warning("robots.txt 返回 %s，本轮按放行处理：%s", resp.status_code, host)
            else:
                log.info("robots.txt 不存在（%s），按放行处理：%s", resp.status_code, host)
        except Exception as exc:  # noqa: BLE001 - 取不到 robots 不应阻断抓取
            log.warning("robots.txt 获取失败，本轮按放行处理 %s：%s", host, str(exc)[:120])
        with _robots_lock:
            _robots_cache[host] = rules
        return rules


def robots_allows(url: str) -> bool:
    """按 robots.txt 判断该地址是否允许抓取。"""
    if RESPECT_ROBOTS == "off":
        return True
    host = _host_of(url)
    if not host:
        return True
    rules = _robots_for(host)
    if rules is None or rules.empty:
        return True
    path = urlparse(url).path or "/"
    if rules.allows(path):
        return True
    with _robots_lock:
        _robots_blocked[host] = _robots_blocked.get(host, 0) + 1
        first = _robots_blocked[host] == 1
    if first:
        if RESPECT_ROBOTS == "enforce":
            log.warning(
                "robots.txt 不允许抓取 %s%s，已跳过（RESPECT_ROBOTS=enforce）", host, path
            )
        else:
            log.warning(
                "robots.txt 不允许抓取 %s%s，但 RESPECT_ROBOTS=warn，仅提示不拦截", host, path
            )
    return RESPECT_ROBOTS != "enforce"


def stats_line() -> str:
    return (
        f"HTTP 请求 {STATS['requests']} 次"
        f"（同 URL 复用 {STATS['shared']} 次，重试 {STATS['retries']} 次，"
        f"失败 {STATS['errors']} 次，robots 探测 {STATS['robots']} 次）"
    )


def _session() -> requests.Session:
    """复用一个带重试的 Session：GitHub Actions 出口网络偶发抖动很常见。"""
    s = getattr(_tls, "session", None)
    if s is not None:
        return s

    s = requests.Session()
    s.headers.update(
        {
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9",
            # 官方站点不压缩时会退化为明文，压缩能省掉大量传输体积
            "Accept-Encoding": "gzip, deflate",
        }
    )
    retry = Retry(
        total=3,
        backoff_factor=1.5,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET", "HEAD"}),
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=PER_HOST_LIMIT, pool_maxsize=PER_HOST_LIMIT)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    _tls.session = s
    return s


def _gate(host: str) -> threading.Semaphore:
    with _gate_lock:
        sem = _host_gates.get(host)
        if sem is None:
            sem = threading.Semaphore(PER_HOST_LIMIT)
            _host_gates[host] = sem
        return sem


def _host_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def get_text(url: str, *, timeout: int = 25, tries: int = 2, shared: bool = True) -> str:
    """GET 页面并返回解码后的 HTML。

    - `shared=True` 时同一轮内相同 URL 只请求一次（并发安全）。
    - 站点是 GBK/UTF-8 混用的老系统，以 UTF-8 为主、失败时回退 apparent_encoding。
    """
    if not shared:
        return _download(url, timeout, tries)

    with _memo_lock:
        if url in _memo:
            STATS["shared"] += 1
            return _memo[url]
        mine = url not in _inflight
        event = _inflight.get(url)
        if event is None:
            event = threading.Event()
            _inflight[url] = event

    if not mine:
        # 别的线程正在抓同一个地址：等它，不重复打官网
        event.wait(timeout * max(1, tries) + 5)
        with _memo_lock:
            if url in _memo:
                STATS["shared"] += 1
                return _memo[url]
        # 等不到就自己抓，绝不因为去重而放弃这条数据
        return _download(url, timeout, tries)

    try:
        html = _download(url, timeout, tries)
        with _memo_lock:
            _memo[url] = html
        return html
    finally:
        with _memo_lock:
            _inflight.pop(url, None)
        event.set()


def _download(url: str, timeout: int, tries: int) -> str:
    # robots.txt 检查放在最前：被禁止的地址一个字节都不请求
    if not robots_allows(url):
        return ""
    last_err: Optional[Exception] = None
    gate = _gate(_host_of(url))
    for attempt in range(1, tries + 1):
        try:
            with gate:
                STATS["requests"] += 1
                resp = _session().get(url, timeout=timeout)
            resp.raise_for_status()
            if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
                resp.encoding = resp.apparent_encoding or "utf-8"
            return resp.text
        except Exception as exc:  # noqa: BLE001 - 网络层异常统一重试
            last_err = exc
            STATS["errors"] += 1
            log.warning("抓取失败(%s/%s) %s: %s", attempt, tries, url, exc)
            if attempt < tries:
                STATS["retries"] += 1
                time.sleep(2 * attempt)
    raise RuntimeError(f"无法抓取 {url}: {last_err}")


# 兼容旧调用方：原有代码写的是 fetch.session()，保留同名入口。
def session() -> requests.Session:  # pragma: no cover - 仅向后兼容
    return _session()
