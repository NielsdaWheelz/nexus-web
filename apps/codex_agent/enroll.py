"""Interactive device-auth handoff to the bundled Codex CLI."""

from __future__ import annotations

import os
from pathlib import Path

import codex_cli_bin
from apps.codex_agent.auth_environment import reject_api_key_auth


def main() -> None:
    reject_api_key_auth()
    _validate_codex_home()
    executable = str(codex_cli_bin.bundled_codex_path())
    os.execv(executable, (executable, "login", "--device-auth"))


def _validate_codex_home() -> None:
    raw = os.environ.get("CODEX_HOME")
    if raw is None or not raw:
        raise RuntimeError("CODEX_HOME is required for Codex enrollment")
    path = Path(raw)
    if not path.is_absolute() or os.path.normpath(raw) != raw:
        raise RuntimeError("CODEX_HOME must be a normalized absolute path")


if __name__ == "__main__":
    main()
