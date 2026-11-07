/**
 * 归档页组装：读取 → 筛选 → 统计 → 视图（列表 / 日历）→ 整页外壳。
 *
 * 只做「数据 → 结构」的编排，具体卡片与日历分别见 list.ts / calendar.ts，
 * 样式在 styles.css。这样改视觉不需要碰 handler，改抓取也不需要碰 HTML。
 */

import type { ContestSchedule, Notice } from '../../cloudflare/src/feed/types';
import { ISSUES_URL } from '../../cloudflare/src/static';
import { buildCalendarEvents, renderCalendar } from './calendar';
import { archiveHref, archiveLink, chip, toggle } from './common';
import { archivePage } from './layout';
import { renderList, sortByDateDesc } from './list';

export interface ArchiveData {
  notices: Notice[];
  schedule: ContestSchedule[];
  generatedAt?: string;
  url: URL;
}

interface FilterState {
  contest: string;
  category: string;
  audience: string;
  important: boolean;
  view: 'list' | 'cal';
}

function readFilter(url: URL): FilterState {
  const get = (k: string): string => (url.searchParams.get(k) || '').trim();
  return {
    contest: get('contest'),
    category: get('category'),
    audience: get('audience'),
    important: get('important') === '1',
    view: get('view') === 'cal' ? 'cal' : 'list',
  };
}

function applyFilter(notices: Notice[], f: FilterState): Notice[] {
  return notices.filter((n) => {
    if (f.contest && n.contest !== f.contest) return false;
    if (f.category && n.category !== f.category) return false;
    if (f.audience && !(n.audiences || []).includes(f.audience)) return false;
    if (f.important && n.aiUrgency !== 'critical' && n.aiUrgency !== 'high') return false;
    return true;
  });
}

const uniq = (values: Array<string | undefined>): string[] =>
  [...new Set(values.filter((v): v is string => Boolean(v)))];

function formatStamp(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
}

/** 页头：标题 + 说明 + 快捷入口。 */
function renderHeader(hasFilter: boolean): string {
  return `<header class="header">
    <div class="dot"></div>
    <h1>研电赛<span class="hl">通知</span></h1>
    <p class="sub">中国研究生创新实践系列大赛 · 官方通知聚合</p>
    <div class="nav">
      <a href="/">控制台 / 个人日历</a><a href="/feed.xml">RSS 订阅</a>${
        hasFilter ? '<a href="/archive">清除筛选</a>' : ''
      }
    </div>
  </header>`;
}

/** 筛选区：赛事 chip（可滚动）+ 分类 chip + 两个开关。 */
function renderFilters(url: URL, f: FilterState, contests: string[], categories: string[]): string {
  const contestChips = [
    chip('全部赛事', archiveHref(url, { contest: '' }), !f.contest),
    ...contests.map((c) => chip(c, archiveHref(url, { contest: c }), c === f.contest)),
  ].join('');

  const catChips = [
    chip('全部分类', archiveHref(url, { category: '' }), !f.category),
    ...categories.map((c) => chip(c, archiveHref(url, { category: c }), c === f.category)),
  ].join('');

  const toggles = [
    toggle('只看重要', archiveHref(url, { important: f.important ? '' : '1' }), f.important),
    toggle('参赛者视角', archiveHref(url, { audience: f.audience === 'student' ? '' : 'student' }),
      f.audience === 'student'),
  ].join('');

  return `<div class="fsec">
    <div class="fl">赛事筛选</div>
    <div class="cscr"><div class="fr">${contestChips}</div></div>
    <div class="fl fgap">通知分类</div>
    <div class="fr">${catChips}</div>
    <div class="fr fgap">${toggles}</div>
  </div>`;
}

function renderTabs(url: URL, view: 'list' | 'cal'): string {
  return `<div class="vtabs">
    <a class="vt${view === 'list' ? ' act' : ''}" href="${archiveLink(url, { view: '' })}">通知列表</a>
    <a class="vt${view === 'cal' ? ' act' : ''}" href="${archiveLink(url, { view: 'cal' })}">日历视图</a>
  </div>`;
}

/** 归档页主入口。 */
export function renderArchive({ notices, schedule, generatedAt, url }: ArchiveData): Response {
  const f = readFilter(url);
  const all = sortByDateDesc(notices);
  const filtered = applyFilter(all, f);
  const contests = uniq(all.map((n) => n.contest));
  const categories = uniq(all.map((n) => n.category));
  const hasFilter = Boolean(f.contest || f.category || f.audience || f.important);

  const stamp = formatStamp(generatedAt);
  const stats = `共 <strong>${all.length}</strong> 条通知 · <strong>${contests.length}</strong> 项赛事`
    + (hasFilter ? ` · 筛选出 <strong>${filtered.length}</strong> 条` : '')
    + (stamp ? ` · 最近更新 <strong>${stamp}</strong>` : '');

  const main = f.view === 'cal'
    ? renderCalendar(buildCalendarEvents(filtered, schedule), url.searchParams.get('m') || '', url)
    : renderList(filtered, hasFilter);

  const body = `<div class="container">
  ${renderHeader(hasFilter)}

  <div class="stats">${stats}</div>

  ${renderTabs(url, f.view)}

  ${renderFilters(url, f, contests, categories)}

  ${main}

  <div class="ebar">
    <a class="ebtn" href="/">个人日历（登录后复制）</a>
    <a class="ebtn" href="/feed.xml">订阅 RSS</a>
  </div>

  <div class="srcbar">
    <div>数据来自 <a href="https://cpipc.acge.org.cn" target="_blank" rel="noopener noreferrer">研创网</a>
      <span class="sep">·</span>
      <a href="https://www.cie.org.cn" target="_blank" rel="noopener noreferrer">中国电子学会</a>
      <span class="sep">·</span> 共 ${all.length} 条，覆盖 ${contests.length} 项主题赛事
    </div>
    <div>日历为每个订阅者单独生成，登录控制台即可复制自己的地址。</div>
  </div>

  <footer class="footer">
    标题错漏、赛事缺失，或者想加一个赛事？
    <a href="${ISSUES_URL}" target="_blank" rel="noopener noreferrer">反馈给我们</a>
  </footer>
</div>`;

  return archivePage({ title: '通知归档 · 研电赛', body });
}

/** 读 KV 或解析失败时的兜底页。 */
export function renderArchiveError(): Response {
  return archivePage(
    {
      title: '通知归档 · 研电赛',
      body: '<div class="container"><div class="empty">归档暂时无法加载，请稍后再试。</div></div>',
    },
    500,
  );
}
