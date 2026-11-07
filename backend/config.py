"""统一配置入口：`.env` → 进程环境变量 → 内置默认值。

优先级从高到低：
    1. 进程环境变量（GitHub Actions Secrets、Cloudflare 注入的变量）
    2. 仓库根目录 .env（本地开发）
    3. 内置默认值

设计要点：**单一事实源**。域名只填 `CUSTOM_DOMAIN`（或首次部署时的
`WORKERS_DEV_URL`），`PUBLIC_BASE_URL`、`UNSUB_URL`、`SUBSCRIBE_API_URL`
全部自动派生；旧部署里显式填过的同名变量仍然优先生效，保证平滑升级。

`config/config.yaml` 只描述业务规则（数据源、去重策略），不含任何环境信息。
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


def _f(key: str, default: float) -> float:
    raw = _s(key)
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


def _b(key: str, default: bool) -> bool:
    raw = _s(key).lower()
    if not raw:
        return default
    return raw not in ("0", "false", "no", "off")


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


def derive_internal_base(workers_dev_url: str, public_base_url: str) -> str:
    """机器对机器调用（/api/list、/api/notices）的基地址。

    自定义域挂在用户 zone 下，可能受 WAF / Bot Fight 的托管质询影响 ——
    GitHub Actions 的机房 IP 曾让 POST 返回 403 "Just a moment..."。
    workers.dev 不经过该 zone 的规则，优先用它；没配时回退对外地址。
    """
    dev = (workers_dev_url or "").strip().rstrip("/")
    if dev.startswith("https://") and ".workers.dev" in dev:
        return dev
    return (public_base_url or "").rstrip("/")


@dataclass(frozen=True)
class Settings:
    # 站点 / 域名
    site_name: str
    custom_domain: str
    workers_dev_url: str
    public_base_url: str
    internal_base_url: str
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
    notices_api_url: str
    publish_notices: bool
    unsub_secret: str
    unsub_ttl_days: int
    subscribe_api_token: str

    # 状态存储（Cloudflare R2）。账户 ID + 账户级 Token + bucket 齐全即启用；
    # STATE_BACKEND=local 可强制回到"本地文件 + git 回写"。
    state_backend: str
    cloudflare_account_id: str
    cloudflare_api_token: str
    r2_bucket: str
    r2_prefix: str

    # AI 分析（OpenAI 兼容接口，默认 DeepSeek）
    # 提示词版本不在这里：由 backend/prompts/manifest.yaml 的 active 决定，避免双源
    ai_enabled: bool
    ai_api_key: str
    ai_base_url: str
    ai_model: str
    ai_thinking: bool
    ai_temperature: float
    ai_max_tokens: int
    ai_timeout: int
    ai_batch_size: int
    ai_max_body_chars: int

    @classmethod
    def load(cls) -> "Settings":
        # 兼容旧部署：MAIL_FROM 曾是纯地址
        from_addr = _s("MAIL_FROM_ADDRESS") or _s("MAIL_FROM")
        custom = _clean_host(_s("CUSTOM_DOMAIN"))
        dev_url = _s("WORKERS_DEV_URL")
        base = derive_base_url(_s("PUBLIC_BASE_URL"), custom, dev_url)
        internal = derive_internal_base(dev_url, base)

        return cls(
            site_name=_s("SITE_NAME", "研电赛通知订阅"),
            custom_domain=custom,
            workers_dev_url=dev_url,
            public_base_url=base,
            internal_base_url=internal,
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
            # 对外链接必须用自定义域；机器接口优先 workers.dev 绕开 zone WAF
            unsub_url=_s("UNSUB_URL") or (f"{base}/unsubscribe" if base else ""),
            subscribe_api_url=_s("SUBSCRIBE_API_URL") or (f"{internal}/api/list" if internal else ""),
            notices_api_url=_s("NOTICES_API_URL") or (f"{internal}/api/notices" if internal else ""),
            publish_notices=_b("PUBLISH_NOTICES", True),
            unsub_secret=_s("UNSUB_SECRET"),
            unsub_ttl_days=max(1, _i("UNSUB_TTL_DAYS", 180)),
            subscribe_api_token=_s("SUBSCRIBE_API_TOKEN"),
            state_backend=_s("STATE_BACKEND", "auto").lower(),
            cloudflare_account_id=_s("CLOUDFLARE_ACCOUNT_ID"),
            cloudflare_api_token=_s("CLOUDFLARE_API_TOKEN"),
            r2_bucket=_s("R2_BUCKET"),
            r2_prefix=_s("R2_PREFIX", "state"),
            ai_enabled=_b("AI_ENABLED", True),
            ai_api_key=_s("AI_API_KEY"),
            ai_base_url=_s("AI_BASE_URL", "https://api.deepseek.com").rstrip("/"),
            ai_model=_s("AI_MODEL", "deepseek-flash"),
            ai_thinking=_b("AI_THINKING", False),
            ai_temperature=_f("AI_TEMPERATURE", 0.1),
            ai_max_tokens=max(256, _i("AI_MAX_TOKENS", 4096)),
            ai_timeout=max(5, _i("AI_TIMEOUT", 60)),
            ai_batch_size=max(1, _i("AI_BATCH_SIZE", 8)),
            ai_max_body_chars=max(200, _i("AI_MAX_BODY_CHARS", 3000)),
        )

    def api_candidates(self, url: str, path: str) -> list[str]:
        """把机器接口地址扩展成 [主入口, 自定义域入口]，用于失败时自动回退。"""
        primary = (url or "").rstrip("/")
        bases: list[str] = []
        if primary.endswith(path):
            bases.append(primary[: -len(path)].rstrip("/"))
        elif primary:
            bases.append(primary)
        pub = (self.public_base_url or "").rstrip("/")
        if pub and pub not in bases:
            bases.append(pub)
        return [b + path for b in bases if b]

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
