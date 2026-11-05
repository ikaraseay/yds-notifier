/** 限流：Durable Object 原子计数，避开 KV 免费版每天 1000 次写的配额。 */

import type { Env } from "./env";

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const url = new URL(raw);
    const limit = Number(url.searchParams.get("limit") || 3);
    const windowSec = Number(url.searchParams.get("window") || 3600);
    const now = Date.now();

    const cur = (await this.state.storage.get<Bucket>("b")) || { count: 0, resetAt: 0 };
    if (now >= cur.resetAt) {
      cur.count = 0;
      cur.resetAt = now + windowSec * 1000;
    }

    if (cur.count >= limit) {
      return Response.json({
        allowed: false,
        remaining: 0,
        retryAfter: Math.ceil((cur.resetAt - now) / 1000),
      });
    }

    cur.count += 1;
    await this.state.storage.put("b", cur);
    return Response.json({ allowed: true, remaining: limit - cur.count, retryAfter: 0 });
  }
}

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

export async function hitLimit(
  env: Env,
  key: string,
  limit: number,
  windowSec: number,
): Promise<LimitResult> {
  const stub = env.RATE.get(env.RATE.idFromName(key));
  const resp = await stub.fetch(`https://do/hit?limit=${limit}&window=${windowSec}`, {
    method: "POST",
  });
  return (await resp.json()) as LimitResult;
}
