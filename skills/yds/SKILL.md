---
name: yds
description: 维护研电赛的监控来源、赛事赛程、公告提取和通知摘要。修改研电赛采集配置、赛事判定或通知提示词时使用。
---

# 研电赛通知

1. 先确认改动对应来源、赛事判定或通知提取。调整抓取来源、扫描周期或推送窗口时读 [config.yaml](config.yaml)。调整赛事标识和角色时分别读 [contests.json](contests.json) 和 [personas.json](personas.json)。
2. 调整 AI 输出时，先读 [提示词版本说明](prompts/README.md)，再按 [提示词清单](prompts/manifest.yaml) 找到当前版本。新增版本时，以原文支持的字段、日期和链接校验输出。用公告有明确截止日、公告缺少截止日、只有页面版式变动三类样本检查规则。
3. 运行 `python -m backend.selftest`。涉及独立入口时，再运行 `python -m backend --skill yds --help`。
