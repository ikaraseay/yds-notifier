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

/** 登录 / 通知类邮件的通用外壳。文案由调用方传入并自行 esc 动态数据。 */
export function mailShell(
  title: string,
  intro: string,
  ctaLabel: string,
  ctaUrl: string,
  note: string,
): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f7f8fc;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f8fc;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
  style="max-width:520px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
  <tr><td style="background:linear-gradient(135deg,#FFE3EE 0%,#E8F0FF 52%,#E6FBF5 100%);
                 border-radius:20px;padding:26px 24px;">
    <div style="font-size:12px;color:#8a90a2;letter-spacing:1px;">YAN DIAN SAI · NOTICE</div>
    <div style="padding:8px 0 0;font-size:21px;font-weight:700;color:#2b2f3d;">${esc(title)}</div>
  </td></tr>
  <tr><td style="padding:14px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"
    style="background:#fff;border-radius:16px;border:1px solid #f0f1f6;">
    <tr><td style="padding:24px;">
      <p style="margin:0 0 18px;font-size:14px;line-height:1.8;color:#5a6072;">${intro}</p>
      <a href="${esc(ctaUrl)}" style="display:inline-block;padding:12px 30px;border-radius:24px;
         background:linear-gradient(135deg,#FF9DB8 0%,#8FA9F5 100%);color:#ffffff;font-size:14px;
         font-weight:600;text-decoration:none;">${esc(ctaLabel)}</a>
      <p style="margin:20px 0 0;font-size:12px;color:#a0a4b8;line-height:1.8;">${note}</p>
    </td></tr>
  </table></td></tr>
  <tr><td style="padding:16px 4px 0;font-size:11px;color:#b8bccb;line-height:1.8;text-align:center;">
    按钮点不开时，复制此链接到浏览器打开：<br>
    <span style="color:#8a90a2;word-break:break-all;">${esc(ctaUrl)}</span>
  </td></tr>
</table></td></tr></table></body></html>`;
}
