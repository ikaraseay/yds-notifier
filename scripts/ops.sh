#!/usr/bin/env bash
# =============================================================================
# 研电赛通知订阅器 · 运维总入口
#
#   bash scripts/ops.sh doctor        体检：哪里没配好，一次列清楚
#   bash scripts/ops.sh status        当前状态（配置 / 线上 / 部署 / Actions）
#   bash scripts/ops.sh secrets       从 .env 同步密钥到 Cloudflare + GitHub
#   bash scripts/ops.sh cf-secrets    只同步 Cloudflare（wrangler）
#   bash scripts/ops.sh gh-secrets    只同步 GitHub（gh）
#   bash scripts/ops.sh config        .env 的查看 / 修改 / 校验
#   bash scripts/ops.sh dev-vars      从 .env 生成 worker/.dev.vars
#   bash scripts/ops.sh check         本地校验：自测 / 类型 / 测试 / 干跑
#   bash scripts/ops.sh deploy        构建并部署 Worker
#   bash scripts/ops.sh notify       触发 Actions（normal | check）
#   bash scripts/ops.sh r2           状态存储（status / diff / seed / refresh / enable / pull）
#   bash scripts/ops.sh logs          最近 Actions 运行 / 指定 run 的日志
#   bash scripts/ops.sh login        登录 Cloudflare
#   bash scripts/ops.sh logout       登出 Cloudflare
#
# 配置只有 .env 一处真源（从 .env.example 复制，不入库）。
# 单独上传密钥也可直接跑 scripts/cf-secrets.sh / scripts/gh-secrets.sh。
# =============================================================================
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PY="$PROJECT_ROOT/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3 || true)"

# 仓库里的 wrangler.toml 只保留占位符；本地 wrangler 需要真实 KV id 时临时注入，
# 无论命令成败都在退出时还原，避免把真实值误提交回仓库。
WORKER_CONFIG_BACKUP=""
restore_worker_config() {
  if [ -n "$WORKER_CONFIG_BACKUP" ] && [ -f "$WORKER_CONFIG_BACKUP" ]; then
    cp "$WORKER_CONFIG_BACKUP" "$WRANGLER_CONFIG"
    rm -f "$WORKER_CONFIG_BACKUP"
    WORKER_CONFIG_BACKUP=""
  fi
}
inject_worker_config() {
  WORKER_CONFIG_BACKUP="$(mktemp)"
  cp "$WRANGLER_CONFIG" "$WORKER_CONFIG_BACKUP"
  (cd "$WORKER_DIR" && npm run --silent sync-config >/dev/null) \
    || { restore_worker_config; die "sync-config 失败：检查 .env 的 KV_SUBS_ID"; }
}
trap restore_worker_config EXIT

