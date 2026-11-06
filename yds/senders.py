"""发信通道：Resend API（主）与 SMTP（备）。

为什么需要两种：
- 只有域名、没有邮箱服务器时，用 Resend + 域名验证就能以 `notice@yourdomain.com` 发信，
  而且走 HTTPS(443) 出网，不受 GitHub Actions 封锁 25 端口的影响。
- 保留 SMTP 是为了本地调试和兜底（Resend 出问题时可切回普通邮箱授权码）。

统一接口：`build_client(config)` 按 config.yaml 的 mail.provider 返回具体实现。
"""

from __future__ import annotations

import logging
import re
import smtplib
import ssl
import time
from typing import Optional, Sequence

import requests

from .config import settings
from .fetch import UA

log = logging.getLogger("yds")

UNOFFICIAL_TAG = "[非官方]"


def unofficial_sender_name(name: str) -> str:
    """发件人显示名统一带 [非官方]，与 Worker 端 unofficialSenderName 同规则。

    收件箱里只显示名字，这是收件人唯一能一眼分辨「不是组委会」的位置。
    幂等：配置里已经写了 [非官方] 也不会重复叠加。
    """
    base = re.sub(r"\[非官方\]", "", name or "").strip()
    return f"{base or '研电赛通知'} {UNOFFICIAL_TAG}"


class BaseSender:
    provider = "base"

    def __init__(self, sender_name: str, sender_email: str, reply_to: str = ""):
        # 在基类统一加后缀：Resend / SMTP / 以后新增的通道都自动带上
        self.sender_name = unofficial_sender_name(sender_name)
        self.sender_email = sender_email
        self.reply_to = reply_to

    @property
    def from_header(self) -> str:
        return f"{self.sender_name} <{self.sender_email}>" if self.sender_name else self.sender_email

    def send(
        self,
        recipients: Sequence[str],
        subject: str,
        text: str,
        html: str,
        extra_headers: Optional[dict] = None,
    ) -> None:
        raise NotImplementedError

    def preflight(self) -> Optional[str]:
        """发信前自检，返回警告文案（None 表示正常）。"""
        return None


# --------------------------------------------------------------------------
# Resend（推荐：只需域名，无需邮箱服务器）
# --------------------------------------------------------------------------
class ResendSender(BaseSender):
    provider = "resend"
    ENDPOINT = "https://api.resend.com/emails"

    def __init__(self, api_key: str, sender_name: str, sender_email: str, reply_to: str = ""):
        super().__init__(sender_name, sender_email, reply_to)
        self.api_key = api_key

    def send(
        self,
        recipients: Sequence[str],
        subject: str,
        text: str,
        html: str,
        extra_headers: Optional[dict] = None,
    ) -> None:
        payload = {
            "from": self.from_header,
            "to": list(recipients),
            "subject": subject,
            "text": text,
            "html": html,
        }
        if self.reply_to:
            payload["reply_to"] = self.reply_to
        if extra_headers:
            # Resend 支持自定义邮件头，用于 List-Unsubscribe 等标准头
            payload["headers"] = dict(extra_headers)

        headers = {"Authorization": f"Bearer {self.api_key}", "User-Agent": UA}
        last: Optional[str] = None
        for attempt in (1, 2, 3):
            try:
                resp = requests.post(self.ENDPOINT, json=payload, headers=headers, timeout=30)
                if resp.status_code in (200, 201, 202):
                    log.info("Resend 已投递 -> %s（id=%s）", ", ".join(recipients), resp.json().get("id", "?"))
                    return
                # 4xx 里除了 429，其余都是配置错误（域名未验证、发件人不对），重试无意义
                last = f"HTTP {resp.status_code}: {resp.text[:300]}"
                if 400 <= resp.status_code < 500 and resp.status_code != 429:
                    raise RuntimeError(f"Resend 拒绝发送：{last}")
                log.warning("Resend 第 %s 次失败：%s", attempt, last)
            except requests.RequestException as exc:
                last = str(exc)
                log.warning("Resend 网络异常(%s/3)：%s", attempt, exc)
            if attempt < 3:
                time.sleep(3 * attempt)
        raise RuntimeError(f"Resend 发送失败：{last}")

    def preflight(self) -> Optional[str]:
        return settings.mail_preflight() or None


