/** 安全原语：签名、常量时间比较、输入校验、CSRF、响应头。 */

import { normalizeOrigin, type Env } from "./env";

const enc = new TextEncoder();

export async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 严格常量时间比较：先定长，再逐字节 XOR 累加，不做短路。 */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length || a.length === 0 || a.length > 256) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 校验退订 token，与 Python 端 yds/unsub.py 的契约：
 *   token = "<exp>.<sig>"
 *   sig   = hmac_sha256(UNSUB_SECRET, `unsub:${email}:${exp}`)[:32]
 *   exp   = Unix 秒，必须落在 (now, now + ttl] 之间
 *
 * 明确拒绝 exp=0（旧版"永久链接"）—— 它既无法撤销，历史上还因
 * Worker 把 0 判成过期导致退订链接全部失效。
 */
export async function verifyUnsubToken(
  env: Pick<Env, "UNSUB_SECRET" | "UNSUB_SECRET_PREVIOUS">,
  email: string,
  token: string,
  maxTtlDays: number,
): Promise<boolean> {
  if (!env.UNSUB_SECRET || !email || !token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [expRaw, sig] = parts;
  if (!/^\d{1,12}$/.test(expRaw) || !/^[0-9a-f]{32}$/.test(sig)) return false;

  const ts = Number(expRaw);
  const now = Date.now();
  if (!Number.isFinite(ts) || ts * 1000 <= now) return false;
  // 上限留 30 天容差：Python 与 Worker 的 UNSUB_TTL_DAYS 允许有配置漂移，
  // 但绝不接受「永久有效」或远期 token。
  if (ts * 1000 > now + (maxTtlDays + 30) * 86_400_000) return false;

  const msg = `unsub:${email.toLowerCase()}:${ts}`;
  for (const secret of [env.UNSUB_SECRET, env.UNSUB_SECRET_PREVIOUS]) {
    if (!secret) continue;
    const expect = (await hmac(secret, msg)).slice(0, 32);
    if (safeEqual(sig, expect)) return true;
  }
  return false;
}

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 每次响应随机的 CSP nonce，替换掉 unsafe-inline。 */
export function newNonce(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function securityHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}

export function csp(nonce: string, allowScript: boolean): string {
  const base =
    `default-src 'none'; style-src 'nonce-${nonce}'; ` +
    `base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
  return allowScript
    ? `${base}; script-src 'nonce-${nonce}'; connect-src 'self'`
    : base;
}

/**
 * 状态变更请求的 CSRF 防护。
 * 允许多个合法来源：自定义域名、workers.dev 地址可并存（绑定自定义域的过渡期
 * 两种入口都会有人访问），因此入参是白名单数组而不是单个 baseUrl。
 *
 * 浏览器会带 Sec-Fetch-Site 或 Origin；服务端脚本（curl / 测试）两者都没有，
 * 此时放行，靠 SameSite=Lax Cookie 兜底（跨站 POST 不会带 Cookie）。
 */
export function assertSameOrigin(req: Request, allowed: string[] | string): boolean {
  const list = (Array.isArray(allowed) ? allowed : [allowed])
    .map(normalizeOrigin)
    .filter(Boolean);
  const site = req.headers.get("Sec-Fetch-Site");
  if (site) return site === "same-origin" || site === "none";
  const origin = req.headers.get("Origin");
  if (!origin) return true;
  if (list.length === 0) return false;
  return list.includes(normalizeOrigin(origin));
}

export function methodNotAllowed(allow: string): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: {
      ...securityHeaders(),
      Allow: allow,
      "Content-Type": "text/plain;charset=utf-8",
    },
  });
}

/** 邮箱规范化 + 校验，与 Python 端 recipients._valid() 规则一致。 */
export function normalizeEmail(raw: string): { ok: boolean; email: string; reason?: string } {
  const v = (raw || "").trim().toLowerCase();
  if (!v) return { ok: false, email: "", reason: "请填写邮箱地址" };
  if (v.length > 254) return { ok: false, email: "", reason: "邮箱地址过长" };
  if (!/^[a-z0-9._%+\-]+@[a-z0-9\-]+(\.[a-z0-9\-]+)*\.[a-z]{2,}$/.test(v)) {
    return { ok: false, email: "", reason: "邮箱格式看起来不太对" };
  }
  if (/@(example|test|invalid|localhost)\./i.test(v)) {
    return { ok: false, email: "", reason: "请不要使用测试域名" };
  }
  return { ok: true, email: v };
}
