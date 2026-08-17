"""Interactive device-auth handoff to the bundled Codex CLI."""

from __future__ import annotations

import os

import codex_cli_bin
from apps.codex_agent.auth_environment import reject_api_key_auth
from apps.codex_agent.path_environment import required_absolute_path

_CODEX_HOME_ENV = "CODEX_HOME"


def main() -> None:
    reject_api_key_auth()
    required_absolute_path(_CODEX_HOME_ENV)
    executable = str(codex_cli_bin.bundled_codex_path())
    os.execv(executable, (executable, "login", "--device-auth"))


if __name__ == "__main__":
    main()
