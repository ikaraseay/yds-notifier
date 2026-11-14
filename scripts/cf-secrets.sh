#!/usr/bin/env bash
# =============================================================================
# 上传密钥 / 变量到 Cloudflare Worker（Wrangler）
#
#   bash scripts/cf-secrets.sh              从 .env 批量写入
#   bash scripts/cf-secrets.sh --dry-run    只列出会写哪些键（不上传）
#   bash scripts/cf-secrets.sh --list       列出云端已有的 secrets
#   bash scripts/cf-secrets.sh --only KEY   只写某一项
#   bash scripts/cf-secrets.sh --admin      一次写入两项管理员密钥
#
# 真源是项目根目录的 .env（已忽略，不入库）。空值自动跳过；
# 用 wrangler secret bulk 一次写入，只产生一个部署版本。
# 等价于 Dashboard → Worker → Settings → Variables and Secrets。
# =============================================================================
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

DRY_RUN=0
ONLY=""
ADMIN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --list)    require_login; wrangler secret list; exit 0 ;;
    --only)    shift; ONLY="${1:-}" ;;
    --admin)   ADMIN=1 ;;
    -h|--help) usage ;;
    *) die "未知参数：$1（可用 --dry-run / --list / --only KEY / --admin）" ;;
  esac
  shift || true
done

load_config
if [ "$ADMIN" -eq 1 ]; then
  [ -z "$ONLY" ] || die "--admin 和 --only 不能同时使用"
  KEYS=("${ADMIN_KEYS[@]}")
  [[ "$ADMIN_PASSWORD_HASH" =~ ^[[:xdigit:]]{64}$ && ${#ADMIN_SESSION_SECRET} -ge 32 ]] \
    || die "管理员密钥未正确配置：bash scripts/ops.sh admin-secrets"
elif [ -n "$ONLY" ]; then
  KEYS=("$ONLY")
else
  KEYS=("${CF_KEYS[@]}")
fi

print_keys "Cloudflare Worker → Variables and Secrets" "${KEYS[@]}"

if [ "$DRY_RUN" -eq 1 ]; then
  note "dry-run：未上传"
  exit 0
fi

require_login
TMP_JSON="$(mktemp)"
trap 'rm -f "$TMP_JSON"' EXIT
{
  printf '{\n'
  first=1
  for k in "${KEYS[@]}"; do
    v="$(config_get "$k")"
    [ -n "$v" ] || continue
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '  "%s": "%s"' "$k" "$(json_escape "$v")"
  done
  printf '\n}\n'
} > "$TMP_JSON"

step "上传到 Cloudflare"
if wrangler secret bulk "$TMP_JSON" 2>&1 | sed 's/^/  /'; then
  ok "已写入 Cloudflare（${#KEYS[@]} 项中的非空项）"
else
  die "上传失败，检查 wrangler 输出与登录状态"
fi

note "提示：Workers Builds 的 Build variables 只在构建期可见，运行时读不到"
