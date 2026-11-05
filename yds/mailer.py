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
from urllib.parse import urlparse

from .models import Notice

log = logging.getLogger("yds")

CATEGORY_ORDER = ("报名参赛", "评审与名单", "决赛与收官", "赛事动态", "其他通知")

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
    first = notices[0]
    if len(notices) == 1:
        return f"{prefix} {first.title}"[:120]
    return f"{prefix} {len(notices)} 条更新 · {first.title}"[:120]


def build_text(notices: Sequence[Notice], site: str = "", unsubscribe_url: str = "") -> str:
    lines = [f"研电赛通知 · 共 {len(notices)} 条\n"]
    for i, n in enumerate(notices, 1):
        flag = "【更新】" if n.change_kind == "changed" else ""
        lines.append(f"[{i}] {flag}{n.title}")
        lines.append(f"    {n.date_text}｜{n.category}｜{n.source}")
        if n.summary:
            lines.append(f"    {n.summary}")
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


def _notice_card(n: Notice) -> str:
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

    summary_block = (
        f'<tr><td style="padding:10px 18px 0;font-size:13px;color:#5a6072;line-height:21px;">'
        f"{_esc(n.summary)}</td></tr>"
        if n.summary
        else ""
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
        {summary_block}
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
) -> str:
    groups = {c: [] for c in CATEGORY_ORDER}
    for n in notices:
        groups.setdefault(n.category, []).append(n)

    blocks: List[str] = []
    for cat in CATEGORY_ORDER:
        items = groups.get(cat) or []
        if not items:
            continue
        color, _ = CATEGORY_STYLE[cat]
        cards = "".join(_notice_card(n) for n in items)
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
        <div style="font-size:12px;color:#2E2A33;letter-spacing:1px;font-weight:700;">YAN DIAN SAI · NOTICE</div>
        <div style="padding:8px 0 0;font-size:24px;font-weight:800;color:#2E2A33;
                    line-height:32px;">{_esc(greet)}</div>
        <div style="padding:8px 0 0;font-size:13px;color:#5a6072;line-height:22px;">
          研电赛有 <b style="background:#FF6B6B;color:#fff;padding:1px 8px;
          border-radius:4px;">{count}</b> {count_label}
        </div>
      </td></tr>
    </table>
  </td></tr>

  {''.join(blocks)}

  {unsub_block}

  <!-- 页脚 -->
  <tr><td style="padding:14px 0 0;font-size:11px;color:#b8bccb;line-height:19px;text-align:center;">
    本邮件由「{_esc(site or '研电赛通知订阅')}」自动推送 · 数据来自研创网与中国电子学会官网<br>
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
