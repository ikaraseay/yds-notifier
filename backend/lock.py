"""单实例运行锁。

为什么需要：状态（seen / ai / pending / zones）默认存 R2、未配置时为本地文件，
本轮运行期间会读-改-写。CI 里有 `concurrency: yds-notify` 串行化，但**本地 `--backfill`
与定时任务同时跑**时两者各写一份，后写者覆盖前者，`seen` 回退 → 下一轮重复发信。
这类故障一旦发生，表现是"订阅者收到重复邮件"，很难与代码 bug 区分。

实现：`fcntl.flock` 非阻塞独占锁。进程退出（含崩溃、被 kill）时由内核自动释放，
不会留下"死锁文件"；锁文件本身留在磁盘上无副作用。

平台差异：Windows 无 `fcntl`，退化为「不加锁」——本项目只在 macOS / Linux /
GitHub Actions 上运行，退化路径仅用于本地 Windows 调试。
"""

from __future__ import annotations

import logging
import os

try:  # pragma: no cover - 平台差异
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]

log = logging.getLogger("yds")


class RunLock:
    """独占运行锁。`acquire()` 返回 False 表示已有实例在跑，调用方应直接退出。"""

    def __init__(self, path: str):
        self.path = path
        self._fh = None

    def acquire(self) -> bool:
        if fcntl is None:
            log.debug("当前平台不支持 flock，跳过运行锁")
            return True
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        fh = open(self.path, "a+", encoding="utf-8")
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fh.close()
            return False
        # 记下持有者，便于人工排查"谁在跑"
        try:
            fh.seek(0)
            fh.truncate()
            fh.write(f"pid={os.getpid()}\n")
            fh.flush()
        except OSError:
            pass
        self._fh = fh  # 故意不关闭：fd 存活期间锁才有效，进程退出即释放
        return True

    def release(self) -> None:
        if self._fh is None:
            return
        try:
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)  # type: ignore[union-attr]
        except OSError:
            pass
        self._fh.close()
        self._fh = None
