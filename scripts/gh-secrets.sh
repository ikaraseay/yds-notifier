#!/usr/bin/env bash
# =============================================================================
# 上传密钥到 GitHub Actions Secrets
#
#   bash scripts/gh-secrets.sh              从 .env 批量写入
#   bash scripts/gh-secrets.sh --dry-run    只列出会写哪些键（不上传）
#   bash scripts/gh-secrets.sh --list       列出仓库已有的 Secrets
#   bash scripts/gh-secrets.sh --only KEY   只写某一项
#   bash scripts/gh-secrets.sh --repo O/R   指定仓库
#
# 前置：gh auth login --web --scopes "repo,workflow"
# 值只经 stdin 传给 gh，不出现在命令行参数 / 进程列表 / 日志里。
# =============================================================================
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

DRY_RUN=0
ONLY=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --list)    require_gh; gh secret list --repo "$REPO"; exit 0 ;;
    --only)    shift; ONLY="${1:-}" ;;
    --repo)    shift; REPO="${1:-}"; export REPO ;;
    -h|--help) usage ;;
    *) die "未知参数：$1（可用 --dry-run / --list / --only KEY / --repo O/R）" ;;
  esac
  shift || true
done

load_config
if [ -n "$ONLY" ]; then
  case "$ONLY" in
    ADMIN_PASSWORD_HASH|ADMIN_SESSION_SECRET) die "管理员密钥只能上传到 Cloudflare" ;;
  esac
  KEYS=("$ONLY")
else
  KEYS=("${GH_KEYS[@]}")
fi

print_keys "GitHub → $REPO → Actions Secrets" "${KEYS[@]}"

if [ "$DRY_RUN" -eq 1 ]; then
  note "dry-run：未上传"
  exit 0
fi

require_gh
step "上传到 GitHub"
ok_count=0
for k in "${KEYS[@]}"; do
  v="$(config_get "$k")"
  [ -n "$v" ] || continue
  if printf '%s' "$v" | gh secret set "$k" --repo "$REPO" >/dev/null 2>&1; then
    ok "$k 已写入"
    ok_count=$((ok_count + 1))
  else
    err "$k 写入失败（检查 token 是否有 repo 权限、仓库是否存在）"
    exit 1
  fi
done

ok "完成：$ok_count 项"
note "查看：gh secret list --repo $REPO"
