import { getSession, getUser, readSessionToken } from "../accounts/auth";
import { adminAuthenticated } from "../admin/handler";
import { inputUrl } from "../groups/handler";
import { loadGroup, parseConfig } from "../groups/repository";
import type { Env } from "../platform/env";
import { readForm, redirect, sameOrigin } from "../platform/http";
import { esc } from "../platform/security";
import { groupErrorPage } from "../ui/groups";
import { page } from "../ui/layout";
import { parseLabels } from "./classification";

export async function skillSources(req: Request, env: Env, id: string): Promise<Response> {
  const admin = await adminAuthenticated(req, env);
  const email = await getSession(env.SUBS, readSessionToken(req));
  if (!admin && (!email || !(await getUser(env.SUBS, email)))) return redirect("/");
  if (!env.GROUPS) return groupErrorPage("尚未配置网站组存储。", 503);
  const row = await loadGroup(env.GROUPS, id);
  const manage = admin || (!!email && email === row?.owner);
  if (!row || (!manage && !row.published && id !== "yds")) return groupErrorPage("未找到通知组。", 404);
  const config = parseConfig(manage || id === "yds" ? row.draft : row.published!);
  if (req.method === "GET") {
    return page({ title: config.name, heading: `${config.name} · 共享来源`, body: `
      <p>这些网址的更新会按此 Skill 的人员和通知类型推送。</p>
      <ul>${config.sources.map(source => `<li>${esc(source.url)} · ${esc(source.detail || "等待试抓")}</li>`).join("") || "<li>暂无自定义网址</li>"}</ul>
      ${manage ? `<form method="post"><input type="hidden" name="revision" value="${row.revision}"><label>监控网址，每行一个<textarea class="field" name="urls" rows="6" maxlength="10000">${esc(config.sources.map(source => source.url).join("\n"))}</textarea></label>${id !== "yds" ? `<label>适用人员，每行一项<textarea class="field" name="roles">${esc((config.taxonomy?.roles || []).join("\n"))}</textarea></label><label>通知类型，每行一项<textarea class="field" name="types">${esc((config.taxonomy?.types || []).join("\n"))}</textarea></label>` : ""}<button type="submit">保存设置</button></form><a href="/api/skills/${encodeURIComponent(id)}/suggestions">规则和改进建议</a>` : ""}
      <a href="${id === "yds" ? "/skills/yds" : "/groups"}">返回通知设置</a>` });
  }
  if (!manage || !sameOrigin(req)) return groupErrorPage("没有修改权限。", 403);
  const form = await readForm(req, 16000);
  if (!form?.has("urls") || form.get("revision") !== String(row.revision)) return groupErrorPage("配置已有更新，请刷新。", 409);
  try {
    const urls = [...new Set(form.get("urls")!.trim().split(/\s+/).filter(Boolean).map(inputUrl))];
    if (urls.length > 10) throw new Error();
    config.sources = urls.map(url => config.sources.find(source => source.url === url) || { url, prompt: "" });
    if (id !== "yds" && form.has("roles") && form.has("types")) {
      config.taxonomy = { roles:parseLabels(form.get("roles")!), types:parseLabels(form.get("types")!) };
    }
  } catch {
    return groupErrorPage("请填写最多 10 个有效的 HTTP 或 HTTPS 网址。");
  }
  const result = await env.GROUPS.prepare(`UPDATE notification_groups SET draft=?,next_check=0,revision=revision+1,
    visibility=CASE WHEN visibility='pending' THEN CASE WHEN published IS NULL THEN 'private' ELSE 'public' END ELSE visibility END
    WHERE id=? AND revision=?`).bind(JSON.stringify(config), id, row.revision).run();
  return result.meta.changes ? redirect(new URL(req.url).pathname, undefined, 303) : groupErrorPage("配置已有更新，请刷新。", 409);
}
