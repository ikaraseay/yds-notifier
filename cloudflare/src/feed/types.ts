/**
 * 通知数据契约（KV `feed:notices` 的载荷形状）。
 *
 * Python 端 `backend/publish.py` 负责写入，Worker 读入后按白名单清洗。
 * 这里集中定义，避免「写侧字段加了一个、读侧忘了同步」这类跨端漂移。
 */

export interface Attachment {
  name: string;
  url: string;
}

/** AI 抽出的真实事件日（已由 Python 端确定性归一化成 YYYY-MM-DD）。 */
export interface AiEvent {
  date: string;
  evidence: string;
  label: string;
  kind: string;
  location: string;
  confidence: number;
}

export interface Notice {
  uid: string;
  title: string;
  url: string;
  date: string;
  category: string;
  source: string;
  summary: string;
  deadline: string;
  attachments?: Attachment[];
  changeKind?: 'new' | 'changed';
  contest?: string;
  stage?: string;
  audiences?: string[];
  action?: string;
  aiCategory?: string;
  aiSummary?: string;
  aiUrgency?: string;
  aiReason?: string;
  aiEvents?: AiEvent[];
  aiConfidence?: number;
  aiVersion?: string;
}

/** 官方赛程表中的一项赛事（Python 端解析，日期均为 YYYY-MM-DD）。 */
export interface ContestSchedule {
  contest: string;
  signupStart: string;
  signupEnd: string;
  submitStart: string;
  submitEnd: string;
  finalStart: string;
  finalEnd: string;
  sourceUrl: string;
}

export interface FeedPayload {
  site?: string;
  baseUrl?: string;
  generatedAt?: string;
  notices?: unknown; // 运行期再校验是否为数组
  schedule?: unknown;
}

/** 归档页 / RSS / 日历共用的角色中文名。 */
export const AUDIENCE_LABELS: Record<string, string> = {
  student: '参赛学生',
  advisor: '指导教师',
  admin: '培养单位',
  organizer: '分赛区 / 承办方',
};

export const AUDIENCES = ['student', 'advisor', 'admin', 'organizer'];
export const URGENCIES = ['critical', 'high', 'normal', 'low'];
export const AI_CATEGORIES = ['报名参赛', '评审与名单', '决赛与收官', '赛事动态', '其他通知'];
export const EVENT_KINDS = ['deadline', 'event', 'notice', 'other'];
export const STAGES = [
  '报名', '资格审查', '缴费', '提交作品', '评审', '决赛',
  '公示', '获奖', '报销', '承办', '动态', '其他',
];
