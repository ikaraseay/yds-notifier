import { getSession, getSub, getUser, isConfirmed, readSessionToken } from "../accounts/auth";
import { parseConfig } from "../groups/repository";
import type { GroupRow } from "../groups/types";
import { groupRunnerToken, type Env } from "../platform/env";
import { redirect } from "../platform/http";
import { esc } from "../platform/security";
import { groupForm } from "../ui/groups";
import { page } from "../ui/layout";
import { monitorState } from "../ui/skill-settings";
import { NOTIFICATION_SKILLS } from "./catalog";

export async function handleSkills(req: Request, env: Env): Promise<Response> {
  const email = await getSession(env.SUBS, readSessionToken(req));
  const user = email ? await getUser(env.SUBS, email) : null;
  if (!user) return redirect("/");
  const db = env.GROUPS;
  const [permission, result, subscription] = await Promise.all([
    db ? db.prepare("SELECT 1 FROM group_creators WHERE email=?").bind(email).first() : null,
    db ? db.prepare("SELECT * FROM notification_groups WHERE owner=? ORDER BY id").bind(email).all<GroupRow>() : null,
    getSub(env.SUBS, user.email),
  ]);
  const canCreate = !!permission && user.status !== "pending";
  const groups = (result?.results || []).map(row => ({ row, config: parseConfig(row.draft) }));
  const url = new URL(req.url);
  const query = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const filter = ["enabled", "attention", "paused"].includes(url.searchParams.get("status") || "") ? url.searchParams.get("status")! : "all";
  const attention = groups.filter(({ config }) => monitorState(config).attention);
  const filtered = groups.filter(({ config }) => {
    const matches = (config.name + " " + config.sources.map(source => source.url).join(" ")).toLowerCase().includes(query.toLowerCase());
    return matches && (filter === "all" || filter === "enabled" && config.enabled || filter === "paused" && !config.enabled || filter === "attention" && monitorState(config).attention);
  }).sort((a, b) => Number(monitorState(b.config).attention) - Number(monitorState(a.config).attention));
  const feedback: Record<string, string> = { pause: "监控已暂停。", enable: "监控已启用。", probe: "试抓已排队，请稍后查看结果。" };
  const done = url.searchParams.get("done") || "";
  const builtin = NOTIFICATION_SKILLS.find(skill => skill.id === "yds")!;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const builtinStatus = !isConfirmed(subscription) ? "尚未订阅" : user.prefs.pausedUntil >= today ? "已暂停" : "已订阅";
  return page({ title: "工作台 · MeoNotifier", heading: "工作台", workspace: { active: "overview", email: user.email }, body: `
    <div class="page-intro"><p>查看网站更新状态，处理试抓问题，管理你的通知。</p><a class="button button-primary" href="#add-skill">添加通知组</a></div>
    ${feedback[done] ? `<p class="admin-feedback" role="status">${esc(feedback[done])}</p>` : ""}
    ${attention.length ? `<section class="attention-banner"><div><h2>${attention.length} 个网站组需要处理</h2><p>先检查未通过或还在等待试抓的网址，确认内容后再开启监控。</p></div><a href="/skills?status=attention#my-groups">查看待处理</a></section>` : ""}

    <section class="overview-section" id="my-groups"><div class="work-heading"><h2>我的网站组 <span class="count-inline">${groups.length}</span></h2><a href="/groups?view=subscribed">查看我的订阅</a></div>
      <search><form method="get" action="/skills" class="filter-form" aria-label="筛选网站组"><div><label for="group-query">搜索名称或网址</label><input class="field" type="search" id="group-query" name="q" value="${esc(query)}" placeholder="例如：科研、guet.edu.cn" maxlength="100"></div><div><label for="group-status">监控状态</label><select class="field" id="group-status" name="status">${[["all", "全部状态"], ["attention", "需要处理"], ["enabled", "监控已开启"], ["paused", "监控已暂停"]].map(([value, label]) => `<option value="${value}"${filter === value ? " selected" : ""}>${label}</option>`).join("")}</select></div><button class="btn-mini" type="submit">筛选</button>${query || filter !== "all" ? '<a href="/skills#my-groups">清除筛选</a>' : ""}</form></search>
      <div class="monitor-list">${filtered.map(({ row, config }) => {
        const state = monitorState(config);
        const href = `/groups?view=mine&id=${encodeURIComponent(row.id)}`;
        const fields = `<input type="hidden" name="revision" value="${row.revision}"><input type="hidden" name="return" value="overview">`;
        return `<article class="monitor-row"><div class="monitor-info"><h3><a href="${esc(href)}">${esc(config.name)}</a><span class="work-status work-status--${state.tone}">${state.label}</span></h3><p>${state.ready} / ${config.sources.length} 个网址试抓通过${state.failed ? `，${state.failed} 个需重试` : ""}</p><small>${config.enabled ? "每 6 小时检查更新" : "监控已暂停"} · ${config.frequency === "daily" ? "每天汇总" : config.frequency === "weekly" ? "每周汇总" : "有更新就通知"}</small></div><div class="work-actions"><a class="button" href="${esc(href)}" aria-label="打开设置：${esc(config.name)}">打开设置</a>${config.enabled || state.ready ? groupForm(config.enabled ? "pause" : "enable", row.id, config.enabled ? "暂停监控" : "启用监控", fields) : ""}${state.failed && groupRunnerToken(env) ? groupForm("probe", row.id, "重新试抓", fields) : ""}</div></article>`;
      }).join("") || `<div class="empty-state"><h3>${groups.length ? "没有符合条件的网站组" : "添加第一个网站组"}</h3><p>${groups.length ? "试试其他名称，或清除筛选。" : "选择下面的模板，添加网址后即可开始试抓。"}</p><a href="${groups.length ? "/skills#my-groups" : "#add-skill"}">${groups.length ? "清除筛选" : "选择通知模板"}</a></div>`}</div>
    </section>
    <section class="overview-section"><h2>内置通知</h2><article class="monitor-row"><div class="monitor-info"><h3>${esc(builtin.name)}<span class="work-status">${builtinStatus}</span></h3><p>${esc(builtin.description)}</p><small>推送到 ${esc(user.email)}</small></div><a class="button" href="/skills/yds" aria-label="打开设置：研电赛">打开设置</a></article></section>
    <section class="overview-section" id="add-skill"><h2>添加通知组</h2><p>每个通知 Skill 对应一个独立的网站组，可以分别设置规则和推送频率。</p>
      ${!db ? '<p class="admin-feedback" role="status">网站组存储尚未配置，请联系管理员。</p>' : !canCreate ? '<p class="admin-feedback">创建权限由管理员授予，已有网站组仍可继续管理。</p>' : groups.length >= 10 ? '<p class="admin-feedback">已达到 10 个网站组上限。</p>' : ""}
      <div class="template-grid">${NOTIFICATION_SKILLS.filter(skill => skill.kind === "template").map(skill => `<article class="template-item"><h3>${esc(skill.name)}</h3><p>${esc(skill.description)}</p><small>${skill.sources.length ? `已预置 ${skill.sources.length} 个网址` : "自行添加需要监控的网址"}</small>${canCreate && groups.length < 10 ? `<details class="template-create"><summary>使用此模板</summary>${groupForm("create", "", "创建并设置", `<input type="hidden" name="template" value="${esc(skill.id)}"><label for="name-${esc(skill.id)}">网站组名称（必填）</label><input id="name-${esc(skill.id)}" class="field" name="name" value="${esc(skill.name)}" maxlength="80" required>`)}</details>` : ""}</article>`).join("")}</div>
    </section>` });
}
