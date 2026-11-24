/** MeoNotifier Worker 的路由入口和 Durable Object 导出。 */

import { clearSessionCookie, getSession, getUser, readSessionToken } from "./accounts/auth";
import { getConfig, type Env } from "./platform/env";
import { handleAdmin, handleAdminLogin, handleAdminLogout, handleAdminRemove } from "./admin/handler";
import { getCount, handleCount, handleList, handleStats, health } from "./accounts/api";
import { handleDeleteAccount, handleLogout, handlePrefs } from "./accounts/dashboard";
import {
  handleArchive,
  handleCalendar,
  handleFeed,
  handleNoticesPost,
  personalCalendarUrl,
} from "./notices/handler";
import {
  handleConfirm,
  handleConfirmResend,
  handleLogin,
  handleMagicVerify,
} from "./accounts/login";
import { handleUnsubscribe } from "./accounts/unsubscribe";
import { handleResendWebhook } from "./mail/webhook";
import { handleGroupAdmin } from "./groups/admin";
import { handleSkills } from "./skills/handler";
import { skillSources } from "./skills/sources";
import { noticeHistory } from "./skills/history";
import { skillApi } from "./skills/api";
import { reviewRule, ruleSuggestions } from "./skills/agent";
import { handleGroups } from "./groups/handler";
import { handleGroupRunner } from "./groups/runner";
import { methodNotAllowed } from "./platform/security";
import { llmsResponse, robotsResponse, ISSUES_URL } from "./platform/static";
import { faviconResponse } from "./ui/icons";
import { redirect } from "./platform/http";
import { dashboardPage, loginPage, messagePage } from "./ui/pages";

export { RateLimiter } from "./platform/rate";
export type { Env } from "./platform/env";

