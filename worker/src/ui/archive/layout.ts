/** 归档页整页外壳：点阵背景 + 单列容器，样式带 nonce 以通过 CSP。 */

import { csp, esc, newNonce, securityHeaders } from '../../security';
import { siteFooter } from '../footer';
import styles from './styles.css';

export interface ShellOpts {
  title: string;
  body: string;
}

export function archivePage({ title, body }: ShellOpts, status = 200): Response {
  const nonce = newNonce();
  // 归档是公开内容，robots.txt 与 llms.txt 都放行；错误页除外。
  const robots = status === 200 ? "index,follow" : "noindex,nofollow";
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><meta name="robots" content="${robots}">
<style nonce="${nonce}">${styles}</style></head><body>
${body}
${siteFooter()}
</body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html;charset=utf-8',
      ...securityHeaders(),
      'Content-Security-Policy': csp(nonce, false),
    },
  });
}
