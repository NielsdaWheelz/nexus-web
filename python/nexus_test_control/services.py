from __future__ import annotations

import ctypes
import errno
import fcntl
import ipaddress
import json
import mmap
import os
import re
import secrets
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import boto3
import httpx
import psycopg
from botocore.client import BaseClient, Config
from botocore.exceptions import ClientError
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from psycopg import sql

from nexus.config import BACKGROUND_WORKER_MEMORY_LIMIT_BYTES
from nexus.release_artifact import (
    BackendArtifactDefect,
    build_runtime_identity,
    load_runtime_identity,
    write_runtime_identity_value,
)
from nexus_test_control.build import StandaloneBuild
from nexus_test_control.model import Resource, ResourceKind
from nexus_test_control.process import run_command, unblock_and_exec_command
from nexus_test_control.runtime import (
    EndpointKind,
    LedgerEntry,
    ResourcePhase,
    RuntimeContractError,
    RuntimePorts,
    RuntimeRecord,
    canonical_repo_root,
    claim_run,
    cleanup_candidates,
    forget_cleaned,
    initialize_runtime,
    local_docker_host,
    migration_database_name,
    process_resource_identity,
    provider_fixture_identity,
    read_ledger,
    read_previous_runtime_for_cleanup,
    read_runtime,
    record_created,
    record_planned,
    release_run,
    require_run_id,
    require_scenario_id,
    require_test_environment,
    run_bucket_name,
    run_database_name,
    run_lifecycle_lock,
    runtime_endpoint,
    runtime_record_path,
    runtime_state_dir,
    supabase_user_email,
    supabase_user_metadata,
    template_build_database_name,
    template_database_name,
    template_fingerprint,
    template_lifecycle_lock,
    upgrade_previous_runtime,
)

POSTGRES_IMAGE = (
    "pgvector/pgvector@sha256:bd12d6788a617f4147d5a2ae0b56d07921398adabfe5a033bd3f50c245df55a1"
)
POSTGRES_VERSION = "15"
MINIO_ACCESS_KEY = "nexus-test-access-key"
MINIO_SECRET_KEY = "nexus-test-secret-key"
MINIO_REGION = "us-east-1"
TEST_EXTENSION_PUBLIC_KEY = (
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7aGcdPe/ohIT6LtXJ0f01AQTBwebDyeBOwM"
    "gtKOlrFeyM0N1rd0f8a04zaf9COcb1W3D+VfvFBUmSzA9VFV/OH8lCubZiSezftQggTIUGZvnvzL"
    "sei/KNK1OO5uC7lfT3TDeYdw4qMMo0WU6QxUyMGeXuqV9dhBexVkQhSvKKZvgN2lX5cXvoH4N7fa"
    "x0GFN5IYKodpTmAHMlxSrhAbQ8ZgNqTZN9M+TA2sbGUP2h9TVXyG90XOdTSr4eFHvogXuQC6bN4Q"
    "oZ3TurMbTspO06nWOKE+Ls+5F0sB3Po1qVfdNd2pzTKn+diDPJ3WwlwwdoN3bBxn/A0V+uzWRym0/"
    "YwIDAQAB"
)
TEST_EXTENSION_ID = "pfcfdmanlahjkanalhpnfjflgaaahgib"
SUPABASE_EXCLUDED_SERVICES = (
    "realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,postgres-meta,postgrest"
)
CADDY_VERSION = "v2.11.4"
_CADDY_MODULE_BUILD_PIN = f"github.com/caddyserver/caddy/v2\t{CADDY_VERSION}".encode()

