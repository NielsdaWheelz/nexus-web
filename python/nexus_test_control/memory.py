from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

from nexus_test_control.model import PeakOwnedMemory
from nexus_test_control.runtime import (
    RuntimeContractError,
    compose_project_name,
    local_docker_host,
    repo_id_for,
)

_MEMORY = re.compile(r"([0-9]+(?:\.[0-9]+)?)(B|kB|KiB|MB|MiB|GB|GiB)\Z")
_MIB = 1024 * 1024


def available_memory_mib(meminfo: Path = Path("/proc/meminfo")) -> int | None:
    try:
        contents = meminfo.read_text(encoding="utf-8")
    except OSError:
        return None
    match = re.search(r"(?m)^MemAvailable:\s+([0-9]+) kB$", contents)
    return _to_mib(int(match.group(1)) * 1024) if match else None


class OwnedMemorySampler:
    def __init__(
        self,
        repo_root: Path,
        *,
        include_containers: bool,
        process_reader: Callable[[int], int] | None = None,
        container_reader: Callable[[Path], int] | None = None,
    ) -> None:
        self._repo_root = repo_root
        self._process_reader = process_reader or _process_tree_rss
        self._container_reader = container_reader or _owned_container_working_set
        self._container_roots = {repo_root} if include_containers else set()
        self._required_container_roots = set(self._container_roots)
        self._sampled_container_roots: set[Path] = set()
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._peak_process_bytes = 0
        self._peak_container_bytes = 0
        self._interval_process_bytes = 0
        self._interval_container_bytes = 0
        self._current_process_bytes = 0
        self._current_container_bytes = 0
        self._container_sample_failed = False
        self._thread = threading.Thread(target=self._sample_until_stopped, daemon=True)
        self.evidence: PeakOwnedMemory | None = None

    def start(self) -> None:
        self._sample(include_containers=bool(self._container_roots))
        self._thread.start()

    def enable_containers(self, repo_root: Path | None = None) -> None:
        """Begin container sampling after the caller owns the heavy-work lock."""
        root = repo_root or self._repo_root
        with self._lock:
            if root in self._container_roots:
                return
            self._container_roots.add(root)
            self._required_container_roots.add(root)
        self._sample(include_containers=True)

    def disable_containers(self, repo_root: Path) -> None:
        """Stop sampling a sensitivity checkout before its path is removed."""
        with self._lock:
            self._container_roots.discard(repo_root)
            if not self._container_roots:
                self._current_container_bytes = 0

    def stop(self) -> PeakOwnedMemory:
        self._stop.set()
        self._thread.join(timeout=6)
        if self._thread.is_alive():
            self._container_sample_failed = True
        else:
            self._sample(include_containers=False)
        return self._snapshot(interval=False)

    def snapshot(self) -> PeakOwnedMemory:
        return self._snapshot(interval=False)

    def checkpoint(self) -> PeakOwnedMemory:
        self._sample(include_containers=False)
        evidence = self._snapshot(interval=True)
        with self._lock:
            self._interval_process_bytes = self._current_process_bytes
            self._interval_container_bytes = self._current_container_bytes
        return evidence

    def _snapshot(self, *, interval: bool) -> PeakOwnedMemory:
        with self._lock:
            process_bytes = self._interval_process_bytes if interval else self._peak_process_bytes
            container_bytes = (
                self._interval_container_bytes if interval else self._peak_container_bytes
            )
            measurement_complete = (
                self._required_container_roots.issubset(self._sampled_container_roots)
            ) and not self._container_sample_failed
        process = _to_mib(process_bytes)
        containers = _to_mib(container_bytes)
        return PeakOwnedMemory(
            process,
            containers,
            process + containers,
            measurement_complete=measurement_complete,
        )

    def _sample_until_stopped(self) -> None:
        next_container_sample = time.monotonic() + 1
        while not self._stop.wait(0.1):
            now = time.monotonic()
            with self._lock:
                containers_enabled = bool(self._container_roots)
            include_containers = containers_enabled and now >= next_container_sample
            self._sample(include_containers=include_containers)
            if include_containers:
                next_container_sample = time.monotonic() + 1

    def _sample(self, *, include_containers: bool) -> None:
        process_bytes = self._process_reader(os.getpid())
        container_bytes: int | None = None
        container_failed = False
        sampled_roots: set[Path] = set()
        if include_containers:
            with self._lock:
                container_roots = tuple(self._container_roots)
            try:
                container_bytes = sum(self._container_reader(root) for root in container_roots)
                sampled_roots.update(container_roots)
            except (OSError, RuntimeContractError, subprocess.SubprocessError):
                container_failed = True
        with self._lock:
            self._current_process_bytes = process_bytes
            self._peak_process_bytes = max(self._peak_process_bytes, process_bytes)
            self._interval_process_bytes = max(self._interval_process_bytes, process_bytes)
            if container_failed:
                self._container_sample_failed = True
            elif container_bytes is not None:
                self._sampled_container_roots.update(sampled_roots)
                self._current_container_bytes = container_bytes
                self._peak_container_bytes = max(self._peak_container_bytes, container_bytes)
                self._interval_container_bytes = max(
                    self._interval_container_bytes, container_bytes
                )


