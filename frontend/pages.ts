/** 界面层：具体页面（登录页、控制台、通用结果页）。 */

import { AUDIENCES, CATEGORIES, CONTESTS, type Frequency, type User } from "../cloudflare/src/auth";
import { esc } from "../cloudflare/src/security";
import { page } from "./layout";
import { LOGIN_SCRIPT, PREFS_SCRIPT } from "./scripts";

/**
 * 设置改动的暂存窗口：改动先落本机，5 分钟后才写 KV。
 *
 * 每次保存 = 2 写 + 1 删，而免费额度是 1000 写 / 1000 删每天，且与发布链路
 * （/api/notices）共用。用户连续勾选赛事属于典型抖动，逐次落库会把额度耗在
 * 无意义的重复写上，极端情况下挤掉归档同步。前端脚本读这个值，只改这一处。
 */
export const PREFS_APPLY_DELAY_MS = 5 * 60 * 1000;

export function loginPage(site: string, count: number, deleted = false): Response {
  return page({
    title: site,
    heading: "订阅<em>研电赛</em>通知",
    body: `
      <p class="sub">研电赛的通知散落在竞赛官网、研创网和各赛事站点。
        这个站帮你盯着：有新公告就发一封邮件，没有就不打扰。</p>
      <div class="count">已有 ${count} 人订阅</div>
      ${deleted ? `<div class="alert ok" role="status">账号已注销，订阅记录也已删除。</div>` : ""}
      <form id="f">
        <input type="email" id="email" name="email" placeholder="你的邮箱地址"
               autocomplete="email" required maxlength="254">
        <button type="submit" id="btn">发送登录邮件</button>
        <div id="msg" role="status" aria-live="polite"></div>
      </form>`,
    extra: `<div class="tip">
      不用设密码：填邮箱后会收到一封登录邮件，<strong>点里面的链接</strong>即可完成订阅并进入控制台。<br>
      登录链接 15 分钟内有效，只能使用一次。
    </div>
    <div class="tip tip--tight">
      不订阅也能看：<a href="/archive">通知归档</a> · <a href="/feed.xml">RSS</a>。
      订阅后还能在控制台复制专属日历地址，内容按你的角色和赛事过滤。
    </div>`,
    script: LOGIN_SCRIPT,
  });
}

const FREQ_LABEL: Record<Frequency, string> = {
  instant: "有新通知就发",
  daily: "每天一封摘要",
  weekly: "每周一封摘要",
};