usage() {
  sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

# ─────────────────────────────────────────────────────────────────────────────
# 配置：查看 / 修改 / 校验
# ─────────────────────────────────────────────────────────────────────────────
PROBLEMS=0
check_one() {
  local label="$1" value="$2" pattern="$3" hint="$4" sensitive shown
  # 密钥一律不回显，连前几位也不行 —— doctor 输出可能进 CI 日志
  if printf '%s' "$label" | grep -qE 'SECRET|TOKEN|PASSWORD|KEY'; then
    sensitive=1
    shown="<${#value} 字符，已隐藏>"
  else
    sensitive=0
    shown="${value:0:32}"
  fi
  if printf '%s' "$value" | grep -qE "$pattern"; then
    [ "$sensitive" -eq 1 ] && ok "$label 已设置（${#value} 字符）" || ok "$label = $shown"
  else
    [ -n "$value" ] && warn "$label 格式不对（值已隐藏）→ $hint" \
      || warn "$label 未设置 → $hint"
    PROBLEMS=$((PROBLEMS + 1))
  fi
}

config_check() {
  PROBLEMS=0
  local site
  site="$(site_url)"
  check_one "对外地址" "$site" '^https?://[^[:space:]]+$' '填 CUSTOM_DOMAIN 或 WORKERS_DEV_URL'
  check_one "MAIL_FROM_ADDRESS" "${MAIL_FROM_ADDRESS:-}" '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' 'Resend 已验证域名下的纯地址'
  check_one "MAIL_TO" "${MAIL_TO:-}" '^[^@[:space:]]+@' '站长邮箱，用于兜底收信与站长通知'
  check_one "RESEND_API_KEY" "${RESEND_API_KEY:-}" '^re_' 'Resend → API Keys 创建 Sending access'
  check_one "UNSUB_SECRET" "${UNSUB_SECRET:-}" '^[0-9a-f]{32,}$' 'openssl rand -hex 32，两端必须一致'
  check_one "SUBSCRIBE_API_TOKEN" "${SUBSCRIBE_API_TOKEN:-}" '^[0-9a-f]{32,}$' 'openssl rand -hex 32，两端必须一致'
  check_one "KV_SUBS_ID" "${KV_SUBS_ID:-}" '^[0-9a-f]{32}$' 'wrangler kv namespace create SUBS 的输出'
  check_one "UNSUB_TTL_DAYS" "${UNSUB_TTL_DAYS:-180}" '^[0-9]+$' '退订链接有效天数，默认 180'
  return 0
}

cmd_config() {
  local cmd="${1:-show}"
  shift || true
  case "$cmd" in
    show)
      step "当前配置（${CONFIG_FILE}）"
      if [ -f "$CONFIG_FILE" ]; then
        # 密钥不回显 —— 这个输出可能进 CI 日志
        grep -vE '^\s*#|^\s*$' "$CONFIG_FILE" \
          | sed -E 's/^([A-Z0-9_]*(SECRET|TOKEN|PASSWORD|KEY|WEBHOOK|HEARTBEAT)[A-Z0-9_]*)=.*/\1="***"/' \
          | sed 's/^/  /'
      else
        warn "还没有配置：cp .env.example .env"
      fi
      ;;
    get)
      local key="${1:-}"
      [ -n "$key" ] || die "用法：ops.sh config get KEY"
      printf '%s=%s\n' "$key" "$(config_get "$key")"
      ;;
    set)
      local key="${1:-}" value="${2:-}"
      [ -n "$key" ] || die "用法：ops.sh config set KEY VALUE"
      [ -n "$value" ] || die "$key 不能是空值"
      load_config
      config_set "$key" "$value"
      ok "$key 已更新"
      note "改完记得：bash scripts/ops.sh secrets && bash scripts/ops.sh deploy"
      ;;
    unset)
      local key="${1:-}"
      [ -n "$key" ] || die "用法：ops.sh config unset KEY"
      load_config
      config_unset "$key"
      ok "$key 已删除"
      ;;
    edit)
      load_config
      "${EDITOR:-vi}" "$CONFIG_FILE"
      ok "配置已保存"
      ;;
    check)
      load_config
      step "校验配置"
      config_check
      if [ "$PROBLEMS" -gt 0 ]; then
        warn "有 $PROBLEMS 项需要注意"
        exit 1
      fi
      ok "配置看起来没问题"
      ;;
    *)
      die "未知命令：${cmd}（可用 show / get / set / unset / edit / check）"
      ;;
  esac
}