_PORT_DEFAULTS = (
    15432,
    19000,
    25421,
    25422,
    25423,
    25424,
    25425,
    18000,
    13000,
    19091,
    19092,
)
_EPHEMERAL_PORT_RANGE_PATH = Path("/proc/sys/net/ipv4/ip_local_port_range")
_CONSERVATIVE_EPHEMERAL_PORT_RANGE = (32768, 65535)
_SUPABASE_DIAGNOSTIC_TAIL_CHARS = 8192
_DARWIN_PROCESS_BSD_INFO = 3
_DARWIN_LIBPROC = "/usr/lib/libproc.dylib"
_DARWIN_LSOF = "/usr/sbin/lsof"
_SAFE_CHILD_ENV = ("HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "TZ", "UV_CACHE_DIR")
_STATUS_KEYS = frozenset(
    {"API_URL", "ANON_KEY", "PUBLISHABLE_KEY", "SECRET_KEY", "SERVICE_ROLE_KEY"}
)
_CALLER_RESOURCE_ENV = frozenset(
    {
        "AWS_ACCESS_KEY_ID",
        "AWS_ENDPOINT_URL",
        "AWS_ENDPOINT_URL_S3",
        "AWS_PROFILE",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "CSP_MEDIA_ORIGINS",
        "DATABASE_URL",
        "DATABASE_URL_TEST",
        "DATABASE_URL_TEST_MIGRATIONS",
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXUS_TEST_PROCESS_OWNER",
        "NEXUS_TEST_PROCESS_OWNER_FD",
        "NEXUS_TEST_STATIC_DNS",
        "NEXUS_TEST_TLS_CA_CERT",
        "NODE_OPTIONS",
        "OUTBOUND_HTTP_PROXY_URL",
        "PODCAST_INDEX_API_KEY",
        "PODCAST_INDEX_API_SECRET",
        "PODCAST_INDEX_BASE_URL",
        "PGDATABASE",
        "PGHOST",
        "PGPASSFILE",
        "PGPASSWORD",
        "PGSERVICE",
        "PGSERVICEFILE",
        "PGUSER",
        "R2_ENDPOINT_URL",
        "R2_ACCESS_KEY_ID",
        "R2_BUCKET",
        "R2_REGION",
        "R2_S3_API_ORIGIN",
        "R2_SECRET_ACCESS_KEY",
        "SERVICE_ROLE_KEY",
        "SUPABASE_ANON_KEY",
        "SUPABASE_ACCESS_TOKEN",
        "SUPABASE_AUTH_ADMIN_KEY",
        "SUPABASE_DATABASE_URL",
        "SUPABASE_DB_URL",
        "SUPABASE_ISSUER",
        "SUPABASE_JWKS_URL",
        "SUPABASE_SERVICE_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_URL",
    }
)


@dataclass(frozen=True, slots=True)
class SupabaseCredentials:
    url: str
    anon_key: str
    admin_key: str = field(repr=False)


@dataclass(frozen=True, slots=True)
class TestRun:
    run_id: str
    database_url: str
    migration_database_url: str | None
    bucket: str
    supabase: SupabaseCredentials


@dataclass(frozen=True, slots=True)
class TestUser:
    id: str
    email: str
    password: str = field(repr=False)


@dataclass(frozen=True, slots=True)
class InvitedTestUser:
    email: str


@dataclass(frozen=True, slots=True)
class StartedProcess:
    role: str
    process_group_id: int
    process_start_token: str
    run_id: str
    owner_token: str = field(repr=False)
    log_path: str


@dataclass(frozen=True, slots=True)
class _ProcessIdentity:
    uid: int
    process_group_id: int
    start_token: str


class _DarwinProcessInfo(ctypes.Structure):
    _fields_ = (
        ("flags", ctypes.c_uint32),
        ("status", ctypes.c_uint32),
        ("exit_status", ctypes.c_uint32),
        ("process_id", ctypes.c_uint32),
        ("parent_process_id", ctypes.c_uint32),
        ("uid", ctypes.c_uint32),
        ("gid", ctypes.c_uint32),
        ("real_uid", ctypes.c_uint32),
        ("real_gid", ctypes.c_uint32),
        ("saved_uid", ctypes.c_uint32),
        ("saved_gid", ctypes.c_uint32),
        ("reserved", ctypes.c_uint32),
        ("command", ctypes.c_char * 16),
        ("name", ctypes.c_char * 32),
        ("file_count", ctypes.c_uint32),
        ("process_group_id", ctypes.c_uint32),
        ("job_control_count", ctypes.c_uint32),
        ("controlling_device", ctypes.c_uint32),
        ("terminal_process_group_id", ctypes.c_uint32),
        ("nice", ctypes.c_int32),
        ("start_seconds", ctypes.c_uint64),
        ("start_microseconds", ctypes.c_uint64),
    )


def required_platform_process_tools() -> tuple[Path, ...]:
    """Return fixed host tools required by the platform process owner."""
    return (Path(_DARWIN_LSOF),) if sys.platform == "darwin" else ()


@dataclass(frozen=True, slots=True)
class OpenAIProviderFixture:
    """Exact run-owned state for the canonical OpenAI protocol process."""

    state: Path
    certificate: Path
    key: Path = field(repr=False)
    audit: Path
    port: int

    def server_environment(self) -> dict[str, str]:
        return {
            "NEXUS_TEST_OPENAI_CERTIFICATE": str(self.certificate),
            "NEXUS_TEST_OPENAI_KEY": str(self.key),
            "NEXUS_TEST_OPENAI_AUDIT": str(self.audit),
        }

    def client_environment(self) -> dict[str, str]:
        return {
            "NEXUS_TEST_STATIC_DNS": json.dumps(
                {
                    "api.openai.com": {"address": "127.0.0.1", "port": self.port},
                    "www.nasa.gov": "93.184.216.34",
                },
                separators=(",", ":"),
                sort_keys=True,
            ),
            "NEXUS_TEST_TLS_CA_CERT": str(self.certificate),
        }

    def worker_environment(self) -> dict[str, str]:
        """Compatibility name for production-worker protocol proofs."""
        return self.client_environment()

    def requests(self) -> tuple[dict[str, object], ...]:
        rows = tuple(
            json.loads(line) for line in self.audit.read_text(encoding="utf-8").splitlines() if line
        )
        payloads = tuple(
            row["payload"]
            for row in rows
            if isinstance(row, dict)
            and row.get("path") == "/v1/embeddings"
            and isinstance(row.get("payload"), dict)
        )
        return cast(tuple[dict[str, object], ...], payloads)


def run_environment(
    repo_root: Path,
    environment: Mapping[str, str],
    run: TestRun,
) -> dict[str, str]:
    """Return the exact local resource environment for proof and app processes."""
    require_test_environment(environment)
    root = canonical_repo_root(repo_root)
    require_run_id(run.run_id)
    ledger = read_ledger(root, run.run_id)
    expected_database_url = _database_url(root, environment, run_database_name(run.run_id))
    expected_migration_url = _expected_migration_database_url(
        root,
        environment,
        run.run_id,
        ledger.entries,
    )
    expected_bucket = run_bucket_name(run.run_id)
    expected_supabase_url = runtime_endpoint(root, environment, EndpointKind.SUPABASE)
    _require_created_run_resource(
        ledger.entries,
        Resource(ResourceKind.RUN_DATABASE, run_database_name(run.run_id)),
    )
    _require_created_run_resource(
        ledger.entries,
        Resource(ResourceKind.BUCKET, expected_bucket),
    )
    if (
        run.database_url != expected_database_url
        or run.migration_database_url != expected_migration_url
        or run.bucket != expected_bucket
        or run.supabase.url != expected_supabase_url
    ):
        raise RuntimeContractError(
            "child process resources do not match the exact persisted local test run"
        )
    values = {
        "APP_PUBLIC_URL": runtime_endpoint(root, environment, EndpointKind.WEB),
        "CSP_MEDIA_ORIGINS": runtime_endpoint(root, environment, EndpointKind.EXTERNAL),
        "DATABASE_URL": expected_database_url,
        "FASTAPI_BASE_URL": runtime_endpoint(root, environment, EndpointKind.API),
        "NEXT_PUBLIC_SUPABASE_ANON_KEY": run.supabase.anon_key,
        "NEXT_PUBLIC_SUPABASE_URL": expected_supabase_url,
        "NEXUS_EXTENSION_REDIRECT_ORIGINS": f"https://{TEST_EXTENSION_ID}.chromiumapp.org",
        "NEXUS_ENV": "test",
        "NEXUS_INTERNAL_SECRET": "nexus-test-internal-secret",
        "NEXUS_RUNTIME_IDENTITY_FILE": str(_runtime_identity_path(root)),
        "NEXUS_TEST_RUN_ID": run.run_id,
        "PARSER_TEMP_ROOT": str(root / "test-results" / "runs" / run.run_id / "parser-tmp"),
        "OPENAI_API_KEY": "nexus-test-fixture-openai-key",
        "R2_ACCESS_KEY_ID": MINIO_ACCESS_KEY,
        "R2_BUCKET": expected_bucket,
        "R2_REGION": MINIO_REGION,
        "R2_S3_API_ORIGIN": runtime_endpoint(root, environment, EndpointKind.MINIO),
        "R2_SECRET_ACCESS_KEY": MINIO_SECRET_KEY,
        "STREAM_BASE_URL": runtime_endpoint(root, environment, EndpointKind.API),
        "STREAM_CORS_ORIGINS": runtime_endpoint(root, environment, EndpointKind.WEB),
        "SUPABASE_AUDIENCES": "authenticated",
        "SUPABASE_ISSUER": f"{expected_supabase_url}/auth/v1",
        "SUPABASE_JWKS_URL": f"{expected_supabase_url}/auth/v1/.well-known/jwks.json",
    }
    if expected_migration_url is not None:
        values["NEXUS_MIGRATION_DATABASE_URL"] = expected_migration_url
    return values


def _expected_migration_database_url(
    repo_root: Path,
    environment: Mapping[str, str],
    run_id: str,
    entries: Sequence[LedgerEntry],
) -> str | None:
    migration = Resource(ResourceKind.MIGRATION_DATABASE, migration_database_name(run_id))
    matching = [entry for entry in entries if entry.resource == migration]
    if not matching:
        return None
    _require_created_run_resource(entries, migration)
    return _database_url(repo_root, environment, migration.identity)


def _require_created_run_resource(entries: Sequence[LedgerEntry], resource: Resource) -> None:
    for entry in entries:
        if entry.resource == resource:
            if entry.phase is not ResourcePhase.CREATED:
                raise RuntimeContractError(
                    f"child process resource is not durably created: {resource.kind.value}"
                )
            return
    raise RuntimeContractError(
        f"child process resource is absent from the exact run ledger: {resource.kind.value}"
    )


def new_run_id() -> str:
    return secrets.token_hex(8)


_ANDROID_TOOL_ENV = (
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
    "GRADLE_USER_HOME",
    "HOME",
    "JAVA_HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "TMPDIR",
    "TZ",
)


def android_tool_environment(environment: Mapping[str, str]) -> dict[str, str]:
    """The safe child environment for owned adb/Gradle subprocesses."""
    child = {key: value for key in _ANDROID_TOOL_ENV if (value := environment.get(key))}
    child["NEXUS_ENV"] = "test"
    return child


def resolve_adb(environment: Mapping[str, str]) -> Path | None:
    """Resolve the one adb transport from the SDK or PATH, without inventing another."""
    sdk = environment.get("ANDROID_HOME") or environment.get("ANDROID_SDK_ROOT")
    if sdk:
        candidate = Path(sdk) / "platform-tools/adb"
        if candidate.is_file():
            return candidate
    found = shutil.which("adb", path=environment.get("PATH"))
    return Path(found) if found else None


def authorized_device_serials(
    adb: Path, environment: Mapping[str, str], cwd: Path
) -> tuple[str, ...] | None:
    """The one `adb devices` parse. ``None`` means the inventory could not be read;
    ``()`` means no authorized device; otherwise the authorized serials."""
    try:
        listed = run_command(
            (str(adb), "devices"),
            cwd=cwd,
            env=android_tool_environment(environment),
            capture_output=True,
            check=False,
        )
    except OSError:
        return None
    if listed.returncode != 0:
        return None
    return tuple(
        line.split("\t", 1)[0]
        for line in listed.stdout.splitlines()[1:]
        if line.endswith("\tdevice")
    )


_MAX_ADB_DEVICE_ROW_CHARS = 8_192
_MAX_ADB_INVENTORY_BYTES = 32 * 1024


@dataclass(frozen=True, slots=True)
class AuthorizedAndroidDevice:
    serial: str
    adb_devices_row: str


@dataclass(frozen=True, slots=True)
class _LongDeviceRow:
    raw: str
    fields: tuple[str, ...]


def _long_device_inventory(
    adb: Path, environment: Mapping[str, str], cwd: Path
) -> tuple[_LongDeviceRow, ...] | None:
    """The one bounded `adb devices -l` parse, retaining each exact device row."""
    try:
        listed = run_command(
            (str(adb), "devices", "-l"),
            cwd=cwd,
            env=android_tool_environment(environment),
            capture_output=True,
            check=False,
        )
    except OSError:
        return None
    if listed.returncode != 0:
        return None
    # `run_command` retains the final 64 KiB. Staying below half that bound
    # proves this is a complete inventory, not a tail that lost the header or
    # an earlier authorized candidate.
    if len(listed.stdout.encode("utf-8")) > _MAX_ADB_INVENTORY_BYTES:
        return None
    lines = listed.stdout.splitlines()
    if not lines or lines[0] != "List of devices attached":
        return None
    rows: list[_LongDeviceRow] = []
    for line in lines[1:]:
        if len(line) > _MAX_ADB_DEVICE_ROW_CHARS:
            return None
        fields = tuple(line.split())
        if len(fields) < 2 or fields[1] != "device":
            continue
        rows.append(_LongDeviceRow(line, fields))
    return tuple(rows)


def _is_usb_physical_row(fields: Sequence[str]) -> bool:
    if fields[0].startswith("emulator-"):
        return False
    return any(field.startswith("usb:") and len(field) > 4 for field in fields[2:])


def authorized_usb_physical_device(
    adb: Path, environment: Mapping[str, str], cwd: Path
) -> tuple[AuthorizedAndroidDevice | None, str]:
    """Attest the one USB-backed physical device used by protected device proof.

    Emulators and wireless adb transports remain distinct lanes and cannot
    satisfy this boundary. Other authorized transports may coexist, but exactly
    one physical row must carry adb's ``usb:`` topology fact.
    """
    rows = _long_device_inventory(adb, environment, cwd)
    if rows is None:
        return None, "Android USB device inventory could not be read"
    candidates = [row for row in rows if _is_usb_physical_row(row.fields)]
    if not candidates:
        return None, "no authorized USB-backed physical Android device is attached"
    if len(candidates) != 1:
        return None, "Android device proof requires exactly one USB-backed physical device"
    selected = candidates[0]
    return AuthorizedAndroidDevice(selected.fields[0], selected.raw), ""


def authorized_instrumentation_device(
    adb: Path, environment: Mapping[str, str], cwd: Path
) -> tuple[AuthorizedAndroidDevice | None, str]:
    """Attest the one device the ordinary `android-device` capability may drive.

    Hosted nightly infrastructure supplies a locally started emulator; the
    protected lab supplies a USB-wired handset. Either is an owned, physically
    reachable transport whose serial the controller can bind. A wireless adb
    transport is neither: it names a host and port the controller does not own,
    so it can never satisfy this capability.
    """
    rows = _long_device_inventory(adb, environment, cwd)
    if rows is None:
        return None, "Android device inventory could not be read"
    candidates = [
        row
        for row in rows
        if row.fields[0].startswith("emulator-") or _is_usb_physical_row(row.fields)
    ]
    if not candidates:
        return None, "no authorized local emulator or USB-backed Android device is attached"
    if len(candidates) != 1:
        return None, "Android device proof requires exactly one local emulator or USB device"
    selected = candidates[0]
    return AuthorizedAndroidDevice(selected.fields[0], selected.raw), ""


def test_environment(caller_environment: Mapping[str, str]) -> dict[str, str]:
    nexus_environment = caller_environment.get("NEXUS_ENV")
    if nexus_environment not in {None, "", "test"}:
        raise RuntimeContractError("test control rejects a non-test NEXUS_ENV")
    supplied = sorted(key for key in _CALLER_RESOURCE_ENV if caller_environment.get(key))
    if supplied:
        raise RuntimeContractError(
            "test control does not accept caller resource configuration: " + ", ".join(supplied)
        )
    caller_docker_host = caller_environment.get("DOCKER_HOST")
    if caller_docker_host and caller_docker_host != local_docker_host():
        raise RuntimeContractError("test control rejects a non-local Docker host")
    caller_docker_context = caller_environment.get("DOCKER_CONTEXT")
    if caller_docker_context not in {None, "", "default"}:
        raise RuntimeContractError("test control rejects a non-default Docker context")
    return {"NEXUS_ENV": "test"}


def ensure_services(repo_root: Path, environment: Mapping[str, str]) -> SupabaseCredentials:
    """Start or reuse the one local-only infrastructure stack for this workspace."""
    require_test_environment(environment)
    root = canonical_repo_root(repo_root)
    with _workspace_service_lock(root):
        if not runtime_record_path(root).exists():
            with _port_allocation_lock():
                initialize_runtime(root, environment, _allocate_ports())
                _start_services(root)
        else:
            _upgrade_previous_runtime_if_needed(root, environment)
            _start_services(root)
        _publish_runtime_identity(root)
    return read_supabase_credentials(root, environment)


def _runtime_identity_path(root: Path) -> Path:
    return runtime_state_dir(root) / "runtime-identity.json"


def _publish_runtime_identity(root: Path) -> None:
    completed = _run(
        ("git", "rev-parse", "HEAD"),
        cwd=root,
        capture_output=True,
    )
    source_sha = completed.stdout.strip()
    identity = build_runtime_identity(root, source_sha)
    path = _runtime_identity_path(root)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.partial")
    try:
        write_runtime_identity_value(identity, temporary)
        with temporary.open("rb") as stream:
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def _start_services(root: Path) -> None:
    runtime = read_runtime(root)
    _run(
        (
            "docker",
            "compose",
            "--project-name",
            runtime.compose_project,
            "--file",
            str(root / "docker" / "docker-compose.test.yml"),
            "up",
            "--detach",
            "--wait",
        ),
        cwd=root,
        environment={
            "POSTGRES_PORT": str(runtime.ports.postgres),
            "MINIO_PORT": str(runtime.ports.minio),
            "MINIO_API_CORS_ALLOW_ORIGIN": (
                f"http://127.0.0.1:{runtime.ports.web},http://localhost:{runtime.ports.web}"
            ),
        },
    )
    _wait_minio(f"http://127.0.0.1:{runtime.ports.minio}/minio/health/ready")
    _write_supabase_config(root)
    start_command = (
        "supabase",
        "--workdir",
        runtime.supabase_workdir,
        "start",
        "--exclude",
        SUPABASE_EXCLUDED_SERVICES,
    )
    try:
        _run(start_command, cwd=root, capture_output=True)
    except subprocess.CalledProcessError as error:
        raise RuntimeContractError(_supabase_start_failure(root, runtime, error)) from error


def _supabase_start_failure(
    root: Path,
    runtime: RuntimeRecord,
    error: subprocess.CalledProcessError,
) -> str:
    try:
        containers = _run(
            (
                "docker",
                "ps",
                "--all",
                "--filter",
                f"label=com.supabase.cli.project={runtime.compose_project}",
                "--format",
                "{{.Names}}\t{{.Status}}\t{{.Image}}",
            ),
            cwd=root,
            capture_output=True,
        ).stdout
    except (subprocess.CalledProcessError, RuntimeContractError) as diagnostic_error:
        containers = (
            f"<container inspection failed: {_redact_supabase_output(str(diagnostic_error))}>"
        )
    return _supabase_start_failure_message(error, containers)


def _supabase_start_failure_message(
    error: subprocess.CalledProcessError,
    containers: str | None,
) -> str:
    container_state = (containers or "").strip() or "<no Supabase containers found>"
    return "\n".join(
        (
            "local Supabase failed to start",
            f"supabase stdout:\n{_redact_supabase_output(error.stdout)}",
            f"supabase stderr:\n{_redact_supabase_output(error.stderr)}",
            f"Supabase container states:\n{_redact_supabase_output(container_state)}",
        )
    )


def _redact_supabase_output(output: str | None) -> str:
    if not output:
        return "<empty>"
    redacted = re.sub(
        r"\beyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b",
        "[REDACTED_JWT]",
        output,
    )
    redacted = re.sub(
        r"(?i)([\"']?(?:anon[_ -]?key|publishable[_ -]?key|service[_ -]?role[_ -]?key|jwt[_ -]?secret|secret[_ -]?key|db[_ -]?url|password|access[_ -]?token)[\"']?\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,}]+)",
        r"\1[REDACTED]",
        redacted,
    )
    redacted = re.sub(
        r"(?i)(postgres(?:ql)?://[^:\s]+:)[^@\s]+(@)",
        r"\1[REDACTED]\2",
        redacted,
    )
    if len(redacted) > _SUPABASE_DIAGNOSTIC_TAIL_CHARS:
        redacted = "…" + redacted[-_SUPABASE_DIAGNOSTIC_TAIL_CHARS:]
    return redacted.strip() or "<empty>"


def read_supabase_credentials(
    repo_root: Path, environment: Mapping[str, str]
) -> SupabaseCredentials:
    require_test_environment(environment)
    root = canonical_repo_root(repo_root)
    runtime = read_runtime(root)
    completed = _run(
        (
            "supabase",
            "--workdir",
            runtime.supabase_workdir,
            "status",
            "--output",
            "json",
        ),
        cwd=root,
        capture_output=True,
    )
    status = _parse_supabase_status(completed.stdout)
    expected_url = runtime_endpoint(root, environment, EndpointKind.SUPABASE)
    return _supabase_credentials_from_status(status, expected_url)


def _supabase_credentials_from_status(
    status: Mapping[str, str], expected_url: str
) -> SupabaseCredentials:
    """Bind CLI credentials to the controller-owned endpoint.

    Supabase CLI omits API_URL when PostgREST is excluded, even though Kong and
    Auth are running on the configured API port.  The runtime record remains the
    endpoint authority; a CLI-reported URL, when present, must agree exactly.
    """
    reported_url = status.get("API_URL")
    anon_key = status.get("ANON_KEY") or status.get("PUBLISHABLE_KEY")
    admin_key = status.get("SECRET_KEY") or status.get("SERVICE_ROLE_KEY")
    if (
        (reported_url is not None and reported_url != expected_url)
        or not isinstance(anon_key, str)
        or not isinstance(admin_key, str)
    ):
        raise RuntimeContractError("local Supabase status does not match the recorded runtime")
    return SupabaseCredentials(expected_url, anon_key, admin_key)


def prepare_run(
    repo_root: Path,
    environment: Mapping[str, str],
    *,
    run_id: str,
    include_migration_database: bool = False,
) -> TestRun:
    require_test_environment(environment)
    require_run_id(run_id)
    root = canonical_repo_root(repo_root)
    supabase = ensure_services(root, environment)
    claim_run(root, environment, run_id)
    try:
        with run_lifecycle_lock(root, environment, run_id):
            fingerprint = _repository_template_fingerprint(root)
            with template_lifecycle_lock(root, environment, fingerprint):
                _ensure_template_locked(root, environment, run_id, fingerprint)
                _create_database(
                    root,
                    environment,
                    run_id,
                    Resource(ResourceKind.RUN_DATABASE, run_database_name(run_id)),
                    template_database_name(fingerprint),
                )
            if include_migration_database:
                _create_database(
                    root,
                    environment,
                    run_id,
                    Resource(ResourceKind.MIGRATION_DATABASE, migration_database_name(run_id)),
                    "template0",
                )
            _create_bucket(root, environment, run_id)
    except BaseException:
        clean_run(root, environment, run_id, supabase=supabase)
        raise
    return TestRun(
        run_id=run_id,
        database_url=_database_url(root, environment, run_database_name(run_id)),
        migration_database_url=(
            _database_url(root, environment, migration_database_name(run_id))
            if include_migration_database
            else None
        ),
        bucket=run_bucket_name(run_id),
        supabase=supabase,
    )


def create_supabase_user(
    repo_root: Path,
    environment: Mapping[str, str],
    run_id: str,
    scenario_id: str,
    credentials: SupabaseCredentials,
) -> TestUser:
    require_test_environment(environment)
    require_scenario_id(scenario_id)
    root = canonical_repo_root(repo_root)
    expected_url = runtime_endpoint(root, environment, EndpointKind.SUPABASE)
    if credentials.url != expected_url:
        raise RuntimeContractError("Supabase credentials are not for the recorded runtime")
    email = supabase_user_email(run_id, scenario_id)
    password = f"Nexus-test-{run_id}-{scenario_id}!"
    user_id = str(uuid4())
    resource = Resource(ResourceKind.SUPABASE_USER, email)
    record_planned(
        root,
        environment,
        run_id,
        resource,
        scenario_id=scenario_id,
        external_id=user_id,
    )
    with httpx.Client(trust_env=False, timeout=15) as client:
        response = client.post(
            f"{expected_url}/auth/v1/admin/users",
            headers=_supabase_admin_headers(credentials.admin_key),
            json={
                "id": user_id,
                "email": email,
                "password": password,
                "email_confirm": True,
                "user_metadata": supabase_user_metadata(run_id, scenario_id),
            },
        )
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, dict) or payload.get("id") != user_id:
        raise RuntimeContractError("Supabase admin create returned the wrong user id")
    record_created(root, environment, run_id, resource, external_id=user_id)
    return TestUser(user_id, email, password)


