import type { GroupConfig } from "../groups/types";
import { esc } from "../platform/security";

/** Shared section links retain native navigation and work without JavaScript. */
export function skillSettingsHeader(name: string, description: string, status: string, builtin = false): string {
  return `<header class="skill-heading"><p class="breadcrumb"><a href="/skills">工作台</a><span aria-hidden="true"> / </span>${esc(name)}</p>
    <div class="work-heading"><p>${esc(description)}</p><span class="work-status">${esc(status)}</span></div>
    <nav class="work-tabs section-nav" aria-label="Skill 设置">
      <a href="#skill-sources">监控来源</a><a href="#skill-rules">通知规则</a>
      <a href="#skill-delivery">通知设置</a>${builtin ? '<a href="/api/skills/yds/notices">通知记录</a>' : '<a href="#skill-history">最近检查</a>'}
    </nav></header>`;
}

export function monitorState(config: GroupConfig) {
  const ready = config.sources.filter(source => source.status === "ready").length;
  const failed = config.sources.filter(source => source.status === "error" || source.status === "blocked").length;
  const waiting = config.sources.length - ready - failed;
  const label = !config.sources.length ? "待添加网址" : failed ? "需要处理" : waiting ? "等待试抓" : config.enabled ? "监控中" : "已暂停";
  const tone = failed ? "error" : waiting || !config.sources.length ? "waiting" : config.enabled ? "ready" : "paused";
  return { ready, failed, waiting, label, tone, attention: !config.sources.length || failed > 0 || waiting > 0 };
}
