#!/usr/bin/env bash
# =============================================================================
# 启用 R2 状态存储（把 data/*.json 从 git 搬到 Cloudflare R2）
#
#   bash scripts/r2-enable.sh                   .env 里已有凭证时直接执行
#   R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… bash scripts/r2-enable.sh
#                                               顺带把凭证写进 .env
#   bash scripts/r2-enable.sh --dry-run         只校验与比对，不写远端、不动 CI
#   bash scripts/r2-enable.sh --no-secrets      建基线但不改 GitHub Secrets
#   bash scripts/r2-enable.sh --refresh         用最新已发布状态覆盖远端基线
#                                               （代码还没上线、CI 仍在写 git 时，
#                                                每次发布前都要跑一次对齐）
#
# 顺序很重要：先用「最新已发布状态」建立远端基线，再切换 CI ——
# 反过来做的话，切换瞬间 CI 可能拿空桶当首次运行，把这几天推过的通知再发一遍。
# =============================================================================
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DRY_RUN=0
SYNC_SECRETS=1
REFRESH=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)    DRY_RUN=1 ;;
    --no-secrets) SYNC_SECRETS=0 ;;
    --refresh)    REFRESH=1 ;;
    -h|--help)    sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$1（可用 --dry-run / --no-secrets / --refresh）" ;;
  esac
  shift || true
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3 || true)"
[ -n "$PY" ] || die "找不到 python3"
R2_KEYS=(STATE_BACKEND R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET R2_PREFIX)

# load_config 会用意 .env 的值覆盖同名环境变量，所以命令行传入的凭证要先接住
IN_ID="${R2_ACCESS_KEY_ID:-}"
IN_SECRET="${R2_SECRET_ACCESS_KEY:-}"

load_config

# ── 1. 凭证：允许从命令行环境变量带进来，省去手改 .env ───────────────────────
step "1/5 凭证"
changed=0
if [ -n "$IN_ID" ] && [ "$IN_ID" != "$(config_get R2_ACCESS_KEY_ID)" ]; then
  config_set R2_ACCESS_KEY_ID "$IN_ID"; changed=1
fi
if [ -n "$IN_SECRET" ] && [ "$IN_SECRET" != "$(config_get R2_SECRET_ACCESS_KEY)" ]; then
  config_set R2_SECRET_ACCESS_KEY "$IN_SECRET"; changed=1
fi
if [ "$changed" -eq 1 ]; then
  ok "已从命令行接收凭证并写入 .env"
  load_config   # 重新载入，下面的连通性检查才用得上新值
fi
missing=()
for k in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
  [ -n "$(config_get "$k")" ] || missing+=("$k")
done
if [ "${#missing[@]}" -gt 0 ]; then
  err "缺少：${missing[*]}"
  acct="${R2_ACCOUNT_ID:-${CLOUDFLARE_ACCOUNT_ID:-}}"
  note "在这两个页面生成（Secret 只显示一次，关掉就看不到了）："
  [ -n "$acct" ] && note "  控制台     https://dash.cloudflare.com/$acct/r2/api-tokens"
  note "  R2 → Manage API Tokens → Create：权限 Object Read & Write → 仅 ${R2_BUCKET:-yds-state} → 永久"
  exit 1
fi
ok "账户 ${R2_ACCOUNT_ID:0:8}… / 桶 ${R2_BUCKET} / 前缀 ${R2_PREFIX:-state}"

# ── 2. 连通性 ────────────────────────────────────────────────────────────────
step "2/5 连通性"
"$PY" "$ROOT/scripts/r2_state.py" check

# ── 3. 用最新已发布状态建基线 ────────────────────────────────────────────────
step "3/5 基线"
SNAP="$(mktemp -d)"
trap 'rm -rf "$SNAP"' EXIT
git -C "$ROOT" fetch --quiet origin || warn "git fetch 失败，改用本地 data/"
mkdir -p "$SNAP/data"
if git -C "$ROOT" archive origin/main data 2>/dev/null | tar -x -C "$SNAP" 2>/dev/null; then
  ok "已取 origin/main 的 data/ 快照"
else
  cp "$ROOT"/data/*.json "$SNAP/data/" 2>/dev/null || true
  warn "取不到 origin/main，改用本地 data/"
fi
[ -n "$(ls -A "$SNAP/data" 2>/dev/null)" ] || die "快照为空，无从建立基线"

if [ "$DRY_RUN" -eq 1 ]; then
  note "dry-run：跳过 seed 与密钥同步"
  "$PY" "$ROOT/scripts/r2_state.py" diff --data "$SNAP/data"
  exit 0
fi

if [ "$REFRESH" -eq 1 ]; then
  note "--refresh：用最新已发布状态覆盖远端基线"
  "$PY" "$ROOT/scripts/r2_state.py" seed --force --data "$SNAP/data" || die "刷新基线失败"
  ok "基线已刷新"
elif "$PY" "$ROOT/scripts/r2_state.py" seed --data "$SNAP/data"; then
  ok "基线已建立"
else
  warn "seed 未执行（远端已有状态）；继续做只读比对，必要时人工确认"
fi

# ── 4. 校对：远端必须与最新已发布状态逐字节一致 ─────────────────────────────
step "4/5 校对"
diff_out="$("$PY" "$ROOT/scripts/r2_state.py" diff --data "$SNAP/data")"
printf '%s\n' "$diff_out"
tail_line="$(printf '%s\n' "$diff_out" | tail -1)"
case "$tail_line" in
  *"有变化 0 / 仅本地 0"*) ok "远端与 origin/main 一致" ;;
  *) err "远端与最新状态不一致：$tail_line"
     note "现在切 CI 会重复推送。先弄清差异来源（是否有运行正在写 git 状态）。"
     exit 1 ;;
esac

# ── 5. 切换 CI ───────────────────────────────────────────────────────────────
step "5/5 同步 GitHub Secrets"
if [ "$SYNC_SECRETS" -eq 0 ]; then
  if [ "$REFRESH" -eq 1 ]; then
    note "跳过密钥同步（--refresh 只对齐基线，CI 配置未动）"
  else
    warn "--no-secrets：CI 仍按 git 回写运行，远端状态会逐渐落后"
  fi
else
  require_gh
  for k in "${R2_KEYS[@]}"; do
    bash "$ROOT/scripts/gh-secrets.sh" --only "$k" >/dev/null || die "$k 写入失败"
    ok "$k"
  done
  note "下一轮定时任务起，状态只走 R2，仓库里不会再出现状态提交。"
fi
