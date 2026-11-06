/**
 * 界面层：前端脚本（纯 JS 片段，不含 <script> 标签）。
 * layout.ts 会为每个脚本加上一次性 CSP nonce，因此不能用外部脚本或 eval。
 */

/** 登录表单：提交邮箱 → 发魔法链接 */
export const LOGIN_SCRIPT = `
(function () {
  var f = document.getElementById('f');
  var btn = document.getElementById('btn');
  var msg = document.getElementById('msg');
  if (!f) return;

  function feedback(kind, text) {
    msg.className = '';
    msg.textContent = '';
    void msg.offsetWidth;
    msg.className = 'alert ' + kind;
    msg.textContent = text;
  }

  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = document.getElementById('email').value.trim();
    if (!email) { feedback('err', '请先填写邮箱地址'); return; }

    btn.disabled = true;
    btn.textContent = '发送中';
    msg.className = '';
    msg.textContent = '';

    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email })
    }).then(function (r) { return r.json(); }).then(function (d) {
      feedback(d.ok ? 'ok' : 'err', d.message || (d.ok ? '登录邮件已发出' : '提交失败，请稍后再试'));
      if (d.ok) { btn.textContent = '已发送'; return; }
      btn.textContent = '进入控制台';
    }).catch(function () {
      feedback('err', '网络出现问题，请稍后再试');
      btn.textContent = '进入控制台';
    }).then(function () {
      if (btn.textContent === '进入控制台') btn.disabled = false;
    });
  });
})();
`;

