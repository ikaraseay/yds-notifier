/**
 * 研电赛通知订阅中心 —— 入口 / 路由层
 *
 * 目录约定：
 *   src/ui/         界面层：样式、脚本、HTML 骨架、具体页面
 *   src/handlers/   后端逻辑层：登录、控制台、退订、名单、归档、webhook
 *   src/env.ts      运行时配置（Cloudflare Variables & Secrets）
 *   src/security.ts 签名、CSRF、CSP、输入校验
 *   src/rate.ts     限流 Durable Object
 *   src/mailer.ts   出站邮件
 *
 * 本文件只做 method 白名单 + 路由分发 + 统一错误处理，不含业务逻辑。
 * Durable Object class 必须从入口模块导出，Wrangler 才能找到它。
 */

import { clearSessionCookie, getSession, getUser, readSessionToken } from "./auth";
import { getConfig, type Env } from "./env";
import { getCount, handleCount, handleList, handleStats, health } from "./handlers/api";
import { handleDeleteAccount, handleLogout, handlePrefs } from "./handlers/dashboard";
import {
  handleArchive,
  handleCalendar,
  handleFeed,
  handleNoticesPost,
} from "./handlers/feed";
import {
  handleConfirm,
  handleConfirmResend,
  handleLogin,
  handleMagicVerify,
} from "./handlers/login";
import { handleUnsubscribe } from "./handlers/unsubscribe";
import { handleResendWebhook } from "./handlers/webhook";
import { methodNotAllowed } from "./security";
import { redirect } from "./ui/layout";
import { dashboardPage, loginPage, messagePage } from "./ui/pages";

export { RateLimiter } from "./rate";
export type { Env } from "./env";

export default {
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

      // ---- 管理接口 ------------------------------------------------------
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

      // 首页：已登录直接进控制台，未登录看登录页
      if (p === "/") {
        if (m !== "GET") return methodNotAllowed("GET");
        const email = await getSession(env.SUBS, readSessionToken(req));
        if (email) {
          const user = await getUser(env.SUBS, email);
          if (user) return dashboardPage(user);
        }
        return loginPage(cfg.siteName, await getCount(env), url.searchParams.get("deleted") === "1");
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

      if (p === "/dashboard") {
        if (m !== "GET") return methodNotAllowed("GET");
        const email = await getSession(env.SUBS, readSessionToken(req));
        if (!email) return redirect("/");
        const user = await getUser(env.SUBS, email);
        if (!user) return redirect("/", clearSessionCookie());
        return dashboardPage(user);
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
        heading: "页面不存在",
        bodyHtml: "你要找的页面不在这里。",
        extraHtml: `<a class="btn-secondary" href="/">返回首页</a>`,
        status: 404,
      });
    } catch (err) {
      // 内部错误只进日志，不回显 err.message（安全评审报告 S-04）
      console.error("worker error", err);
      return messagePage({
        title: "出错了",
        heading: "服务暂时不可用",
        bodyHtml: "请稍后重试。若持续出现，请联系站点管理员。",
        status: 500,
      });
    }
  },
};
