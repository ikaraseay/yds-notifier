# Cloudflare 自动构建部署指南（连接 GitHub + 自定义域名）

```
git push main
      ↓
Cloudflare Workers Builds 自动拉取仓库
      ↓  Root directory = worker
      ↓  npm ci && npm run sync-config && npm run build
      ↓     sync-config：从 .env / 构建变量同步自定义域名与 KV id 到 wrangler.toml
      ↓     build：esbuild 把界面层 + 后端逻辑层打成 dist/index.js
      ↓  npx wrangler deploy
      ↓
Worker 上线：https://<CUSTOM_DOMAIN>  与  https://<name>.<子域>.workers.dev
```

Python 端仍跑在 GitHub Actions，两者通过共享密钥 + `/api/list` 协作。

---

## 一、新的配置模型：`.env` 是唯一事实源

根目录 `.env`（模板 `.env.example`）只填一次，其余全部自动派生：

| 派生项 | 规则 |
|---|---|
| `PUBLIC_BASE_URL` | 显式值 → `https://<CUSTOM_DOMAIN>` → `<WORKERS_DEV_URL>` |
| `UNSUB_URL` | `<生效地址>/unsubscribe` |
| `SUBSCRIBE_API_URL` | `<生效地址>/api/list` |
| `MAIL_FROM` | `MAIL_FROM_NAME <MAIL_FROM_ADDRESS>` |

跨平台共享的密钥改为**同名同值**：`SUBSCRIBE_API_TOKEN` 在 Cloudflare 与 GitHub 用同一个名字填同一个值（旧的 `ADMIN_TOKEN` 仍被 Worker 兼容，但新部署不用填）。

> **`.env` 不会被 Cloudflare 读取**。生产运行时配置填 Dashboard → Variables and Secrets；
> `.env` 里的 `CUSTOM_DOMAIN` / `KV_SUBS_ID` 通过 `npm run sync-config` 在**构建期**写进 `wrangler.toml`。
> Wrangler 本地只认 `worker/` 同目录的 `.dev.vars`（模板 `worker/.dev.vars.example`）。

---

## 二、自定义域名

### 2.1 前提

Custom Domain 要求该域名有一个**已接入 Cloudflare 的 zone**（把域名的 NS 改到 Cloudflare 即可，免费套餐够用）。绑定后 Cloudflare 会**自动创建 DNS 记录并签发证书**，不需要自己配 CNAME、不需要管证书续期。

### 2.2 三种用法

| 场景 | `.env` 怎么填 | 结果 |
|---|---|---|
| 只用 workers.dev | `CUSTOM_DOMAIN=""`，`WORKERS_DEV_URL="https://xxx.workers.dev"` | 只部署到 workers.dev |
| **推荐：自定义域名** | `CUSTOM_DOMAIN="notice.example.com"`，`WORKERS_DEV_URL` 保留 | 自动加 `[[routes]] custom_domain = true`，两个入口都能访问 |
| 反向代理 / 带路径 | 额外 `PUBLIC_BASE_URL="https://example.com/yds"` | 以显式值生成所有对外链接 |

切换顺序建议「**先部署、后绑域名**」：首次部署时 `CUSTOM_DOMAIN` 留空，用 workers.dev 验证登录与退订；DNS 生效后再填 `CUSTOM_DOMAIN` 并触发一次部署，所有邮件里的链接会自动换成新域名。

### 2.3 `sync-config` 会生成什么

```bash
cd worker
CUSTOM_DOMAIN=notice.example.com KV_SUBS_ID=<你的KV_ID> npm run sync-config
```

`wrangler.toml` 的 AUTO-CONFIG 区块会被同步成：

```toml
[[kv_namespaces]]
binding = "SUBS"
# --- BEGIN AUTO-CONFIG ---
id = "<你的KV_ID>"

[[routes]]
pattern = "notice.example.com"
custom_domain = true
# --- END AUTO-CONFIG ---
```

- `custom_domain = true` 是 Cloudflare 的 Custom Domain 写法（不用配 DNS、不用管证书）
- `workers_dev = true` 显式保留 workers.dev —— **有 routes 时 Cloudflare 默认会关掉它**，不写这行会导致过渡期旧链接失效
- 想关掉自定义域名：`CUSTOM_DOMAIN=none npm run sync-config`，区块会收回成只有 KV id
- 本地 `npm run deploy` 会自动执行 sync-config；CI 上由 Build command 执行

