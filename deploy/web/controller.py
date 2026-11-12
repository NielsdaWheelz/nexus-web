#!/usr/bin/env python3
"""Coordinate one sealed web candidate and its matching backend release."""

from __future__ import annotations

import argparse
import os
import re
import selectors
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path
from types import FrameType
from typing import BinaryIO

from artifact import ArtifactError, load_manifest, sha256_file

ROOT = Path(__file__).resolve().parents[2]
SSH = (
    "ssh",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    "-o", "StrictHostKeyChecking=yes",
    "dev-server",
)  # fmt: skip
LOCK = "/run/lock/nexus-web-release.lock"
OWNER = "sudo python3 /opt/nexus-web/control/release.py"


class Failure(RuntimeError):
    """The named phase could not establish its required result."""


def interrupt(_signal: int, _frame: FrameType | None) -> None:
    raise KeyboardInterrupt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="local sealed candidate's manifest.json")
    parser.add_argument(
        "--initialize-native-host",
        action="store_true",
        help="explicit first installation of native identity after stopped writers and backup",
    )
    arguments = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupt)
    stage = "preflight"
    backend_started = False
    incoming: str | None = None
    try:
        candidate_path = arguments.manifest.resolve(strict=True)
        if candidate_path.name != "manifest.json":
            raise Failure("select the sealed candidate's manifest.json")
        candidate = load_manifest(candidate_path)
        directory = candidate_path.parent
        for name, expected in (
            ("app.tar.gz", candidate.archive_sha256),
            ("runtime.env", candidate.config_sha256),
        ):
            if sha256_file(directory / name) != expected:
                raise Failure(f"{name} differs from the manifest; select the original candidate")
        for command in ("git", "gh", "ssh", "uv"):
            if shutil.which(command) is None:
                raise Failure(f"{command} is required")
        if not (ROOT / "python/.venv/bin/python").is_file():
            raise Failure("install the locked python dependencies before releasing")
        if subprocess.check_output(
            ["git", "status", "--porcelain", "--untracked-files=normal"], cwd=ROOT, timeout=30
        ):
            raise Failure("a release requires a clean checkout")
        source = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, timeout=30, text=True
        ).strip()
        if source != candidate.source_sha:
            raise Failure("the candidate source must equal checked-out head")
        subprocess.run(
            ["git", "fetch", "--quiet", "origin", "main"], cwd=ROOT, timeout=120, check=True
        )
        if subprocess.run(
            ["git", "merge-base", "--is-ancestor", source, "origin/main"],
            cwd=ROOT,
            timeout=30,
            check=False,
        ).returncode:
            raise Failure("the candidate source must be merged into freshly fetched origin/main")

        stage = "lock"
        print(f"release: taking {LOCK} on dev-server", flush=True)
        with subprocess.Popen(
            (*SSH, f"sudo flock --nonblock {LOCK} sh -c 'echo held && exec cat >/dev/null'"),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        ) as lock:
            if lock.stdout is None:
                raise Failure("the lock session has no response pipe")
            with selectors.DefaultSelector() as ready:
                ready.register(lock.stdout, selectors.EVENT_READ)
                if not ready.select(timeout=30) or lock.stdout.readline() != b"held\n":
                    raise Failure("release lock unavailable; inspect the current release and ssh")

            def run(
                argv: tuple[str, ...],
                *,
                timeout: int | None = 600,
                stdin: BinaryIO | None = None,
                capture: bool = False,
            ) -> str:
                """Keep every child inside the lock lifetime, including controller interruption."""
                if lock.poll() is not None:
                    raise Failure("release lock connection ended; inspect hosts before retrying")
                with subprocess.Popen(
                    argv,
                    cwd=ROOT,
                    stdin=stdin if stdin is not None else subprocess.DEVNULL,
                    stdout=subprocess.PIPE if capture else None,
                    start_new_session=True,
                ) as process:
                    deadline = time.monotonic() + timeout if timeout is not None else None
                    try:
                        while process.poll() is None:
                            if lock.poll() is not None:
                                raise Failure("release lock connection ended during the command")
                            if deadline is not None and time.monotonic() >= deadline:
                                raise Failure(f"command exceeded {timeout} seconds")
                            try:
                                process.wait(timeout=1)
                            except subprocess.TimeoutExpired:
                                continue
                        if process.returncode != 0:
                            raise Failure(
                                f"command exited {process.returncode}; inspect its output"
                            )
                        if lock.poll() is not None:
                            raise Failure("release lock connection ended before phase completion")
                        return (
                            process.stdout.read().decode("utf-8", "replace")
                            if process.stdout is not None
                            else ""
                        )
                    finally:
                        if process.poll() is None:
                            try:
                                os.killpg(process.pid, signal.SIGTERM)
                            except ProcessLookupError:
                                pass  # justify-ignore-error: the child exited between poll and signal.
                            try:
                                process.wait(timeout=10)
                            except subprocess.TimeoutExpired:
                                try:
                                    os.killpg(process.pid, signal.SIGKILL)
                                except ProcessLookupError:
                                    pass  # justify-ignore-error: the child exited after the wait.
                                process.wait()

            stage = "transfer"
            digest = candidate.digest()
            incoming = run(
                (*SSH, f"sudo mktemp -d /srv/nexus-web/incoming/{digest}.XXXXXX"), capture=True
            ).strip()
            if (
                re.fullmatch(rf"/srv/nexus-web/incoming/{digest}\.[A-Za-z0-9]{{6}}", incoming)
                is None
            ):
                raise Failure("incoming directory response is invalid; inspect dev-server")
            with tempfile.TemporaryFile() as bundle:
                with tarfile.open(fileobj=bundle, mode="w", dereference=True) as archive:
                    for name in ("manifest.json", "app.tar.gz", "runtime.env"):
                        archive.add(directory / name, arcname=name, recursive=False)
                bundle.seek(0)
                run(
                    (*SSH, f"sudo tar --extract --file=- --directory={shlex.quote(incoming)}"),
                    stdin=bundle,
                )
            manifest = f"/srv/nexus-web/releases/{digest}/manifest.json"
            stage = "prepare web"
            print(f"release: preparing web candidate {digest}", flush=True)
            run((*SSH, f"{OWNER} prepare {shlex.quote(incoming)}"))
            stage = "remove incoming"
            run((*SSH, f"sudo rm -r -- {shlex.quote(incoming)}"), timeout=30)
            incoming = None
            stage = "release backend"
            backend_started = True
            print(f"release: converging backend source {source}", flush=True)
            run(
                (
                    "env",
                    f"PYTHONPATH={ROOT / 'python'}",
                    "uv",
                    "run",
                    "--project",
                    str(ROOT / "python"),
                    "--frozen",
                    "--no-sync",
                    "python",
                    "-B",
                    str(ROOT / "deploy/hetzner/release.py"),
                    source,
                    *(("--initialize-native-host",) if arguments.initialize_native_host else ()),
                ),
                timeout=None,  # the backend owner bounds its own phases, including backup lock wait.
            )
            stage = "activate web"
            print(f"release: activating web candidate {digest}", flush=True)
            run((*SSH, f"{OWNER} activate {manifest}"))
            stage = "check web"
            run((*SSH, f"{OWNER} check {manifest}"))
            stage = "unlock"
            if lock.stdin is not None:
                lock.stdin.close()
            if lock.wait(timeout=15) != 0:
                raise Failure("release lock connection ended without a clean exit")
        print(f"released {source}: backend and web candidate {digest} checked", flush=True)
        return 0
    except (ArtifactError, Failure, OSError, subprocess.SubprocessError, KeyboardInterrupt) as exc:
        if isinstance(exc, (ArtifactError, Failure)):
            detail = str(exc)
        elif isinstance(exc, OSError):
            detail = f"{exc.strerror}: {exc.filename or 'operation'}"
        elif isinstance(exc, KeyboardInterrupt):
            detail = "interrupted"
        else:
            detail = "command failed or timed out; inspect its output"
        print(f"release: {stage} failed: {detail}", file=sys.stderr)
        if incoming is not None:
            print(
                f"release: remove private incoming directory {incoming} after repair",
                file=sys.stderr,
            )
        print(
            "release: backend mutation may have begun; keep clients closed, inspect both hosts and repair forward"
            if backend_started
            else "release: serving web was not changed; repair the named prerequisite",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
