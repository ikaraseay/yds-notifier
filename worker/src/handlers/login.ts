/** 后端逻辑：魔法链接登录 + 双重确认订阅（double opt-in）+ 确认 / 欢迎邮件。 */

import {
  createSession,
  DEFAULT_PREFS,
  getSession,
  getUser,
  getSub,
  isConfirmed,
  isSuppressed,
  putSub,
  putUser,
  randomToken,
  readSessionToken,
  sessionCookie,
  sha256,
  type User,
} from "../auth";
import { getConfig, requireBaseUrl, type Env } from "../env";
import { mailShell, sendMail } from "../mailer";
import { hitLimit } from "../rate";
import { assertSameOrigin, esc, normalizeEmail } from "../security";
import { jsonResp, redirect } from "../ui/layout";
import { messagePage } from "../ui/pages";
import { getCount } from "./api";

const MAGIC_TTL_SEC = 15 * 60;
const CONFIRM_TTL_SEC = 24 * 60 * 60;

/** 确认订阅：写名单、计数、欢迎邮件、站长通知。重复调用是幂等的。 */
async function confirmSubscription(env: Env, email: string, user: User): Promise<void> {
  const cfg = getConfig(env);
  const now = new Date().toISOString();
  const existed = await getSub(env.SUBS, email);
  const already = isConfirmed(existed);

  await putSub(env.SUBS, {
    email,
    createdAt: existed?.createdAt || now,
    status: "confirmed",
    confirmedAt: existed?.confirmedAt || now,
    prefs: user.prefs,
    source: "double-opt-in",
  });
  await putUser(env.SUBS, {
    ...user,
    status: "confirmed",
    confirmedAt: user.confirmedAt || now,
    consentSource: user.consentSource || "confirm-email",
  });
  if (!already) await env.SUBS.put("meta:count", String((await getCount(env)) + 1));

  const base = requireBaseUrl(env);
  const intro =
    `已确认订阅「${esc(cfg.siteName)}」。有新公告会按你选择的频率发到这个邮箱；` +
    `在控制台可以随时调整栏目、改成日报 / 周报，或暂停一段时间。`;
  const note =
    `错过邮件也不怕：<a href="${esc(base)}/archive">通知归档</a> 与 ` +
    `<a href="${esc(base)}/feed.xml">RSS</a> 都能看到通知；` +
    `个人日历（按你的角色与赛事过滤）在控制台一键复制。`;
  await sendMail(
    env,
    email,
    `【订阅成功】${cfg.siteName}`,
    mailShell("订阅成功", intro, "打开控制台", `${base}/dashboard`, note, cfg.siteName),
    `已确认订阅「${cfg.siteName}」。\n控制台：${base}/dashboard\n归档：${base}/archive\n个人日历：登录控制台复制`,
  );

  if (!already && cfg.mailTo) {
    sendMail(
      env,
      cfg.mailTo,
      `【新订阅】${email}`,
      mailShell(
        "有新订阅者",
        `邮箱 <b>${esc(email)}</b> 已完成双重确认，加入订阅列表。`,
        "打开订阅页",
        base,
        "订阅者点过确认邮件里的专属链接，consent 已记录在 user: 记录中。",
        cfg.siteName,
      ),
      `新订阅者（已确认）：${email}`,
    ).catch((e) => console.error("站长通知发送失败", e));
  }
}

/** 发确认邮件（内含一次性 token）。返回是否发送成功。 */
async function sendConfirmMail(env: Env, email: string): Promise<boolean> {
  const cfg = getConfig(env);
  const base = requireBaseUrl(env);
  const nonce = randomToken(24);
  await env.SUBS.put(
    `confirm:${await sha256(nonce)}`,
    JSON.stringify({ email, exp: Date.now() + CONFIRM_TTL_SEC * 1000 }),
    { expirationTtl: CONFIRM_TTL_SEC },
  );
  const link = `${base}/confirm?c=${nonce}`;
  const mail = await sendMail(
    env,
    email,
    `【请确认订阅】${cfg.siteName}`,
    mailShell(
      "还差一步，确认订阅",
      `有人用这个邮箱申请订阅「${esc(cfg.siteName)}」。点下面的按钮完成确认，` +
        `之后才会开始收到研电赛通知邮件。`,
      "确认订阅",
      link,
      "链接 24 小时内有效。如果不是你本人操作，直接忽略本邮件，不会收到任何通知。",
      cfg.siteName,
    ),
    `确认订阅「${cfg.siteName}」：\n${link}\n\n链接 24 小时内有效。如非本人操作请忽略。`,
  );
  if (!mail.ok) console.error("确认邮件发送失败", { detail: mail.detail });
  return mail.ok;
}

