/**
 * 把配置从「单一事实源」同步到 wrangler.toml。
 *
 * 读取顺序：进程环境变量（Workers Builds 的 Build variables / 本地 shell）
 *          > 仓库根目录 .env
 *          > wrangler.toml 里已有的值（保持不动）
 *
 * 只负责两件部署期配置：
 *   - KV namespace id（资源标识，非密钥）
 *   - Cloudflare 自定义域名 → [[routes]] custom_domain = true
 *
 * 运行时变量（密钥、发信地址等）不在这里，必须填 Dashboard 的
 * Variables and Secrets —— 构建期变量在 Worker 运行时读不到。
 *
 * 用法：npm run sync-config
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(HERE, "..");
const ROOT = path.resolve(WORKER_DIR, "..");
const TOML_PATH = path.join(WORKER_DIR, "wrangler.toml");
const ENV_PATH = path.join(ROOT, ".env");

const BEGIN = "# --- BEGIN AUTO-CONFIG (由 npm run sync-config 生成，勿手动修改) ---";
const END = "# --- END AUTO-CONFIG ---";

function readDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const raw = m[2];
    const quoted = raw.match(/^\s*(["'])(.*?)\1/);
    out[m[1]] = quoted ? quoted[2] : raw.split(/\s+#/)[0].trim();
  }
  return out;
}

const fromFile = readDotEnv(ENV_PATH);
const get = (key) => (process.env[key] || fromFile[key] || "").trim();

function cleanHost(v) {
  return (v || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .replace(/:\d+$/, "")
    .trim();
}

const src = fs.readFileSync(TOML_PATH, "utf8");
const blockRe = new RegExp(
  `${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
);
if (!blockRe.test(src)) {
  console.error(`[sync-config] wrangler.toml 缺少 AUTO-CONFIG 标记，已跳过以免破坏配置`);
  process.exit(1);
}

// 现有值兜底：没在 .env / 构建变量里提供时，保留文件里已经填好的内容
const existingId = (src.match(/# --- BEGIN AUTO-CONFIG[\s\S]*?\bid\s*=\s*"([^"]*)"/) || [])[1] || "";
const existingHost = cleanHost((src.match(/\bpattern\s*=\s*"([^"]*)"/) || [])[1] || "");

const rawId = get("KV_SUBS_ID");
const kvId = rawId && !rawId.includes("REPLACE_WITH") && rawId !== "replace-with-your-kv-namespace-id"
  ? rawId
  : existingId || "REPLACE_WITH_YOUR_KV_ID";

const domainSetting = get("CUSTOM_DOMAIN");
const rawDomain = cleanHost(domainSetting);
// CUSTOM_DOMAIN=none / off / false 可显式关闭自定义域名（清除 [[routes]]）
const disabled = ["none", "off", "false"].includes(domainSetting.trim().toLowerCase());
const usableNew = rawDomain && !rawDomain.includes("your-domain") && !rawDomain.includes("<");
const usableOld = existingHost && existingHost.includes(".") && !existingHost.includes("your-domain");
const customDomain = disabled ? "" : usableNew ? rawDomain : usableOld ? existingHost : "";

// 只允许域名与 KV id 的合法字符，避免 .env 内容破坏 TOML 结构
if (!/^[a-zA-Z0-9_-]+$/.test(kvId)) {
  console.error(`[sync-config] KV_SUBS_ID 含非法字符：${kvId}`);
  process.exit(1);
}
if (kvId === "REPLACE_WITH_YOUR_KV_ID") {
  console.error("[sync-config] 未提供 KV_SUBS_ID（.env 或 Build variables），已中止以免部署无效绑定");
  process.exit(1);
}
if (customDomain && (!/^[a-z0-9.-]+$/.test(customDomain) || !customDomain.includes("."))) {
  console.error(`[sync-config] CUSTOM_DOMAIN 不是合法 hostname：${customDomain}`);
  process.exit(1);
}

const routes = customDomain
  ? `\n[[routes]]\npattern = ${JSON.stringify(customDomain)}\ncustom_domain = true\n`
  : `\n# 未配置 CUSTOM_DOMAIN：仅通过 workers.dev 访问\n`;

const block = `${BEGIN}\nid = ${JSON.stringify(kvId)}\n${routes}${END}`;
const next = src.replace(blockRe, block);
if (next !== src) fs.writeFileSync(TOML_PATH, next);

console.log(`[sync-config] KV_SUBS_ID 已注入（长度 ${kvId.length}）`);
console.log(
  customDomain
    ? `[sync-config] 自定义域名 = ${customDomain}（workers.dev 仍保留）`
    : "[sync-config] 未启用自定义域名，使用 workers.dev",
);
