import YDS_SKILL from "../../../skills/yds/skill.json";
import { parseConfig } from "../groups/repository";
import type { GroupRow, Skill, Source } from "../groups/types";
import { esc } from "../platform/security";
import WEB_MONITOR from "../../../skills/web-monitor/defaults.json";
import { monitorState, skillSettingsHeader } from "./skill-settings";
import { page } from "./layout";

export const GROUP_VIEWS = ["mine", "subscribed", "directory"] as const;
export type GroupView = (typeof GROUP_VIEWS)[number];

const LABELS: Record<GroupView, string> = { mine: "我的通知组", subscribed: "已订阅", directory: "公开目录" };
const SOURCE_STATUS = { ready: "试抓通过", blocked: "访问受限", error: "试抓失败" };
const FEEDBACK: Record<string, string> = {
  create: "通知组已创建。添加网址后，后台会自动试抓。",
  probe: "试抓已排队。请稍后刷新查看结果；调度每 15 分钟运行，可能有延迟。",
  settings: "通知设置已保存。",
  add: "网址已保存。待检查的网址会在下一轮试抓。",
  rename: "组名已保存。",
  prompt: "提示词已保存。",
  "remove-source": "网址已移除。",
  enable: "监控已启用。",
  pause: "监控已暂停。",
  "request-public": "已提交公开审核。后台会复检所有网址。",
  withdraw: "已撤回公开，其他用户的订阅已取消。",
  "apply-skill": "已采用候选 Skill。",
  "rollback-skill": "已恢复上一版 Skill 规则。",
  delete: "通知组已删除。",
  subscribe: "订阅频率已保存。",
  unsubscribe: "已退出订阅。",
};

export function groupErrorPage(message: string, status = 400, back = "/groups") {
  return page({ title: "通知组", heading: "通知组", body: `<p class="admin-feedback" role="alert">${esc(message)}</p><a href="${esc(back)}">返回${back.startsWith("/admin") ? "管理后台" : "通知组"}</a>` }, status);
}

export function groupForm(action: string, group: string, label: string, fields = "", endpoint = "/groups"): string {
  const guard = ["settings", "prompt", "rename", "add", "create"].includes(action) ? " data-guard" : "";
  const tone = ["delete", "remove-source"].includes(action) ? " button-danger" : ["enable", "settings", "create"].includes(action) ? " button-primary" : "";
  return `<form method="post" action="${esc(endpoint)}" aria-label="${esc(label)}"${guard}>
    <input type="hidden" name="action" value="${esc(action)}">
    <input type="hidden" name="id" value="${esc(group)}">
    ${fields}<button type="submit" class="btn-mini${tone}">${esc(label)}</button>
  </form>`;
}

export function tabs(items: Array<{ href: string; text: string; active: boolean }>, label: string): string {
  return `<nav class="work-tabs" aria-label="${esc(label)}">${items.map(item =>
    `<a href="${esc(item.href)}"${item.active ? ' aria-current="page"' : ""}>${esc(item.text)}</a>`,
  ).join("")}</nav>`;
}

export function groupStatus(row: GroupRow): string {
  if (row.visibility === "pending") return row.published ? "更新待审核" : "待审核";
  return row.published ? "已公开" : "私有";
}

export function sourceStatus(source: Source): string {
  const status = source.status;
  return `<span class="work-status work-status--${status || "waiting"}">${status ? SOURCE_STATUS[status] : "待试抓"}</span>`;
}

function viewUrl(view: GroupView, id?: string): string {
  return `/groups?view=${view}${id ? `&id=${encodeURIComponent(id)}` : ""}`;
}

