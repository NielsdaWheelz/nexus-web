"""Interactive device-auth handoff to the bundled Codex CLI."""

from __future__ import annotations

import subprocess
from pathlib import Path

import codex_cli_bin
from apps.codex_agent.auth_environment import reject_subscription_api_key_auth
from apps.codex_agent.credential_state import (
    install_enrolled_auth,
    require_unenrolled_target,
)
from apps.codex_agent.path_environment import required_absolute_path

_CODEX_HOME_ENV = "CODEX_HOME"
_ENROLLMENT_AUTH_FILE_ENV = "NEXUS_CODEX_ENROLLMENT_AUTH_FILE"


def main() -> None:
    reject_subscription_api_key_auth()
    codex_home = required_absolute_path(_CODEX_HOME_ENV)
    target = required_absolute_path(_ENROLLMENT_AUTH_FILE_ENV)
    if codex_home == Path("/tmp") or not codex_home.is_relative_to(Path("/tmp")):
        raise RuntimeError("CODEX_HOME must be a dedicated path beneath enrollment tmpfs")
    if codex_home.exists():
        raise RuntimeError("enrollment CODEX_HOME must begin absent")
    codex_home.mkdir(mode=0o700)
    require_unenrolled_target(target)
    executable = str(codex_cli_bin.bundled_codex_path())
    try:
        completed = subprocess.run(
            (executable, "login", "--device-auth"),
            check=False,
        )
    except OSError as error:
        raise RuntimeError("Codex enrollment executable could not start") from error
    if completed.returncode != 0:
        raise SystemExit(completed.returncode)
    install_enrolled_auth(codex_home / "auth.json", target)


if __name__ == "__main__":
    main()
