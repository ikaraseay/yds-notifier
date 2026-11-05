/** 后端逻辑：栏目偏好、退出登录、注销账户。 */

import {
  clearSessionCookie,
  deleteUser,
  destroyAllSessions,
  destroySession,
  getSession,
  getUser,
  normalizePrefs,
  putUser,
  readSessionToken,
  type Prefs,
} from "../auth";
import { getConfig, type Env } from "../env";
import { mailShell, sendMail } from "../mailer";
import { assertSameOrigin, esc } from "../security";
import { jsonResp } from "../ui/layout";
import { getCount } from "./api";

/** 所有状态变更都要求同源；非浏览器客户端靠 SameSite=Lax Cookie 兜底。 */
function csrfGuard(req: Request, env: Env): Response | null {
  // 自定义域名与 workers.dev 都在白名单里，过渡期两个入口都可用
  if (assertSameOrigin(req, getConfig(env).allowedOrigins)) return null;
  return jsonResp({ ok: false, message: "请求来源不合法" }, 403);
}

/** POST /api/prefs —— 保存栏目偏好（支持部分字段） */
export async function handlePrefs(req: Request, env: Env): Promise<Response> {
  const guard = csrfGuard(req, env);
  if (guard) return guard;

  const email = await getSession(env.SUBS, readSessionToken(req));
  if (!email) return jsonResp({ ok: false, login: true, message: "登录已过期" }, 401);
  const user = await getUser(env.SUBS, email);
  if (!user) return jsonResp({ ok: false, login: true, message: "账号不存在" }, 401);

  const body = (await req.json().catch(() => ({}))) as Partial<Prefs>;
  user.prefs = normalizePrefs({ ...user.prefs, ...body });
  await putUser(env.SUBS, user);
  return jsonResp({ ok: true, prefs: user.prefs });
}

/** POST /api/logout —— 退出登录（保留账号与订阅） */
export async function handleLogout(req: Request, env: Env): Promise<Response> {
  const guard = csrfGuard(req, env);
  if (guard) return guard;

  await destroySession(env.SUBS, readSessionToken(req));
  return jsonResp({ ok: true }, 200, clearSessionCookie());
}

/** POST /api/delete-account —— 注销：账号、订阅、偏好、全部设备会话一起清掉 */
export async function handleDeleteAccount(req: Request, env: Env): Promise<Response> {
  const guard = csrfGuard(req, env);
  if (guard) return guard;

  const cfg = getConfig(env);
  const token = readSessionToken(req);
  const email = await getSession(env.SUBS, token);
  if (!email) return jsonResp({ ok: false, login: true, message: "登录已过期" }, 401);

  const hadSub = !!(await env.SUBS.get(`sub:${email}`));
  await deleteUser(env.SUBS, email);
  await destroyAllSessions(env.SUBS, email);

  if (hadSub) {
    await env.SUBS.put("meta:count", String(Math.max(0, (await getCount(env)) - 1)));
  }

  if (cfg.mailTo) {
    sendMail(
      env,
      cfg.mailTo,
      `【注销】${email}`,
      mailShell(
        "有人注销了",
        `<b>${esc(email)}</b> 已注销，账号与订阅记录已删除。`,
        "打开订阅页",
        cfg.baseUrl,
        "所有 user:/sub:/session: 记录均已清除，无需额外操作。",
      ),
      `注销：${email}`,
    ).catch((e) => console.error("站长通知发送失败", e));
  }

  return jsonResp({ ok: true }, 200, clearSessionCookie());
}
