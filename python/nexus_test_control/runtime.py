from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import stat
import tempfile
from collections.abc import Iterable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, replace
from enum import StrEnum
from pathlib import Path
from typing import cast

from nexus_test_control.model import Resource, ResourceKind

RUNTIME_VERSION = 1
LEDGER_VERSION = 1
LOOPBACK_HOST = "127.0.0.1"
TEMPLATE_FINGERPRINT_HEX_LENGTH = 40

_RUN_ID = re.compile(r"[0-9a-f]{16}\Z")
_REPO_ID = re.compile(r"[0-9a-f]{16}\Z")
_FINGERPRINT = re.compile(r"[0-9a-f]{40}\Z")
_SCENARIO_ID = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\Z")
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
_PROCESS_ROLES = frozenset({"api", "web", "worker-interactive", "worker-background"})


class RuntimeContractError(ValueError):
    """A value is outside this repository's recorded local-test runtime."""


class EndpointKind(StrEnum):
    POSTGRES = "postgres"
    MINIO = "minio"
    SUPABASE = "supabase"
    API = "api"
    WEB = "web"


class ResourcePhase(StrEnum):
    PLANNED = "planned"
    CREATED = "created"


@dataclass(frozen=True, slots=True)
class RuntimePorts:
    postgres: int
    minio: int
    supabase_api: int
    supabase_db: int
    supabase_studio: int
    supabase_inbucket: int
    supabase_shadow: int
    api: int
    web: int

    def __post_init__(self) -> None:
        ports = tuple(self.as_dict().values())
        if any(
            isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535
            for port in ports
        ):
            raise RuntimeContractError("runtime ports must be integers from 1 through 65535")
        if len(ports) != len(set(ports)):
            raise RuntimeContractError("runtime ports must be distinct")

    def as_dict(self) -> dict[str, int]:
        return {
            "postgres": self.postgres,
            "minio": self.minio,
            "supabase_api": self.supabase_api,
            "supabase_db": self.supabase_db,
            "supabase_studio": self.supabase_studio,
            "supabase_inbucket": self.supabase_inbucket,
            "supabase_shadow": self.supabase_shadow,
            "api": self.api,
            "web": self.web,
        }


@dataclass(frozen=True, slots=True)
class RuntimeRecord:
    version: int
    repo_id: str
    compose_project: str
    supabase_workdir: str
    ports: RuntimePorts
    owned_run_ids: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class LedgerEntry:
    resource: Resource
    phase: ResourcePhase
    scenario_id: str | None = None
    process_group_id: int | None = None
    external_id: str | None = None
    command: tuple[str, ...] | None = None
    process_start_token: str | None = None


@dataclass(frozen=True, slots=True)
class RunLedger:
    version: int
    repo_id: str
    run_id: str
    entries: tuple[LedgerEntry, ...]


@dataclass(frozen=True, slots=True)
class CleanupCandidate:
    resource: Resource
    endpoint: str | None
    process_group_id: int | None
    external_id: str | None
    command: tuple[str, ...] | None
    process_start_token: str | None


def require_test_environment(environment: Mapping[str, str]) -> None:
    if environment.get("NEXUS_ENV") != "test":
        raise RuntimeContractError("NEXUS_ENV must be exactly 'test'")


def local_docker_host(candidates: Sequence[Path] | None = None) -> str:
    """Resolve Docker only through a verified local Unix-domain socket."""
    paths = (
        tuple(candidates)
        if candidates is not None
        else (
            Path(f"/run/user/{os.getuid()}/docker.sock"),
            Path("/var/run/docker.sock"),
        )
    )
    for path in paths:
        try:
            mode = path.stat().st_mode
        except OSError:
            continue
        if stat.S_ISSOCK(mode):
            return f"unix://{path.resolve(strict=True)}"
    raise RuntimeContractError("test control requires a verified local Docker Unix socket")


def canonical_repo_root(repo_root: Path) -> Path:
    try:
        resolved = repo_root.resolve(strict=True)
    except OSError as exc:
        raise RuntimeContractError(f"repository cannot be resolved: {repo_root}") from exc
    if not resolved.is_dir():
        raise RuntimeContractError(f"repository is not a directory: {resolved}")
    return resolved


