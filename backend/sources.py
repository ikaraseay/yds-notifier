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
from .personas import CONTEST_IDS

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
    """研电赛（电子设计竞赛）专区通知。

    地址形如 /cw/contestNews/list/6/1 —— 6 是「电子设计竞赛」的赛事 id，
    其他主题赛事把 contest 改成 1/3/4/10… 即可复用。
    """

    key = "cpipc"
    name = "研创网·研电赛"
    base = "https://cpipc.acge.org.cn/"
    LIST_TPL = "https://cpipc.acge.org.cn/cw/contestNews/list/{contest}/{page}"

    def __init__(
        self,
        max_pages: int = 1,
        keywords: Optional[List[str]] = None,
        allowed_hosts: Optional[List[str]] = None,
        contest: int = 6,
    ):
        super().__init__(max_pages=max_pages, keywords=keywords, allowed_hosts=allowed_hosts)
        self.contest = int(contest)

    def list_page(self, page: int) -> str:
        return self.LIST_TPL.format(contest=self.contest, page=page)

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
            full = clean_text(body.get_text(" ", strip=True), 6000)
            # raw_body 只作 AI 输入，不进 payload / seen.json / 邮件；
            # summary 保持原有逻辑，避免改变 detail_hash 而误报内容更新
            notice.raw_body = full
            notice.summary = notice.summary or clean_text(body.get_text(" ", strip=True))
            for a in body.find_all("a", href=True):
                text = a.get_text(" ", strip=True)
                if "附件" in text or re.search(r"\.(pdf|docx?|xlsx?|zip|rar)$", text, re.I):
                    notice.attachments.append(Attachment(text or "附件", urljoin(self.base, a["href"])))
        return notice


# --------------------------------------------------------------------------
# 研创网「大赛资讯」栏目：大赛通知 / 大赛新闻 / 大赛文件
# --------------------------------------------------------------------------
class CpipcPwSource(BaseSource):
    """研创网全站级栏目，覆盖 20 项主题赛事的公共通知。

    这些页面与赛区专区的结构一致（`ul#news_list li.li`），
    区别只在详情页正文容器同样是 `.articleContent`，因此共用一个解析器。
    """

    key = "cpipc_pw"
    base = "https://cpipc.acge.org.cn/"
    LIST_TPL = "https://cpipc.acge.org.cn/pw/{channel}/list/{page}"
    NAMES = {
        "notice": "研创网·大赛通知",
        "news": "研创网·大赛新闻",
        "document": "研创网·大赛文件",
    }

    def __init__(
        self,
        max_pages: int = 1,
        keywords: Optional[List[str]] = None,
        allowed_hosts: Optional[List[str]] = None,
        channel: str = "notice",
    ):
        self.channel = channel if channel in self.NAMES else "notice"
        self.name = self.NAMES[self.channel]
        super().__init__(max_pages=max_pages, keywords=keywords, allowed_hosts=allowed_hosts)

    def list_page(self, page: int) -> str:
        return self.LIST_TPL.format(channel=self.channel, page=page)

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
                    source_key=f"{self.key}_{self.channel}",
                    title=title,
                    url=href,
                    published=published,
                    summary=summary,
                    uid=make_uid(f"{self.key}_{self.channel}", extract_ident(href, title)),
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
            full = clean_text(body.get_text(" ", strip=True), 6000)
            notice.raw_body = full
            notice.summary = notice.summary or clean_text(body.get_text(" ", strip=True), 300)
            for a in body.find_all("a", href=True):
                text = a.get_text(" ", strip=True)
                if "附件" in text or re.search(r"\.(pdf|docx?|xlsx?|zip|rar)$", text, re.I):
                    notice.attachments.append(Attachment(text or "附件", urljoin(self.base, a["href"])))
        return notice


