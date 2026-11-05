/** 后端逻辑：订阅人数、供 GitHub Actions 拉取的名单、健康检查。 */

import { DEFAULT_PREFS, getUser, type Prefs } from "../auth";
import { getConfig, type Env } from "../env";
import { hitLimit } from "../rate";
import { safeEqual, securityHeaders } from "../security";
import { jsonResp } from "../ui/layout";

export async function getCount(env: Env): Promise<number> {
  try {
    return Number((await env.SUBS.get("meta:count")) || 0);
  } catch {
    return 0;
  }
}

export function health(): Response {
  return new Response("ok", {
    headers: { "Content-Type": "text/plain;charset=utf-8", ...securityHeaders() },
  });
}

export async function handleCount(env: Env): Promise<Response> {
  return jsonResp({ count: await getCount(env) });
}

/**
 * GET /api/list —— 给 GitHub Actions 拉订阅名单与栏目偏好。
 * 独立 Bearer Token 鉴权 + 按 IP 限流（防在线爆破 token）+ 只读。
 */
export async function handleList(req: Request, env: Env): Promise<Response> {
  const cfg = getConfig(env);
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const hit = await hitLimit(env, `list:${ip}`, cfg.listRatePerHour, 3600);
  if (!hit.allowed) return jsonResp({ ok: false, message: "too many requests" }, 429);

  const auth = req.headers.get("Authorization") || "";
  const expected = `Bearer ${cfg.adminToken}`;
  if (!cfg.adminToken || !safeEqual(auth, expected)) {
    console.warn("api/list 鉴权失败", { ip, path: req.url });
    return jsonResp({ ok: false, message: "unauthorized" }, 401);
  }

  const subscribers: { email: string; prefs: Prefs }[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const pg = await env.SUBS.list({ prefix: "sub:", cursor, limit: 1000 });
    for (const k of pg.keys) {
      const email = k.name.slice(4);
      const u = await getUser(env.SUBS, email);
      subscribers.push({ email, prefs: u ? u.prefs : { ...DEFAULT_PREFS } });
    }
    if (pg.list_complete) break;
    cursor = pg.cursor;
  }

  console.log(`api/list 读取 ${subscribers.length} 个订阅者`, { ip });
  return jsonResp({
    ok: true,
    count: subscribers.length,
    // 兼容旧版 Actions（只读 emails）
    emails: subscribers.map((s) => s.email),
    subscribers,
  });
}