def repo_id_for(repo_root: Path) -> str:
    return hashlib.sha256(os.fsencode(canonical_repo_root(repo_root))).hexdigest()[:16]


def compose_project_name(repo_id: str) -> str:
    _require_match(repo_id, _REPO_ID, "repo id")
    return f"nexus-test-{repo_id}"


def runtime_state_dir(repo_root: Path) -> Path:
    return canonical_repo_root(repo_root) / ".nexus-test"


def runtime_record_path(repo_root: Path) -> Path:
    return runtime_state_dir(repo_root) / "runtime.json"


def resource_ledger_path(repo_root: Path, run_id: str) -> Path:
    require_run_id(run_id)
    return runtime_state_dir(repo_root) / "runs" / run_id / "resources.json"


def initialize_runtime(
    repo_root: Path, environment: Mapping[str, str], ports: RuntimePorts
) -> RuntimeRecord:
    require_test_environment(environment)
    with _state_lock(repo_root, "runtime"):
        if runtime_record_path(repo_root).exists():
            existing = read_runtime(repo_root)
            if existing.ports != ports:
                raise RuntimeContractError("recorded runtime ports cannot be replaced")
            return existing
        repo_id = repo_id_for(repo_root)
        record = RuntimeRecord(
            version=RUNTIME_VERSION,
            repo_id=repo_id,
            compose_project=compose_project_name(repo_id),
            supabase_workdir=str(runtime_state_dir(repo_root) / "supabase"),
            ports=ports,
        )
        _write_json(runtime_record_path(repo_root), _runtime_to_json(record))
        return record


def read_runtime(repo_root: Path) -> RuntimeRecord:
    record = _runtime_from_json(_read_json(runtime_record_path(repo_root)))
    expected_repo_id = repo_id_for(repo_root)
    if record.repo_id != expected_repo_id:
        raise RuntimeContractError("runtime belongs to a different repository")
    if record.compose_project != compose_project_name(expected_repo_id):
        raise RuntimeContractError("runtime compose project is not repository-owned")
    if record.supabase_workdir != str(runtime_state_dir(repo_root) / "supabase"):
        raise RuntimeContractError("runtime Supabase workdir is not repository-owned")
    return record


def claim_run(repo_root: Path, environment: Mapping[str, str], run_id: str) -> RunLedger:
    require_test_environment(environment)
    require_run_id(run_id)
    with _state_lock(repo_root, "runtime"):
        record = read_runtime(repo_root)
        ledger_path = resource_ledger_path(repo_root, run_id)
        if ledger_path.exists():
            raise RuntimeContractError(f"run is already recorded: {run_id}")
        if run_id not in record.owned_run_ids:
            record = replace(record, owned_run_ids=tuple(sorted((*record.owned_run_ids, run_id))))
            _write_json(runtime_record_path(repo_root), _runtime_to_json(record))
        ledger = RunLedger(LEDGER_VERSION, record.repo_id, run_id, ())
        _write_json(ledger_path, _ledger_to_json(ledger))
        return ledger


def read_ledger(repo_root: Path, run_id: str) -> RunLedger:
    runtime = read_runtime(repo_root)
    ledger = _ledger_from_json(_read_json(resource_ledger_path(repo_root, run_id)))
    if ledger.repo_id != runtime.repo_id or ledger.run_id != run_id:
        raise RuntimeContractError("ledger does not belong to its exact repository and run")
    if run_id not in runtime.owned_run_ids:
        raise RuntimeContractError("ledger run is not owned by the persisted runtime")
    _validate_ledger(ledger)
    return ledger


def runtime_endpoint(repo_root: Path, environment: Mapping[str, str], kind: EndpointKind) -> str:
    require_test_environment(environment)
    return _endpoint(read_runtime(repo_root).ports, kind)


