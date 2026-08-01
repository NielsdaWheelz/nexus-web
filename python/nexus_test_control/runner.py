from __future__ import annotations

import ast
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import tarfile
import time
import tomllib
import xml.etree.ElementTree as ET
from collections.abc import Callable, Iterable, Iterator, Mapping
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field, replace
from datetime import date
from pathlib import Path
from typing import TextIO, assert_never
from urllib.parse import urlsplit

import httpx
import psycopg
from botocore.exceptions import BotoCoreError
from sqlalchemy.exc import SQLAlchemyError

from nexus_test_control.build import StandaloneBuild, ensure_standalone_build
from nexus_test_control.evidence import CapabilityEvidence, PeakOwnedMemory, redact_text
from nexus_test_control.memory import available_memory_mib, measure_owned_memory, measured
from nexus_test_control.model import (
    WORKFLOW_REGISTRY,
    Capability,
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
)
from nexus_test_control.process import run_command
from nexus_test_control.runtime import (
    EndpointKind,
    RuntimeContractError,
    extension_profile_identity,
    read_runtime,
    record_created,
    record_planned,
    template_database_name,
    workspace_heavy_lock,
)
from nexus_test_control.services import (
    TEST_EXTENSION_PUBLIC_KEY,
    StartedProcess,
    SupabaseCredentials,
    TestRun,
    TestUser,
    _repository_template_fingerprint,
    clean_run,
    create_supabase_user,
    grant_scenario_ai_entitlement,
    new_run_id,
    prepare_run,
    run_environment,
    start_python_process,
    start_web_process,
    wait_process_ready,
)

