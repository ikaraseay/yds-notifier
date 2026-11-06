/**
 * Worker 端到端测试（在 Node 里跑，替换掉 KV / DO / fetch 三类外部依赖）
 *   npm test   （会先用 esbuild 生成 dist/worker.test.mjs）
 *
 * 覆盖：登录（魔法链接）、默认注册、栏目偏好、注销、退订、限流、鉴权，
 *      以及安全加固：CSP nonce、method 白名单、Host 头注入、CSRF、错误不回显。
 */
import assert from "node:assert";
import crypto from "node:crypto";
import worker from "../dist/worker.test.mjs";

/* ---------------- 模拟 KV ---------------- */
class MockKV {
  constructor() {
    this.map = new Map();
    this.writes = 0;
    this.reads = 0;
  }
  async get(k) {
    this.reads++;
    return this.map.has(k) ? this.map.get(k) : null;
  }
  async put(k, v) {
    this.writes++;
    this.map.set(k, v);
  }
  async delete(k) {
    this.map.delete(k);
  }
  async list({ prefix = "", limit = 1000 } = {}) {
    const keys = [...this.map.keys()]
      .filter((k) => k.startsWith(prefix))
      .slice(0, limit)
      .map((name) => ({ name }));
    return { keys, list_complete: true, cursor: undefined };
  }
}

/* ---------------- 模拟 Durable Object ---------------- */
class MockDO {
  constructor() {
    this.buckets = new Map();
  }
  idFromName(name) {
    return name;
  }
  get(id) {
    const self = this;
    return {
      async fetch(input, init) {
        // 桩收到的可能是 Request，也可能只是 URL 字符串（与真实 DO 的 stub.fetch 一致处理）
        const u = new URL(
          typeof input === "string" ? input : input && input.url ? input.url : String(input),
        );

        const limit = Number(u.searchParams.get("limit") || 3);
        const windowSec = Number(u.searchParams.get("window") || 3600);
        const now = Date.now();
        let b = self.buckets.get(id);
        if (!b || now >= b.resetAt) b = { count: 0, resetAt: now + windowSec * 1000 };
        if (b.count >= limit) {
          self.buckets.set(id, b);
          return Response.json({
            allowed: false,
            remaining: 0,
            retryAfter: Math.ceil((b.resetAt - now) / 1000),
          });
        }
        b.count += 1;
        self.buckets.set(id, b);
        return Response.json({ allowed: true, remaining: limit - b.count, retryAfter: 0 });
      },
    };
  }
}

/* ---------------- 模拟 Resend & GitHub ---------------- */
const sent = [];
let githubApiCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url =
    typeof input === "string"
      ? input
      : input && typeof input.url === "string"
        ? input.url
        : String(input);
  if (url.startsWith("https://api.resend.com")) {
    const body = JSON.parse(init.body);
    sent.push(body);
    return new Response(JSON.stringify({ id: "mock-" + sent.length }), { status: 200 });
  }
  // Worker 已移除 GitHub 凭据与全局退订，正常流程不应出现任何 api.github.com 调用
  if (url.includes("api.github.com")) {
    githubApiCalls++;
    return new Response(null, { status: 204 });
  }
  // DO 桩与外部请求都走真实实现
  return realFetch(input, init);
};

const env = {
  // Secrets
  UNSUB_SECRET: "test-secret-123",
  UNSUB_SECRET_PREVIOUS: "",
  RESEND_API_KEY: "re_mock",
  SUBSCRIBE_API_TOKEN: "admin-secret",
  // Variables
  CUSTOM_DOMAIN: "notice.example.com",
  WORKERS_DEV_URL: "https://yds.workers.dev",
  PUBLIC_BASE_URL: "https://yds.workers.dev",
  SITE_NAME: "研电赛通知订阅",
  MAIL_FROM_ADDRESS: "notice@demo.dev",
  MAIL_FROM_NAME: "研电赛通知",
  MAIL_TO: "admin@qq.com",
  UNSUB_TTL_DAYS: "180",
  MAX_PER_IP_HOUR: "10",
  MAX_CONFIRM_PER_DAY: "60",
  LIST_RATE_PER_HOUR: "60",
  // Bindings
  SUBS: new MockKV(),
  RATE: new MockDO(),
};

/** 公共日历已下线：测试统一用签名个人日历地址（不要求该邮箱真实存在）。 */
function signedCal(email = "reader@example.com", purpose = "cal", ttlDays = 3650) {
  const exp = Math.floor(Date.now() / 1000) + ttlDays * 86400;
  const sig = crypto
    .createHmac("sha256", env.UNSUB_SECRET)
    .update(`${purpose}:${email.toLowerCase()}:${exp}`)
    .digest("hex")
    .slice(0, 32);
  return `/calendar.ics?email=${encodeURIComponent(email)}&token=${exp}.${sig}`;
}

let ipSeq = 0;
const call = async (path, init = {}, ip) => {
  const req = new Request("https://yds.workers.dev" + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip || `1.1.1.${++ipSeq}`,
      ...(init.headers || {}),
    },
  });
  const resp = await worker.fetch(req, env);
  const text = await resp.text();
  return { status: resp.status, text, headers: resp.headers };
};

const post = (path, body, ip) =>
  call(path, { method: "POST", body: JSON.stringify(body) }, ip);

/** 从最近一封「登录」邮件里取出魔法链接（确认/欢迎邮件不含该链接） */
const magicPathOf = (email) => {
  const m = sent.filter((x) => x.to[0] === email && String(x.subject).includes("登录")).pop();
  assert.ok(m, `没有发给 ${email} 的登录邮件`);
  const raw = m.html.match(/href="([^"]*\/login\?n=[^"]*)"/)[1].replace(/&amp;/g, "&");
  const u = new URL(raw);
  return u.pathname + u.search;
};

/** 从确认订阅邮件里取出 /confirm?c= 链接 */
const confirmPathOf = (email) => {
  const m = sent.filter(
    (x) => x.to[0] === email && String(x.subject).includes("请确认订阅"),
  ).pop();
  assert.ok(m, `没有发给 ${email} 的确认订阅邮件`);
  const raw = m.html.match(/href="([^"]*\/confirm\?c=[^"]*)"/)[1].replace(/&amp;/g, "&");
  const u = new URL(raw);
  return u.pathname + u.search;
};

/** 走完双重确认，返回确认页响应 */
const confirmOf = (email) => call(confirmPathOf(email));

/** 从 set-cookie 里抠出会话 token */
const sidOf = (resp) => {
  const raw = resp.headers.get("set-cookie") || "";
  const m = raw.match(/yds_sid=([^;]*)/);
  return m ? m[1] : "";
};

let pass = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log("  PASS", name);
  } else {
    console.log("  FAIL", name, extra);
    process.exitCode = 1;
  }
};