def invite_supabase_user(
    repo_root: Path,
    environment: Mapping[str, str],
    run_id: str,
    scenario_id: str,
    credentials: SupabaseCredentials,
) -> InvitedTestUser:
    require_test_environment(environment)
    require_scenario_id(scenario_id)
    root = canonical_repo_root(repo_root)
    expected_url = runtime_endpoint(root, environment, EndpointKind.SUPABASE)
    if credentials.url != expected_url:
        raise RuntimeContractError("Supabase credentials are not for the recorded runtime")
    email = supabase_user_email(run_id, scenario_id)
    resource = Resource(ResourceKind.SUPABASE_USER, email)
    record_planned(root, environment, run_id, resource, scenario_id=scenario_id)
    with httpx.Client(trust_env=False, timeout=15) as client:
        response = client.post(
            f"{expected_url}/auth/v1/invite",
            headers=_supabase_admin_headers(credentials.admin_key),
            json={"email": email, "data": supabase_user_metadata(run_id, scenario_id)},
        )
        response.raise_for_status()
        payload = response.json()
    user_id = payload.get("id") if isinstance(payload, dict) else None
    if not isinstance(user_id, str) or payload.get("email") != email:
        raise RuntimeContractError("Supabase admin invite returned the wrong user")
    record_created(root, environment, run_id, resource, external_id=user_id)
    return InvitedTestUser(email)


def grant_scenario_ai_entitlement(
    repo_root: Path,
    environment: Mapping[str, str],
    run: TestRun,
    user: TestUser,
) -> None:
    """Bootstrap one scenario user and grant deterministic chat capacity."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    from nexus.services.billing_entitlements import grant_entitlement_override
    from nexus.services.bootstrap import ensure_user_and_default_library

    require_test_environment(environment)
    root = canonical_repo_root(repo_root)
    if run.database_url != _database_url(root, environment, run_database_name(run.run_id)):
        raise RuntimeContractError("AI entitlement database does not belong to the exact test run")
    expected_email_prefix = f"nexus+{run.run_id}+"
    if not user.email.startswith(expected_email_prefix) or not user.email.endswith(
        "@example.invalid"
    ):
        raise RuntimeContractError("AI entitlement user does not belong to the exact test run")
    try:
        user_id = UUID(user.id)
    except ValueError as error:
        raise RuntimeContractError("AI entitlement user id is not a UUID") from error
    if str(user_id) != user.id or user_id.version != 4:
        raise RuntimeContractError("AI entitlement user id is not a canonical UUIDv4")
    engine = create_engine(run.database_url)
    try:
        with Session(engine) as db:
            ensure_user_and_default_library(db, user_id, user.email)
            grant_entitlement_override(
                db,
                user_id=user_id,
                plan_tier="ai_pro",
                platform_token_quota_mode="unlimited",
                platform_token_limit_monthly=None,
                transcription_quota_mode="unlimited",
                transcription_minutes_limit_monthly=None,
                expires_at=None,
                reason="deterministic journey chat entitlement",
                actor_label="nexus-test-control",
            )
    finally:
        engine.dispose()


# The background worker lane's readiness contract is a real cgroup v2 memory limit
# with `memory.oom.group=0` (document-import-reliability-hard-cutover.md §7), and
# §10 requires the proof lane to actually be cgroup-capable. A rootless systemd user
# manager is what delegates one, so its absence is a host-provisioning fault with one
# exact repair. CI provisions it in `.github/actions/setup-test`, which fails with
# this same text, and `./scripts/test doctor` reports it before any proof runs.
CGROUP_DELEGATE_DIAGNOSTIC = (
    "The background worker proof requires a rootless systemd user manager that "
    "delegates a cgroup v2 memory controller. Provision it with: "
    'sudo loginctl enable-linger "$(id -un)"; '
    "export XDG_RUNTIME_DIR=/run/user/$(id -u) "
    "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus; "
    "then confirm that "
    f"`systemd-run --user --scope -p MemoryMax={BACKGROUND_WORKER_MEMORY_LIMIT_BYTES} true` "
    "succeeds and that the scope cgroup exposes memory.max and memory.oom.group."
)
_CGROUP_DELEGATE_PROBE_TIMEOUT_SECONDS = 30.0
_CGROUP_DELEGATE_PROBE_SCRIPT = f"""
set -eu
cgroup="/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)"
test "$(cat "$cgroup/memory.max")" = "{BACKGROUND_WORKER_MEMORY_LIMIT_BYTES}"
test "$(cat "$cgroup/memory.oom.group")" = "0"
grep -qw memory "$cgroup/cgroup.controllers"
"""


def user_systemd_environment() -> dict[str, str]:
    """Address the caller's own rootless systemd user manager."""
    user_runtime_directory = f"/run/user/{os.getuid()}"
    return {
        "XDG_RUNTIME_DIR": user_runtime_directory,
        "DBUS_SESSION_BUS_ADDRESS": f"unix:path={user_runtime_directory}/bus",
    }


def _require_cgroup_delegate() -> str:
    """Return the systemd-run path, or refuse with the one shared diagnostic."""
    systemd_run = shutil.which("systemd-run")
    if systemd_run is None or not Path(f"/run/user/{os.getuid()}/bus").is_socket():
        raise RuntimeContractError(CGROUP_DELEGATE_DIAGNOSTIC)
    return systemd_run