/** POST /api/login —— 提交邮箱 → 发一次性登录链接 */
export async function handleLogin(req: Request, env: Env): Promise<Response> {
  const cfg = getConfig(env);
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const body = (await req.json().catch(() => ({}))) as { email?: string };
  const { ok, email, reason } = normalizeEmail(body.email || "");
  if (!ok) return jsonResp({ ok: false, message: reason }, 400);

  const ipHit = await hitLimit(env, `ip:${ip}`, cfg.maxPerIpHour, 3600);
  if (!ipHit.allowed) {
    const min = Math.max(1, Math.ceil(ipHit.retryAfter / 60));
    return jsonResp({ ok: false, message: `提交太频繁了，请 ${min} 分钟后再试` }, 429);
  }
  const cool = await hitLimit(env, `mail:${email}`, 1, 600);
  if (!cool.allowed) {
    return jsonResp(
      { ok: false, message: "登录邮件刚发过，请先查看收件箱（也看看垃圾箱）" },
      429,
    );
  }
  const dayKey = `day:${new Date().toISOString().slice(0, 10)}`;
  const dayHit = await hitLimit(env, dayKey, cfg.maxConfirmPerDay, 86400);
  if (!dayHit.allowed) {
    return jsonResp({ ok: false, message: "今日登录邮件已达上限，请明天再来" }, 429);
  }

  const nonce = randomToken(24);
  await env.SUBS.put(
    `magic:${await sha256(nonce)}`,
    JSON.stringify({ email, exp: Date.now() + MAGIC_TTL_SEC * 1000 }),
    { expirationTtl: MAGIC_TTL_SEC },
  );

  // 只信任配置的固定域名，不用 new URL(req.url).origin（Host 头注入）
  const base = requireBaseUrl(env);
  const loginUrl = `${base}/login?n=${nonce}`;
  const user = await getUser(env.SUBS, email);
  const needsConfirm = cfg.doubleOptIn && (!user || user.status === "pending");

  const mail = await sendMail(
    env,
    email,
    `【登录】${cfg.siteName}`,
    mailShell(
      needsConfirm ? "确认邮箱，完成订阅" : "点这里进入控制台",
      needsConfirm
        ? `你正在订阅「${esc(cfg.siteName)}」。点下面的按钮验证邮箱并登录；` +
          `首次订阅还需再点一封确认邮件里的链接，之后才会开始收通知。`
        : `点下面的按钮进入「${esc(cfg.siteName)}」控制台，调整想收的通知栏目与频率。`,
      "进入控制台",
      loginUrl,
      "链接 15 分钟内有效、只能用一次。如果不是你本人操作，忽略本邮件即可，不会有任何变化。",
      cfg.siteName,
    ),
    `进入「${cfg.siteName}」：\n${loginUrl}\n\n链接 15 分钟内有效、只能用一次。如非本人操作请忽略。`,
  );

  if (!mail.ok) {
    console.error("登录邮件发送失败", { email, detail: mail.detail });
    return jsonResp({ ok: false, message: "登录邮件暂时发不出去，请稍后再试" }, 502);
  }
  return jsonResp({ ok: true, message: "登录邮件已发出，请查收（也看看垃圾箱）" });
}

