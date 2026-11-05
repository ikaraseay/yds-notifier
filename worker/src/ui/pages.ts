/** 界面层：具体页面（登录页、控制台、通用结果页）。 */

import { CATEGORIES, type User } from "../auth";
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
      不用设置密码：填邮箱后会收到一封登录邮件，<strong>点里面的链接就直接进入</strong>。
      首次进入会自动注册并订阅，之后可在控制台挑选想收的栏目，或随时注销账户。<br>
      链接 15 分钟内有效、且只能用一次。
    </div>`,
    script: LOGIN_SCRIPT,
  });
}

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

  return page({
    title: "控制台",
    heading: "通知<em>设置</em>",
    body: `
      <p class="sub">勾选你关心的栏目，改动即时保存。推送时只发勾中的内容。</p>
      <div class="who" id="who">
        <span>${esc(user.email)}</span>
        <a href="#" id="logout">退出登录</a>
      </div>
      <div id="opts" class="opts">${opts}</div>
      <div id="msg" role="status" aria-live="polite"></div>
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
