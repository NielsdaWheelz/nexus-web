"""Serve the pinned codex app-server on its explicit listener; this process lives and dies with it.

Compose declares the rest: uid, read-only root, account volume, cwd volume, the egress peer.
"""

from __future__ import annotations

import json
import os
import re
import signal
import stat
import subprocess
from pathlib import Path
from urllib.parse import unquote, urlsplit

import codex_cli_bin
from provider_runtime.agent_runtime import materialize_codex_containment_catalog


def main() -> None:
    credential = Path(os.environ["NEXUS_CODEX_CREDENTIAL_FILE"])
    listener = os.environ["NEXUS_CODEX_ENDPOINT"]
    try:
        url = urlsplit(listener)
        port = url.port
    except ValueError:
        raise SystemExit("invalid NEXUS_CODEX_ENDPOINT") from None
    cwd_root = Path(os.environ.get("NEXUS_CODEX_CWD_ROOT", "/tmp/codex-daemon-10001/cwds"))
    if not cwd_root.is_absolute():
        raise SystemExit("NEXUS_CODEX_CWD_ROOT must be absolute")
    verifier = os.environ.get("NEXUS_CODEX_TRANSPORT_TOKEN_SHA256")
    socket: Path | None = None
    auth: tuple[str, ...] = ()
    if url.scheme == "unix" and not (url.netloc or url.query or url.fragment or verifier):
        socket = Path(unquote(url.path))
        if not socket.is_absolute():
            raise SystemExit("NEXUS_CODEX_ENDPOINT requires an absolute unix path")
    elif (
        url.scheme == "ws"
        and url.hostname
        and port is not None
        and not (url.username or url.password or url.query or url.fragment or url.path)
        and verifier is not None
        and re.fullmatch(r"[0-9a-f]{64}", verifier)
    ):
        auth = ("--ws-auth", "capability-token", "--ws-token-sha256", verifier)
    else:
        raise SystemExit("invalid NEXUS_CODEX_ENDPOINT or NEXUS_CODEX_TRANSPORT_TOKEN_SHA256")
    if stat.S_IMODE(credential.stat().st_mode) != 0o600:
        raise SystemExit(f"{credential} must be mode 0600")
    account = credential.parent
    for directory in (account / "home", account / "tmp", cwd_root):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    cwd = cwd_root / "host"
    cwd.mkdir(mode=0o500, exist_ok=True)
    # A killed host leaves its socket on the volume; this container is its only server.
    if socket is not None:
        socket.unlink(missing_ok=True)
    catalog = materialize_codex_containment_catalog(account)
    diagnostic = account / "native-stderr.log"
    with os.fdopen(
        os.open(diagnostic, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb"
    ) as native_stderr:
        process = subprocess.Popen(
            (
                codex_cli_bin.bundled_codex_path(),
                "-c",
                f"model_catalog_json={json.dumps(str(catalog))}",
                "app-server",
                "--listen",
                listener,
                *auth,
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
            stderr=native_stderr,
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
        raise SystemExit(
            f"codex app-server exited with status {status}; private diagnostics: {diagnostic}"
        )


if __name__ == "__main__":
    main()
