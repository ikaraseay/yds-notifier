"""Offline regressions for the user-controlled URL boundary and change detection."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from .probe import Blocked, SiteProbe, request_page
from .runner import DEFAULT_MONITOR_PROMPT, scan, skill_candidate


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
    with patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 80))]), \
            patch("socket.create_connection"), patch("http.client.HTTPConnection") as http:
        response = MagicMock(status=404)
        http.return_value.getresponse.return_value.__enter__.return_value = response
        request_page("http://source.test/news")
        ua = http.return_value.request.call_args.kwargs["headers"]["User-Agent"]
        assert ua.startswith("Mozilla/5.0 ") and " Chrome/" in ua and ua.endswith(" Safari/537.36")

    with patch("backend.groups.probe.request_page", return_value=(200, "", "text/plain", b"User-agent: *\nDisallow: /news")) as http:
        sources, changes = scan({"enabled": True, "sources": [{"url": url, "prompt": ""}]}, SiteProbe(), client)
        assert sources[0]["status"] == "blocked" and not changes
        assert [item.args[0] for item in http.call_args_list] == ["https://source.test/robots.txt"]

    with patch("backend.groups.probe.request_page", return_value=(200, "", "text/plain", b"User-agent: MeoNotifier\nDisallow: /news")) as http:
        sources, _ = scan({"enabled": True, "sources": [{"url": url, "prompt": ""}]}, SiteProbe(), client)
        assert sources[0]["status"] == "blocked" and http.call_count == 1

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
        assert sources[0]["status"] == "ready" and sources[0]["prompt"] == DEFAULT_MONITOR_PROMPT and not changes
        config = {"enabled": True, "sources": sources}
        _, changes = scan(config, SiteProbe(), client)
        assert not changes
        feed = b"<rss><channel><item><title>Second</title></item></channel></rss>"
        _, changes = scan(config, SiteProbe(), client)
        assert len(changes) == 1 and changes[0]["url"] == url
    old = [{"url": url, "prompt": "奖学金", "sample": "历史公告"}]
    new = [{**old[0], "sample": "奖学金申请延期至 11 月 20 日"}]
    changes = [{"url": url, "summary": "奖学金延期"}]
    skill = {"guidance": "概括实质变化"}
    assert skill_candidate(client, skill, old, new, changes) == {}
    client.cfg.usable = True
    candidate = {"candidate": "标出原文给出的新截止日"}
    improved = {"relevant": True, "summary": "奖学金申请延期至 11 月 20 日"}
    quiet = {"relevant": False}
    with patch("backend.groups.runner.ask", side_effect=[
        candidate, quiet,
    ]) as ai:
        assert skill_candidate(client, skill, old, new, changes) == {"evaluated": True}
        assert ai.call_count == 2
    with patch("backend.groups.runner.ask", side_effect=[candidate, improved, quiet, improved]) as ai:
        assert skill_candidate(client, skill, old, new, changes) == {"evaluated": True}
        assert ai.call_args.kwargs["current"].split() == ai.call_args.kwargs["previous"].split()
    with patch("backend.groups.runner.ask", side_effect=[
        candidate, improved, quiet, quiet, {"improved": True, "evidence": "补充原文的新截止日"},
    ]) as ai:
        assert skill_candidate(client, skill, old, new, changes) == {
            "evaluated": True, **candidate, "evidence": "补充原文的新截止日",
        }
        compared = ai.call_args.kwargs["examples"][0]
        assert compared["baseline"] == changes[0]["summary"] and compared["proposed"] == improved["summary"]
    print("通知组抓取自测通过")


if __name__ == "__main__":
    main()
