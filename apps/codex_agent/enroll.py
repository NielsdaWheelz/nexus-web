"""Enroll the subscription once: device-auth login, then install auth.json without replacing one.

Runs as a one-off of the host service, inside its account volume, confinement and egress allowlist.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

from apps.codex_agent.binary import codex_command
from apps.codex_agent.state import initialize, read


def main() -> None:
    target = Path(os.environ["NEXUS_CODEX_CREDENTIAL_FILE"])
    if target.exists():
        raise SystemExit(f"{target} exists: retire it while the host is stopped, then enroll")
    existing_state = (target.parent / "host-state.json").exists()
    if existing_state:
        read(target.parent)  # Re-enrollment retains the monotone host identity.
    with tempfile.TemporaryDirectory() as home:
        environment = {
            "CODEX_HOME": home,
            "HOME": home,
            "PATH": "/usr/bin:/bin",
            "LANG": "C.UTF-8",
        }
        login = (*codex_command(), "login", "--device-auth")
        subprocess.run(login, env=environment, check=True)
        payload = (Path(home) / "auth.json").read_bytes()
    with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    if not existing_state:
        initialize(target.parent)


if __name__ == "__main__":
    main()