def record_planned(
    repo_root: Path,
    environment: Mapping[str, str],
    run_id: str,
    resource: Resource,
    *,
    scenario_id: str | None = None,
    external_id: str | None = None,
    command: Sequence[str] | None = None,
) -> LedgerEntry:
    require_test_environment(environment)
    require_run_id(run_id)
    with _state_lock(repo_root, f"run-{run_id}"):
        ledger = read_ledger(repo_root, run_id)
        _validate_resource(resource, run_id, scenario_id)
        if any(entry.resource == resource for entry in ledger.entries):
            raise RuntimeContractError("resource is already recorded")
        normalized_command = tuple(command) if command is not None else None
        if resource.kind is ResourceKind.PROCESS:
            if not normalized_command or any(not part for part in normalized_command):
                raise RuntimeContractError("planned process requires its exact command")
        elif normalized_command is not None:
            raise RuntimeContractError("only a process can record a command")
        if resource.kind is ResourceKind.SUPABASE_USER:
            _require_match(external_id, _UUID, "planned Supabase admin user id")
        elif resource.kind is ResourceKind.TEMPLATE_BUILD:
            _require_match(external_id, _FINGERPRINT, "template build fingerprint")
        elif external_id is not None:
            raise RuntimeContractError("resource kind cannot record an external id while planned")
        entry = LedgerEntry(
            resource,
            ResourcePhase.PLANNED,
            scenario_id,
            external_id=external_id,
            command=normalized_command,
        )
        updated = replace(ledger, entries=(*ledger.entries, entry))
        _write_json(resource_ledger_path(repo_root, run_id), _ledger_to_json(updated))
        return entry


def record_created(
    repo_root: Path,
    environment: Mapping[str, str],
    run_id: str,
    resource: Resource,
    *,
    process_group_id: int | None = None,
    external_id: str | None = None,
    process_start_token: str | None = None,
) -> LedgerEntry:
    require_test_environment(environment)
    require_run_id(run_id)
    with _state_lock(repo_root, f"run-{run_id}"):
        ledger = read_ledger(repo_root, run_id)
        index, entry = _entry(ledger, resource)
        if entry.phase is not ResourcePhase.PLANNED:
            raise RuntimeContractError("only a planned resource can become created")
        if resource.kind is ResourceKind.PROCESS:
            if (
                isinstance(process_group_id, bool)
                or not isinstance(process_group_id, int)
                or process_group_id <= 1
            ):
                raise RuntimeContractError("a created process requires its process-group id")
            if not isinstance(process_start_token, str) or not process_start_token.isdecimal():
                raise RuntimeContractError("a created process requires its birth token")
        elif process_group_id is not None:
            raise RuntimeContractError("only a process can record a process-group id")
        elif process_start_token is not None:
            raise RuntimeContractError("only a process can record a birth token")
        resolved_external_id = external_id if external_id is not None else entry.external_id
        if resource.kind is ResourceKind.SUPABASE_USER:
            _require_match(resolved_external_id, _UUID, "Supabase admin user id")
            if resolved_external_id != entry.external_id:
                raise RuntimeContractError("created Supabase user id changed after planning")
        elif resource.kind is ResourceKind.TEMPLATE_BUILD:
            _require_match(resolved_external_id, _FINGERPRINT, "template build fingerprint")
        elif resolved_external_id is not None:
            raise RuntimeContractError("resource kind cannot record an external id")
        created = replace(
            entry,
            phase=ResourcePhase.CREATED,
            process_group_id=process_group_id,
            external_id=resolved_external_id,
            process_start_token=process_start_token,
        )
        entries = list(ledger.entries)
        entries[index] = created
        _write_json(
            resource_ledger_path(repo_root, run_id),
            _ledger_to_json(replace(ledger, entries=tuple(entries))),
        )
        return created


def cleanup_candidates(
    repo_root: Path, environment: Mapping[str, str], run_id: str
) -> tuple[CleanupCandidate, ...]:
    require_test_environment(environment)
    require_run_id(run_id)
    with _state_lock(repo_root, f"run-{run_id}"):
        runtime = read_runtime(repo_root)
        ledger = read_ledger(repo_root, run_id)
        return tuple(
            CleanupCandidate(
                entry.resource,
                _resource_endpoint(runtime.ports, entry.resource.kind),
                entry.process_group_id,
                entry.external_id,
                entry.command,
                entry.process_start_token,
            )
            for entry in reversed(ledger.entries)
        )


