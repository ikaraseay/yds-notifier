"""数据源解析器。

每个数据源实现 `Source.fetch()` 返回 Notice 列表。
加新数据源只需继承 `BaseSource` 并在 `REGISTRY` 里注册，其余流程不用改。
"""

from __future__ import annotations

import logging
import re
from abc import ABC, abstractmethod
from typing import List, Optional
from urllib.parse import urljoin, urlparse, parse_qsl, urlencode, urlunparse

from bs4 import BeautifulSoup

from . import fetch
from .models import Attachment, Notice, clean_text, extract_ident, make_uid, parse_cn_date

log = logging.getLogger("yds")


def _strip_page_param(url: str) -> str:
    """去掉 ?page=2 这类分页噪音，得到干净的正文地址。"""
    p = urlparse(url)
    q = [(k, v) for k, v in parse_qsl(p.query) if k.lower() != "page"]
    return urlunparse(p._replace(query=urlencode(q), fragment=""))


class BaseSource(ABC):
    key: str = ""
    name: str = ""
    base: str = ""

    def __init__(
        self,
        max_pages: int = 1,
        keywords: Optional[List[str]] = None,
        allowed_hosts: Optional[List[str]] = None,
    ):
        self.max_pages = max(1, max_pages)
        self.keywords = [k for k in (keywords or []) if k]
        default_host = (urlparse(self.base).hostname or "").lower()
        self.allowed_hosts = {h.lower() for h in (allowed_hosts or []) if h}
        if not self.allowed_hosts and default_host:
            self.allowed_hosts = {default_host}

    def _url_ok(self, url: str) -> bool:
        """只允许 http/https 且 host 在白名单内，防止站点内容把我们引到内网（SSRF）。"""
        try:
            p = urlparse(url or "")
        except ValueError:
            return False
        if p.scheme.lower() not in ("http", "https"):
            return False
        host = (p.hostname or "").lower()
        return any(host == h or host.endswith("." + h) for h in self.allowed_hosts)

    def _detail_soup(self, notice: Notice):
        """安全地抓详情页；不合规地址或网络失败都返回 None，由调用方降级。"""
        if not self._url_ok(notice.url):
            log.warning("详情页地址不在白名单，已跳过：%s", notice.url)
            return None
        try:
            return BeautifulSoup(fetch.get_text(notice.url), "html.parser")
        except Exception as exc:  # noqa: BLE001
            log.warning("详情页失败 %s: %s", notice.url, exc)
            return None

    @abstractmethod
    def list_page(self, page: int) -> str:
        """返回第 page 页（从 1 开始）的列表页 URL。"""

    @abstractmethod
    def parse_list(self, html: str) -> List[Notice]:
        """解析列表页，返回该页的 Notice（不含正文与附件）。"""

    def enrich(self, notice: Notice) -> Notice:
        """抓详情页补正文摘要与附件。失败不影响整体流程。"""
        return notice

    def matches(self, title: str) -> bool:
        return not self.keywords or any(k in title for k in self.keywords)

    def fetch(self) -> List[Notice]:
        results: List[Notice] = []
        seen = set()
        for page in range(1, self.max_pages + 1):
            url = self.list_page(page)
            if not self._url_ok(url):
                log.error("[%s] 列表页地址不合规，已跳过：%s", self.name, url)
                break
            try:
                html = fetch.get_text(url)
            except Exception as exc:  # noqa: BLE001
                log.error("[%s] 第 %s 页抓取失败：%s", self.name, page, exc)
                break
            items = self.parse_list(html)
            if not items:
                log.info("[%s] 第 %s 页无条目，停止翻页", self.name, page)
                break
            fresh = 0
            for item in items:
                if item.uid in seen:
                    continue
                seen.add(item.uid)
                if not self.matches(item.title):
                    continue
                results.append(item)
                fresh += 1
            log.info("[%s] 第 %s 页解析 %s 条（命中 %s 条）", self.name, page, len(items), fresh)
        return results


