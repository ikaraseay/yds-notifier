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
  SUBS: { get: async key => kv.get(key) ?? null, put: async (key, value) => { kv.set(key, value); } },
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
const permissions = await (await call("/admin/groups?view=permissions&q=OWNER", { actor: admin })).text();
assert.match(permissions, /owner@domain\.net/);
assert.equal((await manage({ action: "revoke", email: owner })).status, 400);
const created = await group(owner, { action: "create", name: "校园公告" });
assert.equal(created.status, 303);
const editor = created.headers.get("Location");
assert.match(editor, /view=mine&done=create&id=/);
assert.match(await (await call(editor, { actor: owner })).text(), /添加并试抓/);
assert.doesNotMatch(await (await call(editor, { actor: reader })).text(), /校园公告/);
const invalidUrl = await ownerAction("add", { urls: "https://site.net/news\n没有协议的网址" });
assert.equal(invalidUrl.status, 400);
assert.match(await invalidUrl.text(), new RegExp(`/groups\\?view=mine&amp;id=${stored().id}`));
assert.equal((await ownerAction("add", { urls: "https://site.net/announcements\nhttps://site.net/feed" })).status, 303);
assert.equal(JSON.parse(stored().draft).sources.length, 2);
assert.ok(!(await (await group(reader)).text()).includes("校园公告"));
assert.equal((await group(reader, { action: "subscribe", id: stored().id })).status, 404);
assert.equal((await call("/api/group-runner", { token: "admin-secret" })).status, 401);
const tasks = (await (await runner()).json()).groups;
assert.equal(tasks.length, 1);
assert.ok(Number(kv.get("meta:group-runner:last-seen")) > 0);
assert.ok(!Object.hasOwn(tasks[0], "owner"));
const scanned = JSON.parse(stored().draft).sources.map((source, index) => ({
  ...source, status: "ready", detail: "通过", sample: "样本", prompt: `提示词 ${index}`, baseline: hash(String(index)), checked: true,
}));
assert.equal((await save({ draft: scanned })).status, 200);
assert.equal((await ownerAction("enable")).status, 303);
env.SUBSCRIBE_API_TOKEN = "shared-runner-secret";
assert.equal((await call("/api/group-runner", { token: env.SUBSCRIBE_API_TOKEN })).status, 401);
delete env.SUBSCRIBE_API_TOKEN;
const runnerToken = env.GROUP_RUNNER_TOKEN;
try {
  delete env.GROUP_RUNNER_TOKEN;
  env.SUBSCRIBE_API_TOKEN = "shared-runner-secret";
  assert.equal((await call("/api/group-runner", { token: env.SUBSCRIBE_API_TOKEN })).status, 200);
  assert.match(await (await call(editor, { actor: owner })).text(), /重新试抓/);
  delete env.SUBSCRIBE_API_TOKEN;
  const offline = await (await call(editor, { actor: owner })).text();
  assert.match(offline, /试抓服务尚未启用/);
  assert.doesNotMatch(offline, /申请公开<\/button>/);
  assert.equal((await ownerAction("request-public", { confirm: "yes" })).status, 503);
} finally {
  env.GROUP_RUNNER_TOKEN = runnerToken;
}
assert.equal((await ownerAction("request-public", { confirm: "yes" })).status, 303);
assert.equal((await review("approve")).status, 409);
const pendingUrl = "/admin/groups?view=pending&q=" + encodeURIComponent("校园公告");
const pending = await (await call(pendingUrl, { actor: admin })).text();
assert.match(pending, /提示词 0/);
assert.doesNotMatch(pending, /通过并公开/);
const blocked = scanned.map((source, index) => index ? source : { ...source, status: "blocked", detail: "robots.txt 禁止抓取", checked: false });
assert.equal((await save({ draft: blocked })).status, 200);
assert.match(await (await call(editor, { actor: owner })).text(), /网址复检未通过/);
assert.match(await (await call(pendingUrl, { actor: admin })).text(), /网址复检未通过/);
assert.equal((await save({ draft: scanned })).status, 200);
assert.match(await (await call(pendingUrl, { actor: admin })).text(), /通过并公开/);
assert.equal((await review("approve")).status, 303);
assert.equal((await ownerAction("rename", { name: "新版校园公告" })).status, 303);
assert.equal(JSON.parse(stored().draft).name, "新版校园公告");
const publicAdmin = await (await call("/admin/groups?view=public", { actor: admin })).text();
assert.match(publicAdmin, /校园公告/);
assert.doesNotMatch(publicAdmin, /新版校园公告/);
assert.equal((await review("unlist")).status, 400);
const directory = await (await group(reader)).text();
assert.ok(directory.includes(owner) && directory.includes("校园公告") && !directory.includes("提示词 0"));
assert.equal((await group(reader, { action: "subscribe", id: stored().id, frequency: "instant" })).status, 303);
const changes = [{ url: scanned[0].url, summary: "公告更新" }];
assert.equal((await save({ publicChanges: changes, evaluated: true, candidate: "写明更新日期", evidence: "原文给出了新日期" })).status, 200);
assert.match(await (await call(editor, { actor: owner })).text(), /评估依据.*原文给出了新日期/);
assert.equal(JSON.parse(stored().skill).evaluated, 1);
assert.equal((await runner({ action: "deliver" })).status, 200);
assert.equal((await runner({ action: "deliver" })).status, 200);
assert.equal(mail.length, 1);
assert.deepEqual(mail[0].to, [reader]);
assert.ok(mail[0].subject.startsWith("[MeoNotifier]"));
assert.equal((await ownerAction("apply-skill")).status, 303);
assert.equal(JSON.parse(stored().skill).version, 2);
assert.equal((await ownerAction("rollback-skill")).status, 303);
assert.equal(JSON.parse(stored().skill).guidance, "先写本轮发生的实质变化，再写原文明确给出的日期、对象或下一步行动。");
assert.equal((await group(reader, { action: "subscribe", id: stored().id, frequency: "daily" })).status, 303);
assert.match(await (await call("/groups?view=subscribed", { actor: reader })).text(), /value="daily" selected/);
assert.equal((await save({ publicChanges: changes })).status, 200);
assert.equal((await save({ publicChanges: [{ ...changes[0], summary: "第二条公告" }] })).status, 200);
assert.equal(JSON.parse(stored().skill).evaluated, 1);
const digest = sqlite.prepare("SELECT body FROM group_deliveries WHERE sent IS NULL").all();
assert.equal(digest.length, 1);
assert.equal(JSON.parse(digest[0].body).flat().length, 2);
assert.equal((await ownerAction("withdraw")).status, 303);
assert.equal((await runner({ action: "deliver" })).status, 200);
assert.equal(mail.length, 1);
assert.ok(!(await (await group(reader)).text()).includes(owner));
assert.equal((await manage({ action: "revoke", email: owner, confirm: "yes" })).status, 303);
assert.equal((await group(owner, { action: "create", name: "其他通知" })).status, 403);
assert.match(await (await call(editor, { actor: owner })).text(), /新版校园公告/);
// A queued probe must preserve its baseline and be discoverable even while paused.
assert.equal((await ownerAction("pause")).status, 303);
const priorBaseline = JSON.parse(stored().draft).sources[0].baseline;
assert.equal((await ownerAction("probe", { index: "0" })).status, 303);
assert.equal(JSON.parse(stored().draft).sources[0].baseline, priorBaseline);
assert.equal(JSON.parse(stored().draft).sources[0].status, undefined);
assert.equal((await (await runner()).json()).groups.length, 1);
assert.equal((await ownerAction("probe", { index: "999" })).status, 400);
assert.equal((await save({ draft: scanned })).status, 200);
assert.equal((await ownerAction("enable")).status, 303);
assert.equal((await ownerAction("settings", { frequency: "daily", guidance: "写明截止日期" })).status, 303);
assert.equal(JSON.parse(stored().draft).frequency, "daily");
assert.equal(JSON.parse(stored().draft).guidance, "写明截止日期");
assert.equal((await save({ privateChanges: changes })).status, 200);
assert.equal((await save({ privateChanges: [{ ...changes[0], summary: "新的截止日期" }] })).status, 200);
const ownerDigest = sqlite.prepare("SELECT body,due FROM group_deliveries WHERE email=? AND sent IS NULL").all(owner);
assert.equal(ownerDigest.length, 1);
assert.ok(ownerDigest[0].due > Date.now());
assert.equal(JSON.parse(ownerDigest[0].body).flat().length, 2);
assert.equal((await ownerAction("pause")).status, 303);
assert.equal(sqlite.prepare("SELECT count(*) AS n FROM group_deliveries WHERE email=? AND sent IS NULL").get(owner).n, 0);
assert.equal((await call("/skills")).status, 302);
const skills = await (await call("/skills", { actor: owner })).text();
assert.match(skills, /科研通知/);
assert.match(skills, /新版校园公告/);
assert.match(skills, /href="\/skills\/yds"/);
assert.equal((await group(owner, { action: "create", template: "research", name: "科研通知" })).status, 403);
assert.equal((await manage({ action: "grant", email: owner })).status, 303);
assert.equal((await group(owner, { action: "create", template: "missing", name: "错误模板" })).status, 400);
assert.equal((await group(owner, { action: "create", template: "research", name: "科研通知" })).status, 303);
const research = sqlite.prepare("SELECT * FROM notification_groups WHERE json_extract(draft,'$.templateId')='research'").get();
const researchConfig = JSON.parse(research.draft);
assert.equal(researchConfig.sources.length, 6);
assert.ok(researchConfig.sources.every(source => source.prompt.includes("截止")));
assert.equal(researchConfig.enabled, false);
assert.match(await (await call(`/groups?view=mine&id=${research.id}`, { actor: owner })).text(), /保存通知设置/);
assert.doesNotMatch(await (await call(`/groups?view=mine&id=${research.id}`, { actor: reader })).text(), /保存通知设置/);
console.log("通知组 E2E 通过");
