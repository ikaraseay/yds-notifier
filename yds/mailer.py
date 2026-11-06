"""邮件内容渲染（孟菲斯风格）。

设计要点：
- 同时产出纯文本 + HTML 两个版本，国内邮箱兼容性最好。
- HTML 全部用 table 布局 + 内联样式，QQ 邮箱 / 163 / 手机端都能正常显示。
- 奶油纸底色、墨色粗描边、黄/珊瑚/蓝撞色块，与订阅页 `worker/src/ui/styles.ts`
  及 Worker 事务邮件 `worker/src/mailer.ts` 共用同一套孟菲斯视觉系统；
  不使用 emoji，全部用文字与色块表达，保证任何邮件客户端都能正确显示。
- 一封邮件合并本轮所有新通知，避免连发多封被判垃圾邮件。

实际投递方式见 senders.py（Resend API 或 SMTP）。
"""

from __future__ import annotations

import html
import logging
from datetime import datetime
from typing import List, Optional, Sequence
from urllib.parse import quote, urlparse

from .models import Notice
from .personas import AUDIENCE_NAMES, AUDIENCES, primary_audience

log = logging.getLogger("yds")

CATEGORY_ORDER = ("报名参赛", "评审与名单", "决赛与收官", "赛事动态", "其他通知")

# 人员视角分区的主题色（标题直接用角色名，不再加「你需要做什么」这类后缀）
AUDIENCE_COLORS = {
    "student": "#FF6B6B",
    "advisor": "#4D96FF",
    "admin": "#2E2A33",
    "organizer": "#7B9EF8",
}

# 每个分组配主题色（柔和马卡龙色系），不用 emoji，靠色块与文字区分
# 孟菲斯色板：珊瑚/蓝/黄三色区分分类，奶油纸底色
CATEGORY_STYLE = {
    "报名参赛": ("#FF6B6B", "#FFF4E4"),
    "评审与名单": ("#4D96FF", "#FFF4E4"),
    "决赛与收官": ("#2E2A33", "#FFD93D"),
    "赛事动态": ("#FF6B6B", "#FFF4E4"),
    "其他通知": ("#4D96FF", "#FFF4E4"),
}

# 倒计时、回顾类在卡片上标一个小角标，方便一眼跳过
SOFT_BADGE = ("倒计时", "圆满", "落幕", "开幕", "花絮", "侧记")


def sort_notices(notices: Sequence[Notice]) -> List[Notice]:
    """重要度优先，其次日期倒序。"""
    return sorted(
        notices,
        key=lambda n: (n.weight, n.published or datetime.now().date()),
        reverse=True,
    )


def build_subject(notices: Sequence[Notice], prefix: str) -> str:
    """主题行纯文字，靠前缀与条数区分，避免 emoji 在部分客户端显示成方框。"""
    if not notices:
        return prefix
    if any(n.ai_urgency == "critical" for n in notices):
        prefix = "【重要】" + prefix
    first = notices[0]
    if len(notices) == 1:
        return f"{prefix} {first.title}"[:120]
    return f"{prefix} {len(notices)} 条更新 · {first.title}"[:120]


def build_text(notices: Sequence[Notice], site: str = "", unsubscribe_url: str = "") -> str:
    lines = [f"研电赛通知 · 共 {len(notices)} 条\n"]
    for i, n in enumerate(notices, 1):
        flag = "【更新】" if n.change_kind == "changed" else ""
        urgent = "【重要】" if n.ai_urgency == "critical" else ""
        lines.append(f"[{i}] {urgent}{flag}{n.title}")
        lines.append(f"    {n.date_text}｜{n.category}｜{n.stage}｜{n.contest}｜{n.source}")
        if n.audiences:
            lines.append(f"    面向：{' / '.join(AUDIENCE_NAMES.get(a, a) for a in n.audiences)}")
        if n.action:
            lines.append(f"    {n.action}")
        if n.ai_summary or n.summary:
            lines.append(f"    {n.ai_summary or n.summary}")
        for e in n.ai_events[:4]:
            label = e.get("label") or "日程"
            where = f"（{e['location']}）" if e.get("location") else ""
            lines.append(f"    {label}：{e.get('date', '')}{where}")
        lines.append(f"    原文：{n.url}")
        if n.attachments:
            lines.append("    附件：")
            for a in n.attachments:
                lines.append(f"      · {a.name}  {a.url}")
        lines.append("")
    lines.append("--")
    if site:
        lines.append(f"本邮件由「{site}」自动推送，数据来自研创网与中国电子学会官网。")
    if unsubscribe_url:
        lines.append(f"不想再收到？一键退订：{unsubscribe_url}")
    return "\n".join(lines)


