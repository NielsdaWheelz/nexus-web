#!/usr/bin/env python3
"""One-time, immutable adoption of Nexus production infrastructure."""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any

_SHA = re.compile(r"[0-9a-f]{40}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
_IMAGE_REFERENCE = re.compile(r"[^\s@]+@sha256:[0-9a-f]{64}\Z")
_CONTAINER_ID = re.compile(r"[0-9a-f]{64}\Z")
_DATABASE_IDENTIFIER = re.compile(r"[a-z_][a-z0-9_]{0,62}\Z")
_REVISION = re.compile(r"[0-9a-z][0-9a-z_]{0,63}\Z")
_VOLUME_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,254}\Z")
_VERCEL_TOKEN = re.compile(r"[A-Za-z0-9._-]+\Z")
_VERCEL_DEPLOYMENT_ID = re.compile(r"dpl_[A-Za-z0-9]+\Z")
_VERCEL_DEPLOYMENT_URL = re.compile(r"[a-z0-9][a-z0-9.-]*\.vercel\.app\Z")
_VERCEL_ALIAS = re.compile(r"[a-z0-9][a-z0-9.-]*\.vercel\.app\Z")

_SSH_TARGET = "nexus@5.78.194.235"
_PRODUCTION_HOST = "nexus.nielseriknandal.com"
_VERCEL_PROJECT_NAME = "nexus-web"
_VERCEL_PROJECT_ID = "prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs"
_VERCEL_TEAM_ID = "team_fKVvTyTsMBQ7qFjccFO17BJL"
_SSH_OPTIONS = (
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
)
_SERVICES = (
    "postgres",
    "caddy",
    "api",
    "worker-interactive",
    "worker-background",
)
_WRITERS = ("api", "worker-interactive", "worker-background")
_INFRA = ("postgres", "caddy")
_EXPECTED_VOLUME_TARGETS = {
    "postgres": {"/var/lib/postgresql/data": "nexus_postgres_data"},
    "caddy": {"/data": "nexus_caddy_data", "/config": "nexus_caddy_config"},
}
_STATE_FIELDS = frozenset(
    {
        "schema_version",
        "source_sha",
        "phase",
        "input_sha256",
        "config_path",
        "config_sha256",
        "database_name",
        "database_user",
        "infra_image_references",
        "containers",
        "named_mounts",
        "database",
        "backup",
        "replacement_containers",
    }
)
_CONTAINER_FIELDS = frozenset({"container_id", "image_id", "config_sha256"})
_MOUNT_FIELDS = frozenset({"destination", "name"})
_DATABASE_FIELDS = frozenset({"identity", "revision", "table_counts"})
_BACKUP_FIELDS = frozenset({"path", "sha256", "byte_count"})
_COMPLETION_FIELDS = frozenset({"schema_version", "source_sha", "attempt_sha256", "backup_sha256"})

# justify-retry-schedule: Docker health has no event stream available to this
# one-shot host controller; 45 two-second observations bound the no-use window.
_HEALTH_ATTEMPTS = 45
_HEALTH_INTERVAL_SECONDS = 2
_DATABASE_DUMP_TIMEOUT_SECONDS = 300
_DATABASE_ARCHIVE_LIST_TIMEOUT_SECONDS = 60
_DATABASE_RESTORE_TIMEOUT_SECONDS = 420


# justify-defect: malformed retained adoption evidence or changed production
# identity is an operator-visible invariant violation, never a recovery branch.
class AdoptionDefect(RuntimeError):
    """The adoption input, evidence, or live identity violates its contract."""


class AdoptionBlocked(RuntimeError):
    """Another production lifecycle state prevents first adoption."""


class AdoptionPhase(StrEnum):
    Prepared = "Prepared"
    WritersStopped = "WritersStopped"
    DatabaseCaptured = "DatabaseCaptured"
    BackupVerified = "BackupVerified"
    FilesInstalled = "FilesInstalled"
    InfrastructureMutationStarted = "InfrastructureMutationStarted"
    InfrastructureRecreated = "InfrastructureRecreated"
    WritersRestored = "WritersRestored"
    Succeeded = "Succeeded"


_PHASE_ORDER = tuple(AdoptionPhase)


@dataclass(frozen=True, slots=True)
class AdoptionPaths:
    state_root: Path = Path("/var/lib/nexus/infra-adoption")
    release_state_root: Path = Path("/var/lib/nexus/releases")
    current_config: Path = Path("/etc/nexus/current.env")
    config_root: Path = Path("/etc/nexus/config")
    caddy_config: Path = Path("/etc/nexus/Caddyfile")
    backup_root: Path = Path("/var/backups/nexus/infra-adoption")
    lock_path: Path = Path("/run/lock/nexus-release.lock")

    @classmethod
    def under(cls, root: Path) -> AdoptionPaths:
        return cls(
            state_root=root / "var/lib/nexus/infra-adoption",
            release_state_root=root / "var/lib/nexus/releases",
            current_config=root / "etc/nexus/current.env",
            config_root=root / "etc/nexus/config",
            caddy_config=root / "etc/nexus/Caddyfile",
            backup_root=root / "var/backups/nexus/infra-adoption",
            lock_path=root / "run/lock/nexus-release.lock",
        )

    def attempt_root(self, source_sha: str) -> Path:
        return self.state_root / source_sha

    def attempt(self, source_sha: str) -> Path:
        return self.attempt_root(source_sha) / "attempt.json"

    def inputs(self, source_sha: str) -> Path:
        return self.attempt_root(source_sha) / "inputs"

    def rehearsal_claim(self, source_sha: str) -> Path:
        return self.attempt_root(source_sha) / "rehearsal-database"

    @property
    def completion(self) -> Path:
        return self.state_root / "completed.json"


def _canonical_bytes(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode()


def _digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _read_regular_bytes(path: Path, label: str) -> bytes:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as exc:
        raise AdoptionDefect(f"staged {label} input is not a readable regular file") from exc
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise AdoptionDefect(f"staged {label} input is not a regular file")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            return stream.read()
    finally:
        os.close(descriptor)


@contextlib.contextmanager
def _open_immutable_file(path: Path, label: str, mode: int) -> Iterator[Any]:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as exc:
        raise AdoptionDefect(f"{label} is not a readable immutable file") from exc
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != 0
            or metadata.st_gid != 0
            or stat.S_IMODE(metadata.st_mode) != mode
        ):
            raise AdoptionDefect(f"{label} is not root-owned with mode {mode:04o}")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            yield stream
    finally:
        os.close(descriptor)


def _read_immutable_bytes(path: Path, label: str, mode: int) -> bytes:
    with _open_immutable_file(path, label, mode) as stream:
        return stream.read()


def _immutable_digest_and_size(path: Path, label: str, mode: int) -> tuple[str, int]:
    digest = hashlib.sha256()
    byte_count = 0
    with _open_immutable_file(path, label, mode) as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            byte_count += len(chunk)
    return digest.hexdigest(), byte_count


def _require_match(label: str, value: str, pattern: re.Pattern[str]) -> str:
    if pattern.fullmatch(value) is None:
        raise AdoptionDefect(f"{label} is malformed")
    return value


def _mapping(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise AdoptionDefect(f"{label} must be an object")
    return value


def _closed_mapping(value: object, fields: frozenset[str], label: str) -> dict[str, Any]:
    mapping = _mapping(value, label)
    if mapping.keys() != fields:
        raise AdoptionDefect(f"{label} fields are not canonical")
    return mapping


def _string(mapping: Mapping[str, object], key: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str):
        raise AdoptionDefect(f"{key} must be a string")
    return value


def _integer(mapping: Mapping[str, object], key: str) -> int:
    value = mapping.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise AdoptionDefect(f"{key} must be an integer")
    return value


def _read_json(path: Path, label: str, *, mode: int) -> dict[str, Any]:
    try:
        raw = _read_immutable_bytes(path, label, mode)
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AdoptionDefect(f"{label} is unreadable") from exc
    if raw != _canonical_bytes(value):
        raise AdoptionDefect(f"{label} is not canonical JSON")
    return _mapping(value, label)


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _create_bytes(path: Path, value: bytes, *, mode: int = 0o440) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
    temporary = path.with_name(f".{path.name}.partial")
    if path.exists() or path.is_symlink():
        if _read_immutable_bytes(path, "create-only evidence", mode) != value:
            raise AdoptionDefect(f"create-only evidence changed: {path}")
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()
        _fsync_directory(path.parent)
        return
    with contextlib.suppress(FileNotFoundError):
        temporary.unlink()
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            mode,
        )
    except OSError as exc:
        raise AdoptionDefect(f"cannot stage create-only evidence: {path}") from exc
    try:
        os.fchown(descriptor, 0, 0)
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path, follow_symlinks=False)
        except FileExistsError:
            if _read_immutable_bytes(path, "create-only evidence", mode) != value:
                raise AdoptionDefect(f"create-only evidence changed: {path}") from None
        _fsync_directory(path.parent)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()
        _fsync_directory(path.parent)


def _atomic_bytes(path: Path, value: bytes, *, mode: int = 0o440) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
    temporary = path.with_name(f".{path.name}.partial")
    with contextlib.suppress(FileNotFoundError):
        temporary.unlink()
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        mode,
    )
    try:
        os.fchown(descriptor, 0, 0)
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()


@contextlib.contextmanager
def adoption_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise AdoptionBlocked("another production lifecycle operation holds the lock") from exc
        yield


