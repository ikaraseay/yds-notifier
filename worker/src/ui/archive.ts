/**
 * 通知归档页的独立版式（对齐 yandiansai-notices 的 Memphis 设计）。
 *
 * 与其它页面不同，归档页是「整页设计」：点阵背景 + 720px 单列 + 硬阴影卡片，
 * 复用通用 page() 的 card 骨架会打架，所以单独给一套 CSS 与 HTML 外壳。
 * 仍然复用 security.csp 的 nonce 机制，样式内联但受 CSP 约束。
 */

import { csp, esc, newNonce, securityHeaders } from "../security";

export const ARCHIVE_CSS = `
:root{--bg:#FFF4E4;--ink:#2E2A33;--coral:#FF6B6B;--yellow:#FFD93D;--blue:#4D96FF;--meta:#6b6572}
*{margin:0;padding:0;box-sizing:border-box}
body{background-color:var(--bg);background-image:radial-gradient(var(--ink) 1.5px,transparent 1.5px);background-size:22px 22px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.75;color:var(--ink);min-height:100vh;padding:40px 20px}
a{color:inherit}
.container{max-width:720px;margin:0 auto}
.header{position:relative;margin-bottom:24px;padding:32px;background:#fff;border:3px solid var(--ink);border-radius:8px;box-shadow:8px 8px 0 var(--ink)}
.header h1{font-size:36px;font-weight:800;letter-spacing:-0.5px;line-height:1.25}
.header h1 .hl{background:var(--coral);color:#fff;padding:2px 12px;border-radius:4px;display:inline-block;transform:rotate(-1deg)}
.header .sub{margin-top:8px;color:var(--meta);font-size:14px}
.header .dot{position:absolute;top:20px;right:20px;width:16px;height:16px;background:var(--yellow);border:2px solid var(--ink);border-radius:50%}
.header .nav{margin-top:14px;display:flex;gap:14px;flex-wrap:wrap;font-size:12px}
.header .nav a{color:var(--blue);text-decoration:underline;text-underline-offset:2px;font-weight:600}
.stats{margin-bottom:16px;padding:12px 20px;background:#fff;border:2px solid var(--ink);border-radius:8px;box-shadow:4px 4px 0 var(--ink);font-size:13px;color:var(--meta)}
.stats strong{color:var(--ink);font-weight:700}
.fsec{margin-bottom:16px;padding:16px 20px;background:#fff;border:2px solid var(--ink);border-radius:8px;box-shadow:4px 4px 0 var(--ink)}
.fl{font-size:12px;font-weight:700;color:var(--meta);margin-bottom:8px;letter-spacing:.5px}
.fr{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.fb{padding:5px 14px;border:2px solid var(--ink);border-radius:20px;background:#fff;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s ease;box-shadow:3px 3px 0 var(--ink);font-family:inherit;color:var(--ink);text-decoration:none;display:inline-block}
.fb:hover{background:#f8f4ee}.fb.act{background:var(--yellow)}
.fb:active{transform:translate(3px,3px);box-shadow:0 0 0 var(--ink)}
.tw{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;cursor:pointer;user-select:none;text-decoration:none}
.tb{width:32px;height:18px;border:2px solid var(--ink);border-radius:9px;background:#fff;position:relative;transition:background .15s;display:inline-block}
.tb.on{background:var(--coral)}
.tb::after{content:'';position:absolute;top:2px;left:2px;width:10px;height:10px;background:#fff;border:2px solid var(--ink);border-radius:50%;transition:transform .15s}
.tb.on::after{transform:translateX(14px)}
.vtabs{display:flex;gap:0;margin-bottom:16px;border:2px solid var(--ink);border-radius:8px;overflow:hidden;box-shadow:4px 4px 0 var(--ink)}
.vt{flex:1;padding:10px;background:#fff;border:none;border-right:2px solid var(--ink);font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;color:var(--ink);transition:background .15s;text-align:center;text-decoration:none}
.vt:last-child{border-right:none}.vt.act{background:var(--yellow)}.vt:hover{background:#f8f4ee}
.nl{background:#fff;border:3px solid var(--ink);border-radius:8px;box-shadow:8px 8px 0 var(--ink);overflow:hidden}
.nc{padding:20px;border-bottom:2px dashed #e0dcd4;animation:ci .2s cubic-bezier(.22,.9,.28,1) both}
.nc:last-child{border-bottom:none}
@keyframes ci{from{opacity:0;transform:translate(8px,8px)}to{opacity:1;transform:translate(0,0)}}
.mr{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:11px;color:var(--meta);flex-wrap:wrap}
.mr .stg{padding:2px 8px;border:1.5px solid var(--ink);border-radius:4px;font-size:10px;font-weight:600;background:#f8f4ee}
.mr .ctg{padding:2px 8px;border:1.5px solid var(--blue);border-radius:4px;font-size:10px;font-weight:600;background:#e8f0fe;color:var(--blue)}
.nt{font-size:15px;font-weight:700;line-height:1.5;margin-bottom:6px}
.nt a{color:var(--blue);text-decoration:underline;text-underline-offset:3px;font-weight:700}
.nt a:hover{opacity:.7}
.ns{font-size:13px;color:#555;line-height:1.7;margin-bottom:10px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.er{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:8px;font-size:12px}
.ei{display:flex;align-items:center;gap:4px}
.ei .lb{color:var(--meta)}.ei .dt{font-weight:600}.ei .dt.dl{color:var(--coral);font-weight:700}
.ar{margin-bottom:8px;padding:6px 10px;background:#FFF9EC;border-left:3px solid var(--yellow);font-size:12px;line-height:1.6}
.ar .lb{font-weight:700;color:var(--ink)}
.arow{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}
.arlb{font-size:11px;color:var(--meta)}
.fgap{margin-top:12px}
.calem{font-size:12px;color:var(--meta)}
.at{padding:2px 8px;border:1.5px solid var(--ink);border-radius:4px;font-size:10px;background:#fff}
.badges{display:flex;gap:6px}
.badge{padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700}
.badge.crit{background:var(--coral);color:#fff}
.badge.upd{background:var(--yellow);color:var(--ink);border:1.5px solid var(--ink)}
.empty{padding:60px 20px;text-align:center;color:var(--meta);font-size:14px;background:#fff;border:3px solid var(--ink);border-radius:8px;box-shadow:8px 8px 0 var(--ink)}
.calv{background:#fff;border:3px solid var(--ink);border-radius:8px;box-shadow:8px 8px 0 var(--ink);padding:20px}
.calh{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.calh h3{font-size:18px;font-weight:800}
.caln{display:flex;gap:8px}
.caln a{padding:6px 12px;border:2px solid var(--ink);border-radius:6px;background:#fff;font-weight:700;box-shadow:3px 3px 0 var(--ink);text-decoration:none;font-size:12px}
.caln a:active{transform:translate(3px,3px);box-shadow:0 0 0 var(--ink)}
.cg{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.cdh{text-align:center;font-size:11px;font-weight:700;color:var(--meta);padding:8px 0}
.cd{aspect-ratio:1;border:1.5px solid #e0dcd4;border-radius:4px;padding:4px;font-size:11px;position:relative;overflow:hidden}
.cd.om{opacity:.3}
.cd .dn{font-weight:700;margin-bottom:2px}
.cd .ed{width:6px;height:6px;border-radius:50%;display:inline-block;margin:1px}
.cd .ed.dl{background:var(--coral)}.cd .ed.ev{background:var(--blue)}
.cd.he{border-color:var(--ink)}
.cleg{display:flex;gap:16px;margin-top:12px;font-size:11px;color:var(--meta)}
.cleg span{display:flex;align-items:center;gap:4px}
.cleg .d{width:8px;height:8px;border-radius:50%}
.cleg .d.dl{background:var(--coral)}.cleg .d.ev{background:var(--blue)}
.calev{margin-top:16px;padding-top:16px;border-top:2px dashed #e0dcd4}
.calev h4{font-size:13px;font-weight:700;margin-bottom:8px}
.cei{padding:8px;margin-bottom:6px;border:1.5px solid var(--ink);border-radius:4px;font-size:12px}
.cei .edate{font-weight:700;color:var(--coral)}
.cei a{color:var(--blue);text-decoration:underline;text-underline-offset:2px}
.ebar{margin-top:16px;display:flex;gap:8px;flex-wrap:wrap}
.ebtn{padding:8px 16px;border:2px solid var(--ink);border-radius:6px;background:#fff;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:3px 3px 0 var(--ink);transition:all .15s;text-decoration:none;display:inline-block}
.ebtn:hover{background:#f8f4ee}.ebtn:active{transform:translate(3px,3px);box-shadow:0 0 0 var(--ink)}
.srcbar{margin-top:16px;padding:16px 20px;background:#fff;border:2px solid var(--ink);border-radius:8px;box-shadow:4px 4px 0 var(--ink);font-size:12px;color:var(--meta);line-height:2}
.srcbar a{color:var(--blue);text-decoration:underline;text-underline-offset:2px;font-weight:600}
.srcbar .sep{margin:0 4px;color:#ccc}
.footer{margin-top:24px;padding:16px 20px;text-align:center;font-size:12px;color:var(--meta)}
.footer a{color:var(--blue);text-decoration:underline;text-underline-offset:2px}
.cscr{max-height:120px;overflow-y:auto;padding-right:4px}
.cscr::-webkit-scrollbar{width:4px}.cscr::-webkit-scrollbar-thumb{background:var(--ink);border-radius:2px}
@media(max-width:420px){body{padding:20px 12px}.header{padding:20px}.header h1{font-size:28px}.nc{padding:16px}.nt{font-size:14px}.fb{padding:4px 10px;font-size:11px}.stats{padding:10px 16px;font-size:12px}.fsec{padding:12px 16px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
`;

export interface StandaloneOpts {
  title: string;
  body: string;
}

/** 整页外壳：点阵背景 + 单列容器，样式带 nonce 以通过 CSP。 */
export function archivePage({ title, body }: StandaloneOpts, status = 200): Response {
  const nonce = newNonce();
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex">
<style nonce="${nonce}">${ARCHIVE_CSS}</style></head><body>
${body}
</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      ...securityHeaders(),
      "Content-Security-Policy": csp(nonce, false),
    },
  });
}