# 本地开发凭据：Wrangler 只认 worker/ 同目录的 .dev.vars
cmd_dev_vars() {
  load_config
  step "生成 $DEV_VARS"
  {
    printf '# 由 scripts/ops.sh dev-vars 生成 —— 改 .env 后重跑，别手改这里\n'
    printf 'PUBLIC_BASE_URL="http://localhost:8787"\n'
    printf 'CUSTOM_DOMAIN=""\n'
    printf 'WORKERS_DEV_URL="%s"\n\n' "${WORKERS_DEV_URL:-}"
    printf '# --- Secrets ---\n'
    printf 'UNSUB_SECRET="%s"\n' "${UNSUB_SECRET:-}"
    printf 'UNSUB_SECRET_PREVIOUS="%s"\n' "${UNSUB_SECRET_PREVIOUS:-}"
    printf 'RESEND_API_KEY="%s"\n' "${RESEND_API_KEY:-}"
    printf 'SUBSCRIBE_API_TOKEN="%s"\n' "${SUBSCRIBE_API_TOKEN:-}"
    printf 'RESEND_WEBHOOK_SECRET="%s"\n\n' "${RESEND_WEBHOOK_SECRET:-}"
    printf '# --- Variables ---\n'
    printf 'SITE_NAME="%s"\n' "${SITE_NAME:-研电赛通知订阅}"
    printf 'MAIL_FROM_ADDRESS="%s"\n' "${MAIL_FROM_ADDRESS:-}"
    printf 'MAIL_FROM_NAME="%s"\n' "${MAIL_FROM_NAME:-研电赛通知}"
    printf 'MAIL_TO="%s"\n' "${MAIL_TO:-}"
    printf 'UNSUB_TTL_DAYS="%s"\n' "${UNSUB_TTL_DAYS:-180}"
    printf 'MAX_PER_IP_HOUR="%s"\n' "${MAX_PER_IP_HOUR:-10}"
    printf 'MAX_CONFIRM_PER_DAY="%s"\n' "${MAX_CONFIRM_PER_DAY:-200}"
    printf 'LIST_RATE_PER_HOUR="%s"\n' "${LIST_RATE_PER_HOUR:-60}"
  } > "$DEV_VARS"
  ok "已写入 $DEV_VARS"
  note "该文件已被 .gitignore 忽略；线上配置用 ops.sh secrets"
}

cmd_secrets() {
  # 允许 `ops.sh secrets --dry-run`：第一个参数是选项时目标默认为 all
  local target="all"
  if [ -n "${1:-}" ] && [[ "${1:-}" != --* ]]; then
    target="$1"
    shift || true
  fi
  case "$target" in
    all|both)
      bash "$SCRIPTS_DIR/cf-secrets.sh" "$@"
      bash "$SCRIPTS_DIR/gh-secrets.sh" "$@"
      ;;
    cf|cloudflare|wrangler) bash "$SCRIPTS_DIR/cf-secrets.sh" "$@" ;;
    gh|github)             bash "$SCRIPTS_DIR/gh-secrets.sh" "$@" ;;
    *) die "未知目标：${target}（可用 all / cf / gh）" ;;
  esac
}

cmd_check() {
  step "Python 自测"
  [ -x "$PROJECT_ROOT/.venv/bin/python" ] \
    || die "缺少虚拟环境：python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  (cd "$PROJECT_ROOT" && .venv/bin/python -m compileall -q yds \
    && .venv/bin/python -m yds.selftest 2>&1 | tail -3 | sed 's/^/  /')
  step "Worker 类型 / 测试 / 构建"
  (cd "$WORKER_DIR" && npm run typecheck >/dev/null && npm test 2>&1 | tail -3 | sed 's/^/  /' \
    && npm run build 2>&1 | tail -3 | sed 's/^/  /')
  step "Wrangler 部署干跑"
  inject_worker_config
  wrangler deploy --dry-run --outdir /tmp/yds-dryrun 2>&1 | tail -6 | sed 's/^/  /'
  restore_worker_config
  ok "本地校验全部通过"
}

cmd_deploy() {
  load_config
  local base
  base="$(site_url)"
  step "准备部署 Worker"
  note "站点：$base"
  ask_yes_no "确认构建并部署到 Cloudflare？" || { note "已取消"; exit 0; }
  step "构建并部署"
  inject_worker_config
  (cd "$WORKER_DIR" && npm run deploy) 2>&1 | tail -12 | sed 's/^/  /'
  restore_worker_config
  step "验证"
  local code
  code="$(curl_code "$base/health")"
  [ "$code" = "200" ] && ok "$base/health → 200" \
    || warn "$base/health → ${code}（证书刚签发时可能要等几分钟）"
}