# --------------------------------------------------------------------------
# SMTP（本地调试 / 兜底）
# --------------------------------------------------------------------------
class SmtpSender(BaseSender):
    provider = "smtp"

    def __init__(
        self,
        host: str,
        port: int,
        user: str,
        password: str,
        sender_name: str,
        sender_email: str = "",
        security: str = "auto",
        reply_to: str = "",
    ):
        super().__init__(sender_name, sender_email or user, reply_to)
        self.host = host
        self.port = int(port)
        self.user = user
        self.password = password
        self.security = security  # auto | ssl | starttls | none

    def _connect(self):
        ctx = ssl.create_default_context()
        use_ssl = self.security == "ssl" or (self.security == "auto" and self.port == 465)
        if use_ssl:
            server = smtplib.SMTP_SSL(self.host, self.port, timeout=30, context=ctx)
        else:
            server = smtplib.SMTP(self.host, self.port, timeout=30)
            server.ehlo()
            if self.security in ("starttls", "auto"):
                server.starttls(context=ctx)
                server.ehlo()
        server.login(self.user, self.password)
        return server

    def build_message(
        self,
        recipients: Sequence[str],
        subject: str,
        text: str,
        html: str,
        extra_headers: Optional[dict] = None,
    ):
        # 延迟导入，避免 Resend 模式也加载 email 相关模块
        from email.header import Header
        from email.mime.multipart import MIMEMultipart
        from email.mime.text import MIMEText
        from email.utils import formataddr, formatdate, make_msgid

        msg = MIMEMultipart("alternative")
        msg["Subject"] = Header(subject, "utf-8")
        msg["From"] = formataddr((self.sender_name, self.sender_email))
        msg["To"] = ", ".join(recipients)
        if self.reply_to:
            msg["Reply-To"] = self.reply_to
        msg["Date"] = formatdate(localtime=True)
        msg["Message-ID"] = make_msgid(domain=self.sender_email.split("@")[-1] or "localhost")
        for k, v in (extra_headers or {}).items():
            msg[k] = v
        msg.attach(MIMEText(text, "plain", "utf-8"))
        msg.attach(MIMEText(html, "html", "utf-8"))
        return msg

    def send(
        self,
        recipients: Sequence[str],
        subject: str,
        text: str,
        html: str,
        extra_headers: Optional[dict] = None,
    ) -> None:
        msg = self.build_message(recipients, subject, text, html, extra_headers)
        last: Optional[Exception] = None
        for attempt in (1, 2):
            server = None
            try:
                server = self._connect()
                server.sendmail(self.sender_email, list(recipients), msg.as_string())
                log.info("SMTP 已发送 -> %s", ", ".join(recipients))
                return
            except Exception as exc:  # noqa: BLE001
                last = exc
                log.warning("SMTP 失败(%s/2)：%s", attempt, exc)
                if attempt == 1:
                    time.sleep(5)
            finally:
                if server is not None:
                    try:
                        server.quit()
                    except Exception:  # noqa: BLE001
                        pass
        raise RuntimeError(f"SMTP 发送失败：{last}")

    def preflight(self) -> Optional[str]:
        return settings.mail_preflight() or None


def build_client(mail_cfg: dict | None = None) -> BaseSender:
    """构造发信客户端。

    所有环境相关配置来自 `.env` / 环境变量（见 yds/config.py）；
    mail_cfg 仅保留作为旧版 config.yaml 的显示名兜底，可传 None。
    """
    cfg = mail_cfg or {}
    name = settings.mail_from_name or cfg.get("sender_name", "研电赛通知")
    addr = settings.mail_from_address
    reply_to = settings.reply_to

    if settings.mail_provider == "resend":
        return ResendSender(
            api_key=settings.resend_api_key,
            sender_name=name,
            sender_email=addr,
            reply_to=reply_to,
        )

    return SmtpSender(
        host=settings.smtp_host,
        port=settings.smtp_port,
        user=settings.smtp_user,
        password=settings.smtp_password,
        sender_name=name,
        sender_email=addr,
        security=settings.smtp_security,
        reply_to=reply_to,
    )