export default {
  async queue(batch: MessageBatch<string>, env: Env) {
    for (const message of batch.messages) {
      try {
        await reviewRule(env, message.body);
        message.ack();
      } catch {
        if (message.attempts >= 5 && env.GROUPS) await env.GROUPS.prepare("UPDATE skill_jobs SET status='failed' WHERE id=? AND status='pending'").bind(message.body).run();
        message.retry();
      }
    }
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    try {
      const cfg = getConfig(env);

      if (p === "/health") {
        if (m !== "GET" && m !== "HEAD") return methodNotAllowed("GET, HEAD");
        return health();
      }

      // 站点图标：没有它会退化成 /favicon.ico 的 404，控制台留一条红色报错
      if (p === "/favicon.ico" || p === "/favicon.svg") {
        if (m !== "GET" && m !== "HEAD") return methodNotAllowed("GET, HEAD");
        return faviconResponse();
      }

      // 爬虫与 AI 代理的入口说明，内容见 src/static.ts
      if (p === "/robots.txt") {
        if (m !== "GET" && m !== "HEAD") return methodNotAllowed("GET, HEAD");
        return robotsResponse();
      }
      if (p === "/llms.txt") {
        if (m !== "GET" && m !== "HEAD") return methodNotAllowed("GET, HEAD");
        return llmsResponse(cfg.baseUrl);
      }

      // ---- 公开内容：归档 / RSS / 日历 ----------------------------------
      if (p === "/archive") {
        if (m !== "GET") return methodNotAllowed("GET");
        return handleArchive(req, env);
      }
      if (p === "/feed.xml") {
        if (m !== "GET") return methodNotAllowed("GET");
        return handleFeed(env);
      }
      if (p === "/calendar.ics") {
        if (m !== "GET" && m !== "HEAD") return methodNotAllowed("GET, HEAD");
        return handleCalendar(req, env);
      }

      if (p === "/skills") {
        if (m !== "GET") return methodNotAllowed("GET");
        return await handleSkills(req, env);
      }
      const sources = /^\/api\/skills\/([\w-]+)\/sources$/.exec(p);
      if (p === "/api/skills") return m === "GET" ? await skillApi(req,env) : methodNotAllowed("GET");
      const job = /^\/api\/jobs\/([\w-]+)$/.exec(p);
      if (job) return m === "GET" ? await skillApi(req,env,job[1],"job") : methodNotAllowed("GET");
      const section = /^\/api\/skills\/([\w-]+)\/(taxonomy|subscription)$/.exec(p);
      if (section) return ["GET","POST"].includes(m) ? await skillApi(req,env,section[1],section[2]) : methodNotAllowed("GET, POST");
      const history = /^\/api\/skills\/([\w-]+)\/notices$/.exec(p);
      if (history) return m === "GET" ? await noticeHistory(req,env,history[1]) : methodNotAllowed("GET");
      const suggestions = /^\/api\/skills\/([\w-]+)\/suggestions$/.exec(p);
      if (suggestions) {
        if (m !== "GET" && m !== "POST") return methodNotAllowed("GET, POST");
        return await ruleSuggestions(req, env, suggestions[1]);
      }
      if (sources) {
        if (m !== "GET" && m !== "POST") return methodNotAllowed("GET, POST");
        return await skillSources(req, env, sources[1]);
      }

      // ---- 管理后台及机器接口 ------------------------------------------------------
      if (p === "/groups" || p === "/admin/groups" || p === "/api/group-runner") {
        if (m !== "GET" && m !== "POST") return methodNotAllowed("GET, POST");
        if (p === "/groups") return await handleGroups(req, env);
        if (p === "/admin/groups") return await handleGroupAdmin(req, env);
        return await handleGroupRunner(req, env);
      }
      if (p === "/admin") {
        if (m !== "GET") return methodNotAllowed("GET");
        return await handleAdmin(req, env, url);
      }
      if (p === "/api/admin/login" || p === "/api/admin/logout" || p === "/api/admin/subscribers/remove") {
        if (m !== "POST") return methodNotAllowed("POST");
        if (p === "/api/admin/login") return await handleAdminLogin(req, env);
        if (p === "/api/admin/logout") return handleAdminLogout(req);
        return await handleAdminRemove(req, env);
      }
      if (p === "/api/notices") {
        if (m !== "POST") return methodNotAllowed("POST");
        return handleNoticesPost(req, env);
      }
      if (p === "/api/stats") {
        if (m !== "GET") return methodNotAllowed("GET");
        return handleStats(req, env);
      }
      if (p === "/api/webhooks/resend") {
        if (m !== "POST") return methodNotAllowed("POST");
        return handleResendWebhook(req, env);
      }

      const wechat = {
        name: env.WECHAT_SERVICE_NAME?.trim() || "",
        qrUrl: env.WECHAT_SERVICE_QR_URL?.trim() || "",
      };

      // 首页：已登录直接进控制台，未登录看登录页
      if (p === "/") {
        if (m !== "GET") return methodNotAllowed("GET");
        const email = await getSession(env.SUBS, readSessionToken(req));
        if (email) {
          const user = await getUser(env.SUBS, email);
          if (user) return await handleSkills(req, env);
        }
        return loginPage(cfg.siteName, await getCount(env), url.searchParams.get("deleted") === "1", wechat);
      }

      if (p === "/api/login") {
        if (m !== "POST") return methodNotAllowed("POST");
        return handleLogin(req, env);
      }

      if (p === "/login") {
        if (m !== "GET") return methodNotAllowed("GET");
        return handleMagicVerify(url, env);
      }

      if (p === "/confirm") {
        if (m !== "GET") return methodNotAllowed("GET");
        return handleConfirm(url, env);
      }

      if (p === "/api/confirm/resend") {
        if (m !== "POST") return methodNotAllowed("POST");
        return handleConfirmResend(req, env);
      }

      if (p === "/dashboard" || p === "/skills/yds") {
        if (m !== "GET") return methodNotAllowed("GET");
        const email = await getSession(env.SUBS, readSessionToken(req));
        if (!email) return redirect("/");
        const user = await getUser(env.SUBS, email);
        if (!user) return redirect("/", clearSessionCookie());
        return dashboardPage(user, await personalCalendarUrl(env, user.email), wechat);
      }

      if (p === "/api/prefs") {
        if (m !== "POST") return methodNotAllowed("POST");
        return handlePrefs(req, env);
      }

      if (p === "/api/logout") {
        if (m !== "POST") return methodNotAllowed("POST");
        return handleLogout(req, env);
      }

      if (p === "/api/delete-account") {
        if (m !== "POST") return methodNotAllowed("POST");
        return handleDeleteAccount(req, env);
      }

      if (p === "/unsubscribe") {
        if (m !== "GET" && m !== "POST") return methodNotAllowed("GET, POST");
        return handleUnsubscribe(req, url, env);
      }

      if (p === "/api/list") {
        if (m !== "GET") return methodNotAllowed("GET");
        return handleList(req, env);
      }

      if (p === "/api/count") {
        if (m !== "GET") return methodNotAllowed("GET");
        return handleCount(env);
      }

      return messagePage({
        title: "页面不存在",
        heading: "这个地址<em>没有页面</em>",
        bodyHtml: "可能是链接已经过期，或者地址少打了一个字符。",
        extraHtml:
          `<a class="btn-secondary" href="/">返回首页</a>` +
          `<div class="tip tip--tight">如果是从我们的邮件或页面点进来的，欢迎` +
          ` <a href="${ISSUES_URL}" rel="noopener">报个错误</a>，附上这个地址就行。</div>`,
        status: 404,
      });
    } catch (err) {
      // 内部错误只进日志，不回显 err.message（安全评审报告 S-04）
      console.error("worker error", err);
      return messagePage({
        title: "出错了",
        heading: "服务<em>暂时不可用</em>",
        bodyHtml: "请过几分钟再试一次。",
        extraHtml:
          `<a class="btn-secondary" href="/">返回首页</a>` +
          `<div class="tip tip--tight">一直打不开？欢迎` +
          ` <a href="${ISSUES_URL}" rel="noopener">提一个 issue</a>，说明时间和操作步骤就好。</div>`,
        status: 500,
      });
    }
  },
};
