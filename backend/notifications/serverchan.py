"""Send a notification to the configured ServerChan account."""

import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen


def send(sendkey: str, title: str, body: str) -> None:
    sc3 = re.fullmatch(r"sctp([0-9]+)t[a-zA-Z0-9_-]+", sendkey)
    if sc3:
        endpoint = f"https://{sc3[1]}.push.ft07.com/send"
    elif re.fullmatch(r"SCT[a-zA-Z0-9_-]+", sendkey):
        endpoint = "https://sctapi.ftqq.com"
    else:
        raise ValueError("SERVERCHAN_SENDKEY 格式无效")

    data = urlencode({"title": title, "desp": body}).encode()
    try:
        with urlopen(f"{endpoint}/{sendkey}.send", data=data, timeout=10) as response:
            result = json.load(response)
    except HTTPError as exc:
        raise ValueError(f"Server 酱返回 HTTP {exc.code}") from None
    except (URLError, OSError, ValueError):
        raise ValueError("Server 酱请求失败或响应无效") from None

    if not isinstance(result, dict) or result.get("code") != 0:
        raise ValueError("Server 酱拒绝推送，请检查控制台的推送记录")


def main() -> int:
    from .. import config  # Loads the project's .env.

    try:
        send(os.getenv("SERVERCHAN_SENDKEY", "").strip(), "MeoNotifier测试", "Server 酱接入测试。")
    except ValueError as exc:
        print(exc)
        return 1
    print("Server 酱已接受测试推送，请在接收端确认。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
