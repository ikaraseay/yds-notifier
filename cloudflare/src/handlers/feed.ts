/**
 * 通知写入 / RSS / 个人日历接口。
 *
 * 归档页本身已迁到 `ui/archive/`（结构与样式分离），这里只负责：
 *   1. `POST /api/notices`  接收 Python 端同步的数据（白名单清洗）
 *   2. `GET  /feed.xml`     RSS
 *   3. `GET  /calendar.ics` 个人日历（签名校验 + 偏好过滤）
 *
 * KV: feed:notices -> JSON 字符串（FeedPayload）。写入时按白名单清洗，
 * 读取侧再清洗一次，避免 KV 被直接写入时把脏数据带进对外页面。
 */

import { getUser, type Prefs } from '../auth';
import { getConfig, type Env } from '../env';
import { scheduleEntries } from '../feed/schedule';
import {
  AI_CATEGORIES,
  AUDIENCE_LABELS,
  AUDIENCES,
  EVENT_KINDS,
  STAGES,
  URGENCIES,
  type AiEvent,
  type Attachment,
  type ContestSchedule,
  type FeedPayload,
  type Notice,
} from '../feed/types';
import { cacheControl, esc, safeEqual, securityHeaders, signEmailToken, verifyEmailToken } from '../security';
import { renderArchive, renderArchiveError } from '../../../frontend/archive';
import { jsonResp, page } from '../../../frontend/layout';

/* ---------------------------- 通用清洗 ---------------------------- */

/** 只接受标量并转成字符串，对象 / 数组一律丢弃，避免 [object Object] 混入页面。 */
function asStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return '';
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** 仅放行 http/https 绝对地址，其余（含 javascript: 等）一律置空。 */
function safeUrl(v: unknown): string {
  const s = asStr(v).trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : '';
  } catch {
    return '';
  }
}

function asNum(v: unknown, max = 1): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.min(max, Math.max(0, v));
}

/**
 * AI 事件白名单。date 必须是严格 YYYY-MM-DD，否则整条丢弃 ——
 * 避免模型输出被直接拼进 DTSTART 而让日历退回发布日期。
 */
function normalizeEvents(raw: unknown): AiEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: AiEvent[] = [];
  for (const item of raw.slice(0, 4)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const day = asStr(o.date).trim();
    if (!validDate(day)) continue;
    const kind = asStr(o.kind).trim();
    out.push({
      date: day,
      evidence: trunc(asStr(o.evidence).trim(), 60),
      label: trunc(asStr(o.label).trim(), 40),
      kind: EVENT_KINDS.includes(kind) ? kind : 'other',
      location: trunc(asStr(o.location).trim(), 100),
      confidence: asNum(o.confidence),
    });
  }
  return out;
}

/** 白名单字段 + 截断 + URL 校验；title / uid 为空的条目直接丢弃。 */
function normalizeNotice(raw: unknown): Notice | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const uid = trunc(asStr(o.uid).trim(), 200);
  const title = trunc(asStr(o.title).trim(), 300);
  if (!uid || !title) return null;

  let attachments: Attachment[] | undefined;
  if (Array.isArray(o.attachments)) {
    attachments = o.attachments.slice(0, 20).map((a) => {
      const x = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
      return { name: trunc(asStr(x.name).trim(), 200), url: safeUrl(trunc(asStr(x.url).trim(), 500)) };
    });
  }
  const changeKind = o.changeKind === 'changed' ? 'changed' : o.changeKind === 'new' ? 'new' : undefined;

  const aiCategory = trunc(asStr(o.aiCategory).trim(), 100);
  const aiUrgency = asStr(o.aiUrgency).trim();
  const stage = asStr(o.stage).trim();
  const audiences = Array.isArray(o.audiences)
    ? o.audiences.map((a) => asStr(a).trim()).filter((a) => AUDIENCES.includes(a)).slice(0, 4)
    : [];
  return {
    uid,
    title,
    url: safeUrl(trunc(asStr(o.url).trim(), 500)),
    date: trunc(asStr(o.date).trim(), 20),
    category: trunc(asStr(o.category).trim(), 100),
    source: trunc(asStr(o.source).trim(), 100),
    summary: trunc(asStr(o.summary).trim(), 600),
    deadline: trunc(asStr(o.deadline).trim(), 20),
    attachments,
    changeKind,
    contest: trunc(asStr(o.contest).trim(), 60),
    stage: STAGES.includes(stage) ? stage : '',
    audiences,
    action: trunc(asStr(o.action).trim(), 90),
    aiCategory: AI_CATEGORIES.includes(aiCategory) ? aiCategory : '',
    aiSummary: trunc(asStr(o.aiSummary).trim(), 200),
    aiUrgency: URGENCIES.includes(aiUrgency) ? aiUrgency : '',
    aiReason: trunc(asStr(o.aiReason).trim(), 160),
    aiEvents: normalizeEvents(o.aiEvents),
    aiConfidence: asNum(o.aiConfidence),
    aiVersion: trunc(asStr(o.aiVersion).trim(), 40),
  };
}

