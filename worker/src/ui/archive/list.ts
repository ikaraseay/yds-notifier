/** 归档页「通知列表」：单条通知卡片 + 列表容器。 */

import { esc } from '../../security';
import type { Notice } from '../../feed/types';
import { AUDIENCE_LABELS } from './common';

/** 日期倒序（YYYY-MM-DD 可直接按字符串比较）。 */
export function sortByDateDesc(notices: Notice[]): Notice[] {
  return [...notices].sort((a, b) => b.date.localeCompare(a.date));
}

/** 一条通知：日期 / 阶段 / 来源 / 赛事 → 标题 → 摘要 → 日程 → 要做什么 → 面向 → 徽标。 */
export function renderCard(n: Notice): string {
  const href = n.url;
  const title = esc(n.title);
  const link = href
    ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${title}</a>`
    : title;

  const meta = [`<span>${esc(n.date)}</span>`];
  if (n.stage && n.stage !== '其他') meta.push(`<span class="stg">${esc(n.stage)}</span>`);
  if (n.source) meta.push(`<span>${esc(n.source)}</span>`);
  if (n.contest) meta.push(`<span class="ctg">${esc(n.contest)}</span>`);

  const brief = n.aiSummary || n.summary;
  const summary = brief ? `<div class="ns">${esc(brief)}</div>` : '';

  // 有结构化事件就逐条列；否则回落到单值 deadline，避免信息丢失
  const evs = n.aiEvents || [];
  let eventHtml = '';
  if (evs.length) {
    const rows = evs.map((e) => {
      const label = e.label || (e.kind === 'deadline' ? '截止' : '日程');
      const cls = e.kind === 'deadline' ? 'dt dl' : 'dt';
      const where = e.location ? `（${esc(e.location)}）` : '';
      return `<div class="ei"><span class="lb">${esc(label)}：</span>`
        + `<span class="${cls}">${esc(e.date)}${where}</span></div>`;
    }).join('');
    eventHtml = `<div class="er">${rows}</div>`;
  } else if (n.deadline) {
    eventHtml = `<div class="er"><div class="ei"><span class="lb">截止 / 日程：</span>`
      + `<span class="dt dl">${esc(n.deadline)}</span></div></div>`;
  }

  const action = n.action ? `<div class="ar"><span class="lb">要做什么：</span>${esc(n.action)}</div>` : '';

  const auds = n.audiences || [];
  const audience = auds.length
    ? `<div class="arow"><span class="arlb">面向：</span>${auds
        .map((a) => `<span class="at">${esc(AUDIENCE_LABELS[a] || a)}</span>`)
        .join('')}</div>`
    : '';

  const badges: string[] = [];
  if (n.changeKind === 'changed') badges.push('<span class="badge upd">更新</span>');
  if (n.aiUrgency === 'critical') badges.push('<span class="badge crit">重要</span>');

  return `<div class="nc">
  <div class="mr">${meta.join('')}</div>
  <div class="nt">${link}</div>
  ${summary}
  ${eventHtml}
  ${action}
  ${audience}
  ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
</div>`;
}

/** 列表容器；空结果显示提示而非空白页。 */
export function renderList(notices: Notice[], filtered: boolean): string {
  if (!notices.length) {
    return `<div class="empty">${
      filtered ? '没有符合筛选条件的通知。' : '暂时还没有收录通知，过段时间再来看看吧。'
    }</div>`;
  }
  return `<div class="nl">${notices.map(renderCard).join('')}</div>`;
}
