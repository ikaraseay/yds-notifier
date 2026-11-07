#!/usr/bin/env bash
# =============================================================================
# 公共函数：路径、配置读取、输出、Wrangler 包装
#
# 所有运维脚本都先 source 本文件：
#   . "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
#
# 约定与 Wofuf-edge 等同类项目 的运维脚本保持一致：
#   - warn / err 走 stderr，避免被 $() 吞进变量里
#   - 密钥值一律不回显，只显示长度
#   - 配置只有 .env 一处真源，逐键读取（不 source 整个文件，避免行尾注释
#     和特殊字符被当成 shell 代码执行）
# =============================================================================
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS_DIR="$PROJECT_ROOT/scripts"
WORKER_DIR="$PROJECT_ROOT/worker"
CONFIG_FILE="${CONFIG_FILE:-$PROJECT_ROOT/.env}"
CONFIG_EXAMPLE="$PROJECT_ROOT/.env.example"
DEV_VARS="$WORKER_DIR/.dev.vars"
WRANGLER_CONFIG="$WORKER_DIR/wrangler.toml"
REPO="${REPO:-ikaraseay/yds-notifier}"
NOTIFY_WORKFLOW="notify.yml"

# 运维脚本会用到的全部配置键（config_get 的白名单）
ALL_KEYS="CUSTOM_DOMAIN WORKERS_DEV_URL PUBLIC_BASE_URL SITE_NAME REPO_URL
MAIL_PROVIDER MAIL_FROM_ADDRESS MAIL_FROM_NAME MAIL_TO REPLY_TO RESEND_API_KEY
SMTP_HOST SMTP_PORT SMTP_SECURITY SMTP_USER SMTP_PASSWORD
UNSUB_SECRET SUBSCRIBE_API_TOKEN UNSUB_SECRET_PREVIOUS UNSUB_TTL_DAYS
MAX_PER_IP_HOUR MAX_CONFIRM_PER_DAY LIST_RATE_PER_HOUR RESEND_WEBHOOK_SECRET
PUBLISH_NOTICES NOTICES_API_URL HEARTBEAT_URL ALERT_WEBHOOK_URL
CRAWLER_UA RESPECT_ROBOTS
KV_SUBS_ID CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN
STATE_BACKEND R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET R2_PREFIX"

# Cloudflare Worker 运行时变量（Variables and Secrets）
CF_KEYS=(UNSUB_SECRET SUBSCRIBE_API_TOKEN UNSUB_SECRET_PREVIOUS RESEND_API_KEY
  RESEND_WEBHOOK_SECRET CUSTOM_DOMAIN WORKERS_DEV_URL SITE_NAME
  MAIL_FROM_ADDRESS MAIL_FROM_NAME MAIL_TO UNSUB_TTL_DAYS
  MAX_PER_IP_HOUR MAX_CONFIRM_PER_DAY LIST_RATE_PER_HOUR)

# GitHub Actions Secrets（notify.yml 会注入同名环境变量）
GH_KEYS=(CUSTOM_DOMAIN WORKERS_DEV_URL MAIL_FROM_ADDRESS MAIL_FROM_NAME
  MAIL_TO SITE_NAME RESEND_API_KEY UNSUB_SECRET SUBSCRIBE_API_TOKEN UNSUB_TTL_DAYS
  PUBLISH_NOTICES NOTICES_API_URL HEARTBEAT_URL ALERT_WEBHOOK_URL
  CRAWLER_UA RESPECT_ROBOTS
  AI_ENABLED AI_API_KEY AI_BASE_URL AI_MODEL AI_THINKING AI_TEMPERATURE
  AI_MAX_TOKENS AI_TIMEOUT AI_BATCH_SIZE AI_MAX_BODY_CHARS
  STATE_BACKEND R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET R2_PREFIX)

C_RESET=$'\033[0m'; C_B=$'\033[1m'; C_DIM=$'\033[2m'
C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_C=$'\033[36m'