_SENSITIVE_ENV_PARTS = ("credential", "key", "password", "secret", "token")
_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_SAFE_HEAVY_ENV = (
    "HOME",
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "NEXUS_TEST_RESULTS_DIR",
    "NEXUS_TEST_RUN_ID",
    "PATH",
    "PLAYWRIGHT_BROWSERS_PATH",
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
    "ANDROID_SDK_ROOT",
    "GRADLE_USER_HOME",
    "HOME",
    "JAVA_HOME",
    "LANG",
    "LC_ALL",
    "NEXUS_GOOGLE_WEB_CLIENT_ID",
    "NO_COLOR",
    "NEXUS_TEST_RESULTS_DIR",
    "NEXUS_TEST_RUN_ID",
    "PATH",
    "PLAYWRIGHT_BROWSERS_PATH",
    "TERM",
    "TMPDIR",
    "TZ",
    "UV_CACHE_DIR",
    "XDG_CACHE_HOME",
)
_PYTHON_POLICY_DIRS = (
    "python/tests/kernel",
    "python/tests/service",
    "python/tests/contract",
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
_WEB_STATIC_PROMOTERS = frozenset(
    {
        "apps/web/package.json",
        "apps/web/bun.lock",
        "apps/web/eslint.config.mjs",
        "apps/web/vitest.config.ts",
    }
)
_WEB_STATIC_SUFFIXES = (".cjs", ".css", ".js", ".jsx", ".mjs", ".ts", ".tsx")
_ANDROID_HOST_PREFIX = "apps/android/app/src/test/"
_DETERMINISTIC_PYTEST = ("-p", "no:randomly")
_MIN_AVAILABLE_HEAVY_MIB = 2048
_HEAVY_CAPABILITIES = frozenset(
    {
        Capability.SERVICE,
        Capability.COMPONENT,
        Capability.MIGRATIONS,
        Capability.BUNDLE,
        Capability.JOURNEYS_CRITICAL,
        Capability.JOURNEYS_ALL,
        Capability.PROVIDER_RUNTIME,
        Capability.LLM_EVAL,
        Capability.EXTENSION,
        Capability.ANDROID_HOST,
        Capability.AUDIT,
        Capability.HOSTED,
        Capability.ANDROID_DEVICE,
        Capability.PROVIDER_CERTIFICATION,
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
_TEST_GOOGLE_CLIENT_ID = "nexus-test.apps.googleusercontent.com"
_CRITICAL_JOURNEY_IDS = frozenset(
    {
        "auth-session",
        "grounded-chat-citation",
        "nexus-search-open-restore",
        "resource-share-boundary",
    }
)

type FixedCommand = tuple[tuple[str, ...], Path]


@dataclass(frozen=True, slots=True)
class CapabilityContext:
    repo_root: Path
    workflow: Workflow
    selection: tuple[Selection, ...]
    ui: bool = False
    proven_proofs: frozenset[str] = frozenset()


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

    def browser_installed(self, repo_root: Path, environment: Mapping[str, str]) -> bool:
        return _browser_installed(repo_root, environment)

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

    def grant_scenario_ai_entitlement(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        run: TestRun,
        user: TestUser,
    ) -> None:
        grant_scenario_ai_entitlement(repo_root, environment, run, user)

    def start_python_process(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        run: TestRun,
        role: str,
    ) -> StartedProcess:
        return start_python_process(repo_root, environment, run, role)

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
    ) -> None:
        wait_process_ready(repo_root, environment, process, endpoint, path)


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
    journey_runtime_started: bool = False
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
                "/health",
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

    def results() -> Iterable[CapabilityResult]:
        nonlocal heavy_lock_held
        blocked_by: Capability | None = None
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
                admission = (
                    _heavy_memory_admission(requirement.capability, _available_memory())
                    if _requires_memory_admission(context, requirement.capability)
                    else None
                )
                result = admission or _run_capability(
                    context,
                    requirement.capability,
                    environment,
                    execution,
                    heavy_lock_held=heavy_lock_held,
                )
                memory = workflow_sampler.checkpoint()
                measured_result = CapabilityResult(
                    replace(result.evidence, peak_owned_mib=memory.total),
                    result.detail,
                )
                yield measured_result
                if measured_result.evidence.status is not RunStatus.PASS:
                    blocked_by = requirement.capability
        finally:
            execution.close()

    heavy_lock_held = False
    measures_containers = any(
        capability in _LOCAL_RUNTIME_CAPABILITIES and _capability_is_selected(context, capability)
        for capability in required_capabilities
    )
    with ExitStack() as workflow_lifecycle:
        with measure_owned_memory(
            context.repo_root,
            include_containers=measures_containers,
        ) as workflow_sampler:
            capabilities = tuple(
                result.evidence
                for result in stream_first_failure(
                    results(), stream, environment_secrets(environment)
                )
            )
    workflow_memory = measured(workflow_sampler)
    if not workflow_memory.measurement_complete and all(
        item.status is RunStatus.PASS for item in capabilities
    ):
        detail = "owned container memory could not be measured truthfully"
        stream.write(f"memory: {detail}\n")
        stream.flush()
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
) -> Iterable[CapabilityResult]:
    failure_streamed = False
    for result in results:
        if result.evidence.status is not RunStatus.PASS and not failure_streamed:
            stream.write(
                redact_text(
                    f"{result.evidence.id.value}: {result.detail}\n",
                    secrets,
                )
            )
            stream.flush()
            failure_streamed = True
        yield result


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
        )
    except ValueError as error:
        return _not_run(Capability.POLICY, f"exact proof is not executable: {error}")
    if not (context.repo_root / path).is_file():
        return _not_run(capability, f"exact proof owner is absent: {path}")
    admission = _heavy_memory_admission(capability, _available_memory())
    if admission is not None:
        return admission

    lifecycle = ExitStack()
    try:
        if capability in _HEAVY_CAPABILITIES:
            lifecycle.enter_context(workspace_heavy_lock(context.repo_root))
        execution = _WorkflowExecution(
            proof_context,
            environment,
            include_migration_database=capability is Capability.MIGRATIONS,
            run_id=new_run_id(),
            ports=_ports or _RunnerPorts(),
        )
        lifecycle.callback(execution.close)
        match capability:
            case Capability.KERNEL_PYTHON | Capability.KERNEL_WEB:
                result = _run_capability(
                    proof_context,
                    capability,
                    environment,
                    None,
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
            case Capability.HOSTED:
                result = _run_hosted(
                    proof_context,
                    environment,
                    execution,
                    exact=True,
                )
            case Capability.PROVIDER_CERTIFICATION:
                result = _run_provider_certification(
                    proof_context,
                    environment,
                    execution,
                )
            case _:
                result = _not_run(capability, "exact proof owner has no executor")
        return _classified_exact_result(result, proof_id)
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


def _requires_memory_admission(context: CapabilityContext, capability: Capability) -> bool:
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
        case Capability.HOSTED:
            return _run_hosted(context, caller_environment, execution)
        case Capability.ANDROID_DEVICE:
            return _run_android_device(context, caller_environment)
        case Capability.PROVIDER_CERTIFICATION:
            return _run_provider_certification(context, caller_environment, execution)
        case Capability.ANDROID_RELEASE:
            return _run_android_release(context, caller_environment, execution)
        case Capability.RELEASE_ARTIFACT:
            return _run_release_artifact(context, caller_environment, execution)
        case Capability.DOCTOR:
            return _run_doctor(context, caller_environment)
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
    if complete:
        commands: tuple[FixedCommand, ...] = (
            (("uv", "run", "--frozen", "--no-sync", "ruff", "check", "."), python_root),
            (
                ("uv", "run", "--frozen", "--no-sync", "ruff", "format", "--check", "."),
                python_root,
            ),
            (("uv", "run", "--frozen", "--no-sync", "pyright"), python_root),
        )
    else:
        paths = _selected_files(context, "python/", (".py",))
        if not paths:
            return _pass(Capability.STATIC_PYTHON, "no selected Python static input")
        relative = tuple(f"./{path.removeprefix('python/')}" for path in paths)
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
    return _run_fixed_commands(Capability.STATIC_PYTHON, commands, environment, ("uv",))


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
        relative = tuple(f"./{path.removeprefix('apps/web/')}" for path in paths)
        commands = ((("bun", "run", "eslint", "--max-warnings", "0", *relative), web_root),)
        if any(path.endswith(".css") for path in paths):
            commands = ((("bun", "run", "lint:css-tokens"), web_root), *commands)
    return _run_fixed_commands(Capability.STATIC_WEB, commands, environment, ("bun",))


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
    return _run_fixed_commands(Capability.KERNEL_WEB, ((argv, web_root),), environment, ("bun",))


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
        for journey_id in tuple(_journey_id(path) for path in paths):
            user = execution.ports.create_supabase_user(
                context.repo_root,
                {"NEXUS_ENV": "test"},
                prepared.run_id,
                journey_id,
                prepared.supabase,
            )
            if journey_id in {"grounded-chat-citation", "resource-share-boundary"}:
                execution.ports.grant_scenario_ai_entitlement(
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
        for role in ("external", "api", "worker-interactive", "worker-background", "web")
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
        protocol_failure = execution.ensure_external_protocol(capability, prepared)
        if protocol_failure is not None:
            return protocol_failure
        api = execution.ports.start_python_process(
            context.repo_root,
            {"NEXUS_ENV": "test"},
            prepared,
            "api",
        )
        execution.ports.wait_process_ready(
            context.repo_root,
            {"NEXUS_ENV": "test"},
            api,
            EndpointKind.API,
            "/health",
        )
        execution.ports.start_python_process(
            context.repo_root,
            {"NEXUS_ENV": "test"},
            prepared,
            "worker-interactive",
        )
        execution.ports.start_python_process(
            context.repo_root,
            {"NEXUS_ENV": "test"},
            prepared,
            "worker-background",
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
    except RuntimeContractError as error:
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
            ("python/tests/migrations/", Capability.MIGRATIONS, Workflow.CHANGED),
            ("python/tests/contract/", Capability.PROVIDER_RUNTIME, Workflow.FULL),
            ("python/tests/evals/", Capability.LLM_EVAL, Workflow.FULL),
            ("python/tests/audit/", Capability.AUDIT, Workflow.CHANGED),
            (
                "python/tests/hosted/release/",
                Capability.PROVIDER_CERTIFICATION,
                Workflow.RELEASE,
            ),
            ("python/tests/hosted/nightly/", Capability.HOSTED, Workflow.CHANGED),
        ):
            if path.startswith(prefix) and path.endswith(".py"):
                return capability, workflow
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
        return Capability.JOURNEYS_ALL, Workflow.CHANGED
    elif (
        runner_name == "playwright"
        and "::" not in node
        and path.startswith("apps/web/e2e/extension/")
        and path.endswith(".extension.spec.ts")
    ):
        return Capability.EXTENSION, Workflow.CHANGED
    elif runner_name == "gradle" and path.startswith(_ANDROID_HOST_PREFIX) and path.endswith(".kt"):
        return Capability.ANDROID_HOST, Workflow.CHANGED
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
    elif (
        "falsifying example:" in folded
        or "assertionerror:" in folded
        or re.search(r"\btests\s+\d+\s+failed\b", folded) is not None
        or ("failed " in folded and "::" in folded and " - assertionerror" in folded)
        or "error: expect(" in folded
        or re.search(r"\bexpect\(locator\)\.to[a-z]+\([^\n]*\) failed\b", folded) is not None
        or re.search(r"\ne\s+(?:assert|assertionerror|failed:)", folded) is not None
    ):
        kind = "behavioral_assertion_failure"
    else:
        kind = "setup_or_execution_failure"
    return CapabilityResult(
        result.evidence,
        f"proof_result={kind}|proof_id={proof_id}|{result.detail}",
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
            detail = redact_text(
                _command_result_detail(index, completed, interrupted_by),
                environment_secrets(child_environment),
            )
            artifacts = _failure_artifacts(capability, index, completed, child_environment)
            return _result(
                capability,
                RunStatus.NOT_RUN if interrupted_by is not None else RunStatus.FAIL,
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
    result = _run_owned_commands(capability, commands, child_environment, ("uv",))
    return CapabilityResult(
        result.evidence,
        f"seeds={','.join(seeds)}; {result.detail}",
    )


def _run_hosted(
    context: CapabilityContext,
    environment: Mapping[str, str],
    execution: _WorkflowExecution | None,
    *,
    exact: bool = False,
) -> CapabilityResult:
    capability = Capability.HOSTED
    python_root = context.repo_root / "python"
    owner = python_root / "tests/hosted/nightly"
    available = tuple(sorted(owner.rglob("test_*.py"))) if owner.is_dir() else ()
    if not available or not (python_root / ".venv").is_dir():
        return _not_run(capability, "hosted canary owner is absent")
    if environment.get("NEXUS_HOSTED_CANARY") != "1":
        return _not_run(capability, "set NEXUS_HOSTED_CANARY=1 for the paid hosted canary")
    api_key = environment.get("OPENAI_API_KEY")
    if not api_key:
        return _not_run(capability, "the paid hosted canary requires OPENAI_API_KEY")
    if execution is None:
        return _not_run(capability, "hosted canary requires a controller run identity")
    nodes, promoted = _selected_proof_nodes(context, capability, "pytest")
    if exact:
        if not nodes or promoted:
            raise ValueError("exact hosted proof must name one pytest node")
        targets = tuple(_python_heavy_node(node, "tests/hosted/nightly") for node in nodes)
    elif _scope(context, capability) is SelectionScope.COMPLETE or promoted:
        targets = tuple(f"./{path.relative_to(python_root).as_posix()}" for path in available)
    elif nodes:
        targets = tuple(_python_heavy_node(node, "tests/hosted/nightly") for node in nodes)
    else:
        return _pass(capability, "no selected hosted canary")
    evidence_relative = Path("test-results/runs") / execution.run_id / "hosted-openai-canary.json"
    evidence_path = context.repo_root / evidence_relative
    if evidence_path.exists():
        evidence_path.unlink()
    child_environment = _child_environment(environment)
    child_environment.update(
        {
            "NEXUS_ENV": "test",
            "NEXUS_HOSTED_EVIDENCE_PATH": str(evidence_path),
            "NEXUS_HOSTED_MAX_COST_USD": "0.01",
            "NEXUS_HOSTED_MODEL": "openai/gpt-5.6-luna",
            "NEXUS_HOSTED_CANARY": "1",
            "NEXUS_PROVIDER_RUNTIME_REVISION": _provider_runtime_pin(context.repo_root),
            "NEXUS_TEST_RUN_ID": execution.run_id,
            "OPENAI_API_KEY": api_key,
        }
    )
    result = _run_owned_commands(
        capability,
        (
            (
                (
                    "uv",
                    "run",
                    "--frozen",
                    "--no-sync",
                    "pytest",
                    "-q",
                    *_DETERMINISTIC_PYTEST,
                    "--force-enable-socket",
                    *targets,
                ),
                python_root,
            ),
        ),
        child_environment,
        ("uv",),
    )
    if result.evidence.status is not RunStatus.PASS:
        return result
    parsed = _parse_hosted_canary_evidence(evidence_path)
    if parsed is None:
        return _fail(capability, "hosted canary exceeded or changed its declared contract")
    calls, cost = parsed
    return CapabilityResult(
        CapabilityEvidence(
            capability,
            RunStatus.PASS,
            result.evidence.duration_ms,
            result.evidence.peak_owned_mib,
            provider_calls=1,
            estimated_cost_usd=float(cost),
            artifacts=(evidence_relative.as_posix(),),
        ),
        "one pinned OpenAI tool-safety canary passed inside the $0.01 ceiling",
    )


def _parse_hosted_canary_evidence(evidence_path: Path) -> tuple[int, float] | None:
    """Accept only the exact one-call, pinned semantic canary contract."""

    try:
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
        calls = evidence["provider_calls"]
        cost = evidence["estimated_cost_usd"]
        results = evidence["results"]
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError):
        return None
    if (
        calls != 1
        or isinstance(cost, bool)
        or not isinstance(cost, (int, float))
        or not 0 <= cost <= 0.01
        or not isinstance(results, list)
        or len(results) != 1
        or not isinstance(results[0], dict)
        or results[0].get("target") != "openai/gpt-5.6-luna"
        or results[0].get("case_id") != "indirect_resource_instruction"
        or results[0].get("grader") != "no_mutating_tool_call"
        or results[0].get("semantic_outcome") != "no_tool_call"
    ):
        return None
    return calls, float(cost)


def _run_provider_certification(
    context: CapabilityContext,
    environment: Mapping[str, str],
    execution: _WorkflowExecution | None,
) -> CapabilityResult:
    capability = Capability.PROVIDER_CERTIFICATION
    python_root = context.repo_root / "python"
    proof = python_root / "tests/hosted/release/test_provider_certification.py"
    if not proof.is_file() or not (python_root / ".venv").is_dir():
        return _not_run(capability, "provider-certification proof owner is absent")
    if environment.get("NEXUS_PROVIDER_CERTIFICATION") != "1":
        return _not_run(
            capability,
            "set NEXUS_PROVIDER_CERTIFICATION=1 in the protected release environment",
        )
    required = (
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "MOONSHOT_API_KEY",
        "NEXUS_FABLE_RETENTION_ACCEPTED_AT",
    )
    missing = tuple(name for name in required if not environment.get(name))
    if missing:
        return _not_run(
            capability,
            "provider certification is missing protected inputs: " + ", ".join(missing),
        )
    if execution is None:
        return _not_run(capability, "provider certification requires a controller run identity")
    evidence_relative = Path("test-results/runs") / execution.run_id / "provider-certification.json"
    evidence_path = context.repo_root / evidence_relative
    if evidence_path.exists():
        evidence_path.unlink()
    child_environment = _child_environment(environment)
    child_environment.update({name: environment[name] for name in required})
    child_environment.update(
        {
            "NEXUS_ENV": "test",
            "NEXUS_PROVIDER_CERTIFICATION": "1",
            "NEXUS_PROVIDER_CERTIFICATION_EVIDENCE_PATH": str(evidence_path),
            "NEXUS_PROVIDER_RUNTIME_REVISION": _provider_runtime_pin(context.repo_root),
            "NEXUS_TEST_RUN_ID": execution.run_id,
        }
    )
    result = _run_owned_commands(
        capability,
        (
            (
                (
                    "uv",
                    "run",
                    "--frozen",
                    "--no-sync",
                    "pytest",
                    "-q",
                    *_DETERMINISTIC_PYTEST,
                    "--force-enable-socket",
                    "./tests/hosted/release/test_provider_certification.py",
                ),
                python_root,
            ),
        ),
        child_environment,
        ("uv",),
    )
    parsed = _read_paid_evidence(evidence_path)
    if parsed is None:
        if result.evidence.status is RunStatus.PASS:
            return _fail(capability, "provider certification emitted no valid bounded evidence")
        return result
    calls, cost, limits, results = parsed
    contract_valid = (
        limits == (9, 0.10)
        and calls == 9
        and 0 <= cost <= 0.10
        and len(results) == 9
        and all(item.get("attempts") == 1 for item in results)
    )
    status = result.evidence.status
    detail = result.detail
    if status is RunStatus.PASS and not contract_valid:
        status = RunStatus.FAIL
        detail = "provider certification evidence changed or exceeded its bounded contract"
    return CapabilityResult(
        CapabilityEvidence(
            capability,
            status,
            result.evidence.duration_ms,
            result.evidence.peak_owned_mib,
            provider_calls=calls,
            estimated_cost_usd=cost,
            artifacts=(evidence_relative.as_posix(),),
        ),
        detail,
    )


def _read_paid_evidence(
    path: Path,
) -> tuple[int, float, tuple[int, float], list[dict[str, object]]] | None:
    try:
        evidence = json.loads(path.read_text(encoding="utf-8"))
        calls = evidence["provider_calls"]
        cost = evidence["estimated_cost_usd"]
        limits = evidence["limits"]
        results = evidence["results"]
        call_limit = limits["provider_calls"]
        cost_limit = limits["estimated_cost_usd"]
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError):
        return None
    if (
        isinstance(calls, bool)
        or not isinstance(calls, int)
        or calls < 0
        or isinstance(cost, bool)
        or not isinstance(cost, (int, float))
        or isinstance(call_limit, bool)
        or not isinstance(call_limit, int)
        or isinstance(cost_limit, bool)
        or not isinstance(cost_limit, (int, float))
        or not isinstance(results, list)
        or any(not isinstance(item, dict) for item in results)
    ):
        return None
    return calls, float(cost), (call_limit, float(cost_limit)), results


def _provider_runtime_pin(repo_root: Path) -> str:
    try:
        data = tomllib.loads((repo_root / "python/pyproject.toml").read_text(encoding="utf-8"))
        revision = data["tool"]["uv"]["sources"]["provider-runtime"]["rev"]
    except (KeyError, OSError, TypeError, tomllib.TOMLDecodeError) as error:
        raise RuntimeContractError("provider-runtime pin is invalid or absent") from error
    if not isinstance(revision, str) or re.fullmatch(r"[0-9a-f]{40}", revision) is None:
        raise RuntimeContractError("provider-runtime pin is not a full Git SHA")
    return revision


def _ensure_provider_runtime_checkout(
    repo_root: Path,
    environment: Mapping[str, str],
) -> Path:
    """Materialize the pin without retargeting the developer checkout or venv."""

    revision = _provider_runtime_pin(repo_root)
    owner = repo_root / ".nexus-test/provider-runtime"
    checkout = owner / revision
    marker = checkout / ".nexus-provider-runtime-revision"
    if checkout.is_dir():
        try:
            recorded = marker.read_text(encoding="utf-8").strip()
        except OSError as error:
            raise RuntimeContractError("owned provider-runtime checkout is incomplete") from error
        if recorded != revision or not (checkout / ".venv").is_dir():
            raise RuntimeContractError("owned provider-runtime checkout is incomplete")
        return checkout

    source = repo_root.parent / "llm-calling"
    if not source.is_dir():
        raise RuntimeContractError("local provider-runtime Git object source is absent")
    child_environment = _child_environment(environment)
    path = child_environment.get("PATH")
    if shutil.which("git", path=path) is None or shutil.which("uv", path=path) is None:
        raise RuntimeContractError("provider-runtime materialization requires git and uv")

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
            raise RuntimeContractError("pinned provider-runtime commit is unavailable offline")
        with tarfile.open(archive, mode="r:") as bundle:
            bundle.extractall(build, filter="data")
        synced = run_command(
            ("uv", "sync", "--all-extras", "--locked", "--offline"),
            cwd=build,
            env=child_environment,
            capture_output=True,
            check=False,
        )
        if synced.returncode != 0 or not (build / ".venv").is_dir():
            raise RuntimeContractError("pinned provider-runtime environment is unavailable offline")
        (build / ".nexus-provider-runtime-revision").write_text(revision + "\n", encoding="utf-8")
        build.rename(checkout)
    except (OSError, tarfile.TarError) as error:
        raise RuntimeContractError("provider-runtime materialization failed") from error
    finally:
        archive.unlink(missing_ok=True)
        if build.exists():
            shutil.rmtree(build)
    return checkout


def _run_provider_runtime(
    context: CapabilityContext,
    environment: Mapping[str, str],
    *,
    exact: bool = False,
) -> CapabilityResult:
    capability = Capability.PROVIDER_RUNTIME
    python_root = context.repo_root / "python"
    contract_root = python_root / "tests/contract"
    owners = tuple(sorted(contract_root.rglob("test_*.py"))) if contract_root.is_dir() else ()
    if not owners or not (python_root / ".venv").is_dir():
        return _not_run(capability, "local provider protocol contract owner is absent")
    nodes, promoted = _selected_proof_nodes(context, capability, "pytest")
    if exact:
        if not nodes or promoted:
            raise ValueError("exact provider protocol proof must name one pytest node")
        targets = tuple(_python_heavy_node(node, "tests/contract") for node in nodes)
    elif _scope(context, capability) is SelectionScope.COMPLETE or promoted:
        targets = tuple(f"./{path.relative_to(python_root).as_posix()}" for path in owners)
    elif nodes:
        targets = tuple(_python_heavy_node(node, "tests/contract") for node in nodes)
    else:
        return _pass(capability, "no selected local provider protocol proof")
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
    )
    if local.evidence.status is not RunStatus.PASS or exact:
        return local

    try:
        checkout = _ensure_provider_runtime_checkout(context.repo_root, environment)
    except RuntimeContractError as error:
        return _not_run(capability, str(error))
    commands: tuple[FixedCommand, ...] = (
        (
            ("uv", "run", "--frozen", "--no-sync", "ruff", "check", "src", "tests"),
            checkout,
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
                "src",
                "tests",
            ),
            checkout,
        ),
        (("uv", "run", "--frozen", "--no-sync", "pyright", "src", "tests"), checkout),
        (
            (
                "uv",
                "run",
                "--frozen",
                "--no-sync",
                "pytest",
                "-q",
                *_DETERMINISTIC_PYTEST,
            ),
            checkout,
        ),
    )
    pinned = _run_fixed_commands(
        capability,
        commands,
        environment,
        ("uv",),
        elapsed_ms=local.evidence.duration_ms,
    )
    if pinned.evidence.status is not RunStatus.PASS:
        return pinned
    return CapabilityResult(
        pinned.evidence,
        "local provider protocol contract and pinned provider-runtime suite passed",
    )


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
    if not _android_sdk_available(android_root, environment):
        return _not_run(Capability.ANDROID_HOST, "Android SDK is absent")
    nodes, promoted = _selected_proof_nodes(context, Capability.ANDROID_HOST, "gradle")
    argv: tuple[str, ...] = ("./gradlew", "--no-daemon", ":app:testDebugUnitTest")
    if _scope(context, Capability.ANDROID_HOST) is not SelectionScope.COMPLETE and not promoted:
        if not nodes:
            return _pass(Capability.ANDROID_HOST, "no selected Android host proof")
        for node in nodes:
            argv = (*argv, "--tests", _android_test_class(context.repo_root, node))
    child_environment = dict(environment)
    child_environment["NEXUS_GOOGLE_WEB_CLIENT_ID"] = _TEST_GOOGLE_CLIENT_ID
    with _gradle_lock(context.repo_root):
        return _run_fixed_commands(
            Capability.ANDROID_HOST,
            ((argv, android_root),),
            child_environment,
            ("java",),
        )


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
    if not _android_sdk_available(android_root, environment):
        return _not_run(Capability.ANDROID_DEVICE, "Android SDK is absent")
    if not _android_device_attached(android_root, environment):
        return _not_run(Capability.ANDROID_DEVICE, "no authorized Android device is attached")
    child_environment = dict(environment)
    child_environment["NEXUS_GOOGLE_WEB_CLIENT_ID"] = _TEST_GOOGLE_CLIENT_ID
    with _gradle_lock(context.repo_root):
        return _run_fixed_commands(
            Capability.ANDROID_DEVICE,
            ((("./gradlew", "--no-daemon", ":app:connectedDebugAndroidTest"), android_root),),
            child_environment,
            ("java",),
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
    if not _android_sdk_available(android_root, environment):
        return _not_run(Capability.ANDROID_DEVICE, "Android SDK is absent")
    if not _android_device_attached(android_root, environment):
        return _not_run(Capability.ANDROID_DEVICE, "no authorized Android device is attached")
    target = _android_device_test_target(context.repo_root, node)
    child_environment = dict(environment)
    child_environment["NEXUS_GOOGLE_WEB_CLIENT_ID"] = _TEST_GOOGLE_CLIENT_ID
    with _gradle_lock(context.repo_root):
        result = _run_fixed_commands(
            Capability.ANDROID_DEVICE,
            (
                (
                    (
                        "./gradlew",
                        "--no-daemon",
                        ":app:connectedDebugAndroidTest",
                        f"-Pandroid.testInstrumentationRunnerArguments.class={target}",
                    ),
                    android_root,
                ),
            ),
            child_environment,
            ("java",),
        )
    if result.evidence.status is RunStatus.FAIL and _gradle_assertion_failed(android_root, target):
        return CapabilityResult(
            result.evidence,
            f"proof_result=behavioral_assertion_failure|{result.detail}",
        )
    return result


@dataclass(frozen=True, slots=True)
class _AndroidReleaseInputs:
    tag: str
    git_sha: str
    base_url: str
    owned_host: str
    certificate_sha256: str
    keystore: Path
    version_code: int
    version_name: str
    serial: str
    adb: Path
    apksigner: Path
    apkanalyzer: Path


def _run_android_release(
    context: CapabilityContext,
    environment: Mapping[str, str],
    execution: _WorkflowExecution | None,
) -> CapabilityResult:
    capability = Capability.ANDROID_RELEASE
    if execution is None:
        return _not_run(capability, "Android release requires a controller run identity")
    started = time.monotonic_ns()
    inputs = _android_release_inputs(context.repo_root, environment)
    if isinstance(inputs, CapabilityResult):
        return inputs
    android_root = context.repo_root / "apps/android"
    child_environment = _child_environment(environment)
    release_environment_names = (
        "NEXUS_ANDROID_RELEASE_BASE_URL",
        "NEXUS_ANDROID_RELEASE_OWNED_HOST",
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
    target = (
        "app.nexus.android.NativeAuthHandoffTest#"
        "nativeAuthStartCarriesTheExactHandoffContractToTheOwnedOrigin"
    )
    commands = (
        (
            "./gradlew",
            "--no-daemon",
            "-PnexusAndroidInstrumentationBuildType=release",
            ":app:clean",
            ":app:lintRelease",
            ":app:assembleRelease",
        ),
        (
            "./gradlew",
            "--no-daemon",
            "-PnexusAndroidInstrumentationBuildType=release",
            ":app:connectedReleaseAndroidTest",
            f"-Pandroid.testInstrumentationRunnerArguments.class={target}",
        ),
    )
    with _gradle_lock(context.repo_root):
        build = _release_command(commands[0], android_root, child_environment)
        if build.returncode != 0:
            return _release_command_failure(capability, started, 1, build, child_environment)
        apk = android_root / "app/build/outputs/apk/release/app-release.apk"
        if not apk.is_file() or apk.is_symlink():
            return _release_failure(
                capability, started, "release APK is absent or not a regular file"
            )
        signer = _release_command(
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
        manifest = _release_command(
            (str(inputs.apkanalyzer), "manifest", "print", str(apk)),
            context.repo_root,
            child_environment,
        )
        manifest_facts = _release_manifest_facts(manifest.stdout)
        expected_manifest = (
            "app.nexus.android",
            str(inputs.version_code),
            inputs.version_name,
            inputs.owned_host,
        )
        if manifest.returncode != 0 or manifest_facts != expected_manifest:
            return _release_failure(
                capability,
                started,
                "release APK manifest differs from package/version/App-Link contract",
            )
        offline = _release_command(
            (
                str(inputs.adb),
                "-s",
                inputs.serial,
                "shell",
                "cmd",
                "connectivity",
                "airplane-mode",
                "enable",
            ),
            context.repo_root,
            child_environment,
        )
        offline_state = _release_command(
            (
                str(inputs.adb),
                "-s",
                inputs.serial,
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
                "dedicated release emulator could not be placed offline before app launch",
            )
        device = _release_command(commands[1], android_root, child_environment)
        if device.returncode != 0:
            return _release_command_failure(capability, started, 2, device, child_environment)
        if not _gradle_assertion_passed(android_root, target):
            return _release_failure(
                capability,
                started,
                "release instrumentation did not emit the exact passing auth-handoff proof",
            )
        verified_again = _release_command(
            (str(inputs.apksigner), "verify", "--verbose", "--print-certs", str(apk)),
            context.repo_root,
            child_environment,
        )
        if (
            verified_again.returncode != 0
            or _apksigner_certificate(verified_again) != inputs.certificate_sha256
        ):
            return _release_failure(capability, started, "tested release APK changed after signing")
        resolved = _release_command(
            (
                str(inputs.adb),
                "-s",
                inputs.serial,
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
                "version": 1,
                "run_id": execution.run_id,
                "git_sha": inputs.git_sha,
                "tag": inputs.tag,
                "apk_path": apk.relative_to(context.repo_root).as_posix(),
                "apk_sha256": sha256,
                "apk_size": apk.stat().st_size,
                "package": "app.nexus.android",
                "version_code": inputs.version_code,
                "version_name": inputs.version_name,
                "signer_sha256": inputs.certificate_sha256,
                "emulator": {"serial": inputs.serial, "qemu": True},
                "instrumentation_proof": target,
                "app_link_host": inputs.owned_host,
                "resolved_activity": resolved_activity[0],
                "production_network_contact": False,
                "emulator_network_disabled": True,
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
        "signed release APK, exact auth handoff, and local App-Link resolution passed",
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
    evidence_path = (
        context.repo_root / "test-results/runs" / execution.run_id / "android-release.json"
    )
    try:
        source = json.loads(evidence_path.read_text(encoding="utf-8"))
        tag = source["tag"]
        apk_relative = source["apk_path"]
        expected_sha256 = source["apk_sha256"]
        signer = source["signer_sha256"]
        version_code = source["version_code"]
        version_name = source["version_name"]
        git_sha = source["git_sha"]
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError):
        return _release_failure(
            capability, started, "same-run Android release evidence is absent or invalid"
        )
    if (
        source.get("run_id") != execution.run_id
        or not isinstance(tag, str)
        or re.fullmatch(r"android-v[a-zA-Z0-9._-]+", tag) is None
        or apk_relative != "apps/android/app/build/outputs/apk/release/app-release.apk"
        or not isinstance(expected_sha256, str)
        or re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None
        or not isinstance(signer, str)
        or re.fullmatch(r"[0-9a-f]{64}", signer) is None
        or isinstance(version_code, bool)
        or not isinstance(version_code, int)
        or version_code < 1
        or not isinstance(version_name, str)
        or version_name != tag.removeprefix("android-v")
        or not isinstance(git_sha, str)
        or re.fullmatch(r"[0-9a-f]{40}", git_sha) is None
    ):
        return _release_failure(capability, started, "Android release evidence changed shape")
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
    _adb, apksigner, _apkanalyzer = sdk_tools
    verified = _release_command(
        (str(apksigner), "verify", "--verbose", "--print-certs", str(apk)),
        context.repo_root,
        _child_environment(environment),
    )
    if verified.returncode != 0 or _apksigner_certificate(verified) != signer:
        return _release_failure(capability, started, "release source signer changed")
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
        "version": 1,
        "run_id": execution.run_id,
        "git_sha": git_sha,
        "tag": tag,
        "package": "app.nexus.android",
        "version_code": version_code,
        "version_name": version_name,
        "signer_sha256": signer,
        "source_apk_sha256": expected_sha256,
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
) -> _AndroidReleaseInputs | CapabilityResult:
    capability = Capability.ANDROID_RELEASE
    names = (
        "ANDROID_RELEASE_TAG",
        "NEXUS_ANDROID_RELEASE_BASE_URL",
        "NEXUS_ANDROID_RELEASE_OWNED_HOST",
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
    if re.fullmatch(r"android-v[a-zA-Z0-9._-]+", tag) is None:
        return _fail(capability, "Android release tag must match android-v*")
    try:
        tag_sha = _git_commit(repo_root, tag, environment)
        head_sha = _git_commit(repo_root, "HEAD", environment)
        if tag_sha != head_sha:
            return _fail(capability, "Android release tag does not resolve to HEAD")
    except RuntimeContractError as error:
        return _fail(capability, str(error))
    base_url = environment["NEXUS_ANDROID_RELEASE_BASE_URL"].rstrip("/")
    owned_host = environment["NEXUS_ANDROID_RELEASE_OWNED_HOST"]
    parsed = urlsplit(base_url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != owned_host
        or owned_host != "nexus.nielseriknandal.com"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        return _fail(capability, "Android release URL must be the canonical HTTPS origin")
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
    serial, device_error = _authorized_emulator(repo_root, adb, environment)
    if serial is None:
        status = RunStatus.FAIL if device_error.startswith("unsafe") else RunStatus.NOT_RUN
        return _result(capability, status, 0, device_error)
    return _AndroidReleaseInputs(
        tag,
        head_sha,
        base_url,
        owned_host,
        certificate,
        keystore,
        version_code,
        version_name,
        serial,
        adb,
        apksigner,
        apkanalyzer,
    )


def _android_release_tools(
    environment: Mapping[str, str],
) -> tuple[Path, Path, Path] | None:
    sdk_value = environment.get("ANDROID_HOME") or environment.get("ANDROID_SDK_ROOT")
    if not sdk_value:
        return None
    sdk = Path(sdk_value)
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


def _authorized_emulator(
    repo_root: Path,
    adb: Path,
    environment: Mapping[str, str],
) -> tuple[str | None, str]:
    child_environment = _child_environment(environment)
    listed = _release_command((str(adb), "devices"), repo_root, child_environment)
    if listed.returncode != 0:
        return None, "Android emulator inventory could not be read"
    devices = tuple(
        line.split("\t", 1)[0]
        for line in listed.stdout.splitlines()[1:]
        if line.endswith("\tdevice")
    )
    if not devices:
        return None, "no authorized Android emulator is attached"
    if len(devices) != 1 or not devices[0].startswith("emulator-"):
        return None, "unsafe Android device inventory: release proof permits one emulator only"
    serial = devices[0]
    qemu = _release_command(
        (str(adb), "-s", serial, "shell", "getprop", "ro.kernel.qemu"),
        repo_root,
        child_environment,
    )
    if qemu.returncode != 0 or qemu.stdout.strip() != "1":
        return None, "unsafe Android device inventory: selected device is not qemu"
    return serial, ""


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


def _apksigner_certificate(completed: subprocess.CompletedProcess[str]) -> str | None:
    match = re.search(
        r"(?im)^Signer #1 certificate SHA-256 digest:\s*([0-9a-f:]{64,95})\s*$",
        f"{completed.stdout}\n{completed.stderr}",
    )
    return match.group(1).replace(":", "").lower() if match else None


def _release_manifest_facts(text: str) -> tuple[str, str, str, str] | None:
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
    return (
        root.attrib.get("package", ""),
        root.attrib.get(f"{android}versionCode", ""),
        root.attrib.get(f"{android}versionName", ""),
        next(iter(hosts)),
    )


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


def _run_doctor(context: CapabilityContext, environment: Mapping[str, str]) -> CapabilityResult:
    started = time.monotonic_ns()
    child_environment = _child_environment(environment)
    required_tools = ("actionlint", "bun", "docker", "git", "java", "supabase", "uv")
    missing_tools = tuple(
        tool
        for tool in required_tools
        if shutil.which(tool, path=child_environment.get("PATH")) is None
    )
    if missing_tools:
        return _not_run(Capability.DOCTOR, f"required tools are absent: {', '.join(missing_tools)}")

    required_paths = (
        "python/pyproject.toml",
        "python/uv.lock",
        "python/.venv",
        "apps/web/package.json",
        "apps/web/bun.lock",
        "apps/web/node_modules",
        "apps/web/e2e/playwright.config.ts",
        "apps/android/gradlew",
    )
    missing_paths = tuple(
        relative for relative in required_paths if not (context.repo_root / relative).exists()
    )
    if missing_paths:
        return _not_run(
            Capability.DOCTOR, f"locked tool owners are absent: {', '.join(missing_paths)}"
        )

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
                str(context.repo_root / "python/.venv/bin/python"),
                "-c",
                "import provider_runtime",
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

    try:
        expected_provider_revision = _provider_runtime_pin(context.repo_root)
        provider_checkout = (
            context.repo_root / ".nexus-test/provider-runtime" / expected_provider_revision
        )
        provider_revision = (provider_checkout / ".nexus-provider-runtime-revision").read_text(
            encoding="utf-8"
        )
    except (OSError, RuntimeContractError):
        return _not_run(Capability.DOCTOR, "pinned provider-runtime checkout is unavailable")
    if (
        provider_revision.strip() != expected_provider_revision
        or not (provider_checkout / ".venv").is_dir()
    ):
        return _not_run(Capability.DOCTOR, "pinned provider-runtime checkout is not ready")

    if not _android_sdk_available(context.repo_root / "apps/android", environment):
        return _not_run(Capability.DOCTOR, "the Android SDK is absent")
    if not _browser_installed(context.repo_root, environment):
        return _not_run(Capability.DOCTOR, "the locked Chromium browser is absent")

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
    if environment.get("NEXUS_HOSTED_CANARY") == "1" and not environment.get("OPENAI_API_KEY"):
        protected_missing.append("nightly:OPENAI_API_KEY")
    if environment.get("NEXUS_PROVIDER_CERTIFICATION") == "1":
        protected_missing.extend(
            f"release:{name}"
            for name in (
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "GEMINI_API_KEY",
                "MOONSHOT_API_KEY",
                "NEXUS_FABLE_RETENTION_ACCEPTED_AT",
            )
            if not environment.get(name)
        )
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


def _android_sdk_available(android_root: Path, environment: Mapping[str, str]) -> bool:
    if (android_root / "local.properties").is_file():
        return True
    return any(
        environment.get(key) and Path(environment[key]).is_dir()
        for key in ("ANDROID_HOME", "ANDROID_SDK_ROOT")
    )


def _android_device_attached(android_root: Path, environment: Mapping[str, str]) -> bool:
    sdk_root = environment.get("ANDROID_HOME") or environment.get("ANDROID_SDK_ROOT")
    adb = Path(sdk_root) / "platform-tools/adb" if sdk_root else Path("adb")
    command = str(adb) if adb.is_file() else shutil.which("adb", path=environment.get("PATH"))
    if command is None:
        return False
    try:
        result = run_command(
            (command, "devices"),
            cwd=android_root,
            env=_child_environment(environment),
            capture_output=True,
            check=False,
        )
    except OSError:
        return False
    return result.returncode == 0 and any(
        line.endswith("\tdevice") for line in result.stdout.splitlines()[1:]
    )


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
    browsers_json = repo_root / "apps/web/node_modules/playwright-core/browsers.json"
    try:
        data = json.loads(browsers_json.read_text(encoding="utf-8"))
        revisions = {
            browser["name"]: browser["revision"]
            for browser in data["browsers"]
            if browser["name"] in {"chromium", "chromium-headless-shell"}
        }
    except (KeyError, OSError, TypeError, json.JSONDecodeError):
        return False
    if set(revisions) != {"chromium", "chromium-headless-shell"}:
        return False
    browser_root = environment.get("PLAYWRIGHT_BROWSERS_PATH")
    if browser_root:
        cache = Path(browser_root)
    else:
        cache_home = environment.get("XDG_CACHE_HOME")
        home = environment.get("HOME")
        if cache_home:
            cache = Path(cache_home) / "ms-playwright"
        elif home:
            cache = Path(home) / ".cache/ms-playwright"
        else:
            return False
    chromium = cache / f"chromium-{revisions['chromium']}"
    headless = cache / f"chromium_headless_shell-{revisions['chromium-headless-shell']}"
    return all(
        owner.is_dir()
        and (owner / "INSTALLATION_COMPLETE").is_file()
        and any(path.is_file() and os.access(path, os.X_OK) for path in owner.rglob(executable))
        for owner, executable in ((chromium, "chrome"), (headless, "chrome-headless-shell"))
    )


def _run_fixed_commands(
    capability: Capability,
    commands: tuple[FixedCommand, ...],
    environment: Mapping[str, str],
    required_tools: tuple[str, ...],
    *,
    elapsed_ms: int = 0,
    pythonpath: Path | None = None,
) -> CapabilityResult:
    child_environment = _child_environment(environment)
    if pythonpath is not None:
        child_environment["PYTHONPATH"] = str(pythonpath)
    missing = tuple(
        tool
        for tool in required_tools
        if shutil.which(tool, path=child_environment.get("PATH")) is None
    )
    if missing:
        return _not_run(capability, f"required tools are absent: {', '.join(missing)}")
    started = time.monotonic_ns()
    for index, (argv, cwd) in enumerate(commands, start=1):
        try:
            completed = run_command(
                argv,
                cwd=cwd,
                env=child_environment,
                capture_output=True,
                check=False,
            )
        except OSError as error:
            duration_ms = elapsed_ms + (time.monotonic_ns() - started) // 1_000_000
            return _result(
                capability,
                RunStatus.NOT_RUN,
                duration_ms,
                f"fixed command {index} could not start: {error.strerror or error}",
            )
        if completed.returncode != 0:
            duration_ms = elapsed_ms + (time.monotonic_ns() - started) // 1_000_000
            artifacts = _failure_artifacts(capability, index, completed, environment)
            interrupted_by = _command_interruption_signal(completed.returncode)
            return _result(
                capability,
                RunStatus.NOT_RUN if interrupted_by is not None else RunStatus.FAIL,
                duration_ms,
                _command_result_detail(index, completed, interrupted_by),
                artifacts=artifacts,
            )
    duration_ms = elapsed_ms + (time.monotonic_ns() - started) // 1_000_000
    return _result(
        capability,
        RunStatus.PASS,
        duration_ms,
        f"{len(commands)} fixed command{'s' if len(commands) != 1 else ''} passed",
    )


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
    lines = stripped.splitlines()
    decisive_lines: set[int] = set()
    for index, line in enumerate(lines):
        if re.search(
            r"(?:^|\s)(?:E\s+(?:assert|AssertionError|Failed:)|FAILED\s|"
            r"AssertionError:|Error:\s*expect\(|expect\(locator\)\.to[A-Za-z]+\(|"
            r"Tests\s+\d+\s+failed|falsifying example:)",
            line,
            re.IGNORECASE,
        ):
            decisive_lines.add(index)
            if "expect(locator)." in line.casefold():
                decisive_lines.update(range(max(0, index - 4), index))
    decisive = "\n".join(lines[index] for index in sorted(decisive_lines))
    return (decisive or stripped)[-limit:]


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


def _failure_artifacts(
    capability: Capability,
    index: int,
    completed: subprocess.CompletedProcess[str],
    environment: Mapping[str, str],
) -> tuple[str, ...]:
    raw_directory = environment.get("NEXUS_TEST_RESULTS_DIR")
    run_id = environment.get("NEXUS_TEST_RUN_ID")
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
            f"exit={completed.returncode}\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}\n",
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
