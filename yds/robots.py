"""robots.txt 的最小实现（对齐 RFC 9309 的常用子集）。

只做三件事：

1. **解析分组**：把 `User-agent` + `Allow` / `Disallow` 组成规则组；
2. **选组**：优先取与我们 UA 最匹配（最长子串）的那一组，没有就用 `*`；
3. **判定**：路径匹配按「最长模式优先，等长时 Allow 胜过 Disallow」，
   支持 `*` 通配与 `$` 结尾锚定。

不在本项目范围内的：Crawl-delay（各家实现不一）、Sitemap、请求速率协商。
抓取失败 / 无 robots.txt 的判定在调用方（yds/fetch.py）按放行处理。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Pattern, Tuple


@dataclass
class RobotsRules:
    """一组已选中的规则。`rules` 为 (是否允许, 模式) 元组序列。"""

    rules: Tuple[Tuple[bool, str], ...] = ()
    pattern_cache: List[Tuple[bool, str, Pattern[str]]] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.pattern_cache = [
            (allow, raw, _compile(raw)) for allow, raw in self.rules
        ]

    def allows(self, path: str) -> bool:
        """给定 URL 路径，判断是否允许抓取。空规则 = 全站放行。"""
        target = path or "/"
        if not target.startswith("/"):
            target = "/" + target
        best_len = -1
        verdict = True
        for allow, raw, regex in self.pattern_cache:
            if not regex.match(target):
                continue
            # 最长匹配优先；等长时 Allow 覆盖 Disallow（RFC 9309 §2.2.2）
            if len(raw) > best_len or (len(raw) == best_len and allow):
                best_len = len(raw)
                verdict = allow
        return verdict

    @property
    def empty(self) -> bool:
        return not self.rules


def _compile(pattern: str) -> Pattern[str]:
    """把 robots 模式编译成正则：`*` → `.*`，结尾 `$` → 行尾锚定。"""
    anchored = pattern.endswith("$")
    body = pattern[:-1] if anchored else pattern
    # 逐段转义，再还原通配符，避免 `?`、`.` 等被当成元字符
    parts = [re.escape(p) for p in body.split("*")]
    regex = ".*".join(parts)
    return re.compile("^" + regex + ("$" if anchored else ""))


def parse(text: str, ua_token: str = "*") -> RobotsRules:
    """解析 robots.txt，返回适用于 `ua_token` 的规则组。

    `ua_token` 传完整的 UA 字符串即可：按「UA 里含有的 agent 名」匹配，
    取最长的那个（例如 `yds-notifier` 比 `*` 更具体）。
    """
    groups: List[Tuple[List[str], List[Tuple[bool, str]]]] = []
    agents: List[str] = []
    rules: List[Tuple[bool, str]] = []
    seen_rule = False

    for raw_line in (text or "").splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, val = line.split(":", 1)
        key = key.strip().lower()
        val = val.strip()
        if key == "user-agent":
            if seen_rule:  # 上一条规则组已结束
                groups.append((agents, rules))
                agents, rules, seen_rule = [], [], False
            agents.append(val.lower())
        elif key in ("allow", "disallow"):
            seen_rule = True
            if not val:  # `Disallow:` 空值 = 不限制
                continue
            rules.append((key == "allow", val))
    if agents:
        groups.append((agents, rules))

    if not groups:
        return RobotsRules()

    token = (ua_token or "*").lower()
    best: Tuple[int, List[Tuple[bool, str]]] | None = None
    wildcard: List[Tuple[bool, str]] = []
    for names, grp_rules in groups:
        for name in names:
            if name == "*":
                wildcard.extend(grp_rules)
                continue
            if name and name in token:
                if best is None or len(name) > best[0]:
                    best = (len(name), grp_rules)
    chosen = best[1] if best else wildcard
    return RobotsRules(tuple(chosen))
