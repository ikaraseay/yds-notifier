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

import re
from typing import Dict, List, Sequence

# ---------------------------------------------------------------------------
# 主题赛事（来源：研创网页脚「主题赛事」菜单，顺序与官方一致）
# ---------------------------------------------------------------------------
CONTESTS: Sequence[str] = (
    "智慧城市技术与创意设计大赛",
    "未来飞行器创新大赛",
    "数学建模竞赛",
    "电子设计竞赛",
    "创“芯”大赛",
    "EDA精英挑战赛",
    "人工智能创新大赛",
    "机器人创新设计大赛",
    "能源装备创新设计大赛",
    "公共管理案例大赛",
    "乡村振兴科技强农+创新大赛",
    "网络安全创新大赛",
    "“双碳”创新与创意大赛",
    "金融科技创新大赛",
    "“美丽中国”创新设计大赛",
    "企业管理创新大赛",
    "操作系统开源创新大赛",
    "“文化中国”两创大赛",
    "国际中文教育案例大赛",
    "智能建造创新大赛",
)

# 标题里的简称 / 别称 → 标准赛事名（长的放前面，避免「创芯」抢先匹配「创芯EDA」）
CONTEST_ALIASES: Sequence[tuple[str, str]] = (
    ("eda精英挑战赛", "EDA精英挑战赛"),
    ("eda", "EDA精英挑战赛"),
    ("创芯大赛", "创“芯”大赛"),
    ("创“芯”", "创“芯”大赛"),
    ("研电赛", "电子设计竞赛"),
    ("电子设计竞赛", "电子设计竞赛"),
    ("智慧城市", "智慧城市技术与创意设计大赛"),
    ("未来飞行器", "未来飞行器创新大赛"),
    ("数学建模", "数学建模竞赛"),
    ("人工智能创新大赛", "人工智能创新大赛"),
    ("机器人创新设计", "机器人创新设计大赛"),
    ("能源装备", "能源装备创新设计大赛"),
    ("公共管理案例", "公共管理案例大赛"),
    ("乡村振兴", "乡村振兴科技强农+创新大赛"),
    ("网络安全创新", "网络安全创新大赛"),
    ("双碳", "“双碳”创新与创意大赛"),
    ("金融科技", "金融科技创新大赛"),
    ("美丽中国", "“美丽中国”创新设计大赛"),
    ("企业管理创新", "企业管理创新大赛"),
    ("操作系统开源", "操作系统开源创新大赛"),
    ("文化中国", "“文化中国”两创大赛"),
    ("国际中文教育", "国际中文教育案例大赛"),
    ("智能建造", "智能建造创新大赛"),
)
DEFAULT_CONTEST = "电子设计竞赛"

# 主题赛事 → 研创网赛事 id（取自页脚「主题赛事」链接的 /cw/hp/<id>）。
# 数字 id 与 uuid 都能拼进 /cw/contestNews/list/<id>/<page>。
# 乡村振兴大赛官网暂无独立专区（页脚为 #），留空表示跳过。
CONTEST_IDS: Dict[str, str] = {
    "智慧城市技术与创意设计大赛": "1",
    "未来飞行器创新大赛": "3",
    "数学建模竞赛": "4",
    "电子设计竞赛": "6",
    "创“芯”大赛": "10",
    "EDA精英挑战赛": "2c9080158ee9c272018f229208b610a6",
    "人工智能创新大赛": "2c9088a5696cbf370169a3f8101510bd",
    "机器人创新设计大赛": "2c9088a5696cbf370169a3f8934810be",
    "能源装备创新设计大赛": "7",
    "公共管理案例大赛": "8",
    "乡村振兴科技强农+创新大赛": "",
    "网络安全创新大赛": "2c90800c8093eef401809d33b36f0652",
    "“双碳”创新与创意大赛": "2c90800c8093eef401809d348f8b0653",
    "金融科技创新大赛": "2c90800c8093eef401809d3501080654",
    "“美丽中国”创新设计大赛": "2c908018876ef068018774a9501a03fe",
    "企业管理创新大赛": "2c90801786cfa2b60186de4143390279",
    "操作系统开源创新大赛": "2c9080178c7c917b018d1b1a0af61cd6",
    "“文化中国”两创大赛": "2c9080178e896671018e97ce7525018b",
    "国际中文教育案例大赛": "2c9080158e2ad864018e5fa55a450c49",
    "智能建造创新大赛": "2c90801795a92a850195d03b537b1bac",
}