def cgroup_delegate_failure() -> str | None:
    """Probe the real delegate and return the shared diagnostic when it is unusable.

    This runs the exact `systemd-run --user --scope` shape the background worker lane
    launches with and reads the resulting cgroup, so a manager that exists but cannot
    delegate the memory controller is reported before any proof depends on it.
    """
    try:
        systemd_run = _require_cgroup_delegate()
    except RuntimeContractError:
        return CGROUP_DELEGATE_DIAGNOSTIC
    try:
        probe = subprocess.run(
            (
                systemd_run,
                "--user",
                "--scope",
                "--quiet",
                "--collect",
                f"--unit=nexus-cgroup-delegate-{uuid4().hex[:16]}",
                "-p",
                f"MemoryMax={BACKGROUND_WORKER_MEMORY_LIMIT_BYTES}",
                "-p",
                "MemorySwapMax=0",
                "-p",
                "OOMPolicy=continue",
                "/bin/sh",
                "-c",
                _CGROUP_DELEGATE_PROBE_SCRIPT,
            ),
            env={**os.environ, **user_systemd_environment()},
            capture_output=True,
            text=True,
            timeout=_CGROUP_DELEGATE_PROBE_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return CGROUP_DELEGATE_DIAGNOSTIC
    if probe.returncode != 0:
        return CGROUP_DELEGATE_DIAGNOSTIC
    return None


def start_python_process(
    repo_root: Path,
    environment: Mapping[str, str],
    run: TestRun,
    role: str,
    *,
    overrides: Mapping[str, str] | None = None,
) -> StartedProcess:
    require_test_environment(environment)
    root = canonical_repo_root(repo_root)
    runtime = read_runtime(root)
    if role == "external":
        _require_loopback_port_available(runtime.ports.external, role)
        command = (
            str(root / "python/.venv/bin/python"),
            str(root / "python/tests/testkit/external_server.py"),
            "--port",
            str(runtime.ports.external),
            "--fixture-root",
            str(root / "python/tests/fixtures/real_media"),
        )
    elif role == "provider-openai":
        _require_loopback_port_available(runtime.ports.provider_openai, role)
        values = _owned_provider_fixture_paths(root, run.run_id, overrides)
        command = (
            str(root / "python/.venv/bin/python"),
            str(root / "python/tests/testkit/openai_embedding_server.py"),
            "--port",
            str(runtime.ports.provider_openai),
            "--certificate",
            str(values["NEXUS_TEST_OPENAI_CERTIFICATE"]),
            "--key",
            str(values["NEXUS_TEST_OPENAI_KEY"]),
            "--audit",
            str(values["NEXUS_TEST_OPENAI_AUDIT"]),
        )
    elif role == "api":
        _require_loopback_port_available(runtime.ports.api, role)
        command = (
            str(root / "python/.venv/bin/python"),
            "-m",
            "uvicorn",
            "apps.api.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(runtime.ports.api),
        )
    elif role in {"worker-interactive", "worker-background"}:
        command = (
            str(root / "python/.venv/bin/python"),
            "-m",
            "apps.worker.main",
        )
        if role == "worker-background":
            systemd_run = _require_cgroup_delegate()
            command = (
                systemd_run,
                "--user",
                "--scope",
                "--quiet",
                "--collect",
                "-p",
                f"MemoryMax={BACKGROUND_WORKER_MEMORY_LIMIT_BYTES}",
                "-p",
                "MemorySwapMax=0",
                "-p",
                "OOMPolicy=continue",
                *command,
            )
    else:
        raise RuntimeContractError(f"Python process role is not owned: {role}")
    process_environment = {
        **run_environment(root, environment, run),
        "NEXUS_TEST_DENY_EXTERNAL_NETWORK": "1",
        "NEXUS_TEST_STATIC_DNS": '{"www.nasa.gov":"93.184.216.34"}',
        "NODE_OPTIONS": f"--import={root / 'python/tests/testkit/node-network-guard.mjs'}",
        "OPENAI_API_KEY": "nexus-test-fixture-openai-key",
        "OUTBOUND_HTTP_PROXY_URL": f"http://127.0.0.1:{runtime.ports.external}",
        "PODCAST_INDEX_API_KEY": "nexus-test-fixture-podcast-key",
        "PODCAST_INDEX_API_SECRET": "nexus-test-fixture-podcast-secret",
        "PODCAST_INDEX_BASE_URL": f"http://127.0.0.1:{runtime.ports.external}",
        "PYTHONPATH": f"{root / 'python' / 'tests' / 'testkit'}:{root / 'python'}:{root}",
        **({"WORKER_LANE": role.removeprefix("worker-")} if role.startswith("worker-") else {}),
        **(user_systemd_environment() if role == "worker-background" else {}),
        **(overrides or {}),
    }
    return _start_owned_process(
        root,
        environment,
        run.run_id,
        role,
        command,
        cwd=root,
        process_environment=process_environment,
    )


def prepare_openai_provider_fixture(
    repo_root: Path,
    environment: Mapping[str, str],
    run: TestRun,
) -> OpenAIProviderFixture:
    """Create the exact canonical-provider state owned by one persisted run."""
    require_test_environment(environment)
    root = canonical_repo_root(repo_root)
    runtime = read_runtime(root)
    if run.run_id not in runtime.owned_run_ids:
        raise RuntimeContractError("OpenAI provider fixture requires an owned run")
    resource = Resource(ResourceKind.PROVIDER_FIXTURE, provider_fixture_identity(run.run_id))
    state = root / resource.identity
    record_planned(root, environment, run.run_id, resource)
    try:
        state.mkdir(parents=False, exist_ok=False)
    except FileExistsError as error:
        forget_cleaned(root, environment, run.run_id, resource)
        raise RuntimeContractError("OpenAI provider fixture already exists for this run") from error
    certificate = state / "ca.pem"
    key_path = state / "server-key.pem"
    audit = state / "requests.jsonl"
    try:
        audit.touch(mode=0o600, exist_ok=False)
        _write_openai_test_certificate(certificate, key_path)
        record_created(root, environment, run.run_id, resource)
    except Exception:
        raise
    return OpenAIProviderFixture(
        state=state,
        certificate=certificate,
        key=key_path,
        audit=audit,
        port=runtime.ports.provider_openai,
    )


def _write_openai_test_certificate(certificate: Path, key_path: Path) -> None:
    host = "api.openai.com"
    key = rsa.generate_private_key(public_exponent=65_537, key_size=2048)
    now = datetime.now(UTC)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)])
    value = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.DNSName(host), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
            ),
            critical=False,
        )
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    certificate.write_bytes(value.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    key_path.chmod(0o600)


def _clean_openai_provider_fixture(root: Path, identity: str) -> None:
    state = root / identity
    if not state.exists():
        return
    if state.is_symlink() or not state.is_dir():
        raise RuntimeContractError("OpenAI provider fixture state is not an owned directory")
    expected = {"ca.pem", "server-key.pem", "requests.jsonl"}
    entries = {entry.name for entry in state.iterdir()}
    if not entries.issubset(expected) or any(not (state / name).is_file() for name in entries):
        raise RuntimeContractError("OpenAI provider fixture state has unexpected contents")
    shutil.rmtree(state)


def release_openai_provider_fixture(
    repo_root: Path,
    environment: Mapping[str, str],
    run_id: str,
) -> None:
    """Release an idle exact provider fixture between workflow capabilities."""
    require_test_environment(environment)
    root = canonical_repo_root(repo_root)
    with run_lifecycle_lock(root, environment, run_id):
        ledger = read_ledger(root, run_id)
        process = Resource(
            ResourceKind.PROCESS, process_resource_identity(run_id, "provider-openai")
        )
        if any(entry.resource == process for entry in ledger.entries):
            raise RuntimeContractError(
                "OpenAI provider fixture cannot release while its process exists"
            )
        resource = Resource(ResourceKind.PROVIDER_FIXTURE, provider_fixture_identity(run_id))
        matches = [entry for entry in ledger.entries if entry.resource == resource]
        if len(matches) != 1:
            raise RuntimeContractError("OpenAI provider fixture is not uniquely owned by this run")
        _clean_openai_provider_fixture(root, resource.identity)
        forget_cleaned(root, environment, run_id, resource)


def _owned_provider_fixture_paths(
    root: Path,
    run_id: str,
    overrides: Mapping[str, str] | None,
) -> dict[str, Path]:
    names = {
        "NEXUS_TEST_OPENAI_CERTIFICATE",
        "NEXUS_TEST_OPENAI_KEY",
        "NEXUS_TEST_OPENAI_AUDIT",
    }
    if overrides is None or not names.issubset(overrides):
        raise RuntimeContractError("OpenAI provider process requires its owned fixture paths")
    owned_root = (runtime_state_dir(root) / "runs" / run_id).resolve(strict=True)
    fixture_resource = Resource(ResourceKind.PROVIDER_FIXTURE, provider_fixture_identity(run_id))
    fixture_entries = [
        entry for entry in read_ledger(root, run_id).entries if entry.resource == fixture_resource
    ]
    if len(fixture_entries) != 1 or fixture_entries[0].phase is not ResourcePhase.CREATED:
        raise RuntimeContractError("OpenAI provider process requires its created fixture owner")
    values: dict[str, Path] = {}
    for name in names:
        path = Path(overrides[name]).resolve(strict=True)
        if owned_root not in path.parents or not path.is_file():
            raise RuntimeContractError("OpenAI provider fixture path is outside the exact run")
        values[name] = path
    return values


def start_web_process(
    repo_root: Path,
    environment: Mapping[str, str],
    run: TestRun,
    build: StandaloneBuild,
    *,
    overrides: Mapping[str, str] | None = None,
) -> StartedProcess:
    """Start the one ledger-owned standalone web artifact for a journey capability."""
    require_test_environment(environment)
    root = canonical_repo_root(repo_root)
    artifact_root = build.root.resolve(strict=True)
    server = build.server.resolve(strict=True)
    expected_builds = (runtime_state_dir(root) / "builds").resolve(strict=True)
    if expected_builds not in artifact_root.parents or artifact_root not in server.parents:
        raise RuntimeContractError("web process requires a runtime-owned standalone artifact")
    runtime = read_runtime(root)
    _require_loopback_port_available(runtime.ports.web, "web")
    owned_environment = run_environment(root, environment, run)
    try:
        source_sha = load_runtime_identity(_runtime_identity_path(root)).source_sha
    except BackendArtifactDefect as exc:
        raise RuntimeContractError("web process requires the exact runtime identity") from exc
    return _start_owned_process(
        root,
        environment,
        run.run_id,
        "web",
        ("node", str(server)),
        cwd=server.parent,
        process_environment={
            **owned_environment,
            "HOSTNAME": "127.0.0.1",
            "NODE_OPTIONS": f"--import={root / 'python/tests/testkit/node-network-guard.mjs'}",
            "NODE_ENV": "production",
            "PORT": str(runtime.ports.web),
            "VERCEL_GIT_COMMIT_SHA": source_sha,
            **(overrides or {}),
        },
    )


@dataclass(frozen=True, slots=True)
class OfflineReadingCaddyPorts:
    """Run-scoped controller-owned loopback ports for the Caddy seam proof.

    The seam proof never binds the runtime's fixed api/web ports: those are
    owned by the real API and web processes, which other capabilities in the
    same selection may start concurrently.
    """

    origin: int
    site: int


_OFFLINE_READING_CADDY_PREFERRED_PORTS = (18300, 18560)


def _offline_reading_caddy_output_root(root: Path, run_id: str) -> Path:
    return root / "test-results" / "runs" / run_id / "offline-reading-caddy"


def _offline_reading_caddy_ports_path(root: Path, run_id: str) -> Path:
    return _offline_reading_caddy_output_root(root, run_id) / "ports.json"


def _read_offline_reading_caddy_ports(path: Path) -> OfflineReadingCaddyPorts:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RuntimeContractError("offline-reading Caddy ports file is unreadable") from error
    if not isinstance(payload, dict) or set(payload) != {"origin", "site"}:
        raise RuntimeContractError("offline-reading Caddy ports file has an invalid shape")
    origin, site = payload["origin"], payload["site"]
    if not all(
        isinstance(port, int) and not isinstance(port, bool) and 1 <= port <= 65535
        for port in (origin, site)
    ):
        raise RuntimeContractError("offline-reading Caddy ports are outside TCP port bounds")
    if origin == site:
        raise RuntimeContractError("offline-reading Caddy ports must be distinct")
    return OfflineReadingCaddyPorts(origin=origin, site=site)


def _ensure_offline_reading_caddy_ports(root: Path, run_id: str) -> OfflineReadingCaddyPorts:
    path = _offline_reading_caddy_ports_path(root, run_id)
    with _port_allocation_lock():
        if path.exists():
            return _read_offline_reading_caddy_ports(path)
        reserved = set(read_runtime(root).ports.as_dict().values())
        ephemeral_port_range = _local_ephemeral_port_range()
        chosen: list[int] = []
        for preferred in _OFFLINE_READING_CADDY_PREFERRED_PORTS:
            for port in _candidate_ports(preferred, ephemeral_port_range):
                if port not in reserved and port not in chosen and _port_available(port):
                    chosen.append(port)
                    break
            else:
                raise RuntimeContractError(
                    f"no controller-owned loopback port is available from {preferred}"
                )
        ports = OfflineReadingCaddyPorts(origin=chosen[0], site=chosen[1])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"origin": ports.origin, "site": ports.site}), encoding="utf-8")
        return ports


