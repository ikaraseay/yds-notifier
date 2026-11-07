/**
 * 站点图标：内联 SVG，由 /favicon.svg 与 /favicon.ico 直出。
 *
 * 页面统一声明 <link rel="icon">，避免浏览器回退到 /favicon.ico 拿到 404。
 * CSP 的 img-src 'self' 必须保留，否则图标会被拦下。
 */

import { cacheControl } from "../security";

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="研电赛通知订阅">
<rect x="5" y="5" width="54" height="54" rx="11" fill="#FFD93D" stroke="#2E2A33" stroke-width="6"/>
<circle cx="24" cy="24" r="7" fill="#FF6B6B" stroke="#2E2A33" stroke-width="4"/>
<rect x="31" y="34" width="20" height="7" rx="3.5" fill="#4D96FF" stroke="#2E2A33" stroke-width="3"/>
<circle cx="24" cy="46" r="4" fill="#2E2A33"/>
</svg>`;

export function faviconResponse(): Response {
  return new Response(FAVICON, {
    headers: {
      "Content-Type": "image/svg+xml;charset=utf-8",
      // 图标允许长缓存：内容不变，换了内容换个路径即可
      "Cache-Control": cacheControl(86400),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