/** GET /login?n= —— 校验 nonce → 建档 → 待确认的发确认邮件 → 写会话 cookie */
export async function handleMagicVerify(url: URL, env: Env): Promise<Response> {
  const cfg = getConfig(env);
  const nonce = url.searchParams.get("n") || "";
  if (!nonce) return redirect("/");

  const key = `magic:${await sha256(nonce)}`;
  const raw = await env.SUBS.get(key);
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
  const status = cfg.doubleOptIn && !existing ? "pending" : (existing?.status || "confirmed");
  const user: User = existing
    ? { ...existing, lastLogin: now }
    : { email, createdAt: now, lastLogin: now, prefs: { ...DEFAULT_PREFS }, status };
  await putUser(env.SUBS, user);

  const sub = await getSub(env.SUBS, email);
  const pending = cfg.doubleOptIn && !isConfirmed(sub) && user.status === "pending";
  if (!sub && !pending) {
    // 关闭 double opt-in，或老账号重建：直接确认，保持旧行为
    await confirmSubscription(env, email, { ...user, status: "confirmed" });
  } else if (pending) {
    const sent = await sendConfirmMail(env, email);
    if (!sent) {
      return messagePage({
        title: "确认邮件发送失败",
        heading: "确认邮件<em>没发出去</em>",
        bodyHtml: "请稍后回到首页重新登录，我们会再发一次确认邮件。",
        extraHtml: `<a class="btn-secondary" href="/">返回首页</a>`,
        status: 502,
      });
    }
  }

  const token = await createSession(env.SUBS, email);
  return redirect("/dashboard", sessionCookie(token));
}

/** GET /confirm?c= —— 点确认邮件里的链接，完成双重订阅确认 */
export async function handleConfirm(url: URL, env: Env): Promise<Response> {
  const nonce = url.searchParams.get("c") || "";
  if (!nonce) return redirect("/");
  const key = `confirm:${await sha256(nonce)}`;
  const raw = await env.SUBS.get(key);
  if (raw) await env.SUBS.delete(key);

  let email = "";
  try {
    const rec = JSON.parse(raw || "") as { email: string; exp: number };
    if (rec.exp > Date.now()) email = rec.email;
  } catch {
    // 统一走失效页
  }
  const user = email ? await getUser(env.SUBS, email) : null;
  if (!email || !user) {
    return messagePage({
      title: "确认链接失效",
      heading: "这个链接<em>不能用了</em>",
      bodyHtml: "确认链接只能用一次、24 小时内有效。回到控制台可以让我们重新发一封。",
      extraHtml: `<a class="btn-secondary" href="/dashboard">返回控制台</a>`,
      status: 400,
    });
  }
  if (await isSuppressed(env.SUBS, email)) {
    return messagePage({
      title: "无法确认订阅",
      heading: "这个邮箱<em>暂时不能订阅</em>",
      bodyHtml: "该地址此前有退信或垃圾邮件投诉记录，已被自动移出名单。请联系站长处理。",
      status: 403,
    });
  }

  await confirmSubscription(env, email, user);
  return messagePage({
    title: "订阅已确认",
    heading: "订阅<em>已确认</em>",
    bodyHtml: `${esc(email)} 已加入订阅列表，我们同时发了一封欢迎邮件。` +
      `之后可以在控制台挑选栏目、改成日报 / 周报，或暂停一段时间。`,
    extraHtml:
      `<a class="btn-secondary" href="/dashboard">打开控制台</a>` +
      `<div class="tip tip--last">也可以订阅 ` +
      `<a href="/feed.xml">RSS</a>；个人日历在控制台复制，按你的角色与赛事过滤。</div>`,
  });
}

/** POST /api/confirm/resend —— 控制台里重发确认邮件（带限流） */
export async function handleConfirmResend(req: Request, env: Env): Promise<Response> {
  if (!assertSameOrigin(req, getConfig(env).allowedOrigins)) {
    return jsonResp({ ok: false, message: "请求来源不合法" }, 403);
  }
  const email = await getSession(env.SUBS, readSessionToken(req));
  if (!email) return jsonResp({ ok: false, login: true, message: "登录已过期" }, 401);
  const user = await getUser(env.SUBS, email);
  if (!user) return jsonResp({ ok: false, login: true, message: "账号不存在" }, 401);
  if (user.status !== "pending") {
    return jsonResp({ ok: false, message: "订阅已经确认过了" }, 400);
  }
  const hit = await hitLimit(env, `resend:${email}`, 3, 3600);
  if (!hit.allowed) return jsonResp({ ok: false, message: "重发太频繁了，请一小时后再试" }, 429);
  const sent = await sendConfirmMail(env, email);
  return sent
    ? jsonResp({ ok: true, message: "确认邮件已重发，请查收" })
    : jsonResp({ ok: false, message: "确认邮件暂时发不出去，请稍后再试" }, 502);
}