def offline_reading_caddy_ports(
    repo_root: Path,
    environment: Mapping[str, str],
    run_id: str,
) -> OfflineReadingCaddyPorts:
    """Read the run's allocated Caddy seam ports; the origin process allocates them."""
    require_test_environment(environment)
    root = canonical_repo_root(repo_root)
    require_run_id(run_id)
    path = _offline_reading_caddy_ports_path(root, run_id)
    if not path.exists():
        raise RuntimeContractError("offline-reading Caddy ports are not allocated for this run")
    return _read_offline_reading_caddy_ports(path)


def start_offline_reading_caddy_origin_process(
    repo_root: Path,
    environment: Mapping[str, str],
    run_id: str,
) -> StartedProcess:
    """Start the ledger-owned FastAPI origin used only by the Caddy seam proof."""
    require_test_environment(environment)
    root = canonical_repo_root(repo_root)
    require_run_id(run_id)
    read_ledger(root, run_id)
    ports = _ensure_offline_reading_caddy_ports(root, run_id)
    _require_loopback_port_available(ports.origin, "offline-caddy-origin")
    python = root / "python/.venv/bin/python"
    if not python.is_file():
        raise RuntimeContractError("offline-reading Caddy origin requires the locked Python env")
    output_root = _offline_reading_caddy_output_root(root, run_id)
    output_root.mkdir(parents=True, exist_ok=True)
    audit_path = output_root / "origin-audit.jsonl"
    if audit_path.exists():
        raise RuntimeContractError("offline-reading Caddy origin audit already exists")
    audit_path.touch(exist_ok=False)
    command = (
        str(python),
        str((root / "python/tests/testkit/offline_reading_caddy_origin.py").resolve(strict=True)),
        "--port",
        str(ports.origin),
        "--audit",
        str(audit_path),
    )
    return _start_owned_process(
        root,
        environment,
        run_id,
        "offline-caddy-origin",
        command,
        cwd=root,
        process_environment={
            "NEXUS_ENV": "test",
            "NEXUS_TEST_DENY_EXTERNAL_NETWORK": "1",
            "NEXUS_TEST_RUN_ID": run_id,
            "PYTHONPATH": (f"{root / 'python/tests/testkit'}:{root / 'python'}:{root}"),
        },
    )


def start_caddy_process(
    repo_root: Path,
    environment: Mapping[str, str],
    run_id: str,
) -> StartedProcess:
    """Run the production Caddyfile with only test-owned endpoint substitutions."""
    require_test_environment(environment)
    root = canonical_repo_root(repo_root)
    require_run_id(run_id)
    read_ledger(root, run_id)
    ports_path = _offline_reading_caddy_ports_path(root, run_id)
    if not ports_path.exists():
        raise RuntimeContractError("offline-reading Caddy requires its origin to start first")
    ports = _read_offline_reading_caddy_ports(ports_path)
    _require_loopback_port_available(ports.site, "offline-caddy")
    executable_name = shutil.which("caddy", path=environment.get("PATH"))
    if executable_name is None:
        raise RuntimeContractError(f"Caddy {CADDY_VERSION} is required by this proof")
    executable = Path(executable_name).resolve(strict=True)
    if not executable.is_file():
        raise RuntimeContractError("resolved Caddy executable is not a file")
    with (
        executable.open("rb") as binary,
        mmap.mmap(binary.fileno(), 0, access=mmap.ACCESS_READ) as build,
    ):
        if build.find(_CADDY_MODULE_BUILD_PIN) < 0:
            raise RuntimeContractError(f"Caddy executable is not pinned to {CADDY_VERSION}")

    production = (root / "deploy/hetzner/Caddyfile").read_text(encoding="utf-8")
    if not production.startswith("{\n") or production.count("reverse_proxy api:8000") != 2:
        raise RuntimeContractError("production Caddyfile no longer has the exact proxy shape")
    rendered = production.replace("{\n", "{\n\tadmin off\n", 1).replace(
        "reverse_proxy api:8000",
        f"reverse_proxy 127.0.0.1:{ports.origin}",
    )
    site_block = "{$CADDY_SITE} {\n"
    if rendered.count(site_block) != 1:
        raise RuntimeContractError("production Caddyfile no longer has one site block")
    rendered = rendered.replace(site_block, site_block + "\tbind 127.0.0.1\n", 1)
    output_root = _offline_reading_caddy_output_root(root, run_id)
    output_root.mkdir(parents=True, exist_ok=True)
    config_path = output_root / "Caddyfile"
    if config_path.exists():
        raise RuntimeContractError("offline-reading Caddy config already exists")
    config_path.write_text(rendered, encoding="utf-8")
    caddy_home = output_root / "home"
    command = (
        str(executable),
        "run",
        "--config",
        str(config_path),
        "--adapter",
        "caddyfile",
    )
    return _start_owned_process(
        root,
        environment,
        run_id,
        "offline-caddy",
        command,
        cwd=root,
        process_environment={
            "CADDY_ACME_EMAIL": "nexus-test@example.invalid",
            "CADDY_SITE": f"http://127.0.0.1:{ports.site}",
            "NEXUS_ENV": "test",
            "NEXUS_TEST_RUN_ID": run_id,
            "XDG_CONFIG_HOME": str(caddy_home / ".config"),
            "XDG_DATA_HOME": str(caddy_home / ".local/share"),
        },
    )


def wait_process_ready(
    repo_root: Path,
    environment: Mapping[str, str],
    process: StartedProcess,
    endpoint: EndpointKind,
    path: str,
    *,
    timeout_seconds: float = 30,
    tls_ca: Path | None = None,
) -> None:
    """Wait for an owned process at one exact recorded runtime endpoint."""
    require_test_environment(environment)
    if not path.startswith("/") or "//" in path:
        raise RuntimeContractError("process readiness path must be absolute and normalized")
    root = canonical_repo_root(repo_root)
    url = runtime_endpoint(root, environment, endpoint) + path
    port = urlsplit(url).port
    if port is None:
        raise RuntimeContractError("process readiness endpoint has no port")
    if endpoint is EndpointKind.PROVIDER_OPENAI:
        expected_ca = (
            runtime_state_dir(root) / "runs" / process.run_id / "openai-provider" / "ca.pem"
        )
        if tls_ca is None or tls_ca.resolve(strict=True) != expected_ca.resolve(strict=True):
            raise RuntimeContractError("OpenAI provider readiness requires its exact owned CA")
        verify: ssl.SSLContext | bool = ssl.create_default_context(cafile=str(expected_ca))
    elif tls_ca is not None:
        raise RuntimeContractError("TLS CA is only valid for provider readiness")
    else:
        verify = True
    _wait_owned_process_url_ready(root, process, url, port, verify, timeout_seconds)


def wait_offline_reading_caddy_ready(
    repo_root: Path,
    environment: Mapping[str, str],
    process: StartedProcess,
    path: str,
    *,
    timeout_seconds: float = 30,
) -> None:
    """Wait for a Caddy seam proof process at its run-allocated loopback port."""
    require_test_environment(environment)
    if not path.startswith("/") or "//" in path:
        raise RuntimeContractError("process readiness path must be absolute and normalized")
    root = canonical_repo_root(repo_root)
    ports = offline_reading_caddy_ports(root, environment, process.run_id)
    port = {"offline-caddy-origin": ports.origin, "offline-caddy": ports.site}.get(process.role)
    if port is None:
        raise RuntimeContractError("only Caddy seam proof processes have run-allocated ports")
    _wait_owned_process_url_ready(
        root, process, f"http://127.0.0.1:{port}{path}", port, True, timeout_seconds
    )


def _wait_owned_process_url_ready(
    root: Path,
    process: StartedProcess,
    url: str,
    port: int,
    verify: ssl.SSLContext | bool,
    timeout_seconds: float,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    identity_deadline = min(deadline, time.monotonic() + 2)
    with httpx.Client(
        trust_env=False,
        timeout=1,
        follow_redirects=False,
        verify=verify,
    ) as client:
        while time.monotonic() < deadline:
            if not _owned_process_identity_matches(
                root,
                process.process_group_id,
                process.process_start_token,
                process.run_id,
                process.owner_token,
            ):
                if _startup_identity_pending(
                    birth_matches=_process_birth_identity_matches(
                        process.process_group_id,
                        process.process_start_token,
                    ),
                    now=time.monotonic(),
                    deadline=identity_deadline,
                ):
                    time.sleep(0.01)
                    continue
                raise RuntimeContractError(
                    f"owned {process.role} process exited or changed identity before readiness"
                )
            try:
                response = client.get(url)
                if (
                    response.status_code == 200
                    and _process_group_owns_listener(process.process_group_id, port)
                    and _owned_process_identity_matches(
                        root,
                        process.process_group_id,
                        process.process_start_token,
                        process.run_id,
                        process.owner_token,
                    )
                ):
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.05)
    raise RuntimeContractError(f"owned {process.role} process did not become ready")


def _start_owned_process(
    root: Path,
    environment: Mapping[str, str],
    run_id: str,
    role: str,
    command: tuple[str, ...],
    *,
    cwd: Path,
    process_environment: Mapping[str, str],
) -> StartedProcess:
    resource = Resource(ResourceKind.PROCESS, process_resource_identity(run_id, role))
    owner_token = secrets.token_hex(16)
    record_planned(
        root,
        environment,
        run_id,
        resource,
        external_id=owner_token,
        command=command,
    )
    log_path = root / "test-results" / "runs" / run_id / f"{role}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    child_environment = _child_environment(
        {**process_environment, "NEXUS_TEST_PROCESS_OWNER": owner_token}
    )
    blocked_signals = {signal.SIGINT, signal.SIGTERM}
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, blocked_signals)
    process: subprocess.Popen[str] | None = None
    owner_descriptor: int | None = None
    owner_marker: Path | None = None
    try:
        inherited_descriptors: tuple[int, ...] = ()
        if sys.platform == "darwin":
            owner_marker = _process_owner_marker(root, run_id, owner_token)
            owner_marker.parent.mkdir(parents=True, exist_ok=True)
            owner_descriptor = os.open(
                owner_marker,
                os.O_CREAT | os.O_EXCL | os.O_RDONLY,
                0o600,
            )
            inherited_descriptors = (owner_descriptor,)
            child_environment["NEXUS_TEST_PROCESS_OWNER_FD"] = str(owner_descriptor)
        with log_path.open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                unblock_and_exec_command(command),
                cwd=cwd,
                env=child_environment,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                text=True,
                start_new_session=True,
                pass_fds=inherited_descriptors,
            )
        start_token = _process_start_token(process.pid)
        record_created(
            root,
            environment,
            run_id,
            resource,
            process_group_id=process.pid,
            process_start_token=start_token,
        )
    except BaseException:
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if owner_marker is not None:
            owner_marker.unlink(missing_ok=True)
            try:
                owner_marker.parent.rmdir()
            except OSError:
                pass
        raise
    finally:
        if owner_descriptor is not None:
            os.close(owner_descriptor)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
    return StartedProcess(
        role=role,
        process_group_id=process.pid,
        process_start_token=start_token,
        run_id=run_id,
        owner_token=owner_token,
        log_path=log_path.relative_to(root).as_posix(),
    )


