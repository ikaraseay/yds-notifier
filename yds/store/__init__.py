"""状态存储层：把"两次运行之间怎么传状态"与业务代码解耦。

当前实现：`r2`（Cloudflare R2 REST API，账户级 Token 鉴权）。未配置凭证时
`build_store()` 返回 None，整条链路退回本地 JSON 文件 + git 回写。

用法（main.py）：

    store = build_store(settings)
    if store:
        store.pull(DATA_DIR)           # 运行前：远端 → 本地
    ...
    store.push(DATA_DIR)               # 运行后：本地 → 远端，只传变了的

约定：
- 本地始终是普通 JSON（业务代码不感知远端），远端是 gzip 对象；
- push 会跳过内容未变的文件，相等内容不会产生写操作；
- 远端对象被别的运行改过时抛 `StateConflict`，由调用方决定是否中止 ——
  绝不静默覆盖，否则会丢掉别人刚记录的"已推送"标记，导致重复发信。
  （REST 上传前按 ETag 做冲突检测；原子性由 Actions 的 concurrency 组与本地运行锁保证。）
"""

from __future__ import annotations

from .r2 import (
    STATE_FILES,
    R2StateStore,
    StateConflict,
    StateUnavailable,
    build_store,
)

__all__ = ["STATE_FILES", "R2StateStore", "StateConflict", "StateUnavailable", "build_store"]
