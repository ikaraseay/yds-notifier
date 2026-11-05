/**
 * 运行时配置的唯一入口（与 Python 端 yds/config.py 保持同一套派生规则）。
 *
 * 来源：Cloudflare Dashboard → Workers & Pages → <worker> → Settings →
 *       Variables and Secrets（本地调试用 worker/.dev.vars）。
 * 注意：Workers Builds 的 "Build variables" 只在构建期可见，运行时读不到。
 *
 * 单一事实源：域名只填 CUSTOM_DOMAIN（或 WORKERS_DEV_URL），
 * 对外地址、退订链接、订阅名单地址全部自动派生。
 */

export interface Env {
  // ---------- Secrets ----------
  UNSUB_SECRET: string;
  UNSUB_SECRET_PREVIOUS?: string; // 密钥轮换期的旧密钥
  RESEND_API_KEY: string;
  SUBSCRIBE_API_TOKEN?: string; // 与 GitHub 同名同值
  /** Resend webhook 的签名密钥（whsec_...），未配置时 webhook 端点关闭 */
  RESEND_WEBHOOK_SECRET?: string;
  /** @deprecated 旧部署兼容，新部署统一用 SUBSCRIBE_API_TOKEN */
  ADMIN_TOKEN?: string;

  // ---------- Variables ----------
  CUSTOM_DOMAIN?: string; // 自定义域名，仅 hostname；绑定后自动作为对外地址
  WORKERS_DEV_URL?: string; // workers.dev 地址，兜底 + CSRF 白名单
  PUBLIC_BASE_URL?: string; // 高级覆盖，一般留空
  SITE_NAME?: string;
  MAIL_FROM_ADDRESS: string;
  MAIL_FROM_NAME?: string;
  MAIL_TO?: string;
  UNSUB_TTL_DAYS?: string;
  MAX_PER_IP_HOUR?: string;
  MAX_CONFIRM_PER_DAY?: string;
  LIST_RATE_PER_HOUR?: string;
  /** 是否要求二次确认订阅；"false" / "0" 关闭（老部署平滑升级用） */
  DOUBLE_OPT_IN?: string;
  /** @deprecated 旧部署兼容：完整的 "名称 <地址>" */
  MAIL_FROM?: string;

  // ---------- Bindings ----------
  SUBS: KVNamespace;
  RATE: DurableObjectNamespace;
}

export interface Config {
  siteName: string;
  customDomain: string;
  workersDevUrl: string;
  baseUrl: string;
  /** 所有合法的对外来源，用于 CSRF 的 Origin 白名单 */
  allowedOrigins: string[];
  mailFrom: string;
  mailTo: string;
  adminToken: string;
  unsubTtlDays: number;
  maxPerIpHour: number;
  maxConfirmPerDay: number;
  listRatePerHour: number;
  doubleOptIn: boolean;
  webhookSecret: string;
}

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 把 "https://a.com/x"、"a.com" 都归一化成 origin（https://a.com）。 */
export function normalizeOrigin(v: string): string {
  const raw = (v || "").trim();
  if (!raw) return "";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return "";
  }
}

export function cleanHost(v: string): string {
  let s = (v || "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  return s.split("/")[0].split(":")[0].trim();
}

/**
 * 对外地址派生链（与 Python config.derive_base_url 完全一致）：
 *   显式 PUBLIC_BASE_URL → https://<CUSTOM_DOMAIN> → WORKERS_DEV_URL
 */
export function deriveBaseUrl(
  explicit: string = "",
  customDomain: string = "",
  workersDevUrl: string = "",
): string {
  let base = (explicit || "").trim().replace(/\/+$/, "");
  if (!base) {
    const host = cleanHost(customDomain);
    if (host && host.includes(".")) base = `https://${host}`;
  }
  if (!base) base = (workersDevUrl || "").trim().replace(/\/+$/, "");
  return base;
}

export function getConfig(env: Env): Config {
  const customDomain = cleanHost(env.CUSTOM_DOMAIN || "");
  const workersDevUrl = (env.WORKERS_DEV_URL || "").trim().replace(/\/+$/, "");
  const baseUrl = deriveBaseUrl(env.PUBLIC_BASE_URL, customDomain, workersDevUrl);

  const origins = new Set<string>();
  for (const v of [baseUrl, customDomain ? `https://${customDomain}` : "", workersDevUrl, env.PUBLIC_BASE_URL || ""]) {
    const o = normalizeOrigin(v);
    if (o) origins.add(o);
  }

  const mailFrom = env.MAIL_FROM_ADDRESS
    ? `${env.MAIL_FROM_NAME || "研电赛通知"} <${env.MAIL_FROM_ADDRESS}>`
    : env.MAIL_FROM || "";

  return {
    siteName: env.SITE_NAME || "研电赛通知订阅",
    customDomain,
    workersDevUrl,
    baseUrl,
    allowedOrigins: [...origins],
    mailFrom,
    mailTo: env.MAIL_TO || "",
    // 新名优先，旧名兜底
    adminToken: env.SUBSCRIBE_API_TOKEN || env.ADMIN_TOKEN || "",
    unsubTtlDays: positiveInt(env.UNSUB_TTL_DAYS, 180),
    maxPerIpHour: positiveInt(env.MAX_PER_IP_HOUR, 10),
    maxConfirmPerDay: positiveInt(env.MAX_CONFIRM_PER_DAY, 200),
    listRatePerHour: positiveInt(env.LIST_RATE_PER_HOUR, 60),
    doubleOptIn: !/^(0|false|no)$/i.test((env.DOUBLE_OPT_IN || "true").trim()),
    webhookSecret: (env.RESEND_WEBHOOK_SECRET || "").trim(),
  };
}

/**
 * 生成所有对外链接前必须调用。绝不回退到 new URL(req.url).origin ——
 * 那是 Host 头注入钓鱼的入口。没有配置就 fail-closed。
 * 支持自定义域名、带路径的地址，以及本地 http://localhost。
 */
export function requireBaseUrl(env: Env): string {
  const base = getConfig(env).baseUrl;
  try {
    const u = new URL(base);
    const httpsOk = u.protocol === "https:" && Boolean(u.hostname);
    const localOk = u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/i.test(u.hostname);
    if ((httpsOk || localOk) && !u.search && !u.hash) {
      return u.toString().replace(/\/+$/, "");
    }
  } catch {
    // 落到下面的统一报错
  }
  throw new Error(
    "没有可用的对外地址：请在 Cloudflare Variables 填 CUSTOM_DOMAIN 或 WORKERS_DEV_URL（或显式 PUBLIC_BASE_URL）",
  );
}
