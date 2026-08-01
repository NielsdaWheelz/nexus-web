from __future__ import annotations

import errno
import fcntl
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import boto3
import httpx
import psycopg
from botocore.client import BaseClient, Config
from botocore.exceptions import ClientError
from psycopg import sql

from nexus_test_control.build import StandaloneBuild
from nexus_test_control.model import Resource, ResourceKind
from nexus_test_control.process import run_command, unblock_and_exec_command
from nexus_test_control.runtime import (
    EndpointKind,
    LedgerEntry,
    ResourcePhase,
    RuntimeContractError,
    RuntimePorts,
    canonical_repo_root,
    claim_run,
    cleanup_candidates,
    forget_cleaned,
    initialize_runtime,
    local_docker_host,
    migration_database_name,
    process_resource_identity,
    read_ledger,
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

_PORT_DEFAULTS = (15432, 19000, 25421, 25422, 25423, 25424, 25425, 18000, 13000, 19091)
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
        "NEXUS_TEST_STATIC_DNS",
        "NODE_OPTIONS",
        "OPENAI_API_BASE_URL",
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
class StartedProcess:
    role: str
    process_group_id: int
    process_start_token: str
    run_id: str
    owner_token: str = field(repr=False)
    log_path: str


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
        "NEXUS_TEST_RUN_ID": run.run_id,
        "OPENAI_API_BASE_URL": (f"{runtime_endpoint(root, environment, EndpointKind.EXTERNAL)}/v1"),
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
            _start_services(root)
    return read_supabase_credentials(root, environment)


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
    try:
        _run(
            (
                "supabase",
                "--workdir",
                runtime.supabase_workdir,
                "start",
                "--exclude",
                SUPABASE_EXCLUDED_SERVICES,
            ),
            cwd=root,
            capture_output=True,
        )
    except subprocess.CalledProcessError:
        raise RuntimeContractError("local Supabase failed to start") from None


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


def start_python_process(
    repo_root: Path,
    environment: Mapping[str, str],
    run: TestRun,
    role: str,
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
    else:
        raise RuntimeContractError(f"Python process role is not owned: {role}")
    process_environment = {
        **run_environment(root, environment, run),
        "NEXUS_TEST_DENY_EXTERNAL_NETWORK": "1",
        "NEXUS_TEST_STATIC_DNS": '{"www.nasa.gov":"93.184.216.34"}',
        "NODE_OPTIONS": f"--import={root / 'python/tests/testkit/node-network-guard.mjs'}",
        "OPENAI_API_KEY": "nexus-test-fixture-openai-key",
        "OPENAI_API_BASE_URL": f"http://127.0.0.1:{runtime.ports.external}/v1",
        "OUTBOUND_HTTP_PROXY_URL": f"http://127.0.0.1:{runtime.ports.external}",
        "PODCAST_INDEX_API_KEY": "nexus-test-fixture-podcast-key",
        "PODCAST_INDEX_API_SECRET": "nexus-test-fixture-podcast-secret",
        "PODCAST_INDEX_BASE_URL": f"http://127.0.0.1:{runtime.ports.external}",
        "PYTHONPATH": f"{root / 'python' / 'tests' / 'testkit'}:{root / 'python'}:{root}",
        **({"WORKER_LANE": role.removeprefix("worker-")} if role.startswith("worker-") else {}),
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


def start_web_process(
    repo_root: Path,
    environment: Mapping[str, str],
    run: TestRun,
    build: StandaloneBuild,
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
    return _start_owned_process(
        root,
        environment,
        run.run_id,
        "web",
        ("node", str(server)),
        cwd=server.parent,
        process_environment={
            **run_environment(root, environment, run),
            "HOSTNAME": "127.0.0.1",
            "NODE_OPTIONS": f"--import={root / 'python/tests/testkit/node-network-guard.mjs'}",
            "NODE_ENV": "production",
            "PORT": str(runtime.ports.web),
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
    deadline = time.monotonic() + timeout_seconds
    identity_deadline = min(deadline, time.monotonic() + 2)
    with httpx.Client(trust_env=False, timeout=1, follow_redirects=False) as client:
        while time.monotonic() < deadline:
            if not _owned_process_identity_matches(
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
                    200 <= response.status_code < 500
                    and _process_group_owns_listener(process.process_group_id, port)
                    and _owned_process_identity_matches(
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
    try:
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
        raise
    finally:
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
                            candidate.external_id,
                            run_id,
                        )
                        if recovered is not None:
                            process_group_id, process_start_token = recovered
                    if process_group_id is not None:
                        _stop_process_group(
                            process_group_id,
                            process_start_token,
                            run_id,
                            candidate.external_id,
                        )
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
                    if candidate.external_id is None:
                        raise RuntimeContractError("Supabase user lacks its planned exact id")
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
) -> tuple[str, ...]:
    """Delete the exact recorded runs, workspace services, volumes, and state."""
    require_test_environment(environment)
    root = canonical_repo_root(repo_root)
    if not runtime_record_path(root).exists():
        return ()
    run_command = command_runner or _run
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
    for preferred in _PORT_DEFAULTS:
        for port in range(preferred, min(preferred + 200, 65536)):
            if port not in ports and _port_available(port):
                ports.append(port)
                break
        else:
            raise RuntimeContractError(f"no local test port is available from {preferred}")
    return RuntimePorts(*ports)


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
    user_id: str,
    credentials: SupabaseCredentials,
) -> None:
    expected_url = runtime_endpoint(repo_root, environment, EndpointKind.SUPABASE)
    if credentials.url != expected_url:
        raise RuntimeContractError("Supabase credentials are not for the recorded runtime")
    headers = _supabase_admin_headers(credentials.admin_key)
    with httpx.Client(trust_env=False, timeout=15) as client:
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
    process_group_id: int,
    process_start_token: str | None,
    run_id: str,
    owner_token: str,
) -> None:
    process_root = Path("/proc") / str(process_group_id)
    if not process_root.exists():
        return
    if process_start_token is None:
        raise RuntimeContractError("owned process lacks its immutable runtime identity")
    if not _owned_process_identity_matches(
        process_group_id,
        process_start_token,
        run_id,
        owner_token,
    ):
        raise RuntimeContractError("process group no longer belongs to the exact test run")
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
        time.sleep(0.05)
    os.killpg(process_group_id, signal.SIGKILL)
    try:
        os.waitpid(process_group_id, 0)
    except ChildProcessError:
        pass


def _recover_planned_process_group(
    owner_token: str,
    run_id: str,
) -> tuple[int, str] | None:
    if not re.fullmatch(r"[0-9a-f]{32}", owner_token):
        raise RuntimeContractError("planned process lacks its exact ownership contract")
    expected_owner = f"NEXUS_TEST_PROCESS_OWNER={owner_token}".encode()
    expected_run = f"NEXUS_TEST_RUN_ID={run_id}".encode()
    matches: list[tuple[int, str]] = []
    for process_root in Path("/proc").iterdir():
        if not process_root.name.isdecimal():
            continue
        try:
            if process_root.stat().st_uid != os.getuid():
                continue
            environment = (process_root / "environ").read_bytes().split(b"\0")
            if expected_owner not in environment or expected_run not in environment:
                continue
            process_id = int(process_root.name)
            if os.getpgid(process_id) != process_id:
                raise RuntimeContractError(
                    "planned process token no longer identifies its exact process group"
                )
            start_token = _process_start_token(process_id)
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        except (OSError, UnicodeDecodeError, ValueError) as exc:
            raise RuntimeContractError("planned process identity could not be read") from exc
        matches.append((process_id, start_token))
    if len(matches) > 1:
        raise RuntimeContractError("planned process token identifies multiple process groups")
    return matches[0] if matches else None


def _owned_process_identity_matches(
    process_group_id: int,
    process_start_token: str,
    run_id: str,
    owner_token: str,
) -> bool:
    process_root = Path("/proc") / str(process_group_id)
    try:
        if (
            process_root.stat().st_uid != os.getuid()
            or os.getpgid(process_group_id) != process_group_id
        ):
            return False
        stat = (process_root / "stat").read_text(encoding="utf-8")
        actual_start_token = stat[stat.rindex(")") + 2 :].split()[19]
        process_environment = (process_root / "environ").read_bytes().split(b"\0")
    except (OSError, ProcessLookupError, ValueError, IndexError):
        return False
    return (
        actual_start_token == process_start_token
        and f"NEXUS_TEST_RUN_ID={run_id}".encode() in process_environment
        and f"NEXUS_TEST_PROCESS_OWNER={owner_token}".encode() in process_environment
    )


def _process_birth_identity_matches(process_group_id: int, process_start_token: str) -> bool:
    process_root = Path("/proc") / str(process_group_id)
    try:
        if (
            process_root.stat().st_uid != os.getuid()
            or os.getpgid(process_group_id) != process_group_id
        ):
            return False
        stat = (process_root / "stat").read_text(encoding="utf-8")
        actual_start_token = stat[stat.rindex(")") + 2 :].split()[19]
    except (OSError, ProcessLookupError, ValueError, IndexError):
        return False
    return actual_start_token == process_start_token


def _startup_identity_pending(*, birth_matches: bool, now: float, deadline: float) -> bool:
    return birth_matches and now < deadline


def _process_group_owns_listener(process_group_id: int, port: int) -> bool:
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
    deadline = time.monotonic() + 2
    path = Path("/proc") / str(process_id) / "stat"
    while time.monotonic() < deadline:
        try:
            stat = path.read_text(encoding="utf-8")
            return stat[stat.rindex(")") + 2 :].split()[19]
        except (OSError, UnicodeDecodeError, ValueError, IndexError):
            time.sleep(0.01)
    raise RuntimeContractError("started process birth identity could not be read")


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
