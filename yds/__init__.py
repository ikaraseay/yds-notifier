"""研电赛通知订阅器。

包结构：
    models   —— 数据结构
    fetch    —— 带重试的 HTTP 抓取
    sources  —— 各数据源解析器（研创网 / 中国电子学会）
    state    —— 已推送记录的持久化
    mailer   —— 邮件渲染与 SMTP 发送
    main     —— 命令行入口 / 调度编排
"""

__version__ = "1.0.0"