# --------------------------------------------------------------------------
# 研创网「赛事专区」—— 每项主题赛事自己的 contestNews 列表
# --------------------------------------------------------------------------
class CpipcZonesSource(BaseSource):
    """按赛事 id 抓取各专区通知。

    19 个专区一次全扫是 19 次列表请求；主流程每天两轮、直接一轮全扫
    （或只扫订阅者关注的赛事），不使用游标分片。
    `per_run` / `offset` 轮询能力保留给需要更低频抓取的自建实例。
    """

    key = "cpipc_zones"
    name = "研创网·赛事专区"
    base = "https://cpipc.acge.org.cn/"
    LIST_TPL = "https://cpipc.acge.org.cn/cw/contestNews/list/{cid}/{page}"

    def __init__(
        self,
        max_pages: int = 1,
        keywords: Optional[List[str]] = None,
        allowed_hosts: Optional[List[str]] = None,
        contests: Optional[List[str]] = None,
        per_run: int = 4,
        offset: int = 0,
    ):
        super().__init__(max_pages=max_pages, keywords=keywords, allowed_hosts=allowed_hosts)
        self.all = [str(c) for c in (contests or []) if CONTEST_IDS.get(str(c))]
        self.per_run = max(1, int(per_run))
        self.offset = int(offset) % len(self.all) if self.all else 0
        n = min(self.per_run, len(self.all))
        self.contests = [
            self.all[(self.offset + i) % len(self.all)] for i in range(n)
        ] if self.all else []

    def list_page(self, page: int) -> str:
        # BaseSource 抽象方法要求；实际抓取在 fetch() 里按赛事逐个拼 URL
        cid = CONTEST_IDS.get(self.contests[0], "") if self.contests else ""
        return self.LIST_TPL.format(cid=cid, page=page)

    def parse_list(self, html: str) -> List[Notice]:
        return []

    def _parse(self, html: str, contest: str, cid: str) -> List[Notice]:
        soup = BeautifulSoup(html, "html.parser")
        container = soup.find(id="news_list") or soup
        out: List[Notice] = []
        for li in container.find_all("li", class_="li"):
            a = li.find("a", href=True)
            if not a:
                continue
            href = _strip_page_param(urljoin(self.base, a["href"]))
            title = (a.get("title") or a.get_text(" ", strip=True)).strip()
            day = li.select_one(".day")
            month = li.select_one(".date")
            published = None
            if month:
                raw = month.get_text(strip=True)
                if day:
                    raw = f"{raw}-{day.get_text(strip=True)}"
                published = parse_cn_date(raw)
            summary = clean_text(li.select_one(".t2").get_text(" ", strip=True)) if li.select_one(".t2") else ""
            source_key = f"cpipc_zone_{cid}"
            out.append(
                Notice(
                    source=f"研创网·{contest}",
                    source_key=source_key,
                    title=title,
                    url=href,
                    published=published,
                    summary=summary,
                    uid=make_uid(source_key, extract_ident(href, title)),
                    contest=contest,
                )
            )
        return out

    def fetch(self) -> List[Notice]:
        results: List[Notice] = []
        seen = set()
        for contest in self.contests:
            cid = CONTEST_IDS[contest]
            for page in range(1, self.max_pages + 1):
                url = self.LIST_TPL.format(cid=cid, page=page)
                if not self._url_ok(url):
                    log.error("[%s] 列表页地址不合规，已跳过：%s", contest, url)
                    break
                try:
                    html = fetch.get_text(url)
                except Exception as exc:  # noqa: BLE001
                    log.warning("[%s] 专区第 %s 页抓取失败：%s", contest, page, exc)
                    break
                items = self._parse(html, contest, cid)
                if not items:
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
                log.info("[%s] 第 %s 页解析 %s 条（命中 %s 条）", contest, page, len(items), fresh)
        return results

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
            full = clean_text(body.get_text(" ", strip=True), 6000)
            notice.raw_body = full
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
    DEFAULT_KEYWORDS = ("电子设计竞赛", "研电赛", "研究生电子设计", "创新实践系列大赛", "研究生创新实践")

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
            full = clean_text(body.get_text(" ", strip=True), 6000)
            notice.raw_body = full
            notice.summary = notice.summary or clean_text(body.get_text(" ", strip=True), 300)
            for a in body.find_all("a", href=True):
                text = a.get_text(" ", strip=True)
                if "附件" in text or re.search(r"\.(pdf|docx?|xlsx?|zip|rar)$", text, re.I):
                    notice.attachments.append(Attachment(text or "附件", urljoin(self.base, a["href"])))
        return notice


REGISTRY = {
    CpipcSource.key: CpipcSource,
    CpipcPwSource.key: CpipcPwSource,
    CpipcZonesSource.key: CpipcZonesSource,
    CieSource.key: CieSource,
}


def build_sources(
    config: dict,
    only_contests: Optional[set] = None,
    zone_offset: int = 0,
    first_pass: bool = True,
) -> List[BaseSource]:
    """按 config/config.yaml 里 sources 段的顺序构造数据源实例。

    only_contests：订阅者实际关注的赛事集合（None 表示不限，走 per_run 轮询）；
    zone_offset：赛事专区切片起点，仅自建低频实例按需传入（主流程不传）；
    first_pass：本轮是否为当天第一轮。标记 `runs: daily` 的源只在第一轮抓取，
    用于更新极慢的栏目（年度通知、大赛文件、学会公告）——它们一天最多一条，
    抓两遍纯属重复请求。
    """
    sources: List[BaseSource] = []
    for item in config.get("sources", []):
        if not item.get("enabled", True):
            continue
        if not first_pass and str(item.get("runs", "twice")).lower() == "daily":
            log.info("[%s] 本轮跳过（runs: daily，每天只在第一轮抓取）", item.get("key"))
            continue
        cls = REGISTRY.get(item.get("key", ""))
        if cls is None:
            log.warning("未知数据源 %s，已跳过", item.get("key"))
            continue
        kwargs = dict(
            max_pages=int(item.get("max_pages", 1)),
            keywords=item.get("keywords"),
            allowed_hosts=item.get("allowed_hosts"),
        )
        # 只有对应数据源认识的参数才传，避免基类构造函数报错
        if cls is CpipcSource:
            kwargs["contest"] = int(item.get("contest", 6))
        if cls is CpipcPwSource:
            kwargs["channel"] = str(item.get("channel", "notice"))
        if cls is CpipcZonesSource:
            configured = [str(c) for c in (item.get("contests") or [])]
            if only_contests is not None:
                # 只抓订阅者关注的赛事；没有人关注时这个源整体跳过
                configured = [c for c in configured if c in only_contests]
            if not configured:
                continue
            kwargs["contests"] = configured
            kwargs["per_run"] = len(configured) if only_contests is not None else int(item.get("per_run", 4))
            kwargs["offset"] = 0 if only_contests is not None else zone_offset
        sources.append(cls(**kwargs))
    return sources
