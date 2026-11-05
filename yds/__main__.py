"""python -m yds 入口。

必须真正调用 main()，否则模块只被 import 一次就静默退出，
GitHub Actions 会误判为成功（抓取 / 发信 / 写状态全都没执行）。
"""

from .main import main

if __name__ == "__main__":
    raise SystemExit(main())