function editGroup(email: string, row: GroupRow, runnerReady: boolean, runnerLastSeen: number): string {
  const draft = parseConfig(row.draft);
  const skill = row.skill ? JSON.parse(row.skill) as Skill : null;
  const revision = `<input type="hidden" name="revision" value="${row.revision}">`;
  const form = (action: string, label: string, fields = "") => groupForm(action, row.id, label, revision + fields);
  const state = monitorState(draft);
  const canReview = state.ready > 0 && state.ready === draft.sources.length && draft.sources.every(source => source.prompt);
  const failedReview = row.visibility === "pending" && state.failed > 0;
  const nextAction = !draft.sources.length ? "添加要监控的网址" : state.failed ? "检查失败原因，修正网址或重新试抓" : state.waiting ? "等待后台试抓，稍后刷新查看结果" : !draft.enabled ? "试抓已通过，可以启用监控" : "监控已开启，有相关更新时会按设定频率通知你";
  return `${skillSettingsHeader(draft.name, "集中管理这组网站的来源、监控规则和通知。", groupStatus(row))}
    <section class="group-summary"><div><span class="work-status work-status--${state.tone}">${state.label}</span><p>${nextAction}。</p><small>${state.ready} / ${draft.sources.length} 个网址已通过 · ${draft.enabled ? "监控已启用" : "监控已暂停"}${state.ready > 0 && state.ready < draft.sources.length ? " · 仅监控试抓通过的网址" : ""}</small></div><div class="work-actions">${draft.enabled || state.ready ? form(draft.enabled ? "pause" : "enable", draft.enabled ? "暂停监控" : "启用监控") : ""}<a class="button" href="${esc(viewUrl("mine", row.id))}">刷新状态</a></div></section>
    ${row.review_note ? `<p class="admin-feedback" role="status">${esc(row.review_note)}</p>` : ""}
    ${failedReview ? '<p class="admin-feedback" role="status">网址复检未通过。请查看失败的网址，修正或重试后重新提交审核。</p>' : ""}
    ${!runnerReady ? '<p class="admin-feedback notice-warning" role="status">试抓服务尚未启用，请联系管理员。你仍可保存网址和通知规则。</p>' : !runnerLastSeen ? '<p class="admin-feedback" role="status">试抓已配置，等待后台任务首次连接。排队后长时间没有结果，请联系管理员检查任务。</p>' : Date.now() - runnerLastSeen > 45 * 60 * 1000 ? '<p class="admin-feedback notice-warning" role="status">后台任务超过 45 分钟未连接，试抓可能延迟，请联系管理员检查任务。</p>' : ""}
    <div class="settings-grid"><div class="settings-primary">
      <section class="settings-panel" id="skill-sources"><div class="work-heading"><div><h2>监控来源</h2><p>${draft.sources.length} / 10 个网址</p></div>${runnerReady && draft.sources.length ? form("probe", "全部重新试抓") : ""}</div>
        <p class="sub">首次试抓建立基线，不发送历史通知。后台每 15 分钟调度，启用后每 6 小时检查更新，实际执行可能延迟。</p>
        <div class="source-list">${draft.sources.map((source, index) => {
          const sourceIndex = `<input type="hidden" name="index" value="${index}">`;
          const failed = source.status === "blocked" || source.status === "error";
          return `<article class="source-item" id="source-${index}"><div class="source-top"><a class="source-url" href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.url)}<span class="sr-only">（新窗口打开）</span></a>${sourceStatus(source)}</div>
            <p class="${failed ? "source-error" : "sub"}">${esc(source.detail || "等待后台试抓。")}</p>
            ${source.checked ? `<small>最近检查：${esc(new Date(source.checked).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }))}（北京时间）</small>` : ""}
            <div class="source-tools">${runnerReady ? form("probe", "重新试抓", sourceIndex) : ""}<details class="source-editor"${!source.prompt ? " open" : ""}><summary>编辑监控规则${source.sample ? "与查看样本" : ""}</summary><div class="source-editor-body">
              ${form("prompt", "保存提示词", `${sourceIndex}<label for="prompt-${index}">监控提示词（必填，最多 600 字）</label><textarea id="prompt-${index}" class="field" name="prompt" maxlength="600" rows="3" required>${esc(source.prompt)}</textarea><span class="form-state" data-form-state role="status"></span>`)}
              ${source.sample ? `<details class="work-sample"><summary>查看试抓样本</summary><p>${esc(source.sample)}</p></details>` : '<p class="sub">试抓完成后会显示样本，方便确认抓取内容。</p>'}
              <details class="source-remove"><summary>移除此网址</summary><p>移除后不再监控这个来源，其他网址不受影响。</p>${form("remove-source", "确认移除网址", sourceIndex)}</details>
            </div></details></div></article>`;
        }).join("") || '<div class="empty-state"><h3>还没有监控来源</h3><p>在下方粘贴网址，可一次添加多个。</p></div>'}</div>
        ${draft.sources.length < 10 ? `<details class="source-add"${draft.sources.length ? "" : " open"}><summary>添加网址</summary>${form("add", runnerReady ? "添加并试抓" : "保存网址", `<label for="source-urls">网址（必填，每行一个）</label><textarea id="source-urls" class="field" inputmode="url" autocorrect="off" autocapitalize="none" spellcheck="false" name="urls" rows="3" maxlength="10000" placeholder="https://example.org/notices" required></textarea><span class="form-state" data-form-state role="status"></span>`)}</details>` : '<p class="sub">已添加 10 个网址。移除一个网址后可继续添加。</p>'}
      </section>
      <section class="settings-panel" id="skill-rules"><h2>通知规则</h2><p>每个网址的“监控提示词”决定哪些变化值得通知；通知设置中的摘要规则决定如何概括。所有通知都附来源链接。</p><p class="sub">例如：只关注项目申报和截止日期变化，忽略新闻、导航和排版变化。</p></section>
      <details class="settings-panel" id="skill-history"><summary>最近检查记录</summary><ul class="work-review-sources">${draft.sources.map(source => `<li><span class="source-url">${esc(source.url)}</span><p>${sourceStatus(source)} ${esc(source.detail || "等待后台试抓。")}</p></li>`).join("") || "<li>添加网址后显示最近一次运行结果。</li>"}</ul></details>
    </div><aside class="settings-secondary" aria-label="此网站组的通知设置">
      <section class="settings-panel" id="skill-delivery"><h2>通知设置</h2><p>接收邮箱</p><p class="delivery-email">${esc(email)}</p>
        ${form("settings", "保存通知设置", `<label for="group-frequency">推送频率</label><select id="group-frequency" class="field" name="frequency" aria-describedby="frequency-help">${[["instant", "有更新就通知"], ["daily", "每天汇总"], ["weekly", "每周汇总"]].map(([value, label]) => `<option value="${value}"${(draft.frequency || "instant") === value ? " selected" : ""}>${label}</option>`).join("")}</select><p id="frequency-help" class="sub">日报在北京时间 10:00 后、周报在周一 10:00 后随任务发送。</p><label for="group-guidance">摘要规则（最多 600 字）</label><textarea id="group-guidance" class="field" name="guidance" rows="5" maxlength="600">${esc(draft.guidance ?? WEB_MONITOR.summaryGuidance)}</textarea><span class="form-state" data-form-state role="status"></span>`)}
      </section>
      <details class="settings-panel"><summary>公开设置</summary>
        ${row.visibility === "pending" ? "<p>已提交审核。修改网址、组名或提示词后需要重新提交。</p>" : !runnerReady ? "<p>试抓服务恢复后可提交公开审核。</p>" : canReview ? form("request-public", row.published ? "提交更新审核" : "申请公开", `<label class="work-check"><input type="checkbox" name="confirm" value="yes" required> 同意在公开目录显示我的已验证邮箱 ${esc(email)}</label>`) : "<p>所有网址试抓通过并填写提示词后，可以申请公开。</p>"}
        ${row.published || row.visibility === "pending" ? form("withdraw", "撤回公开") : ""}
      </details>
      ${skill ? `<details class="settings-panel"><summary>摘要优化 · v${skill.version}</summary><p>已评估 ${skill.evaluated || 0} 批</p><p>${esc(skill.guidance)}</p>${skill.candidate ? `<p><b>候选规则</b> ${esc(skill.candidate)}</p><p><b>评估依据</b> ${esc(skill.evidence)}</p>${form("apply-skill", "采用候选版本")}` : "<p>暂无候选版本。</p>"}${skill.version > 1 ? form("rollback-skill", "恢复上一版本") : ""}</details>` : ""}
      <details class="settings-panel"><summary>更多操作</summary>${form("rename", "保存组名", `<label for="group-name">组名（必填）</label><input id="group-name" class="field" name="name" maxlength="80" value="${esc(draft.name)}" required><span class="form-state" data-form-state role="status"></span>`)}<details class="danger"><summary>删除通知组</summary><p>删除此组、订阅和待发通知，操作无法恢复。</p>${form("delete", "删除通知组", '<label class="work-check"><input type="checkbox" name="confirm" value="yes" required> 确认删除此组、订阅和待发通知</label>')}</details></details>
    </aside></div>`;
}

