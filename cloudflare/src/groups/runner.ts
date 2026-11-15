import { getUser, isSuppressed, sha256 } from "../accounts/auth";
import { sendMail } from "../mail/sender";
import { requireBaseUrl, type Env } from "../platform/env";
import { jsonResp } from "../platform/http";
import { esc, safeEqual } from "../platform/security";
import { loadGroup, parseConfig } from "./repository";
import type { Change, GroupConfig, Skill } from "./types";

const HOUR = 3600000;
const WAIT = 6 * HOUR;
const MAX_GROUPS_PER_RUN = 10;

function resultSources(before: GroupConfig, value: unknown): GroupConfig | null {
  if (!Array.isArray(value) || value.length !== before.sources.length) return null;
  const sources = before.sources.map((source, index) => {
    const result = value[index];
    if (!result || result.url !== source.url || !["ready", "blocked", "error"].includes(result.status) ||
        typeof result.detail !== "string" || typeof result.sample !== "string" ||
        typeof result.prompt !== "string" || typeof result.baseline !== "string" ||
        !/^(?:[a-f0-9]{64})?$/.test(result.baseline)) return null;
    return {
      ...source, status: result.status, detail: result.detail.slice(0, 240),
      sample: result.sample.slice(0, 1200), baseline: result.baseline,
      prompt: source.prompt || result.prompt.slice(0, 600),
      checked: result.checked === true ? Date.now() : source.checked,
    };
  });
  if (sources.some(source => source === null)) return null;
  return { ...before, sources: sources as GroupConfig["sources"] };
}

function deliveryTime(now: number, freq: string): number {
  if (freq === "instant") return now;
  const day = 24 * HOUR;
  const morning = Math.floor((now - 2 * HOUR) / day) * day + 2 * HOUR;
  if (freq === "daily") return morning + day;
  const weekday = new Date(morning + 8 * HOUR).getUTCDay();
  return morning + ((8 - weekday) % 7 || 7) * day;
}

export async function handleGroupRunner(req: Request, env: Env): Promise<Response> {
  const db = env.GROUPS;
  if (!db || !env.GROUP_RUNNER_TOKEN) return jsonResp({ message: "runner disabled" }, 503);
  const bearer = req.headers.get("Authorization") || "";
  if (!safeEqual(bearer, `Bearer ${env.GROUP_RUNNER_TOKEN}`)) return jsonResp({ message: "unauthorized" }, 401);
  const now = Date.now();
  if (req.method === "GET") {
    const rows = await db.prepare(`SELECT id,revision,visibility,draft,published,skill
      FROM notification_groups WHERE next_check<=?
      AND (published IS NOT NULL OR visibility='pending' OR json_extract(draft,'$.enabled')=1 OR EXISTS (
        SELECT 1 FROM json_each(draft,'$.sources') WHERE json_extract(value,'$.status') IS NULL))
      ORDER BY next_check,id LIMIT ?`).bind(now, MAX_GROUPS_PER_RUN).all();
    return jsonResp({ groups: rows.results });
  }
  const reader = req.body?.getReader();
  if (!reader) return jsonResp({ message: "missing body" }, 400);
  const decoder = new TextDecoder();
  let bytes = 0;
  let input = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 200000) {
      await reader.cancel();
      return jsonResp({ message: "body too large" }, 413);
    }
    input += decoder.decode(value, { stream: true });
  }
  let body: Record<string, unknown> | null;
  try { body = JSON.parse(input + decoder.decode()); } catch { body = null; }
  if (body?.action === "deliver") return deliverGroups(db, env, now);
  if (!body || typeof body.id !== "string" || !Number.isInteger(body.revision)) return jsonResp({ message: "bad result" }, 400);
  const row = await loadGroup(db, body.id);
  if (!row || row.revision !== body.revision) return jsonResp({ message: "stale revision" }, 409);
  const draft = resultSources(parseConfig(row.draft), body.draft);
  const published = row.published ? resultSources(parseConfig(row.published), body.published) : null;
  if (!draft || (row.published && !published)) return jsonResp({ message: "invalid sources" }, 400);
  const statements: D1PreparedStatement[] = [];
  let publicChanges = false;
  for (const [config, raw, shared] of [[draft, body.privateChanges, false], [published, body.publicChanges, true]] as const) {
    if (!config?.enabled || !Array.isArray(raw) || !raw.length) continue;
    const changes: Change[] = raw.filter((item): item is Change => item && typeof item.summary === "string" &&
      config.sources.some(source => source.url === item.url && source.status === "ready")).slice(0, 10);
    if (!changes.length) continue;
    const message = JSON.stringify(changes.map(c => ({ url: c.url, summary: c.summary.slice(0, 800) })));
    const hash = await sha256(`${row.id}:${row.revision}:${Number(shared)}`);
    const subject = `[MeoNotifier] ${config.name} · 网站更新`;
    if (shared) {
      publicChanges = true;
      statements.push(db.prepare(`INSERT INTO group_deliveries(id,group_id,email,subject,body,due,shared)
        SELECT CASE WHEN s.frequency='instant' THEN ?||':'||s.email
          ELSE g.id||':'||s.email||':'||s.frequency||':'||CASE s.frequency WHEN 'daily' THEN ? ELSE ? END END,
          g.id,s.email,?,?,CASE s.frequency WHEN 'daily' THEN ? WHEN 'weekly' THEN ? ELSE ? END,1
        FROM group_subscriptions s JOIN notification_groups g ON g.id=s.group_id
        WHERE g.id=? AND g.revision=? AND g.published IS NOT NULL
        ON CONFLICT(id) DO UPDATE SET body=json_insert(group_deliveries.body,'$[#]',json(excluded.body))
          WHERE group_deliveries.sent IS NULL AND group_deliveries.attempt_until=0`)
        .bind(hash, deliveryTime(now, "daily"), deliveryTime(now, "weekly"), subject, message,
          deliveryTime(now, "daily"), deliveryTime(now, "weekly"), now, row.id, row.revision));
    } else {
      statements.push(db.prepare(`INSERT OR IGNORE INTO group_deliveries(id,group_id,email,subject,body,due)
        SELECT ?,id,owner,?,?,? FROM notification_groups WHERE id=? AND revision=?`)
        .bind(hash, subject, message, now, row.id, row.revision));
    }
  }
  let skill = row.skill;
  if (skill && publicChanges && body.evaluated === true) {
    const current = JSON.parse(skill) as Skill;
    current.evaluated = (current.evaluated || 0) + 1;
    const candidate = typeof body.candidate === "string" ? body.candidate.trim() : "";
    const evidence = typeof body.evidence === "string" ? body.evidence.trim() : "";
    if (candidate && candidate.length <= 600 && candidate !== current.guidance && evidence) {
      current.candidate = candidate;
      current.evidence = evidence.slice(0, 1000);
    }
    skill = JSON.stringify(current);
  }
  statements.push(db.prepare(`UPDATE notification_groups SET draft=?,published=?,skill=?,revision=revision+1,next_check=?
    WHERE id=? AND revision=?`).bind(JSON.stringify(draft), published ? JSON.stringify(published) : null, skill, now + WAIT, row.id, row.revision));
  const results = await db.batch(statements);
  return results.at(-1)?.meta.changes ? jsonResp({ ok: true }) : jsonResp({ message: "stale revision" }, 409);
}