### 2.4 域名生效后的连锁变化（无需逐项改）

| 位置 | 自动变成 |
|---|---|
| 登录邮件里的魔法链接 | `https://<CUSTOM_DOMAIN>/login?n=...` |
| 邮件底部退订 / `List-Unsubscribe` 头 | `https://<CUSTOM_DOMAIN>/unsubscribe?...` |
| GitHub Actions 拉取名单 | `https://<CUSTOM_DOMAIN>/api/list` |
| 站长通知邮件里的「打开订阅页」 | `https://<CUSTOM_DOMAIN>` |

安全上不因此放松：所有对外链接仍**只由配置生成，不信任请求 Host**；CSRF 的 Origin 白名单会自动包含自定义域与 workers.dev 两个来源，所以从任一入口访问控制台都能正常保存偏好，第三方来源仍返回 403。

---

## 三、Cloudflare 需要填写的环境信息

### 3.1 Settings → Variables and Secrets → **Secrets**（加密）

| 名称 | 值 | 说明 |
|---|---|---|
| `UNSUB_SECRET` | `openssl rand -hex 32` | **必填**，与 GitHub 同名同值 |
| `RESEND_API_KEY` | `re_...` | **必填** |
| `SUBSCRIBE_API_TOKEN` | 另一个 `openssl rand -hex 32` | **必填**，与 GitHub 同名同值（旧名 `ADMIN_TOKEN` 仍兼容） |
| `UNSUB_SECRET_PREVIOUS` | 旧签名密钥 | 可选，密钥轮换期使用 |
| `RESEND_WEBHOOK_SECRET` | `whsec_...` | 可选，Resend Webhook 签名密钥；留空时 webhook 端点返回 503（fail-closed） |

### 3.2 Settings → Variables and Secrets → **Variables**（明文）

| 名称 | 示例 | 必填 | 说明 |
|---|---|---|---|
| `CUSTOM_DOMAIN` | `notice.example.com` | 否 | 自定义域名，纯 hostname。填了即自动作为对外地址 |
| `WORKERS_DEV_URL` | `https://yds-unsubscribe.xxx.workers.dev` | 否（无自定义域时必填） | 兜底地址 + CSRF 白名单 |
| `PUBLIC_BASE_URL` | 留空 | 否 | 高级覆盖，一般不用填 |
| `MAIL_FROM_ADDRESS` | `notice@meovo.cc` | **是** | 纯地址，属于 Resend 已验证域名；**与 `CUSTOM_DOMAIN` 无关**，站点用子域、发件用根域是允许的 |
| `MAIL_TO` | `you@qq.com` | **是** | 站长邮箱 |
| `MAIL_FROM_NAME` | `研电赛通知` | 否 | 发件人显示名 |
| `SITE_NAME` | `研电赛通知订阅` | 否 | 页面/邮件标题 |
| `UNSUB_TTL_DAYS` | `180` | 否 | 退订链接有效天数，与 GitHub 同值 |
| `MAX_PER_IP_HOUR` / `MAX_CONFIRM_PER_DAY` / `LIST_RATE_PER_HOUR` | `10` / `200` / `60` | 否 | 限流参数 |
| `DOUBLE_OPT_IN` | `true` | 否 | 首次订阅需二次确认；填 `false` 回到「点登录链接即订阅」 |

> `CUSTOM_DOMAIN`、`WORKERS_DEV_URL`、`PUBLIC_BASE_URL` 三者至少填一个，否则 Worker 会因
> 无法确定对外地址而 fail-closed（登录接口返回 500，日志里能看到明确提示）。

### 3.2.1 Resend Webhook（可选，推荐）

在 Resend → **Webhooks** 添加端点 `https://<站点>/api/webhooks/resend`，
事件勾选 `email.bounced`、`email.complained`、`suppression.added`，
把生成的 **Signing Secret**（`whsec_...`）填为 Cloudflare Secret `RESEND_WEBHOOK_SECRET`。
Worker 会按 Svix 规范验签（时间戳 ±5 分钟防重放），验证通过后把该邮箱移出名单并写入抑制标记。
未配置密钥时端点直接 503，不会被伪造请求删订阅者。

### 3.2.2 告警与心跳（可选，GitHub 侧）