def _esc(v: str) -> str:
    return html.escape(v or "", quote=True)


def _safe_url(v: str) -> str:
    """只允许 http/https 链接进入邮件 HTML。

    原文与附件地址来自外部站点解析结果，若不校验 scheme，
    `javascript:` / `data:` 可能被写进 href（安全评审报告 S-13）。
    """
    try:
        p = urlparse(v or "")
    except ValueError:
        return "#"
    if p.scheme.lower() not in ("http", "https") or not p.netloc:
        return "#"
    return v


def _persona_block(notices: Sequence[Notice], roles: Sequence[str] = ()) -> str:
    """邮件顶部按角色分组的摘要，只包含收件人自己订阅的角色。

    `roles` 为空表示「不限制」（站长邮箱或偏好字段缺失），此时才展示全部角色。
    同一条通知只归到它命中的第一个角色下，避免三个视角把同一条重复三遍。
    """
    order = [a for a in AUDIENCES if not roles or a in roles]
    buckets: dict = {a: [] for a in order}
    for n in notices:
        for aud in order:
            if aud in (n.audiences or []):
                buckets[aud].append(n)
                break
    rows = []
    for aud in order:
        items = buckets[aud]
        if not items:
            continue
        # 有明确动作的排前面，动态类垫底
        items.sort(key=lambda n: (0 if n.action else 1, -n.weight))
        color = AUDIENCE_COLORS.get(aud, "#7B9EF8")
        lines = []
        for n in items[:3]:
            action = f'<span style="color:#8a90a2;"> — {_esc(n.action)}</span>' if n.action else ""
            lines.append(
                f'<div style="margin:7px 0 0;font-size:12px;line-height:19px;color:#2b2f3d;">'
                f'<span style="display:inline-block;padding:1px 6px;background:#FFD93D;'
                f'border:1px solid #2E2A33;border-radius:4px;font-size:10px;font-weight:700;'
                f'margin-right:6px;">{_esc(n.stage)}</span>'
                f'<a href="{_esc(_safe_url(n.url))}" style="color:#2b2f3d;text-decoration:none;">'
                f'{_esc(n.title)}</a>{action}</div>'
            )
        rows.append(
            f'<tr><td style="padding:10px 0 0;">'
            f'<div style="font-size:13px;font-weight:700;color:{color};">'
            f'<span style="display:inline-block;width:9px;height:9px;border-radius:2px;'
            f'background:{color};margin-right:7px;vertical-align:middle;"></span>'
            f'{_esc(AUDIENCE_NAMES.get(aud, aud))}'
            f'<span style="color:#b8bccb;font-weight:400;">&nbsp;{len(items)}</span></div>'
            f'{"".join(lines)}</td></tr>'
        )
    if not rows:
        return ""
    return f"""
    <tr><td style="padding:14px 0 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="background:#ffffff;border:3px solid #2E2A33;border-radius:8px;">
        <tr><td style="padding:14px 18px 18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            {''.join(rows)}
          </table>
        </td></tr>
      </table>
    </td></tr>"""


def _contest_groups(notices: Sequence[Notice]) -> List[tuple[str, List[Notice]]]:
    """按赛事分组；组内保持重要度排序，组间按最高权重排序。"""
    groups: dict = {}
    for n in notices:
        groups.setdefault(n.contest or "综合通知", []).append(n)
    return sorted(
        groups.items(),
        key=lambda kv: max(x.weight for x in kv[1]),
        reverse=True,
    )


def _contest_query(name: str, persona: str = "") -> str:
    """拼赛事筛选参数。`base` 可能已带个人日历的 email/token，故要判断分隔符。"""
    q = f"&contest={quote(name)}"
    if persona:
        q += f"&audience={quote(persona)}"
    return q


