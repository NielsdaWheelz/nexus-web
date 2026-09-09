from __future__ import annotations

import ast
import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import tomllib
import xml.etree.ElementTree as ET
from collections.abc import Callable, Iterable, Iterator, Mapping
from contextlib import ExitStack, contextmanager, nullcontext
from dataclasses import dataclass, field, replace
from datetime import date
from pathlib import Path
from typing import Literal, TextIO, assert_never
from uuid import UUID

import httpx
import psycopg
from botocore.exceptions import BotoCoreError
from sqlalchemy.exc import SQLAlchemyError

from nexus.release_artifact import (
    ANDROID_RELEASE_TAG,
    AndroidPlayerProtocolIdentity,
    BackendArtifactDefect,
)
from nexus.release_artifact import (
    is_exact_https_origin as _is_exact_https_origin,
)
from nexus_test_control import android_visual
from nexus_test_control.build import StandaloneBuild, ensure_standalone_build
from nexus_test_control.evidence import (
    BrowserIdentity,
    CapabilityEvidence,
    FixedCommandIdentity,
    JsonValue,
    RunContextEvidence,
    RuntimeIdentity,
    redact_text,
    write_evidence_json,
)
from nexus_test_control.memory import (
    OwnedMemorySampler,
    available_memory_mib,
    measure_owned_memory,
    measured,
    required_platform_memory_tools,
)
from nexus_test_control.model import (
    WORKFLOW_REGISTRY,
    Capability,
    PeakOwnedMemory,
    Resource,
    ResourceKind,
    RunStatus,
    Selection,
    SelectionReason,
    SelectionScope,
    Workflow,
)
from nexus_test_control.policy import (
    PolicyViolation,
    corpus_violations,
    exception_violations,
    fault_manifest_violations,
    proof_contract_violations,
    python_ast_violations,
    repository_violations,
    resource_capability_projection_violations,
)
from nexus_test_control.process import run_command
from nexus_test_control.runtime import (
    EndpointKind,
    RuntimeContractError,
    extension_profile_identity,
    local_docker_host,
    migration_database_name,
    read_runtime,
    record_created,
    record_planned,
    repo_id_for,
    run_database_name,
    template_database_name,
    workspace_heavy_lock,
)
from nexus_test_control.services import (
    TEST_EXTENSION_PUBLIC_KEY,
    AuthorizedAndroidDevice,
    CodexGenerationPeer,
    EmbeddingPeer,
    InvitedTestUser,
    ProviderApiPeer,
    StartedProcess,
    SupabaseCredentials,
    TestRun,
    TestUser,
    _repository_template_fingerprint,
    android_sdk_available,
    authorized_instrumentation_device,
    authorized_usb_physical_device,
    cgroup_delegate_failure,
    clean_run,
    create_supabase_user,
    grant_scenario_paid_entitlement,
    invite_supabase_user,
    materialize_codex_generation_peer,
    materialize_embedding_peer,
    materialize_provider_api_peer,
    new_run_id,
    prepare_run,
    required_platform_process_tools,
    reset_run_data_plane,
    resolve_adb,
    resolve_android_sdk,
    resolved_android_environment,
    run_environment,
    start_python_process,
    start_web_process,
    wait_codex_generation_peer_ready,
    wait_process_ready,
)

_SENSITIVE_ENV_PARTS = (
    "credential",
    "fixture",
    "key",
    "password",
    "promotion",
    "secret",
    "token",
)
_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_SAFE_HEAVY_ENV = (
    "HOME",
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "NEXUS_TEST_EVIDENCE_RUN_ID",
    "NEXUS_TEST_RESULTS_DIR",
    "NEXUS_TEST_RUN_ID",
    "PARSER_TEMP_ROOT",
    "PATH",
    "PLAYWRIGHT_BROWSERS_PATH",
    "PYTHONDONTWRITEBYTECODE",
    "TERM",
    "TMPDIR",
    "TZ",
    "UV_CACHE_DIR",
    "XDG_CACHE_HOME",
)
_BROWSER_RUN_ENV = frozenset(
    {
        "APP_PUBLIC_URL",
        "FASTAPI_BASE_URL",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXUS_ENV",
        "NEXUS_TEST_RUN_ID",
        "R2_S3_API_ORIGIN",
        "STREAM_BASE_URL",
        "STREAM_CORS_ORIGINS",
    }
)
_SAFE_CHILD_ENV = (
    "ANDROID_HOME",
    "ANDROID_SERIAL",
    "ANDROID_SDK_ROOT",
    "GRADLE_USER_HOME",
    "HOME",
    "JAVA_HOME",
    "LANG",
    "LC_ALL",
    "NEXUS_GOOGLE_WEB_CLIENT_ID",
    "NO_COLOR",
    "NEXUS_TEST_EVIDENCE_RUN_ID",
    "NEXUS_TEST_RESULTS_DIR",
    "NEXUS_TEST_RUN_ID",
    "PARSER_TEMP_ROOT",
    "PATH",
    "PLAYWRIGHT_BROWSERS_PATH",
    "PYTHONDONTWRITEBYTECODE",
    "TERM",
    "TMPDIR",
    "TZ",
    "UV_CACHE_DIR",
    "XDG_CACHE_HOME",
)
_RELEASE_ARTIFACT_WORKER_IMAGE_ENV = "NEXUS_TEST_CANDIDATE_WORKER_IMAGE"
_LOCAL_IMAGE_ID_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
_PYTHON_POLICY_DIRS = (
    "python/tests/kernel",
    "python/tests/service",
    "python/tests/contract",
    "python/tests/llm_tools_contract",
    "python/tests/migrations",
    "python/tests/evals",
    "python/tests/audit",
    "python/tests/hosted",
    "python/tests/testkit",
)
_POLICY_INFRASTRUCTURE = frozenset(
    {
        "python/nexus_test_control/policy.py",
        "python/tests/kernel/nexus_test_control/test_policy.py",
        "testdata/manifest.json",
        "testdata/proofs.json",
        "testdata/policy-exceptions.json",
        "testdata/faults/manifest.json",
    }
)
_PYTHON_STATIC_PROMOTERS = frozenset({"python/pyproject.toml", "python/uv.lock"})
_EXTERNAL_PYTHON_OWNERS = (
    "apps/api/main.py",
    "apps/codex_agent/__init__.py",
    "apps/codex_agent/auth_environment.py",
    "apps/codex_agent/capacity.py",
    "apps/codex_agent/capacity_canary.py",
    "apps/codex_agent/confined_runtime.py",
    "apps/codex_agent/credential_state.py",
    "apps/codex_agent/egress_policy.py",
    "apps/codex_agent/enroll.py",
    "apps/codex_agent/health.py",
    "apps/codex_agent/host.py",
    "apps/codex_agent/main.py",
    "apps/codex_agent/network_health.py",
    "apps/codex_agent/path_environment.py",
    "apps/codex_agent/sandbox_health.py",
    "apps/worker/health.py",
    "apps/worker/main.py",
    "deploy/hetzner/release.py",
)
_WEB_STATIC_PROMOTERS = frozenset(
    {
        "apps/web/package.json",
        "apps/web/bun.lock",
        "apps/web/eslint.config.mjs",
        "apps/web/vitest.config.ts",
    }
)
_WEB_STATIC_SUFFIXES = (".cjs", ".css", ".js", ".jsx", ".mjs", ".ts", ".tsx")
_PLATFORM_SHELL_OWNERS = (
    "deploy/cloudflare/apply-r2-cors.sh",
    "deploy/cloudflare/apply-r2-lifecycle.sh",
    "deploy/hetzner/backend-publisher-workspace.sh",
    "deploy/hetzner/deploy.sh",
    "deploy/hetzner/fetch-release-bundle.sh",
    "deploy/hetzner/prove-codex-capacity.sh",
    "deploy/hetzner/provision.sh",
    "deploy/hetzner/reconcile-oracle.sh",
    "deploy/hetzner/sync-env.sh",
    "deploy/smoke/auth-smoke.sh",
    "deploy/supabase/verify-auth-config.sh",
    "deploy/vercel/sync-env.sh",
    "deploy/vercel/sync-resource-sharing-firewall.sh",
    "scripts/ci-proof-artifact.sh",
)
_PLATFORM_PRODUCTION_COMPOSE_OWNER = "deploy/hetzner/docker-compose.yml"
_PLATFORM_LOCAL_COMPOSE_OWNERS = (
    "docker/docker-compose.yml",
    "docker/docker-compose.worker.yml",
)
_PLATFORM_CLOUD_INIT_OWNER = "deploy/hetzner/cloud-init.yml"
_PLATFORM_BACKEND_DOCKERFILE_OWNER = "docker/Dockerfile.backend"
_PLATFORM_STATIC_OWNERS = frozenset(
    (
        *_PLATFORM_SHELL_OWNERS,
        _PLATFORM_PRODUCTION_COMPOSE_OWNER,
        *_PLATFORM_LOCAL_COMPOSE_OWNERS,
        _PLATFORM_CLOUD_INIT_OWNER,
        _PLATFORM_BACKEND_DOCKERFILE_OWNER,
    )
)
_PLATFORM_PRODUCTION_COMPOSE_ENV = (
    "COMPOSE_DISABLE_ENV_FILE=1",
    "POSTGRES_IMAGE=docker.io/library/postgres@sha256:" + "1" * 64,
    "CADDY_IMAGE=docker.io/library/caddy@sha256:" + "2" * 64,
    "POSTGRES_USER=nexus",
    "POSTGRES_PASSWORD=not-a-secret",
    "POSTGRES_DB=nexus",
    "CADDY_SITE=nexus.example.invalid",
    "CADDY_ACME_EMAIL=nexus@example.invalid",
    "API_IMAGE=example.invalid/nexus-api@sha256:" + "3" * 64,
    "WORKER_IMAGE=example.invalid/nexus-worker@sha256:" + "4" * 64,
    "NEXUS_CONFIG_FILE=/dev/null",
)
_PLATFORM_LOCAL_COMPOSE_ENV = (
    "COMPOSE_DISABLE_ENV_FILE=1",
    "NEXUS_LOCAL_SOURCE_SHA=" + "0" * 40,
    "NEXUS_LOCAL_RUNTIME_IDENTITY_FILE=/dev/null",
    "POSTGRES_PORT=54320",
    "MINIO_PORT=9000",
    "WORKER_DATABASE_URL=postgresql+psycopg://postgres:postgres@postgres:5432/postgres",
    "WORKER_SUPABASE_JWKS_URL=https://auth.example.invalid/.well-known/jwks.json",
    "SUPABASE_ISSUER=https://auth.example.invalid",
    "SUPABASE_AUDIENCES=authenticated",
    "WORKER_R2_S3_API_ORIGIN=http://minio:9000",
    "R2_ACCESS_KEY_ID=static-platform-access",
    "R2_SECRET_ACCESS_KEY=not-a-secret",
    "R2_BUCKET=static-platform",
    "R2_REGION=us-east-1",
    "NEXUS_ENV=test",
)
_ANDROID_HOST_PREFIX = "apps/android/app/src/test/"
_INGEST_NODE_TEST_PREFIX = "node/ingest/test/"
_INGEST_NODE_NETWORK_GUARD = "python/tests/testkit/node-network-guard.mjs"
_ANDROID_TARGET_SDK = 36
_ANDROID_RELEASE_BASELINE_ACQUISITION_NODES = (
    "apps/android/app/src/androidTest/java/app/nexus/android/offline/reading/"
    "OfflineReadingSignedPhysicalPromotionTest.kt::"
    "acquiresAllFormatsAndPersistsPendingProgressOnBaseline",
)
_ANDROID_RELEASE_COLD_OFFLINE_NODES = (
    "apps/android/app/src/androidTest/java/app/nexus/android/offline/reading/"
    "OfflineReadingSignedPhysicalPromotionTest.kt::"
    "opensShelfAfterForceStopRebootAndAirplaneMode",
)
_ANDROID_RELEASE_CANDIDATE_UPDATE_NODES = (
    "apps/android/app/src/androidTest/java/app/nexus/android/NativeAuthHandoffTest.kt::"
    "nativeAuthStartCarriesTheExactHandoffContractToTheOwnedOrigin",
    "apps/android/app/src/androidTest/java/app/nexus/android/offline/reading/"
    "OfflineReadingDeviceLifecycleTest.kt::sqliteFilesSealRecreateLeaseRemovalAndAccountPurge",
    "apps/android/app/src/androidTest/java/app/nexus/android/offline/reading/"
    "OfflineReadingSignedPhysicalPromotionTest.kt::"
    "opensV1AfterUpdateThenPurgesOfflineState",
)
_ANDROID_RELEASE_INSTRUMENTATION_NODES = (
    *_ANDROID_RELEASE_BASELINE_ACQUISITION_NODES,
    *_ANDROID_RELEASE_COLD_OFFLINE_NODES,
    *_ANDROID_RELEASE_CANDIDATE_UPDATE_NODES,
)
# The signed promotion scenarios need the staged older baseline, the protected
# fixture identifiers, and controller-owned force-stop/reboot/airplane steps.
# The plain debug device sweep supplies none of them, so it excludes exactly
# this annotation instead of hard-failing on the promotion methods.
_ANDROID_SIGNED_PROMOTION_ANNOTATION = "app.nexus.android.offline.reading.SignedPromotion"
_ANDROID_RELEASE_PROMOTION_INPUTS = (
    "NEXUS_ANDROID_RELEASE_PROMOTION_ACCOUNT_ID",
    "NEXUS_ANDROID_RELEASE_PROMOTION_PDF_MEDIA_ID",
    "NEXUS_ANDROID_RELEASE_PROMOTION_EPUB_MEDIA_ID",
    "NEXUS_ANDROID_RELEASE_PROMOTION_ARTICLE_MEDIA_ID",
)
_ANDROID_RELEASE_PROMOTION_ARGUMENTS = (
    (
        "NEXUS_ANDROID_RELEASE_PROMOTION_ACCOUNT_ID",
        "nexus_offline_reading_promotion_account_id",
    ),
    (
        "NEXUS_ANDROID_RELEASE_PROMOTION_PDF_MEDIA_ID",
        "nexus_offline_reading_promotion_pdf_media_id",
    ),
    (
        "NEXUS_ANDROID_RELEASE_PROMOTION_EPUB_MEDIA_ID",
        "nexus_offline_reading_promotion_epub_media_id",
    ),
    (
        "NEXUS_ANDROID_RELEASE_PROMOTION_ARTICLE_MEDIA_ID",
        "nexus_offline_reading_promotion_article_media_id",
    ),
)
_DETERMINISTIC_PYTEST = ("-p", "no:randomly")
_MIN_AVAILABLE_HEAVY_MIB = 2048
_MEMORY_ADMISSION_TIMEOUT_SECONDS = 30.0
_MEMORY_ADMISSION_POLL_SECONDS = 0.25
_HEAVY_CAPABILITIES = frozenset(
    {
        Capability.SERVICE,
        Capability.COMPONENT,
        Capability.MIGRATIONS,
        Capability.BUNDLE,
        Capability.JOURNEYS_CRITICAL,
        Capability.JOURNEYS_ALL,
        Capability.PROVIDER_RUNTIME,
        Capability.LLM_TOOLS,
        Capability.INGEST_NODE,
        Capability.LLM_EVAL,
        Capability.EXTENSION,
        Capability.ANDROID_HOST,
        Capability.AUDIT,
        Capability.ANDROID_DEVICE,
        Capability.ANDROID_RELEASE,
        Capability.RELEASE_ARTIFACT,
    }
)
_MEMORY_ADMITTED_CAPABILITIES = _HEAVY_CAPABILITIES | {
    Capability.POLICY_SELF_TESTS,
    Capability.STATIC_WEB,
    Capability.KERNEL_WEB,
}
_LOCAL_RUNTIME_CAPABILITIES = frozenset(
    {
        Capability.SERVICE,
        Capability.COMPONENT,
        Capability.MIGRATIONS,
        Capability.BUNDLE,
        Capability.JOURNEYS_CRITICAL,
        Capability.JOURNEYS_ALL,
        Capability.LLM_EVAL,
        Capability.EXTENSION,
        Capability.AUDIT,
    }
)
_EXTERNAL_PROTOCOL_CAPABILITIES = frozenset(
    {
        Capability.SERVICE,
        Capability.LLM_EVAL,
    }
)
_PROVIDER_API_PROTOCOL_CAPABILITIES = frozenset(
    {
        Capability.SERVICE,
        Capability.LLM_EVAL,
    }
)
_TEST_GOOGLE_CLIENT_ID = "nexus-test.apps.googleusercontent.com"
_ANDROID_DEVICE_EVIDENCE_NAME = "android-device-instrumentation.json"
_ANDROID_DEVICE_OUTPUT_LIMIT = 64 * 1024
_ANDROID_DEVICE_ARTIFACT_MAX_BYTES = 2_000_000
_ANDROID_NEXUS_DIAGNOSTIC_MARKER = "NEXUS_CONTROL_GESTURE_DIAGNOSTICS:"
_ANDROID_NEXUS_GESTURE_PROOF_PATH = (
    "apps/android/app/src/androidTest/java/app/nexus/android/NexusControlGestureTest.kt"
)
_ANDROID_NEXUS_GESTURE_PROOF_METHOD = "nexusControlReceivesHorizontalTouchFromOuterAndInnerHalves"
_ANDROID_NEXUS_GESTURE_PROOF_ID = (
    f"gradle:{_ANDROID_NEXUS_GESTURE_PROOF_PATH}::{_ANDROID_NEXUS_GESTURE_PROOF_METHOD}"
)
_ANDROID_NEXUS_GESTURE_TEST_TARGET = (
    f"app.nexus.android.NexusControlGestureTest#{_ANDROID_NEXUS_GESTURE_PROOF_METHOD}"
)
_ANDROID_RELEASE_OWNED_HOST = "nexus.nielseriknandal.com"
_ANDROID_PLAYER_PROTOCOL_CORPUS = Path("testdata/android/player-protocol.json")
_CRITICAL_JOURNEY_IDS = frozenset(
    {
        "auth-session",
        "durable-ingest-reader-open",
        "grounded-chat-citation",
        "nexus-search-open-restore",
        "password-recovery",
        "resource-share-boundary",
    }
)

type FixedCommand = tuple[tuple[str, ...], Path]


@dataclass(frozen=True, slots=True)
class _SuccessfulFixedCommand:
    argv: tuple[str, ...]
    cwd: Path
    completed: subprocess.CompletedProcess[str]


@dataclass(frozen=True, slots=True)
class _PinnedPythonSuite:
    capability: Capability
    package: str
    source_directory: str
    contract_directory: str
    local_absent_detail: str
    exact_proof_error: str
    no_selection_detail: str
    success_detail: str
    verification_commands: tuple[tuple[str, ...], ...]

    @property
    def marker_name(self) -> str:
        return f".nexus-{self.package}-revision"


_PINNED_PYTHON_VERIFICATION = (
    ("uv", "run", "--frozen", "--no-sync", "ruff", "check", "src", "tests"),
    (
        "uv",
        "run",
        "--frozen",
        "--no-sync",
        "ruff",
        "format",
        "--check",
        "src",
        "tests",
    ),
    ("uv", "run", "--frozen", "--no-sync", "pyright", "src", "tests"),
    ("uv", "run", "--frozen", "--no-sync", "pytest", "-q", *_DETERMINISTIC_PYTEST),
)
_PROVIDER_RUNTIME_SUITE = _PinnedPythonSuite(
    capability=Capability.PROVIDER_RUNTIME,
    package="provider-runtime",
    source_directory="llm-calling",
    contract_directory="tests/contract",
    local_absent_detail="local provider protocol contract owner is absent",
    exact_proof_error="exact provider protocol proof must name one pytest node",
    no_selection_detail="no selected local provider protocol proof",
    success_detail="local provider protocol contract and pinned provider-runtime suite passed",
    verification_commands=_PINNED_PYTHON_VERIFICATION,
)
_LLM_TOOLS_SUITE = _PinnedPythonSuite(
    capability=Capability.LLM_TOOLS,
    package="llm-tools",
    source_directory="llm-tools",
    contract_directory="tests/llm_tools_contract",
    local_absent_detail="local llm-tools contract owner is absent",
    exact_proof_error="exact llm-tools proof must name one pytest node",
    no_selection_detail="no selected local llm-tools contract proof",
    success_detail="local llm-tools contract and pinned llm-tools suite passed",
    verification_commands=(
        *_PINNED_PYTHON_VERIFICATION,
        ("uv", "build", "--no-sources", "--offline"),
    ),
)


@dataclass(frozen=True, slots=True)
class CapabilityContext:
    repo_root: Path
    workflow: Workflow
    selection: tuple[Selection, ...]
    ui: bool = False
    proven_proofs: frozenset[str] = frozenset()
    proof_id: str | None = None
    sensitivity_attempt: str | None = None
    run_context: RunContextRecorder | None = None
    candidate_sha: str | None = None

    def __post_init__(self) -> None:
        if self.sensitivity_attempt not in {None, "red", "green"}:
            raise ValueError("capability sensitivity attempt is unknown")
        if self.sensitivity_attempt is not None and self.proof_id is None:
            raise ValueError("sensitivity capability context must name its proof")
        if (
            self.candidate_sha is not None
            and re.fullmatch(r"[0-9a-f]{40}", self.candidate_sha) is None
        ):
            raise ValueError("capability candidate SHA must be canonical")


@dataclass(frozen=True, slots=True)
class CapabilityResult:
    evidence: CapabilityEvidence
    detail: str

    def __post_init__(self) -> None:
        if not self.detail.strip():
            raise ValueError("capability result detail must not be blank")
        if self.evidence.detail != self.detail:
            object.__setattr__(self, "evidence", replace(self.evidence, detail=self.detail))


@dataclass(frozen=True, slots=True)
class WorkflowRun:
    capabilities: tuple[CapabilityEvidence, ...]
    peak_owned_mib: PeakOwnedMemory


class FirstFailureReporter:
    """Publish one bounded, redacted, machine-classified failure line."""

    def __init__(self, secrets: Iterable[str] = ()) -> None:
        self._secrets = tuple(secrets)
        self._reported = False
        self._started_ns: int | None = None
        self.first_actionable_failure_ms: int | None = None

    def arm(self, started_ns: int) -> None:
        if self._reported or self._started_ns is not None:
            raise ValueError("first-failure reporter can be armed exactly once before reporting")
        self._started_ns = started_ns

    def report(
        self,
        stream: TextIO,
        *,
        owner: str,
        status: RunStatus,
        kind: str,
        detail: object,
    ) -> bool:
        if self._reported:
            return False
        if self._started_ns is not None:
            self.first_actionable_failure_ms = (time.monotonic_ns() - self._started_ns) // 1_000_000
        bounded = _decisive_output(redact_text(str(detail), self._secrets))
        scalar = " ".join(bounded.split()) or "no diagnostic output"
        stream.write(
            f"failure: owner={owner}; status={status.value}; kind={kind}; detail={scalar}\n"
        )
        stream.flush()
        self._reported = True
        return True


