"""Dependency-only checkout worker images, shared by lab and make.

With no services, print the dependency-hash tag. With worker services, hold the
host cache flock from inspection/build through real container creation and
retention. Created containers pin the image before the lock is released; later
startup must use the same composition and --no-build. Only unreferenced tags
under nexus-worker-checkout are removed, including references through aliases
and stopped containers. No release source or runtime identity enters the image.

COMPOSE_FILE and COMPOSE_ENV_FILES select the caller's composition; defaults
are the base and worker files, with no dotenv file. COMPOSE_PROJECT_NAME names
the holder. Cache contention has a fixed 1320-second lock wait limit.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def image_tag() -> str:
    digest = hashlib.sha256()
    for name in (
        "docker/Dockerfile.backend",
        "docker/codex-requirements.toml",
        "python/pyproject.toml",
        "python/uv.lock",
        "python/README.md",
        "node/ingest/package.json",
        "node/ingest/bun.lock",
    ):
        path = ROOT / name
        # The Dockerfile permits an absent Bun lock; absence differs from empty.
        content = path.read_bytes() if path.exists() else None
        if content is None and name != "node/ingest/bun.lock":
            raise FileNotFoundError(path)
        digest.update(name.encode() + b"\0")
        digest.update(b"absent\0" if content is None else str(len(content)).encode() + b"\0")
        if content is not None:
            digest.update(content)
    return f"nexus-worker-checkout:{digest.hexdigest()[:16]}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("services", nargs="*", choices=("worker-interactive", "worker-background"))
    services = parser.parse_args().services
    tag = image_tag()
    if not services:
        print(tag)
        return

    env = os.environ | {"NEXUS_LOCAL_WORKER_IMAGE": tag}
    env.setdefault(
        "COMPOSE_FILE",
        os.pathsep.join(
            str(ROOT / "docker" / name)
            for name in ("docker-compose.yml", "docker-compose.worker.yml")
        ),
    )
    env.setdefault("COMPOSE_ENV_FILES", os.devnull)
    state_home = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state")
    if not state_home.is_absolute():
        raise ValueError("XDG_STATE_HOME must be absolute")
    lock_path = state_home / "nexus-lab/worker-image.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, "r+") as lock:
        deadline = time.monotonic() + 1320
        previous_holder = None
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                lock.seek(0)
                holder = lock.read().strip() or "acquiring holder"
                if holder != previous_holder:
                    print(f"worker image: waiting for {holder}", file=sys.stderr, flush=True)
                    previous_holder = holder
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        f"worker image cache wait exceeded 1320s; holder: {holder}"
                    ) from None
                time.sleep(0.2)
        lock.seek(0)
        lock.truncate()
        lock.write(env["COMPOSE_PROJECT_NAME"] + "\n")
        lock.flush()
        inspected = subprocess.run(
            ["docker", "image", "inspect", tag],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
        )
        if inspected.returncode:
            print(f"worker image: building {tag}", file=sys.stderr, flush=True)
            subprocess.run(
                ["docker", "compose", "build", services[0]],
                cwd=ROOT,
                env=env,
                stdout=sys.stderr,
                check=True,
                timeout=1200,
            )
        else:
            print(f"worker image: reusing {tag}", file=sys.stderr, flush=True)
        subprocess.run(
            ["docker", "compose", "up", "--no-start", "--no-deps", "--no-build", *services],
            cwd=ROOT,
            env=env,
            stdout=sys.stderr,
            check=True,
            timeout=120,
        )
        container_ids = subprocess.run(
            ["docker", "container", "ls", "-aq", "--no-trunc"],
            check=True,
            capture_output=True,
            text=True,
            timeout=20,
        ).stdout.split()
        referenced = set()
        if container_ids:
            inspected = subprocess.run(
                ["docker", "container", "inspect", *container_ids],
                capture_output=True,
                text=True,
                timeout=20,
            )
            containers = json.loads(inspected.stdout)
            if inspected.returncode:
                # Concurrent teardown may remove containers between list and inspect.
                missing = set(container_ids) - {item["Id"] for item in containers}
                remaining = subprocess.run(
                    ["docker", "container", "ls", "-aq", "--no-trunc"],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=20,
                ).stdout.split()
                if not missing or missing.intersection(remaining):
                    inspected.check_returncode()
            referenced = {item["Image"] for item in containers}
        images = subprocess.run(
            [
                "docker",
                "image",
                "ls",
                "--no-trunc",
                "--filter",
                "reference=nexus-worker-checkout:*",
                "--format",
                "{{.Repository}}:{{.Tag}} {{.ID}}",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=20,
        ).stdout.splitlines()
        for image in images:
            old_tag, image_id = image.split()
            if old_tag != tag and image_id not in referenced:
                subprocess.run(
                    ["docker", "image", "rm", old_tag],
                    stdout=sys.stderr,
                    check=True,
                    timeout=20,
                )
    print(tag)


if __name__ == "__main__":
    main()