cmd_notify() {
  require_gh
  local mode="${1:-normal}"
  case "$mode" in
    normal|check) ;;
    *) die "未知模式：${mode}（可用 normal / check）" ;;
  esac
  step "触发 GitHub Actions（${mode}）"
  gh workflow run "$NOTIFY_WORKFLOW" --repo "$REPO" -f mode="$mode"
  ok "已触发"
  note "查看日志：bash scripts/ops.sh logs"
}

cmd_logs() {
  require_gh
  local rid="${1:-}"
  if [ -n "$rid" ]; then
    gh run view "$rid" --repo "$REPO" --log 2>/dev/null | tail -60
  else
    step "最近 Actions 运行"
    gh run list --repo "$REPO" --limit 5 2>/dev/null | sed 's/^/  /'
    note "看某次日志：bash scripts/ops.sh logs <run-id>"
  fi
}

cmd_login()  { step "登录 Cloudflare"; wrangler login;  ok "登录成功"; }
cmd_logout() { step "登出 Cloudflare"; wrangler logout; ok "已登出"; }

# ─────────────────────────────────────────────────────────────────────────────
# 状态存储（Cloudflare R2）
# ─────────────────────────────────────────────────────────────────────────────
r2_configured() {
  [ "${STATE_BACKEND:-auto}" != "local" ] && [ -n "${R2_BUCKET:-}" ] \
    && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] && [ -n "${CLOUDFLARE_API_TOKEN:-}" ]
}

# 一行摘要，给 status 用
r2_summary() {
  if r2_configured; then
    printf 'R2 %s/%s' "$R2_BUCKET" "${R2_PREFIX:-state}"
  elif [ "${STATE_BACKEND:-auto}" = "local" ]; then
    printf '本地文件 + git 回写（STATE_BACKEND=local）'
  else
    printf '本地文件 + git 回写'
  fi
}

cmd_r2() {
  local sub="${1:-status}"
  shift || true
  case "$sub" in
    status|check)
      load_config
      step "R2 状态"
      "$PY" "$SCRIPTS_DIR/r2_state.py" check ;;
    diff)
      load_config
      step "本地 ↔ R2 比对"
      "$PY" "$SCRIPTS_DIR/r2_state.py" diff "$@" ;;
    seed)
      load_config
      step "建立远端基线"
      "$PY" "$SCRIPTS_DIR/r2_state.py" seed "$@" ;;
    pull)
      load_config
      step "从 R2 回拉"
      "$PY" "$SCRIPTS_DIR/r2_state.py" pull "$@" ;;
    refresh)
      # 代码还没上线、CI 仍在写 git 时，远端基线会落后 —— 发布前对齐一次
      load_config
      step "对齐基线到最新已发布状态"
      bash "$SCRIPTS_DIR/r2-enable.sh" --refresh --no-secrets ;;
    enable)
      load_config
      step "启用 R2 状态存储"
      bash "$SCRIPTS_DIR/r2-enable.sh" "$@" ;;
    *)
      die "未知子命令：${sub}（可用 status / diff / seed / pull / refresh / enable）" ;;
  esac
}

cmd_status() {
  load_config
  local base
  base="$(site_url)"
  step "配置"
  printf "  %-20s %s\n" "站点" "$base"
  printf "  %-20s %s\n" "备用入口" "${WORKERS_DEV_URL:-未配置}"
  printf "  %-20s %s\n" "发件人" "${MAIL_FROM_NAME:-研电赛通知} <${MAIL_FROM_ADDRESS:-未配置}>"
  printf "  %-20s %s\n" "站长邮箱" "${MAIL_TO:-未配置}"
  printf "  %-20s %s\n" "仓库" "$REPO"
  printf "  %-20s %s\n" "状态存储" "$(r2_summary)"
  printf "  %-20s %s\n" "IP 限流" "${MAX_PER_IP_HOUR:-10} 次/小时"

  step "线上"
  local path code
  for path in /health / /api/count; do
    code="$(curl_code "$base$path")"
    [ "$code" = "200" ] && ok "$path → 200" || warn "$path → $code"
  done

  step "最近部署"
  wrangler deployments list 2>/dev/null | grep -E "Created:|Source:" | tail -6 | sed 's/^/  /' \
    || note "（未登录，跳过）"

  step "最近 Actions"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh run list --repo "$REPO" --limit 3 2>/dev/null | sed 's/^/  /'
  else
    note "（gh 未登录，跳过）"
  fi
}