class RunContextRecorder:
    """Collect non-secret identities observed at controller launch boundaries."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._fixed_commands: list[FixedCommandIdentity] = []
        self._runtimes: set[RuntimeIdentity] = set()
        self._build_fingerprints: set[str] = set()
        self._browsers: set[BrowserIdentity] = set()

    def record_command(
        self,
        context: CapabilityContext,
        capability: Capability,
        argv: tuple[str, ...],
        cwd: Path,
        environment: Mapping[str, str],
    ) -> None:
        try:
            relative_cwd = cwd.resolve(strict=True).relative_to(
                context.repo_root.resolve(strict=True)
            )
            cwd_identity = relative_cwd.as_posix() or "."
        except (OSError, ValueError):
            cwd_identity = "@isolated"
        identity = FixedCommandIdentity(
            owner=capability,
            argv=_redacted_command_argv(argv, environment_secrets(environment)),
            cwd=cwd_identity,
            proof_id=context.proof_id,
            sensitivity_attempt=context.sensitivity_attempt,
        )
        browsers = (
            tuple(
                BrowserIdentity(name, revision)
                for name, revision in _browser_revisions(context.repo_root)
            )
            if _browser_command(argv)
            else ()
        )
        with self._lock:
            self._fixed_commands.append(identity)
            self._browsers.update(browsers)

    def record_runtime(self, context: CapabilityContext, run: TestRun) -> None:
        runtime = read_runtime(context.repo_root)
        fingerprint = _repository_template_fingerprint(context.repo_root)
        identity = RuntimeIdentity(
            repo_id=repo_id_for(context.repo_root),
            compose_project=runtime.compose_project,
            run_id=run.run_id,
            database=run_database_name(run.run_id),
            migration_database=(
                migration_database_name(run.run_id)
                if run.migration_database_url is not None
                else None
            ),
            bucket=run.bucket,
            template_fingerprint=fingerprint,
            template_database=template_database_name(fingerprint),
        )
        with self._lock:
            self._runtimes.add(identity)

    def record_build(self, fingerprint: str) -> None:
        with self._lock:
            self._build_fingerprints.add(fingerprint)

    def evidence(self) -> RunContextEvidence:
        with self._lock:
            return RunContextEvidence(
                tuple(self._fixed_commands),
                tuple(sorted(self._runtimes, key=lambda item: (item.repo_id, item.run_id))),
                tuple(sorted(self._build_fingerprints)),
                tuple(sorted(self._browsers, key=lambda item: (item.name, item.revision))),
            )


class _RunnerPorts:
    """Owned adapters for external process, service, and filesystem boundaries."""

    @contextmanager
    def heavy_lock(self, repo_root: Path) -> Iterator[Path]:
        with workspace_heavy_lock(repo_root) as path:
            yield path

    def prepare_run(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        *,
        run_id: str,
        include_migration_database: bool,
    ) -> TestRun:
        return prepare_run(
            repo_root,
            environment,
            run_id=run_id,
            include_migration_database=include_migration_database,
        )

    def clean_run(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        run_id: str,
        *,
        supabase: SupabaseCredentials,
    ) -> None:
        clean_run(repo_root, environment, run_id, supabase=supabase)

    def reset_run_data_plane(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        run: TestRun,
    ) -> None:
        reset_run_data_plane(repo_root, environment, run)

    def browser_installed(self, repo_root: Path, environment: Mapping[str, str]) -> bool:
        return _browser_installed(repo_root, environment)

    def local_docker_host(self) -> str:
        return local_docker_host()

    def run_environment(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        run: TestRun,
    ) -> dict[str, str]:
        return run_environment(repo_root, environment, run)

    def ensure_standalone_build(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        supabase_anon_key: str,
    ) -> StandaloneBuild:
        return ensure_standalone_build(repo_root, environment, supabase_anon_key)

    def create_supabase_user(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        run_id: str,
        scenario_id: str,
        supabase: SupabaseCredentials,
    ) -> TestUser:
        return create_supabase_user(repo_root, environment, run_id, scenario_id, supabase)

    def invite_supabase_user(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        run_id: str,
        scenario_id: str,
        supabase: SupabaseCredentials,
    ) -> InvitedTestUser:
        return invite_supabase_user(repo_root, environment, run_id, scenario_id, supabase)

    def grant_scenario_paid_entitlement(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        run: TestRun,
        user: TestUser,
    ) -> None:
        grant_scenario_paid_entitlement(repo_root, environment, run, user)

    def start_python_process(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        run: TestRun,
        role: str,
        *,
        overrides: Mapping[str, str] | None = None,
    ) -> StartedProcess:
        return start_python_process(repo_root, environment, run, role, overrides=overrides)

    def materialize_embedding_peer(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        run: TestRun,
    ) -> EmbeddingPeer:
        return materialize_embedding_peer(repo_root, environment, run)

    def materialize_provider_api_peer(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        run: TestRun,
    ) -> ProviderApiPeer:
        return materialize_provider_api_peer(repo_root, environment, run)

    def materialize_generation_peer(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        run: TestRun,
    ) -> CodexGenerationPeer:
        return materialize_codex_generation_peer(repo_root, environment, run)

    def start_web_process(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        run: TestRun,
        build: StandaloneBuild,
    ) -> StartedProcess:
        return start_web_process(repo_root, environment, run, build)

    def wait_process_ready(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        process: StartedProcess,
        endpoint: EndpointKind,
        path: str,
        *,
        tls_ca: Path | None = None,
    ) -> None:
        wait_process_ready(repo_root, environment, process, endpoint, path, tls_ca=tls_ca)

    def wait_generation_peer_ready(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        process: StartedProcess,
        socket_path: Path,
    ) -> None:
        wait_codex_generation_peer_ready(
            repo_root,
            environment,
            process,
            socket_path,
        )


@dataclass(slots=True)
class _WorkflowExecution:
    context: CapabilityContext
    caller_environment: Mapping[str, str]
    include_migration_database: bool
    run_id: str
    ports: _RunnerPorts = field(default_factory=_RunnerPorts)
    run: TestRun | None = None
    build: StandaloneBuild | None = None
    external_protocol_started: bool = False
    provider_api_peer: ProviderApiPeer | None = None
    journey_runtime_started: bool = False
    browser_data_plane_prepared: bool = False
    preparation_attempted: bool = False
    preparation_failure: CapabilityResult | None = None

    def ensure_external_protocol(
        self,
        capability: Capability,
        prepared: TestRun,
    ) -> CapabilityResult | None:
        if self.external_protocol_started:
            return None
        try:
            external = self.ports.start_python_process(
                self.context.repo_root,
                {"NEXUS_ENV": "test"},
                prepared,
                "external",
            )
            self.ports.wait_process_ready(
                self.context.repo_root,
                {"NEXUS_ENV": "test"},
                external,
                EndpointKind.EXTERNAL,
                "/livez",
            )
        except OSError as error:
            return _not_run(
                capability,
                f"owned external protocol could not start: {error.strerror or error}",
            )
        except RuntimeContractError as error:
            return _fail(capability, f"owned external protocol failed: {error}")
        self.external_protocol_started = True
        return None

    def ensure_provider_api_protocol(
        self,
        capability: Capability,
        prepared: TestRun,
    ) -> CapabilityResult | None:
        if self.provider_api_peer is not None:
            return None
        try:
            peer = self.ports.materialize_provider_api_peer(
                self.context.repo_root,
                {"NEXUS_ENV": "test"},
                prepared,
            )
            process = self.ports.start_python_process(
                self.context.repo_root,
                {"NEXUS_ENV": "test"},
                prepared,
                "provider-api-peer",
            )
            self.ports.wait_process_ready(
                self.context.repo_root,
                {"NEXUS_ENV": "test"},
                process,
                EndpointKind.PROVIDER_API,
                "/livez",
                tls_ca=peer.certificate,
            )
        except OSError as error:
            return _not_run(
                capability,
                f"owned provider API protocol could not start: {error.strerror or error}",
            )
        except RuntimeContractError as error:
            return _fail(capability, f"owned provider API protocol failed: {error}")
        self.provider_api_peer = peer
        return None

    def prepare(self, capability: Capability) -> TestRun | CapabilityResult:
        if self.run is not None:
            return self.run
        if self.preparation_failure is not None:
            return _result(
                capability,
                self.preparation_failure.evidence.status,
                self.preparation_failure.evidence.duration_ms,
                self.preparation_failure.detail,
            )
        if self.preparation_attempted:
            raise AssertionError("workflow preparation has no recorded outcome")
        self.preparation_attempted = True
        if not (self.context.repo_root / "python/.venv").is_dir():
            self.preparation_failure = _not_run(
                capability,
                "locked Python test environment is absent",
            )
            return self.preparation_failure
        child_environment = _child_environment(self.caller_environment)
        missing = tuple(
            tool
            for tool in ("docker", "supabase", "uv")
            if shutil.which(tool, path=child_environment.get("PATH")) is None
        )
        if missing:
            self.preparation_failure = _not_run(
                capability,
                f"local test runtime tools are absent: {', '.join(missing)}",
            )
            return self.preparation_failure
        started = time.monotonic_ns()
        try:
            self.run = self.ports.prepare_run(
                self.context.repo_root,
                {"NEXUS_ENV": "test", **child_environment},
                run_id=self.run_id,
                include_migration_database=self.include_migration_database,
            )
            if self.context.run_context is not None:
                self.context.run_context.record_runtime(self.context, self.run)
        except OSError as error:
            duration_ms = (time.monotonic_ns() - started) // 1_000_000
            self.preparation_failure = _result(
                capability,
                RunStatus.NOT_RUN,
                duration_ms,
                f"local test runtime could not start: {error.strerror or error}",
            )
            return self.preparation_failure
        except (
            BotoCoreError,
            RuntimeContractError,
            httpx.HTTPError,
            psycopg.Error,
            subprocess.CalledProcessError,
        ) as error:
            duration_ms = (time.monotonic_ns() - started) // 1_000_000
            self.preparation_failure = _result(
                capability,
                RunStatus.FAIL,
                duration_ms,
                f"local test runtime preparation failed: {error}",
            )
            return self.preparation_failure
        return self.run

    def close(self) -> None:
        if self.run is None:
            return
        run = self.run
        self.run = None
        self.ports.clean_run(
            self.context.repo_root,
            {"NEXUS_ENV": "test", **_child_environment(self.caller_environment)},
            run.run_id,
            supabase=run.supabase,
        )


def run_workflow(
    context: CapabilityContext,
    stream: TextIO,
    environment: Mapping[str, str],
    *,
    run_id: str,
    _ports: _RunnerPorts | None = None,
    _available_memory: Callable[[], int | None] = available_memory_mib,
    _monotonic: Callable[[], float] = time.monotonic,
    _wait: Callable[[float], None] = time.sleep,
    _reporter: FirstFailureReporter | None = None,
    _memory_sampler: OwnedMemorySampler | None = None,
) -> WorkflowRun:
    requirements = WORKFLOW_REGISTRY[context.workflow].requirements
    required_capabilities = {requirement.capability for requirement in requirements}
    omitted = sorted(
        {selection.capability for selection in context.selection}.difference(required_capabilities),
        key=lambda capability: capability.value,
    )
    if omitted:
        raise RuntimeContractError(
            f"{context.workflow.value} omits selected capabilities: "
            + ", ".join(capability.value for capability in omitted)
        )
    execution = _WorkflowExecution(
        context,
        environment,
        include_migration_database=any(
            requirement.capability is Capability.MIGRATIONS
            and _capability_is_selected(context, Capability.MIGRATIONS)
            for requirement in requirements
        ),
        run_id=run_id,
        ports=_ports or _RunnerPorts(),
    )
    reporter = _reporter or FirstFailureReporter(environment_secrets(environment))

    def results() -> Iterable[CapabilityResult]:
        nonlocal heavy_lock_held
        blocked_by: Capability | None = None

        def run_requirement(capability: Capability) -> CapabilityResult:
            if not _requires_memory_admission(context, capability):
                return _run_capability(
                    context,
                    capability,
                    environment,
                    execution,
                    heavy_lock_held=heavy_lock_held,
                )

            def admitted_run() -> CapabilityResult:
                admission = _await_heavy_memory_admission(
                    capability,
                    _available_memory,
                    monotonic=_monotonic,
                    wait=_wait,
                )
                return admission or _run_capability(
                    context,
                    capability,
                    environment,
                    execution,
                    heavy_lock_held=True,
                )

            if heavy_lock_held:
                return admitted_run()
            with execution.ports.heavy_lock(context.repo_root):
                return admitted_run()

        try:
            for requirement in requirements:
                if blocked_by is not None:
                    yield _not_run(
                        requirement.capability,
                        f"blocked by earlier {blocked_by.value} result",
                    )
                    continue
                if (
                    requirement.capability in _HEAVY_CAPABILITIES
                    and _capability_is_selected(context, requirement.capability)
                    and not heavy_lock_held
                ):
                    workflow_lifecycle.enter_context(execution.ports.heavy_lock(context.repo_root))
                    heavy_lock_held = True
                    if measures_containers:
                        workflow_sampler.enable_containers(context.repo_root)
                result = run_requirement(requirement.capability)
                memory = workflow_sampler.checkpoint()
                measured_result = CapabilityResult(
                    replace(result.evidence, peak_owned_mib=memory.total),
                    result.detail,
                )
                yield measured_result
                if measured_result.evidence.status is not RunStatus.PASS:
                    blocked_by = requirement.capability
        finally:
            try:
                if measures_containers and heavy_lock_held:
                    workflow_sampler.disable_containers(context.repo_root)
            finally:
                execution.close()

    heavy_lock_held = False
    measures_containers = any(
        capability in _LOCAL_RUNTIME_CAPABILITIES and _capability_is_selected(context, capability)
        for capability in required_capabilities
    )
    owns_sampler = _memory_sampler is None
    sampler_lifecycle = (
        measure_owned_memory(
            context.repo_root,
            # The process sampler may run while this workflow waits. Container
            # sampling begins only after the workflow owns the heavy-work lock,
            # so queued workflows cannot measure or contend on another run.
            include_containers=False,
        )
        if owns_sampler
        else nullcontext(_memory_sampler)
    )
    with ExitStack() as workflow_lifecycle:
        with sampler_lifecycle as workflow_sampler:
            if workflow_sampler is None:
                raise AssertionError("workflow owned-memory sampler is absent")
            workflow_sampler.checkpoint()
            capabilities = tuple(
                result.evidence
                for result in stream_first_failure(
                    results(),
                    stream,
                    environment_secrets(environment),
                    reporter=reporter,
                )
            )
    workflow_memory = measured(workflow_sampler) if owns_sampler else workflow_sampler.snapshot()
    if not workflow_memory.measurement_complete and all(
        item.status is RunStatus.PASS for item in capabilities
    ):
        detail = workflow_sampler.failure_detail or (
            "owned memory could not be measured truthfully"
        )
        reporter.report(
            stream,
            owner="memory",
            status=RunStatus.FAIL,
            kind="measurement_failure",
            detail=detail,
        )
        last = capabilities[-1]
        capabilities = (
            *capabilities[:-1],
            replace(
                last,
                status=RunStatus.FAIL,
                detail=detail,
            ),
        )
    return WorkflowRun(capabilities, workflow_memory)


def stream_first_failure(
    results: Iterable[CapabilityResult],
    stream: TextIO,
    secrets: Iterable[str] = (),
    *,
    reporter: FirstFailureReporter | None = None,
) -> Iterable[CapabilityResult]:
    active_reporter = reporter or FirstFailureReporter(secrets)
    for result in results:
        if result.evidence.status is not RunStatus.PASS:
            active_reporter.report(
                stream,
                owner=result.evidence.id.value,
                status=result.evidence.status,
                kind=_capability_failure_kind(result),
                detail=result.detail,
            )
        yield result


def _capability_failure_kind(result: CapabilityResult) -> str:
    match = re.match(r"proof_result=([^|]+)\|", result.detail)
    if match is not None:
        return match.group(1)
    if result.evidence.status is RunStatus.NOT_RUN:
        return "capability_not_run"
    return "capability_failure"


def run_capability(
    context: CapabilityContext,
    capability: Capability,
    environment: Mapping[str, str] | None = None,
) -> CapabilityResult:
    return _run_capability(context, capability, environment or {}, None)


def run_proof(
    context: CapabilityContext,
    proof_id: str,
    environment: Mapping[str, str],
    *,
    _ports: _RunnerPorts | None = None,
    _available_memory: Callable[[], int | None] = available_memory_mib,
    _monotonic: Callable[[], float] = time.monotonic,
    _wait: Callable[[float], None] = time.sleep,
    _memory_sampler: OwnedMemorySampler | None = None,
) -> CapabilityResult:
    """Run one exact runner-qualified proof under its final ownership boundary."""
    try:
        runner_name, separator, node = proof_id.partition(":")
        if not separator or not node:
            raise ValueError("proof id must be runner-qualified")
        capability, workflow = _proof_owner(runner_name, node)
        path = node.split("::", 1)[0]
        proof_context = CapabilityContext(
            context.repo_root,
            workflow,
            (
                Selection(
                    path,
                    capability,
                    SelectionReason.EXPLICIT_FOCUS,
                    proof_id,
                ),
            ),
            ui=context.ui,
            proof_id=context.proof_id or proof_id,
            sensitivity_attempt=context.sensitivity_attempt,
            run_context=context.run_context,
            candidate_sha=context.candidate_sha,
        )
    except ValueError as error:
        return _not_run(Capability.POLICY, f"exact proof is not executable: {error}")
    if not (context.repo_root / path).is_file():
        return _not_run(capability, f"exact proof owner is absent: {path}")

    ports = _ports or _RunnerPorts()
    lifecycle = ExitStack()
    container_owner_enabled = False
    try:
        memory_lock_held = capability in _MEMORY_ADMITTED_CAPABILITIES
        if memory_lock_held:
            lifecycle.enter_context(ports.heavy_lock(context.repo_root))
        container_owner_enabled = (
            _memory_sampler is not None
            and memory_lock_held
            and capability in _LOCAL_RUNTIME_CAPABILITIES
        )
        if container_owner_enabled and _memory_sampler is not None:
            _memory_sampler.enable_containers(context.repo_root)
        admission = _await_heavy_memory_admission(
            capability,
            _available_memory,
            monotonic=_monotonic,
            wait=_wait,
        )
        if admission is not None:
            return admission
        execution = _WorkflowExecution(
            proof_context,
            environment,
            include_migration_database=capability is Capability.MIGRATIONS,
            run_id=new_run_id(),
            ports=ports,
        )
        lifecycle.callback(execution.close)
        match capability:
            case Capability.KERNEL_PYTHON | Capability.KERNEL_WEB:
                result = _run_capability(
                    proof_context,
                    capability,
                    environment,
                    None,
                    heavy_lock_held=memory_lock_held,
                )
            case Capability.SERVICE:
                result = _run_python_heavy(
                    proof_context,
                    capability,
                    environment,
                    execution,
                    owner="tests/service",
                    exact=True,
                )
            case Capability.MIGRATIONS:
                result = _run_python_heavy(
                    proof_context,
                    capability,
                    environment,
                    execution,
                    owner="tests/migrations",
                    exact=True,
                )
            case Capability.LLM_EVAL:
                result = _run_python_heavy(
                    proof_context,
                    capability,
                    environment,
                    execution,
                    owner="tests/evals",
                    exact=True,
                )
            case Capability.PROVIDER_RUNTIME:
                result = _run_provider_runtime(
                    proof_context,
                    environment,
                    exact=True,
                )
            case Capability.LLM_TOOLS:
                result = _run_llm_tools(
                    proof_context,
                    environment,
                    exact=True,
                )
            case Capability.INGEST_NODE:
                result = _run_ingest_node(proof_context, environment, exact=True)
            case Capability.RELEASE_ARTIFACT:
                result = _run_release_artifact_proofs(
                    proof_context,
                    environment,
                    execution,
                    exact=True,
                )
            case Capability.COMPONENT:
                result = _run_component(proof_context, environment, execution, exact=True)
            case Capability.JOURNEYS_ALL:
                result = _run_journeys(
                    proof_context,
                    capability,
                    environment,
                    execution,
                    exact=True,
                )
            case Capability.EXTENSION:
                result = _run_extension(
                    proof_context,
                    environment,
                    execution,
                    exact=True,
                )
            case Capability.ANDROID_DEVICE:
                result = _run_android_device_exact(proof_context, node, environment)
            case Capability.ANDROID_HOST:
                result = _run_android_host(proof_context, environment)
            case Capability.AUDIT:
                result = _run_audit(proof_context, environment, execution, exact=True)
            case _:
                result = _not_run(capability, "exact proof owner has no executor")
        return _classified_exact_result(result, proof_id)
    finally:
        try:
            if container_owner_enabled and _memory_sampler is not None:
                _memory_sampler.disable_containers(context.repo_root)
        finally:
            lifecycle.close()


def _run_capability(
    context: CapabilityContext,
    capability: Capability,
    environment: Mapping[str, str],
    execution: _WorkflowExecution | None,
    *,
    heavy_lock_held: bool = False,
) -> CapabilityResult:
    if capability in _MEMORY_ADMITTED_CAPABILITIES and not heavy_lock_held:
        with workspace_heavy_lock(context.repo_root):
            return _run_capability_unlocked(context, capability, environment, execution)
    return _run_capability_unlocked(context, capability, environment, execution)


def _heavy_memory_admission(
    capability: Capability, available_mib: int | None
) -> CapabilityResult | None:
    if capability not in _MEMORY_ADMITTED_CAPABILITIES:
        return None
    if available_mib is None:
        return _not_run(
            capability,
            "heavy memory admission could not determine available memory",
        )
    if available_mib >= _MIN_AVAILABLE_HEAVY_MIB:
        return None
    return _not_run(
        capability,
        "heavy memory admission requires "
        f"{_MIN_AVAILABLE_HEAVY_MIB} MiB available; observed {available_mib} MiB",
    )


def _await_heavy_memory_admission(
    capability: Capability,
    available_memory: Callable[[], int | None],
    *,
    monotonic: Callable[[], float],
    wait: Callable[[float], None],
) -> CapabilityResult | None:
    """Wait before launch for the host-safety condition; never rerun proof work."""
    if capability not in _MEMORY_ADMITTED_CAPABILITIES:
        return None
    available_mib = available_memory()
    admission = _heavy_memory_admission(capability, available_mib)
    if admission is None or available_mib is None:
        return admission
    deadline = monotonic() + _MEMORY_ADMISSION_TIMEOUT_SECONDS
    # justify-polling: kernel memory availability has no portable event
    # notification; sample the launch condition every 250 ms for at most 30
    # seconds before failing closed.
    while available_mib < _MIN_AVAILABLE_HEAVY_MIB:
        remaining = deadline - monotonic()
        if remaining <= 0:
            return admission
        wait(min(_MEMORY_ADMISSION_POLL_SECONDS, remaining))
        available_mib = available_memory()
        admission = _heavy_memory_admission(capability, available_mib)
        if admission is None or available_mib is None:
            return admission
    return admission


def _requires_memory_admission(context: CapabilityContext, capability: Capability) -> bool:
    if capability not in _MEMORY_ADMITTED_CAPABILITIES:
        return False
    if capability is Capability.STATIC_WEB:
        return _scope(context, capability) is SelectionScope.COMPLETE or any(
            selection.path in _WEB_STATIC_PROMOTERS
            or selection.path.startswith("apps/web/")
            and selection.path.endswith(_WEB_STATIC_SUFFIXES)
            for selection in context.selection
        )
    return _capability_is_selected(context, capability)


def _run_capability_unlocked(
    context: CapabilityContext,
    capability: Capability,
    environment: Mapping[str, str],
    execution: _WorkflowExecution | None,
) -> CapabilityResult:
    required = {
        requirement.capability for requirement in WORKFLOW_REGISTRY[context.workflow].requirements
    }
    if capability not in required:
        raise ValueError(f"{capability.value} is not required by workflow {context.workflow.value}")
    if _scope(context, capability) is SelectionScope.AFFECTED and not _capability_is_selected(
        context, capability
    ):
        return _pass(capability, f"no selected {capability.value} proof")
    caller_environment = environment
    match capability:
        case Capability.POLICY:
            return _run_policy(context)
        case Capability.POLICY_SELF_TESTS:
            return _run_policy_self_tests(context, caller_environment)
        case Capability.STATIC_PYTHON:
            return _run_static_python(context, caller_environment)
        case Capability.STATIC_WEB:
            return _run_static_web(context, caller_environment)
        case Capability.STATIC_WORKFLOWS:
            return _run_static_workflows(context, caller_environment)
        case Capability.STATIC_PLATFORM:
            return _run_static_platform(context, caller_environment)
        case Capability.KERNEL_PYTHON:
            return _run_kernel_python(context, caller_environment)
        case Capability.KERNEL_WEB:
            return _run_kernel_web(context, caller_environment)
        case Capability.SENSITIVITY:
            return _run_sensitivity_gate(context)
        case Capability.SERVICE:
            return _run_python_heavy(
                context,
                capability,
                caller_environment,
                execution,
                owner="tests/service",
            )
        case Capability.COMPONENT:
            return _run_component(context, caller_environment, execution)
        case Capability.MIGRATIONS:
            return _run_python_heavy(
                context,
                capability,
                caller_environment,
                execution,
                owner="tests/migrations",
            )
        case Capability.BUNDLE:
            return _run_bundle(context, execution)
        case Capability.JOURNEYS_CRITICAL:
            return _run_journeys(context, capability, caller_environment, execution)
        case Capability.JOURNEYS_ALL:
            return _run_journeys(context, capability, caller_environment, execution)
        case Capability.CORPUS:
            return _run_corpus(context)
        case Capability.PROVIDER_RUNTIME:
            return _run_provider_runtime(context, caller_environment)
        case Capability.LLM_TOOLS:
            return _run_llm_tools(context, caller_environment)
        case Capability.INGEST_NODE:
            return _run_ingest_node(context, caller_environment)
        case Capability.LLM_EVAL:
            return _run_python_heavy(
                context,
                capability,
                caller_environment,
                execution,
                owner="tests/evals",
            )
        case Capability.EXTENSION:
            return _run_extension(context, caller_environment, execution)
        case Capability.ANDROID_HOST:
            return _run_android_host(context, caller_environment)
        case Capability.AUDIT:
            return _run_audit(context, caller_environment, execution)
        case Capability.ANDROID_DEVICE:
            return _run_android_device(context, caller_environment)
        case Capability.ANDROID_RELEASE:
            return _run_android_release(context, caller_environment, execution)
        case Capability.RELEASE_ARTIFACT:
            return _run_release_artifact(context, caller_environment, execution)
        case Capability.DOCTOR:
            return _run_doctor(context, caller_environment)
        case Capability.ANDROID_VISUAL:
            return _run_android_visual(context, caller_environment, execution)
        case _ as unreachable:
            assert_never(unreachable)


def _run_sensitivity_gate(context: CapabilityContext) -> CapabilityResult:
    required = {
        selection.proof
        for selection in context.selection
        if selection.sensitivity_required and selection.proof is not None
    }
    missing = sorted(required.difference(context.proven_proofs))
    if missing:
        return _fail(
            Capability.SENSITIVITY,
            f"materially changed proofs lack same-run red/green evidence: {missing}",
        )
    return _pass(
        Capability.SENSITIVITY,
        f"{len(required)} materially changed proof{'s' if len(required) != 1 else ''} are sensitive",
    )


def _run_policy(context: CapabilityContext) -> CapabilityResult:
    started = time.monotonic_ns()
    complete = _scope(context, Capability.POLICY) is SelectionScope.COMPLETE or any(
        selection.path in _POLICY_INFRASTRUCTURE
        or selection.path.startswith("python/nexus_test_control/")
        for selection in context.selection
    )
    selected_paths = {selection.path for selection in context.selection}
    violations: list[PolicyViolation] = []

    if complete:
        violations.extend(repository_violations(context.repo_root))
        violations.extend(proof_contract_violations(context.repo_root))
        violations.extend(fault_manifest_violations(context.repo_root))
        violations.extend(corpus_violations(context.repo_root))
        violations.extend(resource_capability_projection_violations(context.repo_root))
        python_paths = _complete_python_policy_paths(context.repo_root)
    else:
        if selected_paths.intersection(
            {
                "Makefile",
                "python/pyproject.toml",
                "apps/web/vitest.config.ts",
                "apps/web/e2e/playwright.config.ts",
            }
        ) or any(
            path.startswith((".github/", "docs/local-rules/", "docs/rules/"))
            for path in selected_paths
        ):
            violations.extend(repository_violations(context.repo_root))
        if "testdata/proofs.json" in selected_paths:
            violations.extend(proof_contract_violations(context.repo_root))
        if any(path.startswith("testdata/faults/") for path in selected_paths):
            violations.extend(fault_manifest_violations(context.repo_root))
        if "testdata/manifest.json" in selected_paths:
            violations.extend(corpus_violations(context.repo_root))
        if selected_paths.intersection(
            {
                "python/nexus/services/resource_items/capabilities.py",
                "apps/web/src/lib/resources/resourceCapabilities.ts",
            }
        ):
            violations.extend(resource_capability_projection_violations(context.repo_root))
        python_paths = tuple(
            context.repo_root / path
            for path in sorted(selected_paths)
            if path.endswith(".py")
            and path.startswith(("python/tests/", "python/nexus_test_control/"))
            and (context.repo_root / path).is_file()
        )

    exception_path = context.repo_root / "testdata/policy-exceptions.json"
    if exception_path.is_file():
        violations.extend(exception_violations(context.repo_root, date.today()))

    for path in python_paths:
        relative = path.relative_to(context.repo_root).as_posix()
        try:
            source = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            violations.append(PolicyViolation("python-source", relative, str(error)))
        else:
            violations.extend(python_ast_violations(relative, source))
    duration_ms = (time.monotonic_ns() - started) // 1_000_000
    if violations:
        violation = sorted(violations, key=lambda item: (item.path, item.line or 0, item.rule))[0]
        location = f"{violation.path}:{violation.line}" if violation.line else violation.path
        remainder = f" (+{len(violations) - 1} more)" if len(violations) > 1 else ""
        return _result(
            Capability.POLICY,
            RunStatus.FAIL,
            duration_ms,
            f"{location}: {violation.rule}: {violation.message}{remainder}",
        )
    if exception_path.is_file():
        exceptions = json.loads(exception_path.read_text(encoding="utf-8"))["exceptions"]
        if exceptions:
            nodes = tuple(exception["node"] for exception in exceptions)
            return _result(
                Capability.POLICY,
                RunStatus.NOT_RUN,
                duration_ms,
                f"active quarantines prevent a green gate: {nodes}",
            )
    return _result(Capability.POLICY, RunStatus.PASS, duration_ms, "policy checks passed")


def _complete_python_policy_paths(repo_root: Path) -> tuple[Path, ...]:
    paths: set[Path] = set()
    for relative in _PYTHON_POLICY_DIRS:
        owner = repo_root / relative
        if owner.is_dir():
            paths.update(path for path in owner.rglob("*.py") if path.is_file())
    for relative in ("python/tests/conftest.py",):
        path = repo_root / relative
        if path.is_file():
            paths.add(path)
    return tuple(sorted(paths))


def _run_policy_self_tests(
    context: CapabilityContext, environment: Mapping[str, str]
) -> CapabilityResult:
    owner = context.repo_root / "python/tests/kernel/nexus_test_control/test_policy.py"
    web_owner = context.repo_root / "apps/web/scripts/test-eslint-policy.mjs"
    if (
        not owner.is_file()
        or not (context.repo_root / "python/.venv").is_dir()
        or not web_owner.is_file()
        or not (context.repo_root / "apps/web/node_modules").is_dir()
    ):
        return _not_run(Capability.POLICY_SELF_TESTS, "policy self-test owner is absent")
    return _run_fixed_commands(
        Capability.POLICY_SELF_TESTS,
        (
            (
                (
                    "uv",
                    "run",
                    "--frozen",
                    "--no-sync",
                    "pytest",
                    *_DETERMINISTIC_PYTEST,
                    "tests/kernel/nexus_test_control/test_policy.py",
                ),
                context.repo_root / "python",
            ),
            (
                ("bun", "run", "test:eslint-policy"),
                context.repo_root / "apps/web",
            ),
        ),
        environment,
        ("bun", "uv"),
        context=context,
    )


def _run_static_python(
    context: CapabilityContext, environment: Mapping[str, str]
) -> CapabilityResult:
    python_root = context.repo_root / "python"
    if not (python_root / "pyproject.toml").is_file() or not (python_root / ".venv").is_dir():
        return _not_run(Capability.STATIC_PYTHON, "Python static owner is absent")
    complete = _scope(context, Capability.STATIC_PYTHON) is SelectionScope.COMPLETE or any(
        selection.path in _PYTHON_STATIC_PROMOTERS for selection in context.selection
    )
    external_arguments = tuple(f"../{path}" for path in _EXTERNAL_PYTHON_OWNERS)
    if complete:
        commands: tuple[FixedCommand, ...] = (
            (
                (
                    "uv",
                    "run",
                    "--frozen",
                    "--no-sync",
                    "ruff",
                    "check",
                    ".",
                    *external_arguments,
                ),
                python_root,
            ),
            (
                (
                    "uv",
                    "run",
                    "--frozen",
                    "--no-sync",
                    "ruff",
                    "format",
                    "--check",
                    ".",
                    *external_arguments,
                ),
                python_root,
            ),
            (("uv", "run", "--frozen", "--no-sync", "pyright"), python_root),
            (
                ("uv", "run", "--frozen", "--no-sync", "pyright", *external_arguments),
                python_root,
            ),
        )
    else:
        paths = set(_selected_files(context, "python/", (".py",)))
        for owner in _EXTERNAL_PYTHON_OWNERS:
            if (
                any(selection.path == owner for selection in context.selection)
                and (context.repo_root / owner).is_file()
            ):
                paths.add(owner)
        if not paths:
            return _pass(Capability.STATIC_PYTHON, "no selected Python static input")
        relative = tuple(
            f"../{path}" if path in _EXTERNAL_PYTHON_OWNERS else f"./{path.removeprefix('python/')}"
            for path in sorted(paths)
        )
        commands = (
            (
                ("uv", "run", "--frozen", "--no-sync", "ruff", "check", *relative),
                python_root,
            ),
            (
                (
                    "uv",
                    "run",
                    "--frozen",
                    "--no-sync",
                    "ruff",
                    "format",
                    "--check",
                    *relative,
                ),
                python_root,
            ),
            (("uv", "run", "--frozen", "--no-sync", "pyright", *relative), python_root),
        )
    return _run_fixed_commands(
        Capability.STATIC_PYTHON,
        commands,
        environment,
        ("uv",),
        context=context,
    )


def _run_static_web(context: CapabilityContext, environment: Mapping[str, str]) -> CapabilityResult:
    web_root = context.repo_root / "apps/web"
    if not (web_root / "package.json").is_file() or not (web_root / "node_modules").is_dir():
        return _not_run(Capability.STATIC_WEB, "web static owner is absent")
    complete = _scope(context, Capability.STATIC_WEB) is SelectionScope.COMPLETE or any(
        selection.path in _WEB_STATIC_PROMOTERS for selection in context.selection
    )
    if complete:
        commands: tuple[FixedCommand, ...] = (
            (("bun", "run", "lint:css-tokens"), web_root),
            (("bun", "run", "lint"), web_root),
            (("bun", "run", "typecheck"), web_root),
        )
    else:
        paths = _selected_files(context, "apps/web/", _WEB_STATIC_SUFFIXES)
        if not paths:
            return _pass(Capability.STATIC_WEB, "no selected web static input")
        # Stylesheets belong to the token owner; ESLint has no configuration for
        # them, so passing one would fail the `--max-warnings 0` command on its
        # own "File ignored" warning.
        scripts = tuple(
            f"./{path.removeprefix('apps/web/')}" for path in paths if not path.endswith(".css")
        )
        commands = (
            ((("bun", "run", "eslint", "--max-warnings", "0", *scripts), web_root),)
            if scripts
            else ()
        )
        if len(scripts) != len(paths):
            commands = ((("bun", "run", "lint:css-tokens"), web_root), *commands)
    return _run_fixed_commands(
        Capability.STATIC_WEB,
        commands,
        environment,
        ("bun",),
        context=context,
    )


def _run_static_workflows(
    context: CapabilityContext, environment: Mapping[str, str]
) -> CapabilityResult:
    workflow_root = context.repo_root / ".github/workflows"
    complete = _scope(context, Capability.STATIC_WORKFLOWS) is SelectionScope.COMPLETE
    if complete:
        paths = tuple(
            path.relative_to(context.repo_root).as_posix()
            for path in sorted((*workflow_root.glob("*.yml"), *workflow_root.glob("*.yaml")))
            if path.is_file()
        )
    else:
        paths = tuple(
            path for path in _selected_files(context, ".github/workflows/", (".yml", ".yaml"))
        )
    if not paths:
        if complete:
            return _not_run(Capability.STATIC_WORKFLOWS, "workflow static owner is absent")
        return _pass(Capability.STATIC_WORKFLOWS, "no selected workflow static input")
    if not (context.repo_root / "python/.venv").is_dir():
        return _not_run(Capability.STATIC_WORKFLOWS, "workflow static tools are absent")
    root_paths = tuple(f"./{path}" for path in paths)
    python_paths = tuple(f"../{path}" for path in paths)
    return _run_fixed_commands(
        Capability.STATIC_WORKFLOWS,
        (
            (("actionlint", *root_paths), context.repo_root),
            (
                ("uv", "run", "--frozen", "--no-sync", "zizmor", *python_paths),
                context.repo_root / "python",
            ),
        ),
        environment,
        ("actionlint", "uv"),
        context=context,
    )


def _run_static_platform(
    context: CapabilityContext, environment: Mapping[str, str]
) -> CapabilityResult:
    complete = _scope(context, Capability.STATIC_PLATFORM) is SelectionScope.COMPLETE
    selected = (
        set(_PLATFORM_STATIC_OWNERS)
        if complete
        else {
            selection.path
            for selection in context.selection
            if selection.path in _PLATFORM_STATIC_OWNERS
        }
    )
    if not selected:
        return _pass(Capability.STATIC_PLATFORM, "no selected platform static input")

    required_owners = set(selected)
    if required_owners.intersection(_PLATFORM_LOCAL_COMPOSE_OWNERS):
        required_owners.update(_PLATFORM_LOCAL_COMPOSE_OWNERS)
    missing = tuple(
        path for path in sorted(required_owners) if not (context.repo_root / path).is_file()
    )
    if missing:
        prefix = "platform static owner" if complete else "selected platform static owner"
        return _not_run(Capability.STATIC_PLATFORM, f"{prefix} is absent: {', '.join(missing)}")

    commands: list[FixedCommand] = []
    required_tools: set[str] = set()
    shell_paths = tuple(f"./{path}" for path in _PLATFORM_SHELL_OWNERS if path in selected)
    if shell_paths:
        commands.extend(
            (
                (("bash", "-n", *shell_paths), context.repo_root),
                (("shellcheck", *shell_paths), context.repo_root),
            )
        )
        required_tools.update(("bash", "shellcheck"))

    if _PLATFORM_PRODUCTION_COMPOSE_OWNER in selected:
        commands.append(
            (
                (
                    "env",
                    *_PLATFORM_PRODUCTION_COMPOSE_ENV,
                    "docker",
                    "compose",
                    "--project-name",
                    "nexus-static-production",
                    "--file",
                    f"./{_PLATFORM_PRODUCTION_COMPOSE_OWNER}",
                    "config",
                    "--quiet",
                ),
                context.repo_root,
            )
        )
        required_tools.update(("docker", "env"))

    if selected.intersection(_PLATFORM_LOCAL_COMPOSE_OWNERS):
        commands.append(
            (
                (
                    "env",
                    *_PLATFORM_LOCAL_COMPOSE_ENV,
                    "docker",
                    "compose",
                    "--project-name",
                    "nexus-static-local-worker",
                    "--file",
                    f"./{_PLATFORM_LOCAL_COMPOSE_OWNERS[0]}",
                    "--file",
                    f"./{_PLATFORM_LOCAL_COMPOSE_OWNERS[1]}",
                    "config",
                    "--quiet",
                ),
                context.repo_root,
            )
        )
        required_tools.update(("docker", "env"))

    if _PLATFORM_CLOUD_INIT_OWNER in selected:
        commands.append(
            (
                (
                    "cloud-init",
                    "schema",
                    "--config-file",
                    f"./{_PLATFORM_CLOUD_INIT_OWNER}",
                ),
                context.repo_root,
            )
        )
        required_tools.add("cloud-init")

    if _PLATFORM_BACKEND_DOCKERFILE_OWNER in selected:
        commands.extend(
            (
                (
                    "docker",
                    "buildx",
                    "build",
                    "--check",
                    "--file",
                    f"./{_PLATFORM_BACKEND_DOCKERFILE_OWNER}",
                    "--target",
                    target,
                    "--build-arg",
                    "SOURCE_SHA=" + "0" * 40,
                    ".",
                ),
                context.repo_root,
            )
            for target in ("api", "worker")
        )
        required_tools.add("docker")

    return _run_fixed_commands(
        Capability.STATIC_PLATFORM,
        tuple(commands),
        environment,
        tuple(sorted(required_tools)),
        context=context,
    )


def _run_kernel_python(
    context: CapabilityContext, environment: Mapping[str, str]
) -> CapabilityResult:
    python_root = context.repo_root / "python"
    owner = python_root / "tests/kernel"
    owners = tuple(sorted(owner.rglob("test_*.py"))) if owner.is_dir() else ()
    if not owners or not (python_root / ".venv").is_dir():
        return _not_run(Capability.KERNEL_PYTHON, "Python kernel owner is absent")
    nodes, promoted = _selected_proof_nodes(context, Capability.KERNEL_PYTHON, "pytest")
    if _scope(context, Capability.KERNEL_PYTHON) is SelectionScope.COMPLETE or promoted:
        proven_files, deselections = _python_proven_exclusions(
            context, Capability.KERNEL_PYTHON, "tests/kernel"
        )
        targets = tuple(
            f"./{path.relative_to(python_root).as_posix()}"
            for path in owners
            if path.relative_to(context.repo_root).as_posix() not in proven_files
        )
        if not targets:
            return _pass(
                Capability.KERNEL_PYTHON,
                "complete Python kernel proof was covered by sensitivity",
            )
        deselect_argv = tuple(part for node in deselections for part in ("--deselect", f"./{node}"))
        argv = (
            "uv",
            "run",
            "--frozen",
            "--no-sync",
            "pytest",
            *_DETERMINISTIC_PYTEST,
            *targets,
            *deselect_argv,
        )
    elif nodes:
        argv = (
            "uv",
            "run",
            "--frozen",
            "--no-sync",
            "pytest",
            *_DETERMINISTIC_PYTEST,
            "--",
            *tuple(_python_proof_node(node) for node in nodes),
        )
    else:
        return _pass(Capability.KERNEL_PYTHON, "no selected Python kernel proof")
    return _run_fixed_commands(
        Capability.KERNEL_PYTHON,
        ((argv, python_root),),
        environment,
        ("uv",),
        pythonpath=python_root,
        context=context,
    )


def _run_kernel_web(context: CapabilityContext, environment: Mapping[str, str]) -> CapabilityResult:
    web_root = context.repo_root / "apps/web"
    owners = tuple(
        sorted(
            path
            for path in (web_root / "src").rglob("*")
            if path.is_file() and path.name.endswith((".unit.test.ts", ".unit.test.tsx"))
        )
    )
    if not owners or not (web_root / "node_modules").is_dir():
        return _not_run(Capability.KERNEL_WEB, "web kernel owner is absent")
    nodes, promoted = _selected_proof_nodes(context, Capability.KERNEL_WEB, "vitest")
    proven_paths = {
        node.split("::", 1)[0] for node in _proven_nodes(context, Capability.KERNEL_WEB, "vitest")
    }
    if _scope(context, Capability.KERNEL_WEB) is SelectionScope.COMPLETE or promoted:
        remaining = tuple(
            f"./{path.relative_to(web_root).as_posix()}"
            for path in owners
            if path.relative_to(context.repo_root).as_posix() not in proven_paths
        )
        if not remaining:
            return _pass(
                Capability.KERNEL_WEB, "complete web kernel proof was covered by sensitivity"
            )
        argv = ("bun", "run", "test:unit", "--", *remaining)
    elif nodes:
        argv = (
            "bun",
            "run",
            "test:unit",
            "--",
            *tuple(_web_proof_path(node) for node in nodes),
        )
    else:
        return _pass(Capability.KERNEL_WEB, "no selected web kernel proof")
    return _run_fixed_commands(
        Capability.KERNEL_WEB,
        ((argv, web_root),),
        environment,
        ("bun",),
        context=context,
    )


def _run_python_heavy(
    context: CapabilityContext,
    capability: Capability,
    environment: Mapping[str, str],
    execution: _WorkflowExecution | None,
    *,
    owner: str,
    exact: bool = False,
) -> CapabilityResult:
    python_root = context.repo_root / "python"
    owner_path = python_root / owner
    owner_files = tuple(sorted(owner_path.rglob("test_*.py"))) if owner_path.is_dir() else ()
    if not owner_files or not (python_root / ".venv").is_dir():
        return _not_run(capability, f"Python {capability.value} proof owner is absent")
    nodes, promoted = _selected_proof_nodes(context, capability, "pytest")
    if exact:
        if not nodes or promoted:
            raise ValueError("exact Python proof must name one pytest node")
        targets = tuple(_python_heavy_node(node, owner) for node in nodes)
    elif _scope(context, capability) is SelectionScope.COMPLETE or promoted:
        proven_files, deselections = _python_proven_exclusions(context, capability, owner)
        targets = tuple(
            f"./{path.relative_to(python_root).as_posix()}"
            for path in owner_files
            if path.relative_to(context.repo_root).as_posix() not in proven_files
        )
        if not targets:
            return _pass(
                capability, f"complete Python {capability.value} proof was covered by sensitivity"
            )
        targets = (
            *targets,
            *(part for node in deselections for part in ("--deselect", f"./{node}")),
        )
    elif nodes:
        targets = tuple(_python_heavy_node(node, owner) for node in nodes)
    else:
        return _pass(capability, f"no selected Python {capability.value} proof")
    prepared = _prepared_run(execution, capability)
    if isinstance(prepared, CapabilityResult):
        return prepared
    if execution is None:
        raise AssertionError("prepared run exists without workflow execution")
    if capability in _PROVIDER_API_PROTOCOL_CAPABILITIES:
        provider_failure = execution.ensure_provider_api_protocol(capability, prepared)
        if provider_failure is not None:
            return provider_failure
    if capability in _EXTERNAL_PROTOCOL_CAPABILITIES:
        protocol_failure = execution.ensure_external_protocol(capability, prepared)
        if protocol_failure is not None:
            return protocol_failure
    child_environment = _heavy_environment(context, environment, prepared, execution.ports)
    return _run_owned_commands(
        capability,
        (
            (
                (
                    "uv",
                    "run",
                    "--frozen",
                    "--no-sync",
                    "pytest",
                    *_DETERMINISTIC_PYTEST,
                    *targets,
                ),
                python_root,
            ),
        ),
        child_environment,
        ("uv",),
        context=context,
    )


def _run_release_artifact_proofs(
    context: CapabilityContext,
    environment: Mapping[str, str],
    execution: _WorkflowExecution,
    *,
    exact: bool = False,
) -> CapabilityResult:
    capability = Capability.RELEASE_ARTIFACT
    python_root = context.repo_root / "python"
    owner = "tests/release_artifact"
    owner_path = python_root / owner
    owner_files = tuple(sorted(owner_path.rglob("test_*.py"))) if owner_path.is_dir() else ()
    if not owner_files or not (python_root / ".venv").is_dir():
        return _not_run(capability, "release artifact Python proof owner is absent")
    nodes, promoted = _selected_proof_nodes(context, capability, "pytest")
    if exact:
        if len(nodes) != 1 or promoted:
            raise ValueError("exact release artifact proof must name one pytest node")
        targets = tuple(_python_heavy_node(node, owner) for node in nodes)
    elif _scope(context, capability) is SelectionScope.COMPLETE or promoted:
        targets = tuple(f"./{path.relative_to(python_root).as_posix()}" for path in owner_files)
    elif nodes:
        targets = tuple(_python_heavy_node(node, owner) for node in nodes)
    else:
        return _pass(capability, "no selected release artifact proof")
    try:
        source_sha = _git_commit(context.repo_root, "HEAD", environment)
        docker_host = execution.ports.local_docker_host()
        image_tag = f"nexus-test-worker-{repo_id_for(context.repo_root)}:{execution.run_id}"
    except RuntimeContractError as error:
        return _not_run(capability, f"candidate worker image setup is unavailable: {error}")

    docker_prefix = (
        "env",
        f"DOCKER_HOST={docker_host}",
        "DOCKER_CONTEXT=default",
    )
    with tempfile.TemporaryDirectory(prefix=f"nexus-test-worker-{execution.run_id}-") as temporary:
        iidfile = Path(temporary) / "worker.iid"
        build = _run_fixed_commands(
            capability,
            (
                (
                    (
                        *docker_prefix,
                        "docker",
                        "buildx",
                        "build",
                        "--load",
                        "--file",
                        "./docker/Dockerfile.backend",
                        "--target",
                        "worker",
                        "--build-arg",
                        f"SOURCE_SHA={source_sha}",
                        "--tag",
                        image_tag,
                        "--iidfile",
                        str(iidfile),
                        ".",
                    ),
                    context.repo_root,
                ),
            ),
            environment,
            ("docker", "env"),
            context=context,
        )
        if build.evidence.status is not RunStatus.PASS:
            return _release_artifact_setup_result(build, "candidate worker image build")

        result: CapabilityResult | None = None
        try:
            try:
                image_id = iidfile.read_text(encoding="utf-8").strip()
            except (OSError, UnicodeDecodeError) as error:
                result = _result(
                    capability,
                    RunStatus.FAIL,
                    build.evidence.duration_ms,
                    "proof_result=setup_or_execution_failure|"
                    f"candidate worker image ID is unreadable: {error}",
                )
            else:
                if _LOCAL_IMAGE_ID_RE.fullmatch(image_id) is None:
                    result = _result(
                        capability,
                        RunStatus.FAIL,
                        build.evidence.duration_ms,
                        "proof_result=setup_or_execution_failure|"
                        "candidate worker image build did not produce an immutable image ID",
                    )
                else:
                    result = _run_fixed_commands(
                        capability,
                        (
                            (
                                (
                                    *docker_prefix,
                                    f"{_RELEASE_ARTIFACT_WORKER_IMAGE_ENV}={image_id}",
                                    "uv",
                                    "run",
                                    "--frozen",
                                    "--no-sync",
                                    "pytest",
                                    *_DETERMINISTIC_PYTEST,
                                    *targets,
                                ),
                                python_root,
                            ),
                        ),
                        environment,
                        ("docker", "env", "uv"),
                        context=context,
                        elapsed_ms=build.evidence.duration_ms,
                    )
        finally:
            elapsed_ms = (
                result.evidence.duration_ms if result is not None else build.evidence.duration_ms
            )
            cleanup = _run_fixed_commands(
                capability,
                (
                    (
                        (*docker_prefix, "docker", "image", "rm", image_tag),
                        context.repo_root,
                    ),
                ),
                environment,
                ("docker", "env"),
                context=context,
                elapsed_ms=elapsed_ms,
            )
        if cleanup.evidence.status is not RunStatus.PASS:
            return _release_artifact_setup_result(
                cleanup,
                "candidate worker image cleanup",
            )
        assert result is not None
        return CapabilityResult(
            replace(result.evidence, duration_ms=cleanup.evidence.duration_ms),
            result.detail,
        )


def _run_component(
    context: CapabilityContext,
    environment: Mapping[str, str],
    execution: _WorkflowExecution | None,
    *,
    exact: bool = False,
) -> CapabilityResult:
    capability = Capability.COMPONENT
    web_root = context.repo_root / "apps/web"
    owners = tuple(
        path
        for path in (web_root / "src").rglob("*")
        if path.is_file() and path.name.endswith((".browser.test.ts", ".browser.test.tsx"))
    )
    if not owners or not (web_root / "node_modules").is_dir():
        return _not_run(capability, "web component proof owner is absent")
    nodes, promoted = _selected_proof_nodes(context, capability, "vitest")
    argv: tuple[str, ...] | None = None
    related = _frontend_related_paths(context)
    nonrelated_promotion = any(
        selection.capability is capability
        and selection.proof is None
        and selection.reason is not SelectionReason.FRONTEND_RELATED
        for selection in context.selection
    )
    proven_paths = {node.split("::", 1)[0] for node in _proven_nodes(context, capability, "vitest")}
    if exact:
        if not nodes or promoted:
            raise ValueError("exact web component proof must name one Vitest path")
        targets = tuple(_web_component_path(node) for node in nodes)
    elif (
        _scope(context, capability) is SelectionScope.AFFECTED
        and related
        and not nonrelated_promotion
    ):
        filters = tuple(dict.fromkeys((*related, *(_web_component_path(node) for node in nodes))))
        targets = ()
        argv = (
            "bunx",
            "--no-install",
            "vitest",
            "related",
            "--run",
            "--project",
            "browser",
            *filters,
        )
    elif _scope(context, capability) is SelectionScope.COMPLETE or promoted:
        targets = tuple(
            f"./{path.relative_to(web_root).as_posix()}"
            for path in owners
            if path.relative_to(context.repo_root).as_posix() not in proven_paths
        )
        if not targets:
            return _pass(capability, "complete web component proof was covered by sensitivity")
    elif nodes:
        targets = tuple(_web_component_path(node) for node in nodes)
    else:
        return _pass(capability, "no selected web component proof")
    ports = execution.ports if execution is not None else _RunnerPorts()
    if not ports.browser_installed(context.repo_root, environment):
        return _not_run(capability, "the locked Chromium browser is absent")
    if execution is None:
        return _not_run(capability, "browser component proof requires workflow ownership")
    if argv is None:
        argv = ("bun", "run", "test:browser")
        if targets:
            argv = (*argv, "--", *targets)
    return _run_owned_commands(
        capability,
        ((argv, web_root),),
        _component_environment(environment, execution.run_id),
        (argv[0],),
        context=context,
    )


def _run_bundle(
    context: CapabilityContext,
    execution: _WorkflowExecution | None,
) -> CapabilityResult:
    capability = Capability.BUNDLE
    if (
        not (context.repo_root / "apps/web/package.json").is_file()
        or not (context.repo_root / "apps/web/node_modules").is_dir()
    ):
        return _not_run(capability, "web bundle owner is absent")
    if not _capability_is_selected(context, capability):
        return _pass(capability, "no selected web bundle proof")
    prepared = _prepared_run(execution, capability)
    if isinstance(prepared, CapabilityResult):
        return prepared
    if execution is None:
        raise AssertionError("prepared run exists without workflow execution")
    return _ensure_bundle(context, capability, execution, prepared)


def _ensure_bundle(
    context: CapabilityContext,
    capability: Capability,
    execution: _WorkflowExecution,
    prepared: TestRun,
) -> CapabilityResult:
    if execution.build is not None:
        return _pass(capability, "strict-CSP standalone bundle is ready")
    child_environment = _child_environment(execution.caller_environment)
    if shutil.which("bun", path=child_environment.get("PATH")) is None:
        return _not_run(capability, "required tool is absent: bun")
    started = time.monotonic_ns()
    try:
        execution.build = execution.ports.ensure_standalone_build(
            context.repo_root,
            {"NEXUS_ENV": "test", **child_environment},
            prepared.supabase.anon_key,
        )
        if context.run_context is not None:
            context.run_context.record_build(execution.build.fingerprint)
    except OSError as error:
        duration_ms = (time.monotonic_ns() - started) // 1_000_000
        return _result(
            capability,
            RunStatus.NOT_RUN,
            duration_ms,
            f"web bundle could not start: {error.strerror or error}",
        )
    except (RuntimeContractError, subprocess.CalledProcessError) as error:
        duration_ms = (time.monotonic_ns() - started) // 1_000_000
        return _result(
            capability,
            RunStatus.FAIL,
            duration_ms,
            f"web bundle failed: {error}",
        )
    duration_ms = (time.monotonic_ns() - started) // 1_000_000
    return _result(capability, RunStatus.PASS, duration_ms, "strict-CSP standalone bundle is ready")


def _run_journeys(
    context: CapabilityContext,
    capability: Capability,
    environment: Mapping[str, str],
    execution: _WorkflowExecution | None,
    *,
    exact: bool = False,
) -> CapabilityResult:
    web_root = context.repo_root / "apps/web"
    journey_root = web_root / "e2e/journeys"
    available = tuple(sorted(journey_root.glob("*.journey.spec.ts")))
    if not available or not (web_root / "node_modules").is_dir():
        return _not_run(capability, "Playwright journey owner is absent")
    nodes, promoted = _selected_proof_nodes(context, capability, "playwright")
    proven_paths = {
        node.split("::", 1)[0]
        for node in _proven_nodes(context, Capability.JOURNEYS_ALL, "playwright")
    }
    scope = _scope(context, capability)
    if exact:
        if not nodes or promoted:
            raise ValueError("exact journey proof must name one Playwright path")
        paths = tuple(context.repo_root / _playwright_journey_path(node) for node in nodes)
    elif scope is SelectionScope.COMPLETE or promoted:
        paths = tuple(
            path
            for path in available
            if capability is Capability.JOURNEYS_ALL or _journey_id(path) in _CRITICAL_JOURNEY_IDS
            if path.relative_to(context.repo_root).as_posix() not in proven_paths
        )
    elif nodes:
        paths = tuple(context.repo_root / _playwright_journey_path(node) for node in nodes)
    else:
        return _pass(capability, "no selected Playwright journey proof")
    if not paths:
        if proven_paths:
            return _pass(capability, "selected Playwright journey proof was covered by sensitivity")
        return _not_run(capability, "selected Playwright journey owner is absent")
    ports = execution.ports if execution is not None else _RunnerPorts()
    if not ports.browser_installed(context.repo_root, environment):
        return _not_run(capability, "the locked Chromium browser is absent")
    prepared = _prepared_run(execution, capability)
    if isinstance(prepared, CapabilityResult):
        return prepared
    if execution is None:
        raise AssertionError("prepared run exists without workflow execution")
    if execution.build is None:
        bundle = _ensure_bundle(context, capability, execution, prepared)
        if bundle.evidence.status is not RunStatus.PASS:
            return _result(
                capability,
                bundle.evidence.status,
                bundle.evidence.duration_ms,
                f"journeys require the production bundle: {bundle.detail}",
            )
    if execution.build is None:
        raise AssertionError("passing bundle capability did not retain its artifact")
    runtime_failure = _ensure_browser_processes(context, capability, execution, prepared)
    if runtime_failure is not None:
        return _with_browser_process_logs(runtime_failure, context, execution)
    try:
        scenario_users: dict[str, dict[str, str]] = {}
        scenario_invites: dict[str, dict[str, str]] = {}
        for journey_id in tuple(_journey_id(path) for path in paths):
            if journey_id == "auth-session":
                invited = execution.ports.invite_supabase_user(
                    context.repo_root,
                    {"NEXUS_ENV": "test"},
                    prepared.run_id,
                    journey_id,
                    prepared.supabase,
                )
                scenario_invites[journey_id] = {"email": invited.email}
                continue
            user = execution.ports.create_supabase_user(
                context.repo_root,
                {"NEXUS_ENV": "test"},
                prepared.run_id,
                journey_id,
                prepared.supabase,
            )
            if journey_id in {
                "durable-ingest-reader-open",
                "grounded-chat-citation",
                "chat-regeneration",
                "resource-share-boundary",
            }:
                execution.ports.grant_scenario_paid_entitlement(
                    context.repo_root,
                    {"NEXUS_ENV": "test"},
                    prepared,
                    user,
                )
            scenario_users[journey_id] = {
                "id": user.id,
                "email": user.email,
                "password": user.password,
            }
    except OSError as error:
        return _with_browser_process_logs(
            _not_run(
                capability,
                f"owned journey runtime could not start: {error.strerror or error}",
            ),
            context,
            execution,
        )
    except (RuntimeContractError, SQLAlchemyError, httpx.HTTPError, psycopg.Error) as error:
        return _with_browser_process_logs(
            _fail(capability, f"owned journey runtime failed: {error}"),
            context,
            execution,
        )
    child_environment = _heavy_environment(
        context, environment, prepared, execution.ports, browser=True
    )
    child_environment["NEXUS_TEST_SCENARIO_USERS"] = json.dumps(
        scenario_users,
        separators=(",", ":"),
        sort_keys=True,
    )
    child_environment["NEXUS_TEST_SCENARIO_INVITES"] = json.dumps(
        scenario_invites,
        separators=(",", ":"),
        sort_keys=True,
    )
    targets = tuple(f"./{path.relative_to(web_root).as_posix()}" for path in paths)
    return _with_browser_process_logs(
        _run_owned_commands(
            capability,
            (
                (
                    (
                        "bun",
                        "run",
                        "playwright",
                        "test",
                        "--config",
                        "e2e/playwright.config.ts",
                        "--project",
                        "journeys",
                        "--workers=1",
                        "--retries=0",
                        *targets,
                    ),
                    web_root,
                ),
            ),
            child_environment,
            ("bun",),
            context=context,
        ),
        context,
        execution,
    )


def _run_extension(
    context: CapabilityContext,
    environment: Mapping[str, str],
    execution: _WorkflowExecution | None,
    *,
    exact: bool = False,
) -> CapabilityResult:
    capability = Capability.EXTENSION
    web_root = context.repo_root / "apps/web"
    owner_root = web_root / "e2e/extension"
    available = tuple(sorted(owner_root.glob("*.extension.spec.ts")))
    if not available or not (context.repo_root / "apps/extension/manifest.json").is_file():
        return _not_run(capability, "MV3 extension proof owner is absent")
    if not _capability_is_selected(context, capability):
        return _pass(capability, "no selected MV3 extension proof")
    nodes, promoted = _selected_proof_nodes(context, capability, "playwright")
    if exact:
        if not nodes or promoted:
            raise ValueError("exact extension proof must name one Playwright path")
        paths = tuple(context.repo_root / _playwright_extension_path(node) for node in nodes)
    elif _scope(context, capability) is SelectionScope.COMPLETE or promoted:
        paths = available
    elif nodes:
        paths = tuple(context.repo_root / _playwright_extension_path(node) for node in nodes)
    else:
        return _pass(capability, "no selected MV3 extension proof")
    ports = execution.ports if execution is not None else _RunnerPorts()
    if not ports.browser_installed(context.repo_root, environment):
        return _not_run(capability, "the locked Chromium browser is absent")
    prepared = _prepared_run(execution, capability)
    if isinstance(prepared, CapabilityResult):
        return prepared
    if execution is None:
        raise AssertionError("prepared run exists without workflow execution")
    if execution.build is None:
        bundle = _ensure_bundle(context, capability, execution, prepared)
        if bundle.evidence.status is not RunStatus.PASS:
            return _result(
                capability,
                bundle.evidence.status,
                bundle.evidence.duration_ms,
                f"extension proof requires the production bundle: {bundle.detail}",
            )
    runtime_failure = _ensure_browser_processes(context, capability, execution, prepared)
    if runtime_failure is not None:
        return _with_browser_process_logs(runtime_failure, context, execution)
    try:
        user = execution.ports.create_supabase_user(
            context.repo_root,
            {"NEXUS_ENV": "test"},
            prepared.run_id,
            "extension",
            prepared.supabase,
        )
        profile, extension = _stage_extension(context.repo_root, prepared.run_id)
    except OSError as error:
        return _with_browser_process_logs(
            _not_run(
                capability,
                f"owned extension state could not start: {error.strerror or error}",
            ),
            context,
            execution,
        )
    except (RuntimeContractError, httpx.HTTPError) as error:
        return _with_browser_process_logs(
            _fail(capability, f"owned extension state failed: {error}"),
            context,
            execution,
        )
    child_environment = _heavy_environment(
        context, environment, prepared, execution.ports, browser=True
    )
    child_environment.update(
        {
            "NEXUS_TEST_EXTENSION_DIR": str(extension),
            "NEXUS_TEST_EXTENSION_PROFILE": str(profile),
            "NEXUS_TEST_SCENARIO_USERS": json.dumps(
                {
                    "extension": {
                        "id": user.id,
                        "email": user.email,
                        "password": user.password,
                    }
                },
                separators=(",", ":"),
                sort_keys=True,
            ),
        }
    )
    targets = tuple(f"./{path.relative_to(web_root).as_posix()}" for path in paths)
    return _with_browser_process_logs(
        _run_owned_commands(
            capability,
            (
                (
                    (
                        "bun",
                        "run",
                        "playwright",
                        "test",
                        "--config",
                        "e2e/playwright.config.ts",
                        "--project",
                        "extension",
                        "--workers=1",
                        "--retries=0",
                        *targets,
                    ),
                    web_root,
                ),
            ),
            child_environment,
            ("bun",),
            context=context,
        ),
        context,
        execution,
    )


def _with_browser_process_logs(
    result: CapabilityResult,
    context: CapabilityContext,
    execution: _WorkflowExecution,
) -> CapabilityResult:
    directory = context.repo_root / "test-results/runs" / execution.run_id
    process_logs = tuple(
        path.relative_to(context.repo_root).as_posix()
        for role in (
            "external",
            "provider-api-peer",
            "provider-openai",
            "codex-generation-peer",
            "api",
            "worker-interactive",
            "worker-background",
            "web",
        )
        if (path := directory / f"{role}.log").is_file()
    )
    if not process_logs:
        return result
    artifacts = tuple(dict.fromkeys((*result.evidence.artifacts, *process_logs)))
    return CapabilityResult(replace(result.evidence, artifacts=artifacts), result.detail)


def _ensure_browser_processes(
    context: CapabilityContext,
    capability: Capability,
    execution: _WorkflowExecution,
    prepared: TestRun,
) -> CapabilityResult | None:
    if execution.journey_runtime_started:
        return None
    if execution.build is None:
        raise AssertionError("browser runtime requires the retained standalone artifact")
    try:
        if not execution.browser_data_plane_prepared:
            execution.ports.reset_run_data_plane(
                context.repo_root,
                {"NEXUS_ENV": "test"},
                prepared,
            )
            execution.browser_data_plane_prepared = True
        protocol_failure = execution.ensure_external_protocol(capability, prepared)
        if protocol_failure is not None:
            return protocol_failure
        provider_failure = execution.ensure_provider_api_protocol(capability, prepared)
        if provider_failure is not None:
            return provider_failure
        embedding_peer = execution.ports.materialize_embedding_peer(
            context.repo_root,
            {"NEXUS_ENV": "test"},
            prepared,
        )
        provider_openai = execution.ports.start_python_process(
            context.repo_root,
            {"NEXUS_ENV": "test"},
            prepared,
            "provider-openai",
        )
        execution.ports.wait_process_ready(
            context.repo_root,
            {"NEXUS_ENV": "test"},
            provider_openai,
            EndpointKind.PROVIDER_OPENAI,
            "/livez",
            tls_ca=embedding_peer.certificate,
        )
        embedding_environment = embedding_peer.client_environment()
        generation_peer = execution.ports.materialize_generation_peer(
            context.repo_root,
            {"NEXUS_ENV": "test"},
            prepared,
        )
        codex_generation_peer = execution.ports.start_python_process(
            context.repo_root,
            {"NEXUS_ENV": "test"},
            prepared,
            "codex-generation-peer",
        )
        execution.ports.wait_generation_peer_ready(
            context.repo_root,
            {"NEXUS_ENV": "test"},
            codex_generation_peer,
            generation_peer.socket,
        )
        app_environment = {
            **embedding_environment,
            **generation_peer.client_environment(),
            # Journeys share one background queue. Unowned optional Synapse
            # work must not leak executor capacity between isolated scenarios.
            "SYNAPSE_ENABLED": "false",
        }
        api = execution.ports.start_python_process(
            context.repo_root,
            {"NEXUS_ENV": "test"},
            prepared,
            "api",
            overrides=app_environment,
        )
        execution.ports.wait_process_ready(
            context.repo_root,
            {"NEXUS_ENV": "test"},
            api,
            EndpointKind.API,
            "/readyz",
        )
        interactive = execution.ports.start_python_process(
            context.repo_root,
            {"NEXUS_ENV": "test"},
            prepared,
            "worker-interactive",
            overrides=app_environment,
        )
        execution.ports.wait_process_ready(
            context.repo_root,
            {"NEXUS_ENV": "test"},
            interactive,
            EndpointKind.AGENT_TOOLS_MCP,
            "/internal/agent-tools/mcp",
        )
        execution.ports.start_python_process(
            context.repo_root,
            {"NEXUS_ENV": "test"},
            prepared,
            "worker-background",
            overrides=app_environment,
        )
        web = execution.ports.start_web_process(
            context.repo_root,
            {"NEXUS_ENV": "test"},
            prepared,
            execution.build,
        )
        execution.ports.wait_process_ready(
            context.repo_root,
            {"NEXUS_ENV": "test"},
            web,
            EndpointKind.WEB,
            "/login",
        )
    except OSError as error:
        return _not_run(
            capability, f"owned browser runtime could not start: {error.strerror or error}"
        )
    except (BotoCoreError, RuntimeContractError, psycopg.Error) as error:
        return _fail(capability, f"owned browser runtime failed: {error}")
    execution.journey_runtime_started = True
    return None


def _stage_extension(repo_root: Path, run_id: str) -> tuple[Path, Path]:
    scenario_id = "capture"
    identity = extension_profile_identity(run_id, scenario_id)
    resource = Resource(ResourceKind.EXTENSION_PROFILE, identity)
    environment = {"NEXUS_ENV": "test"}
    record_planned(
        repo_root,
        environment,
        run_id,
        resource,
        scenario_id=scenario_id,
    )
    root = repo_root / identity
    extension = root / "extension"
    profile = root / "chromium"
    root.mkdir(parents=True, exist_ok=False)
    shutil.copytree(repo_root / "apps/extension", extension)
    manifest_path = extension / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeContractError("extension manifest is not readable JSON") from error
    if not isinstance(manifest, dict) or manifest.get("manifest_version") != 3:
        raise RuntimeContractError("extension proof requires the production MV3 manifest")
    manifest["key"] = TEST_EXTENSION_PUBLIC_KEY
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    profile.mkdir()
    record_created(repo_root, environment, run_id, resource)
    return profile, extension


def _prepared_run(
    execution: _WorkflowExecution | None,
    capability: Capability,
) -> TestRun | CapabilityResult:
    if execution is None:
        return _not_run(capability, "heavy proof requires the workflow-owned local test run")
    return execution.prepare(capability)


def _proof_owner(runner_name: str, node: str) -> tuple[Capability, Workflow]:
    path = node.split("::", 1)[0]
    if runner_name == "pytest":
        for prefix, capability, workflow in (
            ("python/tests/kernel/", Capability.KERNEL_PYTHON, Workflow.CHANGED),
            ("python/tests/service/", Capability.SERVICE, Workflow.CHANGED),
            ("python/tests/migrations/", Capability.MIGRATIONS, Workflow.PR),
            ("python/tests/contract/", Capability.PROVIDER_RUNTIME, Workflow.FULL),
            ("python/tests/llm_tools_contract/", Capability.LLM_TOOLS, Workflow.FULL),
            ("python/tests/release_artifact/", Capability.RELEASE_ARTIFACT, Workflow.RELEASE),
            ("python/tests/evals/", Capability.LLM_EVAL, Workflow.FULL),
            ("python/tests/audit/", Capability.AUDIT, Workflow.NIGHTLY),
        ):
            if path.startswith(prefix) and path.endswith(".py"):
                return capability, workflow
    elif (
        runner_name == "node-test"
        and "::" not in node
        and path.startswith(_INGEST_NODE_TEST_PREFIX)
        and path.endswith(".test.mjs")
    ):
        return Capability.INGEST_NODE, Workflow.FULL
    elif runner_name == "vitest" and "::" not in node:
        if path.startswith("apps/web/src/") and path.endswith((".unit.test.ts", ".unit.test.tsx")):
            return Capability.KERNEL_WEB, Workflow.CHANGED
        if path.startswith("apps/web/src/") and path.endswith(
            (".browser.test.ts", ".browser.test.tsx")
        ):
            return Capability.COMPONENT, Workflow.CHANGED
    elif (
        runner_name == "playwright"
        and "::" not in node
        and path.startswith("apps/web/e2e/journeys/")
        and path.endswith(".journey.spec.ts")
    ):
        return Capability.JOURNEYS_ALL, Workflow.FULL
    elif (
        runner_name == "playwright"
        and "::" not in node
        and path.startswith("apps/web/e2e/extension/")
        and path.endswith(".extension.spec.ts")
    ):
        return Capability.EXTENSION, Workflow.FULL
    elif runner_name == "gradle" and path.startswith(_ANDROID_HOST_PREFIX) and path.endswith(".kt"):
        return Capability.ANDROID_HOST, Workflow.FULL
    elif (
        runner_name == "gradle"
        and path.startswith("apps/android/app/src/androidTest/")
        and path.endswith(".kt")
    ):
        return Capability.ANDROID_DEVICE, Workflow.NIGHTLY
    raise ValueError(f"unsupported exact proof owner: {runner_name}:{node}")


def _classified_exact_result(result: CapabilityResult, proof_id: str) -> CapabilityResult:
    if result.evidence.status is not RunStatus.FAIL:
        return result
    if result.detail.startswith("proof_result="):
        classification, separator, detail = result.detail.partition("|")
        if not separator:
            return CapabilityResult(
                result.evidence,
                f"proof_result=setup_or_execution_failure|proof_id={proof_id}|{result.detail}",
            )
        return CapabilityResult(
            result.evidence,
            f"{classification}|proof_id={proof_id}|{detail}",
        )
    folded = _ANSI_ESCAPE_RE.sub("", result.detail).casefold()
    if any(
        marker in folded
        for marker in (
            "error collecting",
            "error while loading conftest",
            "no test files found",
            "no tests found",
            "not found in rootdir",
        )
    ):
        kind = "collection_failure"
    elif any(
        marker in folded
        for marker in (
            "error at setup",
            "beforeall hook",
            "beforeeach hook",
            "fixture setup",
        )
    ):
        kind = "setup_or_execution_failure"
    elif _is_timeout_failure(folded):
        # A timeout is an execution failure, never a behavioral assertion, even
        # when pytest renders it as "E   Failed: Timeout >Ns" (which would
        # otherwise match the did-not-raise assertion form below).
        kind = "setup_or_execution_failure"
    elif (
        "falsifying example:" in folded
        or "assertionerror:" in folded
        or _is_node_tap_assertion(folded)
        or ("failed " in folded and "::" in folded and " - assertionerror" in folded)
        or "error: expect(" in folded
        or re.search(r"\bexpect\(received\)\.to[a-z]+\(", folded) is not None
        or re.search(r"\bexpect\(locator\)\.to[a-z]+\([^\n]*\) failed\b", folded) is not None
        or re.search(r"\ne\s+(?:assert|assertionerror|failed:)", folded) is not None
    ):
        kind = "behavioral_assertion_failure"
    elif _is_thrown_runtime_error(folded):
        # A thrown runtime error with no assertion marker (a TypeError, a
        # ReferenceError, an unhandled rejection) is an execution failure: the
        # proof crashed before — or instead of — exercising its behavioral
        # oracle, so it is not a valid sensitivity red.
        kind = "setup_or_execution_failure"
    elif re.search(r"\btests\s+\d+\s+failed\b", folded) is not None:
        # Vitest retained only its summary line; the assertion detail scrolled
        # out of the bounded capture. With no runtime-error or timeout signature,
        # a failed test node is a behavioral failure — accept it rather than
        # reject a real red on truncation.
        kind = "behavioral_assertion_failure"
    else:
        kind = "setup_or_execution_failure"
    return CapabilityResult(
        result.evidence,
        f"proof_result={kind}|proof_id={proof_id}|{result.detail}",
    )


def _is_timeout_failure(folded: str) -> bool:
    """A casefolded child failure that is a timeout, not a behavioral assertion."""
    return (
        "timed out in " in folded  # vitest: "Test timed out in 5000ms"
        or "test timed out after " in folded  # Node test runner
        or "hook timed out" in folded  # vitest hook timeout
        or re.search(r"failed:\s*timeout\b", folded) is not None  # pytest-timeout
        or re.search(r"timeout of \d+\s*ms exceeded", folded) is not None  # playwright
    )


def _is_node_tap_assertion(folded: str) -> bool:
    return re.search(r"failuretype:\s*['\"]testcodefailure['\"]", folded) is not None and (
        re.search(r"code:\s*['\"]err_assertion['\"]", folded) is not None
        or re.search(r"name:\s*['\"]assertionerror['\"]", folded) is not None
    )


def _is_thrown_runtime_error(folded: str) -> bool:
    """A casefolded child failure that is a thrown runtime error, not an assertion."""
    return any(
        marker in folded
        for marker in (
            "typeerror:",
            "referenceerror:",
            "rangeerror:",
            "syntaxerror:",
            "is not a function",
            "is not defined",
            "cannot read propert",
            "unhandled rejection",
            "unhandled error",
        )
    )


def _heavy_environment(
    context: CapabilityContext,
    caller_environment: Mapping[str, str],
    run: TestRun,
    ports: _RunnerPorts,
    *,
    browser: bool = False,
) -> dict[str, str]:
    child = {
        key: value
        for key in _SAFE_HEAVY_ENV
        if (value := caller_environment.get(key)) is not None and value != ""
    }
    child["PYTHONPATH"] = str(context.repo_root / "python")
    owned = ports.run_environment(context.repo_root, {"NEXUS_ENV": "test"}, run)
    child.update(
        {key: value for key, value in owned.items() if not browser or key in _BROWSER_RUN_ENV}
    )
    return child


def _component_environment(
    caller_environment: Mapping[str, str],
    run_id: str,
) -> dict[str, str]:
    child = {
        key: value
        for key in _SAFE_HEAVY_ENV
        if (value := caller_environment.get(key)) is not None and value != ""
    }
    child.update(
        {
            "NEXUS_ENV": "test",
            "NEXUS_TEST_RUN_ID": run_id,
        }
    )
    return child


def _python_heavy_node(node: str, owner: str) -> str:
    path, separator, selected_test = node.partition("::")
    prefix = f"python/{owner}/"
    if not path.startswith(prefix) or not path.endswith(".py"):
        raise ValueError(f"Python proof is outside {prefix}: {node}")
    relative = path.removeprefix("python/")
    return f"{relative}::{selected_test}" if separator else relative


def _web_component_path(node: str) -> str:
    path = node.split("::", 1)[0]
    if not path.startswith("apps/web/src/") or not path.endswith(
        (".browser.test.ts", ".browser.test.tsx")
    ):
        raise ValueError(f"web component proof is outside its owner: {node}")
    return f"./{path.removeprefix('apps/web/')}"


def _playwright_journey_path(node: str) -> str:
    path = node.split("::", 1)[0]
    if not path.startswith("apps/web/e2e/journeys/") or not path.endswith(".journey.spec.ts"):
        raise ValueError(f"Playwright journey proof is outside its owner: {node}")
    return path


def _playwright_extension_path(node: str) -> str:
    path = node.split("::", 1)[0]
    if not path.startswith("apps/web/e2e/extension/") or not path.endswith(".extension.spec.ts"):
        raise ValueError(f"Playwright extension proof is outside its owner: {node}")
    return path


def _journey_id(path: Path) -> str:
    journey_id = path.name.removesuffix(".journey.spec.ts")
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?", journey_id):
        raise ValueError(f"journey filename has no valid scenario id: {path.name}")
    return journey_id


def _run_owned_commands(
    capability: Capability,
    commands: tuple[FixedCommand, ...],
    child_environment: Mapping[str, str],
    required_tools: tuple[str, ...],
    *,
    context: CapabilityContext | None,
) -> CapabilityResult:
    if child_environment.get("NEXUS_ENV") != "test":
        raise ValueError("owned test command requires NEXUS_ENV=test")
    missing = tuple(
        tool
        for tool in required_tools
        if shutil.which(tool, path=child_environment.get("PATH")) is None
    )
    if missing:
        return _not_run(capability, f"required tools are absent: {', '.join(missing)}")
    started = time.monotonic_ns()
    for index, (argv, cwd) in enumerate(commands, start=1):
        argv = _fail_fast_command(argv)
        if context is not None and context.run_context is not None:
            context.run_context.record_command(
                context,
                capability,
                argv,
                cwd,
                child_environment,
            )
        try:
            completed = run_command(
                argv,
                cwd=cwd,
                env=dict(child_environment),
                capture_output=True,
                check=False,
            )
        except OSError as error:
            duration_ms = (time.monotonic_ns() - started) // 1_000_000
            return _result(
                capability,
                RunStatus.NOT_RUN,
                duration_ms,
                f"fixed command {index} could not start: {error.strerror or error}",
            )
        if completed.returncode != 0:
            duration_ms = (time.monotonic_ns() - started) // 1_000_000
            interrupted_by = _command_interruption_signal(completed.returncode)
            status = RunStatus.NOT_RUN if interrupted_by is not None else RunStatus.FAIL
            detail = redact_text(
                _command_result_detail(index, completed, interrupted_by),
                environment_secrets(child_environment),
            )
            artifacts = _failure_artifacts(
                capability,
                index,
                argv,
                completed,
                child_environment,
            )
            return _result(
                capability,
                status,
                duration_ms,
                detail,
                artifacts=artifacts,
            )
    duration_ms = (time.monotonic_ns() - started) // 1_000_000
    return _result(
        capability,
        RunStatus.PASS,
        duration_ms,
        f"{len(commands)} fixed command{'s' if len(commands) != 1 else ''} passed",
    )


def _run_corpus(context: CapabilityContext) -> CapabilityResult:
    started = time.monotonic_ns()
    violations = corpus_violations(context.repo_root)
    duration_ms = (time.monotonic_ns() - started) // 1_000_000
    if violations:
        first = violations[0]
        return _result(
            Capability.CORPUS,
            RunStatus.FAIL,
            duration_ms,
            f"{first.path}: {first.rule}: {first.message}"
            + (f" (+{len(violations) - 1} more)" if len(violations) > 1 else ""),
        )
    return _result(Capability.CORPUS, RunStatus.PASS, duration_ms, "corpus contract passed")


def _run_audit(
    context: CapabilityContext,
    environment: Mapping[str, str],
    execution: _WorkflowExecution | None = None,
    *,
    exact: bool = False,
) -> CapabilityResult:
    capability = Capability.AUDIT
    python_root = context.repo_root / "python"
    owner = python_root / "tests/audit"
    available = tuple(sorted(owner.rglob("test_*.py"))) if owner.is_dir() else ()
    if not available or not (python_root / ".venv").is_dir():
        return _not_run(capability, "Python audit proof owner is absent")
    nodes, promoted = _selected_proof_nodes(context, capability, "pytest")
    if exact:
        if not nodes or promoted:
            raise ValueError("exact audit proof must name one pytest node")
        targets = tuple(_python_heavy_node(node, "tests/audit") for node in nodes)
    elif _scope(context, capability) is SelectionScope.COMPLETE or promoted:
        targets = tuple(f"./{path.relative_to(python_root).as_posix()}" for path in available)
    elif nodes:
        targets = tuple(_python_heavy_node(node, "tests/audit") for node in nodes)
    else:
        return _pass(capability, "no selected audit proof")
    child_environment = _child_environment(environment)
    child_environment["NEXUS_ENV"] = "test"
    if not exact:
        service_owner = python_root / "tests/service"
        service_tests = tuple(sorted(service_owner.rglob("test_*.py")))
        if len(service_tests) < 2:
            return _not_run(capability, "randomized audit needs a meaningful service portfolio")
        prepared = _prepared_run(execution, capability)
        if isinstance(prepared, CapabilityResult):
            return prepared
        if execution is None:
            raise AssertionError("randomized audit prepared without workflow execution")
        protocol_failure = execution.ensure_external_protocol(capability, prepared)
        if protocol_failure is not None:
            return protocol_failure
        provider_failure = execution.ensure_provider_api_protocol(capability, prepared)
        if provider_failure is not None:
            return provider_failure
        child_environment = _heavy_environment(
            context,
            environment,
            prepared,
            execution.ports,
        )
        targets = (
            *targets,
            *(f"./{path.relative_to(python_root).as_posix()}" for path in service_tests),
        )
    seeds = ("15485863",) if exact else ("15485863", "32452843")
    commands: tuple[FixedCommand, ...] = tuple(
        (
            (
                "uv",
                "run",
                "--frozen",
                "--no-sync",
                "pytest",
                "-q",
                f"--randomly-seed={seed}",
                f"--hypothesis-seed={seed}",
                *targets,
            ),
            python_root,
        )
        for seed in seeds
    )
    result = _run_owned_commands(
        capability,
        commands,
        child_environment,
        ("uv",),
        context=context,
    )
    return CapabilityResult(
        result.evidence,
        f"seeds={','.join(seeds)}; {result.detail}",
    )


def _pinned_python_suite_pin(repo_root: Path, suite: _PinnedPythonSuite) -> str:
    try:
        data = tomllib.loads((repo_root / "python/pyproject.toml").read_text(encoding="utf-8"))
        revision = data["tool"]["uv"]["sources"][suite.package]["rev"]
    except (KeyError, OSError, TypeError, tomllib.TOMLDecodeError) as error:
        raise RuntimeContractError(f"{suite.package} pin is invalid or absent") from error
    if not isinstance(revision, str) or re.fullmatch(r"[0-9a-f]{40}", revision) is None:
        raise RuntimeContractError(f"{suite.package} pin is not a full Git SHA")
    return revision


def _provider_runtime_pin(repo_root: Path) -> str:
    return _pinned_python_suite_pin(repo_root, _PROVIDER_RUNTIME_SUITE)


def _pinned_python_suite_checkout_ready(
    repo_root: Path,
    suite: _PinnedPythonSuite,
) -> bool:
    revision = _pinned_python_suite_pin(repo_root, suite)
    checkout = repo_root / ".nexus-test" / suite.package / revision
    recorded = (checkout / suite.marker_name).read_text(encoding="utf-8").strip()
    return recorded == revision and (checkout / ".venv").is_dir()


def _ensure_pinned_python_suite_checkout(
    repo_root: Path,
    environment: Mapping[str, str],
    suite: _PinnedPythonSuite,
) -> Path:
    """Materialize one immutable suite without retargeting developer state."""

    revision = _pinned_python_suite_pin(repo_root, suite)
    owner = repo_root / ".nexus-test" / suite.package
    checkout = owner / revision
    marker = checkout / suite.marker_name
    if checkout.is_dir():
        try:
            recorded = marker.read_text(encoding="utf-8").strip()
        except OSError as error:
            raise RuntimeContractError(f"owned {suite.package} checkout is incomplete") from error
        if recorded != revision or not (checkout / ".venv").is_dir():
            raise RuntimeContractError(f"owned {suite.package} checkout is incomplete")
        return checkout

    source = repo_root.parent / suite.source_directory
    if not source.is_dir():
        raise RuntimeContractError(f"local {suite.package} Git object source is absent")
    child_environment = _child_environment(environment)
    path = child_environment.get("PATH")
    if shutil.which("git", path=path) is None or shutil.which("uv", path=path) is None:
        raise RuntimeContractError(f"{suite.package} materialization requires git and uv")

    owner.mkdir(parents=True, exist_ok=True)
    build = owner / f".building-{new_run_id()}"
    archive = owner / f".{revision}-{new_run_id()}.tar"
    build.mkdir()
    try:
        archived = run_command(
            (
                "git",
                "-C",
                str(source),
                "archive",
                "--format=tar",
                f"--output={archive}",
                revision,
            ),
            cwd=repo_root,
            env=child_environment,
            capture_output=True,
            check=False,
        )
        if archived.returncode != 0:
            raise RuntimeContractError(f"pinned {suite.package} commit is unavailable offline")
        with tarfile.open(archive, mode="r:") as bundle:
            bundle.extractall(build, filter="data")
        synced = run_command(
            # --no-editable copies the project into the venv instead of linking a
            # .pth to the build-dir source, so the promoted checkout stays valid
            # after the build directory is renamed away. --reinstall-package busts
            # any cached editable build of the project so the non-editable copy is
            # actually materialized rather than a stale editable link reused.
            (
                "uv",
                "sync",
                "--all-extras",
                "--locked",
                "--offline",
                "--no-editable",
                "--reinstall-package",
                suite.package,
            ),
            cwd=build,
            env=child_environment,
            capture_output=True,
            check=False,
        )
        if synced.returncode != 0 or not (build / ".venv").is_dir():
            raise RuntimeContractError(f"pinned {suite.package} environment is unavailable offline")
        (build / suite.marker_name).write_text(revision + "\n", encoding="utf-8")
        # uv writes each console-script launcher in .venv/bin with the absolute
        # build path of the interpreter; promotion renames the directory, so
        # rewrite those launchers to the promoted checkout before it is used.
        bin_dir = build / ".venv/bin"
        for script in bin_dir.iterdir() if bin_dir.is_dir() else ():
            if script.is_symlink() or not script.is_file():
                continue
            try:
                text = script.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            if str(build) in text:
                script.write_text(text.replace(str(build), str(checkout)), encoding="utf-8")
        build.rename(checkout)
    except (OSError, tarfile.TarError) as error:
        raise RuntimeContractError(f"{suite.package} materialization failed") from error
    finally:
        archive.unlink(missing_ok=True)
        if build.exists():
            shutil.rmtree(build)
    return checkout


def _ensure_provider_runtime_checkout(
    repo_root: Path,
    environment: Mapping[str, str],
) -> Path:
    return _ensure_pinned_python_suite_checkout(
        repo_root,
        environment,
        _PROVIDER_RUNTIME_SUITE,
    )


def _ensure_llm_tools_checkout(
    repo_root: Path,
    environment: Mapping[str, str],
) -> Path:
    return _ensure_pinned_python_suite_checkout(repo_root, environment, _LLM_TOOLS_SUITE)


def _run_provider_runtime(
    context: CapabilityContext,
    environment: Mapping[str, str],
    *,
    exact: bool = False,
) -> CapabilityResult:
    return _run_pinned_python_suite(
        context,
        environment,
        _PROVIDER_RUNTIME_SUITE,
        exact=exact,
    )


def _run_llm_tools(
    context: CapabilityContext,
    environment: Mapping[str, str],
    *,
    exact: bool = False,
) -> CapabilityResult:
    return _run_pinned_python_suite(context, environment, _LLM_TOOLS_SUITE, exact=exact)


def _run_ingest_node(
    context: CapabilityContext,
    environment: Mapping[str, str],
    *,
    exact: bool = False,
) -> CapabilityResult:
    capability = Capability.INGEST_NODE
    ingest_root = context.repo_root / "node/ingest"
    test_root = context.repo_root / _INGEST_NODE_TEST_PREFIX
    guard = context.repo_root / _INGEST_NODE_NETWORK_GUARD
    owners = tuple(sorted(path for path in test_root.rglob("*.test.mjs") if path.is_file()))
    if (
        not (ingest_root / "package.json").is_file()
        or not (ingest_root / "bun.lock").is_file()
        or not (ingest_root / "node_modules").is_dir()
        or not guard.is_file()
        or not owners
    ):
        return _not_run(capability, "Node ingest test owner is absent")

    nodes, promoted = _selected_proof_nodes(context, capability, "node-test")
    if exact:
        if len(nodes) != 1 or promoted:
            raise ValueError("exact Node ingest proof must name one test file")
        targets = _ingest_node_test_targets(context.repo_root, nodes)
    elif _scope(context, capability) is SelectionScope.COMPLETE or promoted:
        targets = tuple(path.relative_to(context.repo_root).as_posix() for path in owners)
    elif nodes:
        targets = _ingest_node_test_targets(context.repo_root, nodes)
    else:
        return _pass(capability, "no selected Node ingest proof")

    guard_import = f"NODE_OPTIONS=--import={guard.resolve(strict=True)}"
    return _run_fixed_commands(
        capability,
        (
            (
                (
                    "env",
                    guard_import,
                    "node",
                    "--test",
                    "--test-reporter=tap",
                    "--test-concurrency=1",
                    *targets,
                ),
                context.repo_root,
            ),
        ),
        environment,
        ("env", "node"),
        context=context,
    )


def _ingest_node_test_targets(repo_root: Path, nodes: tuple[str, ...]) -> tuple[str, ...]:
    targets: list[str] = []
    for node in nodes:
        if (
            "::" in node
            or not node.startswith(_INGEST_NODE_TEST_PREFIX)
            or not node.endswith(".test.mjs")
        ):
            raise ValueError(f"Node ingest proof is outside its owner: {node}")
        candidate = repo_root / node
        if not candidate.is_file():
            raise ValueError(f"Node ingest proof owner is absent: {node}")
        targets.append(node)
    return tuple(targets)


def _run_pinned_python_suite(
    context: CapabilityContext,
    environment: Mapping[str, str],
    suite: _PinnedPythonSuite,
    *,
    exact: bool,
) -> CapabilityResult:
    capability = suite.capability
    python_root = context.repo_root / "python"
    contract_root = python_root / suite.contract_directory
    owners = tuple(sorted(contract_root.rglob("test_*.py"))) if contract_root.is_dir() else ()
    if not owners or not (python_root / ".venv").is_dir():
        return _not_run(capability, suite.local_absent_detail)
    nodes, promoted = _selected_proof_nodes(context, capability, "pytest")
    if exact:
        if not nodes or promoted:
            raise ValueError(suite.exact_proof_error)
        targets = tuple(_python_heavy_node(node, suite.contract_directory) for node in nodes)
    elif _scope(context, capability) is SelectionScope.COMPLETE or promoted:
        targets = tuple(f"./{path.relative_to(python_root).as_posix()}" for path in owners)
    elif nodes:
        targets = tuple(_python_heavy_node(node, suite.contract_directory) for node in nodes)
    else:
        return _pass(capability, suite.no_selection_detail)
    local = _run_fixed_commands(
        capability,
        (
            (
                (
                    "uv",
                    "run",
                    "--frozen",
                    "--no-sync",
                    "pytest",
                    *_DETERMINISTIC_PYTEST,
                    *targets,
                ),
                python_root,
            ),
        ),
        environment,
        ("uv",),
        context=context,
    )
    if local.evidence.status is not RunStatus.PASS or exact:
        return local

    try:
        checkout = _ensure_pinned_python_suite_checkout(
            context.repo_root,
            environment,
            suite,
        )
    except RuntimeContractError as error:
        return _not_run(capability, str(error))
    pinned = _run_fixed_commands(
        capability,
        tuple((command, checkout) for command in suite.verification_commands),
        environment,
        ("uv",),
        elapsed_ms=local.evidence.duration_ms,
        context=context,
    )
    if pinned.evidence.status is not RunStatus.PASS:
        return pinned
    return CapabilityResult(pinned.evidence, suite.success_detail)


def _run_android_host(
    context: CapabilityContext, environment: Mapping[str, str]
) -> CapabilityResult:
    android_root = context.repo_root / "apps/android"
    wrapper = android_root / "gradlew"
    owners = tuple(
        sorted(
            path
            for path in (context.repo_root / _ANDROID_HOST_PREFIX).rglob("*.kt")
            if path.is_file()
        )
    )
    if not wrapper.is_file() or not owners:
        return _not_run(Capability.ANDROID_HOST, "Android host proof owner is absent")
    if not android_sdk_available(android_root, environment):
        return _not_run(Capability.ANDROID_HOST, "Android SDK is absent")
    nodes, promoted = _selected_proof_nodes(context, Capability.ANDROID_HOST, "gradle")
    argv: tuple[str, ...] = ("./gradlew", "--no-daemon", ":app:testDebugUnitTest")
    if _scope(context, Capability.ANDROID_HOST) is not SelectionScope.COMPLETE and not promoted:
        if not nodes:
            return _pass(Capability.ANDROID_HOST, "no selected Android host proof")
        for node in nodes:
            argv = (*argv, "--tests", _android_test_class(context.repo_root, node))
    child_environment = resolved_android_environment(environment)
    child_environment["NEXUS_GOOGLE_WEB_CLIENT_ID"] = _TEST_GOOGLE_CLIENT_ID
    with _gradle_lock(context.repo_root):
        return _run_fixed_commands(
            Capability.ANDROID_HOST,
            ((argv, android_root),),
            child_environment,
            ("java",),
            context=context,
        )


def _android_device_requires_physical(
    context: CapabilityContext, environment: Mapping[str, str]
) -> bool:
    """The release workflow's device proof binds the dedicated USB handset.

    The explicit bootstrap release is the one exception: it has no handset
    anywhere, so its hosted runner boots the same emulator every non-release
    workflow already uses, and the retained android-release evidence names the
    signed-physical stages it skipped.
    """
    if context.workflow is not Workflow.RELEASE:
        return False
    return environment.get("NEXUS_ANDROID_RELEASE_BOOTSTRAP_NO_DEVICE") != "true"


def _run_android_device(
    context: CapabilityContext, environment: Mapping[str, str]
) -> CapabilityResult:
    android_root = context.repo_root / "apps/android"
    wrapper = android_root / "gradlew"
    owners = tuple(
        sorted(
            path for path in (android_root / "app/src/androidTest").rglob("*.kt") if path.is_file()
        )
    )
    if not wrapper.is_file() or not owners:
        return _not_run(Capability.ANDROID_DEVICE, "Android device proof owner is absent")
    if not android_sdk_available(android_root, environment):
        return _not_run(Capability.ANDROID_DEVICE, "Android SDK is absent")
    device, device_detail = _android_device_target(
        android_root,
        environment,
        require_physical=_android_device_requires_physical(context, environment),
    )
    if device is None:
        return _not_run(Capability.ANDROID_DEVICE, device_detail)
    child_environment = resolved_android_environment(environment)
    child_environment["NEXUS_GOOGLE_WEB_CLIENT_ID"] = _TEST_GOOGLE_CLIENT_ID
    child_environment["ANDROID_SERIAL"] = device.serial
    argv = (
        "./gradlew",
        "--no-daemon",
        ":app:connectedDebugAndroidTest",
        "-Pandroid.testInstrumentationRunnerArguments.notAnnotation="
        f"{_ANDROID_SIGNED_PROMOTION_ANNOTATION}",
    )
    with _gradle_lock(context.repo_root):
        return _run_android_instrumentation(
            context,
            device,
            argv,
            android_root,
            child_environment,
        )


def _run_android_visual(
    context: CapabilityContext,
    environment: Mapping[str, str],
    execution: _WorkflowExecution | None,
) -> CapabilityResult:
    capability = Capability.ANDROID_VISUAL
    if execution is None:
        return _not_run(capability, "android-visual requires a controller run identity")
    started = time.monotonic_ns()
    outcome = android_visual.run_android_visual(
        context.repo_root, environment, run_id=execution.run_id
    )
    duration_ms = (time.monotonic_ns() - started) // 1_000_000
    return _result(
        capability, outcome.status, duration_ms, outcome.detail, artifacts=outcome.artifacts
    )


def _run_android_device_exact(
    context: CapabilityContext,
    node: str,
    environment: Mapping[str, str],
) -> CapabilityResult:
    android_root = context.repo_root / "apps/android"
    wrapper = android_root / "gradlew"
    if not wrapper.is_file():
        return _not_run(Capability.ANDROID_DEVICE, "Android device proof owner is absent")
    if not android_sdk_available(android_root, environment):
        return _not_run(Capability.ANDROID_DEVICE, "Android SDK is absent")
    device, device_detail = _android_device_target(
        android_root,
        environment,
        require_physical=_android_device_requires_physical(context, environment),
    )
    if device is None:
        return _not_run(Capability.ANDROID_DEVICE, device_detail)
    target = _android_device_test_target(context.repo_root, node)
    child_environment = resolved_android_environment(environment)
    child_environment["NEXUS_GOOGLE_WEB_CLIENT_ID"] = _TEST_GOOGLE_CLIENT_ID
    child_environment["ANDROID_SERIAL"] = device.serial
    argv = (
        "./gradlew",
        "--no-daemon",
        ":app:connectedDebugAndroidTest",
        f"-Pandroid.testInstrumentationRunnerArguments.class={target}",
    )
    with _gradle_lock(context.repo_root):
        result = _run_android_instrumentation(
            context,
            device,
            argv,
            android_root,
            child_environment,
        )
    if result.evidence.status is RunStatus.FAIL and _gradle_assertion_failed(android_root, target):
        return CapabilityResult(
            result.evidence,
            f"proof_result=behavioral_assertion_failure|{result.detail}",
        )
    return result


def _run_android_instrumentation(
    context: CapabilityContext,
    device: AuthorizedAndroidDevice,
    argv: tuple[str, ...],
    android_root: Path,
    environment: Mapping[str, str],
) -> CapabilityResult:
    reports = android_root / "app/build/outputs/androidTest-results"
    try:
        if reports.exists():
            shutil.rmtree(reports)
    except OSError as error:
        return _not_run(
            Capability.ANDROID_DEVICE,
            f"stale Android instrumentation results could not be cleared: {error}",
        )
    result, successful = _run_fixed_commands_observed(
        Capability.ANDROID_DEVICE,
        ((argv, android_root),),
        environment,
        ("java",),
        context=context,
        retained_stdout_markers=(_ANDROID_NEXUS_DIAGNOSTIC_MARKER,),
    )
    if result.evidence.status is not RunStatus.PASS:
        return result
    if successful is None:
        raise AssertionError("passing Android instrumentation command identity is absent")
    if _android_nexus_diagnostics_required(context):
        if _ANDROID_NEXUS_DIAGNOSTIC_MARKER not in (successful.completed.stdout or ""):
            return _result(
                Capability.ANDROID_DEVICE,
                RunStatus.NOT_RUN,
                result.evidence.duration_ms,
                "successful Nexus-control instrumentation diagnostics were not retained",
            )
        if not _gradle_assertion_passed(android_root, _ANDROID_NEXUS_GESTURE_TEST_TARGET):
            return _result(
                Capability.ANDROID_DEVICE,
                RunStatus.NOT_RUN,
                result.evidence.duration_ms,
                "successful Nexus-control instrumentation did not retain one passing exact proof result",
            )
    artifact, detail = _android_device_success_artifact(
        context,
        device,
        successful,
        environment,
    )
    if artifact is None:
        return _result(
            Capability.ANDROID_DEVICE,
            RunStatus.NOT_RUN,
            result.evidence.duration_ms,
            detail,
        )
    return CapabilityResult(
        replace(result.evidence, artifacts=(artifact,)),
        result.detail,
    )


def _android_nexus_diagnostics_required(context: CapabilityContext) -> bool:
    if context.proof_id is not None:
        return context.proof_id.startswith(f"gradle:{_ANDROID_NEXUS_GESTURE_PROOF_PATH}::")
    return (context.repo_root / _ANDROID_NEXUS_GESTURE_PROOF_PATH).is_file()


def _android_device_artifact_proof_id(context: CapabilityContext) -> str | None:
    if context.proof_id is not None:
        return context.proof_id
    if (context.repo_root / _ANDROID_NEXUS_GESTURE_PROOF_PATH).is_file():
        return _ANDROID_NEXUS_GESTURE_PROOF_ID
    return None


@dataclass(frozen=True, slots=True)
class _AndroidReleaseInputs:
    tag: str
    git_sha: str
    base_url: str
    api_origin: str
    owned_host: str
    certificate_sha256: str
    keystore: Path
    version_code: int
    previous_version_code: int
    version_name: str
    adb: Path
    apksigner: Path
    apkanalyzer: Path


@dataclass(frozen=True, slots=True)
class _AndroidReleaseDeviceInputs(_AndroidReleaseInputs):
    serial: str
    bootstrap: Literal[False] = False


@dataclass(frozen=True, slots=True)
class _AndroidReleaseBootstrapInputs(_AndroidReleaseInputs):
    # The controller measured no device in bootstrap mode; retained evidence
    # records that absence instead of admitting an optional serial downstream.
    serial: None = None
    bootstrap: Literal[True] = True


_AndroidReleaseExecutionInputs = _AndroidReleaseDeviceInputs | _AndroidReleaseBootstrapInputs


# package, versionCode, versionName, App-Link host, targetSdkVersion, player
# protocol version, player protocol contract digest: every fact the signed
# manifest must state exactly.
_ReleaseManifestFacts = tuple[str, str, str, str, str, str, str]


@dataclass(frozen=True, slots=True)
class _AndroidReleaseOperations:
    inputs: Callable[[Path, Mapping[str, str]], _AndroidReleaseExecutionInputs | CapabilityResult]
    command: Callable[[tuple[str, ...], Path, Mapping[str, str]], subprocess.CompletedProcess[str]]
    manifest_facts: Callable[[str], _ReleaseManifestFacts | None]
    read_apk_api_origin: Callable[[Path, Path, Path, Mapping[str, str]], str | None]
    installed_version_code: Callable[[Path, str, Path, Mapping[str, str]], int | None]


def _production_android_release_operations() -> _AndroidReleaseOperations:
    return _AndroidReleaseOperations(
        inputs=_android_release_inputs,
        command=_release_command,
        manifest_facts=_release_manifest_facts,
        read_apk_api_origin=_read_apk_api_origin,
        installed_version_code=_installed_android_version_code,
    )


def _android_release_promotion_arguments(
    environment: Mapping[str, str],
) -> tuple[str, ...] | CapabilityResult:
    """Return the non-secret, fixed physical-promotion identity arguments.

    Authentication itself is deliberately not an argument: the protected USB
    baseline must already hold the dedicated synthetic account's real WebView
    session.  The UUIDs bind that external fixture to the signed test without
    putting a cookie or bearer credential in a command line.
    """
    missing = tuple(name for name in _ANDROID_RELEASE_PROMOTION_INPUTS if not environment.get(name))
    if missing:
        return _not_run(
            Capability.ANDROID_RELEASE,
            "Android release is missing protected offline-reading promotion fixtures: "
            + ", ".join(missing),
        )
    values: dict[str, str] = {}
    for name in _ANDROID_RELEASE_PROMOTION_INPUTS:
        value = environment[name].strip()
        try:
            parsed = UUID(value)
        except ValueError:
            return _fail(
                Capability.ANDROID_RELEASE,
                "Android release offline-reading promotion fixture is not a canonical UUID: "
                + name,
            )
        if parsed.version not in range(1, 9) or str(parsed) != value:
            return _fail(
                Capability.ANDROID_RELEASE,
                "Android release offline-reading promotion fixture is not a canonical UUID: "
                + name,
            )
        values[name] = value
    media_values = tuple(values[name] for name in _ANDROID_RELEASE_PROMOTION_INPUTS[1:])
    if len(set(media_values)) != len(media_values):
        return _fail(
            Capability.ANDROID_RELEASE,
            "Android release offline-reading promotion media fixtures must be distinct",
        )
    arguments: list[str] = []
    for environment_name, instrumentation_name in _ANDROID_RELEASE_PROMOTION_ARGUMENTS:
        arguments.extend(("-e", instrumentation_name, values[environment_name]))
    return tuple(arguments)


def _smali_string_constant(output: str, field: str) -> str | None:
    match = re.search(
        rf'^\.field public static final {re.escape(field)}:Ljava/lang/String; = (".*")$',
        output,
        flags=re.MULTILINE,
    )
    if match is None:
        return None
    try:
        value = json.loads(match.group(1))
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, str) else None


def _read_apk_api_origin(
    apkanalyzer: Path,
    apk: Path,
    repo_root: Path,
    environment: Mapping[str, str],
) -> str | None:
    result = _release_command(
        (
            str(apkanalyzer),
            "dex",
            "code",
            "--class",
            "app.nexus.android.BuildConfig",
            str(apk),
        ),
        repo_root,
        environment,
    )
    if result.returncode != 0:
        return None
    return _smali_string_constant(result.stdout, "NEXUS_API_ORIGIN")


def _run_android_release(
    context: CapabilityContext,
    environment: Mapping[str, str],
    execution: _WorkflowExecution | None,
    operations: _AndroidReleaseOperations | None = None,
) -> CapabilityResult:
    capability = Capability.ANDROID_RELEASE
    if execution is None:
        return _not_run(capability, "Android release requires a controller run identity")
    promotion_owner = (
        context.repo_root / _ANDROID_RELEASE_INSTRUMENTATION_NODES[-1].split("::", 1)[0]
    )
    if not promotion_owner.is_file():
        return _not_run(
            capability,
            "signed physical offline-reading promotion scenario owner is absent",
        )
    promotion_arguments = _android_release_promotion_arguments(environment)
    if isinstance(promotion_arguments, CapabilityResult):
        return promotion_arguments
    started = time.monotonic_ns()
    owned = operations or _production_android_release_operations()
    inputs = owned.inputs(context.repo_root, environment)
    if isinstance(inputs, CapabilityResult):
        return inputs
    try:
        player_protocol = _android_player_protocol_identity(context.repo_root)
    except RuntimeContractError as error:
        return _release_failure(capability, started, str(error))
    android_root = context.repo_root / "apps/android"
    child_environment = _child_environment(environment)
    release_environment_names = (
        "NEXUS_ANDROID_RELEASE_BASE_URL",
        "NEXUS_ANDROID_RELEASE_OWNED_HOST",
        "NEXUS_ANDROID_RELEASE_API_ORIGIN",
        "NEXUS_ANDROID_RELEASE_CERT_SHA256",
        "NEXUS_ANDROID_RELEASE_STORE_FILE",
        "NEXUS_ANDROID_RELEASE_STORE_PASSWORD",
        "NEXUS_ANDROID_RELEASE_KEY_ALIAS",
        "NEXUS_ANDROID_RELEASE_KEY_PASSWORD",
        "NEXUS_ANDROID_VERSION_CODE",
        "NEXUS_ANDROID_VERSION_NAME",
        "NEXUS_GOOGLE_WEB_CLIENT_ID",
    )
    child_environment.update({name: environment[name] for name in release_environment_names})
    try:
        baseline_targets = tuple(
            _android_device_test_target(context.repo_root, node)
            for node in _ANDROID_RELEASE_BASELINE_ACQUISITION_NODES
        )
        offline_targets = tuple(
            _android_device_test_target(context.repo_root, node)
            for node in _ANDROID_RELEASE_COLD_OFFLINE_NODES
        )
        candidate_targets = tuple(
            _android_device_test_target(context.repo_root, node)
            for node in _ANDROID_RELEASE_CANDIDATE_UPDATE_NODES
        )
    except (OSError, UnicodeDecodeError, ValueError) as error:
        return _release_failure(
            capability,
            started,
            f"Android release instrumentation owner is absent or invalid: {error}",
        )
    instrumentation_targets = (*baseline_targets, *offline_targets, *candidate_targets)
    build_command = (
        "./gradlew",
        "--no-daemon",
        "-PnexusAndroidInstrumentationBuildType=release",
        ":app:clean",
        ":app:lintRelease",
        ":app:assembleRelease",
        ":app:assembleReleaseAndroidTest",
    )
    if isinstance(inputs, _AndroidReleaseDeviceInputs):
        child_environment["ANDROID_SERIAL"] = inputs.serial
    with _gradle_lock(context.repo_root):
        # The candidate is built and authenticated before touching the baseline,
        # but it is not installed until after the rebooted offline phase.
        build = owned.command(build_command, android_root, child_environment)
        if build.returncode != 0:
            return _release_command_failure(capability, started, 1, build, child_environment)
        apk = android_root / "app/build/outputs/apk/release/app-release.apk"
        test_apk = (
            android_root / "app/build/outputs/apk/androidTest/release/app-release-androidTest.apk"
        )
        if not apk.is_file() or apk.is_symlink():
            return _release_failure(
                capability, started, "release APK is absent or not a regular file"
            )
        if not test_apk.is_file() or test_apk.is_symlink():
            return _release_failure(
                capability, started, "release instrumentation APK is absent or not a regular file"
            )
        signer = owned.command(
            (str(inputs.apksigner), "verify", "--verbose", "--print-certs", str(apk)),
            context.repo_root,
            child_environment,
        )
        actual_certificate = _apksigner_certificate(signer)
        if signer.returncode != 0 or actual_certificate != inputs.certificate_sha256:
            return _release_failure(
                capability,
                started,
                "release APK signature does not match the protected certificate",
            )
        manifest = owned.command(
            (str(inputs.apkanalyzer), "manifest", "print", str(apk)),
            context.repo_root,
            child_environment,
        )
        manifest_facts = owned.manifest_facts(manifest.stdout)
        expected_manifest = (
            "app.nexus.android",
            str(inputs.version_code),
            inputs.version_name,
            inputs.owned_host,
            str(_ANDROID_TARGET_SDK),
            str(player_protocol.version),
            player_protocol.contract_sha256,
        )
        if manifest.returncode != 0 or manifest_facts != expected_manifest:
            return _release_failure(
                capability,
                started,
                "release APK manifest differs from package/version/App-Link contract",
            )
        embedded_api_origin = owned.read_apk_api_origin(
            inputs.apkanalyzer,
            apk,
            context.repo_root,
            child_environment,
        )
        if embedded_api_origin != inputs.api_origin:
            return _release_failure(
                capability,
                started,
                "signed release APK API origin differs from the protected deployment origin",
            )
        if isinstance(inputs, _AndroidReleaseBootstrapInputs):
            sha256 = _sha256_file(apk)
            evidence_relative = (
                Path("test-results/runs") / execution.run_id / "android-release.json"
            )
            evidence_path = context.repo_root / evidence_relative
            evidence_path.parent.mkdir(parents=True, exist_ok=True)
            evidence_path.write_text(
                json.dumps(
                    {
                        "version": 2,
                        "run_id": execution.run_id,
                        "git_sha": inputs.git_sha,
                        "tag": inputs.tag,
                        "apk_path": apk.relative_to(context.repo_root).as_posix(),
                        "apk_sha256": sha256,
                        "apk_size": apk.stat().st_size,
                        "package": "app.nexus.android",
                        "version_code": inputs.version_code,
                        "previous_version_code": inputs.previous_version_code,
                        "version_name": inputs.version_name,
                        "signer_sha256": inputs.certificate_sha256,
                        # The controller measured no device in this mode; the
                        # retained evidence says so instead of implying one.
                        "physical_device": None,
                        "bootstrap": {
                            "no_device": True,
                            "previous_version_code_source": ("operator_attested_published_stable"),
                            "skipped_stages": {
                                "baseline_acquisition": list(baseline_targets),
                                "cold_offline": list(offline_targets),
                                "candidate_update": list(candidate_targets),
                            },
                        },
                        "instrumentation_proofs": [],
                        "instrumentation_stages": {},
                        "app_link_host": inputs.owned_host,
                        "api_origin": embedded_api_origin,
                        "api_origin_source": "signed_apk_build_config",
                        "target_sdk": _ANDROID_TARGET_SDK,
                        "network_phases": {},
                        "player_protocol": player_protocol.as_json(),
                    },
                    indent=2,
                    sort_keys=True,
                )
                + "\n",
                encoding="utf-8",
            )
            duration_ms = (time.monotonic_ns() - started) // 1_000_000
            return CapabilityResult(
                CapabilityEvidence(
                    capability,
                    RunStatus.PASS,
                    duration_ms,
                    0,
                    artifacts=(evidence_relative.as_posix(),),
                ),
                "signed build, manifest/protocol contract, and pinned API origin verified; "
                "signed-physical device stages explicitly skipped by the bootstrap release",
            )
        serial = inputs.serial
        if serial is None:
            return _release_failure(
                capability,
                started,
                "non-bootstrap Android release has no attested device serial",
            )
        # `adb devices -l` proves a USB topology, not that the endpoint is real
        # hardware. Read the emulator build properties back from the device so
        # the retained evidence records a measurement instead of an assumption.
        qemu_properties: dict[str, str] = {}
        for property_name in ("ro.kernel.qemu", "ro.boot.qemu"):
            observed = owned.command(
                (str(inputs.adb), "-s", serial, "shell", "getprop", property_name),
                context.repo_root,
                child_environment,
            )
            if observed.returncode != 0:
                return _release_failure(
                    capability,
                    started,
                    "dedicated release device emulator properties could not be read",
                )
            qemu_properties[property_name] = observed.stdout.strip()
        if any(value not in {"", "0"} for value in qemu_properties.values()):
            return _release_failure(
                capability,
                started,
                "signed release proof requires physical hardware, not an emulated device",
            )
        baseline_version = owned.installed_version_code(
            inputs.adb,
            serial,
            context.repo_root,
            child_environment,
        )
        if baseline_version != inputs.previous_version_code:
            return _release_failure(
                capability,
                started,
                "installed baseline changed before signed physical acquisition",
            )
        online = owned.command(
            (
                str(inputs.adb),
                "-s",
                serial,
                "shell",
                "cmd",
                "connectivity",
                "airplane-mode",
                "disable",
            ),
            context.repo_root,
            child_environment,
        )
        online_state = owned.command(
            (
                str(inputs.adb),
                "-s",
                serial,
                "shell",
                "settings",
                "get",
                "global",
                "airplane_mode_on",
            ),
            context.repo_root,
            child_environment,
        )
        if (
            online.returncode != 0
            or online_state.returncode != 0
            or online_state.stdout.strip() != "0"
        ):
            return _release_failure(
                capability,
                started,
                "dedicated release device could not be attested online before baseline acquisition",
            )
        test_install = owned.command(
            (
                str(inputs.adb),
                "-s",
                serial,
                "install",
                "-r",
                "-t",
                str(test_apk),
            ),
            context.repo_root,
            child_environment,
        )
        if test_install.returncode != 0:
            return _release_command_failure(capability, started, 2, test_install, child_environment)
        baseline = _run_android_release_instrumentation(
            inputs,
            baseline_targets,
            context.repo_root,
            child_environment,
            promotion_arguments=promotion_arguments,
            command=owned.command,
        )
        if baseline is not None:
            return _release_failure(capability, started, baseline)
        force_stop = owned.command(
            (
                str(inputs.adb),
                "-s",
                serial,
                "shell",
                "am",
                "force-stop",
                "app.nexus.android",
            ),
            context.repo_root,
            child_environment,
        )
        reboot = owned.command(
            (str(inputs.adb), "-s", serial, "reboot"),
            context.repo_root,
            child_environment,
        )
        if force_stop.returncode != 0 or reboot.returncode != 0:
            return _release_failure(
                capability,
                started,
                "dedicated release device could not be force-stopped and rebooted",
            )
        boot = owned.command(
            (str(inputs.adb), "-s", serial, "wait-for-device"),
            context.repo_root,
            child_environment,
        )
        if boot.returncode != 0 or not _android_user_unlocked(
            inputs.adb,
            serial,
            context.repo_root,
            child_environment,
            command=owned.command,
        ):
            return _release_failure(
                capability,
                started,
                "dedicated release device did not complete first unlock after reboot",
            )
        offline = owned.command(
            (
                str(inputs.adb),
                "-s",
                serial,
                "shell",
                "cmd",
                "connectivity",
                "airplane-mode",
                "enable",
            ),
            context.repo_root,
            child_environment,
        )
        offline_state = owned.command(
            (
                str(inputs.adb),
                "-s",
                serial,
                "shell",
                "settings",
                "get",
                "global",
                "airplane_mode_on",
            ),
            context.repo_root,
            child_environment,
        )
        if (
            offline.returncode != 0
            or offline_state.returncode != 0
            or offline_state.stdout.strip() != "1"
        ):
            return _release_failure(
                capability,
                started,
                "dedicated release device could not be attested offline after reboot",
            )
        cold_offline = _run_android_release_instrumentation(
            inputs,
            offline_targets,
            context.repo_root,
            child_environment,
            promotion_arguments=promotion_arguments,
            command=owned.command,
        )
        if cold_offline is not None:
            return _release_failure(capability, started, cold_offline)
        candidate_install = owned.command(
            (str(inputs.adb), "-s", serial, "install", "-r", str(apk)),
            context.repo_root,
            child_environment,
        )
        if candidate_install.returncode != 0:
            return _release_command_failure(
                capability, started, 3, candidate_install, child_environment
            )
        installed_version = owned.installed_version_code(
            inputs.adb, serial, context.repo_root, child_environment
        )
        if installed_version != inputs.version_code:
            return _release_failure(
                capability,
                started,
                "signed physical update did not install the candidate version in place",
            )
        candidate_update = _run_android_release_instrumentation(
            inputs,
            candidate_targets,
            context.repo_root,
            child_environment,
            promotion_arguments=promotion_arguments,
            command=owned.command,
        )
        if candidate_update is not None:
            return _release_failure(capability, started, candidate_update)
        verified_again = owned.command(
            (str(inputs.apksigner), "verify", "--verbose", "--print-certs", str(apk)),
            context.repo_root,
            child_environment,
        )
        manifest_again = owned.command(
            (str(inputs.apkanalyzer), "manifest", "print", str(apk)),
            context.repo_root,
            child_environment,
        )
        if not _release_apk_contract_is_exact(
            signer=verified_again,
            manifest=manifest_again,
            expected_certificate=inputs.certificate_sha256,
            expected_manifest=expected_manifest,
            manifest_facts=owned.manifest_facts,
        ):
            return _release_failure(
                capability,
                started,
                "tested release APK signature or manifest changed after instrumentation",
            )
        resolved = owned.command(
            (
                str(inputs.adb),
                "-s",
                serial,
                "shell",
                "cmd",
                "package",
                "resolve-activity",
                "--brief",
                "-a",
                "android.intent.action.VIEW",
                "-c",
                "android.intent.category.BROWSABLE",
                "-d",
                f"{inputs.base_url}/",
            ),
            context.repo_root,
            child_environment,
        )
    resolved_activity = resolved.stdout.strip().splitlines()[-1:] or [""]
    if resolved.returncode != 0 or resolved_activity[0] not in {
        "app.nexus.android/.MainActivity",
        "app.nexus.android/app.nexus.android.MainActivity",
    }:
        return _release_failure(
            capability,
            started,
            "installed release APK does not resolve its owned HTTPS App Link",
        )
    sha256 = _sha256_file(apk)
    evidence_relative = Path("test-results/runs") / execution.run_id / "android-release.json"
    evidence_path = context.repo_root / evidence_relative
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_path.write_text(
        json.dumps(
            {
                "version": 2,
                "run_id": execution.run_id,
                "git_sha": inputs.git_sha,
                "tag": inputs.tag,
                "apk_path": apk.relative_to(context.repo_root).as_posix(),
                "apk_sha256": sha256,
                "apk_size": apk.stat().st_size,
                "package": "app.nexus.android",
                "version_code": inputs.version_code,
                "previous_version_code": inputs.previous_version_code,
                "version_name": inputs.version_name,
                "signer_sha256": inputs.certificate_sha256,
                "physical_device": {
                    "serial": serial,
                    "connection": "usb",
                    "qemu_properties": qemu_properties,
                },
                "instrumentation_proofs": list(instrumentation_targets),
                "instrumentation_stages": {
                    "baseline_acquisition": list(baseline_targets),
                    "cold_offline": list(offline_targets),
                    "candidate_update": list(candidate_targets),
                },
                "app_link_host": inputs.owned_host,
                "api_origin": embedded_api_origin,
                "api_origin_source": "signed_apk_build_config",
                "target_sdk": _ANDROID_TARGET_SDK,
                "resolved_activity": resolved_activity[0],
                # Each phase records the value the controller actually read back
                # from `settings get global airplane_mode_on`, not a claim about
                # traffic it never observed.
                "network_phases": {
                    "baseline_acquisition": {
                        "phase": "airplane_disabled_then_real_api_acquisition",
                        "airplane_mode_on": online_state.stdout.strip(),
                    },
                    "cold_offline": {
                        "phase": "airplane_attested_after_reboot",
                        "airplane_mode_on": offline_state.stdout.strip(),
                    },
                },
                "player_protocol": player_protocol.as_json(),
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    duration_ms = (time.monotonic_ns() - started) // 1_000_000
    return CapabilityResult(
        CapabilityEvidence(
            capability,
            RunStatus.PASS,
            duration_ms,
            0,
            artifacts=(evidence_relative.as_posix(),),
        ),
        "signed baseline acquisition, rebooted-airplane offline shelf, and in-place "
        "candidate update passed on USB physical hardware",
    )


def _run_release_artifact(
    context: CapabilityContext,
    environment: Mapping[str, str],
    execution: _WorkflowExecution | None,
) -> CapabilityResult:
    capability = Capability.RELEASE_ARTIFACT
    if execution is None:
        return _not_run(capability, "release artifact requires a controller run identity")
    started = time.monotonic_ns()
    proofs = _run_release_artifact_proofs(context, environment, execution)
    if proofs.evidence.status is not RunStatus.PASS:
        return proofs
    evidence_path = (
        context.repo_root / "test-results/runs" / execution.run_id / "android-release.json"
    )
    try:
        source = json.loads(evidence_path.read_text(encoding="utf-8"))
        evidence_version = source["version"]
        tag = source["tag"]
        apk_relative = source["apk_path"]
        expected_sha256 = source["apk_sha256"]
        signer = source["signer_sha256"]
        package = source["package"]
        version_code = source["version_code"]
        previous_version_code = source["previous_version_code"]
        version_name = source["version_name"]
        git_sha = source["git_sha"]
        app_link_host = source["app_link_host"]
        api_origin = source["api_origin"]
        target_sdk = source["target_sdk"]
        player_protocol = _android_player_protocol_identity_from_json(source["player_protocol"])
    except (
        OSError,
        RuntimeContractError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        KeyError,
        TypeError,
    ):
        return _release_failure(
            capability, started, "same-run Android release evidence is absent or invalid"
        )
    if (
        evidence_version != 2
        or source.get("run_id") != execution.run_id
        or not isinstance(tag, str)
        or ANDROID_RELEASE_TAG.fullmatch(tag) is None
        or apk_relative != "apps/android/app/build/outputs/apk/release/app-release.apk"
        or not isinstance(expected_sha256, str)
        or re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None
        or not isinstance(signer, str)
        or re.fullmatch(r"[0-9a-f]{64}", signer) is None
        or package != "app.nexus.android"
        or isinstance(version_code, bool)
        or not isinstance(version_code, int)
        or version_code < 1
        or isinstance(previous_version_code, bool)
        or not isinstance(previous_version_code, int)
        or previous_version_code < 1
        or previous_version_code >= version_code
        or not isinstance(version_name, str)
        or version_name != tag.removeprefix("android-v")
        or not isinstance(git_sha, str)
        or re.fullmatch(r"[0-9a-f]{40}", git_sha) is None
        or app_link_host != _ANDROID_RELEASE_OWNED_HOST
        or not isinstance(api_origin, str)
        or not _is_exact_https_origin(api_origin)
        or source.get("api_origin_source") != "signed_apk_build_config"
        or target_sdk != _ANDROID_TARGET_SDK
    ):
        return _release_failure(capability, started, "Android release evidence changed shape")
    try:
        expected_player_protocol = _android_player_protocol_identity(context.repo_root)
    except RuntimeContractError as error:
        return _release_failure(capability, started, str(error))
    if player_protocol != expected_player_protocol:
        return _release_failure(
            capability,
            started,
            "Android release evidence player protocol differs from the repository corpus",
        )
    apk = context.repo_root / apk_relative
    try:
        tag_sha = _git_commit(context.repo_root, tag, environment)
        head_sha = _git_commit(context.repo_root, "HEAD", environment)
    except RuntimeContractError as error:
        return _release_failure(capability, started, str(error))
    if (
        not apk.is_file()
        or apk.is_symlink()
        or _sha256_file(apk) != expected_sha256
        or tag_sha != git_sha
        or head_sha != git_sha
    ):
        return _release_failure(
            capability,
            started,
            "release source APK, tag, or commit differs from verified evidence",
        )
    sdk_tools = _android_release_tools(environment)
    if sdk_tools is None:
        return _not_run(capability, "Android release SDK tools are absent")
    _adb, apksigner, apkanalyzer = sdk_tools
    child_environment = _child_environment(environment)
    verified = _release_command(
        (str(apksigner), "verify", "--verbose", "--print-certs", str(apk)),
        context.repo_root,
        child_environment,
    )
    manifest = _release_command(
        (str(apkanalyzer), "manifest", "print", str(apk)),
        context.repo_root,
        child_environment,
    )
    expected_manifest = (
        package,
        str(version_code),
        version_name,
        app_link_host,
        str(target_sdk),
        str(expected_player_protocol.version),
        expected_player_protocol.contract_sha256,
    )
    if not _release_apk_contract_is_exact(
        signer=verified,
        manifest=manifest,
        expected_certificate=signer,
        expected_manifest=expected_manifest,
    ):
        return _release_failure(
            capability,
            started,
            "release source APK signature or manifest changed before staging",
        )
    embedded_api_origin = _read_apk_api_origin(
        apkanalyzer,
        apk,
        context.repo_root,
        child_environment,
    )
    if embedded_api_origin != api_origin:
        return _release_failure(
            capability,
            started,
            "release source APK API origin differs from signed-device evidence",
        )
    release_root = context.repo_root / "test-results/runs" / execution.run_id
    staged = release_root / "release"
    temporary = release_root / "release.tmp"
    if staged.exists() or temporary.exists():
        return _release_failure(capability, started, "same-run release staging path already exists")
    temporary.mkdir(parents=True)
    versioned_name = f"nexus-android-{version_name}.apk"
    names = ("nexus-android.apk", versioned_name)
    for name in names:
        shutil.copy2(apk, temporary / name)
        (temporary / f"{name}.sha256").write_text(
            f"{expected_sha256}  {name}\n",
            encoding="utf-8",
        )
    manifest = {
        "version": 2,
        "run_id": execution.run_id,
        "git_sha": git_sha,
        "tag": tag,
        "package": "app.nexus.android",
        "version_code": version_code,
        "previous_version_code": previous_version_code,
        "version_name": version_name,
        "signer_sha256": signer,
        "source_apk_sha256": expected_sha256,
        "api_origin": api_origin,
        "api_origin_source": "signed_apk_build_config",
        "target_sdk": target_sdk,
        "player_protocol": player_protocol.as_json(),
        "assets": {
            name: _sha256_file(temporary / name)
            for name in (*names, *(f"{name}.sha256" for name in names))
        },
    }
    (temporary / "release-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.rename(staged)
    artifacts = tuple(
        (staged / name).relative_to(context.repo_root).as_posix()
        for name in (
            "nexus-android.apk",
            "nexus-android.apk.sha256",
            versioned_name,
            f"{versioned_name}.sha256",
            "release-manifest.json",
        )
    )
    duration_ms = (time.monotonic_ns() - started) // 1_000_000
    return CapabilityResult(
        CapabilityEvidence(
            capability,
            RunStatus.PASS,
            duration_ms,
            0,
            artifacts=artifacts,
        ),
        "verified Android release assets were staged atomically",
    )


def _android_release_inputs(
    repo_root: Path, environment: Mapping[str, str]
) -> _AndroidReleaseExecutionInputs | CapabilityResult:
    capability = Capability.ANDROID_RELEASE
    names = (
        "ANDROID_RELEASE_TAG",
        "NEXUS_ANDROID_RELEASE_BASE_URL",
        "NEXUS_ANDROID_RELEASE_OWNED_HOST",
        "NEXUS_ANDROID_RELEASE_API_ORIGIN",
        "NEXUS_ANDROID_RELEASE_CERT_SHA256",
        "NEXUS_ANDROID_RELEASE_STORE_FILE",
        "NEXUS_ANDROID_RELEASE_STORE_PASSWORD",
        "NEXUS_ANDROID_RELEASE_KEY_ALIAS",
        "NEXUS_ANDROID_RELEASE_KEY_PASSWORD",
        "NEXUS_ANDROID_VERSION_CODE",
        "NEXUS_ANDROID_VERSION_NAME",
        "NEXUS_GOOGLE_WEB_CLIENT_ID",
    )
    missing = tuple(name for name in names if not environment.get(name))
    if missing:
        return _not_run(
            capability, "Android release is missing protected inputs: " + ", ".join(missing)
        )
    tag = environment["ANDROID_RELEASE_TAG"]
    if ANDROID_RELEASE_TAG.fullmatch(tag) is None:
        return _fail(capability, "Android release tag must match android-v*")
    try:
        tag_sha = _git_commit(repo_root, tag, environment)
        head_sha = _git_commit(repo_root, "HEAD", environment)
        if tag_sha != head_sha:
            return _fail(capability, "Android release tag does not resolve to HEAD")
    except RuntimeContractError as error:
        return _fail(capability, str(error))
    base_url = environment["NEXUS_ANDROID_RELEASE_BASE_URL"]
    owned_host = environment["NEXUS_ANDROID_RELEASE_OWNED_HOST"]
    if (
        owned_host != _ANDROID_RELEASE_OWNED_HOST
        or base_url != f"https://{owned_host}"
        or not _is_exact_https_origin(base_url)
    ):
        return _fail(capability, "Android release URL must be the canonical HTTPS origin")
    api_origin = environment["NEXUS_ANDROID_RELEASE_API_ORIGIN"]
    if not _is_exact_https_origin(api_origin):
        return _fail(capability, "Android release API origin must be one exact HTTPS origin")
    certificate = environment["NEXUS_ANDROID_RELEASE_CERT_SHA256"].replace(":", "").lower()
    if re.fullmatch(r"[0-9a-f]{64}", certificate) is None:
        return _fail(capability, "Android release certificate must be SHA-256")
    keystore = Path(environment["NEXUS_ANDROID_RELEASE_STORE_FILE"])
    try:
        mode = keystore.stat().st_mode
    except OSError:
        return _not_run(capability, "Android release keystore is absent")
    if not keystore.is_file() or keystore.is_symlink() or mode & 0o077:
        return _fail(capability, "Android release keystore must be a private regular file")
    try:
        version_code = int(environment["NEXUS_ANDROID_VERSION_CODE"])
    except ValueError:
        return _fail(capability, "Android release version code must be a positive integer")
    if version_code < 1:
        return _fail(capability, "Android release version code must be a positive integer")
    version_name = environment["NEXUS_ANDROID_VERSION_NAME"]
    if version_name != tag.removeprefix("android-v"):
        return _fail(capability, "Android release version name must derive exactly from its tag")
    tools = _android_release_tools(environment)
    if tools is None:
        return _not_run(capability, "Android release SDK tools are absent")
    adb, apksigner, apkanalyzer = tools
    if environment.get("NEXUS_ANDROID_RELEASE_BOOTSTRAP_NO_DEVICE") == "true":
        # Explicit bootstrap mode: no published release carries offline reading,
        # so no in-the-wild offline state exists for the signed-physical stages
        # to protect. The operator attests the published stable version code
        # because there is no installed baseline for the controller to measure.
        raw_previous_version_code = environment.get("NEXUS_ANDROID_PREVIOUS_VERSION_CODE", "")
        try:
            previous_version_code = int(raw_previous_version_code)
        except ValueError:
            previous_version_code = 0
        if previous_version_code < 1:
            return _fail(
                capability,
                "Android bootstrap release requires the published stable version code",
            )
        if previous_version_code >= version_code:
            return _fail(
                capability,
                "Android release version code must be greater than the published stable baseline",
            )
        return _AndroidReleaseBootstrapInputs(
            tag=tag,
            git_sha=head_sha,
            base_url=base_url,
            api_origin=api_origin,
            owned_host=owned_host,
            certificate_sha256=certificate,
            keystore=keystore,
            version_code=version_code,
            previous_version_code=previous_version_code,
            version_name=version_name,
            adb=adb,
            apksigner=apksigner,
            apkanalyzer=apkanalyzer,
        )
    device, device_error = authorized_usb_physical_device(adb, environment, repo_root)
    if device is None:
        status = RunStatus.FAIL if device_error.startswith("unsafe") else RunStatus.NOT_RUN
        return _result(capability, status, 0, device_error)
    previous_version_code = _installed_android_version_code(
        adb,
        device.serial,
        repo_root,
        environment,
    )
    if previous_version_code is None:
        return _not_run(
            capability,
            "Android release device has no installed baseline app for an in-place update",
        )
    if previous_version_code >= version_code:
        return _fail(
            capability,
            "Android release version code must be greater than the installed baseline",
        )
    return _AndroidReleaseDeviceInputs(
        tag=tag,
        git_sha=head_sha,
        base_url=base_url,
        api_origin=api_origin,
        owned_host=owned_host,
        certificate_sha256=certificate,
        keystore=keystore,
        version_code=version_code,
        previous_version_code=previous_version_code,
        version_name=version_name,
        adb=adb,
        apksigner=apksigner,
        apkanalyzer=apkanalyzer,
        serial=device.serial,
    )


def _android_release_tools(
    environment: Mapping[str, str],
) -> tuple[Path, Path, Path] | None:
    sdk = resolve_android_sdk(environment)
    if sdk is None:
        return None
    adb = sdk / "platform-tools/adb"
    apksigners = tuple(sdk.glob("build-tools/*/apksigner"))
    analyzers = tuple(sdk.glob("cmdline-tools/*/bin/apkanalyzer"))
    if not adb.is_file() or not apksigners or not analyzers:
        return None
    return (
        adb,
        max(apksigners, key=lambda path: _android_tool_version(path.parent.name)),
        max(
            analyzers,
            key=lambda path: (path.parents[1].name == "latest", path.parents[1].name),
        ),
    )


def _android_tool_version(value: str) -> tuple[int, ...]:
    numbers = tuple(int(part) for part in re.findall(r"\d+", value))
    return numbers or (0,)


def _installed_android_version_code(
    adb: Path,
    serial: str,
    repo_root: Path,
    environment: Mapping[str, str],
) -> int | None:
    package = _release_command(
        (str(adb), "-s", serial, "shell", "dumpsys", "package", "app.nexus.android"),
        repo_root,
        _child_environment(environment),
    )
    if package.returncode != 0:
        return None
    match = re.search(r"(?m)^\s*versionCode=(\d+)\b", package.stdout)
    return int(match.group(1)) if match is not None else None


def _release_command(
    argv: tuple[str, ...], cwd: Path, environment: Mapping[str, str]
) -> subprocess.CompletedProcess[str]:
    try:
        return run_command(
            argv,
            cwd=cwd,
            env=dict(environment),
            capture_output=True,
            check=False,
        )
    except OSError as error:
        return subprocess.CompletedProcess(argv, 127, "", str(error))


def _run_android_release_instrumentation(
    inputs: _AndroidReleaseDeviceInputs,
    targets: tuple[str, ...],
    repo_root: Path,
    environment: Mapping[str, str],
    *,
    promotion_arguments: tuple[str, ...] = (),
    command: Callable[
        [tuple[str, ...], Path, Mapping[str, str]], subprocess.CompletedProcess[str]
    ] = _release_command,
) -> str | None:
    serial = inputs.serial
    if serial is None:
        return "release instrumentation requires a dedicated device serial"
    for target in targets:
        result = command(
            (
                str(inputs.adb),
                "-s",
                serial,
                "shell",
                "am",
                "instrument",
                "-w",
                "-r",
                "-e",
                "class",
                target,
                *promotion_arguments,
                "app.nexus.android.test/androidx.test.runner.AndroidJUnitRunner",
            ),
            repo_root,
            environment,
        )
        if result.returncode != 0 or not _android_instrumentation_one_test_passed(result.stdout):
            return "release instrumentation did not emit an exact passing proof: " + target
    return None


def _android_instrumentation_one_test_passed(output: str) -> bool:
    lines = [line.strip() for line in _ANSI_ESCAPE_RE.sub("", output).splitlines() if line.strip()]
    if not lines or lines.count("OK (1 test)") != 1:
        return False
    has_instrumentation_envelope = any(line.startswith("INSTRUMENTATION_") for line in lines)
    if has_instrumentation_envelope:
        if lines[-1] != "INSTRUMENTATION_CODE: -1":
            return False
    elif lines[-1] != "OK (1 test)":
        return False
    failure_marker = re.compile(
        r"""(?ix)
        ^failures!!!$ |
        ^failure:\s |
        ^tests\ run:\s*\d+,\s*(?:failures|errors):\s*[1-9]\d* |
        ^instrumentation_result:\s*shortmsg= |
        ^instrumentation_status:\s*(?:.*\b(?:stack|shortmsg)\b) |
        ^\s*at\s+[\w.$]+\(.*\)$ |
        ^\s*(?:caused\ by:|stack(?:\ trace)?\b|java\.[\w.$]+(?:exception|error)\b) |
        \b(?:assumptionfailure|test\ ignored|test\ skipped|process\ crashed)\b
        """
    )
    return not any(failure_marker.search(line) for line in lines)


def _android_user_unlocked(
    adb: Path,
    serial: str,
    repo_root: Path,
    environment: Mapping[str, str],
    *,
    command: Callable[
        [tuple[str, ...], Path, Mapping[str, str]], subprocess.CompletedProcess[str]
    ] = _release_command,
) -> bool:
    deadline = time.monotonic() + 120
    while True:
        unlocked = command(
            (
                str(adb),
                "-s",
                serial,
                "shell",
                "getprop",
                "sys.user.0.ce_available",
            ),
            repo_root,
            environment,
        )
        if unlocked.returncode == 0 and unlocked.stdout.strip().lower() == "true":
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(1)


def _release_command_failure(
    capability: Capability,
    started: int,
    index: int,
    completed: subprocess.CompletedProcess[str],
    environment: Mapping[str, str],
) -> CapabilityResult:
    duration_ms = (time.monotonic_ns() - started) // 1_000_000
    return _result(
        capability,
        RunStatus.FAIL,
        duration_ms,
        redact_text(_failed_command_detail(index, completed), environment_secrets(environment)),
    )


def _release_failure(capability: Capability, started: int, detail: str) -> CapabilityResult:
    return _result(
        capability,
        RunStatus.FAIL,
        (time.monotonic_ns() - started) // 1_000_000,
        detail,
    )


def _release_artifact_setup_result(
    result: CapabilityResult,
    phase: str,
) -> CapabilityResult:
    return CapabilityResult(
        result.evidence,
        f"proof_result=setup_or_execution_failure|{phase}: {result.detail}",
    )


def _apksigner_certificate(completed: subprocess.CompletedProcess[str]) -> str | None:
    match = re.search(
        r"(?im)^Signer #1 certificate SHA-256 digest:\s*([0-9a-f:]{64,95})\s*$",
        f"{completed.stdout}\n{completed.stderr}",
    )
    return match.group(1).replace(":", "").lower() if match else None


def _release_apk_contract_is_exact(
    *,
    signer: subprocess.CompletedProcess[str],
    manifest: subprocess.CompletedProcess[str],
    expected_certificate: str,
    expected_manifest: _ReleaseManifestFacts,
    manifest_facts: Callable[[str], _ReleaseManifestFacts | None] | None = None,
) -> bool:
    facts = manifest_facts or _release_manifest_facts
    return (
        signer.returncode == 0
        and _apksigner_certificate(signer) == expected_certificate
        and manifest.returncode == 0
        and facts(manifest.stdout) == expected_manifest
    )


def _release_manifest_facts(text: str) -> _ReleaseManifestFacts | None:
    start = text.find("<manifest")
    if start < 0:
        return None
    try:
        root = ET.fromstring(text[start:])
    except ET.ParseError:
        return None
    android = "{http://schemas.android.com/apk/res/android}"
    application = root.find("application")
    if application is None or application.attrib.get(f"{android}usesCleartextTraffic") != "false":
        return None
    uses_sdk = root.find("uses-sdk")
    if uses_sdk is None or uses_sdk.attrib.get(f"{android}targetSdkVersion") != str(
        _ANDROID_TARGET_SDK
    ):
        return None
    hosts: set[str] = set()
    for intent_filter in root.findall("./application/activity/intent-filter"):
        if intent_filter.attrib.get(f"{android}autoVerify") != "true":
            continue
        for data in intent_filter.findall("data"):
            if data.attrib.get(f"{android}scheme") == "https":
                host = data.attrib.get(f"{android}host")
                if host:
                    hosts.add(host)
    if len(hosts) != 1:
        return None
    player_metadata: dict[str, str] = {}
    for metadata in root.findall("./application/meta-data"):
        name = metadata.attrib.get(f"{android}name")
        value = metadata.attrib.get(f"{android}value")
        if name not in {
            "app.nexus.android.PLAYER_PROTOCOL_VERSION",
            "app.nexus.android.PLAYER_PROTOCOL_CONTRACT_SHA256",
        }:
            continue
        if name in player_metadata or value is None:
            return None
        player_metadata[name] = value
    if set(player_metadata) != {
        "app.nexus.android.PLAYER_PROTOCOL_VERSION",
        "app.nexus.android.PLAYER_PROTOCOL_CONTRACT_SHA256",
    }:
        return None
    return (
        root.attrib.get("package", ""),
        root.attrib.get(f"{android}versionCode", ""),
        root.attrib.get(f"{android}versionName", ""),
        next(iter(hosts)),
        uses_sdk.attrib.get(f"{android}targetSdkVersion", ""),
        player_metadata["app.nexus.android.PLAYER_PROTOCOL_VERSION"],
        player_metadata["app.nexus.android.PLAYER_PROTOCOL_CONTRACT_SHA256"],
    )


def _android_player_protocol_identity(repo_root: Path) -> AndroidPlayerProtocolIdentity:
    try:
        return AndroidPlayerProtocolIdentity.of_corpus(repo_root / _ANDROID_PLAYER_PROTOCOL_CORPUS)
    except BackendArtifactDefect as error:
        raise RuntimeContractError(str(error)) from error


def _android_player_protocol_identity_from_json(value: object) -> AndroidPlayerProtocolIdentity:
    try:
        return AndroidPlayerProtocolIdentity.from_json(value)
    except BackendArtifactDefect as error:
        raise RuntimeContractError(
            "Android release evidence player protocol changed shape"
        ) from error


def _git_commit(repo_root: Path, revision: str, environment: Mapping[str, str]) -> str:
    child_environment = _child_environment(environment)
    git = shutil.which("git", path=child_environment.get("PATH"))
    if git is None:
        raise RuntimeContractError("required tool is absent: git")
    result = _release_command(
        (git, "rev-parse", "--verify", f"{revision}^{{commit}}"),
        repo_root,
        child_environment,
    )
    sha = result.stdout.strip()
    if result.returncode != 0 or re.fullmatch(r"[0-9a-f]{40}", sha) is None:
        raise RuntimeContractError(f"Git revision is not exact: {revision}")
    return sha


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _gradle_assertion_passed(android_root: Path, target: str) -> bool:
    class_name, separator, method = target.partition("#")
    reports = android_root / "app/build/outputs/androidTest-results"
    matches = 0
    for report in reports.rglob("*.xml") if reports.is_dir() else ():
        try:
            root = ET.parse(report).getroot()
        except (OSError, ET.ParseError):
            continue
        for case in root.iter("testcase"):
            if case.attrib.get("classname") != class_name:
                continue
            if separator and case.attrib.get("name") != method:
                continue
            matches += 1
            if any(case.find(node) is not None for node in ("failure", "error", "skipped")):
                return False
    return matches == 1


def _isolated_python_cache_failure(
    repo_root: Path,
    environment: Mapping[str, str],
    *,
    command_runner: Callable[..., subprocess.CompletedProcess[str]] = run_command,
) -> str | None:
    with tempfile.TemporaryDirectory(prefix="nexus-doctor-python-") as temporary:
        isolated_environment = {
            **environment,
            "UV_PROJECT_ENVIRONMENT": str(Path(temporary) / ".venv"),
        }
        command = (
            "uv",
            "sync",
            "--project",
            str(repo_root / "python"),
            "--all-extras",
            "--locked",
            "--offline",
            "--no-progress",
        )
        try:
            checked = command_runner(
                command,
                cwd=repo_root,
                env=isolated_environment,
                capture_output=True,
                check=False,
            )
        except OSError as error:
            return (
                f"fresh offline Python environment check could not start: {error.strerror or error}"
            )
    if checked.returncode != 0:
        return "locked Python artifacts cannot materialize a fresh offline environment"
    return None


def _run_doctor(context: CapabilityContext, environment: Mapping[str, str]) -> CapabilityResult:
    started = time.monotonic_ns()
    child_environment = _child_environment(environment)
    required_tools = ("actionlint", "bun", "docker", "git", "java", "node", "supabase", "uv")
    missing_tools = tuple(
        tool
        for tool in required_tools
        if shutil.which(tool, path=child_environment.get("PATH")) is None
    )
    if missing_tools:
        return _not_run(Capability.DOCTOR, f"required tools are absent: {', '.join(missing_tools)}")
    missing_platform_tools = tuple(
        path.as_posix()
        for path in (*required_platform_memory_tools(), *required_platform_process_tools())
        if not path.is_file() or not os.access(path, os.X_OK)
    )
    if missing_platform_tools:
        return _not_run(
            Capability.DOCTOR,
            f"required platform tools are absent: {', '.join(missing_platform_tools)}",
        )

    required_paths = (
        "python/pyproject.toml",
        "python/uv.lock",
        "python/.venv",
        "apps/web/package.json",
        "apps/web/bun.lock",
        "apps/web/node_modules",
        "apps/web/e2e/playwright.config.ts",
        "apps/android/gradlew",
        "node/ingest/package.json",
        "node/ingest/bun.lock",
        "node/ingest/node_modules",
    )
    missing_paths = tuple(
        relative for relative in required_paths if not (context.repo_root / relative).exists()
    )
    if missing_paths:
        return _not_run(
            Capability.DOCTOR, f"locked tool owners are absent: {', '.join(missing_paths)}"
        )

    cache_failure = _isolated_python_cache_failure(
        context.repo_root,
        child_environment,
    )
    if cache_failure is not None:
        return _fail(Capability.DOCTOR, cache_failure)

    dependency_commands: tuple[FixedCommand, ...] = (
        (
            (
                "uv",
                "sync",
                "--all-extras",
                "--locked",
                "--dry-run",
                "--offline",
            ),
            context.repo_root / "python",
        ),
        (
            (
                "bun",
                "install",
                "--frozen-lockfile",
                "--dry-run",
                "--offline",
                "--ignore-scripts",
            ),
            context.repo_root / "apps/web",
        ),
        (
            (
                "bun",
                "install",
                "--frozen-lockfile",
                "--dry-run",
                "--offline",
                "--ignore-scripts",
            ),
            context.repo_root / "node/ingest",
        ),
        (
            (
                str(context.repo_root / "python/.venv/bin/python"),
                "-c",
                "import llm_tools, provider_runtime",
            ),
            context.repo_root,
        ),
    )
    for command, cwd in dependency_commands:
        try:
            checked = run_command(
                command,
                cwd=cwd,
                env=child_environment,
                capture_output=True,
                check=False,
            )
        except OSError as error:
            return _not_run(
                Capability.DOCTOR,
                f"locked dependency check could not start: {error.strerror or error}",
            )
        output = f"{checked.stdout or ''}\n{checked.stderr or ''}"
        if checked.returncode != 0:
            return _fail(Capability.DOCTOR, "locked dependency coherence check failed")
        if command[0] == "uv" and re.search(r"(?m)^Would (?:download|install|uninstall) ", output):
            return _fail(Capability.DOCTOR, "locked Python environment is stale")

    for suite in (_PROVIDER_RUNTIME_SUITE, _LLM_TOOLS_SUITE):
        try:
            ready = _pinned_python_suite_checkout_ready(context.repo_root, suite)
        except (OSError, RuntimeContractError):
            return _not_run(
                Capability.DOCTOR,
                f"pinned {suite.package} checkout is unavailable",
            )
        if not ready:
            return _not_run(
                Capability.DOCTOR,
                f"pinned {suite.package} checkout is not ready",
            )

    if not android_sdk_available(context.repo_root / "apps/android", environment):
        return _not_run(Capability.DOCTOR, "the Android SDK is absent")
    if not _browser_installed(context.repo_root, environment):
        return _not_run(Capability.DOCTOR, "the locked Chromium browser is absent")
    if shutil.which("systemd-run", path=child_environment.get("PATH")) is None:
        return _not_run(Capability.DOCTOR, "the user-systemd cgroup delegate is absent")
    cgroup_delegate_diagnostic = cgroup_delegate_failure()
    if cgroup_delegate_diagnostic is not None:
        return _fail(Capability.DOCTOR, cgroup_delegate_diagnostic)

    try:
        runtime = read_runtime(context.repo_root)
    except (OSError, ValueError):
        return _not_run(Capability.DOCTOR, "the local test runtime is not initialized")
    for owner, port in (
        ("postgres", runtime.ports.postgres),
        ("minio", runtime.ports.minio),
        ("supabase", runtime.ports.supabase_api),
    ):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                pass
        except OSError:
            duration_ms = (time.monotonic_ns() - started) // 1_000_000
            return _result(
                Capability.DOCTOR,
                RunStatus.FAIL,
                duration_ms,
                f"recorded {owner} endpoint is not healthy",
            )

    try:
        with httpx.Client(trust_env=False, timeout=1, follow_redirects=False) as client:
            minio_health = client.get(f"http://127.0.0.1:{runtime.ports.minio}/minio/health/live")
            supabase_health = client.get(
                f"http://127.0.0.1:{runtime.ports.supabase_api}/auth/v1/health"
            )
    except httpx.HTTPError:
        return _fail(Capability.DOCTOR, "local service semantic health check failed")
    if minio_health.status_code != 200 or supabase_health.status_code != 200:
        return _fail(Capability.DOCTOR, "local service semantic health check failed")

    expected_template = template_database_name(_repository_template_fingerprint(context.repo_root))
    try:
        with psycopg.connect(
            host="127.0.0.1",
            port=runtime.ports.postgres,
            dbname="postgres",
            user="postgres",
            password="postgres",
            connect_timeout=1,
        ) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT datallowconn FROM pg_database WHERE datname = %s",
                    (expected_template,),
                )
                template = cursor.fetchone()
    except (OSError, psycopg.Error):
        duration_ms = (time.monotonic_ns() - started) // 1_000_000
        return _result(
            Capability.DOCTOR,
            RunStatus.FAIL,
            duration_ms,
            "recorded PostgreSQL template could not be inspected",
        )
    duration_ms = (time.monotonic_ns() - started) // 1_000_000
    if template != (False,):
        return _result(
            Capability.DOCTOR,
            RunStatus.FAIL,
            duration_ms,
            "fingerprinted PostgreSQL template is absent or connectable",
        )
    protected_missing: list[str] = []
    if protected_missing:
        return _not_run(
            Capability.DOCTOR,
            "enabled protected workflows lack inputs: " + ", ".join(protected_missing),
        )
    return _result(
        Capability.DOCTOR,
        RunStatus.PASS,
        duration_ms,
        "tools, locked dependencies, browser, services, ports, template, and enabled workflow inputs are ready",
    )


def _scope(context: CapabilityContext, capability: Capability) -> SelectionScope:
    for requirement in WORKFLOW_REGISTRY[context.workflow].requirements:
        if requirement.capability is capability:
            return requirement.scope
    raise ValueError(f"{capability.value} is not required by workflow {context.workflow.value}")


def _capability_is_selected(context: CapabilityContext, capability: Capability) -> bool:
    return _scope(context, capability) is SelectionScope.COMPLETE or any(
        selection.capability is capability for selection in context.selection
    )


def _selected_files(
    context: CapabilityContext, prefix: str, suffixes: tuple[str, ...]
) -> tuple[str, ...]:
    paths: set[str] = set()
    root = context.repo_root.resolve(strict=True)
    for selection in context.selection:
        path = selection.path
        if not path.startswith(prefix) or not path.endswith(suffixes):
            continue
        candidate = (root / path).resolve(strict=False)
        try:
            relative = candidate.relative_to(root).as_posix()
        except ValueError as error:
            raise ValueError(f"selected path leaves the repository: {path}") from error
        if relative != path:
            raise ValueError(f"selected file is not exact: {path}")
        if not candidate.is_file():
            continue
        paths.add(path)
    return tuple(sorted(paths))


def _selected_proof_nodes(
    context: CapabilityContext, capability: Capability, runner: str
) -> tuple[tuple[str, ...], bool]:
    nodes: set[str] = set()
    promoted = False
    for selection in context.selection:
        if selection.capability is not capability:
            continue
        if selection.proof is None:
            promoted = True
            continue
        proof_runner, separator, node = selection.proof.partition(":")
        if not separator or proof_runner != runner or not node:
            raise ValueError(f"invalid {runner} proof selection: {selection.proof}")
        nodes.add(node)
    return tuple(sorted(nodes)), promoted


def _frontend_related_paths(context: CapabilityContext) -> tuple[str, ...]:
    root = context.repo_root.resolve(strict=True)
    paths: set[str] = set()
    for selection in context.selection:
        if (
            selection.capability is not Capability.COMPONENT
            or selection.reason is not SelectionReason.FRONTEND_RELATED
        ):
            continue
        path = selection.path
        candidate = (root / path).resolve(strict=False)
        try:
            relative = candidate.relative_to(root).as_posix()
        except ValueError as error:
            raise ValueError(f"selected frontend path leaves the repository: {path}") from error
        if (
            relative != path
            or not path.startswith("apps/web/src/")
            or not path.endswith((".ts", ".tsx"))
            or not candidate.is_file()
        ):
            raise ValueError(f"selected frontend path is not exact: {path}")
        paths.add(f"./{Path(path).relative_to('apps/web').as_posix()}")
    return tuple(sorted(paths))


def _proven_nodes(
    context: CapabilityContext, capability: Capability, runner: str
) -> tuple[str, ...]:
    nodes: set[str] = set()
    for proof in context.proven_proofs:
        proof_runner, separator, node = proof.partition(":")
        if not separator or proof_runner != runner:
            continue
        try:
            owner, _workflow = _proof_owner(proof_runner, node)
        except ValueError:
            continue
        if owner is capability:
            nodes.add(node)
    return tuple(sorted(nodes))


def _python_proven_exclusions(
    context: CapabilityContext, capability: Capability, owner: str
) -> tuple[frozenset[str], tuple[str, ...]]:
    proven_files: set[str] = set()
    proven_tests: dict[str, set[str]] = {}
    prefix = f"python/{owner}/"
    for node in _proven_nodes(context, capability, "pytest"):
        path, separator, selected_test = node.partition("::")
        if not path.startswith(prefix) or not path.endswith(".py"):
            raise ValueError(f"proven Python proof is outside {prefix}: {node}")
        if separator:
            proven_tests.setdefault(path, set()).add(selected_test)
        else:
            proven_files.add(path)
    deselections: set[str] = set()
    for path, selected_tests in proven_tests.items():
        collected = _static_pytest_nodes(context.repo_root / path)
        if collected and collected.issubset(selected_tests):
            proven_files.add(path)
            continue
        deselections.update(
            f"{path.removeprefix('python/')}::{selected_test}" for selected_test in selected_tests
        )
    return frozenset(proven_files), tuple(sorted(deselections))


def _static_pytest_nodes(path: Path) -> frozenset[str]:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (OSError, UnicodeDecodeError, SyntaxError):
        return frozenset()
    nodes: set[str] = set()
    for statement in tree.body:
        if isinstance(
            statement, (ast.FunctionDef, ast.AsyncFunctionDef)
        ) and statement.name.startswith("test_"):
            nodes.add(statement.name)
        elif isinstance(statement, ast.ClassDef) and statement.name.startswith("Test"):
            nodes.update(
                f"{statement.name}::{method.name}"
                for method in statement.body
                if isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef))
                and method.name.startswith("test_")
            )
    return frozenset(nodes)


def _python_proof_node(node: str) -> str:
    path, separator, selected_test = node.partition("::")
    if not path.startswith("python/tests/kernel/") or not path.endswith(".py"):
        raise ValueError(f"Python kernel proof is outside its owner: {node}")
    relative = f"./{path.removeprefix('python/')}"
    return f"{relative}::{selected_test}" if separator else relative


def _web_proof_path(node: str) -> str:
    path = node.split("::", 1)[0]
    if not path.startswith("apps/web/src/") or not path.endswith(
        (".unit.test.ts", ".unit.test.tsx")
    ):
        raise ValueError(f"web kernel proof is outside its owner: {node}")
    return f"./{path.removeprefix('apps/web/')}"


def _android_test_class(repo_root: Path, node: str) -> str:
    path = node.split("::", 1)[0]
    if not path.startswith(_ANDROID_HOST_PREFIX) or not path.endswith(".kt"):
        raise ValueError(f"Android host proof is outside its owner: {node}")
    source = (repo_root / path).read_text(encoding="utf-8")
    package = re.search(r"(?m)^package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*$", source)
    class_name = Path(path).stem
    if package is None or re.search(rf"\bclass\s+{re.escape(class_name)}\b", source) is None:
        raise ValueError(f"Android host proof has no filename-owned test class: {path}")
    return f"{package.group(1)}.{class_name}"


def _android_device_test_target(repo_root: Path, node: str) -> str:
    path, separator, method = node.partition("::")
    prefix = "apps/android/app/src/androidTest/"
    if not path.startswith(prefix) or not path.endswith(".kt"):
        raise ValueError(f"Android device proof is outside its owner: {node}")
    source = (repo_root / path).read_text(encoding="utf-8")
    package = re.search(r"(?m)^package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*$", source)
    class_name = Path(path).stem
    if package is None or re.search(rf"\bclass\s+{re.escape(class_name)}\b", source) is None:
        raise ValueError(f"Android device proof has no filename-owned test class: {path}")
    if separator and (
        not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", method)
        or re.search(rf"\bfun\s+{re.escape(method)}\s*\(", source) is None
    ):
        raise ValueError(f"Android device proof has no exact method: {node}")
    target = f"{package.group(1)}.{class_name}"
    return f"{target}#{method}" if separator else target


def _android_device_target(
    android_root: Path,
    environment: Mapping[str, str],
    *,
    require_physical: bool,
) -> tuple[AuthorizedAndroidDevice | None, str]:
    """Resolve the exact serial this workflow's device proof may bind.

    `release` shares one dedicated USB handset with the signed lane, so its
    device proof must run on that physical hardware. Every other workflow
    accepts the hosted emulator it has always used, and neither accepts a
    wireless adb transport.
    """
    adb = resolve_adb(environment)
    if adb is None:
        return None, "Android adb is absent"
    if require_physical:
        return authorized_usb_physical_device(adb, environment, android_root)
    return authorized_instrumentation_device(adb, environment, android_root)


def _gradle_assertion_failed(android_root: Path, target: str) -> bool:
    class_name, separator, method = target.partition("#")
    reports = android_root / "app/build/outputs/androidTest-results"
    for report in reports.rglob("*.xml") if reports.is_dir() else ():
        try:
            root = ET.parse(report).getroot()
        except (OSError, ET.ParseError):
            continue
        for case in root.iter("testcase"):
            if case.attrib.get("classname") != class_name:
                continue
            if separator and case.attrib.get("name") != method:
                continue
            if case.find("failure") is not None:
                return True
    return False


@contextmanager
def _gradle_lock(repo_root: Path) -> Iterator[None]:
    path = repo_root / ".nexus-test/locks/gradle.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = path.open("a+b")
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        lock.close()


def _browser_installed(repo_root: Path, environment: Mapping[str, str]) -> bool:
    return _browser_installed_for_platform(
        repo_root,
        environment,
        platform_name=sys.platform,
        machine=platform.machine(),
    )


def _browser_installed_for_platform(
    repo_root: Path,
    environment: Mapping[str, str],
    *,
    platform_name: str,
    machine: str,
) -> bool:
    revisions = dict(_browser_revisions(repo_root))
    if set(revisions) != {"chromium", "chromium-headless-shell"}:
        return False
    executables = _browser_executable_names(platform_name, machine)
    if executables is None:
        return False
    cache = _browser_cache_directory(environment, platform_name)
    if cache is None:
        return False
    chromium = cache / f"chromium-{revisions['chromium']}"
    headless = cache / f"chromium_headless_shell-{revisions['chromium-headless-shell']}"
    return all(
        owner.is_dir()
        and (owner / "INSTALLATION_COMPLETE").is_file()
        and any(path.is_file() and os.access(path, os.X_OK) for path in owner.rglob(executable))
        for owner, executable in zip((chromium, headless), executables, strict=True)
    )


def _browser_cache_directory(environment: Mapping[str, str], platform_name: str) -> Path | None:
    browser_root = environment.get("PLAYWRIGHT_BROWSERS_PATH")
    if browser_root:
        return Path(browser_root)
    home = environment.get("HOME")
    if platform_name == "linux":
        cache_home = environment.get("XDG_CACHE_HOME")
        if cache_home:
            return Path(cache_home) / "ms-playwright"
        return Path(home) / ".cache/ms-playwright" if home else None
    if platform_name == "darwin":
        return Path(home) / "Library/Caches/ms-playwright" if home else None
    return None


def _browser_executable_names(platform_name: str, machine: str) -> tuple[str, str] | None:
    architecture = machine.lower()
    if platform_name == "linux":
        if architecture in {"x86_64", "amd64"}:
            return "chrome", "chrome-headless-shell"
        if architecture in {"aarch64", "arm64"}:
            return "chrome", "headless_shell"
        return None
    if platform_name == "darwin" and architecture in {"x86_64", "amd64", "arm64", "aarch64"}:
        return "Google Chrome for Testing", "chrome-headless-shell"
    return None


def _browser_revisions(repo_root: Path) -> tuple[tuple[str, str], ...]:
    browsers_json = repo_root / "apps/web/node_modules/playwright-core/browsers.json"
    try:
        data = json.loads(browsers_json.read_text(encoding="utf-8"))
        revisions = tuple(
            sorted(
                (browser["name"], browser["revision"])
                for browser in data["browsers"]
                if browser["name"] in {"chromium", "chromium-headless-shell"}
                and isinstance(browser["name"], str)
                and isinstance(browser["revision"], str)
            )
        )
    except (KeyError, OSError, TypeError, json.JSONDecodeError):
        return ()
    return revisions


def _browser_command(argv: tuple[str, ...]) -> bool:
    return any(part in {"playwright", "test:browser"} for part in argv) or (
        "vitest" in argv and "browser" in argv
    )


def _run_fixed_commands(
    capability: Capability,
    commands: tuple[FixedCommand, ...],
    environment: Mapping[str, str],
    required_tools: tuple[str, ...],
    *,
    context: CapabilityContext | None,
    elapsed_ms: int = 0,
    pythonpath: Path | None = None,
) -> CapabilityResult:
    result, _successful = _run_fixed_commands_observed(
        capability,
        commands,
        environment,
        required_tools,
        context=context,
        elapsed_ms=elapsed_ms,
        pythonpath=pythonpath,
    )
    return result


def _run_fixed_commands_observed(
    capability: Capability,
    commands: tuple[FixedCommand, ...],
    environment: Mapping[str, str],
    required_tools: tuple[str, ...],
    *,
    context: CapabilityContext | None,
    elapsed_ms: int = 0,
    pythonpath: Path | None = None,
    retained_stdout_markers: tuple[str, ...] = (),
) -> tuple[CapabilityResult, _SuccessfulFixedCommand | None]:
    child_environment = _child_environment(environment)
    if pythonpath is not None:
        child_environment["PYTHONPATH"] = str(pythonpath)
    missing = tuple(
        tool
        for tool in required_tools
        if shutil.which(tool, path=child_environment.get("PATH")) is None
    )
    if missing:
        return _not_run(capability, f"required tools are absent: {', '.join(missing)}"), None
    started = time.monotonic_ns()
    successful: _SuccessfulFixedCommand | None = None
    for index, (argv, cwd) in enumerate(commands, start=1):
        argv = _fail_fast_command(argv)
        if context is not None and context.run_context is not None:
            context.run_context.record_command(
                context,
                capability,
                argv,
                cwd,
                child_environment,
            )
        try:
            completed = run_command(
                argv,
                cwd=cwd,
                env=child_environment,
                capture_output=True,
                check=False,
                retain_stdout_markers=retained_stdout_markers,
            )
        except OSError as error:
            duration_ms = elapsed_ms + (time.monotonic_ns() - started) // 1_000_000
            return (
                _result(
                    capability,
                    RunStatus.NOT_RUN,
                    duration_ms,
                    f"fixed command {index} could not start: {error.strerror or error}",
                ),
                None,
            )
        if completed.returncode != 0:
            duration_ms = elapsed_ms + (time.monotonic_ns() - started) // 1_000_000
            artifacts = _failure_artifacts(
                capability,
                index,
                argv,
                completed,
                environment,
            )
            interrupted_by = _command_interruption_signal(completed.returncode)
            return (
                _result(
                    capability,
                    RunStatus.NOT_RUN if interrupted_by is not None else RunStatus.FAIL,
                    duration_ms,
                    _command_result_detail(index, completed, interrupted_by),
                    artifacts=artifacts,
                ),
                None,
            )
        successful = _SuccessfulFixedCommand(argv, cwd, completed)
    duration_ms = elapsed_ms + (time.monotonic_ns() - started) // 1_000_000
    return (
        _result(
            capability,
            RunStatus.PASS,
            duration_ms,
            f"{len(commands)} fixed command{'s' if len(commands) != 1 else ''} passed",
        ),
        successful,
    )


def _fail_fast_command(argv: tuple[str, ...]) -> tuple[str, ...]:
    """Apply controller gate policy without changing direct-runner configs."""
    if "pytest" in argv:
        if "--maxfail=1" in argv:
            return argv
        index = argv.index("pytest") + 1
        return (*argv[:index], "--maxfail=1", *argv[index:])
    if "vitest" in argv:
        if "--bail=1" in argv:
            return argv
        index = argv.index("vitest") + 1
        return (*argv[:index], "--bail=1", *argv[index:])
    if len(argv) >= 3 and argv[:3] in {
        ("bun", "run", "test:unit"),
        ("bun", "run", "test:browser"),
    }:
        if "--bail=1" in argv:
            return argv
        if "--" not in argv[3:]:
            return (*argv, "--", "--bail=1")
        separator = argv.index("--") + 1
        return (*argv[:separator], "--bail=1", *argv[separator:])
    if "playwright" in argv and "test" in argv[argv.index("playwright") + 1 :]:
        if "--max-failures=1" in argv:
            return argv
        index = argv.index("test", argv.index("playwright") + 1) + 1
        return (*argv[:index], "--max-failures=1", *argv[index:])
    return argv


def _redacted_command_argv(
    argv: tuple[str, ...],
    secrets: Iterable[str],
) -> tuple[str, ...]:
    redacted: list[str] = []
    redact_next = False
    for part in argv:
        if redact_next:
            redacted.append("[REDACTED]")
            redact_next = False
            continue
        key, separator, value = part.partition("=")
        normalized_key = re.sub(r"[^a-z]", "", key.casefold())
        sensitive_flag = any(token in normalized_key for token in _SENSITIVE_ENV_PARTS)
        if separator and sensitive_flag:
            redacted.append(f"{key}=[REDACTED]")
            continue
        safe_part = redact_text(part, secrets)
        redacted.append(safe_part)
        if sensitive_flag and part.startswith("-"):
            redact_next = True
    return tuple(redacted)


def _command_interruption_signal(returncode: int) -> signal.Signals | None:
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGKILL):
        if returncode in {-signum, 128 + signum, 256 - signum}:
            return signal.Signals(signum)
    return None


def _command_result_detail(
    index: int,
    completed: subprocess.CompletedProcess[str],
    interrupted_by: signal.Signals | None = None,
) -> str:
    stdout = _decisive_output(completed.stdout or "")
    stderr = _decisive_output(completed.stderr or "")
    parts = []
    if stdout:
        parts.append(f"stdout={stdout}")
    if stderr:
        parts.append(f"stderr={stderr}")
    decisive = " | ".join(parts) if parts else "no diagnostic output"
    if interrupted_by is not None:
        return (
            f"fixed command {index} interrupted by {interrupted_by.name} "
            f"(exit {completed.returncode}): {decisive}"
        )
    return f"fixed command {index} exited {completed.returncode}: {decisive}"


def _decisive_output(value: str, limit: int = 1900) -> str:
    stripped = _ANSI_ESCAPE_RE.sub("", value).strip()
    if len(stripped) <= limit:
        return stripped
    node_tap_assertion = _first_node_tap_assertion_block(stripped, limit)
    if node_tap_assertion is not None:
        return node_tap_assertion
    lines = stripped.splitlines()
    decisive_lines: set[int] = set()
    for index, line in enumerate(lines):
        if re.search(
            r"(?:^|\s)(?:E\s+(?:assert|AssertionError|Failed:)|FAILED\s|"
            r"AssertionError:|Error:\s*expect\(|expect\((?:locator|received)\)\.to[A-Za-z]+\(|"
            r"Tests\s+\d+\s+failed|falsifying example:)",
            line,
            re.IGNORECASE,
        ):
            decisive_lines.add(index)
            if re.search(r"expect\((?:locator|received)\)\.", line, re.IGNORECASE):
                decisive_lines.update(range(max(0, index - 4), index))
    decisive = "\n".join(lines[index] for index in sorted(decisive_lines))
    return (decisive or stripped)[-limit:]


def _first_node_tap_assertion_block(value: str, limit: int) -> str | None:
    lines = value.splitlines()
    for start, line in enumerate(lines):
        if re.match(r"^\s*not ok \d+\s+-", line, re.IGNORECASE) is None:
            continue
        end = next(
            (
                index
                for index in range(start + 1, len(lines))
                if re.match(r"^\s*(?:not )?ok \d+\s+-", lines[index], re.IGNORECASE) is not None
                or re.match(r"^\s*1\.\.\d+\s*$", lines[index]) is not None
            ),
            len(lines),
        )
        block = lines[start:end]
        if not _is_node_tap_assertion("\n".join(block).casefold()):
            continue
        selected = [block[0][:384], "  ---"]
        error_body = False
        error_body_budget = min(1_024, limit // 2)
        for candidate in block[1:]:
            field = re.match(r"^\s{2}([A-Za-z][A-Za-z0-9_]*):", candidate)
            if field is not None:
                key = field.group(1).casefold()
                error_body = key == "error" and candidate.rstrip().endswith(("|-", ">-"))
                if key in {
                    "failuretype",
                    "error",
                    "code",
                    "name",
                    "expected",
                    "actual",
                    "operator",
                }:
                    selected.append(candidate[:384])
                continue
            if error_body and candidate.startswith("    ") and error_body_budget > 0:
                excerpt = candidate[:error_body_budget]
                selected.append(excerpt)
                error_body_budget -= len(excerpt) + 1
        selected.append("  ...")
        return "\n".join(selected)[:limit]
    return None


def _failed_command_detail(index: int, completed: subprocess.CompletedProcess[str]) -> str:
    return _command_result_detail(index, completed)


def _child_environment(environment: Mapping[str, str]) -> dict[str, str]:
    child = {
        key: value
        for key in _SAFE_CHILD_ENV
        if (value := environment.get(key)) is not None and value != ""
    }
    child["NEXUS_ENV"] = "test"
    return child


def _pass(capability: Capability, detail: str) -> CapabilityResult:
    return _result(capability, RunStatus.PASS, 0, detail)


def _fail(capability: Capability, detail: str) -> CapabilityResult:
    return _result(capability, RunStatus.FAIL, 0, detail)


def _not_run(capability: Capability, detail: str) -> CapabilityResult:
    return _result(capability, RunStatus.NOT_RUN, 0, detail)


def _result(
    capability: Capability,
    status: RunStatus,
    duration_ms: int,
    detail: str,
    *,
    artifacts: tuple[str, ...] = (),
) -> CapabilityResult:
    return CapabilityResult(
        CapabilityEvidence(capability, status, duration_ms, 0, artifacts=artifacts),
        detail,
    )


def _android_device_success_artifact(
    context: CapabilityContext,
    device: AuthorizedAndroidDevice,
    successful: _SuccessfulFixedCommand,
    environment: Mapping[str, str],
) -> tuple[str | None, str]:
    raw_directory = environment.get("NEXUS_TEST_RESULTS_DIR")
    run_id = environment.get("NEXUS_TEST_EVIDENCE_RUN_ID")
    if raw_directory is None or run_id is None or re.fullmatch(r"[0-9a-f]{16}", run_id) is None:
        return None, "successful Android instrumentation has no controller evidence directory"
    directory = Path(raw_directory)
    if not directory.is_absolute() or directory.name != run_id or not directory.is_dir():
        return None, "successful Android instrumentation has an invalid evidence directory"
    try:
        expected_directory = context.repo_root.absolute() / "test-results" / "runs" / run_id
        resolved_expected_directory = (
            context.repo_root.resolve(strict=True) / "test-results" / "runs" / run_id
        )
        if (
            directory.absolute() != expected_directory
            or directory.resolve(strict=True) != resolved_expected_directory
        ):
            return None, "successful Android instrumentation has an invalid evidence directory"
    except OSError:
        return None, "successful Android instrumentation has an invalid evidence directory"
    try:
        cwd = successful.cwd.resolve(strict=True).relative_to(
            context.repo_root.resolve(strict=True)
        )
    except (OSError, ValueError):
        return None, "successful Android instrumentation command left the repository"
    secrets = environment_secrets(environment)
    if context.candidate_sha is None:
        return None, "successful Android instrumentation has no exact candidate SHA"
    payload: dict[str, JsonValue] = {
        "version": 2,
        "capability": Capability.ANDROID_DEVICE.value,
        "candidate_sha": context.candidate_sha,
        "scope": "exact" if context.proof_id is not None else "complete",
        "authorized_adb_row": device.adb_devices_row,
        "bound_serial": device.serial,
        "proof_id": _android_device_artifact_proof_id(context),
        "command": {
            "argv": list(_redacted_command_argv(successful.argv, secrets)),
            "cwd": cwd.as_posix(),
        },
        "exit_code": successful.completed.returncode,
        "stdout": _bounded_android_device_output(successful.completed.stdout or "", secrets),
        "stderr": _bounded_android_device_output(successful.completed.stderr or "", secrets),
    }
    encoded = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if len(encoded.encode("utf-8")) > _ANDROID_DEVICE_ARTIFACT_MAX_BYTES:
        return None, "successful Android instrumentation evidence exceeded its artifact bound"
    relative = Path("test-results/runs") / run_id / _ANDROID_DEVICE_EVIDENCE_NAME
    artifact = directory / _ANDROID_DEVICE_EVIDENCE_NAME
    try:
        write_evidence_json(artifact, payload)
    except ValueError:
        return None, "successful Android instrumentation evidence could not be retained"
    return relative.as_posix(), ""


def _bounded_android_device_output(value: str, secrets: Iterable[str]) -> str:
    redacted = redact_text(value, secrets)
    if len(redacted) <= _ANDROID_DEVICE_OUTPUT_LIMIT:
        return redacted
    prefix = f"[truncated to final {_ANDROID_DEVICE_OUTPUT_LIMIT} characters]\n"
    return prefix + redacted[-(_ANDROID_DEVICE_OUTPUT_LIMIT - len(prefix)) :]


def _failure_artifacts(
    capability: Capability,
    index: int,
    argv: tuple[str, ...],
    completed: subprocess.CompletedProcess[str],
    environment: Mapping[str, str],
) -> tuple[str, ...]:
    raw_directory = environment.get("NEXUS_TEST_RESULTS_DIR")
    run_id = environment.get("NEXUS_TEST_EVIDENCE_RUN_ID")
    if raw_directory is None or run_id is None or re.fullmatch(r"[0-9a-f]{16}", run_id) is None:
        return ()
    directory = Path(raw_directory)
    if not directory.is_absolute() or directory.name != run_id:
        return ()
    relative = Path("test-results/runs") / run_id / f"{capability.value}-{index}.log"
    log = directory / relative.name
    log.parent.mkdir(parents=True, exist_ok=True)
    stdout = _bounded_diagnostic(completed.stdout or "")
    stderr = _bounded_diagnostic(completed.stderr or "")
    log.write_text(
        redact_text(
            "command="
            + json.dumps(_redacted_command_argv(argv, environment_secrets(environment)))
            + f"\nexit={completed.returncode}\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}\n",
            environment_secrets(environment),
        ),
        encoding="utf-8",
    )
    artifacts = [relative.as_posix()]
    if capability in {
        Capability.JOURNEYS_CRITICAL,
        Capability.JOURNEYS_ALL,
        Capability.EXTENSION,
    }:
        artifacts.append((Path("test-results/runs") / run_id / "playwright").as_posix())
    return tuple(artifacts)


def _bounded_diagnostic(value: str, limit: int = 1_000_000) -> str:
    if len(value) <= limit:
        return value
    return f"[truncated to final {limit} characters]\n{value[-limit:]}"


def environment_secrets(environment: Mapping[str, str]) -> tuple[str, ...]:
    return tuple(
        value
        for key, value in environment.items()
        if value and any(part in key.casefold() for part in _SENSITIVE_ENV_PARTS)
    )
