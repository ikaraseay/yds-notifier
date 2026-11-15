import YDS_SKILL from "../../../skills/yds/skill.json";
import type { GroupConfig, GroupRow, Skill } from "../groups/types";
import { esc } from "../platform/security";
import { page } from "./layout";

export function groupErrorPage(message: string, status = 400) {
  return page({ title: "通知组", heading: "通知组", body: `<p role="alert">${esc(message)}</p><a href="/groups">返回通知组</a>` }, status);
}

export function groupForm(action: string, group: string, label: string, fields = ""): string {
  return `<form method="post" action="/groups">
    <input type="hidden" name="action" value="${esc(action)}">
    <input type="hidden" name="id" value="${esc(group)}">
    ${fields}<button type="submit" class="btn-mini">${esc(label)}</button>
  </form>`;
}

export function groupsPage(email: string, groups: GroupRow[], subscriptions: Map<string, string>, canCreate: boolean): Response {
  const own = groups.filter(row => row.owner === email);
  const published = groups.filter(row => row.published && row.owner !== email);
  const detail = own.map(row => {
    const draft = JSON.parse(row.draft) as GroupConfig;
    const skill = row.skill ? JSON.parse(row.skill) as Skill : null;
    const revision = `<input type="hidden" name="revision" value="${row.revision}">`;
    const sources = draft.sources.map((source, index) => `<section class="section">
      <p class="detail"><b>${esc(source.url)}</b></p>
      <p>${esc(source.detail || "等待后台试抓")}</p>
      ${source.sample ? `<p><b>试抓样本</b>　${esc(source.sample)}</p>` : ""}
      ${groupForm("prompt", row.id, "保存提示词", `${revision}<input type="hidden" name="index" value="${index}">
        <label>监控提示词<textarea class="field" name="prompt" maxlength="600" rows="3" required>${esc(source.prompt)}</textarea></label>`)}
      ${groupForm("remove-source", row.id, "移除网址", `${revision}<input type="hidden" name="index" value="${index}">`)}
    </section>`).join("");
    return `<section class="section"><h2>${esc(draft.name)}</h2>
      <p>${draft.enabled ? "监控已启用" : "监控已暂停"} · ${row.visibility === "pending" ? "待审核" : row.published ? "已公开" : "私有"}</p>
      ${row.review_note ? `<p role="status">${esc(row.review_note)}</p>` : ""}
      ${groupForm("add", row.id, "添加网址并试抓", `${revision}<label>网址，每行一个
        <textarea class="field" name="urls" maxlength="10000" rows="3" required></textarea></label>`)}
      ${sources}
      ${groupForm(draft.enabled ? "pause" : "enable", row.id, draft.enabled ? "暂停监控" : "启用监控", revision)}
      ${groupForm("request-public", row.id, "提交公开审核", `${revision}<label>
        <input type="checkbox" name="confirm" value="yes" required> 同意在公开目录显示我的已验证邮箱 ${esc(email)}</label> `)}
      ${groupForm("delete", row.id, "删除通知组", `${revision}<label><input type="checkbox" name="confirm" value="yes" required> 确认删除</label> `)}
      ${row.published || row.visibility === "pending" ? groupForm("withdraw", row.id, "撤回公开", revision) : ""}
      ${skill ? `<p>Skill v${skill.version} · 已评估 ${skill.evaluated || 0} 批</p>
        ${skill.candidate ? `<p>${esc(skill.candidate)}</p><p>${esc(skill.evidence)}</p>${groupForm("apply-skill", row.id, "采用候选版本", revision)}` : ""}
        ${skill.version > 1 ? groupForm("rollback-skill", row.id, "恢复上一版本", revision) : ""}` : ""}
    </section>`;
  }).join("");
  return page({
    title: "通知组 · MeoNotifier", heading: "通知组", wide: true,
    body: `<main><a href="/dashboard">返回订阅控制台</a>
      <section class="section"><h2>我的通知组</h2>
      ${canCreate ? groupForm("create", "", "新建私有通知组", '<label>组名 <input class="field" name="name" maxlength="80" required></label> ') : "<p>创建权限由管理员授予。</p>"}
      ${detail || "<p>暂无自建通知组。</p>"}</section>
      <section class="section"><h2>公开目录</h2>
        <p><a href="/dashboard">${esc(YDS_SKILL.name)} · 内置 Skill</a></p>
        ${published.map(row => {
          const config = JSON.parse(row.published!) as GroupConfig;
          const frequency = subscriptions.get(row.id);
          return `<section class="section"><h3>${esc(config.name)}</h3><p>公开者　${esc(row.owner)}</p>
            <ul>${config.sources.map(source => `<li class="detail">${esc(source.url)}</li>`).join("")}</ul>
            ${groupForm("subscribe", row.id, frequency ? "更新推送频率" : "订阅", `<label>推送频率
              <select name="frequency">${[["instant","即时"],["daily","日报"],["weekly","周报"]].map(([key,label]) => `<option value="${key}"${frequency === key ? " selected" : ""}>${label}</option>`).join("")}</select></label> `)}
            ${frequency ? groupForm("unsubscribe", row.id, "退出订阅") : ""}</section>`;
        }).join("")}
      </section></main>`,
  });
}