def forget_cleaned(
    repo_root: Path,
    environment: Mapping[str, str],
    run_id: str,
    resource: Resource,
) -> None:
    require_test_environment(environment)
    require_run_id(run_id)
    with _state_lock(repo_root, f"run-{run_id}"):
        ledger = read_ledger(repo_root, run_id)
        index, _ = _entry(ledger, resource)
        entries = (*ledger.entries[:index], *ledger.entries[index + 1 :])
        _write_json(
            resource_ledger_path(repo_root, run_id),
            _ledger_to_json(replace(ledger, entries=entries)),
        )


def release_run(repo_root: Path, environment: Mapping[str, str], run_id: str) -> None:
    require_test_environment(environment)
    require_run_id(run_id)
    with _state_lock(repo_root, f"run-{run_id}"), _state_lock(repo_root, "runtime"):
        ledger = read_ledger(repo_root, run_id)
        if ledger.entries:
            raise RuntimeContractError("run cannot be released while resources remain")
        record = read_runtime(repo_root)
        ledger_path = resource_ledger_path(repo_root, run_id)
        extension_directory = ledger_path.parent / "extension"
        if extension_directory.exists():
            try:
                extension_directory.rmdir()
            except OSError as exc:
                raise RuntimeContractError(
                    "run contains extension state absent from its ledger"
                ) from exc
        if tuple(ledger_path.parent.iterdir()) != (ledger_path,):
            raise RuntimeContractError("run contains state absent from its exact ledger")
        ledger_path.unlink()
        ledger_path.parent.rmdir()
        _write_json(
            runtime_record_path(repo_root),
            _runtime_to_json(
                replace(
                    record,
                    owned_run_ids=tuple(item for item in record.owned_run_ids if item != run_id),
                )
            ),
        )


def require_run_id(run_id: str) -> None:
    _require_match(run_id, _RUN_ID, "run id")


def require_scenario_id(scenario_id: str) -> None:
    _require_match(scenario_id, _SCENARIO_ID, "scenario id")


def template_database_name(fingerprint: str) -> str:
    _require_match(fingerprint, _FINGERPRINT, "template fingerprint")
    return f"nexus_tpl_{fingerprint}"


def template_build_database_name(run_id: str) -> str:
    require_run_id(run_id)
    return f"nexus_tpl_build_{run_id}"


def run_database_name(run_id: str) -> str:
    require_run_id(run_id)
    return f"nexus_run_{run_id}"


def migration_database_name(run_id: str) -> str:
    require_run_id(run_id)
    return f"nexus_migration_{run_id}"


def run_bucket_name(run_id: str) -> str:
    require_run_id(run_id)
    return f"nexus-run-{run_id}"


def supabase_user_email(run_id: str, scenario_id: str) -> str:
    require_run_id(run_id)
    require_scenario_id(scenario_id)
    return f"nexus+{run_id}+{scenario_id}@example.invalid"


def supabase_user_metadata(run_id: str, scenario_id: str) -> dict[str, str]:
    supabase_user_email(run_id, scenario_id)
    return {"nexus_test_run_id": run_id, "nexus_test_scenario": scenario_id}


def extension_profile_identity(run_id: str, scenario_id: str) -> str:
    require_run_id(run_id)
    require_scenario_id(scenario_id)
    return f".nexus-test/runs/{run_id}/extension/{scenario_id}"


def process_resource_identity(run_id: str, role: str) -> str:
    require_run_id(run_id)
    if role not in _PROCESS_ROLES:
        raise RuntimeContractError(f"unknown process role: {role!r}")
    return f"nexus-process-{run_id}-{role}"


