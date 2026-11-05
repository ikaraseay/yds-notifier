/**
 * 后端逻辑：邮件底部的「一键退订」。
 *
 * 只处理「带 email + HMAC 签名」的按邮箱链接。旧版不带 email 的
 * 「全局停用定时任务」分支已移除 —— 任何人拿到那封邮件都能让全部订阅者
 * 停收，且需要 Worker 长期持有 GitHub PAT（见安全评审报告 S-02）。
 *
 * 这里刻意不做 Origin/CSRF 校验：RFC 8058 的 One-Click 退订由邮件客户端
 * 直接 POST，不带 Origin；签名 token 本身就是授权凭证。
 */

import { getConfig, requireBaseUrl, type Env } from "../env";
import { mailShell, sendMail } from "../mailer";
import { esc, verifyUnsubToken } from "../security";
import { messagePage } from "../ui/pages";
import { getCount } from "./api";

export async function handleUnsubscribe(req: Request, url: URL, env: Env): Promise<Response> {
  const cfg = getConfig(env);
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  const token = url.searchParams.get("token") || "";

  if (!email || !(await verifyUnsubToken(env, email, token, cfg.unsubTtlDays))) {
    return messagePage({
      title: "链接无效",
      heading: "这个链接<em>不能用了</em>",
      bodyHtml: "链接可能已过期，或不是发给你的。请从最近一封邮件底部重新点一次。",
      extraHtml: `<a class="btn-secondary" href="/">返回首页</a>`,
      status: 400,
    });
  }

  // GET 只展示确认页，POST 才真正删除 —— 防邮件客户端预抓链接导致误退订
  if (req.method === "GET") {
    return messagePage({
      title: "确定要退订吗",
      heading: "确定要退订吗？",
      bodyHtml: `退订后 <b>${esc(email)}</b> 将不再收到研电赛通知邮件。`,
      // 不带 action：表单提交回当前 URL，query 中的 email/token 会被保留
      extraHtml: `<form method="POST"><button type="submit">确认退订</button></form>`,
    });
  }

  const subKey = `sub:${email}`;
  const existed = await env.SUBS.get(subKey);
  await env.SUBS.delete(subKey);
  // 退订只停收信，账号仍在：user: 记录保留，重新进控制台即可恢复订阅
  if (existed) {
    await env.SUBS.put("meta:count", String(Math.max(0, (await getCount(env)) - 1)));
    if (cfg.mailTo) {
      sendMail(
        env,
        cfg.mailTo,
        `【退订】${email}`,
        mailShell(
          "有人退订了",
          `<b>${esc(email)}</b> 已从订阅列表移除（账号保留）。`,
          "打开订阅页",
          requireBaseUrl(env),
          "对方重新登录控制台即可恢复订阅。",
          cfg.siteName,
        ),
        `退订：${email}`,
      ).catch((e) => console.error("站长通知发送失败", e));
    }
  }

  return messagePage({
    title: "已退订",
    heading: "已退订",
    bodyHtml: `${esc(email)} 已从订阅列表移除。之后不会再收到邮件。账号还留着，想恢复的话重新登录控制台即可。`,
    extraHtml: `<a class="btn-secondary" href="/">重新登录</a>`,
  });
}
