/**
 * 页脚：非官方声明 + 项目地址 + 错误报告。
 *
 * 每个对外页面都带同一份，理由有两个：
 *   1. 站点聚合的是组委会与各赛事的公告，必须让人一眼看出这不是官方渠道；
 *   2. 出问题时用户需要一个明确的反馈入口，而不是去猜联系方式。
 *
 * 链接地址集中在 static.ts，页脚只负责排版。
 */

import { ISSUES_URL, PROJECT_URL, UNOFFICIAL_NOTE } from "../cloudflare/src/static";

export function siteFooter(): string {
  return `<footer class="foot">
  <p class="foot-note">${UNOFFICIAL_NOTE}。内容自动聚合自公开页面，关键时间节点请以官方公告为准。</p>
  <p class="foot-links">
    <a href="${PROJECT_URL}" rel="noopener">项目地址</a>
    <span>·</span>
    <a href="${ISSUES_URL}" rel="noopener">错误报告</a>
    <span>·</span>
    <a href="/archive">通知归档</a>
    <span>·</span>
    <a href="/feed.xml">RSS</a>
  </p>
</footer>`;
}
