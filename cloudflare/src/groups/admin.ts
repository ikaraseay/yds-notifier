import WEB_MONITOR from "../../../skills/web-monitor/defaults.json";
import { getUser } from "../accounts/auth";
import { adminAuthenticated } from "../admin/handler";
import type { Env } from "../platform/env";
import { readForm, redirect, sameOrigin } from "../platform/http";
import { normalizeEmail } from "../platform/security";
import { GROUP_ADMIN_VIEWS, groupAdminPage } from "../ui/group-admin";
import { groupErrorPage } from "../ui/groups";
import { loadGroup, parseConfig, reviewReady } from "./repository";
import type { GroupRow } from "./types";

const fail = (message: string, status = 400) => groupErrorPage(message, status, "/admin/groups");

export async function handleGroupAdmin(req: Request, env: Env): Promise<Response> {
  const db = env.GROUPS;
  if (!await adminAuthenticated(req, env)) return redirect("/admin");
  if (!db) return fail("通知组尚未配置。", 503);
  if (req.method === "GET") {
    const url = new URL(req.url);
    const selected = url.searchParams.get("view") as (typeof GROUP_ADMIN_VIEWS)[number];
    const view = GROUP_ADMIN_VIEWS.includes(selected) ? selected : "pending";
    const query = (url.searchParams.get("q") || "").trim().slice(0, 100);
    const current = Math.min(10000, Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1)));
    const offset = (current - 1) * 25;
    const term = query.toLowerCase();
    const creators = view === "permissions" ? (await db.prepare(
      "SELECT email FROM group_creators WHERE instr(lower(email), ?) > 0 OR ? = '' ORDER BY email LIMIT 26 OFFSET ?",
    ).bind(term, term, offset).all<{email: string}>()).results : [];
    const groups = view !== "permissions" ? (await db.prepare(`SELECT * FROM notification_groups
      WHERE ${view === "pending" ? "visibility='pending'" : "published IS NOT NULL"}
      AND (? = '' OR instr(lower(owner), ?) > 0 OR instr(lower(json_extract(${view === "pending" ? "draft" : "published"},'$.name')), ?) > 0)
      ORDER BY id LIMIT 26 OFFSET ?`).bind(term, term, term, offset).all<GroupRow>()).results : [];
    return groupAdminPage(view, query, current, groups, creators, Boolean(env.GROUP_RUNNER_TOKEN), url.searchParams.get("done") || "");
  }
  if (!sameOrigin(req)) return fail("请求来源无效。", 403);
  const form = await readForm(req);
  const action = form?.get("action");
  if (action === "grant" || action === "revoke") {
    const { ok, email } = normalizeEmail(form?.get("email") || "");
    if (!ok || (action === "grant" && !await getUser(env.SUBS, email))) return fail("请输入已注册的邮箱。");
    if (action === "revoke" && form?.get("confirm") !== "yes") return fail("请确认收回权限。");
    await (action === "grant"
      ? db.prepare("INSERT OR IGNORE INTO group_creators VALUES (?,?)").bind(email, Date.now())
      : db.prepare("DELETE FROM group_creators WHERE email=?").bind(email)).run();
    return redirect(`/admin/groups?view=permissions&done=${action}`, undefined, 303);
  }
  const row = await loadGroup(db, form?.get("id") || "");
  if (!row || form?.get("revision") !== String(row.revision)) return fail("审核版本已有更新，请刷新。", 409);
  if (action === "approve" && row.visibility === "pending") {
    const draft = parseConfig(row.draft);
    if (!reviewReady(draft, Date.now()) || !await getUser(env.SUBS, row.owner)) return fail("请先完成所有网址的站点检查与试抓。", 409);
    const latest = await db.prepare("SELECT MAX(version) AS version FROM group_skills WHERE group_id=?")
      .bind(row.id).first<number>("version");
    const version = (latest || 0) + 1;
    const guidance = WEB_MONITOR.summaryGuidance;
    const skill = JSON.stringify({ version, guidance });
    const result = await db.batch([
      db.prepare(`INSERT OR IGNORE INTO group_skills SELECT ?,?,?,'公开初始版本',? WHERE EXISTS (
        SELECT 1 FROM notification_groups WHERE id=? AND revision=?)`).bind(row.id, version, guidance, Date.now(), row.id, row.revision),
      db.prepare("UPDATE notification_groups SET published=draft,skill=?,visibility='public',revision=revision+1,next_check=0 WHERE id=? AND revision=?")
        .bind(skill, row.id, row.revision),
    ]);
    if (!result.at(-1)?.meta.changes) return fail("审核版本已有更新，请刷新。", 409);
  } else if (action === "reject" || action === "unlist") {
    const reason = (form?.get("reason") || "").trim();
    if (action === "reject" && (!reason || reason.length > 240 || row.visibility !== "pending")) return fail("请填写退回原因。");
    if (action === "unlist" && (!row.published || form?.get("confirm") !== "yes")) return fail("请确认下架。");
    const keep = action === "reject" ? row.published : null;
    const statements = [];
    if (action === "unlist") {
      statements.push(db.prepare(`DELETE FROM group_subscriptions WHERE group_id=? AND EXISTS (
        SELECT 1 FROM notification_groups WHERE id=? AND revision=?)`).bind(row.id, row.id, row.revision));
      statements.push(db.prepare(`DELETE FROM group_deliveries WHERE group_id=? AND shared=1 AND sent IS NULL AND EXISTS (
        SELECT 1 FROM notification_groups WHERE id=? AND revision=?)`).bind(row.id, row.id, row.revision));
    }
    statements.push(db.prepare("UPDATE notification_groups SET published=?,skill=?,visibility=?,review_note=?,revision=revision+1,next_check=0 WHERE id=? AND revision=?")
      .bind(keep, keep ? row.skill : null, keep ? "public" : "private", reason || "管理员已下架", row.id, row.revision));
    const result = await db.batch(statements);
    if (!result.at(-1)?.meta.changes) return fail("审核版本已有更新，请刷新。", 409);
  } else return fail("未知审核操作。");
  return redirect(`/admin/groups?view=${action === "approve" || action === "unlist" ? "public" : "pending"}&done=${action}`, undefined, 303);
}
