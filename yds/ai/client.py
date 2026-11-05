"""OpenAI 兼容客户端（默认指向 DeepSeek）。

官方文档核对（2026-11）：
- base_url = https://api.deepseek.com，模型 deepseek-flash / deepseek-v4-pro
- JSON Output：response_format={'type': 'json_object'}，且提示词必须含 "json"
- 输出非 JSON 时 content 会被替换成空格 → 必须判空并重试
- thinking 默认开启，需 extra_body={'thinking': {'type': 'disabled'}} 关闭；
  开启时 temperature 无效，CoT 走 reasoning_content

失败一律返回 None 或抛 AiClientError，由 analyzer 降级，绝不阻断邮件主流程。
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

log = logging.getLogger("yds")


class AiClientError(RuntimeError):
    """可预期的 AI 调用失败（网络、鉴权、空响应、解析失败）。"""


@dataclass(frozen=True)
class AiConfig:
    enabled: bool
    api_key: str
    base_url: str
    model: str
    thinking: bool
    temperature: float
    max_tokens: int
    timeout: int
    batch_size: int
    max_body_chars: int
    prompt_version: str

    @property
    def usable(self) -> bool:
        return bool(self.enabled and self.api_key and self.base_url and self.model)


class AiClient:
    """薄封装：一次调用返回原始 content 字符串。"""

    def __init__(self, cfg: AiConfig):
        self.cfg = cfg
        self.calls = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self._client = None

    def _sdk(self):
        """延迟导入：离线自测 / 未配置 AI 时不要求安装 openai 包。"""
        if self._client is not None:
            return self._client
        try:
            from openai import OpenAI
        except ImportError as exc:  # pragma: no cover - 依赖缺失属部署问题
            raise AiClientError("缺少 openai 依赖，请执行 pip install -r requirements.txt") from exc
        self._client = OpenAI(
            api_key=self.cfg.api_key,
            base_url=self.cfg.base_url,
            timeout=float(self.cfg.timeout),
            max_retries=0,  # 重试由本类统一控制，便于记日志
        )
        return self._client

    def complete(self, system: str, user: str) -> str:
        """返回模型输出的 JSON 字符串；失败抛 AiClientError。

        空白 content（DeepSeek JSON Output 的已知行为）与瞬时错误各重试一次。
        """
        last = "未知错误"
        for attempt in range(2):
            try:
                kwargs = dict(
                    model=self.cfg.model,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    response_format={"type": "json_object"},
                    max_tokens=self.cfg.max_tokens,
                )
                if self.cfg.thinking:
                    kwargs["extra_body"] = {"thinking": {"type": "enabled"}}
                else:
                    kwargs["extra_body"] = {"thinking": {"type": "disabled"}}
                    kwargs["temperature"] = self.cfg.temperature

                resp = self._sdk().chat.completions.create(**kwargs)
                self.calls += 1
                usage = getattr(resp, "usage", None)
                if usage:
                    self.prompt_tokens += int(getattr(usage, "prompt_tokens", 0) or 0)
                    self.completion_tokens += int(getattr(usage, "completion_tokens", 0) or 0)

                choices = getattr(resp, "choices", None) or []
                content = choices[0].message.content if choices else None
                if content and content.strip():
                    return content.strip()
                last = "模型返回空白 content（JSON Output 已知行为）"
            except Exception as exc:  # noqa: BLE001 - SDK 异常类型多样，统一降级
                last = f"{type(exc).__name__}: {str(exc)[:160]}"
            if attempt == 0:
                log.warning("AI 调用失败，1 秒后重试一次：%s", last)
                time.sleep(1)
        raise AiClientError(last)