# ---------------------------------------------------------------------------
# 阶段
# ---------------------------------------------------------------------------
STAGES: Sequence[str] = (
    "报名", "资格审查", "缴费", "提交作品", "评审",
    "决赛", "公示", "获奖", "报销", "承办", "动态", "其他",
)

# 判断顺序很重要：先匹配「报销 / 发票」，否则会被「决赛」抢走
STAGE_KEYWORDS: Sequence[tuple[str, Sequence[str]]] = (
    ("报销", ("报销", "发票", "开票", "票据", "费用", "会务费")),
    ("承办", ("承办", "申办", "征集", "组委会", "秘书处")),
    ("公示", ("公示", "名单公布", "获奖名单", "成绩公布", "结果公布", "入选名单")),
    ("获奖", ("获奖", "证书", "奖项", "一等奖", "二等奖", "三等奖", "冠军")),
    ("资格审查", ("资格审查", "资格审核", "资格复审", "审核")),
    ("缴费", ("缴费", "交费", "报名费", "付款", "支付")),
    ("提交作品", ("提交作品", "作品提交", "材料提交", "上传作品", "提交截止", "作品上传")),
    ("评审", ("评审", "初审", "初赛", "答辩", "复核", "专家", "函评", "会评")),
    ("决赛", ("总决赛", "决赛", "颁奖", "闭幕", "开赛")),
    ("报名", ("报名", "参赛报名", "报名系统", "注册", "赛题", "章程", "参赛说明", "启动")),
    ("动态", ("倒计时", "开幕", "落幕", "圆满", "花絮", "侧记", "风采", "回顾", "贺信", "大学计划")),
)

# 阶段 → 默认关注人群
STAGE_AUDIENCES: Dict[str, Sequence[str]] = {
    "报名": ("student", "advisor"),
    "资格审查": ("admin", "student"),
    "缴费": ("admin", "student", "advisor"),
    "提交作品": ("student", "advisor"),
    "评审": ("student", "advisor", "admin"),
    "决赛": ("student", "advisor"),
    "公示": ("student", "advisor", "admin"),
    "获奖": ("student", "advisor", "admin"),
    "报销": ("student", "advisor", "admin"),
    "承办": ("admin", "organizer"),
    "动态": ("student", "advisor"),
    "其他": ("student", "advisor", "admin"),
}

AUDIENCES: Sequence[str] = ("student", "advisor", "admin", "organizer")
AUDIENCE_NAMES: Dict[str, str] = {
    "student": "参赛学生",
    "advisor": "指导教师",
    "admin": "培养单位",
    "organizer": "分赛区 / 承办方",
}

# 标题里出现这些词时，强制追加对应人群
AUDIENCE_HINTS: Sequence[tuple[str, str]] = (
    ("培养单位", "admin"),
    ("研究生院", "admin"),
    ("学院", "admin"),
    ("指导教师", "advisor"),
    ("导师", "advisor"),
    ("分赛区", "organizer"),
    ("赛区", "organizer"),
    ("承办", "organizer"),
)

# 需要「倒计时提醒」的阶段（日程提醒只对这些阶段生成）
DEADLINE_STAGES: Sequence[str] = ("报名", "提交作品", "缴费", "资格审查")


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
    return {
        "报名": "确认参赛资格，按通知要求完成报名",
        "资格审查": "留意审核结果，材料不全及时补交",
        "缴费": "在规定时间内完成缴费，保存凭证",
        "提交作品": "按格式要求提交作品与附件，避免截止前拥堵",
        "评审": "关注评审安排，准备答辩材料",
        "决赛": "确认决赛时间地点，提前安排行程",
        "公示": "核对名单信息，有异议按渠道反馈",
        "获奖": "下载证书 / 获奖文件，按要求归档",
        "报销": "按报销文件准备票据，注意开票时限",
        "承办": "按征集要求准备申办材料",
        "动态": "",
        "其他": "",
    }.get(stage, "")