(async () => {
  console.log("\n[1] 首页 = 登录页");
  let r = await call("/");
  check("返回 200", r.status === 200);
  check("是登录表单", r.text.includes('id="email"') && r.text.includes("进入控制台"));
  check("有 CSP 头", (r.headers.get("content-security-policy") || "").includes("default-src 'none'"));
  check("有 X-Frame-Options", r.headers.get("x-frame-options") === "DENY");
  check("未登录不写会话", !sidOf(r));

  console.log("\n[2] 邮箱校验");
  r = await post("/api/login", { email: "abc" });
  check("非法邮箱 400", r.status === 400, r.status);
  r = await post("/api/login", { email: "a@example.com" });
  check("测试域名被拒 400", r.status === 400);
  r = await post("/api/login", { email: "" });
  check("空邮箱被拒 400", r.status === 400);

  console.log("\n[3] 提交邮箱 → 发登录信");
  const email = "student@qq.com";
  r = await post("/api/login", { email }, "9.9.9.1");
  check("返回 200", r.status === 200, r.text);
  check("提示已发出", r.text.includes("登录邮件已发出"));
  const loginMail = sent.find((m) => m.to[0] === email);
  check("确实发了信", !!loginMail);
  check("主题含登录", loginMail.subject.includes("登录"));
  check(
    "链接含一次性 nonce",
    /\/login\?n=[0-9a-f]{48}/.test(loginMail.html.replace(/&amp;/g, "&")),
  );
  check("文中不含 emoji", !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(loginMail.html));

  console.log("\n[4] 点魔法链接 → 注册 + 建会话");
  const mp = magicPathOf(email);
  r = await call(mp);
  check("302 到控制台", r.status === 302 && r.headers.get("location") === "/dashboard", r.status);
  const sid = sidOf(r);
  check("下发会话 cookie", sid.length === 64, sid);
  const cookie = r.headers.get("set-cookie") || "";
  check("cookie 是 HttpOnly", /HttpOnly/i.test(cookie));
  check("cookie 是 Secure", /Secure/i.test(cookie));
  check("cookie 是 SameSite=Lax", /SameSite=Lax/i.test(cookie));
  const userRec = JSON.parse(await env.SUBS.get("user:" + email));
  check("已建档", userRec.email === email);
  check(
    "默认偏好：报名/评审/决赛开，动态关",
    userRec.prefs.registration &&
      userRec.prefs.review &&
      userRec.prefs.final &&
      userRec.prefs.updates === false,
    JSON.stringify(userRec.prefs),
  );
  check("待确认状态不进名单", (await env.SUBS.get("sub:" + email)) === null);
  check(
    "已发确认订阅邮件",
    sent.some((m) => m.to[0] === email && String(m.subject).includes("请确认订阅")),
  );
  const cr = await confirmOf(email);
  check("确认页返回成功", cr.status === 200 && cr.text.includes("订阅"), cr.status);
  check(
    "确认后发欢迎邮件",
    sent.some((m) => m.to[0] === email && String(m.subject).includes("订阅成功")),
  );
  check("确认后加入订阅列表", (await env.SUBS.get("sub:" + email)) !== null);
  check("订阅数=1", (await env.SUBS.get("meta:count")) === "1");
  check("已通知站长", sent.some((m) => m.to[0] === "admin@qq.com" && m.subject.includes("新订阅")));

  console.log("\n[5] 魔法链接一次性");
  r = await call(mp);
  check("再点一次被拒 400", r.status === 400, r.status);
  check("提示不能用了", r.text.includes("不能用了"));

  console.log("\n[6] 已登录进控制台");
  r = await call("/", { headers: { Cookie: `yds_sid=${sid}` } });
  check("首页直接进控制台", r.status === 200 && r.text.includes("通知<em>设置</em>"), r.text.slice(0, 200));
  check(
    "显示四个栏目",
    ["报名参赛", "评审与名单", "决赛与收官", "赛事动态"].every((k) => r.text.includes(k)),
  );
  check("显示注销入口", r.text.includes("注销账户") && r.text.includes('id="del"'));
  check("显示邮箱", r.text.includes(email));

  console.log("\n[7] /dashboard 鉴权");
  r = await call("/dashboard");
  check("无会话 302 回首页", r.status === 302 && r.headers.get("location") === "/");
  r = await call("/dashboard", { headers: { Cookie: "yds_sid=deadbeef" } });
  check("伪造会话 302", r.status === 302);
  r = await call("/dashboard", { headers: { Cookie: `yds_sid=${sid}` } });
  check("有效会话 200", r.status === 200);

  console.log("\n[8] 保存栏目偏好");
  r = await call("/api/prefs", {
    method: "POST",
    body: JSON.stringify({ updates: true, review: false }),
    headers: { Cookie: `yds_sid=${sid}` },
  });
  check("返回 200", r.status === 200, r.text);
  const pj = JSON.parse(r.text);
  check("updates 已开", pj.prefs.updates === true);
  check("review 已关", pj.prefs.review === false);
  check("未提交的字段保持不变", pj.prefs.registration === true && pj.prefs.final === true);
  const saved = JSON.parse(await env.SUBS.get("user:" + email));
  check("已落 KV", saved.prefs.updates === true && saved.prefs.review === false);

  console.log("\n[9] 偏好接口的输入过滤");
  r = await call("/api/prefs", {
    method: "POST",
    body: JSON.stringify({ evil: true, final: "yes" }),
    headers: { Cookie: `yds_sid=${sid}` },
  });
  const pj2 = JSON.parse(r.text);
  check("未知字段被丢弃", !("evil" in pj2.prefs));
  check("非布尔值被忽略（保持原值）", pj2.prefs.final === true, JSON.stringify(pj2.prefs));

  console.log("\n[10] 偏好接口未登录被拒");
  r = await call("/api/prefs", { method: "POST", body: JSON.stringify({ final: false }) });
  check("返回 401", r.status === 401, r.status);
  check("带 login 标记", JSON.parse(r.text).login === true);

  console.log("\n[11] 同邮箱 10 分钟冷却");
  const e2 = "cool@qq.com";
  r = await post("/api/login", { email: e2 }, "8.8.8.1");
  check("首次成功", r.status === 200, r.text);
  r = await post("/api/login", { email: e2 }, "8.8.8.2");
  check("立刻重发被拦 429", r.status === 429, `${r.status} ${r.text}`);
  check("提示去查收件箱", r.text.includes("刚发过"));

  console.log("\n[12] IP 限流（每 IP 每小时 10 次）");
  const ip = "7.7.7.7";
  const results = [];
  for (let i = 0; i < 11; i++) {
    const rr = await post("/api/login", { email: `x${i}@qq.com` }, ip);
    results.push(rr.status);
  }
  check("前 10 次放行", results.slice(0, 10).every((s) => s === 200), results.join(","));
  check("第 11 次 429", results[10] === 429, results[10]);

  console.log("\n[13] 全局每日熔断");
  const fresh = { ...env, RATE: new MockDO(), SUBS: new MockKV(), MAX_CONFIRM_PER_DAY: "1" };
  let resp = await worker.fetch(
    new Request("https://x/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "6.6.6.1" },
      body: JSON.stringify({ email: "g1@qq.com" }),
    }),
    fresh,
  );
  check("当日第 1 封放行", resp.status === 200, resp.status);
  resp = await worker.fetch(
    new Request("https://x/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "6.6.6.2" },
      body: JSON.stringify({ email: "g2@qq.com" }),
    }),
    fresh,
  );
  const j = await resp.json();
  check("超出当日上限被拒", resp.status === 429 && j.message.includes("上限"), JSON.stringify(j));

  console.log("\n[14] 退出登录");
  r = await call("/api/logout", { method: "POST", headers: { Cookie: `yds_sid=${sid}` } });
  check("返回 200", r.status === 200);
  check("清 cookie", /Max-Age=0/.test(r.headers.get("set-cookie") || ""));
  r = await call("/dashboard", { headers: { Cookie: `yds_sid=${sid}` } });
  check("旧会话立即失效", r.status === 302);
  check("账号仍存在", (await env.SUBS.get("user:" + email)) !== null);
  check("订阅仍在", (await env.SUBS.get("sub:" + email)) !== null);

  console.log("\n[15] 重新登录保留旧偏好");
  // 原邮箱有 10 分钟发信冷却，换一个干净的邮箱走同样流程再验证偏好持久化
  const e3 = "again@qq.com";
  await post("/api/login", { email: e3 }, "9.9.9.5");
  r = await call(magicPathOf(e3));
  await confirmOf(e3);
  const sid3a = sidOf(r);
  await call("/api/prefs", {
    method: "POST",
    body: JSON.stringify({ updates: true, review: false }),
    headers: { Cookie: `yds_sid=${sid3a}` },
  });
  await call("/api/logout", { method: "POST", headers: { Cookie: `yds_sid=${sid3a}` } });
  // 冷却窗口内直接复用上一封邮件的链接不可行（一次性），这里缩短冷却：换 IP 不如清 DO 桶
  const savedRate = env.RATE;
  env.RATE = new MockDO();
  await post("/api/login", { email: e3 }, "9.9.9.7");
  env.RATE = savedRate;
  r = await call(magicPathOf(e3));
  const sid2 = sidOf(r);
  check("拿到新会话", sid2.length === 64);
  r = await call("/dashboard", { headers: { Cookie: `yds_sid=${sid2}` } });
  check("updates 仍为勾选态", /name="updates"\s+checked/.test(r.text), r.text.slice(0, 300));
  check("review 仍为未勾选", !/name="review"\s+checked/.test(r.text));
  check("老用户不重复加订阅", (await env.SUBS.get("meta:count")) === "2");

  console.log("\n[16] 注销账户");
  const before = sent.length;
  r = await call("/api/delete-account", { method: "POST", headers: { Cookie: `yds_sid=${sid2}` } });
  check("返回 200", r.status === 200, r.text);
  check("清 cookie", /Max-Age=0/.test(r.headers.get("set-cookie") || ""));
  check("user: 已删除", (await env.SUBS.get("user:" + e3)) === null);
  check("sub: 已删除", (await env.SUBS.get("sub:" + e3)) === null);
  check("订阅数减一", (await env.SUBS.get("meta:count")) === "1");
  check("已通知站长注销", sent.slice(before).some((m) => m.subject.includes("注销")));
  r = await call("/dashboard", { headers: { Cookie: `yds_sid=${sid2}` } });
  check("会话立即失效", r.status === 302);

  console.log("\n[17] 注销后重新注册是全新账号");
  env.RATE = new MockDO();
  await post("/api/login", { email: e3 }, "9.9.9.8");
  r = await call(magicPathOf(e3));
  await confirmOf(e3);
  const sid3 = sidOf(r);
  const reborn = JSON.parse(await env.SUBS.get("user:" + e3));
  check("偏好回到默认", reborn.prefs.updates === false, JSON.stringify(reborn.prefs));
  check("重新加入订阅", (await env.SUBS.get("sub:" + e3)) !== null);
  check("订阅数回到 2", (await env.SUBS.get("meta:count")) === "2");
  check("会话可用", (await call("/dashboard", { headers: { Cookie: `yds_sid=${sid3}` } })).status === 200);
  // 收尾：把 e3 也注销掉，让后续用例从干净状态开始
  await call("/api/delete-account", { method: "POST", headers: { Cookie: `yds_sid=${sid3}` } });

  console.log("\n[18] 退订链接（邮件底部）");
  const unsubToken = (() => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sig = crypto
      .createHmac("sha256", env.UNSUB_SECRET)
      .update(`unsub:${email}:${exp}`)
      .digest("hex")
      .slice(0, 32);
    return `${exp}.${sig}`;
  })();
  const unsubPath = `/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubToken}`;
  r = await call(unsubPath);
  check("GET 只显示确认页", r.status === 200 && r.text.includes("确定要退订吗"));
  check("GET 未删除数据", (await env.SUBS.get("sub:" + email)) !== null);
  r = await call(unsubPath, { method: "POST" });
  check("POST 退订成功", r.status === 200 && r.text.includes("已退订"), r.text.slice(0, 200));
  check("sub: 已删除", (await env.SUBS.get("sub:" + email)) === null);
  check("账号保留", (await env.SUBS.get("user:" + email)) !== null);
  check("订阅数回到 0", (await env.SUBS.get("meta:count")) === "0");
  check("已通知站长退订", sent.some((m) => m.subject.includes("退订")));

  console.log("\n[19] 篡改退订参数");
  r = await call(`/unsubscribe?email=other@qq.com&token=${unsubToken}`);
  check("换了邮箱即失效 400", r.status === 400, r.status);
  r = await call(`/unsubscribe?email=${encodeURIComponent(email)}&token=123.456`);
  check("乱写 token 被拒", r.status === 400);

  console.log("\n[20] 旧版全局退订链接已被移除");
  const legacySig = crypto
    .createHmac("sha256", env.UNSUB_SECRET)
    .update("unsub:0")
    .digest("hex")
    .slice(0, 32);
  r = await call(`/unsubscribe?token=0.${legacySig}`);
  check("不带 email 的旧链接返回 400", r.status === 400, r.status);
  check("全程未调用 GitHub API", githubApiCalls === 0, String(githubApiCalls));

  console.log("\n[21] /api/list 带栏目偏好");
  r = await call("/api/list");
  check("无 Token 返回 401", r.status === 401, r.status);
  r = await call("/api/list", { headers: { Authorization: "Bearer wrong" } });
  check("错误 Token 返回 401", r.status === 401);

  check("cool@qq.com 未点链接所以没有账号", (await env.SUBS.get("user:" + e2)) === null);
  r = await call(magicPathOf(e2));
  await confirmOf(e2);
  const e2sid = sidOf(r);
  await call("/api/prefs", {
    method: "POST",
    body: JSON.stringify({ updates: true, registration: false }),
    headers: { Cookie: `yds_sid=${e2sid}` },
  });
  r = await call("/api/list", { headers: { Authorization: "Bearer admin-secret" } });
  const listJson = JSON.parse(r.text);
  check("正确 Token 返回 200", r.status === 200);
  check("兼容字段 emails 仍在", Array.isArray(listJson.emails) && listJson.emails.includes(e2));
  const sub = listJson.subscribers.find((s) => s.email === e2);
  check(
    "subscribers 里带 prefs",
    !!sub && sub.prefs.updates === true && sub.prefs.registration === false,
    JSON.stringify(sub),
  );

  console.log("\n[22] 安全响应头与 404");
  r = await call("/");
  check("nosniff", r.headers.get("x-content-type-options") === "nosniff");
  check("Referrer-Policy", r.headers.get("referrer-policy") === "no-referrer");
  check("Cache-Control no-store", r.headers.get("cache-control") === "no-store");
  r = await call("/nope");
  check("未知路径 404", r.status === 404);
  r = await call("/api/count");
  check("count 返回数字", r.status === 200 && typeof JSON.parse(r.text).count === "number");

  console.log("\n[23] 安全加固");
  r = await call("/");
  const policy = r.headers.get("content-security-policy") || "";
  check("CSP 不再使用 unsafe-inline", !policy.includes("unsafe-inline"), policy);
  check("CSP 带 style nonce", /style-src 'nonce-[0-9a-f]+'/.test(policy), policy);
  const styleNonce = (r.text.match(/<style nonce="([0-9a-f]+)">/) || [])[1];
  check("style 标签与 CSP 共用 nonce", !!styleNonce && policy.includes(styleNonce));

  r = await call("/api/list", { method: "DELETE" });
  check("名单接口拒绝非 GET 405", r.status === 405 && r.headers.get("allow") === "GET", r.status);
  r = await call("/unsubscribe?email=a@qq.com&token=x", { method: "PUT" });
  check("退订接口拒绝 PUT 405", r.status === 405, r.status);

  const zeroSig = crypto
    .createHmac("sha256", env.UNSUB_SECRET)
    .update("unsub:a@qq.com:0")
    .digest("hex")
    .slice(0, 32);
  r = await call(`/unsubscribe?email=a@qq.com&token=0.${zeroSig}`);
  check("exp=0 的旧 token 被拒（S-01）", r.status === 400, r.status);

  r = await call("/api/prefs", {
    method: "POST",
    body: "{}",
    headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
  });
  check("跨站请求被 CSRF 拦截 403", r.status === 403, r.status);

  const hostResp = await worker.fetch(
    new Request("https://attacker.example/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "5.5.5.5" },
      body: JSON.stringify({ email: "host-probe@qq.com" }),
    }),
    env,
  );
  check("伪造 Host 的请求仍能受理", hostResp.status === 200, hostResp.status);
  const hostMail = sent.filter((m) => m.to[0] === "host-probe@qq.com").pop();
  check("登录链接固定为 PUBLIC_BASE_URL", !!hostMail && hostMail.html.includes("https://yds.workers.dev/login?n="));
  check("登录链接不含伪造域名", !!hostMail && !hostMail.html.includes("attacker.example"));

  console.log("\n[24] 自定义域名派生与多入口 CSRF 白名单");
  const domainEnv = {
    ...env,
    PUBLIC_BASE_URL: "",                       // 不显式覆盖，走 CUSTOM_DOMAIN 派生
    CUSTOM_DOMAIN: "notice.example.com",
    WORKERS_DEV_URL: "https://yds.workers.dev",
  };
  const domainResp = await worker.fetch(
    new Request("https://attacker.example/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "5.5.5.6" },
      body: JSON.stringify({ email: "domain-probe@qq.com" }),
    }),
    domainEnv,
  );
  check("自定义域名下登录仍可用", domainResp.status === 200, domainResp.status);
  const domainMail = sent.filter((m) => m.to[0] === "domain-probe@qq.com").pop();
  check(
    "登录链接自动使用自定义域名",
    !!domainMail && domainMail.html.includes("https://notice.example.com/login?n="),
  );

  // 自定义域 + workers.dev 两个入口都应在白名单内；恶意来源必须被拦
  for (const [label, origin, wantStatus] of [
    ["自定义域来源", "https://notice.example.com", 401],
    ["workers.dev 来源", "https://yds.workers.dev", 401],
    ["恶意来源", "https://evil.example", 403],
  ]) {
    const csrf = await worker.fetch(
      new Request("https://notice.example.com/api/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: "{}",
      }),
      domainEnv,
    );
    check(`${label} → ${wantStatus}`, csrf.status === wantStatus, csrf.status);
  }


  console.log("\n[25] 通知归档 / RSS / 日历 / 同步接口");
  const noticePayload = {
    site: "研电赛通知订阅",
    baseUrl: "https://yds.workers.dev",
    notices: [
      { uid: "n1", title: "关于报名截止的通知", url: "https://cpipc.acge.org.cn/cw/hp/6/1",
        date: "2026-11-01", category: "报名参赛", source: "研创网",
        summary: "报名截止 2026年11月25日", deadline: "2026-11-25", changeKind: "new" },
      { uid: "n2", title: "评审名单公示（更正）", url: "javascript:alert(1)",
        date: "2026-11-02", category: "评审与名单", source: "研创网",
        summary: "", deadline: "", changeKind: "changed" },
    ],
  };
  r = await call("/api/notices", { method: "POST", body: JSON.stringify(noticePayload) });
  check("同步接口无 token 401", r.status === 401, r.status);
  r = await call("/api/notices", {
    method: "POST", body: JSON.stringify(noticePayload),
    headers: { Authorization: "Bearer admin-secret" },
  });
  check("同步接口有 token 200", r.status === 200, r.text.slice(0, 120));
  r = await call("/archive");
  check("归档页 200 且含标题", r.status === 200 && r.text.includes("关于报名截止的通知"));
  check("归档页标出更新", r.text.includes("更新"));
  check("归档页不渲染危险链接", !r.text.includes('href="javascript'));
  r = await call("/feed.xml");
  check("RSS 200 且结构正确", r.status === 200 && r.text.includes("<rss"), r.text.slice(0, 120));
  check("RSS 含两条 item", (r.text.match(/<item>/g) || []).length === 2);
  r = await call(signedCal());
  check("日历 200 且含 VCALENDAR", r.status === 200 && r.text.includes("BEGIN:VCALENDAR"));
  check("日历含截止日", r.text.includes("DTSTART;VALUE=DATE:20261125"));
  check("日历使用 CRLF", r.text.includes("\r\n"));
  r = await call("/feed.xml", { method: "POST" });
  check("RSS 拒绝 POST 405", r.status === 405, r.status);

  console.log("\n[26] 频率与暂停偏好");
  r = await call("/api/prefs", {
    method: "POST", body: JSON.stringify({ frequency: "weekly", pausedUntil: "2026-12-01" }),
    headers: { Cookie: `yds_sid=${e2sid}` },
  });
  const pref3 = JSON.parse(r.text);
  check("频率保存为 weekly", pref3.prefs.frequency === "weekly", JSON.stringify(pref3.prefs));
  check("暂停日期保存", pref3.prefs.pausedUntil === "2026-12-01");
  r = await call("/api/list", { headers: { Authorization: "Bearer admin-secret" } });
  const e2row = JSON.parse(r.text).subscribers.find((s) => s.email === e2);
  check("名单带 frequency / pausedUntil", !!e2row && e2row.frequency === "weekly" && e2row.pausedUntil === "2026-12-01");
  r = await call("/api/prefs", {
    method: "POST", body: JSON.stringify({ frequency: "evil", pausedUntil: "not-a-date" }),
    headers: { Cookie: `yds_sid=${e2sid}` },
  });
  const pref4 = JSON.parse(r.text);
  check("非法频率回落 instant", pref4.prefs.frequency === "instant");
  check("非法日期被清空", pref4.prefs.pausedUntil === "");

  console.log("\n[27] 退订原因与「改为低频」");
  const unsubToken2 = (() => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sig = crypto.createHmac("sha256", env.UNSUB_SECRET)
      .update(`unsub:${e2}:${exp}`).digest("hex").slice(0, 32);
    return `${exp}.${sig}`;
  })();
  const unsubPath2 = `/unsubscribe?email=${encodeURIComponent(e2)}&token=${unsubToken2}`;
  const formHeaders = { "Content-Type": "application/x-www-form-urlencoded" };
  r = await call(unsubPath2, {
    method: "POST", body: new URLSearchParams({ action: "lowfreq" }).toString(),
    headers: formHeaders,
  });
  check("改为周报返回成功", r.status === 200 && r.text.includes("周报"), r.text.slice(0, 120));
  check("改为周报后仍在名单", (await env.SUBS.get("sub:" + e2)) !== null);
  const e2user = JSON.parse(await env.SUBS.get("user:" + e2));
  check("偏好确实改为 weekly", e2user.prefs.frequency === "weekly");
  r = await call("/api/stats", { headers: { Authorization: "Bearer admin-secret" } });
  check("统计记录降频次数", JSON.parse(r.text).lowFrequency >= 1, r.text);
  r = await call(unsubPath2, {
    method: "POST", body: new URLSearchParams({ action: "unsubscribe", reason: "too_frequent" }).toString(),
    headers: formHeaders,
  });
  check("带原因退订成功", r.status === 200 && r.text.includes("已退订"), r.status);
  check("已移出名单", (await env.SUBS.get("sub:" + e2)) === null);
  r = await call("/api/stats", { headers: { Authorization: "Bearer admin-secret" } });
  const stats = JSON.parse(r.text);
  check("统计记录退订原因", (stats.reasons["邮件太频繁"] || 0) >= 1, JSON.stringify(stats));
  r = await call("/api/stats");
  check("统计接口需鉴权", r.status === 401);

  console.log("\n[28] Resend webhook 验签与自动清理");
  const whKey = Buffer.from("webhook-test-secret");
  const whEnv = {
    ...env,
    RESEND_WEBHOOK_SECRET: "whsec_" + whKey.toString("base64"),
    SUBS: new MockKV(), RATE: new MockDO(),
  };
  await whEnv.SUBS.put("sub:victim@qq.com", JSON.stringify({
    email: "victim@qq.com", createdAt: "2026-11-01", status: "confirmed",
    prefs: { registration: true, review: true, final: true, updates: false, frequency: "instant", pausedUntil: "" },
  }));
  await whEnv.SUBS.put("meta:count", "1");
  const whBody = JSON.stringify({
    type: "email.bounced", data: { to: ["victim@qq.com"], bounce: { type: "Permanent" } },
  });
  const whId = "msg_test_1";
  const whTs = String(Math.floor(Date.now() / 1000));
  const whSig = crypto.createHmac("sha256", whKey)
    .update(`${whId}.${whTs}.${whBody}`).digest("base64");
  const whReq = (sig) => new Request("https://yds.workers.dev/api/webhooks/resend", {
    method: "POST",
    headers: {
      "svix-id": whId, "svix-timestamp": whTs, "svix-signature": "v1," + sig,
      "Content-Type": "application/json",
    },
    body: whBody,
  });
  let wr = await worker.fetch(whReq("invalid-signature"), whEnv);
  check("验签失败 401", wr.status === 401, wr.status);
  wr = await worker.fetch(whReq(whSig), whEnv);
  const wj = await wr.json();
  check("验签成功并清理", wr.status === 200 && wj.ok === true, `${wr.status} ${JSON.stringify(wj)}`);
  check("退信地址已移出名单", (await whEnv.SUBS.get("sub:victim@qq.com")) === null);
  check("写入抑制标记", (await whEnv.SUBS.get("suppressed:victim@qq.com")) !== null);
  wr = await worker.fetch(whReq(whSig), { ...whEnv, RESEND_WEBHOOK_SECRET: "" });
  check("未配置密钥时 fail-closed 503", wr.status === 503, wr.status);

  console.log("\n[29] 关闭 double opt-in 的兼容路径");
  const legacyEnv = { ...env, DOUBLE_OPT_IN: "false", SUBS: new MockKV(), RATE: new MockDO() };
  let lresp = await worker.fetch(new Request("https://yds.workers.dev/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "3.3.3.1" },
    body: JSON.stringify({ email: "legacy@qq.com" }),
  }), legacyEnv);
  check("旧模式登录 200", lresp.status === 200, lresp.status);
  lresp = await worker.fetch(
    new Request("https://yds.workers.dev" + magicPathOf("legacy@qq.com")), legacyEnv,
  );
  check("旧模式点链接直接进名单", (await legacyEnv.SUBS.get("sub:legacy@qq.com")) !== null);

  console.log("\n[30] 确认链接一次性");
  r = await call(confirmPathOf(email));
  check("重复确认返回 400", r.status === 400, r.status);


  console.log("\n[31] AI 字段透传与日历真实事件日");
  const aiPayload = {
    site: "研电赛通知订阅", baseUrl: "https://yds.workers.dev",
    notices: [
      {
        uid: "ai1", title: "关于全国总决赛日程安排的通知",
        url: "https://cpipc.acge.org.cn/x/1", date: "2026-08-05",
        category: "决赛与收官", source: "研创网", summary: "", deadline: "",
        changeKind: "new", aiCategory: "决赛与收官",
        aiSummary: "决赛 8 月 10 日在桐乡举行，<script>alert(1)</script>请勿错过。",
        aiUrgency: "critical", aiReason: "含明确决赛日期", aiVersion: "notices:v1",
        aiConfidence: 0.93,
        aiEvents: [
          { date: "2026-08-10", evidence: "8 月 10 日", label: "决赛举行",
            kind: "event", location: "桐乡", confidence: 0.9 },
          { date: "2026-08-20", evidence: "8 月 20 日", label: "公示截止",
            kind: "deadline", location: "", confidence: 0.8 },
        ],
      },
      {
        uid: "ai2", title: "常规说明", url: "https://cpipc.acge.org.cn/x/2",
        date: "2026-09-01", category: "其他通知", deadline: "",
        aiUrgency: "bogus", aiCategory: "非法分类",
        aiEvents: [{ date: "not-a-date", label: "坏日期", kind: "event" }],
      },
      {
        uid: "ai3", title: "无 AI 结果的历史通知",
        url: "https://cpipc.acge.org.cn/x/3", date: "2026-07-01",
        deadline: "2026-07-20",
      },
    ],
  };
  r = await call("/api/notices", {
    method: "POST", body: JSON.stringify(aiPayload),
    headers: { Authorization: "Bearer admin-secret" },
  });
  check("含 AI 字段的同步 200", r.status === 200, r.text.slice(0, 120));

  r = await call("/archive");
  check("归档页含 AI 摘要", r.text.includes("决赛 8 月 10 日在桐乡举行"));
  check("归档页转义脚本", !r.text.includes("<script>alert(1)</script>")
    && r.text.includes("&lt;script&gt;"));
  check("归档页含真实事件日", r.text.includes("决赛举行：") && r.text.includes("2026-08-10"));
  check("归档页标出重要", r.text.includes("重要"));

  r = await call("/feed.xml");
  check("RSS 含 AI 摘要", r.text.includes("决赛 8 月 10 日在桐乡举行"));
  check("RSS 含事件日", r.text.includes("决赛举行：2026-08-10"));
  check("RSS 标出重要", r.text.includes("【重要】"));

  r = await call(signedCal());
  const ics = r.text;
  check("日历 200", r.status === 200, r.status);
  check("DTSTART 用真实事件日", ics.includes("DTSTART;VALUE=DATE:20260810"));
  check("第二个事件也生成", ics.includes("DTSTART;VALUE=DATE:20260820"));
  check("不再把发布日期当事件日", !ics.includes("DTSTART;VALUE=DATE:20260805"));
  check("非法日期被丢弃并回退发布日期", ics.includes("DTSTART;VALUE=DATE:20260901"));
  check("无 AI 事件时用 deadline", ics.includes("DTSTART;VALUE=DATE:20260720"));
  check("全天事件带 DTEND", ics.includes("DTEND;VALUE=DATE:20260811"));
  check("多事件 UID 带序号", ics.includes("UID:ai1:0@") && ics.includes("UID:ai1:1@"));
  check("单事件 UID 保持不变", ics.includes("UID:ai3@") && !ics.includes("UID:ai3:0@"));
  check("地点写入 LOCATION", ics.includes("LOCATION:桐乡"));
  check("critical 写进 SUMMARY", ics.includes("【重要】"));
  check("原文日期写入 DESCRIPTION", ics.includes("原文日期：8 月 10 日"));
  check("SEQUENCE 非零", /SEQUENCE:[1-9]/.test(ics));
  check("VEVENT 共 4 个", (ics.match(/BEGIN:VEVENT/g) || []).length === 4,
    String((ics.match(/BEGIN:VEVENT/g) || []).length));
  check("ICS 全 CRLF", !/(^|[^\r])\n/.test(ics));

  // 同一份数据重复同步，UID 与 SEQUENCE 必须稳定（延期时原地更新、不留重复）
  await call("/api/notices", {
    method: "POST", body: JSON.stringify(aiPayload),
    headers: { Authorization: "Bearer admin-secret" },
  });
  const ics2 = (await call(signedCal())).text;
  const seqs = (s) => (s.match(/SEQUENCE:\d+/g) || []).join("|");
  check("重复同步 SEQUENCE 稳定", seqs(ics) === seqs(ics2));
  check("重复同步不产生重复事件",
    (ics2.match(/BEGIN:VEVENT/g) || []).length === 4);

  console.log("\n[32] 人员视角字段与官方赛程");

  const personaPayload = {
    site: "研电赛通知订阅",
    baseUrl: "https://yds.workers.dev",
    notices: [
      {
        uid: "p1",
        title: "关于报名截止的通知",
        url: "https://cpipc.acge.org.cn/x/p1",
        date: "2026-11-01",
        category: "报名参赛",
        source: "研创网",
        summary: "",
        deadline: "2026-11-25",
        contest: "电子设计竞赛",
        stage: "报名",
        audiences: ["student", "advisor", "hacker"],
        action: "<b>在 11 月 25 日前完成报名</b>",
        aiUrgency: "high",
        aiEvents: [
          {
            date: "2026-11-25", evidence: "11月25日", label: "报名截止",
            kind: "deadline", location: "", confidence: 0.9,
          },
        ],
      },
    ],
    schedule: [
      {
        contest: "电子设计竞赛",
        signupStart: "2026-04-03",
        signupEnd: "2026-11-25",
        submitStart: "",
        submitEnd: "",
        finalStart: "2026-12-01",
        finalEnd: "2026-12-03",
        sourceUrl: "https://cpipc.acge.org.cn/x/schedule",
      },
      {
        contest: "非法赛事",
        signupEnd: "not-a-date",
      },
    ],
  };

  r = await call("/api/notices", {
    method: "POST", body: JSON.stringify(personaPayload),
    headers: { Authorization: "Bearer admin-secret" },
  });
  check("视角与赛程同步 200", r.status === 200, r.text.slice(0, 120));
  check("返回合法赛程数", r.text.includes('"schedule":1'), r.text.slice(0, 200));

  r = await call("/archive");
  check("归档显示阶段", r.text.includes("报名"), r.text.slice(0, 200));
  check("归档显示人群", r.text.includes("面向：")
    && r.text.includes("参赛学生") && r.text.includes("指导教师"));
  check("非法人群被丢弃", !r.text.includes("hacker"));
  check("归档显示行动建议", r.text.includes("要做什么："));
  check("行动建议被转义", r.text.includes("&lt;b&gt;") && !r.text.includes("<b>在 11 月"));

  r = await call(signedCal());
  const ics3 = r.text;
  check("赛程生成报名截止事件", ics3.includes("【报名截止】电子设计竞赛"));
  check("赛程生成决赛事件", ics3.includes("【决赛开始】电子设计竞赛"));
  check("赛程 UID 稳定前缀", ics3.includes("UID:schedule:电子设计竞赛:"));
  check("非法赛程日期被丢弃", !ics3.includes("not-a-date"));
  check("截止事件带 7 天提醒", ics3.includes("TRIGGER:-P7D"));
  check("截止事件带 1 天提醒", ics3.includes("TRIGGER:-P1D"));
  check("通知截止事件带 3 天提醒", ics3.includes("TRIGGER:-P3D"));
  check("SUMMARY 带阶段标签", ics3.includes("【报名】[报名参赛]"));
  check("VALARM 结构完整", (ics3.match(/BEGIN:VALARM/g) || []).length
    === (ics3.match(/END:VALARM/g) || []).length);

  console.log("\n[33] 角色与赛事偏好");

  // 前面的用例已登出并注销了原账号，这里造一个独立的已确认订阅者
  const pEmail = "persona@qq.com";
  const nowIso = new Date().toISOString();
  await env.SUBS.put(
    `user:${pEmail}`,
    JSON.stringify({ email: pEmail, createdAt: nowIso, lastLogin: nowIso, status: "confirmed" }),
  );
  await env.SUBS.put(
    `sub:${pEmail}`,
    JSON.stringify({ email: pEmail, createdAt: nowIso, status: "confirmed" }),
  );

  const freshSid = "f".repeat(64);
  const sidDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(freshSid));
  const sidHash = [...new Uint8Array(sidDigest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.SUBS.put(
    `session:${sidHash}`,
    JSON.stringify({ email: pEmail, exp: Date.now() + 3600_000 }),
    { expirationTtl: 3600 },
  );

  r = await call("/api/prefs", {
    method: "POST",
    body: JSON.stringify({
      audiences: { student: true, advisor: true, admin: false, organizer: false },
      contests: ["电子设计竞赛", "人工智能创新大赛"],
      frequency: "daily",
    }),
    headers: { Cookie: `yds_sid=${freshSid}` },
  });
  const pj3 = JSON.parse(r.text);
  check("角色偏好保存 200", r.status === 200, r.text);
  check("管理员角色已关", pj3.prefs.audiences.admin === false && pj3.prefs.audiences.student === true);
  check("赛事列表已保存", pj3.prefs.contests.length === 2 && pj3.prefs.contests.includes("人工智能创新大赛"));
  const saved3 = JSON.parse(await env.SUBS.get("user:" + pEmail));
  check("角色落 KV", saved3.prefs.audiences.advisor === true && saved3.prefs.audiences.organizer === false);
  check("赛事落 KV", saved3.prefs.contests.includes("电子设计竞赛"));

  r = await call("/api/prefs", {
    method: "POST",
    body: JSON.stringify({ audiences: ["student"], contests: ["不存在的比赛", "电子设计竞赛"] }),
    headers: { Cookie: `yds_sid=${freshSid}` },
  });
  const pj4 = JSON.parse(r.text);
  check("数组形态角色被接受", pj4.prefs.audiences.student === true
    && pj4.prefs.audiences.admin === false, JSON.stringify(pj4.prefs.audiences));
  check("非法赛事被过滤", pj4.prefs.contests.length === 1
    && pj4.prefs.contests[0] === "电子设计竞赛", JSON.stringify(pj4.prefs.contests));

  // 恢复角色设置，避免影响后续日历 / 归档过滤断言
  await call("/api/prefs", {
    method: "POST",
    body: JSON.stringify({
      audiences: { student: true, advisor: true, admin: true, organizer: true },
    }),
    headers: { Cookie: `yds_sid=${freshSid}` },
  });

  r = await call("/", { headers: { Cookie: `yds_sid=${freshSid}` } });
  check("控制台含「我的角色」", r.text.includes("我的角色"));
  check("控制台含四类角色", ["参赛学生", "指导教师", "培养单位", "分赛区 / 承办方"]
    .every((k) => r.text.includes(k)));
  check("控制台含「关注的赛事」", r.text.includes("关注的赛事"));
  check("控制台列出全部赛事", r.text.includes("智能建造创新大赛") && r.text.includes("数学建模竞赛"));
  check("控制台有快捷选择", r.text.includes("只选研电赛") && r.text.includes("全选"));
  check("赛事勾选可提交", r.text.includes('name="contest" value="电子设计竞赛"'));

  r = await call("/api/list", { headers: { Authorization: "Bearer admin-secret" } });
  const listJson3 = JSON.parse(r.text);
  const me = (listJson3.subscribers || []).find((s) => s.email === pEmail);
  check("/api/list 含该订阅者", !!me, r.text.slice(0, 160));
  check("/api/list 下发角色数组", Array.isArray(me.audiences)
    && me.audiences.includes("student") && me.audiences.includes("admin"), JSON.stringify(me.audiences));
  check("/api/list 下发赛事数组", Array.isArray(me.contests) && me.contests.includes("电子设计竞赛"));

  r = await call("/archive?contest=" + encodeURIComponent("电子设计竞赛"));
  check("归档按赛事筛选命中", r.text.includes("关于报名截止的通知"));
  r = await call("/archive?contest=" + encodeURIComponent("人工智能创新大赛"));
  check("归档按赛事筛选为空", r.text.includes("没有符合筛选条件的通知"));
  r = await call("/archive?audience=admin");
  check("归档按角色筛选为空", r.text.includes("没有符合筛选条件的通知"));

  r = await call(signedCal() + "&contest=" + encodeURIComponent("电子设计竞赛"));
  check("日历按赛事筛选保留事件", r.text.includes("UID:p1@"));
  r = await call(signedCal() + "&contest=" + encodeURIComponent("人工智能创新大赛"));
  check("日历按赛事筛选排除事件", !r.text.includes("UID:p1@"));
  r = await call(signedCal() + "&contest=" + encodeURIComponent("电子设计竞赛") + "&audience=student");
  check("角色链接仍保留赛程", r.text.includes("【报名截止】电子设计竞赛"));

  console.log("\n[33b] 公共日历已下线");
  r = await call("/calendar.ics");
  check("无签名日历 401", r.status === 401, String(r.status));
  check("401 提示去控制台领取", r.text.includes("个人订阅地址"));
  r = await call("/calendar.ics?email=reader%40example.com&token=1.bad");
  check("坏签名 401", r.status === 401, String(r.status));
  r = await call(signedCal("reader@example.com", "unsub"));
  check("退订 token 不能当日历用", r.status === 401, String(r.status));

  console.log("\n[34] 个人日历：按订阅者偏好过滤");

  // 与 Worker 的 signEmailToken 保持同一契约：sig = hmac(secret, `${purpose}:${email}:${exp}`)[:32]
  const emailToken = (email, purpose, ttlDays = 3650) => {
    const exp = Math.floor(Date.now() / 1000) + ttlDays * 86400;
    const sig = crypto
      .createHmac("sha256", env.UNSUB_SECRET)
      .update(`${purpose}:${email.toLowerCase()}:${exp}`)
      .digest("hex")
      .slice(0, 32);
    return `${exp}.${sig}`;
  };
  const calUrl = (email, purpose = "cal") =>
    `/calendar.ics?email=${encodeURIComponent(email)}&token=${emailToken(email, purpose)}`;

  // 先把这位订阅者的偏好恢复成「研电赛 + 全角色」
  await call("/api/prefs", {
    method: "POST",
    body: JSON.stringify({
      audiences: { student: true, advisor: true, admin: true, organizer: true },
      contests: ["电子设计竞赛"],
    }),
    headers: { Cookie: `yds_sid=${freshSid}` },
  });

  r = await call(calUrl(pEmail));
  check("签名日历 200", r.status === 200 && r.text.includes("BEGIN:VCALENDAR"), r.status);
  check("个人日历包含关注赛事的事件", r.text.includes("UID:p1@"));
  check("个人日历名标出角色", r.text.includes("参赛学生"), r.text.slice(0, 400));
  check("个人日历仍带官方赛程", r.text.includes("【报名截止】电子设计竞赛"));

  // 改成只关注别的赛事 → 该公告的事件必须消失，公开日历不受影响
  await call("/api/prefs", {
    method: "POST",
    body: JSON.stringify({ contests: ["人工智能创新大赛"] }),
    headers: { Cookie: `yds_sid=${freshSid}` },
  });
  r = await call(calUrl(pEmail));
  check("未关注赛事的事件被过滤", !r.text.includes("UID:p1@"));
  check("赛程随赛事偏好收敛", !r.text.includes("【报名截止】电子设计竞赛"));
  r = await call(signedCal());
  check("签名日历始终返回 200", r.status === 200 && r.text.includes("UID:p1@"));

  // 角色过滤：只留培养单位 → student/advisor 的通知被过滤
  await call("/api/prefs", {
    method: "POST",
    body: JSON.stringify({
      audiences: { student: false, advisor: false, admin: true, organizer: false },
      contests: ["电子设计竞赛"],
    }),
    headers: { Cookie: `yds_sid=${freshSid}` },
  });
  r = await call(calUrl(pEmail));
  check("角色不符的事件被过滤", !r.text.includes("UID:p1@"));
  check("赛程按赛事保留", r.text.includes("【报名截止】电子设计竞赛"));

  // 用途隔离：退订 token 不能当个人日历 token 用，直接 401（不再退回公开日历）
  r = await call(calUrl(pEmail, "unsub"));
  check("退订 token 不能读个人日历", r.status === 401, String(r.status));

  // 签名被篡改 → 同样 401，不泄露任何日程
  // 注意：不能直接改末位为 "0"——真签名末位本来就是 0 时等于没改，会误判成 200
  const goodCalToken = emailToken(pEmail, "cal");
  const tamperedToken = goodCalToken.slice(0, -1) + (goodCalToken.endsWith("0") ? "1" : "0");
  r = await call(`/calendar.ics?email=${encodeURIComponent(pEmail)}&token=${tamperedToken}`);
  check("篡改签名 401", r.status === 401, String(r.status));

  // 控制台给出个人日历地址
  r = await call("/dashboard", { headers: { Cookie: `yds_sid=${freshSid}` } });
  check("控制台含「我的日历」", r.text.includes("我的日历"));
  check("控制台日历地址带签名", r.text.includes("calendar.ics?email=") && r.text.includes("token="));

  console.log("\n[35] KV 读取次数：同一份数据只读一次");

  // 先写一次触发缓存失效，保证从冷态开始计数
  await call("/api/notices", {
    method: "POST", body: JSON.stringify(personaPayload),
    headers: { Authorization: "Bearer admin-secret" },
  });

  env.SUBS.reads = 0;
  r = await call(signedCal());
  const firstReads = env.SUBS.reads;
  check("首次日历 2 次读（通知/赛程合并 1 次 + 偏好 1 次）", firstReads === 2, String(firstReads));

  env.SUBS.reads = 0;
  await call(signedCal());
  check("60 秒内再次拉日历只读 1 次（仅偏好）", env.SUBS.reads === 1, String(env.SUBS.reads));

  env.SUBS.reads = 0;
  await call("/archive");
  check("归档页共用同一份缓存", env.SUBS.reads === 0, String(env.SUBS.reads));

  env.SUBS.reads = 0;
  await call(calUrl(pEmail));
  const personalReads = env.SUBS.reads;
  check("已存在订阅者同样只多读 1 次", personalReads === 1, String(personalReads));

  // 写入必须让缓存失效，否则归档 / 日历会长期显示旧数据
  env.SUBS.reads = 0;
  await call("/api/notices", {
    method: "POST", body: JSON.stringify(personaPayload),
    headers: { Authorization: "Bearer admin-secret" },
  });
  r = await call("/archive");
  check("写入后缓存已失效", env.SUBS.reads >= 1, String(env.SUBS.reads));
  check("写入后归档内容正确", r.text.includes("关于报名截止的通知"));

  console.log("\n[36] 归档页新版式（Memphis 设计）");

  r = await call("/archive");
  check("归档用独立整页版式", r.text.includes('class="container"') && r.text.includes('class="header"'));
  check("归档标题带高亮块", r.text.includes("研电赛<span class=\"hl\">通知</span>"));
  check("归档有统计条", r.text.includes('class="stats"') && r.text.includes("项赛事"));
  check("归档有赛事筛选", r.text.includes("赛事筛选") && r.text.includes('class="cscr"'));
  check("归档有分类筛选", r.text.includes("通知分类"));
  check("归档有视图切换", r.text.includes("通知列表") && r.text.includes("日历视图"));
  check("归档有导出栏", r.text.includes('class="ebar"') && r.text.includes("订阅 RSS"));
  check("归档点阵背景样式", r.text.includes("radial-gradient"));
  check("归档不引入公开日历链接", !r.text.includes('href="/calendar.ics"'));

  r = await call("/archive?category=" + encodeURIComponent("报名参赛"));
  check("分类筛选命中", r.text.includes("关于报名截止的通知"));
  check("分类筛选项高亮", r.text.includes('class="fb act"'));
  r = await call("/archive?category=" + encodeURIComponent("不存在的分类"));
  check("分类筛选为空提示", r.text.includes("没有符合筛选条件的通知"));

  r = await call("/archive?important=1");
  check("只看重要命中高优通知", r.text.includes("关于报名截止的通知") && r.text.includes("重要"));

  r = await call("/archive?view=cal&m=2026-11");
  check("日历视图渲染月历", r.text.includes('class="calv"') && r.text.includes("2026 年 11 月"));
  check("日历视图含当月事件", r.text.includes("2026-11-25"));
  check("日历视图有图例", r.text.includes("截止日期") && r.text.includes("赛事活动"));

  console.log("\n[37] 日历视图增强（来源 / 定位 / 月份快切）");

  check("日历格显示来源与节点", r.text.includes("<b>报名截止</b>") && r.text.includes("<em>研创网</em>"),
    r.text.slice(0, 200));
  check("日历格可跳到当天", r.text.includes('href="#d-2026-11-25"'));
  check("当天日程分组带锚点", r.text.includes('id="d-2026-11-25"'));
  check("日历节点链回公告原文", r.text.includes("https://cpipc.acge.org.cn/x/p1"));
  check("官方赛程也进日历", r.text.includes("官方赛程") && r.text.includes("<em>电子设计竞赛</em>"));
  check("月份快选有 12 个月", (r.text.match(/class="cm[ "]/g) || []).length === 12);
  check("月份快选可切年", r.text.includes('aria-label="上一年"') && r.text.includes('aria-label="下一年"'));
  check("月份导航含上月下月", r.text.includes("‹ 上月") && r.text.includes("下月 ›"));
  check("日历顶栏给出统计", r.text.includes("个节点") && r.text.includes("覆盖"));
  check("移除刷新列表按钮", !r.text.includes("刷新列表"));

  r = await call("/archive?view=cal&m=2026-12");
  check("切月显示该月赛程", r.text.includes("2026 年 12 月") && r.text.includes("决赛开始"));

  // 筛选条件在翻月时必须保留，否则用户每翻一次就要重选赛事
  r = await call("/archive?view=cal&m=2026-11&contest=" + encodeURIComponent("电子设计竞赛"));
  const nextMonthLink = (r.text.match(/href="([^"]*m=2026-12[^"]*)"/) || [])[1] || "";
  check("翻月保留赛事筛选", nextMonthLink.includes("contest=") && nextMonthLink.includes("view=cal"),
    nextMonthLink);

  r = await call("/archive?contest=" + encodeURIComponent("<script>alert(1)</script>"));
  check("筛选参数被转义", !r.text.includes("<script>alert(1)</script>"));

  console.log("\n[38] 日历只收真实日期（不占用发布日期）");

  // 一条只有发布日、没有任何事件/截止的「动态」，不该在发布当天占一个假日程；
  // 只有 deadline 的公告仍应作为「截止」出现。
  await call("/api/notices", {
    method: "POST",
    body: JSON.stringify({
      notices: [
        {
          uid: "n1", title: "纯动态：决赛现场花絮", url: "https://cpipc.acge.org.cn/x/n1",
          date: "2026-11-09", category: "赛事动态", source: "研创网", summary: "花絮", deadline: "",
        },
        {
          uid: "n2", title: "只有截止日的通知", url: "https://cpipc.acge.org.cn/x/n2",
          date: "2026-11-02", category: "报名参赛", source: "研创网", summary: "", deadline: "2026-11-10",
        },
      ],
      schedule: [],
    }),
    headers: { Authorization: "Bearer admin-secret" },
  });
  r = await call("/archive?view=cal&m=2026-11");
  check("无日期动态不占发布日", !r.text.includes('id="d-2026-11-09"'));
  check("只有截止日的通知以截止进日历",
    r.text.includes('id="d-2026-11-10"') && r.text.includes("<b>截止</b>"));

  console.log(`\n结果：${pass} 项通过${process.exitCode ? "，存在失败" : "，全部通过"}`);
})();
