/** 归档页共用的小工具：URL 改写、筛选 chip、日期与文案。 */

import { esc } from '../../cloudflare/src/security';
import { AUDIENCE_LABELS } from '../../cloudflare/src/feed/types';

export { AUDIENCE_LABELS };

/**
 * 在保留其它查询参数的前提下改一个值；空字符串表示删掉该参数。
 * 所有筛选、翻月、切换视图都靠它拼链接，因此筛选条件在切换时不会丢。
 */
export function archiveHref(url: URL, patch: Record<string, string>): string {
  const p = new URLSearchParams(url.searchParams.toString());
  for (const [k, v] of Object.entries(patch)) {
    if (!v) p.delete(k);
    else p.set(k, v);
  }
  const qs = p.toString();
  return qs ? `/archive?${qs}` : '/archive';
}

/** 归档页内部链接：统一转义 `&`，否则 HTML 属性会被截断。 */
export function archiveLink(url: URL, patch: Record<string, string>): string {
  return esc(archiveHref(url, patch));
}

/** 单选筛选按钮（赛事 / 分类）。 */
export function chip(label: string, href: string, active: boolean): string {
  const cls = active ? 'fb act' : 'fb';
  return `<a class="${cls}" href="${esc(href)}">${esc(label)}</a>`;
}

/** 双态开关（只看重要 / 参赛者视角）。 */
export function toggle(label: string, href: string, on: boolean): string {
  return `<a class="tw" href="${esc(href)}"><span>${esc(label)}</span>`
    + `<span class="tb${on ? ' on' : ''}"></span></a>`;
}

/** 站点面向国内用户，统一按北京时间取「今天」，避免 UTC 跨日出错。 */
export function todayCN(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** YYYY-MM-DD → 周几（用 UTC 解析，纯日期不受时区影响）。 */
export function weekdayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : WEEKDAYS[d.getUTCDay()];
}

/** 把来源名压缩到 6 个字内，日历格子放得下又不会两个赛事混在一起。 */
export function shortSource(source: string): string {
  const s = (source || '').split(/[·/／]/)[0].trim();
  return s.length > 6 ? `${s.slice(0, 6)}…` : s;
}