class InfrastructureAdoption:
    def __init__(self, paths: AdoptionPaths | None = None) -> None:
        self.paths = paths or AdoptionPaths()

    def _run(
        self,
        command: Sequence[str],
        *,
        stdin: Any = None,
        stdout: Any = subprocess.PIPE,
        timeout_seconds: int = 120,
    ) -> subprocess.CompletedProcess[bytes]:
        try:
            return subprocess.run(
                tuple(command),
                check=True,
                stdin=stdin,
                stdout=stdout,
                stderr=subprocess.PIPE,
                timeout=timeout_seconds,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            rendered = " ".join(command[:4])
            raise AdoptionDefect(f"required host command failed: {rendered}") from exc

    def _docker_json(self, command: Sequence[str], label: str) -> object:
        completed = self._run(("docker", *command))
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise AdoptionDefect(f"Docker returned malformed {label}") from exc

    def _service_ids(self, service: str) -> tuple[str, ...]:
        completed = self._run(
            (
                "docker",
                "ps",
                "--all",
                "--no-trunc",
                "--filter",
                "label=com.docker.compose.project=nexus",
                "--filter",
                f"label=com.docker.compose.service={service}",
                "--format",
                "{{.ID}}",
            )
        )
        ids = tuple(line for line in completed.stdout.decode().splitlines() if line)
        for container_id in ids:
            _require_match("Compose container id", container_id, _CONTAINER_ID)
        return ids

    def _one_service_id(self, service: str) -> str:
        ids = self._service_ids(service)
        if len(ids) != 1:
            raise AdoptionDefect(f"service {service} must have exactly one container")
        return ids[0]

    def _inspect(self, container_id: str) -> dict[str, Any]:
        _require_match("container id", container_id, _CONTAINER_ID)
        value = self._docker_json(("inspect", container_id), "container inspection")
        if not isinstance(value, list) or len(value) != 1:
            raise AdoptionDefect("Docker inspection must contain exactly one container")
        inspected = _mapping(value[0], "container inspection")
        if _string(inspected, "Id") != container_id:
            raise AdoptionDefect("Docker inspection changed the requested container identity")
        labels = _mapping(
            _mapping(inspected.get("Config"), "container config").get("Labels"),
            "labels",
        )
        if labels.get("com.docker.compose.project") != "nexus":
            raise AdoptionDefect("container is not owned by the nexus Compose project")
        return inspected

    def _capture_container(self, service: str, container_id: str) -> dict[str, str]:
        inspected = self._inspect(container_id)
        config = _mapping(inspected.get("Config"), "container config")
        labels = _mapping(config.get("Labels"), "container labels")
        if labels.get("com.docker.compose.service") != service:
            raise AdoptionDefect(f"captured container does not own service {service}")
        image_id = _require_match("container image id", _string(inspected, "Image"), _IMAGE_ID)
        return {
            "container_id": container_id,
            "image_id": image_id,
            "config_sha256": _digest_bytes(_canonical_bytes(config)),
        }

    def _container_state(self, container_id: str) -> tuple[bool, str | None]:
        state = _mapping(self._inspect(container_id).get("State"), "container state")
        running = state.get("Running")
        if not isinstance(running, bool):
            raise AdoptionDefect("container running state is malformed")
        raw_health = state.get("Health")
        if raw_health is None:
            return running, None
        return running, _string(_mapping(raw_health, "container health"), "Status")

    def _capture_named_mounts(self, service: str, container_id: str) -> list[dict[str, str]]:
        inspected = self._inspect(container_id)
        mounts = inspected.get("Mounts")
        if not isinstance(mounts, list):
            raise AdoptionDefect("container mounts must be an array")
        expected = _EXPECTED_VOLUME_TARGETS[service]
        captured: list[dict[str, str]] = []
        for value in mounts:
            mount = _mapping(value, "container mount")
            destination = mount.get("Destination")
            if mount.get("Type") != "volume":
                if destination in expected:
                    raise AdoptionDefect(f"{service} data mount is not a writable named volume")
                continue
            if destination not in expected:
                raise AdoptionDefect(f"{service} exposes an unexpected named volume")
            if mount.get("RW") is not True:
                raise AdoptionDefect(f"{service} data mount is not a writable named volume")
            name = _string(mount, "Name") if "Name" in mount else _string(mount, "Source")
            _require_match("Docker volume name", name, _VOLUME_NAME)
            if name != expected[destination]:
                raise AdoptionDefect(f"{service} volume identity differs from planned topology")
            captured.append({"destination": str(destination), "name": name})
        if (
            len(captured) != len(expected)
            or {item["destination"]: item["name"] for item in captured} != expected
        ):
            raise AdoptionDefect(f"{service} does not expose its exact named volumes")
        return sorted(captured, key=lambda item: item["destination"])

    def _capture_config(self) -> tuple[Path, str, dict[str, str]]:
        if not self.paths.current_config.is_symlink():
            raise AdoptionDefect("current config must be an atomic content-addressed symlink")
        try:
            config_path = self.paths.current_config.resolve(strict=True)
            config_root = self.paths.config_root.resolve(strict=True)
        except OSError as exc:
            raise AdoptionDefect(
                "current config is not a file in the immutable config root"
            ) from exc
        if (
            config_path.parent != config_root
            or re.fullmatch(r"[0-9a-f]{64}\.env", config_path.name) is None
        ):
            raise AdoptionDefect("current config is not a canonical config-root child")
        raw_config = _read_immutable_bytes(config_path, "current config", 0o440)
        digest = _digest_bytes(raw_config)
        if config_path.name != f"{digest}.env":
            raise AdoptionDefect("current config path is not content-addressed")
        try:
            lines = raw_config.decode("utf-8").splitlines()
        except UnicodeDecodeError as exc:
            raise AdoptionDefect("current config cannot be read as UTF-8") from exc
        raw_values: dict[str, str] = {}
        for line_number, line in enumerate(lines, 1):
            if not line or line.startswith("#"):
                continue
            key, separator, value = line.partition("=")
            if not separator or re.fullmatch(r"[A-Z][A-Z0-9_]*", key) is None or "\x00" in value:
                raise AdoptionDefect(f"current config line {line_number} is malformed")
            if key in raw_values:
                raise AdoptionDefect("current config contains duplicate keys")
            raw_values[key] = value
        if not raw_values:
            raise AdoptionDefect("current config is empty")
        values = dict(raw_values)
        for key, value in values.items():
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                values[key] = value[1:-1]
        required = ("POSTGRES_IMAGE", "CADDY_IMAGE", "POSTGRES_USER", "POSTGRES_DB")
        if any(not values.get(key) for key in required):
            raise AdoptionDefect("current config lacks an adoption-owned value")
        _require_match("Postgres image", values["POSTGRES_IMAGE"], _IMAGE_REFERENCE)
        _require_match("Caddy image", values["CADDY_IMAGE"], _IMAGE_REFERENCE)
        _require_match("Postgres user", values["POSTGRES_USER"], _DATABASE_IDENTIFIER)
        _require_match("Postgres database", values["POSTGRES_DB"], _DATABASE_IDENTIFIER)
        return config_path, digest, values

    def _prove_pulled_image(self, reference: str, expected_id: str) -> None:
        self._run(("docker", "pull", reference))
        completed = self._run(("docker", "image", "inspect", "--format", "{{.Id}}", reference))
        if completed.stdout.decode().strip() != expected_id:
            raise AdoptionDefect("pulled infrastructure image differs from the running image")

    def _compose(
        self,
        state: Mapping[str, object],
        compose_file: Path,
        operation: Sequence[str],
    ) -> subprocess.CompletedProcess[bytes]:
        containers = _mapping(state.get("containers"), "captured containers")
        environment = os.environ.copy()
        config = _read_immutable_bytes(
            Path(_string(state, "config_path")), "captured production config", 0o440
        ).decode("utf-8")
        for raw_line in config.splitlines():
            line = raw_line.strip()
            if line and not line.startswith("#") and "=" in line:
                environment.pop(line.split("=", 1)[0].strip(), None)
        references = _mapping(
            state.get("infra_image_references"), "infrastructure image references"
        )
        environment.update(
            {
                "API_IMAGE": _string(
                    _closed_mapping(containers["api"], _CONTAINER_FIELDS, "api"),
                    "image_id",
                ),
                "WORKER_IMAGE": _string(
                    _closed_mapping(containers["worker-interactive"], _CONTAINER_FIELDS, "worker"),
                    "image_id",
                ),
                "NEXUS_CONFIG_FILE": _string(state, "config_path"),
                "POSTGRES_IMAGE": _string(references, "postgres"),
                "CADDY_IMAGE": _string(references, "caddy"),
            }
        )
        command = (
            "docker",
            "compose",
            "--project-name",
            "nexus",
            "--env-file",
            _string(state, "config_path"),
            "--file",
            str(compose_file),
            *operation,
        )
        try:
            return subprocess.run(
                command,
                check=True,
                capture_output=True,
                timeout=120,
                env=environment,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise AdoptionDefect("required scoped Compose operation failed") from exc

    def _prove_planned_topology(self, state: Mapping[str, object], compose_file: Path) -> None:
        completed = self._compose(state, compose_file, ("config", "--format", "json"))
        try:
            rendered = _mapping(json.loads(completed.stdout), "rendered Compose topology")
        except json.JSONDecodeError as exc:
            raise AdoptionDefect("rendered Compose topology is malformed") from exc
        services = _mapping(rendered.get("services"), "rendered Compose services")
        if set(services) != set(_SERVICES):
            raise AdoptionDefect("rendered Compose topology must contain the exact five services")
        containers = _mapping(state.get("containers"), "captured containers")
        refs = _mapping(state.get("infra_image_references"), "infrastructure image references")
        expected_images = {
            "postgres": _string(refs, "postgres"),
            "caddy": _string(refs, "caddy"),
            "api": _string(_mapping(containers["api"], "api evidence"), "image_id"),
            "worker-interactive": _string(
                _mapping(containers["worker-interactive"], "worker evidence"),
                "image_id",
            ),
            "worker-background": _string(
                _mapping(containers["worker-background"], "worker evidence"), "image_id"
            ),
        }
        for service, image in expected_images.items():
            if _mapping(services[service], "rendered service").get("image") != image:
                raise AdoptionDefect(f"rendered {service} image differs from captured identity")
        volumes = _mapping(rendered.get("volumes"), "rendered Compose volumes")
        expected_volume_names = {
            name for targets in _EXPECTED_VOLUME_TARGETS.values() for name in targets.values()
        }
        if set(volumes) != {"postgres_data", "caddy_data", "caddy_config"}:
            raise AdoptionDefect("rendered Compose volume keys are not exact")
        rendered_names = {
            _string(_mapping(value, "rendered volume"), "name") for value in volumes.values()
        }
        if rendered_names != expected_volume_names:
            raise AdoptionDefect("rendered Compose named volumes differ from live identity")
        expected_service_volumes = {
            "postgres": {"/var/lib/postgresql/data": "postgres_data"},
            "caddy": {"/data": "caddy_data", "/config": "caddy_config"},
        }
        rendered_mounts: dict[str, list[dict[str, Any]]] = {}
        for service, expected in expected_service_volumes.items():
            raw_mounts = _mapping(services[service], f"rendered {service}").get("volumes")
            if not isinstance(raw_mounts, list):
                raise AdoptionDefect(f"rendered {service} mounts are malformed")
            mounts = [_mapping(value, f"rendered {service} mount") for value in raw_mounts]
            rendered_mounts[service] = mounts
            observed = {
                _string(mount, "target"): _string(mount, "source")
                for mount in mounts
                if mount.get("type") == "volume"
            }
            if observed != expected:
                raise AdoptionDefect(f"rendered {service} volume topology is not exact")
        for service in _WRITERS:
            if _mapping(services[service], f"rendered {service}").get("volumes") not in (
                None,
                [],
            ):
                raise AdoptionDefect(f"rendered {service} unexpectedly mounts host data")
        caddy_mounts = rendered_mounts["caddy"]
        expected_bind = {
            "type": "bind",
            "source": "/etc/nexus/Caddyfile",
            "target": "/etc/caddy/Caddyfile",
            "read_only": True,
        }
        if (
            len(caddy_mounts) != 3
            or sum(
                isinstance(mount, dict)
                and all(mount.get(key) == value for key, value in expected_bind.items())
                for mount in caddy_mounts
            )
            != 1
        ):
            raise AdoptionDefect("rendered caddy does not use the exact read-only Caddyfile bind")
        if len(rendered_mounts["postgres"]) != 1:
            raise AdoptionDefect("rendered postgres unexpectedly mounts additional storage")

    def _require_no_release_state(self) -> None:
        root = self.paths.release_state_root
        if root.is_symlink():
            raise AdoptionDefect("application release state root must be a real directory")
        if not root.exists():
            return
        try:
            metadata = root.lstat()
            if (
                not stat.S_ISDIR(metadata.st_mode)
                or metadata.st_uid != 0
                or metadata.st_gid != 0
                or stat.S_IMODE(metadata.st_mode) != 0o750
            ):
                raise AdoptionDefect("application release state root must be a directory")
        except OSError as exc:
            raise AdoptionDefect("application release state root is unreadable") from exc
        directories = frozenset(("attempts", "oracle-attempts", "oracle-repairs", "records"))
        pointers = frozenset(("current", "forward-fix", "genesis-vercel-deployment"))
        for item in root.iterdir():
            if item.name not in directories | pointers:
                raise AdoptionDefect("application release state contains an unknown path")
        for directory in directories:
            path = root / directory
            if path.is_symlink():
                raise AdoptionDefect("application release state directory must not be a symlink")
            if path.exists():
                try:
                    metadata = path.lstat()
                except OSError as exc:
                    raise AdoptionDefect(
                        "application release state directory is unreadable"
                    ) from exc
                if (
                    not stat.S_ISDIR(metadata.st_mode)
                    or metadata.st_uid != 0
                    or metadata.st_gid != 0
                    or stat.S_IMODE(metadata.st_mode) != 0o750
                ):
                    raise AdoptionDefect(
                        "application release state directory is not root-owned and immutable"
                    )
                if any(path.iterdir()):
                    raise AdoptionBlocked("application or Oracle release state already exists")
        for name in pointers:
            path = root / name
            if path.is_symlink() or path.exists():
                raise AdoptionBlocked("application or Oracle release state already exists")

    def _validate_state(self, value: object, source_sha: str) -> dict[str, Any]:
        state = _closed_mapping(value, _STATE_FIELDS, "infrastructure adoption attempt")
        if _integer(state, "schema_version") != 1 or _string(state, "source_sha") != source_sha:
            raise AdoptionDefect("adoption attempt identity is malformed")
        try:
            phase = AdoptionPhase(_string(state, "phase"))
        except ValueError as exc:
            raise AdoptionDefect("adoption attempt phase is unknown") from exc
        inputs = _closed_mapping(
            state.get("input_sha256"),
            frozenset({"compose", "caddy", "owner"}),
            "input hashes",
        )
        for key in inputs:
            _require_match("input SHA-256", _string(inputs, key), _SHA256)
        config_sha256 = _require_match("config SHA-256", _string(state, "config_sha256"), _SHA256)
        config_path = Path(_string(state, "config_path"))
        if (
            config_path.parent != self.paths.config_root
            or config_path.name != f"{config_sha256}.env"
        ):
            raise AdoptionDefect("captured config path is not canonical")
        _require_match("database name", _string(state, "database_name"), _DATABASE_IDENTIFIER)
        _require_match("database user", _string(state, "database_user"), _DATABASE_IDENTIFIER)
        refs = _closed_mapping(
            state.get("infra_image_references"),
            frozenset(_INFRA),
            "infrastructure references",
        )
        for service in refs:
            _require_match("infrastructure image", _string(refs, service), _IMAGE_REFERENCE)
        containers = _mapping(state.get("containers"), "captured containers")
        if set(containers) != set(_SERVICES):
            raise AdoptionDefect("adoption attempt must bind the exact five containers")
        for evidence in containers.values():
            item = _closed_mapping(evidence, _CONTAINER_FIELDS, "container evidence")
            _require_match("container id", _string(item, "container_id"), _CONTAINER_ID)
            _require_match("image id", _string(item, "image_id"), _IMAGE_ID)
            _require_match("config SHA-256", _string(item, "config_sha256"), _SHA256)
        mounts = _mapping(state.get("named_mounts"), "named mounts")
        if set(mounts) != set(_INFRA):
            raise AdoptionDefect("named mount evidence must cover both infra services")
        for service, entries in mounts.items():
            if not isinstance(entries, list):
                raise AdoptionDefect("named mount evidence must be an array")
            parsed = [_closed_mapping(entry, _MOUNT_FIELDS, "named mount") for entry in entries]
            if len(parsed) != len(_EXPECTED_VOLUME_TARGETS[service]) or parsed != sorted(
                parsed, key=lambda item: _string(item, "destination")
            ):
                raise AdoptionDefect("retained named mount evidence is not canonical")
            if {
                str(item["destination"]): str(item["name"]) for item in parsed
            } != _EXPECTED_VOLUME_TARGETS[service]:
                raise AdoptionDefect("retained named mount evidence is malformed")
        self._validate_optional_database(state.get("database"))
        self._validate_optional_backup(state.get("backup"))
        if state.get("backup") is not None:
            backup = _mapping(state["backup"], "backup evidence")
            if Path(_string(backup, "path")) != self.paths.backup_root / f"{source_sha}.dump":
                raise AdoptionDefect("backup path is not adoption-owned")
        replacements = state.get("replacement_containers")
        if replacements is not None:
            replacement_mapping = _closed_mapping(
                replacements, frozenset(_INFRA), "replacement containers"
            )
            for service, evidence in replacement_mapping.items():
                item = _closed_mapping(evidence, _CONTAINER_FIELDS, "replacement evidence")
                _require_match(
                    "replacement container id",
                    _string(item, "container_id"),
                    _CONTAINER_ID,
                )
                _require_match("replacement image id", _string(item, "image_id"), _IMAGE_ID)
                _require_match(
                    "replacement config SHA-256",
                    _string(item, "config_sha256"),
                    _SHA256,
                )
                captured = _closed_mapping(
                    containers[service],
                    _CONTAINER_FIELDS,
                    "captured container evidence",
                )
                if _string(item, "container_id") == _string(captured, "container_id"):
                    raise AdoptionDefect("replacement retained the captured container identity")
                if _string(item, "image_id") != _string(captured, "image_id"):
                    raise AdoptionDefect("replacement changed the captured image identity")
        phase_index = _PHASE_ORDER.index(phase)
        if (state.get("database") is None) != (
            phase_index < _PHASE_ORDER.index(AdoptionPhase.DatabaseCaptured)
        ):
            raise AdoptionDefect("database evidence disagrees with the durable adoption phase")
        if (state.get("backup") is None) != (
            phase_index < _PHASE_ORDER.index(AdoptionPhase.BackupVerified)
        ):
            raise AdoptionDefect("backup evidence disagrees with the durable adoption phase")
        if (replacements is None) != (
            phase_index < _PHASE_ORDER.index(AdoptionPhase.InfrastructureRecreated)
        ):
            raise AdoptionDefect("replacement evidence disagrees with the durable adoption phase")
        return state

    def _validate_optional_database(self, value: object) -> None:
        if value is None:
            return
        database = _closed_mapping(value, _DATABASE_FIELDS, "database evidence")
        if not _string(database, "identity"):
            raise AdoptionDefect("database identity must not be empty")
        _require_match("database revision", _string(database, "revision"), _REVISION)
        counts = _mapping(database.get("table_counts"), "database table counts")
        for table, count in counts.items():
            _require_match("database table", table, _DATABASE_IDENTIFIER)
            if not isinstance(count, int) or isinstance(count, bool) or count < 0:
                raise AdoptionDefect("database table count is malformed")

    def _validate_optional_backup(self, value: object) -> None:
        if value is None:
            return
        backup = _closed_mapping(value, _BACKUP_FIELDS, "backup evidence")
        path = Path(_string(backup, "path"))
        if not path.is_absolute():
            raise AdoptionDefect("backup path must be absolute")
        _require_match("backup SHA-256", _string(backup, "sha256"), _SHA256)
        if _integer(backup, "byte_count") <= 0:
            raise AdoptionDefect("backup byte count must be positive")

    def _load_state(self, source_sha: str) -> dict[str, Any] | None:
        path = self.paths.attempt(source_sha)
        if not path.exists() and not path.is_symlink():
            return None
        return self._validate_state(_read_json(path, "adoption attempt", mode=0o440), source_sha)

    def _write_state(self, state: Mapping[str, object], *, create: bool = False) -> None:
        validated = self._validate_state(dict(state), _string(state, "source_sha"))
        path = self.paths.attempt(_string(validated, "source_sha"))
        if create:
            _create_bytes(path, _canonical_bytes(validated))
        else:
            _atomic_bytes(path, _canonical_bytes(validated))

    def _advance(
        self,
        state: dict[str, Any],
        phase: AdoptionPhase,
        **updates: object,
    ) -> dict[str, Any]:
        current = AdoptionPhase(_string(state, "phase"))
        if _PHASE_ORDER.index(phase) != _PHASE_ORDER.index(current) + 1:
            raise AdoptionDefect(f"invalid adoption transition {current.value} -> {phase.value}")
        advanced = {**state, **updates, "phase": phase.value}
        self._write_state(advanced)
        return advanced

    def _prove_bound_container(self, service: str, evidence: Mapping[str, object]) -> None:
        expected_id = _string(evidence, "container_id")
        if self._one_service_id(service) != expected_id:
            raise AdoptionDefect(f"{service} container identity changed")
        if self._capture_container(service, expected_id) != dict(evidence):
            raise AdoptionDefect(f"{service} image or configuration changed")

    def _prove_config(self, state: Mapping[str, object]) -> None:
        expected_path = Path(_string(state, "config_path"))
        try:
            current_path = self.paths.current_config.resolve(strict=True)
        except OSError as exc:
            raise AdoptionDefect("captured production config is no longer published") from exc
        digest, _byte_count = _immutable_digest_and_size(
            current_path, "captured production config", 0o440
        )
        if current_path != expected_path or digest != _string(state, "config_sha256"):
            raise AdoptionDefect("published production config changed during adoption")

    def _prove_backup(self, state: Mapping[str, object]) -> None:
        backup = _closed_mapping(state.get("backup"), _BACKUP_FIELDS, "backup evidence")
        path = Path(_string(backup, "path"))
        digest, byte_count = _immutable_digest_and_size(
            path, "verified infrastructure backup", 0o400
        )
        if byte_count != _integer(backup, "byte_count") or digest != _string(backup, "sha256"):
            raise AdoptionDefect("verified infrastructure backup changed")
        self._prove_rehearsal_claim(_string(state, "source_sha"))

    def _prove_rehearsal_claim(self, source_sha: str) -> str:
        rehearsal = f"nexus_adopt_{source_sha}"
        claim = self.paths.rehearsal_claim(source_sha)
        value = _read_immutable_bytes(claim, "rehearsal database claim", 0o440)
        if value != f"{rehearsal}\n".encode():
            raise AdoptionDefect("rehearsal database claim changed")
        return rehearsal

    def _claim_rehearsal_database(
        self,
        state: Mapping[str, object],
        postgres_id: str,
        user: str,
    ) -> tuple[str, bool]:
        source_sha = _string(state, "source_sha")
        claim = self.paths.rehearsal_claim(source_sha)
        if claim.exists() or claim.is_symlink():
            return self._prove_rehearsal_claim(source_sha), True
        rehearsal = f"nexus_adopt_{source_sha}"
        exists = self._psql(
            postgres_id,
            "postgres",
            user,
            f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = '{rehearsal}');",
        )
        if exists == "t":
            raise AdoptionDefect("unowned rehearsal database already exists")
        if exists != "f":
            raise AdoptionDefect("rehearsal database existence proof is malformed")
        _create_bytes(claim, f"{rehearsal}\n".encode())
        return self._prove_rehearsal_claim(source_sha), False

    def _prove_installed_caddy(self, state: Mapping[str, object]) -> None:
        hashes = _mapping(state.get("input_sha256"), "input hashes")
        digest, _byte_count = _immutable_digest_and_size(
            self.paths.caddy_config, "installed Caddyfile", 0o444
        )
        if digest != _string(hashes, "caddy"):
            raise AdoptionDefect("installed Caddyfile changed")

    def _prove_caddy_bind(self, container_id: str) -> None:
        mounts = self._inspect(container_id).get("Mounts")
        if not isinstance(mounts, list):
            raise AdoptionDefect("caddy mounts are malformed")
        matches = [
            mount
            for raw in mounts
            for mount in [_mapping(raw, "caddy mount")]
            if mount.get("Destination") == "/etc/caddy/Caddyfile"
        ]
        if len(matches) != 1:
            raise AdoptionDefect("caddy must expose one exact Caddyfile bind")
        mount = matches[0]
        try:
            source = Path(_string(mount, "Source")).resolve(strict=True)
        except OSError as exc:
            raise AdoptionDefect("caddy Caddyfile bind source is missing") from exc
        if (
            mount.get("Type") != "bind"
            or mount.get("RW") is not False
            or source != self.paths.caddy_config.resolve(strict=True)
        ):
            raise AdoptionDefect("caddy Caddyfile bind is not the installed read-only file")

    def _psql(self, postgres_id: str, database: str, user: str, sql: str) -> str:
        completed = self._run(
            (
                "docker",
                "exec",
                postgres_id,
                "psql",
                "--no-psqlrc",
                "--set=ON_ERROR_STOP=1",
                "--username",
                user,
                "--dbname",
                database,
                "--tuples-only",
                "--no-align",
                "--command",
                sql,
            )
        )
        return completed.stdout.decode().strip()

    def _database_evidence(
        self, state: Mapping[str, object], *, database: str
    ) -> dict[str, object]:
        containers = _mapping(state.get("containers"), "captured containers")
        replacements = state.get("replacement_containers")
        postgres_id = (
            _string(_mapping(containers["postgres"], "postgres evidence"), "container_id")
            if replacements is None
            else _string(
                _mapping(
                    _mapping(replacements, "replacement containers")["postgres"],
                    "replacement postgres evidence",
                ),
                "container_id",
            )
        )
        user = _string(state, "database_user")
        identity = self._psql(
            postgres_id,
            database,
            user,
            "SELECT current_database() || ':' || system_identifier FROM pg_control_system();",
        )
        revision_lines = self._psql(
            postgres_id, database, user, "SELECT version_num FROM alembic_version;"
        ).splitlines()
        if len(revision_lines) != 1:
            raise AdoptionDefect("database must expose exactly one Alembic revision")
        revision = _require_match("database revision", revision_lines[0], _REVISION)
        table_lines = self._psql(
            postgres_id,
            database,
            user,
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;",
        ).splitlines()
        if len(table_lines) != len(set(table_lines)):
            raise AdoptionDefect("database table inventory contains duplicate names")
        counts: dict[str, int] = {}
        for table in table_lines:
            _require_match("database table", table, _DATABASE_IDENTIFIER)
            raw_count = self._psql(
                postgres_id,
                database,
                user,
                f'SELECT count(*) FROM "{table}";',
            )
            if not raw_count.isascii() or not raw_count.isdigit():
                raise AdoptionDefect("database table count is malformed")
            counts[table] = int(raw_count)
        evidence = {"identity": identity, "revision": revision, "table_counts": counts}
        self._validate_optional_database(evidence)
        return evidence

    def _create_and_rehearse_backup(
        self, state: Mapping[str, object], database: Mapping[str, object]
    ) -> dict[str, object]:
        source_sha = _string(state, "source_sha")
        containers = _mapping(state.get("containers"), "captured containers")
        postgres_id = _string(_mapping(containers["postgres"], "postgres evidence"), "container_id")
        user = _string(state, "database_user")
        database_name = _string(state, "database_name")
        self.paths.backup_root.mkdir(parents=True, exist_ok=True, mode=0o750)
        backup_path = self.paths.backup_root / f"{source_sha}.dump"
        if not backup_path.exists() and not backup_path.is_symlink():
            temporary = self.paths.backup_root / f".{source_sha}.partial"
            with contextlib.suppress(FileNotFoundError):
                temporary.unlink()
            descriptor = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o400,
            )
            try:
                os.fchown(descriptor, 0, 0)
                os.fchmod(descriptor, 0o400)
                with os.fdopen(descriptor, "wb") as stream:
                    self._run(
                        (
                            "docker",
                            "exec",
                            postgres_id,
                            "pg_dump",
                            "--format=custom",
                            "--no-owner",
                            "--no-privileges",
                            "--username",
                            user,
                            "--dbname",
                            database_name,
                        ),
                        stdout=stream,
                        timeout_seconds=_DATABASE_DUMP_TIMEOUT_SECONDS,
                    )
                    stream.flush()
                    os.fsync(stream.fileno())
                if temporary.stat().st_size <= 0:
                    raise AdoptionDefect("custom-format database backup is empty")
                os.replace(temporary, backup_path)
                _fsync_directory(backup_path.parent)
            finally:
                with contextlib.suppress(FileNotFoundError):
                    temporary.unlink()
        backup_sha256, backup_size = _immutable_digest_and_size(
            backup_path, "infrastructure backup", 0o400
        )
        if backup_size <= 0:
            raise AdoptionDefect("custom-format database backup is empty")
        with _open_immutable_file(backup_path, "infrastructure backup", 0o400) as backup_stream:
            self._run(
                (
                    "docker",
                    "exec",
                    "--interactive",
                    postgres_id,
                    "pg_restore",
                    "--list",
                ),
                stdin=backup_stream,
                stdout=subprocess.DEVNULL,
                timeout_seconds=_DATABASE_ARCHIVE_LIST_TIMEOUT_SECONDS,
            )
        rehearsal, replaying_rehearsal = self._claim_rehearsal_database(
            state,
            postgres_id,
            user,
        )
        if rehearsal == database_name:
            raise AdoptionDefect("rehearsal database collides with production")
        quoted = f'"{rehearsal}"'
        if replaying_rehearsal:
            self._psql(
                postgres_id,
                "postgres",
                user,
                f"DROP DATABASE IF EXISTS {quoted} WITH (FORCE);",
            )
        self._psql(
            postgres_id,
            "postgres",
            user,
            f"CREATE DATABASE {quoted};",
        )
        rehearsal_succeeded = False
        try:
            with _open_immutable_file(backup_path, "infrastructure backup", 0o400) as backup_stream:
                self._run(
                    (
                        "docker",
                        "exec",
                        "--interactive",
                        postgres_id,
                        "pg_restore",
                        "--exit-on-error",
                        "--no-owner",
                        "--no-privileges",
                        "--username",
                        user,
                        "--dbname",
                        rehearsal,
                    ),
                    stdin=backup_stream,
                    timeout_seconds=_DATABASE_RESTORE_TIMEOUT_SECONDS,
                )
            restored = self._database_evidence(state, database=rehearsal)
            if (
                restored["revision"] != database["revision"]
                or restored["table_counts"] != database["table_counts"]
            ):
                raise AdoptionDefect("restored backup differs from production revision or counts")
            rehearsal_succeeded = True
        finally:
            if rehearsal_succeeded:
                self._psql(
                    postgres_id,
                    "postgres",
                    user,
                    f"DROP DATABASE {quoted} WITH (FORCE);",
                )
        backup = {
            "path": str(backup_path),
            "sha256": backup_sha256,
            "byte_count": backup_size,
        }
        self._validate_optional_backup(backup)
        return backup

    def _prove_database(self, state: Mapping[str, object]) -> None:
        expected = state.get("database")
        if expected is None:
            raise AdoptionDefect("database proof requires captured database evidence")
        observed = self._database_evidence(state, database=_string(state, "database_name"))
        if observed != expected:
            raise AdoptionDefect("production database identity, revision, or counts changed")

    def _prove_retained_inputs(self, state: Mapping[str, object]) -> None:
        hashes = _mapping(state.get("input_sha256"), "input hashes")
        inputs = self.paths.inputs(_string(state, "source_sha"))
        for name, key in (
            ("docker-compose.yml", "compose"),
            ("Caddyfile", "caddy"),
            ("adopt-infrastructure.py", "owner"),
        ):
            digest, _byte_count = _immutable_digest_and_size(
                inputs / name, f"retained {name}", 0o444
            )
            if digest != _string(hashes, key):
                raise AdoptionDefect(f"retained {name} changed")

    def _prove_durable_files(self, state: Mapping[str, object]) -> None:
        self._prove_retained_inputs(state)
        self._prove_config(state)
        if state.get("backup") is not None:
            self._prove_backup(state)
        phase = AdoptionPhase(_string(state, "phase"))
        if _PHASE_ORDER.index(phase) >= _PHASE_ORDER.index(AdoptionPhase.FilesInstalled):
            self._prove_installed_caddy(state)

    def _install_files(self, state: Mapping[str, object]) -> None:
        source_sha = _string(state, "source_sha")
        hashes = _mapping(state.get("input_sha256"), "input hashes")
        inputs = self.paths.inputs(source_sha)
        compose_path = inputs / "docker-compose.yml"
        caddy_path = inputs / "Caddyfile"
        compose_digest, _byte_count = _immutable_digest_and_size(
            compose_path, "retained docker-compose.yml", 0o444
        )
        caddy = _read_immutable_bytes(caddy_path, "retained Caddyfile", 0o444)
        if compose_digest != hashes["compose"] or _digest_bytes(caddy) != hashes["caddy"]:
            raise AdoptionDefect("retained adoption input changed")
        _atomic_bytes(self.paths.caddy_config, caddy, mode=0o444)
        self._prove_installed_caddy(state)

    def _stop_writers(self, state: Mapping[str, object]) -> None:
        containers = _mapping(state.get("containers"), "captured containers")
        ids = tuple(_string(_mapping(containers[name], name), "container_id") for name in _WRITERS)
        self._run(("docker", "stop", "--time", "30", *ids))
        for service, container_id in zip(_WRITERS, ids, strict=True):
            self._prove_bound_container(service, _mapping(containers[service], service))
            running, _health = self._container_state(container_id)
            if running:
                raise AdoptionDefect(f"writer {service} did not stop")

    def _start_writers(self, state: Mapping[str, object], *, require_health: bool) -> None:
        containers = _mapping(state.get("containers"), "captured containers")
        ids = tuple(_string(_mapping(containers[name], name), "container_id") for name in _WRITERS)
        self._run(("docker", "start", *ids))
        if require_health:
            self._wait_healthy(dict(zip(_WRITERS, ids, strict=True)))
        for service in _WRITERS:
            self._prove_bound_container(service, _mapping(containers[service], service))

    def _wait_healthy(self, container_ids: Mapping[str, str]) -> None:
        # justify-polling: Docker exposes the required exact-container health
        # state only through inspection in this one-shot host protocol.
        for attempt in range(_HEALTH_ATTEMPTS):
            ready = True
            for service, container_id in container_ids.items():
                running, health = self._container_state(container_id)
                if (
                    not running
                    or health not in {None, "healthy"}
                    or (health is None and service != "caddy")
                ):
                    ready = False
                    break
            if ready:
                return
            if attempt + 1 < _HEALTH_ATTEMPTS:
                time.sleep(_HEALTH_INTERVAL_SECONDS)
        raise AdoptionDefect("exact adopted containers did not become healthy within 90 seconds")

    def _replacement_ids(self, state: Mapping[str, object]) -> dict[str, str]:
        captured = _mapping(state.get("containers"), "captured containers")
        replacements: dict[str, str] = {}
        for service in _INFRA:
            ids = self._service_ids(service)
            if len(ids) > 1:
                raise AdoptionDefect(f"service {service} has multiple containers during replay")
            if not ids:
                continue
            current = ids[0]
            if current != _string(_mapping(captured[service], service), "container_id"):
                replacements[service] = current
        return replacements

    def _recreate_infrastructure(self, state: Mapping[str, object]) -> dict[str, dict[str, str]]:
        captured = _mapping(state.get("containers"), "captured containers")
        already_replaced = self._replacement_ids(state)
        mounts = _mapping(state.get("named_mounts"), "named mounts")
        for service, replacement_id in already_replaced.items():
            evidence = self._capture_container(service, replacement_id)
            if evidence["image_id"] != _string(_mapping(captured[service], service), "image_id"):
                raise AdoptionDefect(f"partially recreated {service} changed image identity")
            if self._capture_named_mounts(service, replacement_id) != mounts[service]:
                raise AdoptionDefect(f"partially recreated {service} changed named-volume identity")
            if service == "caddy":
                self._prove_caddy_bind(replacement_id)
        pending = tuple(service for service in _INFRA if service not in already_replaced)
        if pending:
            self._compose(
                state,
                self.paths.inputs(_string(state, "source_sha")) / "docker-compose.yml",
                (
                    "up",
                    "--detach",
                    "--no-deps",
                    "--force-recreate",
                    "--wait",
                    "--wait-timeout",
                    "90",
                    *pending,
                ),
            )
        replacements = self._replacement_ids(state)
        if set(replacements) != set(_INFRA):
            raise AdoptionDefect("infrastructure recreation did not replace both exact containers")
        evidence_by_service: dict[str, dict[str, str]] = {}
        for service, replacement_id in replacements.items():
            evidence = self._capture_container(service, replacement_id)
            if evidence["image_id"] != _string(_mapping(captured[service], service), "image_id"):
                raise AdoptionDefect(f"recreated {service} changed image identity")
            if (
                self._capture_named_mounts(service, replacement_id)
                != _mapping(state.get("named_mounts"), "named mounts")[service]
            ):
                raise AdoptionDefect(f"recreated {service} changed named-volume identity")
            evidence_by_service[service] = evidence
        self._prove_caddy_bind(replacements["caddy"])
        for service in _WRITERS:
            evidence = _mapping(captured[service], service)
            self._prove_bound_container(service, evidence)
            if self._container_state(_string(evidence, "container_id"))[0]:
                raise AdoptionDefect("application writer restarted before infrastructure proof")
        return evidence_by_service

    def _prove_recreated(self, state: Mapping[str, object]) -> None:
        replacements = _closed_mapping(
            state.get("replacement_containers"),
            frozenset(_INFRA),
            "replacement containers",
        )
        mounts = _mapping(state.get("named_mounts"), "named mounts")
        for service in _INFRA:
            evidence = _mapping(replacements[service], f"replacement {service} evidence")
            self._prove_bound_container(service, evidence)
            replacement_id = _string(evidence, "container_id")
            if self._capture_named_mounts(service, replacement_id) != mounts[service]:
                raise AdoptionDefect(f"recreated {service} named volumes changed")
        self._prove_caddy_bind(
            _string(
                _mapping(replacements["caddy"], "replacement caddy evidence"),
                "container_id",
            )
        )
        captured = _mapping(state.get("containers"), "captured containers")
        for service in _WRITERS:
            self._prove_bound_container(service, _mapping(captured[service], service))
        self._prove_database(state)

    def _prove_final(self, state: Mapping[str, object]) -> None:
        self._prove_recreated(state)
        self._prove_config(state)
        self._prove_backup(state)
        self._prove_installed_caddy(state)
        replacements = _closed_mapping(
            state.get("replacement_containers"),
            frozenset(_INFRA),
            "replacement containers",
        )
        containers = _mapping(state.get("containers"), "captured containers")
        ids = {
            **{
                service: _string(
                    _mapping(replacements[service], f"replacement {service} evidence"),
                    "container_id",
                )
                for service in _INFRA
            },
            **{
                service: _string(_mapping(containers[service], service), "container_id")
                for service in _WRITERS
            },
        }
        self._wait_healthy(ids)

    def _restore_pre_mutation_writers(self, state: Mapping[str, object]) -> None:
        self._start_writers(state, require_health=True)

    def _drive(self, state: dict[str, Any]) -> dict[str, Any]:
        source_sha = _string(state, "source_sha")
        compose_path = self.paths.inputs(source_sha) / "docker-compose.yml"
        phase = AdoptionPhase(_string(state, "phase"))
        just_recreated = False
        just_restored = False
        hashes = _mapping(state.get("input_sha256"), "input hashes")
        compose_digest, _byte_count = _immutable_digest_and_size(
            compose_path, "retained docker-compose.yml", 0o444
        )
        if compose_digest != _string(hashes, "compose"):
            raise AdoptionDefect("retained Compose input changed")
        self._prove_config(state)
        if _PHASE_ORDER.index(phase) < _PHASE_ORDER.index(
            AdoptionPhase.InfrastructureMutationStarted
        ):
            for service in _SERVICES:
                self._prove_bound_container(
                    service,
                    _mapping(_mapping(state["containers"], "containers")[service], service),
                )
            self._prove_planned_topology(state, compose_path)
            if phase is not AdoptionPhase.Prepared:
                self._stop_writers(state)

        if phase is AdoptionPhase.Prepared:
            self._stop_writers(state)
            state = self._advance(state, AdoptionPhase.WritersStopped)
            phase = AdoptionPhase.WritersStopped
        if phase is AdoptionPhase.WritersStopped:
            database = self._database_evidence(state, database=_string(state, "database_name"))
            state = self._advance(state, AdoptionPhase.DatabaseCaptured, database=database)
            phase = AdoptionPhase.DatabaseCaptured
        if phase is AdoptionPhase.DatabaseCaptured:
            self._prove_database(state)
            backup = self._create_and_rehearse_backup(
                state, _mapping(state.get("database"), "database evidence")
            )
            state = self._advance(state, AdoptionPhase.BackupVerified, backup=backup)
            phase = AdoptionPhase.BackupVerified
        if phase is AdoptionPhase.BackupVerified:
            self._prove_database(state)
            self._prove_backup(state)
            self._install_files(state)
            state = self._advance(state, AdoptionPhase.FilesInstalled)
            phase = AdoptionPhase.FilesInstalled
        if phase is AdoptionPhase.FilesInstalled:
            self._install_files(state)
            self._prove_backup(state)
            state = self._advance(state, AdoptionPhase.InfrastructureMutationStarted)
            phase = AdoptionPhase.InfrastructureMutationStarted
        if phase is AdoptionPhase.InfrastructureMutationStarted:
            self._stop_writers(state)
            replacements = self._recreate_infrastructure(state)
            state = self._advance(
                state,
                AdoptionPhase.InfrastructureRecreated,
                replacement_containers=replacements,
            )
            phase = AdoptionPhase.InfrastructureRecreated
            just_recreated = True
        if phase is AdoptionPhase.InfrastructureRecreated:
            if not just_recreated:
                self._stop_writers(state)
            self._prove_recreated(state)
            self._prove_backup(state)
            self._prove_installed_caddy(state)
            self._start_writers(state, require_health=False)
            replacements = _mapping(state.get("replacement_containers"), "replacement containers")
            containers = _mapping(state.get("containers"), "captured containers")
            self._wait_healthy(
                {
                    **{
                        service: _string(
                            _mapping(replacements[service], f"replacement {service} evidence"),
                            "container_id",
                        )
                        for service in _INFRA
                    },
                    **{
                        service: _string(_mapping(containers[service], service), "container_id")
                        for service in _WRITERS
                    },
                }
            )
            state = self._advance(state, AdoptionPhase.WritersRestored)
            phase = AdoptionPhase.WritersRestored
            just_restored = True
        if phase is AdoptionPhase.WritersRestored:
            if not just_restored:
                self._start_writers(state, require_health=False)
                self._prove_final(state)
            state = self._advance(state, AdoptionPhase.Succeeded)
            return state
        if phase is AdoptionPhase.Succeeded:
            self._start_writers(state, require_health=False)
            self._prove_final(state)
            return state
        if AdoptionPhase(_string(state, "phase")) is not AdoptionPhase.Succeeded:
            raise AdoptionDefect("adoption did not reach its terminal phase")
        raise AdoptionDefect("adoption terminal control flow is incomplete")

    def adopt(
        self,
        *,
        source_sha: str,
        compose_source: Path,
        compose_sha256: str,
        caddy_source: Path,
        caddy_sha256: str,
        owner_source: Path,
        owner_sha256: str,
    ) -> dict[str, object]:
        _require_match("source SHA", source_sha, _SHA)
        expected_hashes = {
            "compose": _require_match("Compose SHA-256", compose_sha256, _SHA256),
            "caddy": _require_match("Caddy SHA-256", caddy_sha256, _SHA256),
            "owner": _require_match("owner SHA-256", owner_sha256, _SHA256),
        }
        staged: dict[str, bytes] = {}
        for label, path, digest in (
            ("Compose", compose_source, compose_sha256),
            ("Caddy", caddy_source, caddy_sha256),
            ("owner", owner_source, owner_sha256),
        ):
            value = _read_regular_bytes(path, label)
            if _digest_bytes(value) != digest:
                raise AdoptionDefect(f"staged {label} input differs from the exact source bytes")
            staged[label] = value
        self._require_no_release_state()
        existing_attempts = (
            tuple(
                path.name
                for path in self.paths.state_root.iterdir()
                if path.is_dir() and _SHA.fullmatch(path.name)
            )
            if self.paths.state_root.exists()
            else ()
        )
        if existing_attempts and existing_attempts != (source_sha,):
            raise AdoptionBlocked("a different infrastructure adoption attempt already exists")
        state = self._load_state(source_sha)
        if (
            state is not None
            and _mapping(state.get("input_sha256"), "input hashes") != expected_hashes
        ):
            raise AdoptionDefect("replay input differs from the durable adoption binding")
        if state is not None:
            self._prove_durable_files(state)
        if self.paths.completion.exists() or self.paths.completion.is_symlink():
            completion = _closed_mapping(
                _read_json(self.paths.completion, "adoption completion", mode=0o440),
                _COMPLETION_FIELDS,
                "adoption completion",
            )
            if (
                _integer(completion, "schema_version") != 1
                or _string(completion, "source_sha") != source_sha
            ):
                raise AdoptionBlocked("production infrastructure was already adopted")
            _require_match(
                "completion attempt SHA-256",
                _string(completion, "attempt_sha256"),
                _SHA256,
            )
            _require_match(
                "completion backup SHA-256",
                _string(completion, "backup_sha256"),
                _SHA256,
            )
            if (
                state is None
                or AdoptionPhase(_string(state, "phase")) is not AdoptionPhase.Succeeded
            ):
                raise AdoptionDefect("completion evidence has no matching succeeded attempt")
            if _digest_bytes(_canonical_bytes(state)) != _string(completion, "attempt_sha256"):
                raise AdoptionDefect("completion evidence differs from the terminal attempt")
            backup = _closed_mapping(state.get("backup"), _BACKUP_FIELDS, "backup evidence")
            if _string(completion, "backup_sha256") != _string(backup, "sha256"):
                raise AdoptionDefect("completion backup digest differs from terminal evidence")
            self._drive(state)
            return completion
        inputs = self.paths.inputs(source_sha)
        for destination, source, digest in (
            (inputs / "docker-compose.yml", staged["Compose"], compose_sha256),
            (inputs / "Caddyfile", staged["Caddy"], caddy_sha256),
            (inputs / "adopt-infrastructure.py", staged["owner"], owner_sha256),
        ):
            _create_bytes(destination, source, mode=0o444)
            retained_digest, _byte_count = _immutable_digest_and_size(
                destination, f"retained {destination.name}", 0o444
            )
            if retained_digest != digest:
                raise AdoptionDefect("retained adoption input differs from its staged hash")
        if state is None:
            config_path, config_digest, config = self._capture_config()
            containers = {
                service: self._capture_container(service, self._one_service_id(service))
                for service in _SERVICES
            }
            for service in _SERVICES:
                running, health = self._container_state(containers[service]["container_id"])
                if (
                    not running
                    or health not in {None, "healthy"}
                    or (health is None and service != "caddy")
                ):
                    raise AdoptionDefect(f"live {service} is not healthy and running")
            mounts = {
                service: self._capture_named_mounts(service, containers[service]["container_id"])
                for service in _INFRA
            }
            refs = {
                "postgres": config["POSTGRES_IMAGE"],
                "caddy": config["CADDY_IMAGE"],
            }
            for service in _INFRA:
                self._prove_pulled_image(refs[service], containers[service]["image_id"])
            state = {
                "schema_version": 1,
                "source_sha": source_sha,
                "phase": AdoptionPhase.Prepared.value,
                "input_sha256": expected_hashes,
                "config_path": str(config_path),
                "config_sha256": config_digest,
                "database_name": config["POSTGRES_DB"],
                "database_user": config["POSTGRES_USER"],
                "infra_image_references": refs,
                "containers": containers,
                "named_mounts": mounts,
                "database": None,
                "backup": None,
                "replacement_containers": None,
            }
            self._prove_planned_topology(state, inputs / "docker-compose.yml")
            self._write_state(state, create=True)
        try:
            terminal = self._drive(state)
        except BaseException:
            latest = self._load_state(source_sha)
            if latest is not None:
                latest_phase = AdoptionPhase(_string(latest, "phase"))
                if _PHASE_ORDER.index(latest_phase) < _PHASE_ORDER.index(
                    AdoptionPhase.InfrastructureMutationStarted
                ):
                    try:
                        self._restore_pre_mutation_writers(latest)
                    except BaseException as restore_error:
                        raise AdoptionDefect(
                            "pre-mutation adoption failed and exact writer restoration also failed"
                        ) from restore_error
                else:
                    try:
                        self._stop_writers(latest)
                    except BaseException as stop_error:
                        raise AdoptionDefect(
                            "post-mutation adoption failed and exact writer containment also failed"
                        ) from stop_error
            raise
        backup = _closed_mapping(terminal.get("backup"), _BACKUP_FIELDS, "backup evidence")
        completion = {
            "schema_version": 1,
            "source_sha": source_sha,
            "attempt_sha256": _digest_bytes(_canonical_bytes(terminal)),
            "backup_sha256": _string(backup, "sha256"),
        }
        try:
            _create_bytes(self.paths.completion, _canonical_bytes(completion), mode=0o440)
        except BaseException:
            self._stop_writers(terminal)
            raise
        return completion