def _with_query(base: str, query: str) -> str:
    if not base:
        return ""
    if not query:
        return base
    sep = "&" if "?" in base else "?"
    return base + sep + query.lstrip("&")


def _next_event(ns: Sequence[Notice]) -> str:
    from datetime import date as _date

    today = _date.today().isoformat()
    days = sorted(d for n in ns for d in n.event_dates if d >= today)
    if not days:
        days = sorted(d for n in ns for d in n.event_dates)
    return days[0] if days else ""


def _contest_overview(
    notices: Sequence[Notice], calendar_url: str, archive_url: str, persona: str = ""
) -> str:
    """顶部「按赛事汇总」：每项赛事的条数、最近时间节点、日历与归档链接。"""
    rows = []
    for name, ns in _contest_groups(notices)[:8]:
        next_day = _next_event(ns)
        q = _contest_query(name, persona)
        links = []
        if calendar_url:
            links.append(
                f'<a href="{_esc(_safe_url(_with_query(calendar_url, q)))}" style="color:#4D96FF;'
                f'text-decoration:none;font-weight:700;">日历</a>'
            )
        if archive_url:
            links.append(
                f'<a href="{_esc(_safe_url(_with_query(archive_url, q)))}" style="color:#4D96FF;'
                f'text-decoration:none;font-weight:700;">列表</a>'
            )
        next_html = (
            f'<span style="color:#8a90a2;"> · 最近 {_esc(next_day)}</span>'
            if next_day else ""
        )
        link_html = "　" + " · ".join(links) if links else ""
        rows.append(
            f'<tr><td style="padding:7px 0;border-top:1px dashed #d8cfc0;font-size:12px;'
            f'line-height:18px;color:#2b2f3d;">'
            f'<b>{_esc(name)}</b>'
            f'<span style="color:#b8bccb;">&nbsp;{len(ns)} 条</span>'
            f'{next_html}'
            f'{link_html}</td></tr>'
        )
    if not rows:
        return ""
    return f"""
    <tr><td style="padding:14px 0 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="background:#ffffff;border:3px solid #2E2A33;border-radius:8px;">
        <tr><td style="padding:15px 18px 12px;">
          <div style="font-size:12px;color:#8a90a2;letter-spacing:1px;font-weight:700;">
            按赛事汇总 · 点击订阅单个赛事日历</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            {''.join(rows)}
          </table>
        </td></tr>
      </table>
    </td></tr>"""


def _contest_sections(
    notices: Sequence[Notice], calendar_url: str, archive_url: str, persona: str = ""
) -> str:
    """角色版邮件：一个赛事一个区块，区块头带该赛事的日历 / 归档链接。"""
    out: List[str] = []
    for name, ns in _contest_groups(notices):
        q = _contest_query(name, persona)
        links = []
        if calendar_url:
            links.append(
                f'<a href="{_esc(_safe_url(_with_query(calendar_url, q)))}" style="font-size:11px;'
                f'color:#4D96FF;text-decoration:none;font-weight:700;">赛事日历</a>'
            )
        if archive_url:
            links.append(
                f'<a href="{_esc(_safe_url(_with_query(archive_url, q)))}" style="font-size:11px;'
                f'color:#4D96FF;text-decoration:none;font-weight:700;">赛事列表</a>'
            )
        cards = "".join(
            _notice_card(n, only_audiences=(persona,) if persona else ()) for n in ns
        )
        out.append(
            f"""
    <tr><td style="padding:22px 0 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:15px;font-weight:800;color:#2b2f3d;">
          <span style="display:inline-block;width:12px;height:12px;border-radius:3px;
                 background:#FF6B6B;margin-right:8px;vertical-align:middle;
                 border:2px solid #2E2A33;"></span>{_esc(name)}
          <span style="color:#b8bccb;font-weight:400;font-size:13px;">&nbsp;{len(ns)}</span>
        </td>
        <td align="right" style="white-space:nowrap;">{' · '.join(links)}</td>
      </tr></table>
    </td></tr>
    {cards}"""
        )
    return "".join(out)


