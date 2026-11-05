/**
 * 后端逻辑：邮件底部的「一键退订」+ 退订原因收集 + 「改为低频」挽留入口。
 *
 * 只处理「带 email + HMAC 签名」的按邮箱链接。旧版不带 email 的
 * 「全局停用定时任务」分支已移除（见安全评审报告 S-02）。
 * 这里刻意不做 Origin/CSRF 校验：RFC 8058 的 One-Click 退订由邮件客户端
 * 直接 POST，不带 Origin；签名 token 本身就是授权凭证。
 */

import { getSub, getUser, isConfirmed, putSub, putUser, removeSub } from "../auth";
import { getConfig, requireBaseUrl, type Env } from "../env";
import { mailShell, sendMail } from "../mailer";
import { esc, verifyUnsubToken } from "../security";
import { messagePage } from "../ui/pages";
import { getCount } from "./api";

const REASONS: Record<string, string> = {
  too_frequent: "邮件太频繁",
  irrelevant: "内容不相关",
  duplicate: "重复收到",
  not_needed: "不再需要",
  other: "其他原因",
};

interface UnsubStats {
  total: number;
  lowFrequency: number;
  reasons: Record<string, number>;
}

async function bumpStats(env: Env, kind: "total" | "lowFrequency", reason = ""): Promise<void> {
  const key = "stats:unsub";
  let stats: UnsubStats = { total: 0, lowFrequency: 0, reasons: {} };
  try {
    const raw = await env.SUBS.get(key);
    if (raw) {
      const parsed = JSON.parse(raw) as UnsubStats;
      stats = {
        total: Number(parsed.total) || 0,
        lowFrequency: Number(parsed.lowFrequency) || 0,
        reasons: parsed.reasons && typeof parsed.reasons === "object" ? parsed.reasons : {},
      };
    }
  } catch {
    // 统计损坏时从零重建
  }
  if (kind === "lowFrequency") stats.lowFrequency += 1;
  else {
    stats.total += 1;
    const label = REASONS[reason] || REASONS.other;
    stats.reasons[label] = (stats.reasons[label] || 0) + 1;
  }
  await env.SUBS.put(key, JSON.stringify(stats));
}

/** 确认页：给出退订原因与「只降频、不退订」的第二选择。 */
function confirmPage(email: string): Response {
  const options = Object.entries(REASONS)
    .map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`)
    .join("");
  return messagePage({
    title: "确定要退订吗",
    heading: "确定要退订吗？",
    bodyHtml: `退订后 <b>${esc(email)}</b> 将不再收到研电赛通知邮件。` +
      `如果只是嫌邮件多，也可以改成每周一封摘要。`,
    // 不带 action：表单提交回当前 URL，query 中的 email/token 会被保留
    extraHtml: `<form method="POST" style="margin-top:18px">
      <label for="reason" style="display:block;font-size:13px;margin-bottom:8px;">退订原因（可选，帮助我们改进）</label>
      <select id="reason" name="reason" class="field">
        <option value="">不填</option>${options}
      </select>
      <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap;">
        <button type="submit" name="action" value="unsubscribe">确认退订</button>
        <button type="submit" name="action" value="lowfreq" class="btn-secondary">改成周报就好</button>
      </div>
    </form>`,
  });
}

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

  // GET 只展示确认页，POST 才真正变更 —— 防邮件客户端预抓链接导致误退订
  if (req.method === "GET") return confirmPage(email);

  // RFC 8058 的 One-Click 由邮件客户端直接 POST（没有表单字段），按退订处理；
  // 网页表单会带 action / reason。读取失败一律按退订，保证一键退订永远有效。
  let action = "unsubscribe";
  let reason = "";
  try {
    const form = await req.formData();
    action = String(form.get("action") || "unsubscribe");
    reason = String(form.get("reason") || "");
  } catch {
    // 非表单的 One-Click POST
  }
  if (!(reason in REASONS)) reason = "";

  if (action === "lowfreq") {
    const user = await getUser(env.SUBS, email);
    if (user) {
      user.prefs.frequency = "weekly";
      await putUser(env.SUBS, user);
    }
    const sub = await getSub(env.SUBS, email);
    if (sub && isConfirmed(sub)) {
      await putSub(env.SUBS, { ...sub, prefs: { ...sub.prefs!, frequency: "weekly" } });
    }
    await bumpStats(env, "lowFrequency");
    if (cfg.mailTo) {
      sendMail(
        env,
        cfg.mailTo,
        `【改为周报】${email}`,
        mailShell(
          "有人改成了周报",
          `<b>${esc(email)}</b> 在退订页选择了「改成周报」，没有退订。`,
          "打开订阅页",
          requireBaseUrl(env),
          "该订阅者的推送频率已改为 weekly。",
          cfg.siteName,
        ),
        `改为周报：${email}`,
      ).catch((e) => console.error("站长通知发送失败", e));
    }
    return messagePage({
      title: "已改为周报",
      heading: "已改为<em>每周摘要</em>",
      bodyHtml: `${esc(email)} 仍会收到通知，但同一周的内容会合并成一封摘要。` +
        `随时可以在控制台改回即时推送。`,
      extraHtml: `<a class="btn-secondary" href="/">返回首页</a>`,
    });
  }

  const existed = await removeSub(env.SUBS, email);
  // 退订只停收信，账号仍在：user: 记录保留，重新进控制台即可恢复订阅
  if (existed) {
    await env.SUBS.put("meta:count", String(Math.max(0, (await getCount(env)) - 1)));
    await bumpStats(env, "total", reason);
    if (cfg.mailTo) {
      const label = reason ? `，原因：${esc(REASONS[reason])}` : "";
      sendMail(
        env,
        cfg.mailTo,
        `【退订】${email}`,
        mailShell(
          "有人退订了",
          `<b>${esc(email)}</b> 已从订阅列表移除（账号保留）${label}。`,
          "打开订阅页",
          requireBaseUrl(env),
          `当前累计退订数据可在 /api/stats 查看。对方重新登录控制台即可恢复订阅。`,
          cfg.siteName,
        ),
        `退订：${email}${reason ? `（${REASONS[reason]}）` : ""}`,
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
