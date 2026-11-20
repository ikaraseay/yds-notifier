import { esc } from "../platform/security";

/** Shared entry and settings navigation for every notification skill. */
export function skillSettingsHeader(name: string, description: string, status: string, builtin = false): string {
  return `<header class="skill-heading"><p><a href="/skills">所有通知 Skill</a></p>
    <h2>${esc(name)}</h2><p>${esc(description)}</p><span class="work-status">${esc(status)}</span>
    <nav class="work-tabs" aria-label="Skill 设置">
      <a href="#skill-sources">监控来源</a><a href="#skill-rules">通知规则</a>
      <a href="#skill-delivery">通知设置</a>${builtin ? '<a href="/archive">通知记录</a>' : '<a href="#skill-history">运行记录</a>'}
    </nav></header>`;
}
