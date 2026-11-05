#!/usr/bin/env python3
"""把 .env 的运行时配置同步到 Cloudflare Worker 与 GitHub Actions Secrets。

单一事实源是仓库根目录的 .env（已被 .gitignore 忽略）。改完 .env 后跑一次，
两端自动对齐，避免「退订密钥两边不一致」这类故障。

用法：
    python3 scripts/sync-secrets.py --dry-run        # 只列出会同步哪些键
    python3 scripts/sync-secrets.py --target cf      # 只同步 Cloudflare
    python3 scripts/sync-secrets.py --target gh      # 只同步 GitHub（需 gh 登录）
    python3 scripts/sync-secrets.py                 # 两端都同步
    python3 scripts/sync-secrets.py --repo owner/name

前置：
    Cloudflare : 已执行 npx wrangler login
    GitHub     : 已执行 gh auth login --web --scopes "repo,workflow"
                 且目标仓库已创建

安全：密钥只经 stdin / 临时文件传递，不打印到终端、不写入仓库。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
WORKER_DIR = ROOT / "worker"

# Cloudflare Worker 运行时变量（Variables and Secrets）
CF_KEYS = [
    "UNSUB_SECRET",
    "SUBSCRIBE_API_TOKEN",
    "UNSUB_SECRET_PREVIOUS",
    "RESEND_API_KEY",
    "CUSTOM_DOMAIN",
    "WORKERS_DEV_URL",
    "SITE_NAME",
    "MAIL_FROM_ADDRESS",
    "MAIL_FROM_NAME",
    "MAIL_TO",
    "UNSUB_TTL_DAYS",
    "MAX_PER_IP_HOUR",
    "MAX_CONFIRM_PER_DAY",
    "LIST_RATE_PER_HOUR",
]

# GitHub Actions Secrets（notify.yml 会注入同名环境变量）
GH_KEYS = [
    "CUSTOM_DOMAIN",
    "WORKERS_DEV_URL",
    "MAIL_FROM_ADDRESS",
    "MAIL_FROM_NAME",
    "MAIL_TO",
    "SITE_NAME",
    "RESEND_API_KEY",
    "UNSUB_SECRET",
    "SUBSCRIBE_API_TOKEN",
    "UNSUB_TTL_DAYS",
]


def read_env(path: Path) -> dict[str, str]:
    if not path.exists():
        sys.exit(f"缺少 {path}，请先 cp .env.example .env 并填写")
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$", line.strip())
        if not m:
            continue
        key, raw = m.group(1), m.group(2)
        quoted = re.match(r'^["\'](.*?)["\']\s*(?:#.*)?$', raw)
        if quoted:
            value = quoted.group(1)
        else:
            value = raw.split(" #", 1)[0].strip()
        values[key] = value
    return values


def pick(values: dict[str, str], keys: list[str]) -> tuple[dict[str, str], list[str]]:
    """返回非空值与被跳过的空值键名。"""
    picked = {k: values[k] for k in keys if values.get(k)}
    skipped = [k for k in keys if not values.get(k)]
    return picked, skipped


def sync_cloudflare(data: dict[str, str], skipped: list[str]) -> int:
    print("\n[Cloudflare] Variables and Secrets")
    for k in sorted(data):
        print(f"  + {k} = <{len(data[k])} 字符>")
    for k in skipped:
        print(f"  - {k} (留空，跳过)")
    fd, tmp = tempfile.mkstemp(prefix="yds-cf-secrets-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        r = subprocess.run(
            ["npx", "wrangler", "secret", "bulk", tmp],
            cwd=WORKER_DIR,
            capture_output=True,
            text=True,
        )
        tail = "\n".join((r.stdout + r.stderr).strip().splitlines()[-8:])
        print(tail)
        if r.returncode != 0:
            print("[Cloudflare] 同步失败", file=sys.stderr)
            return 1
    finally:
        Path(tmp).unlink(missing_ok=True)
    return 0


def sync_github(data: dict[str, str], skipped: list[str], repo: str) -> int:
    print(f"\n[GitHub] {repo} → Settings → Secrets and variables → Actions")
    for k in sorted(data):
        print(f"  + {k} = <{len(data[k])} 字符>")
    for k in skipped:
        print(f"  - {k} (留空，跳过)")
    if subprocess.run(["gh", "auth", "status"], capture_output=True).returncode != 0:
        print('[GitHub] 跳过：gh 未登录。先执行 gh auth login --web --scopes "repo,workflow"', file=sys.stderr)
        return 1
    failed = 0
    for key, value in data.items():
        r = subprocess.run(
            ["gh", "secret", "set", key, "--repo", repo],
            input=value,
            capture_output=True,
            text=True,
        )
        if r.returncode != 0:
            print(f"  ! {key} 写入失败：{(r.stderr or r.stdout).strip()[:160]}", file=sys.stderr)
            failed += 1
    print(f"[GitHub] 完成：{len(data) - failed}/{len(data)} 项")
    return 1 if failed else 0


def main() -> int:
    ap = argparse.ArgumentParser(description="从 .env 同步密钥到 Cloudflare / GitHub")
    ap.add_argument("--target", choices=["all", "cf", "gh"], default="all")
    ap.add_argument("--repo", default="ikaraseay/yds-notifier")
    ap.add_argument("--dry-run", action="store_true", help="只列出将同步的键，不写入")
    args = ap.parse_args()

    values = read_env(ENV_FILE)
    cf_data, cf_skip = pick(values, CF_KEYS)
    gh_data, gh_skip = pick(values, GH_KEYS)

    if args.dry_run:
        print("Cloudflare:", ", ".join(sorted(cf_data)) or "(无)")
        print("  留空跳过:", ", ".join(cf_skip) or "(无)")
        print("GitHub    :", ", ".join(sorted(gh_data)) or "(无)")
        print("  留空跳过:", ", ".join(gh_skip) or "(无)")
        if not values.get("RESEND_API_KEY"):
            print("\n提示：RESEND_API_KEY 仍为空，发信功能不可用。")
        return 0

    rc = 0
    if args.target in ("all", "cf"):
        rc |= sync_cloudflare(cf_data, cf_skip)
    if args.target in ("all", "gh"):
        rc |= sync_github(gh_data, gh_skip, args.repo)

    if not values.get("RESEND_API_KEY"):
        print("\n提示：RESEND_API_KEY 仍为空。拿到 Resend API Key 后填入 .env 再跑一次本脚本。")
    return rc


if __name__ == "__main__":
    sys.exit(main())
