/** 出站邮件：Resend 调用 + 邮件 HTML 模板（后端逻辑层，不含页面）。 */

import { getConfig, type Env } from "./env";
import { esc } from "./security";

export interface MailResult {
  ok: boolean;
  detail?: string; // 仅用于服务端日志，禁止回显给访客
}

export async function sendMail(
  env: Env,
  to: string,
  subject: string,
  html: string,
  text: string,
  headers: Record<string, string> = {},
): Promise<MailResult> {
  const cfg = getConfig(env);
  // fail-fast：不再静默回退到 notice@example.com
  if (!env.RESEND_API_KEY) return { ok: false, detail: "RESEND_API_KEY 未配置" };
  if (!cfg.mailFrom) return { ok: false, detail: "MAIL_FROM_ADDRESS 未配置" };

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: cfg.mailFrom,
        to: [to],
        subject,
        html,
        text,
        headers,
      }),
    });
    if (resp.ok) return { ok: true };
    return { ok: false, detail: `HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 孟菲斯风格邮件外壳：与订阅页 `ui/styles.ts`、Python 通知邮件 `yds/mailer.py`
 * 共用同一套视觉系统（奶油纸底 / 墨色粗描边 / 黄·珊瑚·蓝撞色 / 硬阴影 / 波点节奏）。
 *
 * 兼容性：全部用 table + 内联样式与离散色块，不依赖渐变、伪元素、SVG 或 flex，
 * QQ 邮箱 / 163 / Gmail / 手机客户端都能降级显示；全程不使用 emoji。
 * 文案约定：`intro` / `note` 允许简单 HTML，动态数据由调用方自行 esc；
 * `title` / `ctaLabel` / `ctaUrl` / `siteName` 在此统一转义。
 */
export function mailShell(
  title: string,
  intro: string,
  ctaLabel: string,
  ctaUrl: string,
  note: string,
  siteName = "研电赛通知订阅",
): string {
  const INK = "#2E2A33";
  const PAPER = "#FFF4E4";
  const YELLOW = "#FFD93D";
  const CORAL = "#FF6B6B";
  const BLUE = "#4D96FF";

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:${PAPER};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
       style="background:${PAPER};padding:22px 12px 30px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
       style="max-width:600px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',
              'PingFang SC','Microsoft YaHei',sans-serif;">

  <!-- 头部：黄色撞色块 + 墨色粗描边 + 几何点缀 -->
  <tr><td style="padding:0 0 6px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:${YELLOW};border:3px solid ${INK};border-radius:8px;padding:24px;">
      <tr>
        <td valign="top">
          <div style="font-size:12px;color:${INK};letter-spacing:1px;font-weight:700;">YAN DIAN SAI · NOTICE</div>
          <div style="padding:10px 0 0;font-size:24px;font-weight:800;color:${INK};line-height:32px;">${esc(title)}</div>
        </td>
        <td align="right" valign="top" style="white-space:nowrap;">
          <span style="display:inline-block;width:12px;height:12px;background:${CORAL};border:2px solid ${INK};border-radius:2px;"></span>
          <span style="display:inline-block;width:10px;height:10px;background:${BLUE};border:2px solid ${INK};border-radius:50%;margin-left:6px;"></span>
          <span style="display:inline-block;width:8px;height:8px;background:${INK};border-radius:50%;margin-left:6px;"></span>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- 孟菲斯装饰条：撞色块 + 虚线节奏 -->
  <tr><td style="padding:14px 2px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td>
        <span style="display:inline-block;width:20px;height:8px;background:${YELLOW};border:2px solid ${INK};border-radius:2px;vertical-align:middle;"></span>
        <span style="display:inline-block;width:12px;height:8px;background:${CORAL};border:2px solid ${INK};border-radius:2px;vertical-align:middle;margin-left:6px;"></span>
        <span style="display:inline-block;width:10px;height:10px;background:${BLUE};border:2px solid ${INK};border-radius:50%;vertical-align:middle;margin-left:6px;"></span>
      </td>
      <td align="right" style="font-size:11px;color:${INK};letter-spacing:3px;">- - - -</td>
    </tr></table>
  </td></tr>

  <!-- 内容卡：白底 + 墨色粗描边；按钮带 4px 硬阴影 -->
  <tr><td>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:#ffffff;border:3px solid ${INK};border-radius:8px;">
      <tr><td style="padding:26px 24px;">
        <p style="margin:0 0 22px;font-size:14px;line-height:1.85;color:#4a4550;">${intro}</p>
        <a href="${esc(ctaUrl)}"
           style="display:inline-block;padding:12px 28px;background:${YELLOW};color:${INK};
                  border:3px solid ${INK};border-radius:6px;box-shadow:4px 4px 0 ${INK};
                  font-size:14px;font-weight:700;text-decoration:none;">${esc(ctaLabel)}</a>
        <div style="margin-top:24px;padding:12px 14px;background:${PAPER};
                    border:2px dashed ${INK};border-radius:6px;
                    font-size:12px;color:#6b6572;line-height:1.8;">${note}</div>
      </td></tr>
    </table>
  </td></tr>

  <!-- 链接兜底 -->
  <tr><td style="padding:16px 2px 0;font-size:11px;color:#8a90a2;line-height:1.8;">
    按钮点不开时，复制此链接到浏览器打开：<br>
    <span style="color:${INK};word-break:break-all;">${esc(ctaUrl)}</span>
  </td></tr>

  <!-- 页脚，与批量通知邮件保持一致 -->
  <tr><td align="center" style="padding:24px 0 0;font-size:11px;color:#8a90a2;line-height:19px;">
    本邮件由「${esc(siteName)}」自动推送 · 请勿直接回复
  </td></tr>
  <tr><td align="center" style="padding:10px 0 0;font-size:11px;color:#6b6572;">
    —— 祝顺利，赛场见 ——
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}
