from __future__ import annotations

import json
import os
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

from nexus_test_control.runtime import RuntimeContractError, local_docker_host

_MIB = 1024 * 1024


def available_storage_mib(
    repo_root: Path,
    include_docker: bool,
    *,
    _free_bytes: Callable[[Path], int] | None = None,
    _docker_root_path: Callable[[], Path] | None = None,
) -> int | None:
    """Return the lowest free space across every filesystem a proof may write."""
    try:
        roots = [repo_root.resolve(strict=True)]
        if include_docker:
            roots.append((_docker_root_path or _docker_root)())
        read_free_bytes = _free_bytes or _filesystem_free_bytes
        return min(read_free_bytes(root) // _MIB for root in roots)
    except (OSError, RuntimeContractError, ValueError):
        return None


def _filesystem_free_bytes(root: Path) -> int:
    return shutil.disk_usage(root).free


def _docker_root() -> Path:
    docker = shutil.which("docker")
    if docker is None:
        raise RuntimeContractError("Docker is unavailable for storage admission")
    environment = {
        "DOCKER_CONTEXT": "default",
        "DOCKER_HOST": local_docker_host(),
    }
    if path := os.environ.get("PATH"):
        environment["PATH"] = path
    try:
        result = subprocess.run(
            (docker, "info", "--format", "{{json .DockerRootDir}}"),
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
            env=environment,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeContractError("Docker storage root probe failed") from error
    if result.returncode != 0:
        raise RuntimeContractError("Docker storage root probe failed")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeContractError("Docker storage root is malformed") from error
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise RuntimeContractError("Docker storage root is malformed")
    try:
        return Path(value).resolve(strict=True)
    except OSError as error:
        raise RuntimeContractError("Docker storage root cannot be resolved") from error