/** 赛程白名单：只接受合法日期，非法行整条丢弃。 */
function normalizeSchedule(raw: unknown): ContestSchedule[] {
  if (!Array.isArray(raw)) return [];
  const out: ContestSchedule[] = [];
  for (const item of raw.slice(0, 40)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const contest = trunc(asStr(o.contest).trim(), 60);
    if (!contest) continue;
    const day = (v: unknown): string => {
      const s = asStr(v).trim();
      return validDate(s) ? s : '';
    };
    const row: ContestSchedule = {
      contest,
      signupStart: day(o.signupStart),
      signupEnd: day(o.signupEnd),
      submitStart: day(o.submitStart),
      submitEnd: day(o.submitEnd),
      finalStart: day(o.finalStart),
      finalEnd: day(o.finalEnd),
      sourceUrl: safeUrl(trunc(asStr(o.sourceUrl).trim(), 500)),
    };
    // 一个日期都没有的赛程对日历没有意义，直接丢弃
    if (!row.signupStart && !row.signupEnd && !row.submitEnd && !row.finalStart && !row.finalEnd) continue;
    out.push(row);
  }
  return out;
}

/**
 * 通知 + 赛程存在同一条 KV 记录里，这里一次读出、两个视图共用。
 *
 * 之前 loadNotices / loadSchedule 各读一次同一个 key：一次日历请求就要 2 次 KV 读。
 * 现在合并成 1 次，并加 60 秒的 isolate 内缓存 —— 同一个边缘节点上的高频轮询
 * （归档页刷新、多个订阅者的日历同时拉取）基本不再回源 KV。
 */
interface FeedData {
  notices: Notice[];
  schedule: ContestSchedule[];
  generatedAt: string;
}

const FEED_TTL_MS = 60_000;
let feedCache: { at: number; data: FeedData } | null = null;

/** 写入新数据后必须清掉内存缓存，否则同一 isolate 会继续返回旧内容。 */
export function invalidateFeed(): void {
  feedCache = null;
}

export async function loadFeed(env: Env): Promise<FeedData> {
  const now = Date.now();
  if (feedCache && now - feedCache.at < FEED_TTL_MS) return feedCache.data;
  try {
    // cacheTtl：让 Cloudflare 边缘缓存这次读取，60 秒内同节点不再回源 KV。
    const raw = await env.SUBS.get('feed:notices', { cacheTtl: 60 });
    if (!raw) {
      feedCache = { at: now, data: { notices: [], schedule: [], generatedAt: '' } };
      return feedCache.data;
    }
    const data = (JSON.parse(raw) || {}) as FeedPayload;
    const notices = Array.isArray(data.notices)
      ? (data.notices as unknown[])
          .slice(0, 300)
          .map(normalizeNotice)
          .filter((n): n is Notice => n !== null)
      : [];
    const schedule = normalizeSchedule(data.schedule);
    const generatedAt = asStr(data.generatedAt).trim();
    feedCache = { at: now, data: { notices, schedule, generatedAt } };
    return feedCache.data;
  } catch {
    // 解析失败时宁可返回上一次的好数据，也不要让所有订阅者的日历一起变空
    return feedCache?.data ?? { notices: [], schedule: [], generatedAt: '' };
  }
}

async function loadNotices(env: Env): Promise<Notice[]> {
  return (await loadFeed(env)).notices;
}

async function loadSchedule(env: Env): Promise<ContestSchedule[]> {
  return (await loadFeed(env)).schedule;
}

/** 日期倒序（YYYY-MM-DD 可直接按字符串比较）。 */
function sorted(notices: Notice[]): Notice[] {
  return [...notices].sort((a, b) => b.date.localeCompare(a.date));
}

