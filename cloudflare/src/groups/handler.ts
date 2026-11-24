import { getSession, getUser, readSessionToken } from "../accounts/auth";
import { groupRunnerToken, type Env } from "../platform/env";
import { readForm, redirect, sameOrigin } from "../platform/http";
import { groupErrorPage, groupsPage } from "../ui/groups";
import { loadGroup, parseConfig } from "./repository";
import type { GroupRow, Skill } from "./types";
import { findSkill } from "../skills/catalog";
import { parseLabels, readPreference } from "../skills/classification";
import type { Preference } from "./types";

const CONTROL = /[\u0000-\u001f\u007f]/;

export function inputUrl(raw: string): string {
  if (raw.length > 1000 || CONTROL.test(raw)) throw new Error();
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
  url.hash = "";
  return url.href;
}

function frequency(raw: string | null) {
  return raw === "daily" || raw === "weekly" ? raw : "instant";
}

export async function handleGroups(req: Request, env: Env): Promise<Response> {
  const db = env.GROUPS;
  if (!db) return groupErrorPage("通知组尚未配置。", 503);
  const email = await getSession(env.SUBS, readSessionToken(req));
  const user = email ? await getUser(env.SUBS, email) : null;
  if (!user || user.status === "pending") return redirect("/");
  const canCreate = !!await db.prepare("SELECT 1 FROM group_creators WHERE email=?").bind(email).first();
  if (req.method === "GET") {
    const [groups, subs] = await Promise.all([
      db.prepare(`SELECT g.* FROM notification_groups g WHERE g.owner=? OR (
        g.published IS NOT NULL AND (g.id IN (
          SELECT id FROM notification_groups WHERE published IS NOT NULL ORDER BY id LIMIT 100
        ) OR EXISTS (SELECT 1 FROM group_subscriptions WHERE group_id=g.id AND email=?))
      ) ORDER BY g.id`).bind(email, email).all<GroupRow>(),
      db.prepare("SELECT group_id,frequency,preference FROM group_subscriptions WHERE email=?").bind(email).all<{group_id: string; frequency: string; preference: string}>(),
    ]);
    return groupsPage(email, groups.results, new Map(subs.results.map(s => [s.group_id, s.frequency])), canCreate, new URL(req.url), Boolean(groupRunnerToken(env)), Number(await env.SUBS.get("meta:group-runner:last-seen")) || 0, new Map(subs.results.map(s => [s.group_id, JSON.parse(s.preference) as Preference])));
  }
  if (!sameOrigin(req)) return groupErrorPage("请求来源无效。", 403);
  const form = await readForm(req, 16000);
  const action = form?.get("action");
  if (!form || !action) return groupErrorPage("表单无效。");
  const id = form.get("id") || "";
  const back = (view = "mine", group = "") => {
    if (form.get("return") === "overview" && ["pause", "enable", "probe"].includes(action)) {
      return redirect(`/skills?done=${encodeURIComponent(action)}`, undefined, 303);
    }
    const params = new URLSearchParams({ view, done: action });
    if (group) params.set("id", group);
    const section = action === "settings" ? "#skill-delivery" : action === "prompt" ? "#source-" + Number(form.get("index")) : ["add", "probe", "remove-source"].includes(action) ? "#skill-sources" : "";
    return redirect(`/groups?${params}${section}`, undefined, 303);
  };
  const subscriptionView = form.get("view") === "subscribed" ? "subscribed" : "directory";
  if (action === "create") {
    if (!canCreate) return groupErrorPage("创建权限由管理员授予。", 403);
    const name = (form.get("name") || "").trim();
    if (!name || name.length > 80 || CONTROL.test(name)) return groupErrorPage("请输入有效的组名。");
    const template = findSkill(form.get("template") || "web-monitor");
    if (!template || template.kind !== "template") return groupErrorPage("未知通知 Skill 模板。");
    const config = {
      name, templateId: template.id, enabled: false, frequency: "instant", guidance: template.summaryGuidance, taxonomy: template.taxonomy,
      sources: template.sources.map(url => ({ url: inputUrl(url), prompt: template.monitorPrompt })),
    };
    const groupId = crypto.randomUUID();
    const result = await db.prepare(`INSERT INTO notification_groups (id, owner, draft)
      SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM group_creators WHERE email=?)
      AND (SELECT COUNT(*) FROM notification_groups WHERE owner=?) < 10`)
      .bind(groupId, email, JSON.stringify(config), email, email).run();
    return result.meta.changes ? back("mine", groupId) : groupErrorPage("已达到 10 个通知组的上限，或创建权限已收回。", 409);
  }
  if (action === "unsubscribe") {
    await db.batch([
      db.prepare("DELETE FROM group_subscriptions WHERE group_id=? AND email=?").bind(id, email),
      db.prepare("DELETE FROM group_deliveries WHERE group_id=? AND email=? AND shared=1 AND sent IS NULL").bind(id, email),
    ]);
    return back(subscriptionView);
  }
  const row = await loadGroup(db, id);
  if (action === "subscribe" && row?.published && row.owner !== email) {
    const preference = readPreference(form, parseConfig(row.published).taxonomy);
    if (!preference) return groupErrorPage("请在每个已有分类中至少选择一项。");
    const result = await db.prepare(`INSERT INTO group_subscriptions(group_id,email,frequency,preference)
      SELECT id,?,?,? FROM notification_groups WHERE id=? AND published IS NOT NULL AND revision=?
      ON CONFLICT(group_id,email) DO UPDATE SET frequency=excluded.frequency, preference=excluded.preference`)
      .bind(email, frequency(form.get("frequency")), JSON.stringify(preference), id, row.revision).run();
    return result.meta.changes ? back(subscriptionView) : groupErrorPage("通知组已停止公开。", 409);
  }
  if (!row || row.owner !== email) return groupErrorPage("未找到可编辑的通知组。", 404);
  const fail = (message: string, status = 400) =>
    groupErrorPage(message, status, `/groups?view=mine&id=${encodeURIComponent(id)}`);
  if (form.get("revision") !== String(row.revision)) return fail("通知组已有更新，请重新打开后重试。", 409);
  const draft = parseConfig(row.draft);
  if (action === "preferences") {
    const preference = readPreference(form,draft.taxonomy);
    if (!preference) return fail("请在每个已有分类中至少选择一项。");
    const result = await db.prepare("UPDATE notification_groups SET owner_preference=? WHERE id=? AND owner=? AND revision=?")
      .bind(JSON.stringify(preference),id,email,row.revision).run();
    return result.meta.changes ? back("mine",id) : fail("配置已有更新，请刷新。",409);
  }
  let { visibility, published, skill, review_note } = row;
  const statements: D1PreparedStatement[] = [];
  switch (action) {
    case "taxonomy":
      try {
        draft.taxonomy = { roles: parseLabels(form.get("roles") || ""), types: parseLabels(form.get("types") || "") };
      } catch {
        return fail("每类最多 20 项，每项最多 40 字。");
      }
      break;
    case "probe": {
      if (!groupRunnerToken(env)) return fail("试抓服务尚未启用，请联系管理员。", 503);
      const index = form.get("index");
      const sources = index === null ? draft.sources : /^\d+$/.test(index) && draft.sources[Number(index)] ? [draft.sources[Number(index)]] : [];
      if (!sources.length) return fail("请先添加有效网址。");
      for (const source of sources) {
        source.status = undefined;
        source.checked = undefined;
        source.detail = "已排队，等待下一轮试抓。";
      }
      break;
    }
    case "settings": {
      draft.frequency = frequency(form.get("frequency"));
      break;
    }
    case "rename": {
      const name = (form.get("name") || "").trim();
      if (!name || name.length > 80 || CONTROL.test(name)) return fail("请输入有效的组名。");
      draft.name = name;
      break;
    }
    case "add": {
      try {
        const urls = [...new Set((form.get("urls") || "").split(/\s+/).filter(Boolean).map(inputUrl))];
        const additions = urls.filter(url => !draft.sources.some(source => source.url === url));
        if (!urls.length || draft.sources.length + additions.length > 10) return fail("每个组最多监控 10 个网址。");
        for (const url of additions) draft.sources.push({ url, prompt: "" });
        for (const source of draft.sources) {
          if (urls.includes(source.url) && source.status !== "ready") {
            source.status = undefined;
            source.detail = undefined;
          }
        }
      } catch {
        return fail("请输入有效的 HTTP 或 HTTPS 网址。");
      }
      break;
    }
    case "remove-source": {
      const index = form.get("index") || "";
      const source = /^\d+$/.test(index) ? draft.sources[Number(index)] : undefined;
      if (!source) return fail("未找到这个网址。");
      draft.sources.splice(Number(index), 1);
      break;
    }
    case "enable":
      if (!draft.sources.some(source => source.status === "ready")) return fail("请先完成至少一个网址的试抓。");
      draft.enabled = true;
      if (published) published = JSON.stringify({ ...parseConfig(published), enabled: true });
      break;
    case "pause":
      draft.enabled = false;
      if (published) published = JSON.stringify({ ...parseConfig(published), enabled: false });
      break;
    case "request-public":
      if (!groupRunnerToken(env)) return fail("试抓服务尚未启用，暂时无法提交公开审核。", 503);
      if (form.get("confirm") !== "yes" || !draft.sources.length ||
          draft.sources.some(source => source.status !== "ready" || !source.prompt)) {
        return fail("请确认邮箱展示，并为每个成功试抓的网址填写提示词。");
      }
      visibility = "pending";
      review_note = "";
      for (const source of draft.sources) source.checked = undefined;
      break;
    case "delete": {
      if (form.get("confirm") !== "yes") return fail("请确认删除。");
      const result = await db.prepare("DELETE FROM notification_groups WHERE id=? AND revision=?").bind(id, row.revision).run();
      return result.meta.changes ? back() : fail("通知组已有更新，请重新打开后重试。", 409);
    }
    case "withdraw":
      visibility = "private";
      published = null;
      skill = null;
      break;
    case "apply-skill":
    case "rollback-skill": {
      if (!published || !skill) return fail("只有已公开的组可以管理 Skill。", 409);
      const current = JSON.parse(skill) as Skill;
      const previous = action === "rollback-skill" ? await db.prepare(
        "SELECT rules FROM group_skills WHERE group_id=? AND version<? ORDER BY version DESC LIMIT 1",
      ).bind(id, current.version).first<string>("rules") : null;
      const guidance = action === "apply-skill" ? current.candidate : previous;
      if (guidance === undefined || guidance === null) return fail("没有可采用的版本。");
      const version = current.version + 1;
      skill = JSON.stringify({ version, guidance, evaluated: current.evaluated });
      statements.push(db.prepare(`INSERT INTO group_skills SELECT ?,?,?,?,? WHERE EXISTS (
        SELECT 1 FROM notification_groups WHERE id=? AND revision=?)`)
        .bind(id, version, guidance, action === "apply-skill" ? current.evidence || "" : "组主恢复上一版本", Date.now(), id, row.revision));
      break;
    }
    default:
      return fail("未知操作。");
  }
  if (action === "withdraw") {
    statements.push(db.prepare(`DELETE FROM group_subscriptions WHERE group_id=? AND EXISTS (
      SELECT 1 FROM notification_groups WHERE id=? AND revision=?)`).bind(id, id, row.revision));
    statements.push(db.prepare(`DELETE FROM group_deliveries WHERE group_id=? AND shared=1 AND sent IS NULL AND EXISTS (
      SELECT 1 FROM notification_groups WHERE id=? AND revision=?)`).bind(id, id, row.revision));
  }
  if (["taxonomy", "add", "prompt", "remove-source", "rename", "settings", "probe"].includes(action) && visibility === "pending") {
    visibility = published ? "public" : "private";
    review_note = "内容已修改，请重新提交公开审核。";
  }
  statements.push(db.prepare(`UPDATE notification_groups SET draft=?,published=?,skill=?,visibility=?,review_note=?,revision=revision+1,next_check=0
    WHERE id=? AND revision=?`).bind(JSON.stringify(draft), published, skill, visibility, review_note, id, row.revision));
  if (action === "pause") {
    statements.unshift(db.prepare(`DELETE FROM group_deliveries WHERE group_id=? AND sent IS NULL AND EXISTS (
      SELECT 1 FROM notification_groups WHERE id=? AND revision=?)`).bind(id, id, row.revision));
  }
  const results = await db.batch(statements);
  return results.at(-1)?.meta.changes ? back("mine", id) : fail("通知组已有更新，请重新打开后重试。", 409);
}