def _notice_card(n: Notice, compact: bool = False, only_audiences: Sequence[str] = ()) -> str:
    color, soft = CATEGORY_STYLE.get(n.category, ("#7B9EF8", "#EEF3FF"))
    is_soft = any(k in n.title for k in SOFT_BADGE)

    if n.change_kind == "changed":
        badge = (
            f'<span style="display:inline-block;padding:2px 9px;background:#FF6B6B;color:#ffffff;'
            f'font-size:11px;border-radius:4px;margin-left:6px;vertical-align:middle;'
            f'border:1px solid #2E2A33;font-weight:700;">更新</span>'
        )
    elif is_soft:
        badge = (
            f'<span style="display:inline-block;padding:2px 9px;background:#FFD93D;color:#2E2A33;'
            f'font-size:11px;border-radius:4px;margin-left:6px;vertical-align:middle;'
            f'border:1px solid #2E2A33;font-weight:700;">动态</span>'
        )
    else:
        badge = ""

    if n.ai_urgency == "critical":
        badge = (
            f'<span style="display:inline-block;padding:2px 9px;background:#FF6B6B;color:#ffffff;'
            f'font-size:11px;border-radius:4px;margin-left:6px;vertical-align:middle;'
            f'border:1px solid #2E2A33;font-weight:700;">重要</span>' + badge
        )

    # 「低价值动态」在摘要邮件里折叠成一行，不占整张卡片
    if compact:
        return f"""
    <tr><td style="padding:0 0 8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="background:#ffffff;border:2px solid #2E2A33;border-radius:6px;">
        <tr><td style="padding:9px 14px;font-size:12px;color:#5a6072;line-height:19px;">
          <span style="display:inline-block;width:6px;height:6px;border-radius:2px;
                 background:{color};margin-right:7px;vertical-align:middle;"></span>
          <a href="{_esc(_safe_url(n.url))}" style="color:#2b2f3d;text-decoration:none;">{_esc(n.title)}</a>
          <span style="color:#b8bccb;">&nbsp;{_esc(n.date_text)}</span>
        </td></tr>
      </table>
    </td></tr>"""

    attach_block = ""
    if n.attachments:
        rows = "".join(
            f'<div style="margin:5px 0;padding-left:2px;">'
            f'<span style="display:inline-block;width:5px;height:5px;border-radius:50%;'
            f'background:{color};margin-right:8px;vertical-align:middle;"></span>'
            f'<a href="{_esc(_safe_url(a.url))}" style="color:#5a6072;text-decoration:none;'
            f'font-size:12px;line-height:18px;">{_esc(a.name)}</a></div>'
            for a in n.attachments[:8]
        )
        attach_block = (
            f'<tr><td style="padding:12px 18px 0;">'
            f'<div style="background:{soft};border:2px dashed #2E2A33;border-radius:6px;padding:10px 12px;">{rows}</div>'
            f"</td></tr>"
        )

    shown_summary = n.ai_summary or n.summary
    summary_block = (
        f'<tr><td style="padding:10px 18px 0;font-size:13px;color:#5a6072;line-height:21px;">'
        f"{_esc(shown_summary)}</td></tr>"
        if shown_summary
        else ""
    )

    event_block = ""
    if n.ai_events:
        rows = "".join(
            f'<div style="margin:3px 0;">'
            f'<span style="display:inline-block;padding:1px 7px;background:#FFD93D;'
            f'border:1px solid #2E2A33;border-radius:4px;font-size:11px;font-weight:700;">'
            f'{_esc(str(e.get("label") or "日程"))}</span>&nbsp;'
            f'<span style="font-size:12px;color:#2E2A33;">{_esc(str(e.get("date") or ""))}'
            f'{" · " + _esc(str(e["location"])) if e.get("location") else ""}</span></div>'
            for e in n.ai_events[:4]
        )
        event_block = f'<tr><td style="padding:10px 18px 0;">{rows}</td></tr>'

    meta_bits = []
    if n.contest:
        meta_bits.append(n.contest)
    # 只列收件人自己勾选的角色，不把他没收的视角摊在眼前
    shown_auds = [a for a in n.audiences if not only_audiences or a in only_audiences]
    if shown_auds:
        meta_bits.append("面向：" + " / ".join(AUDIENCE_NAMES.get(a, a) for a in shown_auds))
    meta_block = (
        f'<tr><td style="padding:8px 18px 0;font-size:11px;color:#8a90a2;line-height:17px;">'
        f'<span style="display:inline-block;padding:1px 7px;background:#EEF3FF;'
        f'border:1px solid #2E2A33;border-radius:4px;font-weight:700;margin-right:6px;">'
        f'{_esc(n.stage)}</span>{_esc(" · ".join(meta_bits))}</td></tr>'
        if meta_bits else ""
    )
    action_block = (
        f'<tr><td style="padding:10px 18px 0;">'
        f'<div style="background:#FFF4E4;border-left:4px solid #FF6B6B;padding:8px 12px;'
        f'font-size:12px;line-height:18px;color:#2b2f3d;">'
        f'{_esc(n.action)}</div></td></tr>'
        if n.action else ""
    )

    return f"""
    <tr><td style="padding:0 0 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="background:#ffffff;border-radius:8px;border:3px solid #2E2A33;">
        <tr><td style="padding:18px 18px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:12px;color:#a0a4b8;">
              <span style="display:inline-block;width:8px;height:8px;border-radius:2px;
                     background:{color};margin-right:6px;vertical-align:middle;"></span>
              <b>{_esc(n.date_text)}</b>
            </td>
            <td align="right" style="font-size:11px;color:#b8bccb;">{_esc(n.source)}</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:8px 18px 0;">
          <a href="{_esc(_safe_url(n.url))}" style="font-size:16px;line-height:25px;color:#2b2f3d;
             font-weight:600;text-decoration:none;">{_esc(n.title)}</a>{badge}
        </td></tr>
        {meta_block}
        {summary_block}
        {action_block}
        {event_block}
        {attach_block}
        <tr><td style="padding:14px 18px 18px;">
          <a href="{_esc(_safe_url(n.url))}" style="display:inline-block;padding:9px 22px;
             background:{color};color:{"#2E2A33" if color == "#FFD93D" else "#ffffff"};
             border-radius:6px;font-size:13px;font-weight:700;text-decoration:none;
             border:2px solid #2E2A33;">阅读原文 →</a>
        </td></tr>
      </table>
    </td></tr>"""


