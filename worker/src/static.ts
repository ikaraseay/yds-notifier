/**
 * 纯文本静态资源：项目地址常量 + robots.txt / llms.txt。
 *
 * 三者都由 Worker 直出，不额外部署静态文件。之所以放在代码里而不是托管：
 * 站点是单 Worker 部署，多个资源就多一处会漂移的事实源。
 */

/** 项目仓库：页脚「项目地址」与「错误报告」都指向这里 */
export const PROJECT_URL = "https://github.com/ikaraseay/yds-notifier";
export const ISSUES_URL = `${PROJECT_URL}/issues/new`;

/**
 * 声明本站为非官方第三方服务。邮件 From 名称、页脚、robots / llms
 * 都带上同一个说法，避免收件人误认为组委会官方通知。
 */
export const UNOFFICIAL_NOTE = "非官方项目，与竞赛组委会无关";

/** 邮件显示名的后缀。收件箱里只看得到名字，所以「非官方」必须长在名字上。 */
export const UNOFFICIAL_TAG = "[非官方]";

/**
 * 给发件人显示名补上 [非官方]。
 *
 * 幂等：配置里已经写过的会被去掉再补，不会出现「研电赛通知 [非官方] [非官方]」。
 * 放在代码里而不是靠 MAIL_FROM_NAME 配置，是因为这是合规要求 —— 换部署、
 * 换变量都不该悄悄丢掉。
 */
export function unofficialSenderName(name: string): string {
  const base = String(name || "")
    .replace(/\[非官方\]/g, "")
    .trim();
  return `${base || "研电赛通知"} ${UNOFFICIAL_TAG}`;
}

const TEXT_HEADERS = {
  "Content-Type": "text/plain;charset=utf-8",
  "Cache-Control": "public, max-age=3600",
  "X-Content-Type-Options": "nosniff",
} as const;

/**
 * robots.txt
 *
 * 个人页面（控制台、登录、退订、个人日历）一律不进索引：它们要么需要登录，
 * 要么带邮箱签名，被收录只会有隐私风险。归档与 RSS 是公共内容，放行。
 */
export function robotsResponse(): Response {
  const body = `# ${UNOFFICIAL_NOTE}
# 通知内容版权归原发布方；本站只做聚合与订阅，请以原文为准。

User-agent: *
Allow: /archive
Allow: /feed.xml
Allow: /llms.txt

# 需要登录或邮箱签名的个人页面，不对爬虫开放
Disallow: /api/
Disallow: /dashboard
Disallow: /login
Disallow: /confirm
Disallow: /unsubscribe
Disallow: /calendar.ics
Disallow: /health

# 给 AI 代理的站点说明
# llms.txt: /llms.txt
`;
  return new Response(body, { headers: TEXT_HEADERS });
}

/**
 * llms.txt（https://llmstxt.org 约定）
 *
 * 给大模型一句话说清「这是什么、有哪些公开内容、哪些别碰」，
 * 比让它自己猜页面结构可靠，也能把「非官方」这件事提前讲明白。
 */
export function llmsResponse(baseUrl: string): Response {
  const base = baseUrl.replace(/\/+$/, "");
  const body = `# 研电赛通知订阅

> ${UNOFFICIAL_NOTE}。本站汇总中国研究生电子设计竞赛（研电赛）及关联赛事的公开通知，
> 提供邮件订阅、网页归档、RSS 与个人日历；内容来自各赛事官方站点的公开页面，版权归原发布方。

## 公开内容
- [通知归档](${base}/archive)：按赛事、栏目、角色筛选的历史通知，含摘要与原文链接。
- [RSS](${base}/feed.xml)：与归档同源的通知流，适合订阅阅读器。
- [首页](${base}/)：输入邮箱获取一次性登录链接，不需要密码。

## 使用约定
- 抓取规则见 [robots.txt](${base}/robots.txt)。
- 通知每小时同步一次，可能有延迟；每条都附原文链接，**以原文为准**。
- \`/dashboard\`、\`/unsubscribe\`、\`/calendar.ics\` 等路径需要登录或邮箱签名，不对爬虫开放，
  也不提供任何绕过方式。
- 本站不是竞赛官方渠道，报名、截止时间等关键信息请以组委会公告为准。

## 项目
- [源码](${PROJECT_URL})
- [错误报告](${ISSUES_URL})
- 数据来源：研创网（cpipc.acge.org.cn）及各赛事官方站点
`;
  return new Response(body, {
    headers: { ...TEXT_HEADERS, "Content-Type": "text/plain;charset=utf-8" },
  });
}
