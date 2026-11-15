"""赛事 / 阶段 / 人员视角的确定性推断。

设计原则与日期抽取一致：**规则能定的绝不留白，AI 只做规则覆盖不到的语义判断**。
- 即使不配置 AI，`contest` / `stage` / `audiences` 也能从标题与来源推断出来；
- AI（提示词 v2）给出的结果优先，规则只在字段为空时补位；
- 枚举值全部收敛在本文件，Prompt、邮件、Worker 都引用同一套定义。

人员视角（audience）说明：
    student   参赛学生：报名、赛题、提交、答辩、获奖
    advisor   指导教师：组队、指导、评审、证书、报销
    admin     培养单位管理员：资格审核、缴费、统计、获奖名单、承办
    organizer 分赛区 / 承办方：分赛区资讯、承办征集、赛程协调
"""

from __future__ import annotations

import json
import re
from typing import Dict, List, Sequence

from ..skills import load_skill

# ---------------------------------------------------------------------------
# 主题赛事：从 skills/yds/contests.json 读取（跨端单一事实源）
#
# 过去 Python 与 Worker 各自硬编码一份赛事清单，靠 selftest 去「解析 auth.ts
# 的源码文本」比对——两端都可能改漏，测试也只是事后对齐，属于典型的契约漂移。
# 现在只有一个 JSON，Python 运行时读、Worker 构建期内联，改赛事只改一处。
# ---------------------------------------------------------------------------
SKILL = load_skill()
CONTRACTS = SKILL.contests


def _load_contests() -> List[dict]:
    with open(CONTRACTS, encoding="utf-8") as fh:
        raw = json.load(fh)
    rows = raw.get("contests")
    if not isinstance(rows, list) or not rows:
        raise RuntimeError(f"赛事契约缺少 contests 数组：{CONTRACTS}")
    return [
        {"name": str(r.get("name") or "").strip(), "zoneId": str(r.get("zoneId") or "").strip()}
        for r in rows
        if isinstance(r, dict) and str(r.get("name") or "").strip()
    ]


_CONTESTS = _load_contests()

# 顺序与官方页脚一致：邮件「按赛事汇总」与后台勾选面板都按这个顺序展示
CONTESTS: Sequence[str] = tuple(c["name"] for c in _CONTESTS)

# 主题赛事 → 研创网赛事 id（取自页脚「主题赛事」链接的 /cw/hp/<id>）。
# 数字 id 与 uuid 都能拼进 /cw/contestNews/list/<id>/<page>。
# 乡村振兴大赛官网暂无独立专区（页脚为 #），zoneId 为空表示跳过。
CONTEST_IDS: Dict[str, str] = {c["name"]: c["zoneId"] for c in _CONTESTS}

with (SKILL.directory / "personas.json").open(encoding="utf-8") as file:
    _RULES = json.load(file)

# 顺序决定别名、阶段关键词和主要收件人分区的匹配优先级。
CONTEST_ALIASES: Sequence[tuple[str, str]] = tuple(tuple(rule) for rule in _RULES["aliases"])
DEFAULT_CONTEST = "电子设计竞赛"
STAGES: Sequence[str] = tuple(_RULES["stages"])
STAGE_KEYWORDS: Sequence[tuple[str, Sequence[str]]] = tuple(
    (stage, tuple(keywords)) for stage, keywords in _RULES["stageKeywords"]
)
STAGE_AUDIENCES: Dict[str, Sequence[str]] = {
    stage: tuple(audiences) for stage, audiences in _RULES["stageAudiences"].items()
}
AUDIENCE_NAMES: Dict[str, str] = _RULES["audienceNames"]
AUDIENCES: Sequence[str] = tuple(AUDIENCE_NAMES)
AUDIENCE_HINTS: Sequence[tuple[str, str]] = tuple(tuple(rule) for rule in _RULES["audienceHints"])
DEADLINE_STAGES: Sequence[str] = tuple(_RULES["deadlineStages"])


def normalize_contest(raw: str) -> str:
    """把 AI / 标题给出的赛事名收敛到标准名；识别不了返回空串。"""
    text = (raw or "").strip()
    if not text:
        return ""
    if text in CONTESTS:
        return text
    # 官网标题里常有「创 “芯” 大赛」这类空格，比对前统一去掉空白
    low = re.sub(r"\s+", "", text).lower()
    for alias, name in CONTEST_ALIASES:
        if re.sub(r"\s+", "", alias) in low:
            return name
    return ""


def infer_contest(title: str, source: str = "", declared: str = "") -> str:
    """优先用配置/数据源声明的赛事，其次标题，最后来源名。

    识别不出时返回空串，而不是硬塞「电子设计竞赛」——
    大赛通知栏目同时覆盖 19 项赛事，猜错比留空更糟。
    """
    got = normalize_contest(declared)
    if got:
        return got
    got = normalize_contest(title)
    if got:
        return got
    return normalize_contest(source)


def infer_stage(title: str, category: str = "", body: str = "") -> str:
    """按标题判断阶段；标题看不出时才看分类与正文前缀。"""
    text = title or ""
    # 回顾 / 宣传类先判定，避免「总决赛圆满落幕」被当成需要行动的决赛通知
    if any(k in text for k in ("倒计时", "圆满", "落幕", "回顾", "花絮", "侧记",
                               "风采", "贺信", "大学计划", "签约", "缅怀")):
        return "动态"
    low = text.lower()
    for stage, keys in STAGE_KEYWORDS:
        if any(k.lower() in low for k in keys):
            return stage
    # 标题没写，退一步看正文前 300 字（AI 关闭时也能有基本判断）
    head = (body or "")[:300]
    for stage, keys in STAGE_KEYWORDS:
        if any(k in head for k in keys):
            return stage
    if category == "报名参赛":
        return "报名"
    if category == "评审与名单":
        return "评审"
    if category == "决赛与收官":
        return "决赛"
    if category == "赛事动态":
        return "动态"
    return "其他"


def infer_audiences(stage: str, title: str, declared: Sequence[str] | None = None) -> List[str]:
    """阶段给基础人群，标题里的「培养单位 / 导师 / 分赛区」再补充。"""
    ordered: List[str] = []
    for a in (declared or []):
        if a in AUDIENCES and a not in ordered:
            ordered.append(a)
    for a in STAGE_AUDIENCES.get(stage, STAGE_AUDIENCES["其他"]):
        if a not in ordered:
            ordered.append(a)
    # 动态类默认不全员打扰：只保留学生 / 导师，除非标题明确点名管理员
    for hint, audience in AUDIENCE_HINTS:
        if hint in (title or "") and audience not in ordered:
            ordered.append(audience)
    if stage == "动态":
        ordered = [a for a in ordered if a in ("student", "advisor")]
    return ordered


def audience_labels(values: Sequence[str]) -> str:
    return " / ".join(AUDIENCE_NAMES.get(v, v) for v in (values or []))


def primary_audience(values: Sequence[str]) -> str:
    """邮件分区用：按固定优先级取第一个人群，保证同一封邮件里不重复出现。"""
    for a in AUDIENCES:
        if a in (values or []):
            return a
    return "general"


def action_for(stage: str, title: str = "") -> str:
    """规则兜底的「你要做什么」，AI 有输出时以其为准。"""
    return _RULES["actions"].get(stage, "")
