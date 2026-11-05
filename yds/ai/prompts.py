"""提示词加载与渲染。

模板存放于仓库根目录 prompts/，版本由 prompts/manifest.yaml 注册。
这里只做纯文本变量替换（{{name}}），不执行模板里的任何内容。
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict

import yaml

ROOT = Path(__file__).resolve().parent.parent.parent
PROMPTS_DIR = ROOT / "prompts"
MANIFEST = PROMPTS_DIR / "manifest.yaml"

_VAR = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


class PromptError(RuntimeError):
    """提示词缺失 / 版本不匹配 / 变量未替换。"""


@dataclass(frozen=True)
class PromptSpec:
    name: str
    version: str
    system: str
    user: str
    schema_path: Path
    examples_path: Path

    @property
    def cache_key(self) -> str:
        """写进 AI 缓存，升版时自动全量重算。"""
        return f"{self.name}:{self.version}"


def load_manifest() -> dict:
    if not MANIFEST.exists():
        raise PromptError(f"缺少提示词注册表：{MANIFEST}")
    with open(MANIFEST, encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if not isinstance(data.get("prompts"), dict):
        raise PromptError("manifest.yaml 缺少 prompts 段")
    return data


def _read(rel: str) -> str:
    path = PROMPTS_DIR / rel
    if not path.is_file():
        raise PromptError(f"提示词文件不存在：{path}")
    return path.read_text(encoding="utf-8")


def load_prompt(name: str = "notices") -> PromptSpec:
    data = load_manifest()
    entry = (data.get("prompts") or {}).get(name)
    if not isinstance(entry, dict):
        raise PromptError(f"manifest.yaml 未注册提示词：{name}")
    version = str(entry.get("active") or "")
    if not version:
        raise PromptError(f"提示词 {name} 未指定 active 版本")
    # 强制版本化的文件命名，避免「改了内容却没升版」导致缓存不失效
    for key in ("system", "user"):
        rel = str(entry.get(key) or "")
        if version not in os.path.basename(rel):
            raise PromptError(f"{name}.{key} 文件名未包含版本号 {version}：{rel}")
    system = _read(str(entry["system"]))
    user = _read(str(entry["user"]))
    if "json" not in system.lower():
        raise PromptError("系统提示词必须包含 'json'（DeepSeek JSON Output 前置条件）")
    return PromptSpec(
        name=name,
        version=version,
        system=system,
        user=user,
        schema_path=PROMPTS_DIR / str(entry.get("schema") or "schemas/analysis.schema.json"),
        examples_path=PROMPTS_DIR / str(entry.get("examples") or "schemas/examples.json"),
    )


def render(template: str, **variables: str) -> str:
    """替换 {{var}}；出现未提供的变量直接报错，避免把占位符发给模型。"""
    missing: set[str] = set()

    def repl(m: re.Match) -> str:
        key = m.group(1)
        if key not in variables:
            missing.add(key)
            return m.group(0)
        return str(variables[key])

    out = _VAR.sub(repl, template)
    if missing:
        raise PromptError(f"提示词变量未提供：{', '.join(sorted(missing))}")
    leftover = _VAR.findall(out)
    if leftover:
        raise PromptError(f"提示词存在未替换变量：{', '.join(sorted(set(leftover)))}")
    return out


def load_schema(spec: PromptSpec) -> dict:
    if not spec.schema_path.is_file():
        raise PromptError(f"缺少输出 schema：{spec.schema_path}")
    with open(spec.schema_path, encoding="utf-8") as fh:
        return json.load(fh)


def load_examples(spec: PromptSpec) -> list:
    if not spec.examples_path.is_file():
        return []
    with open(spec.examples_path, encoding="utf-8") as fh:
        data = json.load(fh)
    cases = data.get("cases") if isinstance(data, dict) else None
    return cases if isinstance(cases, list) else []


def user_payload(spec: PromptSpec, items: list, today: str) -> str:
    """把批量输入渲染成 user 消息。"""
    return render(
        spec.user,
        today=today,
        notices_json=json.dumps(items, ensure_ascii=False, indent=2),
    )
