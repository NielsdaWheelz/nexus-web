"""Exercise the release's actual namespace mount boundary before readiness."""

from __future__ import annotations

import subprocess
from pathlib import Path

from apps.codex_agent.auth_environment import (
    reject_ambient_codex_home,
    reject_subscription_api_key_auth,
)
from apps.codex_agent.credential_state import (
    create_ephemeral_runtime_paths,
    remove_ephemeral_runtime_paths,
)
from apps.codex_agent.exec_server import sandbox_command
from apps.codex_agent.path_environment import required_absolute_path

_WORKING_DIRECTORY_ROOT_ENV = "NEXUS_CODEX_WORKING_DIRECTORY_ROOT"
_PROBE = """
set -eu
test ! -e /run/nexus-codex-credential/auth.json
test ! -e /run/nexus-codex/agent.sock
test ! -e /app/apps/codex_agent/main.py
printf 'sandbox-ok' > /workspace/sandbox-health
test -r /etc/ssl/certs/ca-certificates.crt
test -r /etc/codex/requirements.toml
"""


def check(working_directory_root: Path) -> None:
    reject_subscription_api_key_auth()
    reject_ambient_codex_home()
    paths = create_ephemeral_runtime_paths(working_directory_root, "sandbox-health")
    try:
        (paths.root / "exec-home").mkdir(mode=0o700)
        completed = subprocess.run(
            sandbox_command(
                paths,
                {"HOME": "/home/agent", "TMPDIR": "/tmp", "PATH": "/usr/bin:/bin"},
                ("/bin/sh", "-c", _PROBE),
            ),
            cwd=paths.root,
            env={"PATH": "/usr/bin:/bin"},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
        )
        marker = paths.working_directory / "sandbox-health"
        if completed.returncode != 0 or marker.read_text(encoding="ascii") != "sandbox-ok":
            raise RuntimeError("Codex execution namespace did not pass its readiness probe")
    finally:
        remove_ephemeral_runtime_paths(paths, root=working_directory_root)


def main() -> None:
    check(required_absolute_path(_WORKING_DIRECTORY_ROOT_ENV))


if __name__ == "__main__":
    main()
