/** 界面层：页面样式。由 layout.ts 以 CSP nonce 内联输出，不引用任何外部资源。 */

export const CSS = `
:root{
  --memphis-background:#FFF4E4;
  --memphis-coral:#FF6B6B;
  --memphis-yellow:#FFD93D;
  --memphis-blue:#4D96FF;
  --memphis-ink:#2E2A33;
  --memphis-pattern:radial-gradient(#2E2A33 1.5px, transparent 1.5px);
  --ease-out:cubic-bezier(.22,.9,.28,1);
  --dur:200ms;
  color-scheme:light;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{
  margin:0;min-height:100vh;padding:28px 16px;
  display:flex;align-items:center;justify-content:center;
  background-color:var(--memphis-background);
  background-image:var(--memphis-pattern);
  background-size:22px 22px;
  color:var(--memphis-ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
}
.card{
  position:relative;width:100%;max-width:520px;
  background:#fff;border:3px solid var(--memphis-ink);border-radius:8px;
  padding:40px 30px 30px;
  box-shadow:8px 8px 0 var(--memphis-ink);
  animation:card-in var(--dur) var(--ease-out) both;
}
@keyframes card-in{from{transform:translate(8px,8px);box-shadow:0 0 0 var(--memphis-ink)}
  to{transform:none;box-shadow:8px 8px 0 var(--memphis-ink)}}
.mark{width:46px;height:46px;border-radius:50%;margin:0 0 22px;
  background:var(--memphis-yellow);border:3px solid var(--memphis-ink);
  box-shadow:4px 4px 0 var(--memphis-blue)}
h1{font-size:26px;margin:0 0 10px;font-weight:800;letter-spacing:-.4px;line-height:1.25}
h1 em{font-style:normal;background:var(--memphis-coral);color:#fff;
  padding:0 6px;border-radius:4px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
p{font-size:14px;line-height:1.75;color:#4a4550;margin:6px 0}
.sub{font-size:13px;color:#6b6572;line-height:1.7}
.count{display:inline-block;margin-top:16px;padding:5px 14px;border-radius:4px;
  border:2px solid var(--memphis-ink);background:var(--memphis-yellow);
  font-size:12px;font-weight:700;color:var(--memphis-ink)}
form{margin-top:24px}
input[type=email]{
  width:100%;padding:14px 16px;font-size:15px;font-family:inherit;
  border:3px solid var(--memphis-ink);border-radius:6px;background:#fff;
  color:var(--memphis-ink);outline:none;
  transition:box-shadow var(--dur) var(--ease-out),background var(--dur) linear;
}
input[type=email]::placeholder{color:#a09a9e}
input[type=email]:focus{background:#FFFDF7;box-shadow:4px 4px 0 var(--memphis-blue)}
button{
  width:100%;margin-top:14px;padding:15px;font-size:15px;font-weight:800;
  font-family:inherit;letter-spacing:.3px;cursor:pointer;
  color:var(--memphis-ink);background:var(--memphis-yellow);
  border:3px solid var(--memphis-ink);border-radius:6px;
  box-shadow:4px 4px 0 var(--memphis-ink);
  transition:transform 120ms var(--ease-out),box-shadow 120ms var(--ease-out),
             background 160ms linear;
}
button:hover{background:#FFE270}
button:active{transform:translate(4px,4px);box-shadow:0 0 0 var(--memphis-ink)}
button:focus-visible{outline:3px solid var(--memphis-blue);outline-offset:3px}
button:disabled{opacity:.6;cursor:not-allowed;transform:none;box-shadow:4px 4px 0 var(--memphis-ink)}
.alert{margin-top:16px;padding:12px 14px;border-radius:6px;font-size:13px;
  line-height:1.6;border:3px solid var(--memphis-ink);
  animation:cut-in 120ms steps(1,end) both}
@keyframes cut-in{from{opacity:0}to{opacity:1}}
.ok{background:var(--memphis-blue);color:#fff}
.err{background:var(--memphis-coral);color:#fff}
.tip{margin-top:24px;padding-top:18px;border-top:2px dashed #d8cfc0;
  font-size:12px;color:#6b6572;line-height:1.8}
a{color:var(--memphis-blue);font-weight:700;text-underline-offset:3px}
.btn-secondary{display:inline-block;margin-top:22px;padding:11px 24px;
  border:3px solid var(--memphis-ink);border-radius:6px;background:#fff;
  color:var(--memphis-ink);font-size:13px;font-weight:800;text-decoration:none;
  box-shadow:4px 4px 0 var(--memphis-ink);
  transition:transform 120ms var(--ease-out),box-shadow 120ms var(--ease-out)}
.btn-secondary:active{transform:translate(4px,4px);box-shadow:0 0 0 var(--memphis-ink)}
.detail{margin-top:16px;background:#FFF4E4;border:2px dashed var(--memphis-ink);
  border-radius:6px;padding:11px 13px;font-size:12px;color:#6b6572;
  line-height:1.7;word-break:break-all}
.who{display:flex;align-items:center;justify-content:space-between;gap:12px;
  margin:18px 0 4px;padding:12px 14px;border:2px solid var(--memphis-ink);
  border-radius:6px;background:#FFF4E4;font-size:13px;font-weight:700;word-break:break-all}
.who a{font-size:12px;font-weight:800;text-decoration:none;color:var(--memphis-ink);
  border:2px solid var(--memphis-ink);border-radius:4px;padding:3px 9px;background:#fff;
  white-space:nowrap}
.who a:active{transform:translate(1px,1px)}
.opts{margin-top:20px;display:grid;gap:12px}
.opt{position:relative;display:block;padding:14px 16px 14px 52px;
  border:3px solid var(--memphis-ink);border-radius:6px;background:#fff;cursor:pointer;
  transition:transform 120ms var(--ease-out),box-shadow 120ms var(--ease-out),
             background 160ms linear}
.opt:hover{background:#FFFDF7}
.opt input{position:absolute;opacity:0;width:0;height:0}
.opt .box{position:absolute;left:15px;top:50%;transform:translateY(-50%);
  width:22px;height:22px;border:3px solid var(--memphis-ink);border-radius:4px;
  background:#fff;transition:background 120ms steps(1,end)}
.opt .box::after{content:"";position:absolute;left:5px;top:1px;width:6px;height:12px;
  border:solid var(--memphis-ink);border-width:0 3px 3px 0;transform:rotate(45deg);
  opacity:0;transition:opacity 120ms steps(1,end)}
.opt input:checked~.box{background:var(--memphis-yellow)}
.opt input:checked~.box::after{opacity:1}
.opt input:focus-visible~.box{outline:3px solid var(--memphis-blue);outline-offset:3px}
.opt .name{font-size:14px;font-weight:800;display:flex;align-items:center;gap:8px}
.opt .dot{width:10px;height:10px;border-radius:50%;border:2px solid var(--memphis-ink);flex:none}
.opt .desc{font-size:12px;color:#6b6572;margin-top:3px;line-height:1.6}
.opt.is-on{box-shadow:4px 4px 0 var(--memphis-ink)}
.danger{margin-top:28px;padding-top:20px;border-top:2px dashed #d8cfc0}
.danger h2{font-size:13px;margin:0 0 6px;font-weight:800;color:var(--memphis-coral);
  letter-spacing:.3px}
.danger p{margin:0;font-size:12px;color:#6b6572;line-height:1.7}
.btn-danger{width:auto;margin-top:12px;padding:10px 20px;font-size:13px;
  background:#fff;color:var(--memphis-coral);box-shadow:4px 4px 0 var(--memphis-coral)}
.btn-danger:hover{background:#FFF0F0}
.btn-danger:active{transform:translate(4px,4px);box-shadow:0 0 0 var(--memphis-coral)}
.section{margin-top:26px;padding-top:18px;border-top:2px dashed #d8cfc0}
.section h2{font-size:13px;margin:0 0 8px;font-weight:800;letter-spacing:.3px}
.row-actions{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}
.btn-mini{width:auto;margin:0;padding:7px 13px;font-size:12px;font-weight:800;
  background:#fff;color:var(--memphis-ink);border:2px solid var(--memphis-ink);
  border-radius:5px;box-shadow:3px 3px 0 var(--memphis-ink)}
.btn-mini:hover{background:#FFFDF7}
.btn-mini:active{transform:translate(3px,3px);box-shadow:0 0 0 var(--memphis-ink)}
.contest-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.opt.compact{padding-bottom:12px}
.opt.mini{padding:9px 10px 9px 38px;border-width:2px}
.opt.mini .box{left:11px;width:18px;height:18px;border-width:2px}
.opt.mini .box::after{left:4px;top:1px;width:5px;height:9px;border-width:0 2px 2px 0}
.opt.mini .name{font-size:12px;line-height:1.45;font-weight:700}
.opt.mini.is-on{box-shadow:3px 3px 0 var(--memphis-ink)}
.field{width:100%;box-sizing:border-box;padding:10px 12px;font-size:13px;color:var(--memphis-ink);
  background:#fff;border:3px solid var(--memphis-ink);border-radius:6px;outline:none}
.field:focus-visible{outline:3px solid var(--memphis-blue);outline-offset:2px}
select.field{appearance:none;background-image:none;cursor:pointer}
@media (prefers-reduced-motion:reduce){
  *{animation:none!important;transition:none!important}
}
@media (max-width:420px){
  .card{padding:34px 22px 26px;box-shadow:6px 6px 0 var(--memphis-ink)}
  h1{font-size:22px}
  .contest-grid{grid-template-columns:1fr}
}
`;
