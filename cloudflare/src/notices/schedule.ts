/** 官方赛程的展开逻辑：同一份数据被「个人日历」与「归档日历视图」共用。 */

import type { ContestSchedule } from './types';

export interface ScheduleEntry {
  date: string;
  label: string;
  /** true 表示截止类节点（日历里标红并挂提醒） */
  deadline: boolean;
}

/** 赛程字段 → 日历节点；只保留真正有意义的五个节点。 */
export function scheduleEntries(s: ContestSchedule): ScheduleEntry[] {
  return [
    { date: s.signupStart, label: '报名开始', deadline: false },
    { date: s.signupEnd, label: '报名截止', deadline: true },
    { date: s.submitEnd, label: '提交作品截止', deadline: true },
    { date: s.finalStart, label: '决赛开始', deadline: false },
    { date: s.finalEnd, label: '决赛结束', deadline: false },
  ];
}

/** 严格校验 YYYY-MM-DD（含真实日期，排除 2026-02-31）。 */
export function isDay(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
}
