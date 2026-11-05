"""AI 分析能力子包（OpenAI 兼容接口，默认 DeepSeek）。

分层约定：
- 本包**不 import** `yds.models` / `yds.publish` / `yds.state`，只接受纯 dict、返回纯 dict，
  便于独立测试与替换 provider。Notice ↔ dict 的转换由调用方（`yds/main.py`）负责。
- `client.py`   仅负责一次 /chat/completions 调用
- `prompts.py`  仅负责加载与渲染 prompts/ 目录下的模板
- `schema.py`   仅负责校验与「模型提议、代码决定」的日期归一化
- `cache.py`    仅负责 data/ai.json 的读写
- `analyzer.py` 唯一编排入口：批量 → 缓存 → 调用 → 校验 → 降级

提示词一律放在仓库根目录 `prompts/`，不要把提示词正文写进代码。
"""

from .analyzer import analyze_notices
from .schema import AiAnalysis, AiEvent, validate_response

__all__ = ["analyze_notices", "AiAnalysis", "AiEvent", "validate_response"]