`ALERT_WEBHOOK_URL` 填失败时接收 POST JSON 的 webhook（企业微信 / 飞书 / Slack 等），
未配置时失败运行会显式 `::error::` 而不会静默通过；
`HEARTBEAT_URL` 填外部 dead-man switch 的 ping 地址，成功运行会打一次心跳，
「该来没来」即告警，可覆盖定时任务被 60 天规则禁用与抓取静默停摆。

### 3.3 Bindings（不是环境变量）

| 绑定 | 类型 | 在哪配 |
|---|---|---|
| `SUBS` | KV Namespace | `KV_SUBS_ID` 由 `npm run sync-config` 写进 `wrangler.toml` 的 AUTO-CONFIG 区块 |
| `RATE` | Durable Object | `wrangler.toml`（class `RateLimiter` + `v1` migration，已写好） |

### 3.4 Settings → **Build**（连接 GitHub）

| 字段 | 值 |
|---|---|
| Git repository / Production branch | 你的仓库 / `main` |
| **Root directory** | `worker` |
| **Build command** | `npm ci && npm run sync-config && npm run build` |
| **Deploy command** | `npx wrangler deploy` |
| Preview command | `npx wrangler versions upload`（启用预览时） |
| API token | 用 Cloudflare 自动生成的即可（已含 Workers Routes 编辑权限） |
| **Build variables and secrets** | `KV_SUBS_ID`（必填）；用自定义域名时再加 `CUSTOM_DOMAIN` |

> ⚠️ **Build variables 只在构建期可见，运行时读不到**。它们仅用于让 `sync-config` 生成
> `wrangler.toml`；上面 3.1 / 3.2 的运行时变量必须填在 Variables and Secrets。
> 反之，把密钥填进 Build variables 也不会生效。

### 3.5 已移除 / 无需再填

| 变量 | 说明 |
|---|---|
| `ADMIN_TOKEN`、`UNSUB_URL`、`SUBSCRIBE_API_URL` | 分别由 `SUBSCRIBE_API_TOKEN` 与域名派生取代；代码仍兼容旧值 |
| `GITHUB_TOKEN`、`GITHUB_OWNER`、`GITHUB_REPO`、`WORKFLOW_FILE` | 删除全局退订后，Worker 不再持有任何 GitHub 凭据 |

---

## 四、GitHub Actions 需要填的 Secrets

| Secret | 值 | 与 Cloudflare 的关系 |
|---|---|---|
| `CUSTOM_DOMAIN` | `notice.example.com` | **与 3.2 同值**（不用自定义域时改填 `WORKERS_DEV_URL`） |
| `WORKERS_DEV_URL` | `https://xxx.workers.dev` | 兜底，可选 |
| `UNSUB_SECRET` | 同 3.1 | **完全一致** |
| `SUBSCRIBE_API_TOKEN` | 同 3.1 | **同名同值** |
| `RESEND_API_KEY` / `MAIL_FROM_ADDRESS` / `MAIL_TO` | 发信与收件人 | 同 3.1 / 3.2 |
| `UNSUB_TTL_DAYS` | `180` | 同 3.2 |
| `MAIL_PROVIDER` / `MAIL_FROM_NAME` / `SITE_NAME` / `REPLY_TO` | 文案类 | 可选 |
| `SMTP_*` | 仅 `MAIL_PROVIDER=smtp` | 可选 |
| `PUBLISH_NOTICES` / `NOTICES_API_URL` | `true` / 留空自动派生 | 归档 / RSS / 日历同步开关，可选 |
| `HEARTBEAT_URL` / `ALERT_WEBHOOK_URL` | 外部拨测 / 告警地址 | 失败可见性，可选 |

`UNSUB_URL` / `SUBSCRIBE_API_URL` 已由 `CUSTOM_DOMAIN` 自动派生，新部署不用填；旧部署若填过，仍会作为显式覆盖优先生效。

### 一致性核对

