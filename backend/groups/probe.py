"""Fetch public notification sources with URL and robots.txt checks."""

from __future__ import annotations

import http.client
import ipaddress
import re
import socket
import ssl
import time
from collections import OrderedDict
from urllib.parse import parse_qsl, quote, urljoin, urlsplit
from xml.etree import ElementTree

from bs4 import BeautifulSoup

from ..crawl.fetch import DEFAULT_UA
from ..crawl.robots import parse

ROBOTS_AGENT = "MeoNotifier"
MAX_BYTES = 1024 * 1024
KEY_NAMES = re.compile(r"token|key|secret|pass|auth|signature|session", re.IGNORECASE)


class Blocked(ValueError):
    """The site policy or public-network boundary prevents the request."""


def public_url(url: str):
    parsed = urlsplit(url)
    if (
        parsed.scheme not in ("http", "https") or not parsed.hostname
        or parsed.username is not None or parsed.password is not None
        or parsed.port not in (None, 443 if parsed.scheme == "https" else 80)
        or any(KEY_NAMES.search(k) for k, _ in parse_qsl(parsed.query))
        or any(ord(c) < 32 or c == "\\" for c in url)
    ):
        raise Blocked("网址含凭据、敏感查询参数或不受支持的协议和端口。")
    return parsed


def request_page(url: str) -> tuple[int, str, str, bytes]:
    parsed = public_url(url)
    host = parsed.hostname.encode("idna").decode("ascii")
    port = 443 if parsed.scheme == "https" else 80
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not addresses or any(
        not ipaddress.ip_address(item[4][0]).is_global
        or ipaddress.ip_address(item[4][0]).is_multicast for item in addresses
    ):
        raise Blocked("网址解析到了非公网地址。")

    conn = http.client.HTTPConnection(host, port, timeout=8)
    # Use the validated address directly and keep the original hostname for TLS and Host.
    sock = socket.create_connection(addresses[0][4][:2], timeout=8)
    try:
        if parsed.scheme == "https":
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
        conn.sock = sock
        target = quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~")
        if parsed.query:
            target += "?" + quote(parsed.query, safe="=%&+/?@:!$'()*;,.-_~")
        conn.request("GET", target, headers={"User-Agent": DEFAULT_UA, "Accept-Encoding": "identity"})
        with conn.getresponse() as response:
            location = response.getheader("Location", "")
            content_type = response.getheader("Content-Type", "")
            if response.status != 200:
                return response.status, location, content_type, b""
            chunks = bytearray()
            deadline = time.monotonic() + 8
            while len(chunks) <= MAX_BYTES and time.monotonic() < deadline:
                chunk = response.read1(min(65536, MAX_BYTES + 1 - len(chunks)))
                if not chunk:
                    return response.status, location, content_type, bytes(chunks)
                chunks.extend(chunk)
            raise ValueError("响应超过大小或时长上限。")
    finally:
        conn.close()
        sock.close()


class SiteProbe:
    def __init__(self):
        self.rules = {}
        self.documents = OrderedDict()
        self.hints = {}
        self.last_request = {}

    def download(self, url: str, check_rules: bool = True):
        for _ in range(6):
            target = public_url(url)
            if check_rules:
                origin = f"{target.scheme}://{target.netloc}"
                if origin not in self.rules:
                    status, _, data = self.download(origin + "/robots.txt", False)
                    if status not in (200, 404, 410):
                        raise Blocked("robots.txt 暂不可用，等待下轮检查。")
                    self.rules[origin] = parse(data.decode("utf-8-sig", "replace"), ROBOTS_AGENT)
                path = target.path or "/"
                path += "?" + target.query if target.query else ""
                path = re.sub(
                    r"%([0-9A-Fa-f]{2})",
                    lambda match: chr(int(match[1], 16))
                    if chr(int(match[1], 16)) in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
                    else match[0].upper(),
                    path,
                )
                if not self.rules[origin].allows(quote(path, safe="/%?=&:@!$'()*+,;[]-._~")):
                    raise Blocked("robots.txt 禁止抓取这个地址。")
            host = target.hostname
            delay = self.last_request.get(host, 0) + 0.5 - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            self.last_request[host] = time.monotonic()
            status, location, content_type, data = request_page(url)
            if status not in (301, 302, 303, 307, 308) or not location:
                return status, content_type, data
            url = urljoin(url, location)
        raise Blocked("网址重定向次数过多。")

    def sample(self, url: str) -> tuple[str, str]:
        if url in self.documents:
            self.documents.move_to_end(url)
            return self.documents[url]
        value = self.extract(url)
        self.documents[url] = value
        if len(self.documents) > 16:
            self.documents.popitem(last=False)
        return value

    def extract(self, url: str, discover: bool = True) -> tuple[str, str]:
        status, kind, data = self.download(url)
        if status != 200:
            raise ValueError(f"来源返回 HTTP {status}。")
        if not any(value in kind.lower() for value in ("text/", "xml", "json")):
            raise ValueError("当前支持 HTML、文本、RSS/Atom 和 JSON 页面。")
        parsed = public_url(url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        if origin not in self.hints:
            try:
                status, _, hints = self.download(origin + "/llms.txt")
                self.hints[origin] = hints[:4000].decode("utf-8", "replace") if status == 200 else ""
            except (ValueError, OSError, http.client.HTTPException):
                self.hints[origin] = ""
        if "xml" in kind.lower() or re.search(rb"<(?:rss|feed)(?:\s|>)", data[:500]):
            if b"<!doctype" in data.lower():
                raise ValueError("XML 含不受支持的文档类型。")
            try:
                root = ElementTree.fromstring(data)
            except ElementTree.ParseError as error:
                raise ValueError("无法解析 RSS/Atom。") from error
            if root.tag.split("}")[-1] not in ("rss", "feed"):
                raise ValueError("此 XML 不是受支持的 RSS/Atom。")
            entries = []
            for item in root.iter():
                if item.tag.split("}")[-1] in ("item", "entry"):
                    fields = [f"{node.tag.split('}')[-1]}: {node.attrib.get('href', '')} {''.join(node.itertext()).strip()}"
                              for node in item if node.tag.split("}")[-1] in
                              ("title", "id", "guid", "link", "updated", "pubDate", "description", "summary")]
                    entries.append(" | ".join(fields))
            text = "\n".join(entries[:100]) or "订阅源当前没有条目。"
            return text, self.hints[origin]
        parser = BeautifulSoup(data, "html.parser")
        if discover:
            for link in parser.select('link[rel~="alternate"][href]'):
                if link.get("type", "").lower() not in ("application/rss+xml", "application/atom+xml"):
                    continue
                candidate = urljoin(url, link["href"])
                parts = urlsplit(candidate)
                if (parts.scheme, parts.netloc) != (parsed.scheme, parsed.netloc):
                    continue
                try:
                    return self.extract(candidate, discover=False)
                except (ValueError, OSError, http.client.HTTPException):
                    break
        for node in parser.select("script, style, nav, footer, header, aside, noscript"):
            node.decompose()
        content = parser.select_one("main, article, [role=main]") or parser
        # Include link destinations so list changes with identical titles remain detectable.
        links = [
            f"{anchor.get_text(' ', strip=True)} {anchor['href']}"
            for anchor in content.select("a[href]")[:100]
        ]
        text = " ".join(content.stripped_strings) + "\n" + "\n".join(links)
        text = text.strip()
        if not text:
            raise ValueError("没有提取到正文。")
        return text, self.hints[origin]
