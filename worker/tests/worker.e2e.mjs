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
  }
  async get(k) {
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
  MAX_PER_IP_HOUR: "3",
  MAX_CONFIRM_PER_DAY: "60",
  LIST_RATE_PER_HOUR: "60",
  // Bindings
  SUBS: new MockKV(),
  RATE: new MockDO(),
};

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

/** 从最近一封发给该邮箱的信里取出魔法链接 */
const magicPathOf = (email) => {
  const m = sent.filter((x) => x.to[0] === email).pop();
  assert.ok(m, `没有发给 ${email} 的邮件`);
  const raw = m.html.match(/href="([^"]*\/login\?n=[^"]*)"/)[1].replace(/&amp;/g, "&");
  const u = new URL(raw);
  return u.pathname + u.search;
};

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
  check("自动加入订阅列表", (await env.SUBS.get("sub:" + email)) !== null);
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

  console.log("\n[12] IP 限流（每 IP 每小时 3 次）");
  const ip = "7.7.7.7";
  const results = [];
  for (let i = 0; i < 4; i++) {
    const rr = await post("/api/login", { email: `x${i}@qq.com` }, ip);
    results.push(rr.status);
  }
  check("前 3 次放行", results.slice(0, 3).every((s) => s === 200), results.join(","));
  check("第 4 次 429", results[3] === 429, results[3]);

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

  console.log(`\n结果：${pass} 项通过${process.exitCode ? "，存在失败" : "，全部通过"}`);
})();
