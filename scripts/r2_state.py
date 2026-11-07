#!/usr/bin/env python3
"""R2 状态存储运维工具：校验配置、建立基线、比对远近端。

    python scripts/r2_state.py check          校验凭证 / 桶 / 前缀，列出远端对象
    python scripts/r2_state.py seed           用 data/*.json 建立远端基线（首次迁移）
    python scripts/r2_state.py seed --force   远端已有对象也覆盖（慎用）
    python scripts/r2_state.py pull --to DIR  把远端状态拉到指定目录（默认 .r2-preview）
    python scripts/r2_state.py diff           逐个对象比对本地与远端（push 会跳过哪些）

只读写对象存储，不抓取、不发信、不修改 data/ 下文件（pull 默认写到临时目录）。
凭证来自 .env 的 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN / R2_BUCKET。
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from yds.config import settings  # noqa: E402
from yds.store import STATE_FILES, StateUnavailable, build_store  # noqa: E402

DATA_DIR = os.path.join(ROOT, "data")


def _require_store():
    store = build_store(settings)
    if store is not None:
        return store
    missing = [
        name
        for name, value in (
            ("R2_BUCKET", settings.r2_bucket),
            ("CLOUDFLARE_ACCOUNT_ID", settings.cloudflare_account_id),
            ("CLOUDFLARE_API_TOKEN", settings.cloudflare_api_token),
        )
        if not value
    ]
    if (settings.state_backend or "auto").lower() in ("local", "git", "off"):
        print("state_backend=%s，R2 被显式关闭（改成 auto 才会启用）" % settings.state_backend)
    else:
        print("R2 未启用，缺少：" + ("、".join(missing) or "（未知原因）"))
    print("提示：在 Manage Account → Account API Tokens 创建账户级 Token，权限选 Workers R2 Storage Read/Write。")
    raise SystemExit(2)


def _remote_objects(store) -> list[dict]:
    try:
        return store.list_objects()
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"列对象失败（桶名 / Token 权限 / 网络）：{str(exc)[:200]}")


def cmd_check(store) -> int:
    print(f"桶        : {store.bucket}")
    print(f"账户      : {settings.cloudflare_account_id}")
    print(f"前缀      : {store.prefix or '(根)'}")
    print(f"本地状态  : {DATA_DIR}")
    objects = _remote_objects(store)
    print(f"远端对象  : {len(objects)} 个")
    for obj in objects:
        size = obj.get("Size") or 0
        print(f"  {obj['Key']:<28} {size/1024:>8.1f} KB  {obj.get('LastModified')}")
    if not objects:
        print("  桶内还是空的 —— 执行 `seed` 可把本地 data/*.json 作为基线写上去")
    return 0


def cmd_seed(store, force: bool, data_dir: str) -> int:
    existing = _remote_objects(store)
    states = [o for o in existing if not o["Key"].endswith("_ready.json")]
    if states and not force:
        print(f"远端已有 {len(states)} 个状态对象，拒绝覆盖（确需覆盖加 --force）")
        print("首次迁移只需要跑一次；重复 seed 会把远端状态回退成这台的副本。")
        return 1
    have = [n for n in STATE_FILES if os.path.exists(os.path.join(data_dir, n))]
    if not have:
        print(f"{data_dir} 没有任何状态文件，无从 seed")
        return 1
    print(f"源目录：{data_dir}")
    print("将上传：" + "、".join(have))
    result = store.push(data_dir)
    if result["uploaded"]:
        print("已上传：" + "、".join(result["uploaded"]))
    if result["skipped"]:
        print("内容未变跳过：" + "、".join(result["skipped"]))
    if result["missing"]:
        print("本地缺失（不视为错误）：" + "、".join(result["missing"]))
    after = _remote_objects(store)
    print(f"远端现有 {len(after)} 个对象；初始化标记：{'有' if any(o['Key'].endswith('_ready.json') for o in after) else '无'}")
    return 0


def cmd_pull(store, dest: str) -> int:
    os.makedirs(dest, exist_ok=True)
    try:
        got = store.pull(dest)
    except StateUnavailable as exc:
        print(f"拉取失败：{exc}")
        return 1
    print(f"拉到 {got} 个文件 → {dest}")
    return 0


def cmd_diff(store, data_dir: str) -> int:
    same = changed = only_local = only_remote = 0
    for name in STATE_FILES:
        path = os.path.join(data_dir, name)
        if not os.path.exists(path):
            continue
        with open(path, "rb") as fh:
            digest = hashlib.sha256(gzip.compress(fh.read(), mtime=0)).hexdigest()
        try:
            remote = hashlib.sha256(store.read_object(name)).hexdigest()
        except FileNotFoundError:
            print(f"  {name:<16} 仅本地存在 → push 会上传")
            only_local += 1
            continue
        except Exception as exc:  # noqa: BLE001
            print(f"  {name:<16} 读取失败：{str(exc)[:80]}")
            continue
        if remote == digest:
            print(f"  {name:<16} 一致 → push 跳过（0 次写）")
            same += 1
        else:
            print(f"  {name:<16} 不同 → push 会上传")
            changed += 1
    for obj in _remote_objects(store):
        base = os.path.basename(obj["Key"])[: -len(".gz")] if obj["Key"].endswith(".gz") else ""
        if base and base != "_ready" and not os.path.exists(os.path.join(data_dir, base)):
            only_remote += 1
    print(f"\n一致 {same} / 有变化 {changed} / 仅本地 {only_local} / 仅远端 {only_remote}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="R2 状态存储运维")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check", help="校验配置并列出远端对象")
    p_seed = sub.add_parser("seed", help="用本地状态建立远端基线")
    p_seed.add_argument("--force", action="store_true", help="远端已有对象也覆盖")
    p_seed.add_argument("--data", default=DATA_DIR, help="状态源目录（默认 data/）")
    p_pull = sub.add_parser("pull", help="把远端状态拉到指定目录")
    p_pull.add_argument("--to", default=os.path.join(ROOT, ".r2-preview"))
    p_diff = sub.add_parser("diff", help="比对本地与远端")
    p_diff.add_argument("--data", default=DATA_DIR, help="状态源目录（默认 data/）")
    args = parser.parse_args()

    store = _require_store()
    if args.cmd == "check":
        return cmd_check(store)
    if args.cmd == "seed":
        return cmd_seed(store, args.force, args.data)
    if args.cmd == "pull":
        return cmd_pull(store, args.to)
    if args.cmd == "diff":
        return cmd_diff(store, args.data)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
