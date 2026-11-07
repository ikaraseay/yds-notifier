/**
 * 归档页「日历视图」。
 *
 * 设计要点：
 * 1. **日期格子带来源**：每格最多列 3 个节点，显示「来源 · 节点」；
 * 2. **格子可点**：点某天跳到下方「按天日程」对应分组（`#d-YYYY-MM-DD`），
 *    `:target` 会高亮该分组，形成「月历 → 当日清单」的快速定位；
 * 3. **节点可跳转**：标题链回公告原文；
 * 4. **月份快切换**：上月 / 下月 / 本月 + `<details>` 折叠的「年 + 12 个月」网格，
 *    纯链接实现，不依赖 JS（站点 CSP 不允许脚本）。
 */

import { esc } from '../../cloudflare/src/security';
import { isDay, scheduleEntries } from '../../cloudflare/src/feed/schedule';
import type { ContestSchedule, Notice } from '../../cloudflare/src/feed/types';
import { archiveLink, shortSource, todayCN, weekdayOf } from './common';

/** 摊平后的日历节点：可能来自通知的 AI 事件，也可能来自官方赛程表。 */
export interface CalEvent {
  date: string;
  label: string;
  deadline: boolean;
  title: string;
  url: string;
  /** 格子里的来源后缀：通知取来源名，赛程取赛事名 */
  source: string;
  contest: string;
  /** true 表示来自官方赛程表（不是某篇公告） */
  official: boolean;
}

/** 单格最多显示的节点条数，超出用「+N」角标提示。 */
const MAX_PER_CELL = 3;
/** 「按天日程」最多渲染的天数，避免大月份把页面拉得过长。 */
const MAX_DAYS = 62;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 把通知与官方赛程摊平成按日排序的事件流。 */
export function buildCalendarEvents(notices: Notice[], schedule: ContestSchedule[]): CalEvent[] {
  const out: CalEvent[] = [];

  for (const n of notices) {
    const source = shortSource(n.source);
    // 只收「有真实日期的节点」：AI 抽出的多日程，或确定性规则抽到的 deadline。
    // 绝不回落到发布日期——那正是当初「日历只显示发布日期」的老 bug，
    // 而且会让每个普通动态都在发布当天多出一个假日程，把月历糊满。
    const events = (n.aiEvents || []).length
      ? n.aiEvents!.map((e) => ({
          date: e.date,
          label: e.label || (e.kind === 'deadline' ? '截止' : '日程'),
          deadline: e.kind === 'deadline',
        }))
      : n.deadline
        ? [{ date: n.deadline, label: '截止', deadline: true }]
        : [];
    for (const e of events) {
      if (!isDay(e.date)) continue;
      out.push({
        date: e.date,
        label: e.label,
        deadline: e.deadline,
        title: n.title,
        url: n.url,
        source,
        contest: n.contest || '',
        official: false,
      });
    }
  }

  for (const s of schedule) {
    for (const item of scheduleEntries(s)) {
      if (!isDay(item.date)) continue;
      out.push({
        date: item.date,
        label: item.label,
        deadline: item.deadline,
        title: `${s.contest} ${item.label}`,
        url: s.sourceUrl,
        // 赛程没有「公告来源」，格子里用赛事名当来源标记信息量更大
        source: shortSource(s.contest),
        contest: s.contest,
        official: true,
      });
    }
  }

  return out.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
}

interface MonthRef {
  year: number;
  /** 1–12 */
  month: number;
}

/** `?m=YYYY-MM` → { year, month }，非法值回落到「今天所在的月」。 */
function parseMonth(raw: string): MonthRef {
  const m = /^(\d{4})-(\d{2})$/.exec((raw || '').trim());
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (year >= 2000 && year <= 2100 && month >= 1 && month <= 12) return { year, month };
  }
  const today = todayCN();
  return { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
}

