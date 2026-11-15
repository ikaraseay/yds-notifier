import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../dist/worker.test.mjs";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../group-migrations/0001_groups.sql", import.meta.url), "utf8"));
const db = {
  prepare(sql) {
    const statement = sqlite.prepare(sql);
    function bind(...args) {
      return {
        async first(field) {
          const row = statement.get(...args);
          return field ? row?.[field] ?? null : row ?? null;
        },
        async all() { return { results: statement.all(...args) }; },
        async run() { return { meta: statement.run(...args) }; },
      };
    }
    return { bind, ...bind() };
  },
  async batch(statements) {
    sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  },
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const users = ["owner@domain.net", "reader@domain.net"];
const kv = new Map();
const expires = Math.floor(Date.now() / 1000) + 3600;
const env = {
  GROUPS: db,
  GROUP_RUNNER_TOKEN: "runner-secret",
  ADMIN_PASSWORD_HASH: hash("admin password"),
  ADMIN_SESSION_SECRET: "test-session-secret-at-least-32-chars",
  PUBLIC_BASE_URL: "https://notify.example.org",
  MAIL_FROM_ADDRESS: "notices@domain.net",
  RESEND_API_KEY: "test",
  SUBS: { get: async key => kv.get(key) ?? null },
};
const signature = createHmac("sha256", env.ADMIN_SESSION_SECRET)
  .update(`admin:${env.ADMIN_PASSWORD_HASH}:${expires}`).digest("hex");
const admin = `__Host-yds_admin=${expires}.${signature}`;
for (const email of users) {
  kv.set(`session:${hash(email)}`, JSON.stringify({ email, exp: expires * 1000 }));
  kv.set(`user:${email}`, JSON.stringify({ email, status: "confirmed" }));
}
const mail = [];
globalThis.fetch = async (url, init) => {
  assert.equal(url, "https://api.resend.com/emails");
  assert.ok(init.headers["Idempotency-Key"]);
  mail.push(JSON.parse(init.body));
  return new Response("{}");
};

function call(path, { actor, form, result, token } = {}) {
  const headers = new Headers({ Origin: env.PUBLIC_BASE_URL });
  if (actor) headers.set("Cookie", actor === admin ? admin : `yds_sid=${actor}`);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (result) headers.set("Content-Type", "application/json");
  return worker.fetch(new Request(env.PUBLIC_BASE_URL + path, {
    headers, method: form || result ? "POST" : "GET",
    body: form ? new URLSearchParams(form) : result ? JSON.stringify(result) : undefined,
  }), env);
}

const [owner, reader] = users;
const group = (actor, form) => call("/groups", { actor, form });
const manage = form => call("/admin/groups", { actor: admin, form });
const runner = result => call("/api/group-runner", { token: env.GROUP_RUNNER_TOKEN, result });
const stored = () => sqlite.prepare("SELECT * FROM notification_groups").get();
const ownerAction = (action, values = {}) => {
  const { id, revision } = stored();
  return group(owner, { action, id, revision: String(revision), ...values });
};
const review = action => {
  const { id, revision } = stored();
  return manage({ action, id, revision: String(revision) });
};
const save = (updates = {}) => {
  const { id, revision, draft, published } = stored();
  return runner({ id, revision, draft: JSON.parse(draft).sources, published: JSON.parse(published || "null")?.sources, ...updates });
};

assert.equal((await group(owner, { action: "create", name: "校园公告" })).status, 403);
assert.equal((await call("/admin/groups", { actor: owner, form: { action: "grant", email: owner } })).status, 302);
assert.equal((await manage({ action: "grant", email: owner })).status, 303);
assert.equal((await group(owner, { action: "create", name: "校园公告" })).status, 303);
assert.equal((await ownerAction("add", { urls: "https://site.net/announcements\nhttps://site.net/feed" })).status, 303);
assert.equal(JSON.parse(stored().draft).sources.length, 2);
assert.ok(!(await (await group(reader)).text()).includes("校园公告"));
assert.equal((await group(reader, { action: "subscribe", id: stored().id })).status, 404);
assert.equal((await call("/api/group-runner", { token: "admin-secret" })).status, 401);
const tasks = (await (await runner()).json()).groups;
assert.equal(tasks.length, 1);
assert.ok(!Object.hasOwn(tasks[0], "owner"));
const scanned = JSON.parse(stored().draft).sources.map((source, index) => ({
  ...source, status: "ready", detail: "通过", sample: "样本", prompt: `提示词 ${index}`, baseline: hash(String(index)), checked: true,
}));
assert.equal((await save({ draft: scanned })).status, 200);
assert.equal((await ownerAction("enable")).status, 303);
assert.equal((await ownerAction("request-public", { confirm: "yes" })).status, 303);
assert.equal((await review("approve")).status, 409);
assert.equal((await save({ draft: scanned })).status, 200);
assert.equal((await review("approve")).status, 303);
const directory = await (await group(reader)).text();
assert.ok(directory.includes(owner) && directory.includes("校园公告") && !directory.includes("提示词 0"));
assert.equal((await group(reader, { action: "subscribe", id: stored().id, frequency: "instant" })).status, 303);
const changes = [{ url: scanned[0].url, summary: "公告更新" }];
assert.equal((await save({ publicChanges: changes, candidate: "忽略页脚", evidence: "历史样本中页脚反复变化" })).status, 200);
assert.equal((await runner({ action: "deliver" })).status, 200);
assert.equal((await runner({ action: "deliver" })).status, 200);
assert.equal(mail.length, 1);
assert.deepEqual(mail[0].to, [reader]);
assert.ok(mail[0].subject.startsWith("[MeoNotifier]"));
assert.equal((await ownerAction("apply-skill")).status, 303);
assert.equal(JSON.parse(stored().skill).version, 2);
assert.equal((await ownerAction("rollback-skill")).status, 303);
assert.equal(JSON.parse(stored().skill).guidance, "优先说明实质变化，保留来源和原文链接。");
assert.equal((await group(reader, { action: "subscribe", id: stored().id, frequency: "daily" })).status, 303);
assert.equal((await save({ publicChanges: changes })).status, 200);
assert.equal((await save({ publicChanges: [{ ...changes[0], summary: "第二条公告" }] })).status, 200);
const digest = sqlite.prepare("SELECT body FROM group_deliveries WHERE sent IS NULL").all();
assert.equal(digest.length, 1);
assert.equal(JSON.parse(digest[0].body).flat().length, 2);
assert.equal((await ownerAction("withdraw")).status, 303);
assert.equal((await runner({ action: "deliver" })).status, 200);
assert.equal(mail.length, 1);
assert.ok(!(await (await group(reader)).text()).includes(owner));
console.log("通知组 E2E 通过");