1. `UNSUB_SECRET`：两边完全一致（不一致 → 退订链接全部 400）
2. `SUBSCRIBE_API_TOKEN`：两边同名同值（不一致 → Actions 拉名单 401）
3. `CUSTOM_DOMAIN`：两边同值；若 GitHub 侧用了显式 `PUBLIC_BASE_URL`，必须与 Cloudflare 的对外地址一致
4. `RESEND_WEBHOOK_SECRET` 只在 Cloudflare（Webhook 由 Worker 直接接收），且必须与 Resend 端点显示的签名密钥一致
4. `MAIL_FROM_ADDRESS` 属于 Resend 已验证域名。发件域名与 `CUSTOM_DOMAIN` **不必相同**：本项目站点在 `notice.yds.meovo.cc`（子域），发件用 `notice@meovo.cc`（根域），只要 Resend 验证的是 `meovo.cc` 即可。改完 `.env` 用 `bash scripts/ops.sh secrets` 一次同步两端

---

## 五、部署步骤

1. 生成密钥、创建 KV（`cd worker && npx wrangler kv namespace create SUBS`）
2. 在根目录 `.env` 填 `CUSTOM_DOMAIN`、`WORKERS_DEV_URL`、`KV_SUBS_ID` 等
3. `cd worker && npm run sync-config` 把域名与 KV id 写进 `wrangler.toml`，提交推送
4. Cloudflare Dashboard → Worker → **Settings → Builds → Connect to Git**，按 3.4 填 Build 配置与 Build variables
5. 按 3.1 / 3.2 填 Variables and Secrets；按第四节填 GitHub Secrets
6. 触发首次构建。若 `CUSTOM_DOMAIN` 对应的 zone 已在 Cloudflare，部署会自动创建 DNS 与证书
7. 验证：

```bash
curl https://notice.example.com/health                       # → ok
curl https://yds-unsubscribe.xxx.workers.dev/health          # → ok（workers_dev = true）
curl -H "Authorization: Bearer <SUBSCRIBE_API_TOKEN>" \
     https://notice.example.com/api/list                    # → {"ok":true,...}
```

> 也可以在 Dashboard → **Settings → Domains & Routes → Add → Custom Domain** 手动绑定，
> 效果与 `[[routes]]` 相同；二选一即可，不要两处重复添加同一个域名。

---

## 六、本地开发与验证

```bash
# Worker
cd worker
cp .dev.vars.example .dev.vars     # PUBLIC_BASE_URL=http://localhost:8787
npm ci
npm run sync-config                # 从根目录 .env 同步域名与 KV id
npm run check                      # 类型检查 + 端到端测试
npm run dev                        # http://localhost:8787

# Python（仓库根目录）
cp .env.example .env
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m yds.selftest   # 含域名派生、退订签名、收件人校验
.venv/bin/python -m yds --dry-run
```

`npm run check` 与 `python -m yds.selftest` 在 CI 中自动执行。

---

## 七、排错

| 现象 | 原因 |
|---|---|
| 登录返回 500 | `CUSTOM_DOMAIN` / `WORKERS_DEV_URL` / `PUBLIC_BASE_URL` 三者都没配（对外地址 fail-closed）；看 `wrangler tail` |
| 登录后收不到邮件 | `RESEND_API_KEY` / `MAIL_FROM_ADDRESS` 未填或域名未验证 |
| 点登录链接进不去 | `PUBLIC_BASE_URL` 与 `CUSTOM_DOMAIN` 冲突，或 DNS / 证书还没生效；过渡期先用 workers.dev |
| 绑定自定义域后 workers.dev 404 | `workers_dev` 被设成 false；本项目的 wrangler.toml 显式设为 true |
| 自定义域保存偏好提示「请求来源不合法」 | `WORKERS_DEV_URL` 没填，CSRF 白名单缺少该来源 |
| 退订链接 400 | `UNSUB_SECRET` 两边不一致、`UNSUB_TTL_DAYS` 差异过大，或链接过期 |
| 构建报找不到 `dist/index.js` | Build command 没执行或 Root directory 不是 `worker` |
| 部署报 KV namespace 无效 | 没填 Build variable `KV_SUBS_ID`，或本地没跑 `sync-config` |
| 运行时读不到变量 | 变量填进了 Build variables，应移到 Variables and Secrets |

---

## 八、安全说明

本次改造同步修复了 3 项严重、5 项高危问题（退订链接失效、全局退订可停掉所有人推送、Host 头注入、内部错误回显、CSRF/method 校验缺失、CSP nonce 化等），完整清单见 **[安全评审报告](安全评审报告.md)**。

Worker 不持有任何 GitHub 凭据；所有对外链接只由配置派生；自定义域名与 workers.dev 并存时，CSRF 白名单自动覆盖两个入口，其余来源一律拒绝。
