/**
 * 通知归档 / RSS / 日历订阅，以及供 Python 端写入通知元数据的接口。
 *
 * KV: feed:notices -> JSON 字符串（FeedPayload）。写入时按白名单清洗，
 * 读取侧再清洗一次，避免 KV 被直接写入时把脏数据带进对外页面。
 */

import { getConfig, type Env } from '../env';
import { esc, safeEqual, securityHeaders } from '../security';
import { jsonResp, page } from '../ui/layout';

interface Attachment {
  name: string;
  url: string;
}

/** AI 抽出的真实事件日（已由 Python 端确定性归一化成 YYYY-MM-DD）。 */
interface AiEvent {
  date: string;
  evidence: string;
  label: string;
  kind: string;
  location: string;
  confidence: number;
}

interface Notice {
  uid: string;
  title: string;
  url: string;
  date: string;
  category: string;
  source: string;
  summary: string;
  deadline: string;
  attachments?: Attachment[];
  changeKind?: 'new' | 'changed';
  aiCategory?: string;
  aiSummary?: string;
  aiUrgency?: string;
  aiReason?: string;
  aiEvents?: AiEvent[];
  aiConfidence?: number;
  aiVersion?: string;
}

const URGENCIES = ['critical', 'high', 'normal', 'low'];
const AI_CATEGORIES = ['报名参赛', '评审与名单', '决赛与收官', '赛事动态', '其他通知'];
const EVENT_KINDS = ['deadline', 'event', 'notice', 'other'];

interface FeedPayload {
  site?: string;
  baseUrl?: string;
  generatedAt?: string;
  notices?: unknown; // 运行期再校验是否为数组
}

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
    aiCategory: AI_CATEGORIES.includes(aiCategory) ? aiCategory : '',
    aiSummary: trunc(asStr(o.aiSummary).trim(), 200),
    aiUrgency: URGENCIES.includes(aiUrgency) ? aiUrgency : '',
    aiReason: trunc(asStr(o.aiReason).trim(), 160),
    aiEvents: normalizeEvents(o.aiEvents),
    aiConfidence: asNum(o.aiConfidence),
    aiVersion: trunc(asStr(o.aiVersion).trim(), 40),
  };
}

/** 读 KV：读不到 / 解析失败都按空列表处理，绝不向外抛错。 */
async function loadNotices(env: Env): Promise<Notice[]> {
  try {
    const raw = await env.SUBS.get('feed:notices');
    if (!raw) return [];
    const data = JSON.parse(raw) as FeedPayload;
    if (!data || !Array.isArray(data.notices)) return [];
    return (data.notices as unknown[])
      .slice(0, 300)
      .map(normalizeNotice)
      .filter((n): n is Notice => n !== null);
  } catch {
    return [];
  }
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

/** 合并安全头，但把 no-store 换成可缓存的 public。 */
function cacheableHeaders(contentType: string, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...securityHeaders() };
  delete h['Cache-Control'];
  return { ...h, 'Content-Type': contentType, 'Cache-Control': 'public, max-age=600', ...extra };
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
  const site = asStr(payload.site).trim() || cfg.siteName;
  const baseUrl = asStr(payload.baseUrl).trim() || cfg.baseUrl;
  const generatedAt = asStr(payload.generatedAt).trim() || new Date().toISOString();

  try {
    await env.SUBS.put('feed:notices', JSON.stringify({ site, baseUrl, generatedAt, notices }));
  } catch {
    return jsonResp({ ok: false, message: 'store failed' }, 500);
  }
  return jsonResp({ ok: true, count: notices.length });
}

/* ---------------------------- 2. 归档页 ---------------------------- */

function archiveItem(n: Notice): string {
  const meta = [n.date, n.category, n.source].filter(Boolean).map(esc).join(' · ');
  const updated = n.changeKind === 'changed' ? ' <span class="count">更新</span>' : '';
  const important = n.aiUrgency === 'critical' ? ' <span class="count">重要</span>' : '';
  const href = safeUrl(n.url);
  const title = esc(n.title);
  const link = href
    ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${title}</a>`
    : title;
  const events = (n.aiEvents || [])
    .map((e) => {
      const label = e.label || (e.kind === 'deadline' ? '截止' : '日程');
      const where = e.location ? ` · ${esc(e.location)}` : '';
      return `<p class="sub">${esc(label)}：${esc(e.date)}${where}</p>`;
    })
    .join('');
  // 有结构化事件时不再重复显示旧的单值 deadline
  const deadline = !events && n.deadline ? `<p class="sub">截止 / 日程：${esc(n.deadline)}</p>` : '';
  const aiSummary = n.aiSummary ? `<p class="sub">摘要：${esc(n.aiSummary)}</p>` : '';
  return `<div class="detail">
    <p class="sub">${meta}${updated}${important}</p>
    <p>${link}</p>
    ${aiSummary}
    ${events}
    ${deadline}
  </div>`;
}

export async function handleArchive(env: Env): Promise<Response> {
  try {
    const notices = sorted(await loadNotices(env)).slice(0, 200);
    const nav = `<p class="sub">这里收录最近推送过的通知，错过邮件也能查到</p>
<p class="tip">
  <a href="/feed.xml">RSS 订阅（/feed.xml）</a> ·
  <a href="/calendar.ics">日历订阅（/calendar.ics）</a> ·
  <a href="/">返回首页</a>
</p>`;
    const list = notices.length
      ? notices.map(archiveItem).join('')
      : '<p class="sub">暂时还没有收录通知，过段时间再来看看吧。</p>';
    return page({ title: '通知归档', heading: '通知归档', body: `${nav}${list}` });
  } catch {
    return page({ title: '通知归档', heading: '通知归档', body: '<p class="sub">归档暂时无法加载，请稍后再试。</p>' }, 500);
  }
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

export async function handleCalendar(env: Env): Promise<Response> {
  const headers = cacheableHeaders('text/calendar;charset=utf-8', {
    'Content-Disposition': 'inline; filename="yds-notices.ics"',
  });
  try {
    const cfg = getConfig(env);
    const notices = await loadNotices(env);
    const stamp = utcStamp(new Date());
    const host = hostOf(cfg.baseUrl);
    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//yds-notifier//Notice Calendar//ZH',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${icalEsc(`${cfg.siteName}日历`)}`,
      'X-WR-TIMEZONE:Asia/Shanghai',
    ];
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

      const base = `${n.changeKind === 'changed' ? '【更新】' : ''}`
        + `${n.aiUrgency === 'critical' ? '【重要】' : ''}[${n.category}] ${n.title}`;
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
        lines.push('END:VEVENT');
      });
    }
    lines.push('END:VCALENDAR');
    return new Response(lines.join('\r\n') + '\r\n', { headers });
  } catch {
    return new Response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n', { status: 500, headers });
  }
}
