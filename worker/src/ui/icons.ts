/**
 * 站点图标。
 *
 * 以前没有声明 <link rel="icon">，浏览器会按默认规则去要 /favicon.ico，
 * 拿到 404 后在控制台留一条「Failed to load resource」—— 这是首页第二条报错的来源。
 * 现在直接内联一枚 SVG：不需要额外的静态资源托管，也没有缓存戳的问题。
 *
 * 注意 CSP：图标属于 img-src，而页面默认是 default-src 'none'，
 * 所以 security.ts 的 csp() 里加了 img-src 'self'，否则图标会被拦掉换一条新报错。
 */

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
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
