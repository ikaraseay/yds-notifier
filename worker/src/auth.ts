/**
 * 账号与订阅偏好。
 *
 * 存储结构（KV）：
 *   user:<email>       -> { email, createdAt, lastLogin, prefs: {...} }
 *   session:<hash>     -> { email, exp }      会话（cookie 里只放随机 token，KV 存其哈希）
 *   sub:<email>        -> { email, createdAt } 订阅名单（是否收信的总开关）
 *   meta:count         -> 订阅人数
 *
 * 栏目：与 yds/models.py 的 Notice.category 一一对应，Actions 发信时按用户偏好过滤。
 */

export const CATEGORIES = [
  { key: "registration", label: "报名参赛", desc: "报名通知、赛事章程、赛题指南", color: "#FF6B6B" },
  { key: "review", label: "评审与名单", desc: "初赛评审、晋级公示、获奖名单", color: "#4D96FF" },
  { key: "final", label: "决赛与收官", desc: "总决赛安排、证书、发票报销", color: "#2E2A33" },
  { key: "updates", label: "赛事动态", desc: "分赛区新闻、倒计时、赛事花絮", color: "#FFD93D" },
] as const;

export type CategoryKey = (typeof CATEGORIES)[number]["key"];

export interface Prefs {
  registration: boolean;
  review: boolean;
  final: boolean;
  updates: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  registration: true,
  review: true,
  final: true,
  updates: false, // 动态里多是花絮，默认关掉，避免打扰
};

export interface User {
  email: string;
  createdAt: string;
  lastLogin: string;
  prefs: Prefs;
}

export function normalizePrefs(raw: unknown): Prefs {
  const p = (raw || {}) as Partial<Prefs>;
  const out = { ...DEFAULT_PREFS };
  for (const c of CATEGORIES) {
    if (typeof p[c.key] === "boolean") out[c.key] = p[c.key] as boolean;
  }
  return out;
}

/** 由中文分类名反查栏目 key，供 Actions 过滤使用 */
export const CATEGORY_LABEL_TO_KEY: Record<string, CategoryKey> = {
  报名参赛: "registration",
  评审与名单: "review",
  决赛与收官: "final",
  赛事动态: "updates",
  其他通知: "review",
};

/* ---------------------------- 会话 ---------------------------- */

const SESSION_COOKIE = "yds_sid";
const SESSION_TTL = 60 * 60 * 24 * 14; // 14 天

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256(v: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function sessionCookie(token: string, maxAge = SESSION_TTL): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readSessionToken(req: Request): string {
  const raw = req.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE) return rest.join("=");
  }
  return "";
}

export async function createSession(kv: KVNamespace, email: string): Promise<string> {
  const token = randomToken();
  await kv.put(
    `session:${await sha256(token)}`,
    JSON.stringify({ email, exp: Date.now() + SESSION_TTL * 1000 }),
    { expirationTtl: SESSION_TTL },
  );
  return token;
}

export async function getSession(kv: KVNamespace, token: string): Promise<string> {
  if (!token) return "";
  const raw = await kv.get(`session:${await sha256(token)}`);
  if (!raw) return "";
  try {
    const s = JSON.parse(raw) as { email: string; exp: number };
    if (s.exp < Date.now()) return "";
    return s.email;
  } catch {
    return "";
  }
}

export async function destroySession(kv: KVNamespace, token: string): Promise<void> {
  if (token) await kv.delete(`session:${await sha256(token)}`);
}

/* ---------------------------- 用户 ---------------------------- */

export async function getUser(kv: KVNamespace, email: string): Promise<User | null> {
  const raw = await kv.get(`user:${email}`);
  if (!raw) return null;
  try {
    const u = JSON.parse(raw) as User;
    return { ...u, prefs: normalizePrefs(u.prefs) };
  } catch {
    return null;
  }
}

export async function putUser(kv: KVNamespace, user: User): Promise<void> {
  await kv.put(`user:${user.email}`, JSON.stringify(user));
}

/** 注销：删账号、订阅记录、偏好。会话由调用方一并清理。 */
export async function deleteUser(kv: KVNamespace, email: string): Promise<boolean> {
  const had = !!(await getUser(kv, email));
  await kv.delete(`user:${email}`);
  await kv.delete(`sub:${email}`);
  return had;
}

/**
 * 清理某个邮箱的全部会话（注销账户时用）。
 * 只删当前设备会留下仍然有效的其它设备会话记录，虽然 getUser 失败会拦住访问，
 * 但不留残留更符合「注销即彻底删除」的承诺。
 */
export async function destroyAllSessions(kv: KVNamespace, email: string): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;
  for (let i = 0; i < 20; i++) {
    const pg = await kv.list({ prefix: "session:", cursor, limit: 1000 });
    for (const k of pg.keys) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw) as { email?: string };
        if (rec.email === email) {
          await kv.delete(k.name);
          deleted += 1;
        }
      } catch {
        // 损坏的会话记录直接跳过（KV TTL 会自行清理）
      }
    }
    if (pg.list_complete) break;
    cursor = pg.cursor;
  }
  return deleted;
}
