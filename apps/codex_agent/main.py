"""Serve the pinned codex app-server on the shared socket; this process lives and dies with it.

Compose declares the rest: uid, read-only root, account bind, socket volume, the egress peer.
"""

from __future__ import annotations

import json
import os
import signal
import stat
import subprocess
from pathlib import Path

import codex_cli_bin
from provider_runtime.agent_runtime import materialize_codex_containment_catalog


def main() -> None:
    credential = Path(os.environ["NEXUS_CODEX_CREDENTIAL_FILE"])
    socket = Path(os.environ["NEXUS_CODEX_NATIVE_SOCKET"])
    if stat.S_IMODE(credential.stat().st_mode) != 0o600:
        raise SystemExit(f"{credential} must be mode 0600")
    account = credential.parent
    for directory in (account / "home", account / "tmp", socket.parent / "cwds"):
        directory.mkdir(mode=0o700, exist_ok=True)
    cwd = socket.parent / "cwds" / "host"
    cwd.mkdir(mode=0o500, exist_ok=True)
    # A killed host leaves its socket on the volume; this container is its only server.
    socket.unlink(missing_ok=True)
    catalog = materialize_codex_containment_catalog(account)
    process = subprocess.Popen(
        (
            codex_cli_bin.bundled_codex_path(),
            "-c",
            f"model_catalog_json={json.dumps(str(catalog))}",
            "app-server",
            "--listen",
            f"unix://{socket}",
            "--strict-config",
        ),
        cwd=cwd,
        # Explicit, so no inherited *_API_KEY or CODEX_HOME can redirect subscription work.
        env={
            "CODEX_HOME": str(account),
            "CODEX_EXEC_SERVER_URL": "none",
            "HOME": str(account / "home"),
            "TMPDIR": str(account / "tmp"),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        },
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    stopping = False

    def stop(signum: int, frame: object) -> None:
        nonlocal stopping
        stopping = True
        process.terminate()
        # codex drains running turns for up to 45 s, the same as docker's grace period,
        # so cut the drain short and still exit 0 before docker kills the container.
        signal.alarm(30)

    signal.signal(signal.SIGALRM, lambda signum, frame: process.kill())
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    status = process.wait()
    if not stopping:
        raise SystemExit(f"codex app-server exited with status {status}")


if __name__ == "__main__":
    main()
