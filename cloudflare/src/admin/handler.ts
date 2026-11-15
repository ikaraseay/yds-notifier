import { getSub, isConfirmed, listSubscribers, removeSub, sha256 } from "../accounts/auth";
import type { Env } from "../platform/env";
import { hitLimit } from "../platform/rate";
import { hmac, safeEqual } from "../platform/security";
import { readForm, redirect, sameOrigin } from "../platform/http";
import {
  adminArchivePage,
  adminLoginPage,
  adminOverviewPage,
  adminSubscribersPage,
  subscriberPageUrl,
} from "../ui/admin";
import { getUnsubscribeStats } from "../accounts/api";
import { loadFeed } from "../notices/handler";

const COOKIE = "__Host-yds_admin";
const SESSION_SECONDS = 4 * 3600;

function credentials(env: Env) {
  const passwordHash = env.ADMIN_PASSWORD_HASH?.trim().toLowerCase() || "";
  const secret = env.ADMIN_SESSION_SECRET?.trim() || "";
  return /^[0-9a-f]{64}$/.test(passwordHash) && secret.length >= 32 ? { passwordHash, secret } : null;
}

function cookie(token: string, maxAge: number): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export async function adminAuthenticated(req: Request, env: Env): Promise<boolean> {
  const config = credentials(env);
  if (!config) return false;
  const token = req.headers.get("Cookie")?.match(/(?:^|;\s*)__Host-yds_admin=([^;]*)/)?.[1] || "";
  const match = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(token);
  if (!match) return false;
  const [, expires, signature] = match;
  return Number(expires) > Date.now() / 1000 &&
    safeEqual(signature, await hmac(config.secret, `admin:${config.passwordHash}:${expires}`));
}

export async function handleAdmin(req: Request, env: Env, url: URL): Promise<Response> {
  if (!credentials(env)) return adminLoginPage("管理员后台尚未启用。", 503);
  if (!(await adminAuthenticated(req, env))) return adminLoginPage();

  const section = url.searchParams.get("view");
  if (section === "archive") return adminArchivePage(await loadFeed(env));
  const subscribers = await listSubscribers(env.SUBS);
  if (section === "subscribers") return adminSubscribersPage(subscribers, url);
  const [stats, feed] = await Promise.all([getUnsubscribeStats(env), loadFeed(env)]);
  return adminOverviewPage(subscribers, stats, feed);
}

export async function handleAdminLogin(req: Request, env: Env): Promise<Response> {
  const config = credentials(env);
  if (!config) return adminLoginPage("管理员后台尚未启用。", 503);
  if (!sameOrigin(req)) return adminLoginPage("请求来源无效，请从后台登录页重试。", 403);

  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const hit = await hitLimit(env, `admin:login:${ip}`, 5, 600);
  if (!hit.allowed) return adminLoginPage(`尝试次数过多，请在 ${hit.retryAfter} 秒后重试。`, 429);

  const form = await readForm(req);
  const password = form?.get("password") || "";
  if (!password || password.length > 256) return adminLoginPage("请输入有效的管理员口令。", 400);
  if (!safeEqual(await sha256(password), config.passwordHash)) {
    return adminLoginPage("管理员口令错误。", 401);
  }

  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const signature = await hmac(config.secret, `admin:${config.passwordHash}:${expires}`);
  return redirect("/admin", cookie(`${expires}.${signature}`, SESSION_SECONDS), 303);
}

export function handleAdminLogout(req: Request): Response {
  if (!sameOrigin(req)) return adminLoginPage("请求来源无效。", 403);
  return redirect("/admin", cookie("", 0), 303);
}

export async function handleAdminRemove(req: Request, env: Env): Promise<Response> {
  if (!sameOrigin(req)) return adminLoginPage("请求来源无效。", 403);
  if (!(await adminAuthenticated(req, env))) return adminLoginPage("管理员会话已失效，请重新登录。", 401);

  const form = await readForm(req);
  const email = form?.get("email") || "";
  // 支持旧名单里的邮箱，同时只允许删除与 KV 中记录匹配的单个邮箱。
  if (form?.get("confirm") !== "yes" || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) {
    return adminLoginPage("请确认要移出的订阅邮箱。", 400);
  }
  const sub = await getSub(env.SUBS, email);
  if (sub && sub.email !== email) return adminLoginPage("订阅记录不匹配。", 409);
  if (sub) await removeSub(env.SUBS, email);

  // 按名单重算，重复提交只会校准计数。
  const remaining = await listSubscribers(env.SUBS);
  const count = remaining.filter((record) => record.email !== email && isConfirmed(record)).length;
  if ((await env.SUBS.get("meta:count")) !== String(count)) await env.SUBS.put("meta:count", String(count));

  const query = (form?.get("q") || "").slice(0, 254);
  const page = Number(form?.get("page")) || 1;
  return redirect(subscriberPageUrl(query, page, true), undefined, 303);
}
