/** 后端逻辑：栏目偏好、退出登录、注销账户。 */

import {
  clearSessionCookie,
  deleteUser,
  destroyAllSessions,
  destroySession,
  getSession,
  getSub,
  getUser,
  isConfirmed,
  normalizePrefs,
  prefsFromBody,
  putSub,
  putUser,
  readSessionToken,
} from "../auth";
import { getConfig, type Env } from "../env";
import { mailShell, sendMail } from "../mailer";
import { assertSameOrigin, esc } from "../security";
import { jsonResp } from "../../../frontend/layout";
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

  const body = await req.json().catch(() => ({}));
  const next = prefsFromBody(body, user.prefs);
  // 幂等短路：内容没变就不写。
  // 每次保存要写 user: + sub: 并删 subs:index，共 2 写 + 1 删；KV 免费额度是
  // 1000 写/1000 删每天，且与 /api/notices 的发布共用。反复点同一个选项若都落盘，
  // 会把额度消耗在无意义的重复写上，最终挤掉归档同步。
  if (JSON.stringify(normalizePrefs(next)) === JSON.stringify(normalizePrefs(user.prefs))) {
    return jsonResp({ ok: true, prefs: user.prefs, unchanged: true });
  }
  user.prefs = next;
  await putUser(env.SUBS, user);
  // sub: 里冗余一份偏好，/api/list 无需再读 user:，也避免两处不一致
  const sub = await getSub(env.SUBS, email);
  if (sub && isConfirmed(sub)) {
    await putSub(env.SUBS, { ...sub, prefs: user.prefs });
  }
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
        cfg.siteName,
      ),
      `注销：${email}`,
    ).catch((e) => console.error("站长通知发送失败", e));
  }

  return jsonResp({ ok: true }, 200, clearSessionCookie());
}