def clean_run(
    repo_root: Path,
    environment: Mapping[str, str],
    run_id: str,
    *,
    supabase: SupabaseCredentials | None = None,
) -> None:
    """Delete only exact resources persisted in one run ledger, in reverse order."""
    require_test_environment(environment)
    root = canonical_repo_root(repo_root)
    with run_lifecycle_lock(root, environment, run_id):
        candidates = cleanup_candidates(root, environment, run_id)
        failures: list[Exception] = []
        for candidate in candidates:
            resource = candidate.resource
            try:
                if resource.kind is ResourceKind.PROCESS:
                    if candidate.external_id is None:
                        raise RuntimeContractError(
                            "owned process lacks its pre-recorded owner token"
                        )
                    process_group_id = candidate.process_group_id
                    process_start_token = candidate.process_start_token
                    if process_group_id is None:
                        recovered = _recover_planned_process_group(
                            root,
                            candidate.external_id,
                            run_id,
                        )
                        if recovered is not None:
                            process_group_id, process_start_token = recovered
                    if process_group_id is not None:
                        _stop_process_group(
                            root,
                            process_group_id,
                            process_start_token,
                            run_id,
                            candidate.external_id,
                        )
                    _remove_process_owner_marker(root, run_id, candidate.external_id)
                elif resource.kind is ResourceKind.TEMPLATE_BUILD:
                    if candidate.external_id is None:
                        raise RuntimeContractError("template build lacks its lifecycle fingerprint")
                    with template_lifecycle_lock(root, environment, candidate.external_id):
                        _drop_database(root, environment, resource.identity)
                elif resource.kind in {
                    ResourceKind.RUN_DATABASE,
                    ResourceKind.MIGRATION_DATABASE,
                }:
                    _drop_database(root, environment, resource.identity)
                elif resource.kind is ResourceKind.BUCKET:
                    _delete_bucket(root, environment, resource.identity)
                elif resource.kind is ResourceKind.SUPABASE_USER:
                    if supabase is None:
                        supabase = ensure_services(root, environment)
                    _delete_supabase_user(
                        root,
                        environment,
                        run_id,
                        resource.identity,
                        candidate.external_id,
                        supabase,
                    )
                elif resource.kind is ResourceKind.EXTENSION_PROFILE:
                    _delete_extension_profile(root, resource.identity)
                elif resource.kind is ResourceKind.PROVIDER_FIXTURE:
                    _clean_openai_provider_fixture(root, resource.identity)
                else:
                    raise RuntimeContractError(f"clean has no owner for {resource.kind.value}")
                forget_cleaned(root, environment, run_id, resource)
            except Exception as error:
                failures.append(
                    RuntimeContractError(
                        f"{resource.kind.value} cleanup failed for {resource.identity}: {error}"
                    )
                )
        if failures:
            raise ExceptionGroup(f"run {run_id} cleanup failed", failures)
        release_run(root, environment, run_id)


def clean_owned_runs(repo_root: Path, environment: Mapping[str, str]) -> tuple[str, ...]:
    require_test_environment(environment)
    root = canonical_repo_root(repo_root)
    if not runtime_record_path(root).exists():
        return ()
    run_ids = read_runtime(root).owned_run_ids
    failures: list[Exception] = []
    for run_id in run_ids:
        try:
            clean_run(root, environment, run_id)
        except Exception as error:
            failures.append(RuntimeContractError(f"run cleanup failed for {run_id}: {error}"))
    if failures:
        raise ExceptionGroup("owned run cleanup failed", failures)
    return run_ids


CommandRunner = Callable[..., subprocess.CompletedProcess[str]]


def clean_owned_runtime(
    repo_root: Path,
    environment: Mapping[str, str],
    *,
    command_runner: CommandRunner | None = None,
    port_available: Callable[[int], bool] | None = None,
) -> tuple[str, ...]:
    """Delete the exact recorded runs, workspace services, volumes, and state."""
    require_test_environment(environment)
    root = canonical_repo_root(repo_root)
    if not runtime_record_path(root).exists():
        return ()
    run_command = command_runner or _run
    _upgrade_previous_runtime_if_needed(root, environment, port_available=port_available)
    runtime = read_runtime(root)
    run_ids = runtime.owned_run_ids
    failures: list[str] = []
    try:
        clean_owned_runs(root, environment)
    except Exception as error:
        failures.append(f"run cleanup failed: {error}")
    supabase_config = Path(runtime.supabase_workdir) / "supabase" / "config.toml"
    if supabase_config.is_file():
        try:
            run_command(
                (
                    "supabase",
                    "--workdir",
                    runtime.supabase_workdir,
                    "stop",
                    "--project-id",
                    runtime.compose_project,
                    "--no-backup",
                    "--yes",
                ),
                cwd=root,
            )
        except Exception as error:
            failures.append(f"Supabase teardown failed: {error}")
    try:
        run_command(
            (
                "docker",
                "compose",
                "--project-name",
                runtime.compose_project,
                "--file",
                str(root / "docker" / "docker-compose.test.yml"),
                "down",
                "--volumes",
                "--remove-orphans",
            ),
            cwd=root,
        )
    except Exception as error:
        failures.append(f"Compose teardown failed: {error}")
    if failures:
        raise RuntimeContractError("; ".join(failures))
    shutil.rmtree(runtime_state_dir(root))
    return run_ids


def _allocate_ports() -> RuntimePorts:
    ports: list[int] = []
    ephemeral_port_range = _local_ephemeral_port_range()
    for preferred in _PORT_DEFAULTS:
        for port in _candidate_ports(preferred, ephemeral_port_range):
            if port not in ports and _port_available(port):
                ports.append(port)
                break
        else:
            raise RuntimeContractError(f"no local test port is available from {preferred}")
    return RuntimePorts(*ports)


def _upgrade_previous_runtime_if_needed(
    root: Path,
    environment: Mapping[str, str],
    *,
    port_available: Callable[[int], bool] | None = None,
) -> None:
    is_port_available = port_available or _port_available
    try:
        read_runtime(root)
        return
    except RuntimeContractError as current_error:
        with _port_allocation_lock():
            try:
                previous = read_previous_runtime_for_cleanup(root)
            except RuntimeContractError:
                raise current_error from None
            used = set(previous.ports.as_dict().values()) - {previous.ports.provider_openai}
            ephemeral_port_range = _local_ephemeral_port_range()
            for port in _candidate_ports(19092, ephemeral_port_range):
                if port not in used and is_port_available(port):
                    upgrade_previous_runtime(root, environment, port)
                    return
    raise RuntimeContractError("no local provider test port is available")


def _local_ephemeral_port_range() -> tuple[int, int]:
    try:
        fields = _EPHEMERAL_PORT_RANGE_PATH.read_text(encoding="utf-8").split()
    except FileNotFoundError:
        return _CONSERVATIVE_EPHEMERAL_PORT_RANGE
    except OSError as error:
        raise RuntimeContractError("cannot read the host ephemeral port range") from error
    if len(fields) != 2:
        raise RuntimeContractError("host ephemeral port range has an invalid shape")
    try:
        lower, upper = (int(field) for field in fields)
    except ValueError as error:
        raise RuntimeContractError("host ephemeral port range is not numeric") from error
    if not 1 <= lower <= upper <= 65535:
        raise RuntimeContractError("host ephemeral port range is outside TCP port bounds")
    return lower, upper


def _candidate_ports(
    preferred: int,
    ephemeral_port_range: tuple[int, int],
) -> Iterator[int]:
    lower, upper = ephemeral_port_range
    for port in range(preferred, min(preferred + 200, 65536)):
        if lower <= port <= upper:
            continue
        yield port


def _port_available(port: int) -> bool:
    for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as listener:
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                listener.bind((host, port))
        except OSError as error:
            if family == socket.AF_INET6 and error.errno in {
                errno.EAFNOSUPPORT,
                errno.EADDRNOTAVAIL,
                errno.EPROTONOSUPPORT,
            }:
                continue
            return False
    return True


@contextmanager
def _workspace_service_lock(repo_root: Path) -> Iterator[None]:
    workspace_lock = runtime_state_dir(repo_root) / "locks" / "services.lock"
    workspace_lock.parent.mkdir(parents=True, exist_ok=True)
    with workspace_lock.open("a+b") as workspace_handle:
        fcntl.flock(workspace_handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(workspace_handle.fileno(), fcntl.LOCK_UN)


@contextmanager
def _port_allocation_lock() -> Iterator[None]:
    with Path("/tmp/nexus-test-port-allocation.lock").open("a+b") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _wait_minio(url: str) -> None:
    deadline = time.monotonic() + 30
    with httpx.Client(trust_env=False, timeout=1) as client:
        while time.monotonic() < deadline:
            try:
                if client.get(url).status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.1)
    raise RuntimeContractError("local MinIO did not become ready")


def _write_supabase_config(repo_root: Path) -> None:
    runtime = read_runtime(repo_root)
    destination = Path(runtime.supabase_workdir) / "supabase" / "config.toml"
    destination.parent.mkdir(parents=True, exist_ok=True)
    text = (repo_root / "supabase" / "config.toml").read_text(encoding="utf-8")
    replacements = (
        (r'(?m)^project_id = "[^"]*"$', f'project_id = "{runtime.compose_project}"'),
        (r"(?m)(\[api\][\s\S]*?\nport\s*=\s*)\d+", rf"\g<1>{runtime.ports.supabase_api}"),
        (r"(?m)(\[db\][\s\S]*?\nport\s*=\s*)\d+", rf"\g<1>{runtime.ports.supabase_db}"),
        (
            r"(?m)(\[db\][\s\S]*?\nshadow_port\s*=\s*)\d+",
            rf"\g<1>{runtime.ports.supabase_shadow}",
        ),
        (
            r"(?m)(\[studio\][\s\S]*?\nport\s*=\s*)\d+",
            rf"\g<1>{runtime.ports.supabase_studio}",
        ),
        (
            r"(?m)(\[inbucket\][\s\S]*?\nport\s*=\s*)\d+",
            rf"\g<1>{runtime.ports.supabase_inbucket}",
        ),
        (
            r'(?m)(\[auth\][\s\S]*?\nsite_url\s*=\s*)"[^"]*"',
            rf'\g<1>"http://127.0.0.1:{runtime.ports.web}"',
        ),
        (
            r'(?m)(\[auth\][\s\S]*?\njwt_issuer\s*=\s*)"[^"]*"',
            rf'\g<1>"http://127.0.0.1:{runtime.ports.supabase_api}/auth/v1"',
        ),
        (
            r"(?m)^additional_redirect_urls\s*=\s*\[[\s\S]*?\]",
            "additional_redirect_urls = ["
            f'"http://127.0.0.1:{runtime.ports.web}/auth/callback", '
            f'"http://localhost:{runtime.ports.web}/auth/callback", '
            f'"http://10.0.2.2:{runtime.ports.web}/auth/callback"'
            "]",
        ),
    )
    for pattern, replacement in replacements:
        text, count = re.subn(pattern, replacement, text, count=1)
        if count != 1:
            raise RuntimeContractError(f"required Supabase config shape is missing: {pattern}")
    destination.write_text(text, encoding="utf-8")
    template_destination = destination.parent / "templates"
    template_destination.mkdir(exist_ok=True)
    for name in ("invite.html", "recovery.html"):
        shutil.copyfile(repo_root / "supabase" / "templates" / name, template_destination / name)


def _parse_supabase_status(raw: str) -> dict[str, str]:
    normalized = "\n".join(
        line for line in raw.splitlines() if line and not line.startswith("Stopped services:")
    )
    try:
        payload = json.loads(normalized)
    except json.JSONDecodeError as exc:
        raise RuntimeContractError("Supabase status was not JSON") from exc
    if not isinstance(payload, dict):
        raise RuntimeContractError("Supabase status must be a JSON object")
    result: dict[str, str] = {}
    for key in _STATUS_KEYS:
        value = payload.get(key)
        if isinstance(value, str) and value:
            result[key] = value
    return result


def _repository_template_fingerprint(repo_root: Path) -> str:
    migration_root = repo_root / "migrations"
    migration_sources = tuple(
        sorted((*migration_root.glob("*.ini"), *migration_root.glob("alembic/**/*.py")))
    )
    return template_fingerprint(
        repo_root,
        migration_sources=migration_sources,
        postgres_image=POSTGRES_IMAGE,
        postgres_version=POSTGRES_VERSION,
        extensions=("pgcrypto", "vector"),
        immutable_seed_sources=tuple(sorted(migration_root.glob("oracle_v1_seed/*.json"))),
    )


