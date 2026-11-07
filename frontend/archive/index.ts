/**
 * 归档页对外只暴露两个入口，内部按职责拆分：
 *
 *   index.ts   ← 你在这里
 *   ├── page.ts      组装：筛选 → 统计 → 视图 → 外壳
 *   ├── list.ts      通知列表卡片
 *   ├── calendar.ts  日历视图（含按天日程）
 *   ├── common.ts    URL 改写 / chip / 开关 / 日期工具
 *   ├── layout.ts    整页 <html> 外壳与 CSP nonce
 *   └── styles.css   全部样式（构建时以文本模块导入）
 */

export { renderArchive, renderArchiveError, type ArchiveData } from './page';
export { archivePage, type ShellOpts } from './layout';
