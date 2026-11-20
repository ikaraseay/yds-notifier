import YDS_SKILL from "../../../skills/yds/skill.json";
import { parseConfig } from "../groups/repository";
import type { GroupRow, Skill, Source } from "../groups/types";
import { esc } from "../platform/security";
import WEB_MONITOR from "../../../skills/web-monitor/defaults.json";
import { skillSettingsHeader } from "./skill-settings";
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
  return `<form method="post" action="${esc(endpoint)}" aria-label="${esc(label)}">
    <input type="hidden" name="action" value="${esc(action)}">
    <input type="hidden" name="id" value="${esc(group)}">
    ${fields}<button type="submit" class="btn-mini">${esc(label)}</button>
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
  const ready = draft.sources.filter(source => source.status === "ready");
  const canReview = ready.length > 0 && ready.length === draft.sources.length && ready.every(source => source.prompt);
  const failedReview = row.visibility === "pending" && draft.sources.some(source => source.status === "blocked" || source.status === "error");
  return `${skillSettingsHeader(draft.name, "一个 Skill 管理一个网站组。先试抓确认内容，再启用监控。", groupStatus(row))}<div class="work-heading">
    <div><h2>${esc(draft.name)}</h2><p>${groupStatus(row)} · ${draft.enabled ? "监控已启用" : "监控已暂停"}</p></div>
    ${draft.enabled || ready.length ? form(draft.enabled ? "pause" : "enable", draft.enabled ? "暂停监控" : "启用监控") : ""}
  </div>
  ${row.review_note ? `<p class="admin-feedback" role="status">${esc(row.review_note)}</p>` : ""}
  ${failedReview ? '<p class="admin-feedback" role="status">网址复检未通过。请查看失败的网址，修正或重试后重新提交审核。</p>' : ""}
  ${!runnerReady ? '<p class="admin-feedback">试抓服务尚未启用，请联系管理员。</p>' : !runnerLastSeen ? '<p class="admin-feedback" role="status">试抓已配置，等待后台任务首次连接。排队后长时间没有结果，请联系管理员检查任务。</p>' : Date.now() - runnerLastSeen > 45 * 60 * 1000 ? '<p class="admin-feedback" role="status">后台任务超过 45 分钟未连接，试抓可能延迟，请联系管理员检查任务。</p>' : '<p class="sub">后台任务已连接，试抓会在后续调度中处理。</p>'}
  <section class="work-section" id="skill-sources">
    <div class="work-heading"><h3>监控网址</h3><p>${ready.length} / ${draft.sources.length} 已通过</p></div>
    ${runnerReady && draft.sources.length ? form("probe", "全部重新试抓") : ""}
    <p class="sub">待试抓的网址在下一轮任务中检查。任务每 15 分钟调度，可能延迟；启用后每 6 小时检查更新。首次试抓建立基线，不发送历史通知。</p>
    ${draft.sources.length < 10 ? form("add", runnerReady ? "添加并试抓" : "保存网址", `<label>网址，每行一个
      <textarea class="field" inputmode="url" autocorrect="off" autocapitalize="none" spellcheck="false" name="urls" rows="3" maxlength="10000" placeholder="https://example.org/notices" required></textarea></label>`) : "<p>已添加 10 个网址。移除一个网址后可继续添加。</p>"}
    <div class="work-list">${draft.sources.map((source, index) => {
      const sourceIndex = `<input type="hidden" name="index" value="${index}">`;
      return `<details class="work-source"><summary><span>${esc(source.url)}</span>${sourceStatus(source)}</summary>
        <div class="work-source-body">
          <p>${esc(source.detail || "等待后台试抓。")}</p>${source.checked ? `<p>最近检查：${esc(new Date(source.checked).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }))}（北京时间）</p>` : ""}
          ${source.sample ? `<details class="work-sample"><summary>查看试抓样本</summary><p>${esc(source.sample)}</p></details>` : ""}
          ${form("prompt", "保存提示词", `${sourceIndex}<label>监控提示词
            <textarea class="field" name="prompt" maxlength="600" rows="3" required>${esc(source.prompt)}</textarea></label>`)}
          <div class="work-actions">
            ${runnerReady ? form("probe", "重新试抓", sourceIndex) : ""}
            ${form("remove-source", "移除网址", sourceIndex)}
          </div>
        </div></details>`;
    }).join("")}</div>
  </section>
  <section class="work-section" id="skill-rules"><h3>通知规则</h3><p>每个网址的监控提示词决定哪些变化值得通知。摘要规则决定如何概括，所有通知都附来源链接。</p></section>
  <section class="work-section" id="skill-delivery"><h3>通知设置</h3>
    <p>通知发送到 ${esc(email)}。日报在北京时间 10:00 后汇总，周报在周一 10:00 后汇总，实际投递随任务调度。</p>
    ${form("settings", "保存通知设置", `<label for="delivery-${esc(row.id)}">推送频率</label><select id="delivery-${esc(row.id)}" class="field" name="frequency">${[["instant", "有更新就通知"], ["daily", "每天汇总"], ["weekly", "每周汇总"]].map(([value, label]) => `<option value="${value}"${(draft.frequency || "instant") === value ? " selected" : ""}>${label}</option>`).join("")}</select>
      <label for="guidance-${esc(row.id)}">摘要规则（最多 600 字）</label><textarea id="guidance-${esc(row.id)}" class="field" name="guidance" rows="3" maxlength="600">${esc(draft.guidance ?? WEB_MONITOR.summaryGuidance)}</textarea>`)}
  </section>
  <section class="work-section" id="skill-history"><h3>运行记录</h3><ul class="work-urls">${draft.sources.map(source => `<li>${esc(source.url)}：${sourceStatus(source)}${source.detail ? `，${esc(source.detail)}` : ""}</li>`).join("") || "<li>添加网址后显示最近运行结果。</li>"}</ul></section>
  <details class="work-section"><summary>公开设置</summary>
    ${row.visibility === "pending" ? "<p>已提交审核。修改网址、组名或提示词后需要重新提交。</p>"
      : !runnerReady ? "<p>试抓服务恢复后可提交公开审核。</p>" : canReview
      ? form("request-public", row.published ? "提交更新审核" : "申请公开", `<label class="work-check">
        <input type="checkbox" name="confirm" value="yes" required> 同意在公开目录显示我的已验证邮箱 ${esc(email)}</label>`)
      : "<p>所有网址试抓通过并填写提示词后，可以申请公开。</p>"}
    ${row.published || row.visibility === "pending" ? form("withdraw", "撤回公开") : ""}
  </details>
  ${skill ? `<details class="work-section"><summary>Skill v${skill.version} · 已评估 ${skill.evaluated || 0} 批</summary>
    <p>${esc(skill.guidance)}</p>
    ${skill.candidate ? `<p><b>候选规则</b>　${esc(skill.candidate)}</p><p><b>评估依据</b>　${esc(skill.evidence)}</p>${form("apply-skill", "采用候选版本")}` : "<p>暂无候选版本。</p>"}
    ${skill.version > 1 ? form("rollback-skill", "恢复上一版本") : ""}
  </details>` : ""}
  <details class="work-section"><summary>更多操作</summary>
    ${form("rename", "保存组名", `<label>组名<input class="field" name="name" maxlength="80" value="${esc(draft.name)}" required></label>`)}
    ${form("delete", "删除通知组", '<label class="work-check"><input type="checkbox" name="confirm" value="yes" required> 确认删除此组、订阅和待发通知</label>')}
  </details>`;
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
    content = `<p><a href="${viewUrl("mine")}">返回我的通知组</a></p>${editGroup(email, selected, runnerReady, runnerLastSeen)}`;
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
    title: "通知组 · MeoNotifier", heading: "通知组", wide: true,
    body: `<main class="work-area"><p><a href="/skills">通知智能体与 Skill</a> · <a href="/dashboard">订阅控制台</a></p>
      ${navigation}${feedback ? `<p class="admin-feedback" role="status">${esc(feedback)}</p>` : ""}${content}</main>`,
  });
}
