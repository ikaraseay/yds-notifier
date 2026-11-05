/** 界面层：HTML 骨架、响应构造。所有响应统一带安全头与 CSP nonce。 */

import { csp, esc, newNonce, securityHeaders } from "../security";
import { CSS } from "./styles";

export interface PageOpts {
  title: string;
  /** 允许含少量自生成的 <em> 标签，仅用于服务端静态文案 */
  heading: string;
  /** 已由调用方用 esc() 处理过动态数据的 HTML */
  body: string;
  extra?: string;
  /** 纯 JS 片段，由本函数包上带 nonce 的 <script> */
  script?: string;
}

export function page({ title, heading, body, extra = "", script = "" }: PageOpts, status = 200): Response {
  const nonce = newNonce();
  const hasScript = Boolean(script);
  const safeHeading = esc(heading)
    .replace(/&lt;\/em&gt;/g, "</em>")
    .replace(/&lt;em&gt;/g, "<em>");

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex">
<style nonce="${nonce}">${CSS}</style></head><body>
<div class="card">
  <div class="mark"></div>
  <h1>${safeHeading}</h1>
  ${body}
  ${extra}
</div>${hasScript ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;

  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      ...securityHeaders(),
      "Content-Security-Policy": csp(nonce, hasScript),
    },
  });
}

export function pageWithCookie(opts: PageOpts, cookie: string, status = 200): Response {
  const resp = page(opts, status);
  const h = new Headers(resp.headers);
  h.append("Set-Cookie", cookie);
  return new Response(resp.body, { status: resp.status, headers: h });
}

export function jsonResp(data: unknown, status = 200, cookie?: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json;charset=utf-8",
    ...securityHeaders(),
  };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(JSON.stringify(data), { status, headers });
}

export function redirect(location: string, cookie?: string): Response {
  const headers: Record<string, string> = { Location: location, ...securityHeaders() };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(null, { status: 302, headers });
}
