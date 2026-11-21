import { esc } from "../platform/security";

export type WorkspaceSection = "overview" | "groups" | "subscribed" | "directory" | "settings";
export interface Workspace { active: WorkspaceSection; email: string }

export function workspaceShell(workspace: Workspace, heading: string, body: string): string {
  const links: [WorkspaceSection, string, string][] = [
    ["overview", "/skills", "工作台"], ["groups", "/groups?view=mine", "我的网站组"],
    ["subscribed", "/groups?view=subscribed", "我的订阅"], ["directory", "/groups?view=directory", "发现通知组"],
    ["settings", "/skills/yds", "研电赛设置"],
  ];
  return `<a class="skip-link" href="#workspace-content">跳到主要内容</a>
    <div class="workspace-shell"><aside class="workspace-sidebar">
      <a class="workspace-brand" href="/skills"><span class="brand-symbol" aria-hidden="true">M</span><span>MeoNotifier<small>通知工作台</small></span></a>
      <nav aria-label="主要导航">${links.map(([key, href, label]) => `<a href="${esc(href)}"${workspace.active === key ? ' aria-current="page"' : ""}>${esc(label)}</a>`).join("")}</nav>
      <div class="sidebar-help"><a href="/archive">查看通知归档</a><p>汇总你关心的网站更新，按设定的频率送到邮箱。</p></div>
    </aside><div class="workspace-main"><header class="workspace-topbar"><span>通知中心</span><div class="account-actions"><span class="account-email">${esc(workspace.email)}</span><button type="button" class="logout-button" id="workspace-logout">退出登录</button></div></header><p id="workspace-message" class="workspace-message" role="status"></p>
      <main id="workspace-content" tabindex="-1"><h1>${heading}</h1>${body}</main>
    </div></div><dialog id="discard-dialog" aria-labelledby="discard-title" aria-describedby="discard-description"><h2 id="discard-title">有未保存的修改</h2><p id="discard-description">继续操作会丢失其他位置尚未保存的修改。</p><form method="dialog"><button type="submit" value="cancel" autofocus>继续编辑</button><button type="submit" value="discard" class="button-danger">放弃修改并继续</button></form></dialog>`;
}

export const WORKSPACE_SCRIPT = `
(function () {
  var forms = Array.from(document.querySelectorAll('form[data-guard]'));
  var dirty = new Set();
  var submitted = false;
  var approvedForm = null;
  var discardDialog = document.getElementById('discard-dialog');
  function confirmDiscard() {
    if (!discardDialog || discardDialog.open) return Promise.resolve(false);
    discardDialog.returnValue = '';
    discardDialog.showModal();
    return new Promise(function (resolve) {
      discardDialog.addEventListener('close', function () {
        var discard = discardDialog.returnValue === 'discard';
        discardDialog.returnValue = '';
        resolve(discard);
      }, { once: true });
    });
  }
  forms.forEach(function (form) {
    var original = new URLSearchParams(new FormData(form)).toString();
    var notice = form.querySelector('[data-form-state]');
    function changed() {
      var edited = new URLSearchParams(new FormData(form)).toString() !== original;
      if (edited) dirty.add(form); else dirty.delete(form);
      if (notice) notice.textContent = edited ? '有未保存的修改' : '';
    }
    form.addEventListener('input', changed);
    form.addEventListener('change', changed);
  });
  document.querySelectorAll('form[method="post"]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      if (submitted) { event.preventDefault(); return; }
      if (approvedForm !== form && Array.from(dirty).some(function (other) { return other !== form; })) {
        event.preventDefault();
        var submitter = event.submitter;
        confirmDiscard().then(function (discard) {
          if (discard) { approvedForm = form; form.requestSubmit(submitter || undefined); }
        });
        return;
      }
      approvedForm = null;
      submitted = true;
      var button = event.submitter || form.querySelector('button[type="submit"]');
      if (button) { button.disabled = true; button.textContent = '正在处理…'; }
    });
  });
  document.addEventListener('click', function (event) {
    var link = event.target.closest('a[href]');
    if (!link || !dirty.size || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || link.target === '_blank') return;
    var destination = new URL(link.href, window.location.href);
    if (destination.origin !== window.location.origin || destination.pathname === window.location.pathname && destination.search === window.location.search) return;
    event.preventDefault();
    confirmDiscard().then(function (discard) {
      if (discard) { submitted = true; window.location.href = destination.href; }
    });
  });
  var logout = document.getElementById('workspace-logout');
  if (logout) logout.addEventListener('click', async function () {
    var preferences = document.getElementById('applybar');
    if ((dirty.size || preferences && preferences.classList.contains('on')) && !await confirmDiscard()) return;
    logout.disabled = true;
    fetch('/api/logout', { method: 'POST' }).then(function (response) {
      if (!response.ok) throw new Error('logout failed');
      submitted = true;
      window.location.href = '/';
    }).catch(function () {
      logout.disabled = false;
      document.getElementById('workspace-message').textContent = '退出失败，请稍后重试。';
    });
  });
  window.addEventListener('beforeunload', function (event) {
    if (!submitted && dirty.size) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) window.location.reload();
  });
})();`;
