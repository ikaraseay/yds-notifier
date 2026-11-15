"""Load the declarative resources of an installed MeoNotifier skill."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import yaml

SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"
DEFAULT_SKILL = "yds"
BUILTIN_SKILLS = (DEFAULT_SKILL,)


@dataclass(frozen=True)
class Skill:
    id: str
    name: str
    version: int
    directory: Path

    def load_config(self, override: str | None = None) -> dict:
        path = Path(override) if override else self.directory / "config.yaml"
        # Keep the former built-in path usable in existing CLI invocations.
        if not path.exists() and path.resolve() == SKILLS_DIR.parent / "config" / "config.yaml":
            path = self.directory / "config.yaml"
        with path.open(encoding="utf-8") as file:
            config = yaml.safe_load(file)
        if config is None:
            return {}
        if not isinstance(config, dict):
            raise ValueError(f"Skill 配置必须是 YAML 映射：{path}")
        return config

    @property
    def contests(self) -> Path:
        return self.directory / "contests.json"

    @property
    def prompts(self) -> Path:
        return self.directory / "prompts"


def load_skill(skill_id: str = DEFAULT_SKILL) -> Skill:
    """Load one built-in skill without starting the crawler or loading credentials."""
    if skill_id not in BUILTIN_SKILLS:
        raise ValueError(f"未知内置 Skill：{skill_id}")
    directory = SKILLS_DIR / skill_id
    manifest = json.loads((directory / "skill.json").read_text(encoding="utf-8"))
    if (
        not isinstance(manifest, dict) or manifest.get("id") != skill_id
        or not isinstance(manifest.get("name"), str) or not manifest["name"].strip()
        or type(manifest.get("version")) is not int or manifest["version"] < 1
    ):
        raise ValueError(f"无效的 Skill 清单：{directory / 'skill.json'}")
    return Skill(skill_id, manifest["name"], manifest["version"], directory)
