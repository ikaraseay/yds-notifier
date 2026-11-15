import { getUser } from "../accounts/auth";
import { adminAuthenticated } from "../admin/handler";
import type { Env } from "../platform/env";
import { readForm, redirect, sameOrigin } from "../platform/http";
import { esc, normalizeEmail } from "../platform/security";
import { groupErrorPage, groupForm } from "../ui/groups";
import { page } from "../ui/layout";
import { loadGroup, parseConfig } from "./repository";
import type { GroupRow } from "./types";

const REVIEW_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function handleGroupAdmin(req: Request, env: Env): Promise<Response> {
  const db = env.GROUPS;
  if (!await adminAuthenticated(req, env)) return redirect("/admin");
  if (!db) return groupErrorPage("通知组尚未配置。", 503);
  if (req.method === "GET") {
    const [pending, creators] = await Promise.all([
      db.prepare("SELECT * FROM notification_groups WHERE visibility='pending' OR published IS NOT NULL ORDER BY id").all<GroupRow>(),
      db.prepare("SELECT email FROM group_creators ORDER BY email").all<{email:string}>(),
    ]);
    const form = (action: string, id: string, label: string, fields = "") =>
      groupForm(action, id, label, fields).replace('action="/groups"', 'action="/admin/groups"');
    return page({ title: "通知组管理", heading: "通知组管理", wide: true, body: `
      <a href="/admin">返回管理后台</a>
      ${form("grant", "", "授予创建权限", '<label>用户邮箱<input class="field" type="email" name="email" required></label>')}
      ${creators.results.map(c => form("revoke", "", "收回权限", `${esc(c.email)} <input type="hidden" name="email" value="${esc(c.email)}">`)).join("")}
      <section class="section"><h2>公开审核与下架</h2>
      ${pending.results.map(row => {
        const config = parseConfig(row.draft);
        const version = `<input type="hidden" name="revision" value="${row.revision}">`;
        return `<section class="section"><h3>${esc(config.name)} · ${esc(row.owner)}</h3>
          <p>${row.visibility === "pending" ? "待审核" : "已公开"}</p>
          <ul>${config.sources.map(s => `<li class="detail">${esc(s.url)} · ${esc(s.detail || "待试抓")}<br>${esc(s.prompt)}</li>`).join("")}</ul>
          ${row.visibility === "pending" ? form("approve", row.id, "审核通过并公开", version) + form("reject", row.id, "退回", version + '<label>退回原因<input class="field" name="reason" maxlength="240" required></label>') : ""}
          ${row.published ? form("unlist", row.id, "下架", version) : ""}</section>`;
      }).join("") || "<p>暂无审核中的或已公开的通知组。</p>"}</section>` });
  }
  if (!sameOrigin(req)) return groupErrorPage("请求来源无效。", 403);
  const form = await readForm(req);
  const action = form?.get("action");
  if (action === "grant" || action === "revoke") {
    const { ok, email } = normalizeEmail(form?.get("email") || "");
    if (!ok || (action === "grant" && !await getUser(env.SUBS, email))) return groupErrorPage("请输入已注册的邮箱。");
    await (action === "grant"
      ? db.prepare("INSERT OR IGNORE INTO group_creators VALUES (?,?)").bind(email, Date.now())
      : db.prepare("DELETE FROM group_creators WHERE email=?").bind(email)).run();
    return redirect("/admin/groups", undefined, 303);
  }
  const row = await loadGroup(db, form?.get("id") || "");
  if (!row || form?.get("revision") !== String(row.revision)) return groupErrorPage("审核版本已有更新，请刷新。", 409);
  if (action === "approve" && row.visibility === "pending") {
    const draft = parseConfig(row.draft);
    if (!draft.sources.length || draft.sources.some(s => s.status !== "ready" || !s.prompt || !s.baseline || !s.checked || Date.now() - s.checked > REVIEW_MAX_AGE_MS) ||
        !await getUser(env.SUBS, row.owner)) return groupErrorPage("请先完成所有网址的站点检查与试抓。", 409);
    const latest = await db.prepare("SELECT MAX(version) AS version FROM group_skills WHERE group_id=?")
      .bind(row.id).first<number>("version");
    const version = (latest || 0) + 1;
    const guidance = "优先说明实质变化，保留来源和原文链接。";
    const skill = JSON.stringify({ version, guidance });
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO group_skills SELECT ?,?,?,'公开初始版本',? WHERE EXISTS (
        SELECT 1 FROM notification_groups WHERE id=? AND revision=?)`).bind(row.id, version, guidance, Date.now(), row.id, row.revision),
      db.prepare("UPDATE notification_groups SET published=draft,skill=?,visibility='public',revision=revision+1,next_check=0 WHERE id=? AND revision=?")
        .bind(skill, row.id, row.revision),
    ]);
  } else if (action === "reject" || action === "unlist") {
    const reason = (form?.get("reason") || "").trim();
    if (action === "reject" && (!reason || reason.length > 240 || row.visibility !== "pending")) return groupErrorPage("请填写退回原因。");
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
    await db.batch(statements);
  } else return groupErrorPage("未知审核操作。");
  return redirect("/admin/groups", undefined, 303);
}