export function dashboardPage(user: User, calendarUrl = ""): Response {
  const opts = CATEGORIES.map((c) => {
    const on = user.prefs[c.key];
    return `<label class="opt${on ? " is-on" : ""}">
  <input type="checkbox" name="${esc(c.key)}"${on ? " checked" : ""}>
  <span class="box"></span>
  <span class="name"><span class="dot dot--${c.key}"></span>${esc(c.label)}</span>
  <span class="desc">${esc(c.desc)}</span>
</label>`;
  }).join("\n");

  const audOpts = AUDIENCES.map((a) => {
    const on = user.prefs.audiences[a.key];
    return `<label class="opt compact${on ? " is-on" : ""}">
  <input type="checkbox" data-aud="${esc(a.key)}"${on ? " checked" : ""}>
  <span class="box"></span>
  <span class="name">${esc(a.label)}</span>
  <span class="desc">${esc(a.desc)}</span>
</label>`;
  }).join("\n");

  const pickedContests = new Set(user.prefs.contests);
  const contestOpts = CONTESTS.map((name) => {
    const on = pickedContests.has(name);
    return `<label class="opt mini${on ? " is-on" : ""}">
  <input type="checkbox" name="contest" value="${esc(name)}"${on ? " checked" : ""}>
  <span class="box"></span>
  <span class="name">${esc(name)}</span>
</label>`;
  }).join("\n");
  const allContests = user.prefs.contests.length === 0;

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
      <p class="sub">改动会自动保存，最迟 5 分钟后生效。</p>
      <div class="who" id="who">
        <span>${esc(user.email)}</span>
        <a href="#" id="logout">退出登录</a>
      </div>
      ${pending ? `<div class="alert err" id="pending-box" role="status">
        还差一步：确认邮件已发到 <b>${esc(user.email)}</b>，点里面的链接后才开始收通知。
        没收到的话，先看看垃圾箱。
        <button type="button" id="resend" class="btn-secondary btn-gap">重新发送确认邮件</button>
      </div>` : ""}
      <div id="settings" data-email="${esc(user.email)}" data-apply-delay="${PREFS_APPLY_DELAY_MS}">
        <div class="section section--first">
          <h2>我的角色</h2>
          <p class="sub hint">
            学生看报名与提交，导师看评审与决赛，培养单位看审核与承办。可多选，按所选角色的合集推送。
          </p>
          <div id="aud-opts" class="opts">${audOpts}</div>
        </div>
        <div class="section">
          <h2>关注的赛事</h2>
          <p class="sub hint">
            只勾你关心的赛事，都不勾时默认接收全部。当前：${allContests ? "全部赛事" : `${pickedContests.size} 项`}。
          </p>
          <div class="row-actions">
            <button type="button" class="btn-mini" data-contest-preset="core">只选研电赛</button>
            <button type="button" class="btn-mini" data-contest-preset="all">全选</button>
            <button type="button" class="btn-mini" data-contest-preset="none">清空</button>
          </div>
          <div id="contest-opts" class="contest-grid">${contestOpts}</div>
        </div>
        <div class="section">
          <h2>通知栏目</h2>
          <p class="sub hint">
            勾选想收的通知类型，会与上面的角色一起筛选。
          </p>
          <div id="opts" class="opts">${opts}</div>
        </div>
      </div>
      <div class="section">
        <h2>推送频率</h2>
        <p class="sub hint">
          不想被频繁打扰？改成日报或周报，同一时段的通知会合并成一封。
        </p>
        <select id="frequency" class="field" aria-label="推送频率">${freqOptions}</select>
      </div>
      <div class="section">
        <h2>暂停订阅</h2>
        <p class="sub hint">
          在这个日期之前不发信。暂停期间攒下的通知，会在恢复后的第一封里补上。
        </p>
        <input type="date" id="pausedUntil" class="field" aria-label="暂停至"
               value="${esc(user.prefs.pausedUntil || "")}">
        <button type="button" id="clearPause" class="btn-secondary btn-gap">清除暂停</button>
      </div>
      <div id="msg" role="status" aria-live="polite"></div>
      <div id="applybar" class="applybar" aria-live="polite">
        <span id="applytext">有未保存的更改</span>
        <button type="button" id="applyNow" class="btn-mini">立即生效</button>
      </div>
      <div class="section">
        <h2>我的日历</h2>
        <p class="sub hint">
          内容只包含你订阅的赛事和栏目，修改设置后自动同步。
          把地址粘贴到手机或 Outlook 的「订阅日历」即可。地址与你的邮箱绑定，请勿分享。
        </p>
        ${calendarUrl ? `<input type="text" id="calUrl" class="field" readonly
               value="${esc(calendarUrl)}" aria-label="我的日历地址">
        <button type="button" id="copyCal" class="btn-secondary btn-gap">复制日历地址</button>`
        : `<p class="sub hint">日历签名未配置，暂时无法生成个人地址。</p>`}
      </div>
      <div class="tip tip--last">
        <a href="/archive">通知归档</a> · <a href="/feed.xml">RSS 订阅</a>${calendarUrl
          ? ` · <a href="${esc(calendarUrl)}">加入日历</a>` : ""}
      </div>
      <div class="danger">
        <h2>注销账户</h2>
        <p>将删除账号、订阅记录和全部设置，之后不再收到任何邮件，且无法恢复。</p>
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
