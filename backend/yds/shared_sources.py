"""Import changes from the built-in Skill's shared URL monitor."""

import json
import logging
import os
from datetime import datetime, timezone, timedelta

import requests

from ..config import derive_internal_base, settings
from .models import VALID_CATEGORIES, Notice
from .personas import AUDIENCES


def shared_notices():
    base = derive_internal_base(settings.workers_dev_url, settings.public_base_url)
    token = os.getenv("GROUP_RUNNER_TOKEN") or settings.subscribe_api_token
    if not base or not token:
        return []
    try:
        response = requests.get(base + "/api/group-runner", params={"notices": "yds"},
                                headers={"Authorization": "Bearer " + token},
                                timeout=12, allow_redirects=False)
        response.raise_for_status()
        records = response.json()["notices"]
        cutoff = datetime.now(timezone.utc).timestamp() - 2 * 86400
        notices = []
        for record in records:
            # 只接最近两天的新变化：上线首日不会把历史记录一次性群发。
            if record["recorded"] / 1000 < cutoff:
                continue
            change = json.loads(record["payload"])
            types = [label for label in change.get("types") or [] if label in VALID_CATEGORIES]
            roles = [role for role in change.get("roles") or [] if role in AUDIENCES]
            events = []
            event_date = change.get("eventDate")
            if isinstance(event_date, str) and len(event_date) == 10:
                events = [{"date": event_date, "evidence": "共享来源原文中的日期",
                            "label": "原文日期", "kind": "event", "location": "", "confidence": 1.0}]
            notice = Notice(
                source="研电赛共享来源", source_key="yds_shared", uid="yds_shared:" + record["id"],
                url=change["url"], title=change["summary"][:120], summary=change["summary"],
                published=datetime.fromtimestamp(record["recorded"] / 1000, timezone(timedelta(hours=8))).date(),
                audiences=roles, ai_category=types[0] if types else "",
                ai_events=events, ai_version="shared",
            )
            # 共享网址与赛事无关：清掉标题推断出的赛事，并保留来源给出的角色。
            notice.contest = ""
            # 没有角色线索时视为全站通知：否则按角色过滤的订阅者会全部漏收。
            notice.audiences = roles or list(AUDIENCES)
            notices.append(notice)
        return notices
    except (requests.RequestException, ValueError, KeyError, TypeError) as error:
        logging.getLogger("yds").warning("研电赛共享来源读取失败：%s", type(error).__name__)
        return []