function shiftMonth({ year, month }: MonthRef, delta: number): MonthRef {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

const monthKey = (r: MonthRef): string => `${r.year}-${pad2(r.month)}`;

/** 月份导航：上月 / 下月 / 本月 + 折叠式月份网格。 */
function renderMonthNav(cur: MonthRef, thisMonth: MonthRef, monthsWithData: Set<string>, url: URL): string {
  const prev = shiftMonth(cur, -1);
  const next = shiftMonth(cur, 1);
  const isThisMonth = monthKey(cur) === monthKey(thisMonth);

  const cells = Array.from({ length: 12 }, (_, i) => {
    const key = `${cur.year}-${pad2(i + 1)}`;
    const cls = [
      'cm',
      key === monthKey(cur) ? 'act' : '',
      monthsWithData.has(key) ? 'has' : '',
    ].filter(Boolean).join(' ');
    const hint = monthsWithData.has(key) ? ' · 有日程' : '';
    return `<a class="${cls}" href="${archiveLink(url, { view: 'cal', m: key })}" title="${cur.year} 年 ${i + 1} 月${hint}">${i + 1} 月</a>`;
  }).join('');

  return `<div class="caln">
      <a class="cnav" href="${archiveLink(url, { view: 'cal', m: monthKey(prev) })}" rel="prev">‹ 上月</a>
      ${isThisMonth ? '' : `<a class="cnav act" href="${archiveLink(url, { view: 'cal', m: monthKey(thisMonth) })}">本月</a>`}
      <a class="cnav" href="${archiveLink(url, { view: 'cal', m: monthKey(next) })}" rel="next">下月 ›</a>
      <details class="cpick">
        <summary>选月份</summary>
        <div class="cpop">
          <div class="cyear">
            <a href="${archiveLink(url, { view: 'cal', m: `${cur.year - 1}-${pad2(cur.month)}` })}" aria-label="上一年">‹</a>
            <span>${cur.year} 年</span>
            <a href="${archiveLink(url, { view: 'cal', m: `${cur.year + 1}-${pad2(cur.month)}` })}" aria-label="下一年">›</a>
          </div>
          <div class="cmgr">${cells}</div>
        </div>
      </details>
    </div>`;
}

/** 单个日期格子：有节点时是锚点链接，无节点时是纯格子。 */
function renderCell(day: string, num: number, list: CalEvent[], today: string): string {
  const cls = ['cd'];
  if (list.length) cls.push('he');
  if (list.some((e) => e.deadline)) cls.push('dl');
  if (day === today) cls.push('td');

  const lines = list.slice(0, MAX_PER_CELL).map((e) =>
    `<span class="cl${e.deadline ? ' dl' : ''}">`
    + (e.source ? `<em>${esc(e.source)}</em>` : '')
    + `<b>${esc(e.label)}</b></span>`,
  ).join('');
  const more = list.length ? `<span class="cn">${list.length}</span>` : '';
  const inner = `<span class="dn">${num}</span>${more}${lines}`;

  if (!list.length) return `<div class="${cls.join(' ')}">${inner}</div>`;

  const tip = `${day}：${list.map((e) => `${e.label}（${e.official ? '官方赛程' : e.source}）`).join('，')}`;
  return `<a class="${cls.join(' ')}" href="#d-${day}" title="${esc(tip)}">${inner}</a>`;
}

/** 按天分组的日程清单，每个分组带锚点 id，供月历格子跳转定位。 */
function renderDayGroups(groups: Array<[string, CalEvent[]]>, total: number): string {
  if (!groups.length) {
    return '<p class="calempty">这个月没有日程节点，可以切换月份或调整筛选条件。</p>';
  }
  const shown = groups.slice(0, MAX_DAYS);
  const items = shown.map(([day, list]) => {
    const rows = list.map((e) => {
      const label = `<span class="lb${e.deadline ? ' dl' : ''}">${esc(e.label)}</span>`;
      const chip = esc(e.official ? '官方赛程' : (e.source || '通知'));
      const title = e.url
        ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title)}</a>`
        : esc(e.title);
      return `<div class="cei"><span class="src">${chip}</span>${label}${title}</div>`;
    }).join('');
    return `<div class="cday" id="d-${day}">
        <a class="cday-h" href="#d-${day}">${day.slice(5)} <span class="wk">周${weekdayOf(day)}</span>
          <span class="cnt">${list.length} 个节点</span></a>
        ${rows}
      </div>`;
  }).join('');

  const clipped = groups.length > MAX_DAYS
    ? `<p class="calempty">还有 ${groups.length - MAX_DAYS} 天的日程未展示，可用上方筛选缩小范围。</p>`
    : '';
  return `<p class="calempty">共 ${total} 个节点，分布在 ${groups.length} 天。</p>
    <div class="cdays">${items}</div>${clipped}`;
}

/** 日历视图主入口。`monthParam` 为 `?m=YYYY-MM`，空则用当月。 */
export function renderCalendar(events: CalEvent[], monthParam: string, url: URL): string {
  const cur = parseMonth(monthParam);
  const thisMonth = parseMonth('');
  const today = todayCN();
  const prefix = `${cur.year}-${pad2(cur.month)}`;

  // 按日归并当月事件
  const byDay = new Map<string, CalEvent[]>();
  for (const e of events) {
    if (!e.date.startsWith(prefix)) continue;
    const arr = byDay.get(e.date) || [];
    arr.push(e);
    byDay.set(e.date, arr);
  }
  const monthEvents = [...byDay.values()].flat();
  const contests = new Set(monthEvents.map((e) => e.contest).filter(Boolean));
  const monthsWithData = new Set(events.map((e) => e.date.slice(0, 7)));

  // 月历网格（周日开头，与国内日历习惯一致）
  const firstWeekday = new Date(Date.UTC(cur.year, cur.month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(cur.year, cur.month, 0)).getUTCDate();
  const head = ['日', '一', '二', '三', '四', '五', '六']
    .map((w) => `<div class="cdh">${w}</div>`)
    .join('');
  const blanks = Array.from({ length: firstWeekday }, () => '<div class="cd om"></div>').join('');
  const cells = Array.from({ length: daysInMonth }, (_, i) => {
    const day = `${prefix}-${pad2(i + 1)}`;
    return renderCell(day, i + 1, byDay.get(day) || [], today);
  }).join('');
  const tail = (7 - ((firstWeekday + daysInMonth) % 7)) % 7;
  const tailBlanks = Array.from({ length: tail }, () => '<div class="cd om"></div>').join('');

  const summary = monthEvents.length
    ? `本月 ${monthEvents.length} 个节点 · 覆盖 ${contests.size} 项赛事`
    : '本月暂无节点';

  return `<div class="calv" id="cal">
  <div class="calh">
    <div>
      <h3>${cur.year} 年 ${cur.month} 月</h3>
      <p class="csub">${summary} · 点击日期定位当天日程</p>
    </div>
    ${renderMonthNav(cur, thisMonth, monthsWithData, url)}
  </div>

  <div class="cg">${head}${blanks}${cells}${tailBlanks}</div>

  <div class="cleg">
    <span><span class="d dl"></span> 截止日期</span>
    <span><span class="d ev"></span> 赛事活动</span>
    <span><span class="d sc"></span> 官方赛程</span>
    <span>右上角数字 = 当天节点数，点格子看当天日程</span>
  </div>

  <div class="calev">
    <h4>本月日程 <a class="cnav" href="#cal">↑ 回到月历</a></h4>
    ${renderDayGroups([...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])), monthEvents.length)}
  </div>
</div>`;
}
