# 研电赛通知邮件订阅器

自动抓取**中国研究生电子设计竞赛（研电赛）**官方渠道的最新通知，发现更新后合并成一封邮件推送给订阅者。抓取与发信跑在 GitHub Actions，订阅页 / 控制台 / 退订跑在 Cloudflare Worker，全部免费额度内运行。

## 架构

```
研创网 / 中国电子学会
        ↓ 抓取（GitHub Actions，每 10 分钟）
   Python 端：列表页比对 UID → 命中才抓详情 → 去重 → 渲染邮件
        ↓ GET /api/list（Bearer SUBSCRIBE_API_TOKEN）拉订阅名单与栏目偏好
   Cloudflare Worker：登录 / 控制台 / 退订 / 名单 API（KV + Durable Object）
        ↓ Resend API
   收件人（每人单独一封，退订链接一人一签）
```

Worker 由 **Cloudflare Workers Builds** 连接 GitHub 自动构建部署：
`npm ci && npm run sync-config && npm run build` —— 先从 `.env` 同步自定义域名与 KV id 到 `wrangler.toml`，再用 esbuild 把界面层与后端逻辑层打包成 `dist/index.js`，最后 `npx wrangler deploy`。

| 数据源 | 栏目 | 说明 |
|---|---|---|
| [研创网](https://cpipc.acge.org.cn/cw/contestNews/list/6/1) | 大赛通知 | 官方平台，报名 / 评审 / 决赛通知 |
| [中国电子学会](https://www.cie.org.cn/list_43/) | 通知公告 | 主办方，按关键词过滤研电赛相关公告 |

抓取逻辑：列表页翻页 → 解析条目 → 抓详情页补摘要与附件 → 稳定 UID 去重 → 有新内容才发信。两阶段抓取让高频轮询对源站压力几乎为零。

## 配置：`.env` 是唯一事实源

```bash
cp .env.example .env      # 填真实值；.env 已被 .gitignore 忽略
```

每个值只填一次，**能推导的绝不重复填**：

| 派生项 | 规则 |
|---|---|
| `PUBLIC_BASE_URL` | 显式值 → `https://<CUSTOM_DOMAIN>` → `<WORKERS_DEV_URL>` |
| `UNSUB_URL` | `<生效地址>/unsubscribe` |
| `SUBSCRIBE_API_URL` | `<生效地址>/api/list` |
| `MAIL_FROM` | `MAIL_FROM_NAME <MAIL_FROM_ADDRESS>` |

- **自定义域名**只需填 `CUSTOM_DOMAIN="notice.example.com"`，全站链接自动跟随；`npm run sync-config` 会把它写成 `[[routes]] custom_domain = true`。首次部署可先留空、只用 `WORKERS_DEV_URL`，DNS 生效后再补上。
- 跨平台共享密钥**同名同值**：`UNSUB_SECRET`、`SUBSCRIBE_API_TOKEN` 在 Cloudflare 与 GitHub 各填一次，名字一样。
- **`.env.example`** 每项都标注去处（`[CF-V]` 明文变量 / `[CF-S]` 密钥 / `[GH]` GitHub Secret / `[构建]` Build variable / `[本地]`）。
- **`config.yaml`** 只留业务规则（数据源、白名单、去重、主题前缀），可安全入库。
- 优先级：**进程环境变量（CI / Cloudflare 注入）> `.env` > 内置默认值**。

> Cloudflare **不会读取仓库里的 `.env`**：运行时配置填 Dashboard → Variables and Secrets；
> `.env` 里的 `CUSTOM_DOMAIN` / `KV_SUBS_ID` 由 `sync-config` 在构建期写进 `wrangler.toml`；
> 本地 `wrangler dev` 读 `worker/.dev.vars`（模板 `worker/.dev.vars.example`）。

完整清单与自定义域名步骤见 **[Cloudflare自动部署指南](docs/Cloudflare自动部署指南.md)**。

## 快速部署

### 1. 本地准备

```bash
cp .env.example .env
openssl rand -hex 32     # UNSUB_SECRET
openssl rand -hex 32     # SUBSCRIBE_API_TOKEN
```

在 `.env` 里填 `CUSTOM_DOMAIN`（或先用 `WORKERS_DEV_URL`）、`MAIL_FROM_ADDRESS`、`MAIL_TO`、`RESEND_API_KEY` 等。

### 2. 部署 Worker（一次配置，之后 push 即自动部署）

```bash
cd worker
npx wrangler login
npx wrangler kv namespace create SUBS   # 把 id 填进 .env 的 KV_SUBS_ID
npm run sync-config                     # 同步自定义域名 + KV id 到 wrangler.toml
```

Cloudflare Dashboard → Worker → **Settings → Builds → Connect to Git**：

| 字段 | 值 |
|---|---|
| Root directory | `worker` |
| Build command | `npm ci && npm run sync-config && npm run build` |
| Deploy command | `npx wrangler deploy` |
| Build variables | `KV_SUBS_ID`；用自定义域名时加 `CUSTOM_DOMAIN` |

再在 **Settings → Variables and Secrets** 填运行时配置，完整清单见部署指南第三节，至少：

- Secrets：`UNSUB_SECRET`、`RESEND_API_KEY`、`SUBSCRIBE_API_TOKEN`
- Variables：`CUSTOM_DOMAIN`（或 `WORKERS_DEV_URL`）、`MAIL_FROM_ADDRESS`、`MAIL_TO`
- Bindings：`SUBS`（KV，经 sync-config 写入）、`RATE`（Durable Object，已配好）

> 自定义域名要求该域名的 zone 已接入 Cloudflare；绑定后 DNS 记录与证书由 Cloudflare 自动创建。
> `wrangler.toml` 里 `workers_dev = true` 会同时保留 workers.dev 入口，方便过渡与排错。

### 3. 配置 GitHub Secrets

仓库 → Settings → Secrets and variables → Actions：

| Secret | 说明 |
|---|---|
| `CUSTOM_DOMAIN` | **与 Cloudflare 同值**（不用自定义域时改填 `WORKERS_DEV_URL`） |
| `UNSUB_SECRET` / `SUBSCRIBE_API_TOKEN` | **两边同名同值** |
| `MAIL_FROM_ADDRESS` / `MAIL_TO` / `RESEND_API_KEY` | 发信与收件人 |
| `UNSUB_TTL_DAYS` | 默认 180，两边同值 |

`UNSUB_URL` / `SUBSCRIBE_API_URL` 已自动派生，新部署不用填。不配订阅 API 也能跑：Actions 会退回只用 `MAIL_TO` 发信。

### 4. 推送

```bash
git init && git add . && git commit -m "init: 研电赛通知订阅器"
git branch -M main
git remote add origin git@github.com:<你的用户名>/yds-notifier.git
git push -u origin main
```

推送后 Cloudflare 自动构建部署；到 Actions 手动 **Run workflow** 测试发信（首次只发一封最近 8 条的确认邮件并建立去重基线），之后每 10 分钟自动检查。

> 用自己的域名发信（Resend + DKIM/SPF/DMARC）见 **[域名发信配置指南](docs/域名发信配置指南.md)**。

## 邮件效果

按「报名参赛 / 评审与名单 / 决赛与收官 / 赛事动态」分组，纯文本 + HTML 双格式。日系清新 + 孟菲斯卡片风格，按时段变化问候，**全程不使用 emoji**，任何邮件客户端显示一致。底部有「一键退订」按钮和 Gmail 原生退订头（RFC 8058）。订阅者可在控制台勾选栏目，推送时按偏好过滤。

## 目录结构

```
yds-notifier/
├── .env                          # 唯一事实源（已忽略，不入库）
├── .env.example                  # 模板 + 每项去处标注
├── .gitignore
├── config.yaml                   # 纯业务规则：数据源 / 去重 / 主题前缀
├── requirements.txt
├── docs/
│   ├── Cloudflare自动部署指南.md   # Git 集成 + 自定义域名 + 环境变量清单
│   ├── 安全评审报告.md             # 本次评审发现与修复
│   ├── 订阅页面部署指南.md         # 账号体系与接口说明
│   ├── 退订服务部署指南.md         # 退订链路与签名契约
│   └── 域名发信配置指南.md         # Resend + DNS 步骤
├── worker/
│   ├── src/index.ts              # 路由层
│   ├── src/env.ts                # 配置派生：域名 / 多来源白名单
│   ├── src/security.ts           # 签名 / CSRF / CSP / 校验
│   ├── src/auth.ts / rate.ts / mailer.ts
│   ├── src/ui/                   # 界面层：styles / scripts / layout / pages
│   ├── src/handlers/             # 后端逻辑层：login / dashboard / unsubscribe / api
│   ├── scripts/sync-config.mjs   # .env → wrangler.toml（自定义域名 + KV id）
│   ├── wrangler.toml             # main = dist/index.js，AUTO-CONFIG 区块
│   ├── .dev.vars.example         # 本地调试配置模板
│   └── tests/worker.e2e.mjs      # 端到端测试（含自定义域名用例）
├── data/seen.json                # 已推送记录（Action 自动提交回仓库去重）
├── .github/workflows/
│   ├── notify.yml                # 定时抓取发信
│   └── worker-ci.yml             # Worker 类型检查 / 测试 / 构建
└── yds/
    ├── config.py                 # 统一读取 .env 与域名派生
    ├── models.py / fetch.py / sources.py / state.py
    ├── mailer.py / senders.py / recipients.py / unsub.py / main.py
    └── selftest.py               # 离线自测（域名派生 / 签名 / 收件人）
```

## 本地使用

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt

.venv/bin/python -m yds.selftest    # 配置与退订签名自测（不联网）
.venv/bin/python -m yds --check     # 只抓取打印，调试解析器
.venv/bin/python -m yds --dry-run   # 完整流程但不发信
.venv/bin/python -m yds --preview preview.html

cd worker && npm ci && npm run check && npm run dev
```

## 实时性

| 项 | 实际情况 |
|---|---|
| 检查间隔 | 10 分钟（cron `*/10 * * * *`） |
| 实际延迟 | 一般 10 分钟内，GitHub 高峰期可能多几分钟 |
| 单次成本 | 无新公告时只发 1 个列表页请求，不抓详情页 |
| 费用 | 仓库须为 **Public** 才完全免费（Private 仓库 144 次/天会超免费分钟数） |

## 自定义

- **增删数据源 / 改抓取深度**：编辑 `config.yaml`
- **加新站点**：在 `yds/sources.py` 继承 `BaseSource` 并注册（记得配 `allowed_hosts`）
- **换发信服务商**：`yds/senders.py` 继承 `BaseSender`
- **改邮件样式**：`yds/mailer.py` 的 `build_html`
- **改 Worker 界面**：`worker/src/ui/`；**改后端逻辑**：`worker/src/handlers/`
- **改栏目**：`worker/src/auth.ts` 的 `CATEGORIES` 与 `yds/recipients.py` 的 `CATEGORY_TO_KEY` 必须同步
- **换域名**：只改 `.env` 的 `CUSTOM_DOMAIN`，跑 `npm run sync-config`，同步更新 Cloudflare 与 GitHub 的同名变量

## 常见问题

- **收不到邮件**：看 Actions 日志。Resend 报 `403 domain is not verified` 是 DNS 未验证；SMTP 报 `535` 是授权码不对。
- **登录返回 500**：`CUSTOM_DOMAIN` / `WORKERS_DEV_URL` / `PUBLIC_BASE_URL` 三者都没配，对外地址无法确定（fail-closed）。
- **绑定自定义域后 workers.dev 404**：`workers_dev` 被关掉了，本项目的 `wrangler.toml` 显式设为 `true`。
- **退订链接点开报「链接不能用」**：多数是 `UNSUB_SECRET` 两边不一致，或链接已过 `UNSUB_TTL_DAYS`。
- **Worker 部署后读不到变量**：变量填到了 Build variables（只在构建期可见），应移到 Variables and Secrets。
- **会不会漏通知**：状态文件若推送失败，下轮会重发未确认的通知，宁可重复不漏发。
