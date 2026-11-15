import { parseConfig, reviewReady } from "../groups/repository";
import type { GroupRow } from "../groups/types";
import { esc } from "../platform/security";
import { adminPage } from "./admin";
import { groupForm, groupStatus, sourceStatus, tabs } from "./groups";

export const GROUP_ADMIN_VIEWS = ["pending", "public", "permissions"] as const;
type View = (typeof GROUP_ADMIN_VIEWS)[number];
const LABELS: Record<View, string> = { pending: "待审核", public: "已公开", permissions: "创建权限" };
const FEEDBACK: Record<string, string> = {
  grant: "已授予创建权限。",
  revoke: "已收回创建权限。用户可继续管理已有组。",
  approve: "审核已通过，通知组已公开。",
  reject: "申请已退回，组主可查看原因。",
  unlist: "通知组已下架，公开订阅和待发通知已清理。",
};

export function groupAdminPage(
  view: View,
  query: string,
  current: number,
  groups: GroupRow[],
  creators: Array<{ email: string }>,
  runnerReady: boolean,
  done: string,
): Response {
  const more = groups.length > 25 || creators.length > 25;
  const link = (tab: View, page = 1) => {
    const params = new URLSearchParams({ view: tab });
    if (query && tab === view) params.set("q", query);
    if (page > 1) params.set("page", String(page));
    return `/admin/groups?${params}`;
  };
  const form = (action: string, id: string, label: string, fields = "") =>
    groupForm(action, id, label, fields, "/admin/groups");
  const rows = groups.slice(0, 25).map(row => {
    const config = parseConfig(view === "public" ? row.published! : row.draft);
    const ready = view === "pending" && reviewReady(config, Date.now());
    const failed = config.sources.some(source => source.status === "blocked" || source.status === "error");
    const version = `<input type="hidden" name="revision" value="${row.revision}">`;
    return `<section class="work-panel">
      <div class="work-heading"><div><h3>${esc(config.name)}</h3><p>${esc(row.owner)} · ${config.sources.length} 个网址</p></div>
        <span class="work-status">${esc(groupStatus(row))}</span></div>
      ${view === "pending" ? `<p>${ready ? "网址复检通过，请核对提示词后决定是否公开。"
        : failed ? "网址复检未通过。请核对下方原因，必要时退回申请。"
        : "等待所有网址完成复检。可查看来源状态。"}</p>` : ""}
      <details${view === "pending" ? " open" : ""}><summary>查看网址与提示词</summary><ul class="work-review-sources">
      ${config.sources.map(source => `<li><div class="work-heading"><strong>${esc(source.url)}</strong>${sourceStatus(source)}</div>
        <p>${esc(source.detail || "等待试抓。")}</p><p class="work-prompt">${esc(source.prompt || "尚无提示词")}</p></li>`).join("")}</ul></details>
      ${view === "pending" ? `<div class="work-actions">${ready ? form("approve", row.id, "通过并公开", version) : ""}
        <details><summary>退回申请</summary>${form("reject", row.id, "确认退回", version + '<label>退回原因<input class="field" name="reason" maxlength="240" required></label>')}</details></div>`
        : `<details class="work-section"><summary>下架通知组</summary><p>下架会取消公开订阅并清理待发通知。</p>
          ${form("unlist", row.id, "确认下架", version + '<label class="work-check"><input type="checkbox" name="confirm" value="yes" required> 确认下架</label>')}</details>`}
    </section>`;
  }).join("");
  const permissions = `<section class="work-panel"><h3>授予创建权限</h3>
    ${form("grant", "", "授权", '<label>已注册邮箱<input class="field" type="email" name="email" maxlength="254" required></label>')}</section>
    <div class="work-list">${creators.slice(0, 25).map(creator => `<div class="work-row"><strong>${esc(creator.email)}</strong>
      <details><summary>收回权限</summary>${form("revoke", "", "确认收回", `<input type="hidden" name="email" value="${esc(creator.email)}"><label class="work-check"><input type="checkbox" name="confirm" value="yes" required> 确认收回</label>`)}</details></div>`).join("") || "<p>暂无符合条件的授权记录。</p>"}</div>`;
  const message = Object.hasOwn(FEEDBACK, done) ? FEEDBACK[done] : "";
  return adminPage("groups", `
    ${tabs(GROUP_ADMIN_VIEWS.map(tab => ({ href: link(tab), text: LABELS[tab], active: view === tab })), "通知组管理")}
    ${message ? `<p class="admin-feedback" role="status">${esc(message)}</p>` : ""}
    ${runnerReady ? "" : '<p class="admin-feedback">试抓任务尚未启用。请为 Worker 和 GitHub Actions 设置相同的 GROUP_RUNNER_TOKEN。</p>'}
    <form class="admin-search" method="get" action="/admin/groups">
      <input type="hidden" name="view" value="${view}"><label for="group-search">${view === "permissions" ? "搜索邮箱" : "搜索组名或公开者邮箱"}</label>
      <div><input class="field" id="group-search" name="q" type="search" maxlength="100" value="${esc(query)}"><button class="btn-mini" type="submit">搜索</button></div>
      ${query ? `<a href="/admin/groups?view=${view}">清除搜索</a>` : ""}
    </form>
    ${view === "permissions" ? permissions : `<div class="work-list">${rows || `<p>暂无符合条件的${LABELS[view]}通知组。</p>`}</div>`}
    ${current > 1 || more ? `<nav class="admin-pagination" aria-label="分页">
      ${current > 1 ? `<a href="${esc(link(view, current - 1))}">上一页</a>` : ""}<span>第 ${current} 页</span>
      ${more ? `<a href="${esc(link(view, current + 1))}">下一页</a>` : ""}</nav>` : ""}`);
}