step() { printf "\n%s▸ %s%s\n" "$C_C" "$*" "$C_RESET"; }
sub()  { printf "  %s→%s %s\n" "$C_DIM" "$C_RESET" "$*"; }
ok()   { printf "  %s✓%s %s\n" "$C_G" "$C_RESET" "$*"; }
# 警告与错误走 stderr：它们是给人看的，不该混进命令替换的输出里
warn() { printf "  %s!%s %s\n" "$C_Y" "$C_RESET" "$*" >&2; }
err()  { printf "  %s✗%s %s\n" "$C_R" "$C_RESET" "$*" >&2; }
die()  { err "$*"; exit 1; }
note() { printf "  %s%s%s\n" "$C_DIM" "$*" "$C_RESET"; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1（$2）"; }

ask_yes_no() {
  local prompt="$1" reply
  printf "  %s%s [y/N] %s" "$C_B" "$prompt" "$C_RESET"
  read -r reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

# 读单个配置项：兼容 KEY="value" # 注释 / KEY='value' / KEY=value
config_get() {
  local key="$1" line
  [ -f "$CONFIG_FILE" ] || return 0
  line="$(sed -n "s/^${key}=//p" "$CONFIG_FILE" | head -1)"
  [ -n "$line" ] || return 0
  case "$line" in
    \"*)  printf '%s' "$line" | sed -E 's/^"([^"]*)".*/\1/' ;;
    \'*)  printf '%s' "$line" | sed -E "s/^'([^']*)'.*/\1/" ;;
    *)    printf '%s' "$line" | sed -E 's/[[:space:]]*#.*//; s/[[:space:]]+$//' ;;
  esac
}

# 写单个配置项（保留注释与其它行）
config_set() {
  local key="$1" value="$2" escaped
  [ -f "$CONFIG_FILE" ] || cp "$CONFIG_EXAMPLE" "$CONFIG_FILE"
  escaped="${value//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  if grep -q "^${key}=" "$CONFIG_FILE"; then
    awk -v k="$key" -v v="\"$escaped\"" '
      $0 ~ "^"k"=" { print k "=" v; next } { print }
    ' "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
  else
    printf '%s="%s"\n' "$key" "$escaped" >> "$CONFIG_FILE"
  fi
}

config_unset() {
  local key="$1"
  [ -f "$CONFIG_FILE" ] || return 0
  grep -v "^${key}=" "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
}

# 加载配置：逐键 export，不 source 整个 .env
load_config() {
  [ -f "$CONFIG_FILE" ] || die "缺少配置：cp .env.example .env 并填入真实值"
  local k v
  for k in $ALL_KEYS; do
    v="$(config_get "$k")"
    export "$k=$v"
  done
}

# 站点地址：显式覆盖 → 自定义域 → workers.dev
# 注意：先剥掉 scheme 再切路径，直接对 "https://host" 用 %%/* 会截成 "https:"
site_url() {
  local base="${PUBLIC_BASE_URL:-}" host
  if [ -z "$base" ] && [ -n "${CUSTOM_DOMAIN:-}" ]; then
    host="${CUSTOM_DOMAIN#https://}"
    host="${host#http://}"
    host="${host%%/*}"
    [ -n "$host" ] && base="https://$host"
  fi
  [ -n "$base" ] || base="${WORKERS_DEV_URL:-}"
  printf '%s' "${base%/}"
}

# JSON 字符串转义（用于 wrangler secret bulk 的临时文件）
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# Wrangler 一律在 worker/ 目录下执行，避免读错配置
wrangler() { (cd "$WORKER_DIR" && npx --no-install wrangler "$@"); }

require_login() {
  local who
  who="$(wrangler whoami 2>/dev/null)" || true
  printf '%s' "$who" | grep -qi "account" \
    || die "还没登录 Cloudflare：bash scripts/ops.sh login"
}

require_gh() {
  require_cmd gh "brew install gh"
  gh auth status >/dev/null 2>&1 \
    || die "还没登录 GitHub：gh auth login --web --scopes 'repo,workflow'"
}

# 取 HTTP 状态码。本机 DNS 被过滤/缓存时 curl 会返回 000，但站点其实是好的 ——
# 换公共 DNS 拿 IP 再 --resolve 试一次，别把「解析不了」误报成「站点挂了」。
curl_code() {
  local url="$1" host code ip resolver
  code="$(curl -o /dev/null -s -m 10 -w '%{http_code}' --noproxy '*' "$url" 2>/dev/null || true)"
  [ "$code" != "000" ] && { printf '%s' "$code"; return; }
  command -v dig >/dev/null 2>&1 || { printf '000'; return; }
  host="$(printf '%s' "$url" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')"
  for resolver in "" "@1.1.1.1" "@8.8.8.8"; do
    ip="$(dig +short $resolver "$host" 2>/dev/null | grep -E '^[0-9]+\.' | head -1)"
    [ -n "$ip" ] && break
  done
  [ -n "$ip" ] || { printf '000'; return; }
  local out
  out="$(curl -o /dev/null -s -m 10 -w '%{http_code}' --noproxy '*' \
    --resolve "$host:443:$ip" "$url" 2>/dev/null || true)"
  printf '%s' "${out:-000}"
}

# 列出待同步的键（脱敏：只显示长度）
print_keys() {
  local title="$1"; shift
  local k v n=0
  step "$title"
  for k in "$@"; do
    v="$(config_get "$k")"
    if [ -n "$v" ]; then
      printf '  %-26s %s\n' "+ $k" "<${#v} 字符>"
      n=$((n + 1))
    else
      note "- ${k}（留空，跳过）"
    fi
  done
  [ "$n" -gt 0 ] || die "没有任何可同步的非空配置，检查 $CONFIG_FILE"
}