def _prove_local_checkout(root: Path, source_sha: str) -> None:
    subprocess.run(
        ("git", "-C", str(root), "fetch", "--quiet", "origin", "main"),
        check=True,
        timeout=120,
    )
    status = subprocess.run(
        ("git", "-C", str(root), "status", "--porcelain", "--untracked-files=all"),
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if status.stdout:
        raise AdoptionBlocked("infrastructure adoption requires a clean checkout")
    head = subprocess.run(
        ("git", "-C", str(root), "rev-parse", "HEAD"),
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    ).stdout.strip()
    origin_main = subprocess.run(
        ("git", "-C", str(root), "rev-parse", "origin/main"),
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    ).stdout.strip()
    if head != source_sha or origin_main != source_sha:
        raise AdoptionBlocked("source SHA must equal clean HEAD and origin/main")


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON key: {key}")
        value[key] = item
    return value


def _local_json(path: Path, label: str) -> dict[str, Any]:
    try:
        return _mapping(
            json.loads(path.read_bytes(), object_pairs_hook=_unique_json_object),
            label,
        )
    except (OSError, ValueError) as exc:
        raise AdoptionDefect(f"{label} is not valid JSON") from exc


def _bounded_https_get(
    url: str,
    output: Path,
    *,
    api_config: Path | None = None,
    headers: Path | None = None,
    max_bytes: int = 1024 * 1024,
) -> int:
    command = [
        "curl",
        "--silent",
        "--show-error",
        "--max-time",
        "15",
        "--max-filesize",
        str(max_bytes),
        "--proto",
        "=https",
        "--tlsv1.2",
    ]
    if api_config is not None:
        command.extend(("--config", str(api_config)))
    if headers is not None:
        command.extend(("--dump-header", str(headers)))
    command.extend(("--output", str(output), "--write-out", "%{http_code}", url))
    for attempt in range(2):
        output.unlink(missing_ok=True)
        if headers is not None:
            headers.unlink(missing_ok=True)
        try:
            completed = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=20,
            )
        except (OSError, subprocess.TimeoutExpired):
            completed = None
        if completed is None or completed.returncode != 0:
            if attempt == 0:
                continue
            raise AdoptionDefect("Vercel admission request failed transiently")
        raw_status = completed.stdout.strip()
        if len(raw_status) != 3 or not raw_status.isascii() or not raw_status.isdigit():
            raise AdoptionDefect("Vercel admission returned a malformed HTTP status")
        status = int(raw_status)
        if (status in {408, 429} or 500 <= status <= 599) and attempt == 0:
            continue
        return status
    raise AdoptionDefect("Vercel admission exhausted its bounded reads")


