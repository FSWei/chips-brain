"""brain-gate — Hermes 侧写闸（chips-brain 适配器）。

把 `MemoryStore.add` 与 `MemoryStore.apply_batch` 包一层：写之前先问 brain.js，
不合规直接返回错误。规则只有一份（brain.js/policy.js），与 DSH 侧完全相同。

为什么不用 pre_tool_call 钩子：`memory` 属于 model_tools._AGENT_LOOP_TOOLS，
走内联执行器，钩子链不覆盖；provider 注册同名 schema 也会被 _HERMES_CORE_TOOLS 过滤。
详见 docs/WRITE-GATE.md。

失败即放行：node 不在、超时、任何异常都不拦，闸门不能拖垮会话。
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)

BRAIN_BIN = Path(
    os.environ.get("BRAIN_BIN")
    or (Path.home() / "agent-brain" / ".brain" / "bin" / "brain.js")
)
WRITE_ACTIONS = {"add", "patch"}
BASE = Path(__file__).resolve().parent
LOG = BASE / "logs" / "gate.log"
_INSTALLED_ATTR = "_brain_gate_installed"


def _audit(line: str) -> None:
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass


def brain_check(content: str, target: str) -> dict | None:
    """调用 brain.js check；任何异常返回 None（= 放行）。"""
    try:
        proc = subprocess.run(
            [
                "node", str(BRAIN_BIN), "check",
                "--file", "USER" if target == "user" else "MEMORY",
                "--text", content,
            ],
            capture_output=True, text=True, timeout=8,
        )
        out = (proc.stdout or "").strip()
        if not out:
            return None
        data = json.loads(out)
        return data if isinstance(data, dict) and "ok" in data else None
    except Exception:
        return None


def _blocked(decided: dict) -> dict:
    suggestions = " / ".join(
        str(s.get("action") or "") for s in (decided.get("suggestions") or []) if isinstance(s, dict)
    )
    message = f"[brain] {decided.get('reason') or 'policy'}: {decided.get('detail') or ''}"
    if suggestions:
        message += f"｜可选：{suggestions}"
    return {
        "success": False,
        "error": message,
        "reason": decided.get("reason"),
        "suggestions": decided.get("suggestions") or [],
    }


def install() -> bool:
    """幂等安装 Store 写闸。返回是否本次新装。"""
    try:
        from tools.memory_tool import MemoryStore
    except Exception:
        return False
    if getattr(MemoryStore, _INSTALLED_ATTR, False):
        return False

    orig_add = MemoryStore.add
    orig_batch = getattr(MemoryStore, "apply_batch", None)

    def gated_add(self, target: str, content: str):
        try:
            decided = brain_check(content, target if target in ("memory", "user") else "memory")
            if isinstance(decided, dict) and decided.get("ok") is False:
                _audit(f"BLOCK add {target} {decided.get('reason')} :: {str(content)[:60]!r}")
                return _blocked(decided)
        except Exception:
            pass
        return orig_add(self, target, content)

    MemoryStore.add = gated_add

    if callable(orig_batch):
        def gated_batch(self, target: str, operations):
            try:
                for op in (operations or []):
                    if not isinstance(op, dict):
                        continue
                    if str(op.get("action") or "add").lower() not in WRITE_ACTIONS:
                        continue
                    text = op.get("content") or op.get("new_text") or ""
                    if not isinstance(text, str) or not text.strip():
                        continue
                    decided = brain_check(text, target if target in ("memory", "user") else "memory")
                    if isinstance(decided, dict) and decided.get("ok") is False:
                        _audit(f"BLOCK batch {target} {decided.get('reason')} :: {text[:60]!r}")
                        return _blocked(decided)
            except Exception:
                pass
            return orig_batch(self, target, operations)

        MemoryStore.apply_batch = gated_batch

    setattr(MemoryStore, _INSTALLED_ATTR, True)
    log.info("brain-gate installed on MemoryStore (add + apply_batch)")
    return True


def register(ctx) -> None:  # Hermes 插件入口
    install()
