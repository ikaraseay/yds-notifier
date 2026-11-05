"""统一配置入口：`.env` → 进程环境变量 → 内置默认值。

优先级从高到低：
    1. 进程环境变量（GitHub Actions Secrets、Cloudflare 注入的变量）
    2. 仓库根目录 .env（本地开发）
    3. 内置默认值

设计要点：**单一事实源**。域名只填 `CUSTOM_DOMAIN`（或首次部署时的
`WORKERS_DEV_URL`），`PUBLIC_BASE_URL`、`UNSUB_URL`、`SUBSCRIBE_API_URL`
全部自动派生；旧部署里显式填过的同名变量仍然优先生效，保证平滑升级。

`config.yaml` 只描述业务规则（数据源、去重策略），不含任何环境信息。
本模块是 Python 端读取环境配置的唯一出口。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent

# override=False：CI 上注入的 Secrets 永远优先于本地 .env
load_dotenv(ROOT / ".env", override=False)


def _s(key: str, default: str = "") -> str:
    return (os.environ.get(key) or default).strip()


def _i(key: str, default: int) -> int:
    raw = _s(key)
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def _clean_host(v: str) -> str:
    """把可能带 scheme / 路径的自定义域名清洗成纯 hostname。"""
    v = (v or "").strip().lower()
    for prefix in ("https://", "http://"):
        if v.startswith(prefix):
            v = v[len(prefix):]
    return v.split("/")[0].split(":")[0].strip()


def derive_base_url(
    explicit: str = "", custom_domain: str = "", workers_dev_url: str = ""
) -> str:
    """对外地址的派生链：显式覆盖 → 自定义域名 → workers.dev 兜底。"""
    base = (explicit or "").strip()
    if not base:
        host = _clean_host(custom_domain)
        if host and "." in host:
            base = f"https://{host}"
    if not base:
        base = (workers_dev_url or "").strip()
    return base.rstrip("/")


@dataclass(frozen=True)
class Settings:
    # 站点 / 域名
    site_name: str
    custom_domain: str
    workers_dev_url: str
    public_base_url: str
    repo_url: str

    # 发信
    mail_provider: str
    mail_from_address: str
    mail_from_name: str
    mail_to: str
    reply_to: str
    resend_api_key: str
    smtp_host: str
    smtp_port: int
    smtp_security: str
    smtp_user: str
    smtp_password: str

    # 退订 / 订阅名单（URL 自动派生）
    unsub_url: str
    subscribe_api_url: str
    unsub_secret: str
    unsub_ttl_days: int
    subscribe_api_token: str

    @classmethod
    def load(cls) -> "Settings":
        # 兼容旧部署：MAIL_FROM 曾是纯地址
        from_addr = _s("MAIL_FROM_ADDRESS") or _s("MAIL_FROM")
        custom = _clean_host(_s("CUSTOM_DOMAIN"))
        dev_url = _s("WORKERS_DEV_URL")
        base = derive_base_url(_s("PUBLIC_BASE_URL"), custom, dev_url)

        return cls(
            site_name=_s("SITE_NAME", "研电赛通知订阅"),
            custom_domain=custom,
            workers_dev_url=dev_url,
            public_base_url=base,
            repo_url=_s("REPO_URL"),
            mail_provider=_s("MAIL_PROVIDER", "resend").lower(),
            mail_from_address=from_addr,
            mail_from_name=_s("MAIL_FROM_NAME", "研电赛通知"),
            mail_to=_s("MAIL_TO"),
            reply_to=_s("REPLY_TO"),
            resend_api_key=_s("RESEND_API_KEY"),
            smtp_host=_s("SMTP_HOST", "smtp.qq.com"),
            smtp_port=_i("SMTP_PORT", 465),
            smtp_security=_s("SMTP_SECURITY", "ssl"),
            smtp_user=_s("SMTP_USER"),
            smtp_password=_s("SMTP_PASSWORD"),
            # 显式旧变量优先，否则从域名派生
            unsub_url=_s("UNSUB_URL") or (f"{base}/unsubscribe" if base else ""),
            subscribe_api_url=_s("SUBSCRIBE_API_URL") or (f"{base}/api/list" if base else ""),
            unsub_secret=_s("UNSUB_SECRET"),
            unsub_ttl_days=max(1, _i("UNSUB_TTL_DAYS", 180)),
            subscribe_api_token=_s("SUBSCRIBE_API_TOKEN"),
        )

    def mail_preflight(self) -> str:
        """返回空串表示发信配置可用，否则返回具体缺失项。"""
        if not self.mail_from_address or "@" not in self.mail_from_address:
            return "MAIL_FROM_ADDRESS 未配置（应填 notice@你的域名）"
        if self.mail_provider == "resend":
            if not self.resend_api_key:
                return "RESEND_API_KEY 未设置"
        elif self.mail_provider == "smtp":
            if not self.smtp_user or not self.smtp_password:
                return "SMTP_USER / SMTP_PASSWORD 未设置"
        else:
            return f"未知 MAIL_PROVIDER：{self.mail_provider}"
        return ""


settings = Settings.load()