def _require_no_store_headers(path: Path) -> None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as exc:
        raise AdoptionDefect("staged frontend headers are unreadable") from exc
    cache_control: list[str] = []
    forbidden: list[str] = []
    for line in lines:
        name, separator, value = line.rstrip("\r").partition(":")
        if not separator:
            continue
        normalized = name.strip().lower()
        if normalized == "cache-control":
            cache_control.append(value.strip())
        if normalized in {"location", "set-cookie"}:
            forbidden.append(normalized)
    if cache_control != ["no-store"] or forbidden:
        raise AdoptionDefect(
            "staged frontend version must be public, unredirected, and exactly no-store"
        )


def _prove_vercel_candidate(source_sha: str, staging: Path) -> None:
    token = os.environ.get("VERCEL_TOKEN", "")
    _require_match("Vercel token", token, _VERCEL_TOKEN)
    api_config = staging / "vercel-api.conf"
    descriptor = os.open(
        api_config,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
    )
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(f'header = "Authorization: Bearer {token}"\n')
        stream.flush()
        os.fsync(stream.fileno())

    project_path = staging / "vercel-project.json"
    project_status = _bounded_https_get(
        f"https://api.vercel.com/v9/projects/{_VERCEL_PROJECT_ID}?teamId={_VERCEL_TEAM_ID}",
        project_path,
        api_config=api_config,
    )
    if project_status != 200:
        raise AdoptionDefect("committed Vercel project inspection did not return HTTP 200")
    project = _local_json(project_path, "Vercel project")
    if not (
        project.get("id") == _VERCEL_PROJECT_ID
        and project.get("name") == _VERCEL_PROJECT_NAME
        and project.get("accountId") == _VERCEL_TEAM_ID
        and project.get("autoAssignCustomDomains") is False
        and project.get("autoExposeSystemEnvs") is True
        and project.get("ssoProtection") == {"deploymentType": "preview"}
    ):
        raise AdoptionDefect("committed Vercel project/team or build policy disagrees")

    deployments_path = staging / "vercel-deployments.json"
    deployments_status = _bounded_https_get(
        "https://api.vercel.com/v6/deployments"
        f"?projectId={_VERCEL_PROJECT_ID}&teamId={_VERCEL_TEAM_ID}"
        f"&target=production&limit=100&meta-githubCommitSha={source_sha}",
        deployments_path,
        api_config=api_config,
    )
    if deployments_status != 200:
        raise AdoptionDefect("Vercel candidate listing did not return HTTP 200")
    listing = _local_json(deployments_path, "Vercel deployment listing")
    deployments = listing.get("deployments")
    pagination = listing.get("pagination")
    if (
        not isinstance(deployments, list)
        or not isinstance(pagination, dict)
        or "next" not in pagination
        or pagination["next"] is not None
    ):
        raise AdoptionDefect("Vercel candidate listing is incomplete or malformed")
    matches: list[dict[str, Any]] = []
    for raw in deployments:
        deployment = _mapping(raw, "Vercel deployment")
        meta = deployment.get("meta")
        if (
            deployment.get("readyState") == "READY"
            and deployment.get("name") == _VERCEL_PROJECT_NAME
            and deployment.get("projectId") == _VERCEL_PROJECT_ID
            and deployment.get("target") == "production"
            and isinstance(meta, dict)
            and meta.get("githubCommitSha") == source_sha
            and isinstance(deployment.get("uid"), str)
            and _VERCEL_DEPLOYMENT_ID.fullmatch(deployment["uid"]) is not None
            and isinstance(deployment.get("url"), str)
            and _VERCEL_DEPLOYMENT_URL.fullmatch(deployment["url"]) is not None
        ):
            matches.append(deployment)
    if len(matches) != 1:
        raise AdoptionDefect("exactly one READY production Vercel candidate must exist")
    candidate = matches[0]
    deployment_id = _string(candidate, "uid")
    deployment_url = _string(candidate, "url")

    detail_path = staging / "vercel-deployment.json"
    detail_status = _bounded_https_get(
        f"https://api.vercel.com/v13/deployments/{deployment_id}?teamId={_VERCEL_TEAM_ID}",
        detail_path,
        api_config=api_config,
    )
    if detail_status != 200:
        raise AdoptionDefect("exact Vercel candidate inspection did not return HTTP 200")
    detail = _local_json(detail_path, "Vercel deployment detail")
    detail_meta = detail.get("meta")
    targets = project.get("targets")
    production_target = targets.get("production", {}) if isinstance(targets, Mapping) else {}
    production_aliases = (
        production_target.get("alias", []) if isinstance(production_target, Mapping) else []
    )
    automatic_aliases = (
        production_target.get("automaticAliases", [])
        if isinstance(production_target, Mapping)
        else []
    )
    aliases = detail.get("alias")
    staged_aliases = (
        isinstance(aliases, list)
        and isinstance(production_aliases, list)
        and isinstance(automatic_aliases, list)
        and all(
            isinstance(alias, str)
            and _VERCEL_ALIAS.fullmatch(alias) is not None
            and (alias not in production_aliases or alias in automatic_aliases)
            for alias in aliases
        )
    )
    if not (
        detail.get("id") == deployment_id
        and detail.get("name") == _VERCEL_PROJECT_NAME
        and detail.get("projectId") == _VERCEL_PROJECT_ID
        and detail.get("ownerId") == _VERCEL_TEAM_ID
        and detail.get("url") == deployment_url
        and detail.get("target") == "production"
        and detail.get("readyState") == "READY"
        and isinstance(detail_meta, dict)
        and detail_meta.get("githubCommitSha") == source_sha
        and _PRODUCTION_HOST not in (aliases or [])
        and staged_aliases
    ):
        raise AdoptionDefect("exact Vercel candidate is not READY, staged, and production-bound")

    version_path = staging / "vercel-version.json"
    headers_path = staging / "vercel-version.headers"
    version_status = _bounded_https_get(
        f"https://{deployment_url}/version",
        version_path,
        headers=headers_path,
        max_bytes=65536,
    )
    if version_status != 200:
        raise AdoptionDefect("staged frontend version did not return HTTP 200")
    version = _closed_mapping(
        _local_json(version_path, "staged frontend version"),
        frozenset({"source_sha"}),
        "staged frontend version",
    )
    if _string(version, "source_sha") != source_sha:
        raise AdoptionDefect("staged frontend version differs from the exact source SHA")
    _require_no_store_headers(headers_path)


