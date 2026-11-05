/** 后端逻辑：订阅人数、供 GitHub Actions 拉取的名单、健康检查、退订统计。 */

import { isConfirmed, listSubscribers, type Prefs } from "../auth";
import { getConfig, type Env } from "../env";
import { hitLimit } from "../rate";
import { safeEqual, securityHeaders } from "../security";
import { jsonResp } from "../ui/layout";

export interface ListedSubscriber {
  email: string;
  prefs: Prefs;
  frequency: string;
  pausedUntil: string;
}

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

/** 鉴权：名单、统计等管理接口共用。 */
function adminAuthed(req: Request, cfg: ReturnType<typeof getConfig>): boolean {
  const auth = req.headers.get("Authorization") || "";
  return !!cfg.adminToken && safeEqual(auth, `Bearer ${cfg.adminToken}`);
}

/**
 * GET /api/list —— 给 GitHub Actions 拉订阅名单与偏好。
 *
 * 名单缓存在 subs:index 单键里（订阅变更时失效），正常路径只读一次 KV，
 * 不再对每个订阅者做一次 getUser。只有「待确认」的账号会被排除；
 * 暂停中的仍返回，由 Python 端按 pausedUntil 决定是否投递。
 */
export async function handleList(req: Request, env: Env): Promise<Response> {
  const cfg = getConfig(env);
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const hit = await hitLimit(env, `list:${ip}`, cfg.listRatePerHour, 3600);
  if (!hit.allowed) return jsonResp({ ok: false, message: "too many requests" }, 429);
  if (!adminAuthed(req, cfg)) {
    console.warn("api/list 鉴权失败", { ip, path: req.url });
    return jsonResp({ ok: false, message: "unauthorized" }, 401);
  }

  const records = await listSubscribers(env.SUBS);
  const subscribers: ListedSubscriber[] = records
    .filter((r) => isConfirmed(r) && r.email)
    .map((r) => ({
      email: r.email,
      prefs: r.prefs!,
      frequency: r.prefs!.frequency,
      pausedUntil: r.prefs!.pausedUntil,
    }));

  console.log(`api/list 读取 ${subscribers.length} 个订阅者`, { ip });
  return jsonResp({
    ok: true,
    count: subscribers.length,
    // 兼容旧版 Actions（只读 emails）
    emails: subscribers.map((s) => s.email),
    subscribers,
  });
}

/** GET /api/stats —— 退订原因与「改为低频」统计（管理接口）。 */
export async function handleStats(req: Request, env: Env): Promise<Response> {
  const cfg = getConfig(env);
  if (!adminAuthed(req, cfg)) return jsonResp({ ok: false, message: "unauthorized" }, 401);
  let stats: Record<string, unknown> = { total: 0, lowFrequency: 0, reasons: {} };
  try {
    const raw = await env.SUBS.get("stats:unsub");
    if (raw) stats = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // 统计损坏时返回零值，不影响主流程
  }
  return jsonResp({ ok: true, count: await getCount(env), ...stats });
}
