/** 归档页整页外壳：点阵背景 + 单列容器，样式带 nonce 以通过 CSP。 */

import { csp, esc, newNonce, securityHeaders } from '../../security';
import styles from './styles.css';

export interface ShellOpts {
  title: string;
  body: string;
}

export function archivePage({ title, body }: ShellOpts, status = 200): Response {
  const nonce = newNonce();
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex">
<style nonce="${nonce}">${styles}</style></head><body>
${body}
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
