"""The exact locked Codex npm launcher; native host qualification owns its version check."""

from __future__ import annotations

import shutil
from pathlib import Path


def codex_command() -> tuple[str, str]:
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("the Codex host requires Node")
    launcher = (
        Path(__file__).resolve().parents[2] / "node/codex/node_modules/@openai/codex/bin/codex.js"
    )
    if not launcher.is_file():
        raise RuntimeError("install the locked node/codex dependencies with bun")
    return str(Path(node).resolve()), str(launcher)