def _prove_anonymous_candidate_images(
    source_sha: str,
    bundle: Path,
    staging: Path,
) -> None:
    manifest = _local_json(bundle / "candidate-manifest.json", "candidate manifest")
    if manifest.get("source_sha") != source_sha:
        raise AdoptionDefect("candidate manifest differs from the exact source SHA")
    images = _closed_mapping(
        manifest.get("images"), frozenset({"api", "worker"}), "candidate images"
    )
    anonymous_config = staging / "anonymous-docker"
    anonymous_config.mkdir(mode=0o700)
    environment = os.environ.copy()
    environment["DOCKER_CONFIG"] = str(anonymous_config)
    for credential in ("DOCKER_AUTH_CONFIG", "REGISTRY_AUTH_FILE"):
        environment.pop(credential, None)
    for name in ("api", "worker"):
        reference = _require_match(
            f"candidate {name} image", _string(images, name), _IMAGE_REFERENCE
        )
        try:
            subprocess.run(
                ("docker", "buildx", "imagetools", "inspect", reference),
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                env=environment,
                timeout=60,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise AdoptionDefect(
                f"candidate {name} image is not anonymously fetchable by digest"
            ) from exc


def _prove_local_release_admission(root: Path, source_sha: str, staging: Path) -> None:
    resolver = root / "deploy/hetzner/fetch-release-bundle.sh"
    if not resolver.is_file() or not os.access(resolver, os.X_OK):
        raise AdoptionDefect("committed release-bundle resolver is not executable")
    bundle = staging / "release-bundle"
    bundle.mkdir(mode=0o700)
    subprocess.run(
        (str(resolver), source_sha, str(bundle)),
        check=True,
        stdout=subprocess.DEVNULL,
        timeout=600,
    )
    _prove_anonymous_candidate_images(source_sha, bundle, staging)
    _prove_vercel_candidate(source_sha, staging)


def _run_local(source_sha: str) -> int:
    _require_match("source SHA", source_sha, _SHA)
    root = Path(__file__).resolve().parents[2]
    for command in ("curl", "docker", "git", "scp", "ssh"):
        if shutil.which(command) is None:
            raise AdoptionDefect(f"{command} is not installed locally")
    _prove_local_checkout(root, source_sha)
    tracked = {
        "docker-compose.yml": "deploy/hetzner/docker-compose.yml",
        "Caddyfile": "deploy/hetzner/Caddyfile",
        "adopt-infrastructure.py": "deploy/hetzner/adopt-infrastructure.py",
    }
    blobs = {
        name: subprocess.run(
            ("git", "-C", str(root), "show", f"{source_sha}:{relative}"),
            check=True,
            capture_output=True,
            timeout=30,
        ).stdout
        for name, relative in tracked.items()
    }
    for name, relative in tracked.items():
        if (root / relative).read_bytes() != blobs[name]:
            raise AdoptionBlocked("working adoption input differs from the exact source commit")
    with tempfile.TemporaryDirectory(prefix="nexus-infra-adoption-") as raw_staging:
        staging = Path(raw_staging)
        sources: dict[str, Path] = {}
        for name, value in blobs.items():
            source = staging / name
            source.write_bytes(value)
            sources[name] = source
        _prove_local_release_admission(root, source_sha, staging)
        remote = subprocess.run(
            (
                "ssh",
                *_SSH_OPTIONS,
                _SSH_TARGET,
                "mktemp",
                "-d",
                "/tmp/nexus-infra-adoption.XXXXXXXX",
            ),
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout.strip()
        if re.fullmatch(r"/tmp/nexus-infra-adoption\.[A-Za-z0-9]{8}", remote) is None:
            raise AdoptionDefect("host returned an invalid staging path")
        try:
            for name, source in sources.items():
                subprocess.run(
                    (
                        "scp",
                        *_SSH_OPTIONS,
                        str(source),
                        f"{_SSH_TARGET}:{remote}/{name}",
                    ),
                    check=True,
                    timeout=120,
                )
            _prove_local_checkout(root, source_sha)
            command = (
                "ssh",
                *_SSH_OPTIONS,
                _SSH_TARGET,
                "sudo",
                "env",
                "PYTHONDONTWRITEBYTECODE=1",
                "python3",
                "-B",
                f"{remote}/adopt-infrastructure.py",
                "host",
                "--source-sha",
                source_sha,
                "--compose",
                f"{remote}/docker-compose.yml",
                "--compose-sha256",
                _file_digest(sources["docker-compose.yml"]),
                "--caddy",
                f"{remote}/Caddyfile",
                "--caddy-sha256",
                _file_digest(sources["Caddyfile"]),
                "--owner",
                f"{remote}/adopt-infrastructure.py",
                "--owner-sha256",
                _file_digest(sources["adopt-infrastructure.py"]),
            )
            completed = subprocess.run(command, check=True, timeout=900)
            return completed.returncode
        finally:
            with contextlib.suppress(OSError, subprocess.SubprocessError):
                subprocess.run(
                    ("ssh", *_SSH_OPTIONS, _SSH_TARGET, "rm", "-r", "--", remote),
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=30,
                )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    local = commands.add_parser("adopt")
    local.add_argument("source_sha")
    host = commands.add_parser("host")
    host.add_argument("--source-sha", required=True)
    host.add_argument("--compose", type=Path, required=True)
    host.add_argument("--compose-sha256", required=True)
    host.add_argument("--caddy", type=Path, required=True)
    host.add_argument("--caddy-sha256", required=True)
    host.add_argument("--owner", type=Path, required=True)
    host.add_argument("--owner-sha256", required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "adopt":
            return _run_local(args.source_sha)
        if os.geteuid() != 0:
            raise AdoptionBlocked("host infrastructure adoption must run as root")
        with adoption_lock(AdoptionPaths().lock_path):
            result = InfrastructureAdoption().adopt(
                source_sha=args.source_sha,
                compose_source=args.compose,
                compose_sha256=args.compose_sha256,
                caddy_source=args.caddy,
                caddy_sha256=args.caddy_sha256,
                owner_source=args.owner,
                owner_sha256=args.owner_sha256,
            )
        sys.stdout.buffer.write(_canonical_bytes(result))
        return 0
    except (AdoptionBlocked, AdoptionDefect) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except (OSError, subprocess.SubprocessError):
        print("error: production adoption transport failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
