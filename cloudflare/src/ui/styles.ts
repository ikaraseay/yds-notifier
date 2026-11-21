/** Original Memphis palette and surfaces, with the current responsive workspace layout. */
export const CSS = `
:root{color-scheme:light;--memphis-background:#FFF4E4;--memphis-coral:#FF6B6B;--memphis-yellow:#FFD93D;--memphis-blue:#4D96FF;--memphis-ink:#2E2A33;--ink:var(--memphis-ink);--muted:#6b6572;--line:#d8cfc0;--surface:#fff;--canvas:var(--memphis-background);--blue:var(--memphis-blue);--blue-soft:#eef5ff;--yellow:var(--memphis-yellow);--coral:var(--memphis-coral);--link:#285887;--focus:#235dcc;--danger:#a52c3c;--hard-shadow:4px 4px 0 var(--ink)}
*{box-sizing:border-box}
html{scroll-padding-top:24px}
body{margin:0;min-height:100vh;padding:48px 20px;background-color:var(--canvas);background-image:radial-gradient(var(--ink) 1.5px,transparent 1.5px);background-size:22px 22px;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.6}
h1,h2,h3,p{overflow-wrap:anywhere}
h1{font-size:28px;line-height:1.3;font-weight:800;margin:0 0 12px;letter-spacing:-.4px}
h1 em{font-style:normal;background:var(--coral);color:var(--ink);padding:0 6px;border-radius:4px}
h2{font-size:18px;line-height:1.5;margin:0 0 10px;font-weight:650}
h3{font-size:16px;margin:0 0 6px;font-weight:650}
p{font-size:14px;line-height:1.7;color:var(--muted);margin:6px 0 12px}
small,.sub{font-size:13px;color:var(--muted)}a{color:var(--link);text-underline-offset:3px}a:hover{color:#154594}
:where(a,button,input,textarea,select,summary):focus-visible{outline:3px solid var(--focus);outline-offset:3px}
button,.button,.btn-mini,.btn-secondary{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:42px;width:auto;padding:9px 15px;border:2px solid var(--ink);box-shadow:3px 3px 0 var(--ink);border-radius:6px;background:#fff;color:var(--ink);font:inherit;font-size:14px;font-weight:750;line-height:1.4;text-decoration:none;cursor:pointer;white-space:normal;vertical-align:middle}
button:hover,.button:hover,.btn-mini:hover,.btn-secondary:hover{background:#fff9ea;color:var(--ink);border-color:var(--ink)}
button:disabled{opacity:.65;cursor:wait}
button:active,.button:active,.btn-mini:active,.btn-secondary:active{transform:translate(2px,2px);box-shadow:1px 1px 0 var(--ink)}
.button-primary,button[type=submit]:not(.btn-mini){background:var(--yellow);color:var(--ink);border-color:var(--ink)}
.button-primary:hover,button[type=submit]:not(.btn-mini):hover{background:#ffe270;color:var(--ink);border-color:var(--ink)}
.button-danger,.btn-danger{color:var(--danger);border-color:var(--ink);background:#fff;box-shadow:3px 3px 0 var(--danger)}
.button-danger:hover,.btn-danger:hover{color:#94182b;background:#fff0f2}
form{margin:16px 0 0}label{display:block;font-size:14px;font-weight:550;margin:0 0 6px}
.field,input[type=email]{display:block;width:100%;min-height:44px;padding:10px 12px;border:2px solid var(--ink);border-radius:6px;color:var(--ink);background:#fff;font:inherit;font-size:max(1rem,1em);line-height:1.5;margin:6px 0 14px}
textarea.field{resize:vertical}
select.field{appearance:auto;cursor:pointer}
.field:read-only{background:#f7f9fc}
input[type=checkbox],input[type=radio]{accent-color:var(--blue);width:18px;height:18px;flex:none}
.field:user-invalid,input[type=email]:user-invalid{border-color:var(--danger)}
summary{cursor:pointer;font-size:14px;font-weight:600;min-height:32px;line-height:1.7}
details[open]>summary{margin-bottom:12px}
details>form{margin-top:10px}[hidden]{display:none!important}
.card{width:100%;max-width:500px;margin:5vh auto 0;padding:32px;border:3px solid var(--ink);border-radius:8px;background:#fff;box-shadow:8px 8px 0 var(--ink)}
.card--wide{max-width:1080px}
.mark{height:46px;width:46px;background:var(--yellow);border:3px solid var(--ink);border-radius:50%;box-shadow:4px 4px 0 var(--blue);margin-bottom:24px}
.count{display:inline-block;font-size:13px;background:var(--yellow);color:var(--ink);padding:5px 10px;border:2px solid var(--ink);border-radius:4px;margin:8px 0}
.count-inline{font-size:14px;color:var(--muted);font-weight:400;margin-left:6px}
.tip{font-size:13px;color:var(--muted);border-top:1px solid var(--line);padding-top:16px;margin-top:24px;line-height:1.8}
.tip--tight{margin-top:12px}
.detail{padding:12px;background:#f6f8fc;border:1px solid var(--line);border-radius:6px;overflow-wrap:anywhere;font-size:13px}
.alert,.admin-feedback{font-size:14px;padding:12px 16px;border-radius:6px;margin:16px 0;background:var(--blue-soft);border:2px solid var(--ink);border-left:6px solid var(--blue);color:var(--ink)}
.alert:empty{display:none}
.ok{background:#edf8f2;color:#176244;border-color:#b7dfc9}
.err,.notice-warning{background:#fff4ef;color:#87391c;border-color:#f0c5b1}
.hint{margin-top:0}
.btn-gap{margin-top:8px}
.section,.work-section{margin-top:24px;padding-top:20px;border-top:1px solid var(--line)}
.section--first{border-top:0;margin-top:20px}
.section h2{font-size:17px}
.who{display:flex;gap:12px;align-items:center;justify-content:space-between;font-size:13px;margin:16px 0;padding:12px;background:#f5f7fb;border-radius:6px;overflow-wrap:anywhere}
dialog{max-width:min(460px,calc(100vw - 32px));padding:24px;border:3px solid var(--ink);border-radius:8px;color:var(--ink);box-shadow:8px 8px 0 var(--ink)}
dialog form{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px}dialog:modal{overscroll-behavior:contain}dialog::backdrop{background:#14263866;overflow:hidden;overscroll-behavior:contain}
.workspace-body{padding:0}
.workspace-shell{display:grid;grid-template-columns:216px minmax(0,1fr);min-height:calc(100vh - 100px)}
.workspace-sidebar{position:sticky;top:0;height:100vh;align-self:start;display:flex;flex-direction:column;gap:30px;padding:28px 18px;background:#fff;border-right:3px solid var(--ink)}
.workspace-brand{display:flex;gap:10px;align-items:center;text-decoration:none;color:var(--ink);font-size:17px;font-weight:700}
.workspace-brand small{display:block;font-size:12px;font-weight:400;margin-top:2px}
.brand-symbol{display:grid;place-items:center;width:34px;height:34px;border-radius:8px;background:var(--yellow);color:var(--ink);border:2px solid var(--ink);box-shadow:3px 3px 0 var(--blue);font-size:19px}
.workspace-sidebar nav{display:grid;gap:6px}
.workspace-sidebar nav a{padding:11px 14px;border-radius:6px;color:var(--muted);text-decoration:none;font-size:14px;border:1px solid transparent}
.workspace-sidebar nav a:hover{background:#f6f8fb}
.workspace-sidebar nav a[aria-current=page]{color:var(--ink);background:var(--yellow);border:2px solid var(--ink);padding-inline-start:13px;box-shadow:3px 3px 0 var(--ink);font-weight:750}
.sidebar-help{margin-top:auto;padding:18px 10px 0;border-top:1px solid var(--line)}
.sidebar-help p{font-size:12px;margin-top:10px}
.sidebar-help a{font-size:13px}
.workspace-main{min-width:0}
.workspace-topbar{height:52px;display:flex;justify-content:space-between;gap:12px;align-items:center;padding:0 36px;background:var(--canvas);border-bottom:2px solid var(--ink);font-size:14px;color:var(--muted)}
.account-actions{display:flex;align-items:center;gap:16px;min-width:0}
.logout-button{box-shadow:none;border:1px solid var(--ink);padding:4px 8px;min-height:36px;font-size:13px;color:var(--muted)}
.workspace-message{margin:0 24px}.workspace-message:empty{display:none}
.account-email{overflow-wrap:anywhere;font-size:13px}
.workspace-main>main{max-width:1200px;margin:0 auto;padding:24px 36px 40px}
.workspace-main>main:focus{outline:none}
.workspace-main>main>h1{display:table;padding:6px 12px;background:var(--yellow);border:3px solid var(--ink);border-radius:6px;box-shadow:4px 4px 0 var(--coral);margin-bottom:20px}
.skip-link{position:fixed;left:12px;top:-100px;z-index:20;padding:12px;background:#fff;border:2px solid var(--blue);border-radius:6px}
.skip-link:focus{top:12px}
.sr-only{position:absolute;clip-path:inset(50%);width:1px;height:1px;overflow:hidden;white-space:nowrap}
.page-intro{display:flex;gap:20px;align-items:center;justify-content:space-between;margin:0 0 28px}
.page-intro p{margin:0}
.page-intro .button{flex:none}
.overview-section{margin:28px 0 0;scroll-margin-top:24px}
.overview-section>p{max-width:68ch}
.attention-banner{display:flex;gap:20px;align-items:center;justify-content:space-between;padding:16px 20px;background:#fff5cf;border:2px solid var(--ink);border-left:6px solid var(--coral);box-shadow:3px 3px 0 var(--ink);border-radius:6px}
.attention-banner h2{font-size:15px;margin-bottom:3px}
.attention-banner p{margin:0;font-size:13px;color:#715726}
.attention-banner>a{white-space:nowrap}
.monitor-list{display:grid;gap:0;border:3px solid var(--ink);background:#fff;box-shadow:var(--hard-shadow);border-radius:8px;margin-top:16px;overflow:hidden}
.monitor-row{display:flex;align-items:center;justify-content:space-between;gap:20px;min-width:0;padding:20px;background:#fff;border:2px solid var(--ink);border-radius:8px;box-shadow:var(--hard-shadow)}
.monitor-list .monitor-row{border:0;border-radius:0;box-shadow:none}
.monitor-list .monitor-row+.monitor-row{border-top:1px solid var(--line)}
.monitor-info{min-width:0}
.monitor-info h3{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.monitor-info h3>a{color:var(--ink);text-decoration:none}
.monitor-info h3>a:hover{text-decoration:underline}
.monitor-info p{margin:5px 0}
.monitor-info small{font-size:12px}
.monitor-row>.work-actions{margin:0;flex-shrink:0}
.filter-form{display:flex;align-items:flex-end;flex-wrap:wrap;gap:12px;margin-top:16px}
.filter-form>div:first-child{flex:1 1 240px}
.filter-form>div:nth-child(2){flex:0 1 170px}
.filter-form .field{margin:0}
.filter-form label{font-size:13px}
.filter-form>a{align-self:center;margin-top:24px;font-size:13px}
.template-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:16px}
.template-item{padding:20px;background:#fff;border:2px solid var(--ink);border-radius:8px;box-shadow:var(--hard-shadow)}
.template-item p{font-size:13px}
.template-create{border-top:1px solid var(--line);margin-top:16px;padding-top:14px}
.template-create summary{color:var(--link)}
.empty-state{padding:28px 20px;text-align:center}
.empty-state p{margin-bottom:10px}
.work-area{min-width:0}
.work-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px}
.work-heading h2,.work-heading h3{margin:0}
.work-heading>form{margin:0}
.work-heading p{margin:3px 0}
.work-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 24px;padding:6px;border:2px solid var(--ink);border-radius:6px;background:var(--canvas)}
.work-tabs a{padding:10px 14px;color:var(--muted);text-decoration:none;border:2px solid transparent;border-radius:4px;font-size:14px}
.work-tabs a[aria-current=page]{color:var(--ink);border-color:var(--ink);background:var(--yellow);font-weight:750}
.work-tabs a:hover{background:#eaf0fa;border-radius:4px}
.skill-heading{margin-bottom:20px}
.breadcrumb{font-size:13px;margin:0 0 12px}
.skill-heading .work-heading>p{max-width:64ch}
.section-nav{margin:16px 0 0}
.group-summary{padding:18px 20px;display:flex;align-items:center;justify-content:space-between;gap:20px;background:#fff;border:2px solid var(--ink);border-radius:8px;box-shadow:var(--hard-shadow);margin-bottom:24px}
.group-summary p{color:var(--ink);margin:8px 0 4px}
.group-summary .work-actions{margin:0}
.settings-grid{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:24px;align-items:start}
.settings-primary,.settings-secondary{min-width:0;display:grid;gap:20px}
.settings-panel{padding:20px;border:2px solid var(--ink);border-radius:8px;background:#fff;box-shadow:var(--hard-shadow);scroll-margin-top:24px;min-width:0}
.settings-panel>h2{font-size:16px}
.settings-panel .sub{font-size:12px}
.settings-panel form{margin-top:14px}
.settings-panel form>button{margin-top:4px}
.settings-panel .work-heading{align-items:start}
.settings-panel .work-heading form{margin:0}
.delivery-email{color:var(--ink);font-weight:550;overflow-wrap:anywhere}
.settings-secondary textarea{min-height:130px}
.settings-secondary .settings-panel>summary{font-weight:550}
.settings-secondary label{font-size:13px;margin-top:12px}
.source-list{margin-top:20px}
.source-item{padding:16px 0;border-top:1px solid var(--line)}
.source-item:first-child{border-top:0;padding-top:0}
.source-top{display:flex;align-items:flex-start;gap:10px;justify-content:space-between}
.source-url{font-size:13px;overflow-wrap:anywhere;word-break:break-word}
.source-top .source-url{min-width:0;flex:1}
.source-item>p{margin:8px 0 4px;font-size:13px}
.source-item>small{font-size:12px}
.source-error{color:var(--danger)}
.source-tools{display:flex;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-top:10px}
.source-tools>form{margin:0}
.source-tools .btn-mini{min-height:34px;padding:6px 10px;font-size:12px}
.source-editor{flex:1 1 180px;padding-top:3px;min-width:0}
.source-editor summary{color:var(--link);font-size:13px;font-weight:550}
.source-editor[open]{flex-basis:100%}
.source-editor-body{background:#fff9ee;padding:14px;border:1px solid var(--line);border-radius:6px;margin-top:8px}
.source-editor-body form{margin:0}
.source-remove{margin-top:14px;padding-top:10px;border-top:1px solid var(--line)}
.source-remove>summary{color:var(--danger)}
.source-add{border-top:1px solid var(--line);padding-top:16px;margin-top:8px}
.source-add>summary{color:var(--link)}
.form-state{display:block;font-size:12px;color:#875a08;min-height:20px;margin:4px 0}
.form-state:empty{display:none}
.work-list{display:grid;gap:12px;margin-top:16px}
.work-panel,.work-row,.work-create,.work-source{padding:18px;border:2px solid var(--ink);border-radius:8px;background:#fff;box-shadow:var(--hard-shadow);min-width:0;overflow-wrap:anywhere}
.work-row{display:flex;align-items:center;justify-content:space-between;gap:16px;color:var(--ink);text-decoration:none}
.work-row small{display:block;margin-top:4px}
.work-row:hover{border-color:#a1b9dd}
.work-status{display:inline-block;flex:none;border-radius:4px;padding:3px 8px;background:#f0ece7;color:#46404a;border:1px solid var(--ink);font-size:12px;font-weight:700;line-height:1.6}
.work-status--ready{background:#eaf6ef;color:#176244}
.work-status--blocked,.work-status--error{background:#fff0f1;color:#a02738}
.work-status--waiting{background:#fff4d9;color:#785513}
.work-status--paused{background:#eef1f5;color:#526176}
.work-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px}
.work-actions>form{margin:0}
.work-check{display:flex;align-items:flex-start;gap:8px;font-weight:400;font-size:13px}
.work-check input{margin-top:3px}
.work-sample{margin-top:12px}
.work-sample p,.work-prompt{padding:12px;background:#f7f4ef;border-radius:6px;white-space:pre-wrap;max-height:220px;overflow:auto}
.work-review-sources{padding:0;list-style:none;margin:0}
.work-review-sources li{padding:12px 0;border-top:1px solid var(--line)}
.work-urls{padding-left:20px;font-size:13px;overflow-wrap:anywhere}
.opts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:14px}
.opt{position:relative;display:block;cursor:pointer;padding:14px 14px 14px 44px;border:2px solid var(--ink);border-radius:6px;margin:0;background:#fff}
.opt:hover{background:#fffdf7}
.opt input{position:absolute;left:14px;top:16px;margin:0;opacity:1;width:18px;height:18px}
.opt .box,.opt .dot{display:none}
.opt .name{font-size:14px;font-weight:550;display:block}
.opt .desc{display:block;font-size:12px;font-weight:400;color:var(--muted);margin-top:3px}
.opt.is-on{border-color:var(--ink);background:#fff9df;box-shadow:3px 3px 0 var(--ink)}
.opt[hidden]{display:none}
.contest-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.contest-grid .opt{padding:12px 10px 12px 38px}
.contest-grid .opt input{left:12px;top:14px}
.contest-grid .name{font-size:13px}
.row-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.applybar{display:none}
.applybar.on{position:sticky;bottom:16px;z-index:5;display:flex;align-items:center;gap:12px;padding:14px 18px;background:#fff9e6;border:2px solid var(--ink);border-radius:6px;box-shadow:var(--hard-shadow);margin-top:16px}
.applybar span{flex:1;font-size:13px}
.applybar button{flex:none}
.danger{margin-top:20px;padding-top:16px;border-top:1px solid #eccbd1}
.danger h2,.danger>summary{color:var(--danger)}
.danger p{font-size:13px}
.btn-danger{margin-top:12px}
.unsub-form{margin-top:20px}
.unsub-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.unsub-label{margin-bottom:10px}
.wechat-service img{display:block;margin-top:12px}
.admin-shell{display:grid;grid-template-columns:170px minmax(0,1fr);gap:24px;margin-top:24px}
.admin-sidebar{border-right:1px solid var(--line);padding-right:16px}
.admin-sidebar nav{display:grid;gap:6px;margin-bottom:16px}
.admin-sidebar nav a{display:block;padding:10px;text-decoration:none;color:var(--muted);border-radius:6px}
.admin-sidebar nav a[aria-current=page]{background:var(--yellow);color:var(--ink)}
.admin-sidebar form{margin:0}
.admin-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:2px solid var(--ink);border-radius:6px;margin:0 0 20px;background:var(--canvas);box-shadow:4px 4px 0 var(--blue)}
.admin-metrics div{padding:14px}
.admin-metrics div+div{border-left:1px solid var(--line)}
.admin-metrics dt{font-size:13px;color:var(--muted)}
.admin-metrics dd{font-size:26px;font-weight:650;margin:6px 0 0}
.admin-section{border-top:1px solid var(--line);margin-top:24px;padding-top:18px}
.admin-search div{display:flex;gap:10px;align-items:center}
.admin-search .field{margin:0}
.admin-table{overflow:auto;border:2px solid var(--ink);border-radius:6px;margin-top:16px}
.admin-table table{border-collapse:collapse;width:100%;font-size:13px;text-align:left}
.admin-table th,.admin-table td{padding:12px;border-bottom:1px solid var(--line)}
.admin-table th{background:var(--canvas)}
.admin-table th:not(:first-child),.admin-table td{white-space:nowrap}
.admin-table form{display:flex;gap:8px;align-items:center;margin:0}
.admin-confirm{display:flex;align-items:center;gap:6px}
.admin-pagination{display:flex;gap:16px;margin-top:16px}
.foot{max-width:800px;margin:28px auto 0;text-align:center;padding:0 20px;font-size:12px;color:var(--muted)}
.foot p{font-size:11px;margin:4px 0}
.foot-links{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.foot-links a{color:var(--muted)}
.workspace-body>.foot{margin:12px 24px 24px 240px;max-width:none}
@media(max-width:1100px){.settings-grid{grid-template-columns:minmax(0,1fr)}
.settings-secondary{grid-template-columns:repeat(2,minmax(0,1fr))}
.settings-secondary>.settings-panel:first-child{grid-column:1/-1}
.monitor-row{align-items:flex-start;flex-wrap:wrap}
.monitor-row>.work-actions{flex-shrink:1}
.contest-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:760px){body{padding:24px 14px}
.workspace-body{padding:0}
.workspace-shell{display:block;min-height:0}
.workspace-sidebar{position:static;height:auto;padding:16px;gap:16px;border-right:0;border-bottom:1px solid var(--line)}
.workspace-sidebar nav{display:flex;flex-wrap:wrap;gap:4px}
.workspace-sidebar nav a{padding:9px 12px;font-size:13px;min-height:40px}
.sidebar-help{display:none}
.workspace-topbar{height:auto;min-height:48px;padding:10px 18px}
.workspace-main>main{padding:24px 16px 36px}
.workspace-body>.foot{margin:8px 12px 24px}
.page-intro{align-items:flex-start;gap:12px}
.page-intro .button{font-size:13px}
.settings-grid{gap:16px}
.settings-secondary{grid-template-columns:minmax(0,1fr)}
.settings-panel{padding:16px}
.settings-panel .work-heading{flex-wrap:wrap}
.group-summary{align-items:flex-start;flex-wrap:wrap;padding:16px}
.attention-banner{align-items:flex-start;flex-wrap:wrap;gap:10px;padding:14px 16px}
.template-grid{grid-template-columns:minmax(0,1fr)}
.filter-form>div:nth-child(2){flex:1 1 120px}
.filter-form>button{min-width:70px}
.source-top{flex-wrap:wrap}
.source-top .source-url{flex-basis:100%}
.work-heading{flex-wrap:wrap}
.work-tabs a{padding:9px 10px}
.admin-shell{grid-template-columns:minmax(0,1fr)}
.admin-sidebar{border-right:0;border-bottom:1px solid var(--line);padding:0 0 12px}
.admin-sidebar nav{display:flex;flex-wrap:wrap}
.admin-metrics div{padding:10px}
.card{margin:12px auto 0;padding:24px}
.opts,.contest-grid{grid-template-columns:minmax(0,1fr)}
.applybar.on{bottom:8px;flex-wrap:wrap}
.applybar span{flex-basis:180px}
h1{font-size:25px}}
@media(pointer:coarse){button,.button,.btn-mini,.btn-secondary,.source-tools .btn-mini{min-height:48px}
summary{min-height:44px;padding-block:6px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
@media(forced-colors:active){:root{--ink:CanvasText;--muted:CanvasText;--line:CanvasText;--canvas:Canvas;--surface:Canvas;--link:LinkText;--focus:Highlight;--danger:CanvasText;--blue:Highlight;--yellow:Canvas;--coral:CanvasText}.workspace-sidebar nav a[aria-current=page]{outline:2px solid Highlight}
.work-status{border:1px solid currentColor}}
`;