@contextmanager
def measure_owned_memory(
    repo_root: Path, *, include_containers: bool
) -> Iterator[OwnedMemorySampler]:
    sampler = OwnedMemorySampler(repo_root, include_containers=include_containers)
    sampler.start()
    try:
        yield sampler
    finally:
        sampler.evidence = sampler.stop()


def measured(sampler: OwnedMemorySampler) -> PeakOwnedMemory:
    evidence = sampler.evidence
    if evidence is None:
        raise RuntimeError("owned-memory evidence is available only after sampling")
    return evidence


def _process_tree_rss(root_pid: int) -> int:
    pending = [root_pid]
    seen: set[int] = set()
    total = 0
    while pending:
        pid = pending.pop()
        if pid in seen:
            continue
        seen.add(pid)
        try:
            status = (Path("/proc") / str(pid) / "status").read_text(encoding="utf-8")
            children = (Path("/proc") / str(pid) / "task" / str(pid) / "children").read_text(
                encoding="utf-8"
            )
        except OSError:
            continue
        match = re.search(r"(?m)^VmRSS:\s+([0-9]+) kB$", status)
        if match:
            total += int(match.group(1)) * 1024
        pending.extend(int(value) for value in children.split() if value.isdecimal())
    return total


def _owned_container_working_set(repo_root: Path) -> int:
    docker = shutil.which("docker")
    if docker is None:
        raise RuntimeContractError("Docker is unavailable for owned-memory measurement")
    try:
        docker_environment = {
            "DOCKER_CONTEXT": "default",
            "DOCKER_HOST": local_docker_host(),
        }
        if path := os.environ.get("PATH"):
            docker_environment["PATH"] = path
        project = compose_project_name(repo_id_for(repo_root))
        listed = subprocess.run(
            (
                docker,
                "ps",
                "--filter",
                f"label=com.docker.compose.project={project}",
                "--format",
                "{{.ID}}",
            ),
            capture_output=True,
            text=True,
            check=False,
            timeout=1,
            env=docker_environment,
        )
        if listed.returncode != 0:
            raise RuntimeContractError("owned container enumeration failed")
        ids = tuple(line for line in listed.stdout.splitlines() if line)
        if not ids:
            return 0
        stats = subprocess.run(
            (docker, "stats", "--no-stream", "--format", "{{.MemUsage}}", *ids),
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
            env=docker_environment,
        )
    except (
        OSError,
        RuntimeContractError,
        subprocess.TimeoutExpired,
    ) as error:
        raise RuntimeContractError("owned container measurement failed") from error
    if stats.returncode != 0:
        raise RuntimeContractError("owned container statistics failed")
    return sum(_memory_bytes(line.split("/", 1)[0].strip()) for line in stats.stdout.splitlines())


def _memory_bytes(value: str) -> int:
    match = _MEMORY.fullmatch(value)
    if match is None:
        raise RuntimeContractError(f"invalid Docker memory value: {value!r}")
    amount = float(match.group(1))
    multiplier = {
        "B": 1,
        "kB": 1000,
        "KiB": 1024,
        "MB": 1000**2,
        "MiB": 1024**2,
        "GB": 1000**3,
        "GiB": 1024**3,
    }[match.group(2)]
    return int(amount * multiplier)


def _to_mib(value: int) -> int:
    return (value + _MIB - 1) // _MIB if value else 0
