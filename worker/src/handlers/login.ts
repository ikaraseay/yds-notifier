/** 后端逻辑：魔法链接登录 / 首次自动建档订阅。 */

import {
  createSession,
  DEFAULT_PREFS,
  getUser,
  putUser,
  randomToken,
  sessionCookie,
  sha256,
  type User,
} from "../auth";
import { getConfig, requireBaseUrl, type Env } from "../env";
import { mailShell, sendMail } from "../mailer";
import { hitLimit } from "../rate";
import { esc, normalizeEmail } from "../security";
import { jsonResp, redirect } from "../ui/layout";
import { messagePage } from "../ui/pages";
import { getCount } from "./api";

const MAGIC_TTL_SEC = 15 * 60;

/** POST /api/login —— 提交邮箱 → 发一次性登录链接 */
export async function handleLogin(req: Request, env: Env): Promise<Response> {
  const cfg = getConfig(env);
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const body = (await req.json().catch(() => ({}))) as { email?: string };
  const { ok, email, reason } = normalizeEmail(body.email || "");
  if (!ok) return jsonResp({ ok: false, message: reason }, 400);

  // 第 1 层：IP 限流
  const ipHit = await hitLimit(env, `ip:${ip}`, cfg.maxPerIpHour, 3600);
  if (!ipHit.allowed) {
    const min = Math.max(1, Math.ceil(ipHit.retryAfter / 60));
    return jsonResp({ ok: false, message: `提交太频繁了，请 ${min} 分钟后再试` }, 429);
  }

  // 第 2 层：同邮箱 10 分钟冷却，避免被拿去轰炸别人
  const cool = await hitLimit(env, `mail:${email}`, 1, 600);
  if (!cool.allowed) {
    return jsonResp(
      { ok: false, message: "登录邮件刚发过，请先查看收件箱（也看看垃圾箱）" },
      429,
    );
  }

  // 第 3 层：全局每日发送上限，防止批量刷登录烧光 Resend 额度
  const dayKey = `day:${new Date().toISOString().slice(0, 10)}`;
  const dayHit = await hitLimit(env, dayKey, cfg.maxConfirmPerDay, 86400);
  if (!dayHit.allowed) {
    return jsonResp({ ok: false, message: "今日登录邮件已达上限，请明天再来" }, 429);
  }

  // 第 4 层：一次性 token。KV 存哈希，链接点过即删，无法重放
  const nonce = randomToken(24);
  const exp = Date.now() + MAGIC_TTL_SEC * 1000;
  await env.SUBS.put(
    `magic:${await sha256(nonce)}`,
    JSON.stringify({ email, exp }),
    { expirationTtl: MAGIC_TTL_SEC },
  );

  // 关键：只信任配置的固定域名，不用 new URL(req.url).origin（Host 头注入）
  const base = requireBaseUrl(env);
  const loginUrl = `${base}/login?n=${nonce}`;
  const isNew = !(await getUser(env.SUBS, email));

  const mail = await sendMail(
    env,
    email,
    `【登录】${cfg.siteName}`,
    mailShell(
      isNew ? "欢迎，登录即可订阅" : "点这里进入控制台",
      isNew
        ? `你正在订阅「${esc(cfg.siteName)}」。点下面的按钮完成登录，会自动注册并开始订阅。`
        : `点下面的按钮进入「${esc(cfg.siteName)}」控制台，调整想收的通知栏目。`,
      "进入控制台",
      loginUrl,
      "链接 15 分钟内有效、只能用一次。如果不是你本人操作，忽略本邮件即可，不会有任何变化。",
    ),
    `进入「${cfg.siteName}」：\n${loginUrl}\n\n链接 15 分钟内有效、只能用一次。如非本人操作请忽略。`,
  );

  if (!mail.ok) {
    // 上游错误细节只进日志，绝不回显给访客（安全评审报告 S-04）
    console.error("登录邮件发送失败", { email, detail: mail.detail });
    return jsonResp({ ok: false, message: "登录邮件暂时发不出去，请稍后再试" }, 502);
  }
  return jsonResp({ ok: true, message: "登录邮件已发出，请查收（也看看垃圾箱）" });
}

/** GET /login?n= —— 校验 nonce → 建档 → 写会话 cookie → 302 控制台 */
export async function handleMagicVerify(url: URL, env: Env): Promise<Response> {
  const cfg = getConfig(env);
  const base = requireBaseUrl(env);
  const nonce = url.searchParams.get("n") || "";
  if (!nonce) return redirect("/");

  const key = `magic:${await sha256(nonce)}`;
  const raw = await env.SUBS.get(key);
  // 一次性：不管成功与否先删，避免同链接被重复使用
  if (raw) await env.SUBS.delete(key);
  if (!raw) {
    return messagePage({
      title: "链接失效",
      heading: "这个链接<em>不能用了</em>",
      bodyHtml: "登录链接只能用一次，且 15 分钟后失效。重新填一次邮箱就好。",
      extraHtml: `<a class="btn-secondary" href="/">重新登录</a>`,
      status: 400,
    });
  }

  let email = "";
  try {
    const rec = JSON.parse(raw) as { email: string; exp: number };
    if (rec.exp > Date.now()) email = rec.email;
  } catch {
    // 落到下面的失效分支
  }
  if (!email) {
    return messagePage({
      title: "链接失效",
      heading: "这个链接<em>已过期</em>",
      bodyHtml: "重新填一次邮箱，会立刻发一封新的。",
      extraHtml: `<a class="btn-secondary" href="/">重新登录</a>`,
      status: 400,
    });
  }

  const now = new Date().toISOString();
  const existing = await getUser(env.SUBS, email);
  const user: User = existing
    ? { ...existing, lastLogin: now }
    : { email, createdAt: now, lastLogin: now, prefs: { ...DEFAULT_PREFS } };
  await putUser(env.SUBS, user);

  // 默认订阅：首次登录就进订阅列表，用户不必再点一次确认
  const subKey = `sub:${email}`;
  const had = await env.SUBS.get(subKey);
  if (!had) {
    await env.SUBS.put(subKey, JSON.stringify({ email, createdAt: now, source: "web" }));
    await env.SUBS.put("meta:count", String((await getCount(env)) + 1));
    if (cfg.mailTo && !existing) {
      sendMail(
        env,
        cfg.mailTo,
        `【新订阅】${email}`,
        mailShell(
          "有新订阅者",
          `邮箱 <b>${esc(email)}</b> 完成登录，已自动加入订阅列表。`,
          "打开订阅页",
          base,
          "如需移除，可在 Cloudflare KV 删除 sub:邮箱 与 user:邮箱。",
        ),
        `新订阅者：${email}`,
      ).catch((e) => console.error("站长通知发送失败", e));
    }
  }

  const token = await createSession(env.SUBS, email);
  return redirect("/dashboard", sessionCookie(token));
}