def template_fingerprint(
    repo_root: Path,
    *,
    migration_sources: Sequence[Path],
    postgres_image: str,
    postgres_version: str,
    extensions: Iterable[str],
    immutable_seed_sources: Sequence[Path],
) -> str:
    root = canonical_repo_root(repo_root)
    if not postgres_image or not postgres_version:
        raise RuntimeContractError("PostgreSQL image and version are required")
    extension_names = tuple(sorted(set(extensions)))
    if not extension_names or any(not name for name in extension_names):
        raise RuntimeContractError("at least one PostgreSQL extension is required")
    files = (
        *(("migration", *item) for item in _fingerprint_files(root, migration_sources)),
        *(("seed", *item) for item in _fingerprint_files(root, immutable_seed_sources)),
    )
    if not migration_sources:
        raise RuntimeContractError("at least one migration source is required")
    digest = hashlib.sha256()
    for value in (
        "nexus-postgres-template-v1",
        postgres_image,
        postgres_version,
        *extension_names,
    ):
        digest.update(value.encode())
        digest.update(b"\0")
    for label, relative, contents in files:
        digest.update(label.encode() + b"\0" + relative.encode() + b"\0" + contents + b"\0")
    return digest.hexdigest()[:TEMPLATE_FINGERPRINT_HEX_LENGTH]


@contextmanager
def template_lifecycle_lock(
    repo_root: Path, environment: Mapping[str, str], fingerprint: str
) -> Iterator[Path]:
    require_test_environment(environment)
    _require_match(fingerprint, _FINGERPRINT, "template fingerprint")
    path = runtime_state_dir(repo_root) / "locks" / f"template-{fingerprint}.lock"
    with _locked_path(path):
        yield path


@contextmanager
def run_lifecycle_lock(
    repo_root: Path, environment: Mapping[str, str], run_id: str
) -> Iterator[Path]:
    require_test_environment(environment)
    require_run_id(run_id)
    path = runtime_state_dir(repo_root) / "locks" / f"lifecycle-{run_id}.lock"
    with _locked_path(path):
        yield path


@contextmanager
def _state_lock(repo_root: Path, name: str) -> Iterator[None]:
    with _locked_path(runtime_state_dir(repo_root) / "locks" / f"{name}.lock"):
        yield


