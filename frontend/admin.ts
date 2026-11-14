import { isConfirmed, normalizePrefs, type SubRecord } from "../cloudflare/src/auth";
import type { Notice } from "../cloudflare/src/feed/types";
import { esc } from "../cloudflare/src/security";
import { page } from "./layout";

const VIEWS = [
  { key: "overview", title: "运营概览", url: "/admin" },
  { key: "subscribers", title: "订阅管理", url: "/admin?view=subscribers" },
  { key: "archive", title: "通知归档", url: "/admin?view=archive" },
] as const;

const DATE = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short",
});
const FREQUENCY = { instant: "即时", daily: "日报", weekly: "周报" };

function displayDate(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? DATE.format(time) : "—";
}

export function adminLoginPage(message = "", status = 200): Response {
  return page({
    title: "管理员登录",
    heading: "管理员登录",
    body: `
      ${message ? `<p class="admin-feedback" role="alert">${esc(message)}</p>` : ""}
      ${status === 503 ? "" : `<form method="post" action="/api/admin/login">
        <label class="unsub-label" for="password">管理员口令</label>
        <input class="field" id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required>
        <button type="submit">登录</button>
      </form>`}
    `,
    extra: '<a class="btn-secondary" href="/">返回订阅首页</a>',
  }, status);
}

function adminPage(view: (typeof VIEWS)[number]["key"], content: string): Response {
  const title = VIEWS.find((item) => item.key === view)!.title;
  const nav = VIEWS.map(({ key, title, url }) =>
    `<a href="${url}"${key === view ? ' aria-current="page"' : ""}>${title}</a>`,
  ).join("");
  return page({
    title: `${title} · 管理后台`,
    heading: "通知订阅管理后台",
    wide: true,
    body: `<div class="admin-shell">
      <aside class="admin-sidebar">
        <nav aria-label="管理后台">${nav}</nav>
        <a href="/">订阅首页</a>
        <form method="post" action="/api/admin/logout"><button type="submit" class="btn-mini">退出登录</button></form>
      </aside>
      <main class="admin-main"><h2>${title}</h2>${content}</main>
    </div>`,
  });
}

export function adminOverviewPage(
  subscribers: SubRecord[],
  stats: Record<string, unknown>,
  feed: { notices: Notice[]; generatedAt: string },
): Response {
  const confirmed = subscribers.filter(isConfirmed).length;
  const reasons = stats.reasons && typeof stats.reasons === "object" ? Object.entries(stats.reasons) : [];
  const metrics = [
    ["已确认订阅", confirmed],
    ["待确认订阅", subscribers.length - confirmed],
    ["归档通知", feed.notices.length],
  ].map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("");
  return adminPage("overview", `
    <dl class="admin-metrics">${metrics}</dl>
    <p>最近归档同步　${displayDate(feed.generatedAt)}</p>
    <section class="admin-section">
      <h3>退订与降频</h3>
      <p>累计自助退订 <b>${Number(stats.total) || 0}</b> 次，改为周报 <b>${Number(stats.lowFrequency) || 0}</b> 次。</p>
      ${reasons.length ? `<ul>${reasons.map(([label, count]) => `<li>${esc(label)}　${Number(count) || 0}</li>`).join("")}</ul>` : "<p>暂无退订原因记录。</p>"}
    </section>`);
}

export function subscriberPageUrl(query: string, pageNumber: number, removed = false): string {
  const params = new URLSearchParams({ view: "subscribers" });
  if (query) params.set("q", query);
  if (pageNumber > 1) params.set("page", String(pageNumber));
  if (removed) params.set("removed", "1");
  return `/admin?${params}`;
}

export function adminSubscribersPage(subscribers: SubRecord[], url: URL): Response {
  const query = (url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 254);
  const records = subscribers.filter((record) => record.email.toLowerCase().includes(query))
    .sort((a, b) => a.email.localeCompare(b.email));
  const pageSize = 25;
  const last = Math.max(1, Math.ceil(records.length / pageSize));
  const current = Math.min(last, Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1)));
  const rows = records.slice((current - 1) * pageSize, current * pageSize).map((record) => {
    const prefs = record.prefs || normalizePrefs(null);
    return `<tr>
      <th scope="row">${esc(record.email)}</th>
      <td>${isConfirmed(record) ? "已确认" : "待确认"}</td>
      <td>${FREQUENCY[prefs.frequency]}</td>
      <td>${displayDate(record.createdAt)}</td>
      <td><form method="post" action="/api/admin/subscribers/remove">
        <input type="hidden" name="email" value="${esc(record.email)}">
        <input type="hidden" name="q" value="${esc(query)}">
        <input type="hidden" name="page" value="${current}">
        <label class="admin-confirm"><input type="checkbox" name="confirm" value="yes" required aria-label="确认移出 ${esc(record.email)}"> 确认</label>
        <button class="btn-mini" type="submit" aria-label="移出 ${esc(record.email)}">移出</button>
      </form></td>
    </tr>`;
  }).join("");
  return adminPage("subscribers", `
    <form method="get" action="/admin" class="admin-search">
      <input type="hidden" name="view" value="subscribers">
      <label for="admin-search">按邮箱搜索</label>
      <div><input id="admin-search" class="field" type="search" name="q" value="${esc(query)}" maxlength="254">
      <button class="btn-mini" type="submit">搜索</button></div>
      ${query ? '<a href="/admin?view=subscribers">清除搜索</a>' : ""}
    </form>
    ${url.searchParams.get("removed") === "1" ? '<p class="admin-feedback" role="status">已从投递名单移出。</p>' : ""}
    <p>找到 ${records.length} 条订阅。移出后将停止收信，订阅者重新登录后可以恢复。</p>
    ${rows ? `<div class="admin-table" tabindex="0" role="region" aria-label="订阅名单">
      <table aria-label="订阅名单"><thead><tr><th scope="col">邮箱</th><th scope="col">状态</th><th scope="col">频率</th><th scope="col">订阅时间</th><th scope="col">移出名单</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>` : "<p>没有符合条件的订阅。</p>"}
    ${last > 1 ? `<nav class="admin-pagination" aria-label="订阅名单分页">
      ${current > 1 ? `<a href="${esc(subscriberPageUrl(query, current - 1))}">上一页</a>` : ""}
      <span>第 ${current} / ${last} 页</span>
      ${current < last ? `<a href="${esc(subscriberPageUrl(query, current + 1))}">下一页</a>` : ""}
    </nav>` : ""}
  `);
}

export function adminArchivePage(feed: { notices: Notice[]; generatedAt: string }): Response {
  const recent = [...feed.notices].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 25);
  const rows = recent.map((notice) => `<tr>
    <th scope="row"><a href="${esc(notice.url)}" rel="noreferrer">${esc(notice.title)}</a></th>
    <td>${esc(notice.contest || notice.source || "—")}</td>
    <td>${esc(notice.category || "—")}</td>
    <td>${esc(notice.date || "—")}</td>
  </tr>`).join("");
  return adminPage("archive", `
    <p>最近同步　${displayDate(feed.generatedAt)}</p>
    <p>共 ${feed.notices.length} 条通知，显示最近 ${recent.length} 条。<a href="/archive">查看公开归档</a></p>
    ${rows ? `<div class="admin-table" tabindex="0" role="region" aria-label="最近同步的通知">
      <table aria-label="最近同步的通知"><thead><tr><th scope="col">通知</th><th scope="col">赛事 / 来源</th><th scope="col">栏目</th><th scope="col">发布日期</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>` : "<p>暂无已同步的通知。启用通知同步后，可在此查看结果。</p>"}
  `);
}