async function deliverGroups(db: D1Database, env: Env, now: number): Promise<Response> {
  type Delivery = { id: string; group_id: string; email: string; subject: string; body: string; shared: number };
  const deliveries = await db.prepare(`SELECT id,group_id,email,subject,body,shared FROM group_deliveries
    WHERE sent IS NULL AND due<=? AND attempt_until<=? ORDER BY due LIMIT 25`).bind(now, now).all<Delivery>();
  const dashboard = requireBaseUrl(env) + "/groups";
  let sent = 0;
  let failures = 0;
  for (const delivery of deliveries.results) {
    const claim = await db.prepare("UPDATE group_deliveries SET attempt_until=? WHERE id=? AND sent IS NULL AND attempt_until<=?")
      .bind(now + 600000, delivery.id, now).run();
    if (!claim.meta.changes) continue;
    const row = await loadGroup(db, delivery.group_id);
    const active = delivery.shared ? row?.published : row?.draft;
    const subscribed = !delivery.shared || !!await db.prepare("SELECT 1 FROM group_subscriptions WHERE group_id=? AND email=?")
      .bind(delivery.group_id, delivery.email).first();
    if (!active || !row || !await getUser(env.SUBS, row.owner) || !subscribed || !parseConfig(active).enabled || !await getUser(env.SUBS, delivery.email) ||
        await isSuppressed(env.SUBS, delivery.email)) {
      await db.prepare("DELETE FROM group_deliveries WHERE id=?").bind(delivery.id).run();
      continue;
    }
    const allowed = new Set(parseConfig(active).sources.filter(source => source.status === "ready").map(source => source.url));
    const content = [...new Set((JSON.parse(delivery.body) as (Change | Change[])[]).flat()
      .filter(change => allowed.has(change.url)).map(change => `${change.summary}\n${change.url}`))].join("\n\n");
    if (!content) {
      await db.prepare("DELETE FROM group_deliveries WHERE id=?").bind(delivery.id).run();
      continue;
    }
    const body = content.slice(0, 12000) + "\n\n管理订阅 " + dashboard;
    const outcome = await sendMail(env, delivery.email, delivery.subject,
      `<p>${esc(content.slice(0, 12000)).replace(/\n/g, "<br>")}</p><p><a href="${esc(dashboard)}">管理订阅</a></p>`,
      body, {}, await sha256(delivery.id));
    if (outcome.ok) {
      await db.prepare("UPDATE group_deliveries SET sent=? WHERE id=?").bind(now, delivery.id).run();
      sent++;
    } else failures++;
  }
  await db.prepare("DELETE FROM group_deliveries WHERE sent<?").bind(now - 30 * 24 * HOUR).run();
  return jsonResp({ sent, failures }, failures ? 502 : 200);
}