@contextmanager
def _locked_path(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_file = path.open("a+b")
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        lock_file.close()


def _validate_ledger(ledger: RunLedger) -> None:
    if ledger.version != LEDGER_VERSION:
        raise RuntimeContractError("unsupported ledger version")
    _require_match(ledger.repo_id, _REPO_ID, "repo id")
    require_run_id(ledger.run_id)
    identities: set[tuple[ResourceKind, str]] = set()
    for entry in ledger.entries:
        _validate_resource(entry.resource, ledger.run_id, entry.scenario_id)
        identity = (entry.resource.kind, entry.resource.identity)
        if identity in identities:
            raise RuntimeContractError("ledger contains a duplicate resource")
        identities.add(identity)
        if entry.resource.kind is ResourceKind.PROCESS:
            if not entry.command or any(not part for part in entry.command):
                raise RuntimeContractError("process lacks its exact command")
            if entry.phase is ResourcePhase.CREATED and (
                isinstance(entry.process_group_id, bool)
                or not isinstance(entry.process_group_id, int)
                or entry.process_group_id <= 1
            ):
                raise RuntimeContractError("created process lacks its process-group id")
            if entry.phase is ResourcePhase.CREATED and (
                not isinstance(entry.process_start_token, str)
                or not entry.process_start_token.isdecimal()
            ):
                raise RuntimeContractError("created process lacks its birth token")
            if entry.phase is ResourcePhase.PLANNED and (
                entry.process_group_id is not None or entry.process_start_token is not None
            ):
                raise RuntimeContractError("planned process already has a runtime identity")
        elif entry.process_group_id is not None:
            raise RuntimeContractError("non-process resource has a process-group id")
        elif entry.command is not None or entry.process_start_token is not None:
            raise RuntimeContractError("non-process resource has process state")
        if entry.resource.kind is ResourceKind.SUPABASE_USER:
            _require_match(entry.external_id, _UUID, "Supabase admin user id")
        elif entry.resource.kind is ResourceKind.TEMPLATE_BUILD:
            _require_match(entry.external_id, _FINGERPRINT, "template build fingerprint")
        elif entry.external_id is not None:
            raise RuntimeContractError("resource kind cannot have an external id")


def _validate_resource(resource: Resource, run_id: str, scenario_id: str | None) -> None:
    kind = resource.kind
    identity = resource.identity
    if kind is ResourceKind.TEMPLATE:
        raise RuntimeContractError("shared finalized templates are not run-owned resources")
    if kind is ResourceKind.TEMPLATE_BUILD:
        expected = template_build_database_name(run_id)
    elif kind is ResourceKind.RUN_DATABASE:
        expected = run_database_name(run_id)
    elif kind is ResourceKind.MIGRATION_DATABASE:
        expected = migration_database_name(run_id)
    elif kind is ResourceKind.BUCKET:
        expected = run_bucket_name(run_id)
    elif kind is ResourceKind.SUPABASE_USER:
        if scenario_id is None:
            raise RuntimeContractError("Supabase user requires scenario metadata")
        expected = supabase_user_email(run_id, scenario_id)
    elif kind is ResourceKind.PROCESS:
        if scenario_id is not None:
            raise RuntimeContractError("process must not carry scenario metadata")
        role = identity.removeprefix(f"nexus-process-{run_id}-")
        expected = process_resource_identity(run_id, role)
    elif kind is ResourceKind.EXTENSION_PROFILE:
        if scenario_id is None:
            raise RuntimeContractError("extension profile requires scenario metadata")
        expected = extension_profile_identity(run_id, scenario_id)
    else:
        raise RuntimeContractError(f"resource kind is not run-owned: {kind.value}")
    if identity != expected:
        raise RuntimeContractError(f"{kind.value} identity is not the exact test-only name")
    if kind not in {ResourceKind.SUPABASE_USER, ResourceKind.EXTENSION_PROFILE} and (
        scenario_id is not None
    ):
        raise RuntimeContractError("resource kind must not carry scenario metadata")


def _resource_endpoint(ports: RuntimePorts, kind: ResourceKind) -> str | None:
    if kind in {
        ResourceKind.TEMPLATE_BUILD,
        ResourceKind.RUN_DATABASE,
        ResourceKind.MIGRATION_DATABASE,
    }:
        return _endpoint(ports, EndpointKind.POSTGRES)
    if kind is ResourceKind.BUCKET:
        return _endpoint(ports, EndpointKind.MINIO)
    if kind is ResourceKind.SUPABASE_USER:
        return _endpoint(ports, EndpointKind.SUPABASE)
    return None


def _endpoint(ports: RuntimePorts, kind: EndpointKind) -> str:
    port = {
        EndpointKind.POSTGRES: ports.postgres,
        EndpointKind.MINIO: ports.minio,
        EndpointKind.SUPABASE: ports.supabase_api,
        EndpointKind.API: ports.api,
        EndpointKind.WEB: ports.web,
    }[kind]
    scheme = "postgresql" if kind is EndpointKind.POSTGRES else "http"
    return f"{scheme}://{LOOPBACK_HOST}:{port}"


def _entry(ledger: RunLedger, resource: Resource) -> tuple[int, LedgerEntry]:
    for index, entry in enumerate(ledger.entries):
        if entry.resource == resource:
            return index, entry
    raise RuntimeContractError("resource is not recorded in the exact run ledger")


def _fingerprint_files(root: Path, sources: Sequence[Path]) -> tuple[tuple[str, bytes], ...]:
    found: list[tuple[str, bytes]] = []
    for source in sources:
        try:
            resolved = source.resolve(strict=True)
            relative = resolved.relative_to(root).as_posix()
        except (OSError, ValueError) as exc:
            raise RuntimeContractError("fingerprint source is outside the repository") from exc
        if not resolved.is_file():
            raise RuntimeContractError("fingerprint source must be a file")
        found.append((relative, resolved.read_bytes()))
    if len({relative for relative, _ in found}) != len(found):
        raise RuntimeContractError("fingerprint source is duplicated")
    return tuple(sorted(found))


def _runtime_to_json(record: RuntimeRecord) -> dict[str, object]:
    return {
        "version": record.version,
        "repo_id": record.repo_id,
        "compose_project": record.compose_project,
        "supabase_workdir": record.supabase_workdir,
        "ports": record.ports.as_dict(),
        "owned_run_ids": list(record.owned_run_ids),
    }


def _runtime_from_json(value: object) -> RuntimeRecord:
    data = _object(value, "runtime")
    _keys(
        data,
        {"version", "repo_id", "compose_project", "supabase_workdir", "ports", "owned_run_ids"},
        "runtime",
    )
    ports = _object(data["ports"], "runtime ports")
    _keys(ports, set(RuntimePorts.__annotations__), "runtime ports")
    run_ids = data["owned_run_ids"]
    if not isinstance(run_ids, list) or any(not isinstance(item, str) for item in run_ids):
        raise RuntimeContractError("owned_run_ids must be an array of strings")
    record = RuntimeRecord(
        version=cast(int, data["version"]),
        repo_id=cast(str, data["repo_id"]),
        compose_project=cast(str, data["compose_project"]),
        supabase_workdir=cast(str, data["supabase_workdir"]),
        ports=RuntimePorts(**cast(dict[str, int], ports)),
        owned_run_ids=tuple(run_ids),
    )
    if record.version != RUNTIME_VERSION or record.owned_run_ids != tuple(sorted(set(run_ids))):
        raise RuntimeContractError("runtime version or owned runs are invalid")
    return record


def _ledger_to_json(ledger: RunLedger) -> dict[str, object]:
    return {
        "version": ledger.version,
        "repo_id": ledger.repo_id,
        "run_id": ledger.run_id,
        "entries": [
            {
                "kind": entry.resource.kind.value,
                "identity": entry.resource.identity,
                "phase": entry.phase.value,
                "scenario_id": entry.scenario_id,
                "process_group_id": entry.process_group_id,
                "external_id": entry.external_id,
                "command": list(entry.command) if entry.command is not None else None,
                "process_start_token": entry.process_start_token,
            }
            for entry in ledger.entries
        ],
    }


def _ledger_from_json(value: object) -> RunLedger:
    data = _object(value, "ledger")
    _keys(data, {"version", "repo_id", "run_id", "entries"}, "ledger")
    raw_entries = data["entries"]
    if not isinstance(raw_entries, list):
        raise RuntimeContractError("ledger entries must be an array")
    entries: list[LedgerEntry] = []
    for raw in raw_entries:
        item = _object(raw, "ledger entry")
        _keys(
            item,
            {
                "kind",
                "identity",
                "phase",
                "scenario_id",
                "process_group_id",
                "external_id",
                "command",
                "process_start_token",
            },
            "ledger entry",
        )
        if not isinstance(item["identity"], str):
            raise RuntimeContractError("ledger resource identity must be a string")
        raw_command = item["command"]
        if raw_command is not None and (
            not isinstance(raw_command, list)
            or any(not isinstance(part, str) for part in raw_command)
        ):
            raise RuntimeContractError("ledger process command must be an array of strings")
        try:
            entries.append(
                LedgerEntry(
                    Resource(ResourceKind(item["kind"]), cast(str, item["identity"])),
                    ResourcePhase(item["phase"]),
                    cast(str | None, item["scenario_id"]),
                    cast(int | None, item["process_group_id"]),
                    cast(str | None, item["external_id"]),
                    tuple(cast(list[str], raw_command)) if raw_command is not None else None,
                    cast(str | None, item["process_start_token"]),
                )
            )
        except (TypeError, ValueError) as exc:
            raise RuntimeContractError("ledger entry is malformed") from exc
    return RunLedger(
        cast(int, data["version"]),
        cast(str, data["repo_id"]),
        cast(str, data["run_id"]),
        tuple(entries),
    )


def _object(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise RuntimeContractError(f"{label} must be a JSON object")
    return cast(dict[str, object], value)


def _keys(data: Mapping[str, object], expected: set[str], label: str) -> None:
    if set(data) != expected:
        raise RuntimeContractError(f"{label} keys must be exactly {sorted(expected)}")


def _require_match(value: object, pattern: re.Pattern[str], label: str) -> None:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise RuntimeContractError(f"{label} has an invalid test-only shape")


def _read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeContractError(f"runtime state could not be read: {path}") from exc


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=path.parent, delete=False
        ) as handle:
            temporary = Path(handle.name)
            json.dump(value, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError as exc:
        raise RuntimeContractError(f"runtime state could not be written: {path}") from exc
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
