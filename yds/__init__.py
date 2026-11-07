"""研电赛通知订阅器。

每天两轮（10:00 / 20:00）：抓取 → 赛事状态判定 → 去重 → AI 分析 → 邮件分发，
并把归档 / RSS / 日历同步给 Cloudflare Worker。状态默认存 Cloudflare R2。

主要模块：`main` 编排、`sources` 数据源、`contests` 赛事状态、`ai/` 分析、
`state` 去重、`mailer` / `dispatch` 发信、`publish` 归档同步、`store/` 状态后端。
"""

__version__ = "1.0.0"