export function groupsPage(email: string, groups: GroupRow[], subscriptions: Map<string, string>, canCreate: boolean, url: URL, runnerReady: boolean, runnerLastSeen = 0): Response {
  const own = groups.filter(row => row.owner === email);
  const published = groups.filter(row => row.published && row.owner !== email);
  const subscribed = published.filter(row => subscriptions.has(row.id));
  const requested = url.searchParams.get("view") as GroupView;
  const view = GROUP_VIEWS.includes(requested) ? requested : own.length || canCreate ? "mine" : "directory";
  const selectedId = url.searchParams.get("id");
  const selected = own.find(row => row.id === selectedId);
  const done = url.searchParams.get("done") || "";
  const feedback = !runnerReady && done === "create" ? "通知组已创建。"
    : !runnerReady && done === "add" ? "网址已保存，将在试抓服务恢复后检查。"
    : Object.hasOwn(FEEDBACK, done) ? FEEDBACK[done] : "";
  const counts = { mine: own.length, subscribed: subscribed.length, directory: published.length + 1 };
  const navigation = tabs(GROUP_VIEWS.map(key => ({ href: viewUrl(key), text: `${LABELS[key]} ${counts[key]}`, active: key === view })), "通知组");
  let content: string;
  if (view === "mine" && selected) {
    content = `${editGroup(email, selected, runnerReady, runnerLastSeen)}`;
  } else if (view === "mine") {
    content = `<div class="work-heading"><h2>我的通知组</h2></div>
      ${canCreate && own.length < 10
        ? `<details class="work-create"${own.length ? "" : " open"}><summary>新建私有通知组</summary>
          ${groupForm("create", "", "创建通知组", '<label>组名<input class="field" name="name" maxlength="80" required></label>')}</details>`
        : `<p>${canCreate ? "已达到 10 个通知组上限。" : "创建权限由管理员授予。"}</p>`}
      <div class="work-list">${own.map(row => {
        const draft = parseConfig(row.draft);
        return `<a class="work-row" href="${esc(viewUrl("mine", row.id))}"><span><strong>${esc(draft.name)}</strong>
          <small>${draft.sources.length} 个网址 · ${draft.enabled ? "监控中" : "已暂停"}</small></span>
          <span class="work-status">${groupStatus(row)}</span></a>`;
      }).join("") || "<p>暂无自建通知组。</p>"}</div>`;
  } else {
    const directory = view === "directory";
    const cards = (directory ? published : subscribed).map(row => {
      const config = parseConfig(row.published!);
      const frequency = subscriptions.get(row.id);
      return `<section class="work-panel"><div class="work-heading"><div><h3>${esc(config.name)}</h3><p>公开者 ${esc(row.owner)}</p></div>
        <span class="work-status${frequency ? " work-status--ready" : ""}">${frequency ? "已订阅" : config.enabled ? "监控中" : "已暂停"}</span></div>
        <details><summary>${config.sources.length} 个监控网址</summary><ul class="work-urls">${config.sources.map(source => `<li>${esc(source.url)}</li>`).join("")}</ul></details>
        <div class="work-actions">${groupForm("subscribe", row.id, frequency ? "保存频率" : "订阅", `<input type="hidden" name="view" value="${view}"><label>推送频率
          <select class="field" name="frequency">${[["instant","即时"],["daily","日报"],["weekly","周报"]].map(([key,label]) => `<option value="${key}"${frequency === key ? " selected" : ""}>${label}</option>`).join("")}</select></label>`)}
        ${frequency ? groupForm("unsubscribe", row.id, "退出订阅", `<input type="hidden" name="view" value="${view}">`) : ""}</div></section>`;
    }).join("");
    content = `<h2>${LABELS[view]}</h2><div class="work-list">
      ${directory ? `<a class="work-row" href="/skills/yds"><span><strong>${esc(YDS_SKILL.name)}</strong><small>赛事通知、赛程及个人日历</small></span><span class="work-status">内置 Skill</span></a>` : ""}
      ${cards || (directory ? "<p>暂无其他公开通知组。</p>" : `<p>暂无订阅。<a href="${viewUrl("directory")}">浏览公开目录</a></p>`)}</div>`;
  }
  return page({
    title: selected ? `${parseConfig(selected.draft).name} · 通知设置` : "通知组 · MeoNotifier",
    heading: selected ? parseConfig(selected.draft).name : LABELS[view],
    workspace: { active: view === "mine" ? "groups" : view, email },
    body: `<div class="work-area">${selected ? "" : navigation}${feedback ? `<p class="admin-feedback" role="status">${esc(feedback)}</p>` : ""}${content}</div>`,
  });
}
