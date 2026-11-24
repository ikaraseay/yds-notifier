import { AUDIENCES, CATEGORIES, CATEGORY_LABEL_TO_KEY, getSession, getUser, readSessionToken } from "../accounts/auth";
import { handlePrefs } from "../accounts/dashboard";
import { adminAuthenticated } from "../admin/handler";
import { handleGroups } from "../groups/handler";
import { loadGroup, parseConfig } from "../groups/repository";
import type { Env } from "../platform/env";
import { jsonResp, readForm, sameOrigin } from "../platform/http";
import { NOTIFICATION_SKILLS } from "./catalog";
import { allNotices, parseLabels, readPreference, ydsPreference } from "./classification";

export async function skillApi(req: Request, env: Env, id = "", section = ""): Promise<Response> {
  const db = env.GROUPS;
  const email = await getSession(env.SUBS, readSessionToken(req));
  const user = email && await getUser(env.SUBS,email);
  const admin = await adminAuthenticated(req,env);
  if (!user && !admin) return jsonResp({message:"请先登录。"},401);
  if (!db) return jsonResp({message:"通知组存储尚未配置。"},503);
  if (!id) {
    const groups = await db.prepare(`SELECT id,json_extract(CASE WHEN owner=? OR ?=1 OR id='yds' THEN draft ELSE published END,'$.name') AS name
      FROM notification_groups WHERE owner=? OR ?=1 OR id='yds' OR published IS NOT NULL ORDER BY id LIMIT 200`)
      .bind(email,Number(admin),email,Number(admin)).all();
    return jsonResp({ templates:NOTIFICATION_SKILLS, skills:groups.results });
  }
  if (section === "job") {
    const job = await db.prepare(`SELECT j.id,j.group_id,j.status,j.evidence,j.revision,j.prior,j.candidate FROM skill_jobs j
      JOIN notification_groups g ON g.id=j.group_id WHERE j.id=? AND (g.owner=? OR ?=1)`).bind(id,email,Number(admin)).first();
    return job ? jsonResp(job) : jsonResp({message:"未找到任务。"},404);
  }
  const row = await loadGroup(db,id);
  const manage = admin || row?.owner === email;
  if (!row || (!manage && !row.published && id !== "yds")) return jsonResp({message:"未找到通知组。"},404);
  const config = parseConfig(manage || id === "yds" ? row.draft : row.published!);
  if (req.method === "GET") {
    if (section === "taxonomy") return jsonResp({revision:row.revision,taxonomy:config.taxonomy ?? {roles:[],types:[]}});
    if (!user) return jsonResp({message:"请先登录个人账号。"},401);
    if (id === "yds") return jsonResp({preference:ydsPreference(user.prefs),frequency:user.prefs.frequency,contests:user.prefs.contests});
    const sub = await db.prepare("SELECT frequency,preference FROM group_subscriptions WHERE group_id=? AND email=?").bind(id,email)
      .first<{frequency:string;preference:string}>();
    if (row.owner === email) return jsonResp({preference:JSON.parse(row.owner_preference || JSON.stringify(allNotices)),frequency:config.frequency});
    return jsonResp({subscription:sub ? {frequency:sub.frequency,preference:JSON.parse(sub.preference)} : null});
  }
  if (!sameOrigin(req)) return jsonResp({message:"请求来源无效。"},403);
  const form = await readForm(req,16000);
  if (!form) return jsonResp({message:"无效表单。"},400);
  if (section === "taxonomy") {
    if (!manage) return jsonResp({message:"没有修改权限。"},403);
    if (id === "yds") return jsonResp({message:"内置分类由赛事解析器维护。"},409);
    if (form.get("revision") !== String(row.revision)) return jsonResp({message:"配置版本已更新。"},409);
    if (!form.has("roles") || !form.has("types")) return jsonResp({message:"需要提供两个分类维度。"},400);
    try { config.taxonomy = {roles:parseLabels(form.get("roles")!),types:parseLabels(form.get("types")!)}; }
    catch { return jsonResp({message:"分类数量或名称长度超限。"},400); }
    const result = await db.prepare(`UPDATE notification_groups SET draft=?,revision=revision+1,
      visibility=CASE WHEN visibility='pending' THEN CASE WHEN published IS NULL THEN 'private' ELSE 'public' END ELSE visibility END
      WHERE id=? AND revision=?`).bind(JSON.stringify(config),id,row.revision).run();
    return jsonResp({ok:!!result.meta.changes}, result.meta.changes ? 200 : 409);
  }
  if (id === "yds") {
    if (!user) return jsonResp({message:"请先登录个人账号。"},401);
    const preference = readPreference(form,config.taxonomy);
    if (!preference) return jsonResp({message:"请选择有效的人员和通知类型。"},400);
    const enabled = preference.mode === "all";
    const settings = preference.mode === "paused" ? {pausedUntil:"9999-12-31"} : {
      pausedUntil:"",
      audiences:Object.fromEntries(AUDIENCES.map(role => [role.key,enabled || preference.roles.includes(role.key)])),
      ...Object.fromEntries(CATEGORIES.map(category => [category.key,enabled || preference.types.some(label => CATEGORY_LABEL_TO_KEY[label] === category.key)])),
    };
    const headers = new Headers(req.headers);
    headers.set("Content-Type","application/json");
    return handlePrefs(new Request(req.url,{method:"POST",headers,body:JSON.stringify({...settings,frequency:form.get("frequency") || user.prefs.frequency})}),env);
  }
  form.set("id",id);
  form.set("action",row.owner === email ? "preferences" : "subscribe");
  return handleGroups(new Request(req.url,{method:"POST",headers:req.headers,body:form}),env);
}