def _ensure_template_locked(
    repo_root: Path,
    environment: Mapping[str, str],
    run_id: str,
    fingerprint: str,
) -> None:
    template = template_database_name(fingerprint)
    build = template_build_database_name(run_id)
    with _postgres_admin(repo_root, environment) as connection:
        row = connection.execute(
            "SELECT datallowconn, datistemplate FROM pg_database WHERE datname = %s",
            (template,),
        ).fetchone()
        if row is not None:
            if row != (False, True):
                raise RuntimeContractError("recorded template database is not finalized")
            return
    resource = Resource(ResourceKind.TEMPLATE_BUILD, build)
    record_planned(repo_root, environment, run_id, resource, external_id=fingerprint)
    _create_database_raw(repo_root, environment, build, "template0")
    record_created(repo_root, environment, run_id, resource)
    try:
        _run_migrations(repo_root, _database_url(repo_root, environment, build))
        with _postgres_admin(repo_root, environment) as connection:
            _terminate_database_connections(connection, build)
            connection.execute(
                sql.SQL("ALTER DATABASE {} WITH ALLOW_CONNECTIONS false IS_TEMPLATE true").format(
                    sql.Identifier(build)
                )
            )
            connection.execute(
                sql.SQL("ALTER DATABASE {} RENAME TO {}").format(
                    sql.Identifier(build), sql.Identifier(template)
                )
            )
    except BaseException:
        _drop_database(repo_root, environment, build)
        raise
    forget_cleaned(repo_root, environment, run_id, resource)


def _create_database(
    repo_root: Path,
    environment: Mapping[str, str],
    run_id: str,
    resource: Resource,
    template: str,
) -> None:
    record_planned(repo_root, environment, run_id, resource)
    _create_database_raw(repo_root, environment, resource.identity, template)
    record_created(repo_root, environment, run_id, resource)


def _create_database_raw(
    repo_root: Path, environment: Mapping[str, str], database: str, template: str
) -> None:
    with _postgres_admin(repo_root, environment) as connection:
        connection.execute(
            sql.SQL("CREATE DATABASE {} TEMPLATE {}").format(
                sql.Identifier(database), sql.Identifier(template)
            )
        )


def _drop_database(repo_root: Path, environment: Mapping[str, str], database: str) -> None:
    with _postgres_admin(repo_root, environment) as connection:
        exists = connection.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s", (database,)
        ).fetchone()
        if exists is None:
            return
        _terminate_database_connections(connection, database)
        connection.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(database)))


def _terminate_database_connections(connection: psycopg.Connection, name: str) -> None:
    connection.execute(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
        "WHERE datname = %s AND pid <> pg_backend_pid()",
        (name,),
    )


def _postgres_admin(repo_root: Path, environment: Mapping[str, str]) -> psycopg.Connection:
    endpoint = runtime_endpoint(repo_root, environment, EndpointKind.POSTGRES)
    return psycopg.connect(f"{endpoint}/postgres?user=postgres&password=postgres", autocommit=True)


def _database_url(repo_root: Path, environment: Mapping[str, str], name: str) -> str:
    endpoint = runtime_endpoint(repo_root, environment, EndpointKind.POSTGRES)
    return f"{endpoint.replace('postgresql://', 'postgresql+psycopg://')}/{name}?user=postgres&password=postgres"


def _run_migrations(repo_root: Path, database_url: str) -> None:
    _run(
        (
            "uv",
            "run",
            "--project",
            str(repo_root / "python"),
            "--frozen",
            "--no-sync",
            "alembic",
            "upgrade",
            "head",
        ),
        cwd=repo_root / "migrations",
        environment={"DATABASE_URL": database_url, "NEXUS_ENV": "test"},
    )


def _s3(repo_root: Path, environment: Mapping[str, str]) -> BaseClient:
    return cast(
        BaseClient,
        boto3.client(
            "s3",
            endpoint_url=runtime_endpoint(repo_root, environment, EndpointKind.MINIO),
            aws_access_key_id=MINIO_ACCESS_KEY,
            aws_secret_access_key=MINIO_SECRET_KEY,
            region_name=MINIO_REGION,
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
                proxies={},
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
            ),
        ),
    )


def _create_bucket(repo_root: Path, environment: Mapping[str, str], run_id: str) -> None:
    resource = Resource(ResourceKind.BUCKET, run_bucket_name(run_id))
    record_planned(repo_root, environment, run_id, resource)
    _s3(repo_root, environment).create_bucket(Bucket=resource.identity)
    record_created(repo_root, environment, run_id, resource)


def _delete_bucket(repo_root: Path, environment: Mapping[str, str], bucket: str) -> None:
    client = _s3(repo_root, environment)
    try:
        while True:
            response = client.list_objects_v2(Bucket=bucket)
            contents = response.get("Contents", [])
            if contents:
                client.delete_objects(
                    Bucket=bucket,
                    Delete={"Objects": [{"Key": item["Key"]} for item in contents]},
                )
            if not response.get("IsTruncated"):
                break
        client.delete_bucket(Bucket=bucket)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") not in {"NoSuchBucket", "404"}:
            raise


def _delete_supabase_user(
    repo_root: Path,
    environment: Mapping[str, str],
    run_id: str,
    email: str,
    user_id: str | None,
    credentials: SupabaseCredentials,
) -> None:
    expected_url = runtime_endpoint(repo_root, environment, EndpointKind.SUPABASE)
    if credentials.url != expected_url:
        raise RuntimeContractError("Supabase credentials are not for the recorded runtime")
    headers = _supabase_admin_headers(credentials.admin_key)
    with httpx.Client(trust_env=False, timeout=15) as client:
        if user_id is None:
            page = 1
            page_size = 1000
            matches: list[str] = []
            seen_user_ids: set[str] = set()
            while True:
                listed = client.get(
                    f"{expected_url}/auth/v1/admin/users",
                    headers=headers,
                    params={"page": page, "per_page": page_size},
                )
                listed.raise_for_status()
                listed_payload = listed.json()
                users = listed_payload.get("users") if isinstance(listed_payload, dict) else None
                if not isinstance(users, list) or len(users) > page_size:
                    raise RuntimeContractError("Supabase admin user listing is malformed")
                for item in users:
                    candidate_id = item.get("id") if isinstance(item, dict) else None
                    if not isinstance(candidate_id, str) or not candidate_id:
                        raise RuntimeContractError("Supabase admin user listing is malformed")
                    try:
                        candidate_uuid = UUID(candidate_id)
                    except ValueError as error:
                        raise RuntimeContractError(
                            "Supabase admin user listing is malformed"
                        ) from error
                    if str(candidate_uuid) != candidate_id:
                        raise RuntimeContractError("Supabase admin user listing is malformed")
                    if candidate_id in seen_user_ids:
                        raise RuntimeContractError("Supabase admin user pagination is malformed")
                    seen_user_ids.add(candidate_id)
                    if item.get("email") != email:
                        continue
                    metadata = item.get("user_metadata")
                    if (
                        not isinstance(metadata, dict)
                        or metadata.get("nexus_test_run_id") != run_id
                    ):
                        raise RuntimeContractError(
                            "Supabase invitation no longer has exact run ownership"
                        )
                    matches.append(candidate_id)
                if len(users) < page_size:
                    break
                page += 1
            if not matches:
                return
            if len(matches) != 1:
                raise RuntimeContractError("Supabase invitation cleanup identity is ambiguous")
            user_id = matches[0]
        found = client.get(f"{expected_url}/auth/v1/admin/users/{user_id}", headers=headers)
        if found.status_code == 404:
            return
        found.raise_for_status()
        payload = found.json()
        metadata = payload.get("user_metadata") if isinstance(payload, dict) else None
        if (
            not isinstance(payload, dict)
            or payload.get("email") != email
            or not isinstance(metadata, dict)
            or metadata.get("nexus_test_run_id") != run_id
        ):
            raise RuntimeContractError("Supabase user no longer has exact run ownership")
        deleted = client.delete(f"{expected_url}/auth/v1/admin/users/{user_id}", headers=headers)
        deleted.raise_for_status()


def _supabase_admin_headers(admin_key: str) -> dict[str, str]:
    if not admin_key:
        raise RuntimeContractError("local Supabase admin key is missing")
    return {"Authorization": f"Bearer {admin_key}", "apikey": admin_key}


def _delete_extension_profile(repo_root: Path, identity: str) -> None:
    path = (repo_root / identity).resolve()
    expected_root = (runtime_state_dir(repo_root) / "runs").resolve()
    if expected_root not in path.parents:
        raise RuntimeContractError("extension profile is outside run-owned state")
    if path.exists():
        shutil.rmtree(path)


def _stop_process_group(
    repo_root: Path,
    process_group_id: int,
    process_start_token: str | None,
    run_id: str,
    owner_token: str,
) -> None:
    owned_groups = _owned_process_group_map(repo_root, run_id, owner_token)
    try:
        os.killpg(process_group_id, 0)
        recorded_group_alive = True
    except ProcessLookupError:
        recorded_group_alive = False
    except PermissionError as exc:
        raise RuntimeContractError("owned process group could not be verified") from exc
    if not recorded_group_alive:
        if process_group_id in owned_groups:
            raise RuntimeContractError(
                "owned process identity identifies a group the kernel cannot signal"
            )
        # The recorded worker group is already gone; reap any bounded child group
        # it may have left behind (parent-death teardown races the ledger cleanup).
        for group_id in sorted(owned_groups):
            _terminate_process_group(group_id)
        return
    if process_group_id not in owned_groups:
        raise RuntimeContractError("process group no longer belongs to the exact test run")
    if process_start_token is not None:
        try:
            leader_identity = _read_process_identity(process_group_id)
        except (FileNotFoundError, ProcessLookupError):
            leader_identity = None
        except (OSError, RuntimeContractError) as exc:
            raise RuntimeContractError("owned process identity could not be read") from exc
        if leader_identity is not None and (
            leader_identity.uid != os.getuid()
            or leader_identity.process_group_id != process_group_id
            or leader_identity.start_token != process_start_token
        ):
            raise RuntimeContractError("process group no longer belongs to the exact test run")
    # Terminate the recorded worker group and every bounded execution child it
    # forked into its own session; all carry this run's one secret owner token.
    for group_id in sorted(owned_groups):
        _terminate_process_group(group_id)