cmd_doctor() {
  load_config
  local PASS=0 WARN=0 FAIL=0
  mark_ok()   { ok "$*";   PASS=$((PASS + 1)); }
  mark_warn() { warn "$*"; WARN=$((WARN + 1)); }
  mark_fail() { err "$*";  FAIL=$((FAIL + 1)); }

  step "工具链"
  for c in python3 node npm gh; do
    if command -v "$c" >/dev/null 2>&1; then
      mark_ok "$c 已安装"
    else
      mark_warn "$c 未安装（部分命令不可用）"
    fi
  done
  if [ -x "$WORKER_DIR/node_modules/.bin/wrangler" ]; then
    mark_ok "wrangler 已安装"
  else
    mark_fail "wrangler 未安装：cd worker && npm ci"
  fi

  step "依赖"
  [ -x "$PROJECT_ROOT/.venv/bin/python" ] && mark_ok "Python 虚拟环境就绪" \
    || mark_warn "缺 .venv：python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  [ -d "$WORKER_DIR/node_modules" ] && mark_ok "Worker 依赖就绪" \
    || mark_warn "Worker 依赖未装：cd worker && npm ci"

  step "配置"
  [ -f "$CONFIG_FILE" ] && mark_ok "配置存在：$CONFIG_FILE" \
    || mark_fail "缺少配置：cp .env.example .env"
  config_check >/dev/null 2>&1 || true
  [ "$PROBLEMS" -eq 0 ] && mark_ok "必填配置校验通过" \
    || mark_warn "有 $PROBLEMS 项配置需注意（ops.sh config check 看详情）"

  local kv_in_toml
  kv_in_toml="$(sed -n 's/^id *= *"\([^"]*\)".*/\1/p' "$WRANGLER_CONFIG" | head -1)"
  case "$kv_in_toml" in
    ""|REPLACE_WITH_YOUR_KV_ID)
      mark_ok "wrangler.toml 保持占位符（真实 KV id 只在 .env / Build variables）" ;;
    *)
      mark_warn "wrangler.toml 含真实 KV id（本地注入，勿提交；ops.sh deploy 结束会自动还原）" ;;
  esac

  step "Cloudflare"
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    local verify_url="https://api.cloudflare.com/client/v4/user/tokens/verify"
    case "$CLOUDFLARE_API_TOKEN" in
      cfat_*) verify_url="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID:-}/tokens/verify" ;;
    esac
    local token_code
    token_code="$(curl -sS -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$verify_url" 2>/dev/null || true)"
    if [ "$token_code" = "200" ]; then
      mark_ok "CLOUDFLARE_API_TOKEN 有效（部署 / secrets / R2 共用）"
    else
      mark_fail "CLOUDFLARE_API_TOKEN 无效或与账户不匹配（HTTP ${token_code:-无响应}）"
    fi
  elif wrangler whoami 2>/dev/null | grep -qi "account"; then
    mark_ok "wrangler 登录态可用"
  else
    mark_fail "没有凭据：在 .env 填 CLOUDFLARE_API_TOKEN，或 bash scripts/ops.sh login"
  fi
  local cf_secrets=""
  cf_secrets="$(wrangler secret list 2>/dev/null || true)"
  for k in RESEND_API_KEY UNSUB_SECRET SUBSCRIBE_API_TOKEN MAIL_FROM_ADDRESS; do
    printf '%s' "$cf_secrets" | grep -q "\"$k\"" && mark_ok "$k 已设置" \
      || mark_fail "$k 没设置：bash scripts/ops.sh cf-secrets"
  done

  step "GitHub"
  local gh_secrets=""
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    mark_ok "已登录"
    gh_secrets="$(gh secret list --repo "$REPO" 2>/dev/null || true)"
    for k in RESEND_API_KEY UNSUB_SECRET SUBSCRIBE_API_TOKEN CUSTOM_DOMAIN; do
      printf '%s' "$gh_secrets" | grep -q "^$k" && mark_ok "$k 已设置" \
        || mark_warn "$k 没设置：bash scripts/ops.sh gh-secrets"
    done
    if r2_configured; then
      for k in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN; do
        printf '%s' "$gh_secrets" | grep -q "^$k" && mark_ok "$k 已设置" \
          || mark_fail "$k 没设置（R2 状态需要）：bash scripts/ops.sh gh-secrets"
      done
    fi
  else
    mark_warn "gh 未登录：gh auth login --web --scopes 'repo,workflow'"
  fi

  step "状态存储"
  if r2_configured; then
    local r2out r2diff
    if r2out="$("$PY" "$SCRIPTS_DIR/r2_state.py" check 2>&1)"; then
      mark_ok "R2 可用：${R2_BUCKET}/${R2_PREFIX:-state}，$(printf '%s' "$r2out" | sed -n 's/^远端对象  : \([0-9]*\).*/\1/p') 个对象"
      if r2diff="$("$PY" "$SCRIPTS_DIR/r2_state.py" diff 2>&1)"; then
        printf '%s' "$r2diff" | tail -1 | grep -q "有变化 0 / 仅本地 0" \
          && mark_ok "本地 data/ 与远端一致" \
          || mark_warn "本地 data/ 与远端有差异（发布前先 bash scripts/ops.sh r2 refresh）"
      else
        mark_warn "比对失败：$(printf '%s' "$r2diff" | tail -1)"
      fi
    else
      mark_fail "R2 不可用：$(printf '%s' "$r2out" | tail -1)"
    fi
  else
    mark_warn "状态走本地文件 + git 回写（bash scripts/ops.sh r2 enable 切到 R2）"
  fi

  step "线上"
  local base code
  base="$(site_url)"
  if [ -n "$base" ]; then
    code="$(curl_code "$base/health")"
    [ "$code" = "200" ] && mark_ok "$base/health → 200" \
      || mark_fail "$base/health → ${code}（检查自定义域与证书）"
  else
    mark_fail "没有对外地址：ops.sh config set CUSTOM_DOMAIN <域名>"
  fi

  step "体检结果"
  printf '  %s通过 %s%s  %s警告 %s%s  %s失败 %s%s\n' \
    "$C_G" "$PASS" "$C_RESET" "$C_Y" "$WARN" "$C_RESET" "$C_R" "$FAIL" "$C_RESET"
  [ "$FAIL" -eq 0 ] || exit 1
}

# ─────────────────────────────────────────────────────────────────────────────
CMD="${1:-help}"
shift || true
case "$CMD" in
  doctor)       cmd_doctor ;;
  status)       cmd_status ;;
  config)       cmd_config "$@" ;;
  secrets)      cmd_secrets "$@" ;;
  cf-secrets)   bash "$SCRIPTS_DIR/cf-secrets.sh" "$@" ;;
  gh-secrets)   bash "$SCRIPTS_DIR/gh-secrets.sh" "$@" ;;
  dev-vars)     cmd_dev_vars ;;
  check)        cmd_check ;;
  deploy)       cmd_deploy ;;
  notify)       cmd_notify "$@" ;;
  r2)           cmd_r2 "$@" ;;
  logs)         cmd_logs "$@" ;;
  login)        cmd_login ;;
  logout)       cmd_logout ;;
  help|--help|-h|"") usage ;;
  *) die "未知命令：${CMD}（跑 bash scripts/ops.sh help 看用法）" ;;
esac
