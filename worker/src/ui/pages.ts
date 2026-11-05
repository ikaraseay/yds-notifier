/** 界面层：具体页面（登录页、控制台、通用结果页）。 */

import { CATEGORIES, type Frequency, type User } from "../auth";
import { esc } from "../security";
import { page } from "./layout";
import { LOGIN_SCRIPT, PREFS_SCRIPT } from "./scripts";

export function loginPage(site: string, count: number, deleted = false): Response {
  return page({
    title: site,
    heading: "订阅<em>研电赛</em>通知",
    body: `
      <p class="sub">报名、评审、晋级、决赛，研电赛的重要通知，一封邮件替你整理好。
         有新公告就推送，没有就不打扰。</p>
      <div class="count">已有 ${count} 人订阅</div>
      ${deleted ? `<div class="alert ok" role="status">账号已注销，订阅记录也已删除。</div>` : ""}
      <form id="f">
        <input type="email" id="email" name="email" placeholder="你的邮箱地址"
               autocomplete="email" required maxlength="254">
        <button type="submit" id="btn">进入控制台</button>
        <div id="msg" role="status" aria-live="polite"></div>
      </form>`,
    extra: `<div class="tip">
      不用设置密码：填邮箱后会收到一封登录邮件，<strong>点里面的链接验证邮箱</strong>；
      首次订阅还会再收到一封确认邮件，点过确认才开始收通知。<br>
      登录链接 15 分钟内有效、只能用一次。
    </div>
    <div class="tip" style="margin-top:12px">
      也能用 <a href="/archive">通知归档</a> · <a href="/feed.xml">RSS</a> ·
      <a href="/calendar.ics">日历订阅</a> 查看全部通知，不必注册。
    </div>`,
    script: LOGIN_SCRIPT,
  });
}

const FREQ_LABEL: Record<Frequency, string> = {
  instant: "有新通知就发",
  daily: "每天一封摘要",
  weekly: "每周一封摘要",
};

export function dashboardPage(user: User): Response {
  const opts = CATEGORIES.map((c) => {
    const on = user.prefs[c.key];
    return `<label class="opt${on ? " is-on" : ""}">
  <input type="checkbox" name="${esc(c.key)}"${on ? " checked" : ""}>
  <span class="box"></span>
  <span class="name"><span class="dot" style="background:${c.color}"></span>${esc(c.label)}</span>
  <span class="desc">${esc(c.desc)}</span>
</label>`;
  }).join("\n");

  const pending = user.status === "pending";
  const freqOptions = (Object.keys(FREQ_LABEL) as Frequency[])
    .map(
      (k) =>
        `<option value="${k}"${user.prefs.frequency === k ? " selected" : ""}>${esc(FREQ_LABEL[k])}</option>`,
    )
    .join("");

  return page({
    title: "控制台",
    heading: "通知<em>设置</em>",
    body: `
      <p class="sub">勾选你关心的栏目，改动即时保存。推送时只发勾中的内容。</p>
      <div class="who" id="who">
        <span>${esc(user.email)}</span>
        <a href="#" id="logout">退出登录</a>
      </div>
      ${pending ? `<div class="alert err" id="pending-box" role="status">
        还差一步：我们给 <b>${esc(user.email)}</b> 发了一封确认邮件，点里面的链接才会开始收通知。
        <button type="button" id="resend" class="btn-secondary" style="margin-top:10px">重新发送确认邮件</button>
      </div>` : ""}
      <div id="opts" class="opts">${opts}</div>
      <div class="section">
        <h2>推送频率</h2>
        <p class="sub" style="font-size:12px;margin:0 0 10px">
          不想被频繁打扰？改成日报或周报，同一时段的通知会合并成一封。
        </p>
        <select id="frequency" class="field" aria-label="推送频率">${freqOptions}</select>
      </div>
      <div class="section">
        <h2>暂停订阅</h2>
        <p class="sub" style="font-size:12px;margin:0 0 10px">
          选一个日期，在那之前不收邮件；暂停期间的通知会随恢复后的第一封摘要补上。
        </p>
        <input type="date" id="pausedUntil" class="field" aria-label="暂停至"
               value="${esc(user.prefs.pausedUntil || "")}">
        <button type="button" id="clearPause" class="btn-secondary" style="margin-top:10px">清除暂停</button>
      </div>
      <div id="msg" role="status" aria-live="polite"></div>
      <div class="tip" style="margin-top:16px">
        <a href="/archive">通知归档</a> · <a href="/feed.xml">RSS 订阅</a> ·
        <a href="/calendar.ics">加入日历</a>
      </div>
      <div class="danger">
        <h2>注销账户</h2>
        <p>删除账号、订阅记录与栏目设置，之后不再收到任何邮件。此操作不可恢复。</p>
        <button type="button" id="del" class="btn-danger">注销账户</button>
      </div>`,
    script: PREFS_SCRIPT,
  });
}

export interface MessageOpts {
  title: string;
  heading: string;
  /** 动态数据必须由调用方 esc() 后再拼进来 */
  bodyHtml: string;
  extraHtml?: string;
  status?: number;
}

/** 结果页 / 错误页统一出口，避免每个 handler 各写一份 HTML 骨架。 */
export function messagePage(o: MessageOpts): Response {
  return page(
    {
      title: o.title,
      heading: o.heading,
      body: `<p class="sub">${o.bodyHtml}</p>`,
      extra: o.extraHtml,
    },
    o.status ?? 200,
  );
}