def _terminate_process_group(process_group_id: int) -> None:
    try:
        os.killpg(process_group_id, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            os.waitpid(process_group_id, os.WNOHANG)
        except ChildProcessError:
            pass
        try:
            os.killpg(process_group_id, 0)
        except ProcessLookupError:
            return
        except PermissionError:
            if sys.platform == "darwin":
                return
            raise
        time.sleep(0.05)
    try:
        os.killpg(process_group_id, signal.SIGKILL)
    except ProcessLookupError:
        return
    except PermissionError:
        if sys.platform == "darwin":
            return
        raise
    try:
        os.waitpid(process_group_id, 0)
    except ChildProcessError:
        pass


def _recover_planned_process_group(
    repo_root: Path,
    owner_token: str,
    run_id: str,
) -> tuple[int, str | None] | None:
    if not re.fullmatch(r"[0-9a-f]{32}", owner_token):
        raise RuntimeContractError("planned process lacks its exact ownership contract")
    owned_groups = _owned_process_group_map(repo_root, run_id, owner_token)
    if not owned_groups:
        return None
    # `_stop_process_group` reaps every group in the tree, so recovery only needs
    # one representative: prefer a group whose leader carries the token.
    for group_id in sorted(owned_groups):
        if owned_groups[group_id] is not None:
            return group_id, owned_groups[group_id]
    representative = min(owned_groups)
    return representative, owned_groups[representative]


def _owned_process_identity_matches(
    repo_root: Path,
    process_group_id: int,
    process_start_token: str,
    run_id: str,
    owner_token: str,
) -> bool:
    try:
        identity = _read_process_identity(process_group_id)
        if identity.uid != os.getuid() or identity.process_group_id != process_group_id:
            return False
        if identity.start_token != process_start_token:
            return False
        if sys.platform == "darwin":
            marker = _process_owner_marker(repo_root, run_id, owner_token)
            return process_group_id in _darwin_owner_marker_holders(marker)
        process_environment = _linux_process_environment(process_group_id)
    except (OSError, ProcessLookupError, RuntimeContractError):
        return False
    return (
        f"NEXUS_TEST_RUN_ID={run_id}".encode() in process_environment
        and f"NEXUS_TEST_PROCESS_OWNER={owner_token}".encode() in process_environment
    )


def _process_birth_identity_matches(process_group_id: int, process_start_token: str) -> bool:
    try:
        identity = _read_process_identity(process_group_id)
    except (OSError, ProcessLookupError, RuntimeContractError):
        return False
    return (
        identity.uid == os.getuid()
        and identity.process_group_id == process_group_id
        and identity.start_token == process_start_token
    )


def _startup_identity_pending(*, birth_matches: bool, now: float, deadline: float) -> bool:
    return birth_matches and now < deadline


def _process_group_owns_listener(process_group_id: int, port: int) -> bool:
    if sys.platform == "darwin":
        try:
            process_ids = _darwin_lsof_process_ids(("-a", f"-iTCP:{port}", "-sTCP:LISTEN"))
        except RuntimeContractError:
            return False
        for process_id in process_ids:
            try:
                identity = _read_process_identity(process_id)
            except (OSError, ProcessLookupError, RuntimeContractError):
                continue
            if identity.uid == os.getuid() and identity.process_group_id == process_group_id:
                return True
        return False
    if sys.platform != "linux":
        return False
    listener_inodes: set[str] = set()
    try:
        rows = Path("/proc/net/tcp").read_text(encoding="ascii").splitlines()[1:]
    except OSError:
        return False
    for row in rows:
        columns = row.split()
        if len(columns) > 9:
            _, raw_port = columns[1].rsplit(":", 1)
            if columns[3] == "0A" and int(raw_port, 16) == port:
                listener_inodes.add(columns[9])
    if not listener_inodes:
        return False
    for process_root in Path("/proc").iterdir():
        if not process_root.name.isdecimal():
            continue
        process_id = int(process_root.name)
        try:
            if (
                process_root.stat().st_uid != os.getuid()
                or os.getpgid(process_id) != process_group_id
            ):
                continue
            for descriptor in (process_root / "fd").iterdir():
                target = descriptor.readlink().as_posix()
                if target.startswith("socket:[") and target[8:-1] in listener_inodes:
                    return True
        except (OSError, ProcessLookupError):
            continue
    return False


def _require_loopback_port_available(port: int, role: str) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.2)
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            raise RuntimeContractError(
                f"owned {role} process cannot start: loopback port {port} is already in use"
            )


def _process_start_token(process_id: int) -> str:
    if sys.platform not in {"darwin", "linux"}:
        raise RuntimeContractError("owned process identity requires Linux or Darwin")
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            return _read_process_identity(process_id).start_token
        except (OSError, ProcessLookupError, RuntimeContractError):
            time.sleep(0.01)
    raise RuntimeContractError("started process birth identity could not be read")


def _read_process_identity(process_id: int) -> _ProcessIdentity:
    if sys.platform == "darwin":
        library = ctypes.CDLL(_DARWIN_LIBPROC, use_errno=True)
        proc_pidinfo = library.proc_pidinfo
        proc_pidinfo.argtypes = (
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_uint64,
            ctypes.c_void_p,
            ctypes.c_int,
        )
        proc_pidinfo.restype = ctypes.c_int
        process_info = _DarwinProcessInfo()
        ctypes.set_errno(0)
        size = proc_pidinfo(
            process_id,
            _DARWIN_PROCESS_BSD_INFO,
            0,
            ctypes.byref(process_info),
            ctypes.sizeof(process_info),
        )
        if size == 0:
            error_number = ctypes.get_errno()
            if error_number in {0, errno.ENOENT, errno.ESRCH}:
                raise ProcessLookupError(process_id)
            raise OSError(error_number, os.strerror(error_number))
        if size != ctypes.sizeof(process_info) or process_info.process_id != process_id:
            raise RuntimeContractError("Darwin process identity was incomplete")
        start_token = str(process_info.start_seconds * 1_000_000 + process_info.start_microseconds)
        if start_token == "0":
            raise RuntimeContractError("Darwin process birth identity was unavailable")
        return _ProcessIdentity(
            uid=process_info.uid,
            process_group_id=process_info.process_group_id,
            start_token=start_token,
        )
    if sys.platform == "linux":
        process_root = Path("/proc") / str(process_id)
        process_uid = process_root.stat().st_uid
        process_group_id = os.getpgid(process_id)
        try:
            stat = (process_root / "stat").read_text(encoding="utf-8")
            start_token = stat[stat.rindex(")") + 2 :].split()[19]
        except (UnicodeDecodeError, ValueError, IndexError) as exc:
            raise RuntimeContractError("Linux process identity was malformed") from exc
        if not start_token.isdecimal():
            raise RuntimeContractError("Linux process birth identity was malformed")
        return _ProcessIdentity(process_uid, process_group_id, start_token)
    raise RuntimeContractError("owned process identity requires Linux or Darwin")


def _linux_process_environment(process_id: int) -> tuple[bytes, ...]:
    if sys.platform != "linux":
        raise RuntimeContractError("Linux process environment was requested on another platform")
    return tuple((Path("/proc") / str(process_id) / "environ").read_bytes().split(b"\0"))


def _linux_owner_token_identities(
    run_id: str,
    owner_token: str,
) -> list[tuple[int, _ProcessIdentity]]:
    """Every live process whose environment carries this run's exact owner token."""
    require_run_id(run_id)
    if not re.fullmatch(r"[0-9a-f]{32}", owner_token):
        raise RuntimeContractError("Linux process owner requires an exact owner token")
    expected_owner = f"NEXUS_TEST_PROCESS_OWNER={owner_token}".encode()
    expected_run = f"NEXUS_TEST_RUN_ID={run_id}".encode()
    holder_identities: list[tuple[int, _ProcessIdentity]] = []
    try:
        process_roots = tuple(Path("/proc").iterdir())
    except OSError as exc:
        raise RuntimeContractError("Linux process table could not be read") from exc
    for process_root in process_roots:
        if not process_root.name.isdecimal():
            continue
        process_id = int(process_root.name)
        try:
            if process_root.stat().st_uid != os.getuid():
                continue
            environment = _linux_process_environment(process_id)
            if expected_owner not in environment or expected_run not in environment:
                continue
            identity = _read_process_identity(process_id)
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        except (OSError, RuntimeContractError) as exc:
            raise RuntimeContractError("owned Linux process identity could not be read") from exc
        if identity.uid != os.getuid():
            raise RuntimeContractError("owned Linux process identity changed during cleanup")
        holder_identities.append((process_id, identity))
    return holder_identities


def _owned_process_group_map(
    repo_root: Path,
    run_id: str,
    owner_token: str,
) -> dict[int, str | None]:
    """The process groups that make up one owned process's tree.

    An owned worker forks bounded execution children into their own sessions --
    the containment design under proof here -- so a single owner token, a
    per-launch secret, legitimately spans the worker's group and one group per
    live child. Every carrier holds that secret, so each group is definitively
    owned by this run and must be reaped. The value is the group leader's start
    token when the leader itself carries the token, else ``None``.
    """
    if sys.platform == "darwin":
        holders = _darwin_owner_marker_identities(repo_root, run_id, owner_token)
    elif sys.platform == "linux":
        holders = _linux_owner_token_identities(run_id, owner_token)
    else:
        raise RuntimeContractError("owned process cleanup requires Linux or Darwin")
    groups: dict[int, str | None] = {}
    for process_id, identity in holders:
        process_group_id = identity.process_group_id
        if process_group_id <= 1:
            raise RuntimeContractError("owned process token identifies an unsafe group")
        if process_id == process_group_id:
            groups[process_group_id] = identity.start_token
        else:
            groups.setdefault(process_group_id, None)
    return groups


def _process_owner_marker(repo_root: Path, run_id: str, owner_token: str) -> Path:
    require_run_id(run_id)
    if not re.fullmatch(r"[0-9a-f]{32}", owner_token):
        raise RuntimeContractError("process owner marker requires an exact owner token")
    return runtime_state_dir(repo_root) / "runs" / run_id / "process-owners" / owner_token


def _remove_process_owner_marker(repo_root: Path, run_id: str, owner_token: str) -> None:
    if sys.platform != "darwin":
        return
    marker = _process_owner_marker(repo_root, run_id, owner_token)
    marker.unlink(missing_ok=True)
    try:
        marker.parent.rmdir()
    except FileNotFoundError:
        pass
    except OSError as exc:
        if exc.errno != errno.ENOTEMPTY:
            raise RuntimeContractError(
                "process owner marker directory could not be removed"
            ) from exc


def _darwin_owner_marker_identities(
    repo_root: Path,
    run_id: str,
    owner_token: str,
) -> list[tuple[int, _ProcessIdentity]]:
    """Every live process holding this run's inherited owner-marker descriptor."""
    marker = _process_owner_marker(repo_root, run_id, owner_token)
    if not marker.is_file():
        return []
    holder_ids = _darwin_owner_marker_holders(marker)
    if not holder_ids:
        return []
    holder_identities: list[tuple[int, _ProcessIdentity]] = []
    for process_id in holder_ids:
        try:
            identity = _read_process_identity(process_id)
        except ProcessLookupError:
            continue
        except (OSError, RuntimeContractError) as exc:
            raise RuntimeContractError("owned Darwin process identity could not be read") from exc
        if identity.uid != os.getuid():
            raise RuntimeContractError("owned Darwin process marker has a foreign holder")
        holder_identities.append((process_id, identity))
    if not holder_identities and _darwin_owner_marker_holders(marker):
        raise RuntimeContractError("owned Darwin process marker holders changed during cleanup")
    return holder_identities


def _darwin_owner_marker_holders(marker: Path) -> tuple[int, ...]:
    try:
        resolved_marker = marker.resolve(strict=True).as_posix()
    except OSError as exc:
        raise RuntimeContractError("Darwin process owner marker could not be inspected") from exc
    return _darwin_lsof_process_ids(("--", resolved_marker))


def _darwin_lsof_process_ids(selection: tuple[str, ...]) -> tuple[int, ...]:
    try:
        result = subprocess.run(
            (_DARWIN_LSOF, "-nP", "-t", *selection),
            check=False,
            capture_output=True,
            text=True,
            timeout=1,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeContractError("Darwin process ownership could not be inspected") from exc
    if result.returncode == 1 and not result.stdout.strip():
        return ()
    if result.returncode != 0:
        raise RuntimeContractError("Darwin process ownership inspection failed")
    rows = result.stdout.splitlines()
    if not rows or any(not row.isdecimal() for row in rows):
        raise RuntimeContractError("Darwin process ownership output was malformed")
    return tuple(dict.fromkeys(int(row) for row in rows))


def _child_environment(environment: Mapping[str, str]) -> dict[str, str]:
    child = {key: os.environ[key] for key in _SAFE_CHILD_ENV if key in os.environ}
    child.update(environment)
    return child


def _run(
    command: Sequence[str],
    *,
    cwd: Path,
    environment: Mapping[str, str] | None = None,
    capture_output: bool = False,
) -> subprocess.CompletedProcess[str]:
    if not command or any(not isinstance(part, str) or not part for part in command):
        raise RuntimeContractError("child command must be a fixed non-empty argv")
    child_environment = _child_environment(environment or {})
    if command[0] in {"docker", "supabase"}:
        child_environment["DOCKER_HOST"] = local_docker_host()
        child_environment["DOCKER_CONTEXT"] = "default"
    return run_command(
        tuple(command),
        cwd=cwd,
        env=child_environment,
        check=True,
        capture_output=capture_output,
    )
