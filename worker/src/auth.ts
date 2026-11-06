/**
 * 账号与订阅偏好。
 *
 * 存储结构（KV）：
 *   user:<email>       -> { email, createdAt, lastLogin, prefs, status }
 *   session:<hash>     -> { email, exp }      会话（cookie 里只放随机 token，KV 存其哈希）
 *   sub:<email>        -> { email, createdAt, status, prefs } 订阅名单（是否收信的总开关）
 *   confirm:<hash>     -> { email, exp }      待确认订阅的一次性 token
 *   meta:count         -> 订阅人数
 *   feed:notices       -> 通知元数据（归档 / RSS / 日历）
 *   stats:unsub        -> 退订原因与降频统计
 *
 * 栏目：与 yds/models.py 的 Notice.category 一一对应，Actions 发信时按用户偏好过滤。
 * sub:<email> 里冗余了 prefs / status，/api/list 不再需要对每个订阅者 getUser（N+1），
 * 也避免 sub: 与 user: 两次写入之间的一致性窗口。
 */

export const CATEGORIES = [
  { key: "registration", label: "报名参赛", desc: "报名通知、赛事章程、赛题指南", color: "#FF6B6B" },
  { key: "review", label: "评审与名单", desc: "初赛评审、晋级公示、获奖名单", color: "#4D96FF" },
  { key: "final", label: "决赛与收官", desc: "总决赛安排、证书、发票报销", color: "#2E2A33" },
  { key: "updates", label: "赛事动态", desc: "分赛区新闻、倒计时、赛事花絮", color: "#FFD93D" },
] as const;

export type CategoryKey = (typeof CATEGORIES)[number]["key"];

/**
 * 人员视角：与 yds/personas.py 的 AUDIENCES 一一对应。
 * 订阅者勾选自己的角色，Actions 发信时按 notice.audiences 过滤。
 */
export const AUDIENCES = [
  { key: "student", label: "参赛学生", desc: "报名、赛题、提交作品、答辩、获奖、报销" },
  { key: "advisor", label: "指导教师", desc: "组队与指导、评审安排、决赛行程、证书" },
  { key: "admin", label: "培养单位", desc: "资格审核、缴费统计、获奖名单、承办申报" },
  { key: "organizer", label: "分赛区 / 承办方", desc: "分赛区资讯、承办征集、赛程协调" },
] as const;

export type AudienceKey = (typeof AUDIENCES)[number]["key"];

/**
 * 主题赛事清单。**必须与 yds/personas.py 的 CONTESTS 完全一致**，
 * yds/selftest.py 会解析本文件并逐项比对，改这里要同时改那边。
 *
 * <contests>
 */
export const CONTESTS = [
  "智慧城市技术与创意设计大赛",
  "未来飞行器创新大赛",
  "数学建模竞赛",
  "电子设计竞赛",
  "创“芯”大赛",
  "EDA精英挑战赛",
  "人工智能创新大赛",
  "机器人创新设计大赛",
  "能源装备创新设计大赛",
  "公共管理案例大赛",
  "乡村振兴科技强农+创新大赛",
  "网络安全创新大赛",
  "“双碳”创新与创意大赛",
  "金融科技创新大赛",
  "“美丽中国”创新设计大赛",
  "企业管理创新大赛",
  "操作系统开源创新大赛",
  "“文化中国”两创大赛",
  "国际中文教育案例大赛",
  "智能建造创新大赛",
];
// </contests>

export const DEFAULT_CONTEST = "电子设计竞赛";

export type Frequency = "instant" | "daily" | "weekly";
export type SubStatus = "pending" | "confirmed";

export interface Prefs {
  registration: boolean;
  review: boolean;
  final: boolean;
  updates: boolean;
  /** 人员视角开关：只收命中角色的通知 */
  audiences: Record<AudienceKey, boolean>;
  /** 关注的赛事；空数组表示不限（收全部赛事） */
  contests: string[];
  frequency: Frequency;
  pausedUntil: string; // YYYY-MM-DD，含当天；空串表示不暂停
}

export const DEFAULT_PREFS: Prefs = {
  registration: true,
  review: true,
  final: true,
  updates: false, // 动态里多是花絮，默认关掉，避免打扰
  // 老用户默认全开，保持升级前的收信范围；可自行收窄
  audiences: { student: true, advisor: true, admin: true, organizer: true },
  // 默认只看研电赛，用户可在控制台添加其他赛事
  contests: [DEFAULT_CONTEST],
  frequency: "instant",
  pausedUntil: "",
};

export interface User {
  email: string;
  createdAt: string;
  lastLogin: string;
  prefs: Prefs;
  /** 老账号没有该字段，一律视为已确认，避免升级后集体掉出名单 */
  status?: SubStatus;
  confirmedAt?: string;
  consentSource?: string;
}

export interface SubRecord {
  email: string;
  createdAt: string;
  status?: SubStatus;
  prefs?: Prefs;
  confirmedAt?: string;
  source?: string;
}

export function isConfirmed(rec: SubRecord | null): boolean {
  // 兼容旧格式：没有 status 字段的老订阅记录视为已确认
  return !!rec && rec.status !== "pending";
}

export function normalizeFrequency(raw: unknown): Frequency {
  return raw === "daily" || raw === "weekly" ? raw : "instant";
}

