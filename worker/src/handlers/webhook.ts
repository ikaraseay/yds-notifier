/**
 * Resend webhook：验签通过后，把硬退信 / 垃圾邮件投诉 / 被抑制的邮箱
 * 自动移出订阅名单，并写入永久抑制标记。
 *
 * 验签采用 Svix 规范（Resend 使用同一套）：
 *   signedContent = `${svix-id}.${svix-timestamp}.${rawBody}`
 *   signature     = base64(HMAC-SHA256(base64 解码后的密钥字节, signedContent))
 * svix-signature 里任一条 v1 签名常量时间命中即通过；失败统一 401，不回显细节。
 */

import { getSub, suppress } from '../auth';
import { getConfig, type Env } from '../env';
import { mailShell, sendMail } from '../mailer';
import { esc, safeEqual } from '../security';
import { jsonResp } from '../ui/layout';
import { getCount } from './api';

const enc = new TextEncoder();

/** 只有这三类事件会影响订阅名单。 */
const HANDLED_TYPES = ['email.bounced', 'email.complained', 'suppression.added'];

/** 把 unknown 安全地收窄成普通对象，数组与 null 一律视为空。 */
function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** 邮箱校验：小写、长度 <= 254、与 normalizeEmail 同款正则。 */
function validEmail(v: string): boolean {
  return (
    v.length <= 254 &&
    /^[a-z0-9._%+\-]+@[a-z0-9\-]+(\.[a-z0-9\-]+)*\.[a-z]{2,}$/.test(v)
  );
}

/** 按优先级从事件 data 里抽取收件邮箱：to / email / recipient / suppression.email。 */
function pickEmail(data: Record<string, unknown>): string {
  const to = data.to;
  let first: unknown = '';
  if (Array.isArray(to)) {
    first = to.length > 0 ? to[0] : '';
  } else if (typeof to === 'string') {
    first = to;
  }

  const supp = asRecord(data.suppression);
  const suppEmail: unknown = supp ? supp.email : '';

  for (const c of [first, data.email, data.recipient, suppEmail]) {
    if (typeof c === 'string' && c.trim()) return c.trim().toLowerCase();
  }
  return '';
}

/** 把 webhook secret 解成 HMAC key 的原始字节。 */
function secretKeyBytes(secret: string): Uint8Array {
  // whsec_ 只是前缀标识，真正的密钥是其后的 base64 串；
  // 不带前缀时也按 base64 处理。
  const b64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    // base64 解码失败：退回把 secret 原文按 UTF-8 当作密钥字节
    return enc.encode(secret);
  }
}

/** 计算 Svix v1 签名的 base64 形式。 */
async function computeSignature(secret: string, signedContent: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    secretKeyBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signedContent));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function handleResendWebhook(req: Request, env: Env): Promise<Response> {
  // 1. 只接受 POST，并带上 Allow 头（jsonResp 不支持自定义头，这里补一层）
  if (req.method !== 'POST') {
    const resp = jsonResp({ ok: false, message: 'method not allowed' }, 405);
    const headers = new Headers(resp.headers);
    headers.set('Allow', 'POST');
    return new Response(resp.body, { status: resp.status, headers });
  }

  const cfg = getConfig(env);

  // 2. fail-closed：未配置密钥则关闭端点，不读 body、不做任何处理
  if (!cfg.webhookSecret) return jsonResp({ ok: false }, 503);

  // 3. body 只读一次，验签与解析共用
  const rawBody = await req.text();

  // 4. Svix 验签
  const id = req.headers.get('svix-id') || '';
  const timestamp = req.headers.get('svix-timestamp') || '';
  const signatureHeader = req.headers.get('svix-signature') || '';
  if (!id || !timestamp || !signatureHeader) return jsonResp({ ok: false }, 401);

  // 时间戳为 Unix 秒，允许当前时间 ±300 秒，防重放
  const ts = Number(timestamp);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!/^\d+$/.test(timestamp) || !Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) {
    return jsonResp({ ok: false }, 401);
  }

  const expected = await computeSignature(cfg.webhookSecret, `${id}.${timestamp}.${rawBody}`);
  const candidates = signatureHeader
    .split(' ')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1,'))
    .map((part) => part.slice(3));
  let verified = false;
  for (const c of candidates) {
    if (safeEqual(c, expected)) {
      verified = true;
      break;
    }
  }
  if (!verified) return jsonResp({ ok: false }, 401);

  // 5. 解析事件体，读出 type 与 data
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return jsonResp({ ok: false }, 400);
  }
  const obj: Record<string, unknown> = asRecord(parsed) || {};
  const type = typeof obj.type === 'string' ? obj.type : '';
  const data: Record<string, unknown> = asRecord(obj.data) || {};

  // 6. 只处理三类事件
  if (!HANDLED_TYPES.includes(type)) return jsonResp({ ok: true, ignored: true });

  // 软退信不移除：bounce.type 存在且不含 permanent / hard 时忽略
  if (type === 'email.bounced') {
    const bounce = asRecord(data.bounce);
    const bounceType = bounce && typeof bounce.type === 'string' ? bounce.type : '';
    if (bounceType && !/permanent|hard/i.test(bounceType)) {
      return jsonResp({ ok: true, ignored: true });
    }
  }

  // 7. 提取并校验邮箱，无效则忽略
  const email = pickEmail(data);
  if (!validEmail(email)) return jsonResp({ ok: true, ignored: true });

  // 8. 移出订阅名单 + 写抑制标记
  const removed = !!(await getSub(env.SUBS, email));
  if (removed) {
    await env.SUBS.delete(`sub:${email}`);
    await env.SUBS.put('meta:count', String(Math.max(0, (await getCount(env)) - 1)));
  }
  // 即使原本不在名单里也要写抑制标记，防止以后重新登录又进名单
  await suppress(env.SUBS, email, type);

  // 非阻塞通知站长；失败只记录事件类型，绝不回显 secret / 签名 / 完整事件体
  if (cfg.mailTo) {
    const reasonText: Record<string, string> = {
      'email.bounced': '硬退信',
      'email.complained': '垃圾邮件投诉',
      'suppression.added': '被 Resend 加入抑制名单',
    };
    const reason = reasonText[type] || type;
    const safeEmail = esc(email);
    const intro =
      `<b>${safeEmail}</b> 因「${esc(reason)}」（事件 <code>${esc(type)}</code>）` +
      `被自动移出订阅名单，并写入永久抑制标记。`;
    const note = '该邮箱今后不会再收到研电赛通知邮件。此邮件由 webhook 自动触发，无需手动处理。';
    const html = mailShell('订阅名单自动清理', intro, '打开管理页', cfg.baseUrl, note, cfg.siteName);
    const text = `[自动清理] ${email} 因 ${type} 事件被移出订阅名单，已写入抑制标记。`;
    sendMail(env, cfg.mailTo, `【自动清理】${email}`, html, text).catch(() =>
      console.error('webhook 自动清理：站长通知发送失败，事件类型', type),
    );
  }

  return jsonResp({ ok: true, removed, type });
}