def build_html(
    notices: Sequence[Notice],
    site: str = "",
    repo_url: str = "",
    unsubscribe_url: str = "",
    issue_url: str = "",
    compact_low: bool = False,
    persona: str = "",
    calendar_url: str = "",
    archive_url: str = "",
    audiences: Sequence[str] = (),
) -> str:
    groups = {c: [] for c in CATEGORY_ORDER}
    for n in notices:
        groups.setdefault(n.category, []).append(n)

    persona_line = ""
    if persona:
        persona_line = (
            f'<div style="padding:6px 0 0;font-size:12px;color:#5a6072;">'
            f'本版面向：{_esc(AUDIENCE_NAMES.get(persona, persona))}</div>'
        )

    blocks: List[str] = []
    for cat in CATEGORY_ORDER:
        items = groups.get(cat) or []
        if not items:
            continue
        color, _ = CATEGORY_STYLE[cat]
        cards = "".join(
            _notice_card(
                n,
                compact=compact_low and n.ai_urgency == "low",
                only_audiences=audiences,
            )
            for n in items
        )
        blocks.append(
            f"""
    <tr><td style="padding:22px 0 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:15px;font-weight:700;color:#2b2f3d;">
          <span style="display:inline-block;width:12px;height:12px;border-radius:3px;
                 background:{color};margin-right:8px;vertical-align:middle;
                 border:2px solid #2E2A33;"></span>{_esc(cat)}
          <span style="color:#b8bccb;font-weight:400;font-size:13px;">&nbsp;{len(items)}</span>
        </td>
        <td align="right" style="font-size:11px;color:#2E2A33;">- - - -</td>
      </tr></table>
    </td></tr>
    {cards}"""
        )

    now = datetime.now()
    greet = _greeting(now)
    count = len(notices)
    # 综合版按栏目分组；角色版按赛事分组，并在顶部给出「按赛事汇总 + 赛事日历入口」
    content_blocks = (
        _contest_sections(notices, calendar_url, archive_url, persona)
        if persona else "".join(blocks)
    )
    overview = _contest_overview(notices, calendar_url, archive_url, persona)
    count_label = (
        "条通知有更新，已为你重新整理" if any(n.change_kind == "changed" for n in notices)
        else "条新通知，已为你整理如下"
    )

    unsub_block = ""
    if unsubscribe_url:
        unsub_block = f"""
    <tr><td align="center" style="padding:26px 0 8px;">
      <a href="{_esc(_safe_url(unsubscribe_url))}"
         style="display:inline-block;padding:11px 28px;background:#fff;color:#2E2A33;
                border:3px solid #2E2A33;border-radius:6px;font-size:13px;
                font-weight:700;text-decoration:none;">一键退订</a>
      <div style="padding:10px 0 0;font-size:11px;color:#b8bccb;line-height:18px;">
        点了之后不会再收到任何邮件，随时可以再回来订阅～
      </div>
    </td></tr>"""

    footer_links = []
    if calendar_url:
        # 个人日历：已按收件人的角色与赛事偏好过滤过，加一次长期有效
        footer_links.append(
            f'<a href="{_esc(_safe_url(calendar_url))}" style="color:#8a90a2;text-decoration:none;">我的日历</a>'
        )
    if repo_url:
        footer_links.append(f'<a href="{_esc(_safe_url(repo_url))}" style="color:#8a90a2;text-decoration:none;">项目主页</a>')
    if issue_url:
        footer_links.append(f'<a href="{_esc(_safe_url(issue_url))}" style="color:#8a90a2;text-decoration:none;">反馈问题</a>')
    footer_links.append('<a href="https://cpipc.acge.org.cn/cw/hp/6" style="color:#8a90a2;text-decoration:none;">研电赛官网</a>')

    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#FFF4E4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
       style="background:#FFF4E4;padding:22px 12px 30px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
       style="max-width:600px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',
              'PingFang SC','Microsoft YaHei',sans-serif;">

  <!-- 头部：柔和渐变 + 软萌问候 -->
  <tr><td style="padding:0 0 6px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:#FFD93D;border:3px solid #2E2A33;border-radius:8px;
                  padding:26px 24px;">
      <tr><td>
        <div style="font-size:12px;color:#2E2A33;letter-spacing:1px;font-weight:700;">研电赛 · 非官方通知</div>
        <div style="padding:8px 0 0;font-size:24px;font-weight:800;color:#2E2A33;
                    line-height:32px;">{_esc(greet)}</div>
        <div style="padding:8px 0 0;font-size:13px;color:#5a6072;line-height:22px;">
          研电赛有 <b style="background:#FF6B6B;color:#fff;padding:1px 8px;
          border-radius:4px;">{count}</b> {count_label}
        </div>
        {persona_line}
      </td></tr>
    </table>
  </td></tr>

  {'' if persona else _persona_block(notices, audiences)}

  {overview}

  {content_blocks}

  {unsub_block}

  <!-- 页脚 -->
  <tr><td style="padding:14px 0 0;font-size:11px;color:#b8bccb;line-height:19px;text-align:center;">
    非官方项目「{_esc(site or '研电赛通知订阅')}」自动推送 · 数据来自研创网与各赛事官网<br>
    关键时间节点请以组委会公告为准<br>
    {' &nbsp;·&nbsp; '.join(footer_links)}
  </td></tr>
  <tr><td align="center" style="padding:14px 0 0;font-size:11px;color:#6b6572;">
    —— 祝顺利，赛场见 ——
  </td></tr>
</table>
</td></tr></table>
</body></html>"""


def _greeting(now: datetime) -> str:
    """按时间给一句问候，让邮件不那么像机器发的。纯文字，不用 emoji。"""
    h = now.hour
    if 5 <= h < 11:
        return "早上好"
    if 11 <= h < 14:
        return "中午好"
    if 14 <= h < 18:
        return "下午好"
    if 18 <= h < 23:
        return "晚上好"
    return "夜深了"