/** YYYY-MM-DD 是否可解析；pubDate / DTSTART 共用。 */
function validDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
}

/* ---------------------------- XML / iCal 转义 ---------------------------- */

/**
 * 自己实现的 XML 转义：只输出 & < > " ' 对应的基础实体（与 esc() 同一套取值，
 * 均为合法 XML），不复用 esc()，也不引入 &nbsp; 等 HTML 专有实体；不会出现裸 &。
 */
function xmlEsc(v: unknown): string {
  return asStr(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** iCalendar TEXT 值转义：反斜杠、分号、逗号、换行。 */
function icalEsc(v: unknown): string {
  return asStr(v)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/* ---------------------------- 响应头 ---------------------------- */

/** 合并安全头，把 no-store 换成可缓存的 public（仍保留 no-transform）。 */
function cacheableHeaders(contentType: string, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...securityHeaders() };
  h['Cache-Control'] = cacheControl(600);
  return { ...h, 'Content-Type': contentType, ...extra };
}

/* ---------------------------- 1. 写入接口 ---------------------------- */

export async function handleNoticesPost(req: Request, env: Env): Promise<Response> {
  const cfg = getConfig(env);
  const auth = req.headers.get('Authorization') || '';
  const expected = `Bearer ${cfg.adminToken}`;
  if (!cfg.adminToken || !safeEqual(auth, expected)) {
    return jsonResp({ ok: false, message: 'unauthorized' }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResp({ ok: false, message: 'invalid json' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResp({ ok: false, message: 'invalid payload' }, 400);
  }
  const payload = body as FeedPayload;
  if (!Array.isArray(payload.notices) || payload.notices.length > 300) {
    return jsonResp({ ok: false, message: 'invalid notices' }, 400);
  }

  const notices = (payload.notices as unknown[])
    .map(normalizeNotice)
    .filter((n): n is Notice => n !== null);
  const schedule = normalizeSchedule(payload.schedule);
  const site = asStr(payload.site).trim() || cfg.siteName;
  const baseUrl = asStr(payload.baseUrl).trim() || cfg.baseUrl;
  const generatedAt = asStr(payload.generatedAt).trim() || new Date().toISOString();

  try {
    await env.SUBS.put('feed:notices', JSON.stringify({ site, baseUrl, generatedAt, notices, schedule }));
  } catch {
    return jsonResp({ ok: false, message: 'store failed' }, 500);
  }
  // 立刻失效本 isolate 的缓存：写完马上读（CI 的冒烟步骤、测试）必须是新数据
  invalidateFeed();
  return jsonResp({ ok: true, count: notices.length, schedule: schedule.length });
}

/* ---------------------------- 2. 归档页 ---------------------------- */

/**
 * 归档页：只负责取数并把数据交给 `ui/archive`。
 * 筛选、卡片、日历与样式都在 UI 层，改版式不需要动这里。
 */
export async function handleArchive(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  try {
    const feed = await loadFeed(env);
    return renderArchive({
      notices: feed.notices,
      schedule: feed.schedule,
      generatedAt: feed.generatedAt,
      url,
    });
  } catch {
    return renderArchiveError();
  }
}

/** 个人日历 token 的有效期：加一次长期使用，给足 10 年。 */
export const CAL_TTL_DAYS = 3650;

/**
 * 从 `?email=&token=` 校验日历身份。
 *
 * **不再提供公共日历**：没有签名 / 签名不对 / token 过期一律拒绝，
 * 由调用方返回 401。这样每个人看到的都只是自己勾选的赛事与角色，
 * 也避免公开日历被爬虫或陌生人当免费数据源。
 *
 * 返回 `prefs: null` 表示「签名有效但 KV 里查不到该用户」（如已注销）：
 * 此时按不过滤处理，让链接到期的老用户至少不会看到空白日历。
 */
interface CalendarIdentity {
  email: string;
  prefs: Prefs | null;
}

async function calendarIdentity(env: Env, url: URL): Promise<CalendarIdentity | null> {
  const email = (url.searchParams.get('email') || '').trim().toLowerCase();
  const token = (url.searchParams.get('token') || '').trim();
  if (!email || !token) return null;
  if (!(await verifyEmailToken(env, email, token, 'cal', CAL_TTL_DAYS))) return null;
  // 日历每 15 分钟轮询一次，偏好却很少改：60 秒边缘缓存足够，能挡住重试与多设备并发
  const user = await getUser(env.SUBS, email, { cacheTtl: 60 });
  return { email, prefs: user?.prefs ?? null };
}

/** 按订阅者偏好过滤事件：赛事取交集，角色取并集；全站级通知不受赛事筛选影响。 */
function applyPrefs<T extends { contest?: string; audiences?: string[] }>(
  items: T[],
  prefs: Prefs | null,
): T[] {
  if (!prefs) return items;
  const contests = (prefs.contests || []).filter(Boolean);
  const roles = AUDIENCES.filter((a) => prefs.audiences?.[a as keyof typeof prefs.audiences]);
  return items.filter((n) => {
    if (contests.length && n.contest && !contests.includes(n.contest)) return false;
    // 与邮件端一致：角色一个都没勾等价于「不限制」（历史账号字段缺失时也走这里）
    if (!roles.length) return true;
    const auds = n.audiences || [];
    if (auds.length && !auds.some((a) => roles.includes(a))) return false;
    return true;
  });
}


/** 控制台展示的个人日历地址（签名绑定邮箱，只读）。 */
export async function personalCalendarUrl(env: Env, email: string): Promise<string> {
  const base = getConfig(env).baseUrl;
  if (!base || !email) return "";
  const token = await signEmailToken(env.UNSUB_SECRET, email, "cal", CAL_TTL_DAYS);
  // 没有签名密钥就不生成链接：宁可让用户看不到入口，也不发一个无效地址
  if (!token) return "";
  return `${base}/calendar.ics?email=${encodeURIComponent(email.toLowerCase())}&token=${token}`;
}

/* ---------------------------- 3. RSS ---------------------------- */

function pubDateOf(date: string): string {
  if (!validDate(date)) return '';
  return new Date(`${date}T00:00:00Z`).toUTCString();
}

export async function handleFeed(env: Env): Promise<Response> {
  const headers = cacheableHeaders('application/rss+xml;charset=utf-8');
  try {
    const cfg = getConfig(env);
    const notices = sorted(await loadNotices(env));
    const lines: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0"><channel>',
      `<title>${xmlEsc(cfg.siteName)}</title>`,
      `<link>${xmlEsc(cfg.baseUrl)}</link>`,
      `<description>${xmlEsc('研电赛通知订阅中心的最近通知归档')}</description>`,
    ];
    for (const n of notices) {
      const desc = [n.aiSummary || n.summary];
      for (const e of n.aiEvents || []) {
        const label = e.label || (e.kind === 'deadline' ? '截止' : '日程');
        desc.push(`${label}：${e.date}${e.location ? `（${e.location}）` : ''}`);
      }
      if (!(n.aiEvents || []).length && n.deadline) desc.push(`截止 / 日程：${n.deadline}`);
      if (n.stage) desc.push(`阶段：${n.stage}`);
      if ((n.audiences || []).length) {
        desc.push(`面向：${(n.audiences || []).map((a) => AUDIENCE_LABELS[a] || a).join(' / ')}`);
      }
      if (n.action) desc.push(`要做什么：${n.action}`);
      if (n.aiUrgency === 'critical') desc.push('【重要】');
      if (n.changeKind === 'changed') desc.push('【更新】该通知有更新');
      lines.push('<item>');
      lines.push(`<title>${xmlEsc(n.title)}</title>`);
      lines.push(`<link>${xmlEsc(safeUrl(n.url))}</link>`);
      lines.push(`<guid isPermaLink="false">${xmlEsc(n.uid)}</guid>`);
      const pd = pubDateOf(n.date);
      if (pd) lines.push(`<pubDate>${xmlEsc(pd)}</pubDate>`);
      lines.push(`<description>${xmlEsc(desc.filter(Boolean).join('\n'))}</description>`);
      lines.push(`<category>${xmlEsc(n.category)}</category>`);
      lines.push('</item>');
    }
    lines.push('</channel></rss>');
    return new Response(lines.join('\n'), { headers });
  } catch {
    return new Response('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel></channel></rss>', {
      status: 500,
      headers,
    });
  }
}

/* ---------------------------- 4. 日历 ---------------------------- */

/** 当前 UTC 时间，格式 YYYYMMDDTHHMMSSZ。 */
function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** 取 baseUrl 的 hostname 作为 UID 后缀，保持延期时 UID 稳定不变。 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname || 'yds-notifier';
  } catch {
    return 'yds-notifier';
  }
}

function dateCompact(s: string): string {
  return validDate(s) ? s.replace(/-/g, '') : '';
}

/** 全天事件的次日，用于 DTEND（部分客户端没有 DTEND 会显示成 0 天）。 */
function nextDay(compact: string): string {
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T00:00:00Z`;
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * SEQUENCE 由事件内容派生：内容一变值就变，订阅客户端会刷新该事件；
 * UID 保持不变，避免延期时产生重复事件（RFC 5545）。
 */
function seqOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h % 100000);
}

/** 写入一个 VALARM（全天事件按「当天 00:00 前 N 天」触发）。 */
function pushAlarm(lines: string[], days: number, desc: string): void {
  lines.push('BEGIN:VALARM');
  lines.push(`TRIGGER:-P${days}D`);
  lines.push('ACTION:DISPLAY');
  lines.push(`DESCRIPTION:${icalEsc(desc)}`);
  lines.push('END:VALARM');
}

/** 按 URL 查询参数过滤：?contest=赛事名&audience=角色（日历接口用）。 */
function filterByUrl<T extends { contest?: string; audiences?: string[] }>(items: T[], url: URL): T[] {
  const contest = (url.searchParams.get('contest') || '').trim();
  const audience = (url.searchParams.get('audience') || '').trim();
  if (!contest && !audience) return items;
  return items.filter((n) => {
    if (contest && n.contest !== contest) return false;
    if (audience && !(n.audiences || []).includes(audience)) return false;
    return true;
  });
}

export async function handleCalendar(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const ident = await calendarIdentity(env, url);
  if (!ident) {
    // 公共日历已下线：只有控制台 / 邮件签发的个人链接可用
    return new Response(
      '日历需要个人订阅地址。请登录控制台复制「我的日历」链接后再订阅。\n',
      {
        status: 401,
        headers: {
          ...securityHeaders(),
          'Content-Type': 'text/plain;charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
        },
      },
    );
  }
  const headers = cacheableHeaders('text/calendar;charset=utf-8', {
    'Content-Disposition': 'inline; filename="yds-notices.ics"',
    // 个人日历只允许浏览器 / 客户端私有缓存，避免中间代理串号
    'Cache-Control': 'private, max-age=300',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  try {
    const cfg = getConfig(env);
    const prefs = ident.prefs;
    const notices = applyPrefs(filterByUrl(await loadNotices(env), url), prefs);
    const scopedContest = (url.searchParams.get('contest') || '').trim();
    const scopedAudience = (url.searchParams.get('audience') || '').trim();
    // 订阅者关注的赛事：没有显式 contest 参数时按个人偏好收敛赛程
    const myContests = (prefs?.contests || []).filter(Boolean);
    // 赛程是赛事级数据，没有角色属性：只按赛事过滤，避免角色链接把赛程全丢掉
    const schedule = (await loadSchedule(env)).filter((s) => {
      if (scopedContest) return s.contest === scopedContest;
      if (!prefs) return true;
      return !myContests.length || myContests.includes(s.contest);
    });
    const roleTag = prefs
      ? AUDIENCES.filter((a) => prefs.audiences?.[a as keyof typeof prefs.audiences])
          .map((a) => AUDIENCE_LABELS[a] || a)
          .join('/')
      : '';
    const calName = `${cfg.siteName}日历${scopedContest ? ` · ${scopedContest}` : ''}${
      scopedAudience ? ` · ${AUDIENCE_LABELS[scopedAudience] || scopedAudience}` : ''
    }${roleTag ? ` · ${roleTag}` : ''}`;
    const stamp = utcStamp(new Date());
    const host = hostOf(cfg.baseUrl);
    const seenUid = new Set<string>();
    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//yds-notifier//Notice Calendar//ZH',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${icalEsc(calName)}`,
      'X-WR-TIMEZONE:Asia/Shanghai',
    ];

    // 1) 官方赛程：把所有已配置赛事的报名 / 提交 / 决赛节点提前放进日历，
    //    这样即使官网几个月不发新通知，订阅者也能看到关键时间。
    for (const s of schedule) {
      for (const item of scheduleEntries(s)) {
        const start = dateCompact(item.date);
        if (!start) continue;
        const uid = `schedule:${s.contest}:${item.label}:${item.date}@${host}`;
        if (seenUid.has(uid)) continue;
        seenUid.add(uid);
        const summary = `【${item.label}】${s.contest}`;
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:${icalEsc(uid)}`);
        lines.push(`DTSTAMP:${stamp}`);
        lines.push(`DTSTART;VALUE=DATE:${start}`);
        lines.push(`DTEND;VALUE=DATE:${nextDay(start)}`);
        lines.push(`SUMMARY:${icalEsc(summary)}`);
        if (s.sourceUrl) lines.push(`URL:${s.sourceUrl}`);
        lines.push(`DESCRIPTION:${icalEsc(`官方赛程：${s.contest}｜${item.label}｜${item.date}\n请以研创网最新通知为准。`)}`);
        lines.push(`SEQUENCE:${seqOf(`${s.contest}|${item.label}|${item.date}`)}`);
        lines.push('TRANSP:TRANSPARENT');
        if (item.deadline) {
          pushAlarm(lines, 7, `${s.contest}：${item.label}还有 7 天`);
          pushAlarm(lines, 1, `${s.contest}：${item.label}明天到期`);
        }
        lines.push('END:VEVENT');
      }
    }

    // 2) 通知正文里抽出的真实事件日
    for (const n of notices) {
      // 优先用 AI 从公告正文抽出的真实事件日；没有时才回退到规则 deadline 或发布日期。
      // 一条公告有多个时间节点（报名截止 + 决赛 + 公示期）就生成多个 VEVENT。
      const events = n.aiEvents || [];
      const pairs: Array<{ start: string; ev?: AiEvent }> = [];
      if (events.length) {
        for (const ev of events) {
          const day = dateCompact(ev.date);
          if (day) pairs.push({ start: day, ev });
        }
      } else {
        const day = dateCompact(n.deadline) || dateCompact(n.date);
        if (day) pairs.push({ start: day });
      }
      if (!pairs.length) continue;

      const stageTag = n.stage && n.stage !== '其他' ? `【${n.stage}】` : '';
      const base = `${n.changeKind === 'changed' ? '【更新】' : ''}`
        + `${n.aiUrgency === 'critical' ? '【重要】' : ''}${stageTag}[${n.category}] ${n.title}`;
      const descParts = [n.aiSummary || n.summary];
      if (n.source) descParts.push(`来源：${n.source}`);
      const href = safeUrl(n.url);

      pairs.forEach(({ start, ev }, idx) => {
        const parts = [...descParts];
        if (ev?.evidence) parts.push(`原文日期：${ev.evidence}`);
        if (ev?.location) parts.push(`地点：${ev.location}`);
        // 单事件沿用旧 UID；多事件加序号，保证延期时不产生重复
        const uid = pairs.length > 1 ? `${n.uid}:${idx}@${host}` : `${n.uid}@${host}`;
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:${icalEsc(uid)}`);
        lines.push(`DTSTAMP:${stamp}`);
        lines.push(`DTSTART;VALUE=DATE:${start}`);
        lines.push(`DTEND;VALUE=DATE:${nextDay(start)}`);
        lines.push(`SUMMARY:${icalEsc(base + (ev?.label ? ` · ${ev.label}` : ''))}`);
        if (href) lines.push(`URL:${href}`);
        if (ev?.location) lines.push(`LOCATION:${icalEsc(ev.location)}`);
        lines.push(`DESCRIPTION:${icalEsc(parts.filter(Boolean).join('\n'))}`);
        lines.push(`SEQUENCE:${seqOf(`${n.uid}|${start}|${ev?.label}|${ev?.evidence}|${n.aiSummary}`)}`);
        lines.push('TRANSP:TRANSPARENT');
        // 截止类事件给 -3 天 / -1 天提醒（全天事件由客户端按当地时区触发）
        if (ev?.kind === 'deadline') {
          pushAlarm(lines, 3, `${n.title}：${ev.label || '截止'}还有 3 天`);
          pushAlarm(lines, 1, `${n.title}：${ev.label || '截止'}明天到期`);
        }
        lines.push('END:VEVENT');
      });
    }
    lines.push('END:VCALENDAR');
    return new Response(lines.join('\r\n') + '\r\n', { headers });
  } catch {
    return new Response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n', { status: 500, headers });
  }
}
