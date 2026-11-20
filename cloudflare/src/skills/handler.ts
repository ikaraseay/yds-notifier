import { getSession, getUser, readSessionToken } from "../accounts/auth";
import { parseConfig } from "../groups/repository";
import type { GroupRow } from "../groups/types";
import type { Env } from "../platform/env";
import { redirect } from "../platform/http";
import { esc } from "../platform/security";
import { groupForm } from "../ui/groups";
import { page } from "../ui/layout";
import { NOTIFICATION_SKILLS } from "./catalog";

export async function handleSkills(req: Request, env: Env): Promise<Response> {
  const email = await getSession(env.SUBS, readSessionToken(req));
  const user = email ? await getUser(env.SUBS, email) : null;
  if (!user) return redirect("/");
  const canCreate = env.GROUPS && user.status !== "pending" && !!await env.GROUPS.prepare("SELECT 1 FROM group_creators WHERE email=?").bind(email).first();
  const groups = env.GROUPS ? (await env.GROUPS.prepare("SELECT * FROM notification_groups WHERE owner=? ORDER BY id").bind(email).all<GroupRow>()).results : [];
  const card = (name: string, description: string, content: string) => `<section class="work-panel"><h3>${esc(name)}</h3><p>${esc(description)}</p>${content}</section>`;
  return page({ title: "通知智能体", heading: "通知智能体", wide: true, body: `<main class="work-area">
    <p class="sub">选择一个 Skill，管理它负责的网站组、监控意图和通知方式。</p>
    <nav class="work-tabs" aria-label="通知导航"><a href="/skills" aria-current="page">我的 Skill</a><a href="/groups?view=subscribed">已订阅</a><a href="/groups?view=directory">公开目录</a><a href="/dashboard">账号与订阅</a></nav>
    <h2>我的 Skill</h2><div class="work-list">${NOTIFICATION_SKILLS.filter(skill => skill.kind === "builtin").map(skill => card(skill.name, skill.description, `<a class="btn-mini" href="${esc(skill.settingsUrl)}" aria-label="打开设置：${esc(skill.name)}">打开设置</a>`)).join("")}
    ${groups.map(row => { const config = parseConfig(row.draft); return card(config.name, `${config.sources.length} 个网址 · ${config.enabled ? "监控中" : "已暂停"}`, `<a class="btn-mini" href="/groups?view=mine&amp;id=${encodeURIComponent(row.id)}" aria-label="打开设置：${esc(config.name)}">打开设置</a>`); }).join("")}</div>
    <section class="work-section"><h2>添加通知 Skill</h2><p>每次添加都会创建独立的私有网站组，使用相同的设置模板。</p>
    ${!env.GROUPS ? '<p role="status">网站组存储尚未配置，请联系管理员。</p>' : !canCreate ? '<p>创建权限由管理员授予。</p>' : ""}
    <div class="work-list">${NOTIFICATION_SKILLS.filter(skill => skill.kind === "template").map(skill => card(skill.name, skill.description,
      canCreate && groups.length < 10 ? groupForm("create", "", "添加 Skill", `<input type="hidden" name="template" value="${esc(skill.id)}"><label for="name-${esc(skill.id)}">网站组名称（必填）</label><input id="name-${esc(skill.id)}" class="field" name="name" value="${esc(skill.name)}" maxlength="80" required>`) : "")).join("")}</div></section></main>` });
}