/** 控制台：角色 / 赛事 / 栏目 / 频率 / 暂停即时保存，确认邮件重发，退出与注销 */
export const PREFS_SCRIPT = `
(function () {
  var settings = document.getElementById('settings');
  var msg = document.getElementById('msg');
  if (!settings || !msg) return;
  var freq = document.getElementById('frequency');
  var pause = document.getElementById('pausedUntil');
  var catBoxes = settings.querySelectorAll('#opts input[type=checkbox]');
  var audBoxes = settings.querySelectorAll('#aud-opts input[type=checkbox]');
  var contestBoxes = settings.querySelectorAll('#contest-opts input[type=checkbox]');

  function feedback(kind, text) {
    msg.className = '';
    msg.textContent = '';
    void msg.offsetWidth;
    msg.className = 'alert ' + kind;
    msg.textContent = text;
  }
  function syncLabel(el) {
    var label = el.closest('.opt');
    if (label) label.classList.toggle('is-on', el.checked);
  }
  function collect() {
    var out = {};
    catBoxes.forEach(function (el) {
      out[el.name] = el.checked;
      syncLabel(el);
    });
    var aud = {};
    audBoxes.forEach(function (el) {
      aud[el.dataset.aud] = el.checked;
      syncLabel(el);
    });
    out.audiences = aud;
    out.contests = Array.prototype.filter.call(contestBoxes, function (el) {
      return el.checked;
    }).map(function (el) {
      return el.value;
    });
    if (freq) out.frequency = freq.value;
    if (pause) out.pausedUntil = pause.value || '';
    return out;
  }
  // 保存策略：改动先落在本机（localStorage），经过 delay（默认 5 分钟）才真正写 KV。
  // 原因：每次保存 = 2 写 + 1 删，免费额度 1000 写/1000 删每天，且与 /api/notices 发布共用；
  // 勾 20 项赛事若逐次保存就是 40 写 20 删，几下就能把当天的发布额度挤掉。
  // 抖动窗口内的所有改动合并成一次提交，想立刻生效可以点「立即生效」。
  var delay = 300000;
  try { delay = parseInt(settings.getAttribute('data-apply-delay') || '', 10) || 300000; } catch (e) {}
  var email = settings.getAttribute('data-email') || 'anon';
  var storeKey = 'yds:pendingPrefs:' + email;
  var timer = null;
  var stagedAt = 0;
  var bar = document.getElementById('applybar');
  var barText = document.getElementById('applytext');

  function minutes() {
    var m = Math.round(delay / 60000);
    return m > 0 ? m : 1;
  }
  function showBar(text) {
    if (!bar) return;
    if (barText) barText.textContent = text;
    bar.className = 'applybar on';
  }
  function hideBar() {
    if (bar) bar.className = 'applybar';
  }

  function applyPayload(p) {
    if (!p || typeof p !== 'object') return;
    catBoxes.forEach(function (el) {
      if (typeof p[el.name] === 'boolean') { el.checked = p[el.name]; syncLabel(el); }
    });
    if (p.audiences && typeof p.audiences === 'object') {
      audBoxes.forEach(function (el) {
        var k = el.dataset.aud;
        if (k && typeof p.audiences[k] === 'boolean') { el.checked = p.audiences[k]; syncLabel(el); }
      });
    }
    if (Array.isArray(p.contests)) {
      var on = {};
      p.contests.forEach(function (v) { on[v] = true; });
      contestBoxes.forEach(function (el) { el.checked = !!on[el.value]; syncLabel(el); });
    }
    if (freq && p.frequency) freq.value = p.frequency;
    if (pause && typeof p.pausedUntil === 'string') pause.value = p.pausedUntil;
  }

  function stash() {
    stagedAt = Date.now();
    try {
      localStorage.setItem(storeKey, JSON.stringify({ at: stagedAt, body: JSON.stringify(collect()) }));
    } catch (e) {}
    showBar('改动已记录，' + minutes() + ' 分钟后自动保存');
    schedule();
  }

  function clearStash() {
    stagedAt = 0;
    if (timer) { clearTimeout(timer); timer = null; }
    try { localStorage.removeItem(storeKey); } catch (e) {}
    hideBar();
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    var wait = Math.max(0, delay - (Date.now() - stagedAt));
    timer = setTimeout(commit, wait);
  }

  function commit() {
    if (timer) { clearTimeout(timer); timer = null; }
    var payload = JSON.stringify(collect());
    fetch('/api/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) { clearStash(); feedback('ok', '设置已生效，下一次推送按新设置发送'); return; }
      if (d.login) { feedback('err', '登录已过期，请重新进入'); return; }
      // 失败时保留暂存并重试；服务端幂等，重复提交不会产生额外写入
      showBar(d.message || '保存失败，稍后自动重试');
      stagedAt = Date.now();
      schedule();
    }).catch(function () {
      showBar('网络异常，稍后自动重试');
      stagedAt = Date.now();
      schedule();
    });
  }

  settings.addEventListener('change', stash);
  if (freq) freq.addEventListener('change', stash);
  if (pause) pause.addEventListener('change', stash);

  var applyNow = document.getElementById('applyNow');
  if (applyNow) applyNow.addEventListener('click', function () { commit(); });

  // 关闭 / 刷新页面：用 beacon 把暂存提交掉，避免改动只留在本机
  window.addEventListener('pagehide', function () {
    if (!stagedAt) return;
    var payload = JSON.stringify(collect());
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/prefs', new Blob([payload], { type: 'application/json' }));
        return;
      }
    } catch (e) {}
    try {
      fetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true
      });
    } catch (e) {}
  });

  // 打开页面：恢复上次未提交的改动（否则这次提交会用旧值覆盖它），并按剩余时间继续等
  (function restore() {
    try {
      var raw = localStorage.getItem(storeKey);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (!saved || typeof saved.body !== 'string') return;
      applyPayload(JSON.parse(saved.body));
      stagedAt = saved.at || 0;
      if (!stagedAt || Date.now() - stagedAt >= delay) { commit(); return; }
      showBar('有改动待保存，' + minutes() + ' 分钟内自动生效');
      schedule();
    } catch (e) {}
  })();

  document.querySelectorAll('[data-contest-preset]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.getAttribute('data-contest-preset');
      contestBoxes.forEach(function (el) {
        el.checked = mode === 'all' ? true : mode === 'core' ? el.value === '电子设计竞赛' : false;
        syncLabel(el);
      });
      stash();
    });
  });

  var clearPause = document.getElementById('clearPause');
  if (clearPause && pause) clearPause.addEventListener('click', function () {
    pause.value = '';
    stash();
  });

  var resend = document.getElementById('resend');
  if (resend) resend.addEventListener('click', function () {
    resend.disabled = true;
    fetch('/api/confirm/resend', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        feedback(d.ok ? 'ok' : 'err', d.message || (d.ok ? '已重发' : '重发失败'));
        resend.disabled = false;
      })
      .catch(function () {
        feedback('err', '网络出现问题，请稍后再试');
        resend.disabled = false;
      });
  });

  var out = document.getElementById('logout');
  if (out) out.addEventListener('click', function () {
    fetch('/api/logout', { method: 'POST' }).then(function () {
      location.href = '/';
    }).catch(function () {
      location.href = '/';
    });
  });

  var copyCal = document.getElementById('copyCal');
  var calField = document.getElementById('calUrl');
  if (copyCal && calField) copyCal.addEventListener('click', function () {
    calField.select();
    var done = function (ok) {
      feedback(ok ? 'ok' : 'err', ok ? '日历地址已复制' : '复制失败，请手动选中复制');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(calField.value).then(function () { done(true); },
        function () { done(false); });
    } else {
      try { done(document.execCommand('copy')); } catch (e) { done(false); }
    }
  });

  var del = document.getElementById('del');
  if (del) del.addEventListener('click', function () {
    if (!confirm('注销后账号、订阅记录和栏目设置都会被删除，且无法恢复。确定继续吗？')) return;
    del.disabled = true;
    fetch('/api/delete-account', { method: 'POST' }).then(function () {
      location.href = '/?deleted=1';
    }).catch(function () {
      del.disabled = false;
      feedback('err', '注销失败，请稍后再试');
    });
  });
})();
`;
