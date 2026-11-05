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

/** 控制台：栏目 / 频率 / 暂停即时保存，确认邮件重发，退出与注销 */
export const PREFS_SCRIPT = `
(function () {
  var form = document.getElementById('opts');
  var msg = document.getElementById('msg');
  if (!form) return;
  var freq = document.getElementById('frequency');
  var pause = document.getElementById('pausedUntil');

  function feedback(kind, text) {
    msg.className = '';
    msg.textContent = '';
    void msg.offsetWidth;
    msg.className = 'alert ' + kind;
    msg.textContent = text;
  }
  function collect() {
    var out = {};
    form.querySelectorAll('input[type=checkbox]').forEach(function (el) {
      out[el.name] = el.checked;
      var label = el.closest('.opt');
      if (label) label.classList.toggle('is-on', el.checked);
    });
    if (freq) out.frequency = freq.value;
    if (pause) out.pausedUntil = pause.value || '';
    return out;
  }
  function save() {
    fetch('/api/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collect())
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) { feedback('ok', '已保存，下次推送按新设置发送'); return; }
      if (d.login) { feedback('err', '登录已过期，请重新进入'); return; }
      feedback('err', d.message || '保存失败，请稍后再试');
    }).catch(function () {
      feedback('err', '网络出现问题，设置没有保存');
    });
  }

  form.addEventListener('change', save);
  if (freq) freq.addEventListener('change', save);
  if (pause) pause.addEventListener('change', save);

  var clearPause = document.getElementById('clearPause');
  if (clearPause && pause) clearPause.addEventListener('click', function () {
    pause.value = '';
    save();
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