# --------------------------------------------------------------------------
# 研创网（中国研究生创新实践系列大赛）研电赛栏目
# --------------------------------------------------------------------------
class CpipcSource(BaseSource):
    """https://cpipc.acge.org.cn/cw/contestNews/list/6/N"""

    key = "cpipc"
    name = "研创网·研电赛"
    base = "https://cpipc.acge.org.cn/"
    LIST_TPL = "https://cpipc.acge.org.cn/cw/contestNews/list/6/{page}"

    def list_page(self, page: int) -> str:
        return self.LIST_TPL.format(page=page)

    def parse_list(self, html: str) -> List[Notice]:
        soup = BeautifulSoup(html, "html.parser")
        container = soup.find(id="news_list") or soup
        out: List[Notice] = []
        for li in container.find_all("li", class_="li"):
            a = li.find("a", href=True)
            if not a:
                continue
            href = _strip_page_param(urljoin(self.base, a["href"]))
            title = (a.get("title") or a.get_text(" ", strip=True)).strip()
            # 日期被拆成 "13" + "2026-08" 两个 div，拼回来
            day = li.select_one(".day")
            month = li.select_one(".date")
            published = None
            if month:
                raw = month.get_text(strip=True)
                if day:
                    raw = f"{raw}-{day.get_text(strip=True)}"
                published = parse_cn_date(raw)
            summary = clean_text(li.select_one(".t2").get_text(" ", strip=True)) if li.select_one(".t2") else ""
            out.append(
                Notice(
                    source=self.name,
                    source_key=self.key,
                    title=title,
                    url=href,
                    published=published,
                    summary=summary,
                    uid=make_uid(self.key, extract_ident(href, title)),
                )
            )
        return out

    def enrich(self, notice: Notice) -> Notice:
        soup = self._detail_soup(notice)
        if soup is None:
            return notice

        head = soup.select_one(".top .h")
        if head and head.get_text(strip=True):
            notice.title = head.get_text(" ", strip=True)

        meta = soup.select_one(".top .p")
        if meta:
            d = parse_cn_date(meta.get_text(" ", strip=True))
            if d:
                notice.published = d

        body = soup.select_one(".articleContent")
        if body:
            notice.summary = notice.summary or clean_text(body.get_text(" ", strip=True))
            for a in body.find_all("a", href=True):
                text = a.get_text(" ", strip=True)
                if "附件" in text or re.search(r"\.(pdf|docx?|xlsx?|zip|rar)$", text, re.I):
                    notice.attachments.append(Attachment(text or "附件", urljoin(self.base, a["href"])))
        return notice


# --------------------------------------------------------------------------
# 中国电子学会 通知公告
# --------------------------------------------------------------------------
class CieSource(BaseSource):
    """https://www.cie.org.cn/list_43/ 与 /list_43_N/

    学会公告是全学科混排的，所以默认只保留标题含「电子设计竞赛 / 研电赛」的条目。
    """

    key = "cie"
    name = "中国电子学会·通知公告"
    base = "https://www.cie.org.cn/"
    DEFAULT_KEYWORDS = ("电子设计竞赛", "研电赛", "研究生电子设计")

    def __init__(
        self,
        max_pages: int = 1,
        keywords: Optional[List[str]] = None,
        allowed_hosts: Optional[List[str]] = None,
    ):
        super().__init__(
            max_pages=max_pages,
            keywords=keywords or list(self.DEFAULT_KEYWORDS),
            allowed_hosts=allowed_hosts,
        )

    def list_page(self, page: int) -> str:
        return f"https://www.cie.org.cn/list_43/" if page == 1 else f"https://www.cie.org.cn/list_43_{page}/"

    def parse_list(self, html: str) -> List[Notice]:
        soup = BeautifulSoup(html, "html.parser")
        out: List[Notice] = []
        for li in soup.select("ul.headlines-list li"):
            a = li.find("a", href=True)
            if not a:
                continue
            href = urljoin(self.base, a["href"])
            title = a.get_text(" ", strip=True)
            span = li.find("span")
            published = parse_cn_date(span.get_text(strip=True)) if span else None
            out.append(
                Notice(
                    source=self.name,
                    source_key=self.key,
                    title=title,
                    url=href,
                    published=published,
                    uid=make_uid(self.key, extract_ident(href, title)),
                )
            )
        return out

    def enrich(self, notice: Notice) -> Notice:
        soup = self._detail_soup(notice)
        if soup is None:
            return notice

        body = soup.select_one(".headlines-news-content")
        if body:
            notice.summary = notice.summary or clean_text(body.get_text(" ", strip=True), 300)
            for a in body.find_all("a", href=True):
                text = a.get_text(" ", strip=True)
                if "附件" in text or re.search(r"\.(pdf|docx?|xlsx?|zip|rar)$", text, re.I):
                    notice.attachments.append(Attachment(text or "附件", urljoin(self.base, a["href"])))
        return notice


REGISTRY = {
    CpipcSource.key: CpipcSource,
    CieSource.key: CieSource,
}


def build_sources(config: dict) -> List[BaseSource]:
    """按 config.yaml 里 sources 段的顺序构造数据源实例。"""
    sources: List[BaseSource] = []
    for item in config.get("sources", []):
        if not item.get("enabled", True):
            continue
        cls = REGISTRY.get(item.get("key", ""))
        if cls is None:
            log.warning("未知数据源 %s，已跳过", item.get("key"))
            continue
        sources.append(
            cls(
                max_pages=int(item.get("max_pages", 1)),
                keywords=item.get("keywords"),
                allowed_hosts=item.get("allowed_hosts"),
            )
        )
    return sources
