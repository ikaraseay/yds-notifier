"""Offline regressions for the user-controlled URL boundary and change detection."""

from types import SimpleNamespace
from unittest.mock import patch

from .probe import Blocked, SiteProbe, request_page
from .runner import scan, skill_candidate


def main():
    client = SimpleNamespace(cfg=SimpleNamespace(usable=False))
    with patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("127.0.0.1", 80))]), patch("socket.create_connection") as connect:
        try:
            request_page("http://source.test/")
        except Blocked:
            connect.assert_not_called()
        else:
            raise AssertionError("private address was accepted")

    url = "https://source.test/news"
    with patch("backend.groups.probe.request_page", return_value=(200, "", "text/plain", b"User-agent: *\nDisallow: /news")) as http:
        sources, changes = scan({"enabled": True, "sources": [{"url": url, "prompt": ""}]}, SiteProbe(), client)
        assert sources[0]["status"] == "blocked" and not changes
        assert [item.args[0] for item in http.call_args_list] == ["https://source.test/robots.txt"]

    def fixture(address):
        if address.endswith("/robots.txt") or address.endswith("/llms.txt"):
            return 404, "", "", b""
        if address == url:
            return 200, "", "text/html", b'<link rel="alternate" type="application/rss+xml" href="/feed">'
        assert address == "https://source.test/feed"
        return 200, "", "application/rss+xml", feed

    feed = b"<rss><channel><item><title>First</title></item></channel></rss>"
    with patch("backend.groups.probe.request_page", side_effect=fixture):
        sources, changes = scan({"enabled": True, "sources": [{"url": url, "prompt": ""}]}, SiteProbe(), client)
        assert sources[0]["status"] == "ready" and sources[0]["prompt"] and not changes
        config = {"enabled": True, "sources": sources}
        _, changes = scan(config, SiteProbe(), client)
        assert not changes
        feed = b"<rss><channel><item><title>Second</title></item></channel></rss>"
        _, changes = scan(config, SiteProbe(), client)
        assert len(changes) == 1 and changes[0]["url"] == url
    old = [{"url": url, "prompt": "奖学金", "sample": "历史公告"}]
    new = [{**old[0], "sample": "奖学金申请延期"}]
    changes = [{"url": url, "summary": "奖学金延期"}]
    with patch("backend.groups.runner.ask", side_effect=[
        {"candidate": "标出新截止日"}, {"relevant": True}, {"relevant": False},
        {"relevant": False},
    ]):
        assert not skill_candidate(client, {"guidance": ""}, old, new, changes)
    with patch("backend.groups.runner.ask", side_effect=[
        {"candidate": "标出新截止日"}, {"relevant": True}, {"relevant": True},
        {"relevant": False}, {"improved": True, "evidence": "补充原文的新截止日"},
    ]):
        assert skill_candidate(client, {"guidance": ""}, old, new, changes)["candidate"] == "标出新截止日"
    print("通知组抓取自测通过")


if __name__ == "__main__":
    main()