export function normalizePausedUntil(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

export function normalizeAudiences(raw: unknown): Record<AudienceKey, boolean> {
  const out = { ...DEFAULT_PREFS.audiences };
  if (Array.isArray(raw)) {
    const set = new Set(raw.map((v) => String(v)));
    for (const a of AUDIENCES) out[a.key] = set.has(a.key);
    return out;
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const a of AUDIENCES) {
      if (typeof o[a.key] === "boolean") out[a.key] = o[a.key] as boolean;
    }
  }
  return out;
}

export function normalizeContests(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_PREFS.contests];
  const picked = raw.filter((v): v is string => typeof v === "string" && CONTESTS.includes(v));
  return [...new Set(picked)];
}

export function normalizePrefs(raw: unknown): Prefs {
  const p = (raw || {}) as Partial<Prefs>;
  const out = { ...DEFAULT_PREFS };
  for (const c of CATEGORIES) {
    if (typeof p[c.key] === "boolean") out[c.key] = p[c.key] as boolean;
  }
  out.audiences = normalizeAudiences(p.audiences);
  out.contests = normalizeContests(p.contests);
  out.frequency = normalizeFrequency(p.frequency);
  out.pausedUntil = normalizePausedUntil(p.pausedUntil);
  return out;
}

/** 解析 /api/prefs 提交的偏好字段，忽略任何未知键与非布尔 / 非法值。 */
export function prefsFromBody(body: unknown, current: Prefs): Prefs {
  const raw = (body || {}) as Record<string, unknown>;
  const out = { ...current };
  for (const c of CATEGORIES) {
    if (typeof raw[c.key] === "boolean") out[c.key] = raw[c.key] as boolean;
  }
  if (raw.audiences !== undefined) out.audiences = normalizeAudiences(raw.audiences);
  if (raw.contests !== undefined) out.contests = normalizeContests(raw.contests);
  if (typeof raw.frequency === "string") out.frequency = normalizeFrequency(raw.frequency);
  if (typeof raw.pausedUntil === "string") out.pausedUntil = normalizePausedUntil(raw.pausedUntil);
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

/* ---------------------------- 订阅记录 ---------------------------- */

export async function getSub(kv: KVNamespace, email: string): Promise<SubRecord | null> {
  const raw = await kv.get(`sub:${email}`);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as SubRecord;
    return { ...rec, prefs: normalizePrefs(rec.prefs) };
  } catch {
    return null;
  }
}

export async function putSub(kv: KVNamespace, rec: SubRecord): Promise<void> {
  await kv.put(
    `sub:${rec.email}`,
    JSON.stringify({ ...rec, prefs: normalizePrefs(rec.prefs) }),
  );
  await kv.delete(SUBS_INDEX_KEY); // 名单缓存失效，下次 /api/list 自动重建
}

export async function removeSub(kv: KVNamespace, email: string): Promise<boolean> {
  const had = !!(await kv.get(`sub:${email}`));
  await kv.delete(`sub:${email}`);
  await kv.delete(SUBS_INDEX_KEY);
  return had;
}

const SUBS_INDEX_KEY = "subs:index";

/**
 * 供 /api/list 使用的订阅名单缓存。
 * 正常情况下只读一个 KV key；订阅发生变化后第一次会扫描 sub: 前缀重建。
 * 这样避免对每个订阅者做一次 getUser（N+1），也避免 sub: 与 user: 双写窗口。
 */
export async function listSubscribers(kv: KVNamespace): Promise<SubRecord[]> {
  // 用一次 list 拿 key 集合做对账：新订阅 / 退订即使没来得及失效缓存也能被看到
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const pg = await kv.list({ prefix: "sub:", cursor, limit: 1000 });
    keys.push(...pg.keys.map((k) => k.name));
    if (pg.list_complete) break;
    cursor = pg.cursor;
  }
  const keySet = new Set(keys);

  let cached: SubRecord[] = [];
  const raw = await kv.get(SUBS_INDEX_KEY);
  if (raw) {
    try {
      const arr = JSON.parse(raw) as SubRecord[];
      if (Array.isArray(arr)) cached = arr;
    } catch {
      // 缓存损坏，走下面的重建
    }
  }

  const out = cached.filter((r) => r && keySet.has(`sub:${r.email}`));
  const known = new Set(out.map((r) => r.email));
  let dirty = out.length !== cached.length || !raw;
  for (const k of keys) {
    const email = k.slice(4);
    if (known.has(email)) continue;
    const rec = await getSub(kv, email);
    if (rec) {
      out.push(rec);
      known.add(email);
      dirty = true;
    }
  }
  if (dirty) await kv.put(SUBS_INDEX_KEY, JSON.stringify(out));
  return out.map((r) => ({ ...r, prefs: normalizePrefs(r.prefs) }));
}

/** hard bounce / 垃圾邮件投诉后的永久抑制，防止重新登录又进名单。 */
export async function isSuppressed(kv: KVNamespace, email: string): Promise<boolean> {
  return !!(await kv.get(`suppressed:${email}`));
}

export async function suppress(kv: KVNamespace, email: string, reason: string): Promise<void> {
  await kv.put(`suppressed:${email}`, JSON.stringify({ email, reason, at: new Date().toISOString() }));
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
