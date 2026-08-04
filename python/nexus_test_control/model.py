import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from pathlib import PurePosixPath
from types import MappingProxyType

_GIT_SHA = re.compile(r"[0-9a-f]{40}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")


def _repository_relative(value: str) -> bool:
    path = PurePosixPath(value)
    return (
        bool(value.strip())
        and not path.is_absolute()
        and ".." not in path.parts
        and "\\" not in value
    )


class Workflow(StrEnum):
    CHANGED = "changed"
    CONFIDENCE = "confidence"
    PR = "pr"
    FULL = "full"
    NIGHTLY = "nightly"
    RELEASE = "release"
    DOCTOR = "doctor"


class Capability(StrEnum):
    POLICY = "policy"
    POLICY_SELF_TESTS = "policy-self-tests"
    STATIC_PYTHON = "static-python"
    STATIC_WEB = "static-web"
    STATIC_WORKFLOWS = "static-workflows"
    KERNEL_PYTHON = "kernel-python"
    KERNEL_WEB = "kernel-web"
    SENSITIVITY = "sensitivity"
    SERVICE = "service"
    COMPONENT = "component"
    MIGRATIONS = "migrations"
    BUNDLE = "bundle"
    JOURNEYS_CRITICAL = "journeys-critical"
    JOURNEYS_ALL = "journeys-all"
    CORPUS = "corpus"
    PROVIDER_RUNTIME = "provider-runtime"
    LLM_EVAL = "llm-eval"
    EXTENSION = "extension"
    ANDROID_HOST = "android-host"
    AUDIT = "audit"
    HOSTED = "hosted"
    ANDROID_DEVICE = "android-device"
    PROVIDER_CERTIFICATION = "provider-certification"
    ANDROID_RELEASE = "android-release"
    RELEASE_ARTIFACT = "release-artifact"
    DOCTOR = "doctor"


class PriorityRiskId(StrEnum):
    TEST_ENVIRONMENT_ISOLATION = "test-environment-isolation"
    AUTH_PRIVACY_SECRETS = "auth-privacy-secrets"
    DESTRUCTIVE_SIDE_EFFECTS = "destructive-side-effects"
    MIGRATION_COMPATIBILITY = "migration-compatibility"
    COSTLY_EFFECTS = "costly-effects"
    READING_PROGRESS = "reading-progress"
    CITATION_PROVENANCE_IDENTITY = "citation-provenance-identity"
    DURABLE_JOB_REPLAY = "durable-job-replay"
    DATABASE_OBJECT_CONVERGENCE = "database-object-convergence"
    LLM_TOOL_SAFETY = "llm-tool-safety"
    NATIVE_RELEASE_AUTH_HANDOFF = "native-release-auth-handoff"
    NATIVE_SYSTEM_INSETS = "native-system-insets"


PRIORITY_RISK_FLOOR = frozenset(PriorityRiskId)
PRIORITY_SOURCE_OWNERSHIP_SHA256 = (
    "5673ec4fa650f74a57fbaef4c3cc40d468a51c1a0ad30f0106584f0b30ab643f"
)


class ResourceKind(StrEnum):
    TEMPLATE_BUILD = "template-build"
    TEMPLATE = "template"
    RUN_DATABASE = "run-database"
    MIGRATION_DATABASE = "migration-database"
    BUCKET = "bucket"
    SUPABASE_USER = "supabase-user"
    PROCESS = "process"
    EXTENSION_PROFILE = "extension-profile"
    BUILD_ARTIFACT = "build-artifact"
    LOCK = "lock"


@dataclass(frozen=True, slots=True)
class Resource:
    kind: ResourceKind
    identity: str

    def __post_init__(self) -> None:
        if not isinstance(self.kind, ResourceKind):
            raise ValueError("resource kind must be a typed ResourceKind")
        if not self.identity.strip():
            raise ValueError("resource identity must not be blank")


class RunStatus(StrEnum):
    PASS = "pass"
    FAIL = "fail"
    NOT_RUN = "not_run"


@dataclass(frozen=True, slots=True)
class PeakOwnedMemory:
    process_tree_rss: int
    container_working_set: int
    total: int
    measurement_complete: bool = True

    def __post_init__(self) -> None:
        if any(
            type(value) is not int or value < 0
            for value in (
                self.process_tree_rss,
                self.container_working_set,
                self.total,
            )
        ):
            raise ValueError("owned memory values must be nonnegative integers")
        if self.total != self.process_tree_rss + self.container_working_set:
            raise ValueError("total owned memory must equal its recorded owners")
        if not isinstance(self.measurement_complete, bool):
            raise ValueError("owned memory measurement state must be boolean")


def aggregate_status(statuses: tuple[RunStatus, ...]) -> RunStatus:
    if any(not isinstance(status, RunStatus) for status in statuses):
        raise ValueError("aggregate statuses must be typed RunStatus values")
    if not statuses or RunStatus.NOT_RUN in statuses:
        return RunStatus.NOT_RUN if RunStatus.FAIL not in statuses else RunStatus.FAIL
    if RunStatus.FAIL in statuses:
        return RunStatus.FAIL
    return RunStatus.PASS


class SelectionReason(StrEnum):
    EXPLICIT_FOCUS = "explicit-focus"
    CHANGED_TEST = "changed-test"
    FRONTEND_RELATED = "frontend-related"
    CRITICAL_SOURCE = "critical-source"
    LAZY_PANE = "lazy-pane"
    PYTHON_OWNER = "python-owner"
    PRIORITY_RISK = "priority-risk"
    JOURNEY_OWNER = "journey-owner"
    PROMOTED_CAPABILITY = "promoted-capability"


@dataclass(frozen=True, slots=True)
class Selection:
    path: str
    capability: Capability
    reason: SelectionReason
    proof: str | None = None
    sensitivity_required: bool = False
    deferred_to: Workflow | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.capability, Capability) or not isinstance(
            self.reason, SelectionReason
        ):
            raise ValueError("selection capability and reason must be typed enums")
        if not _repository_relative(self.path):
            raise ValueError("selection path must be repository-relative")
        if self.proof is not None and not self.proof.strip():
            raise ValueError("selection proof must not be blank")
        if self.sensitivity_required and self.proof is None:
            raise ValueError("sensitivity-required selection must name its proof")
        if self.deferred_to is not None and not isinstance(self.deferred_to, Workflow):
            raise ValueError("selection deferral must name a typed workflow")


class SensitivityMethod(StrEnum):
    BASE = "base"
    FAULT = "fault"


class SensitivityPhase(StrEnum):
    ASSERTION = "assertion"
    PROPERTY = "property"


@dataclass(frozen=True, slots=True)
class SensitivityAgainst:
    git_sha: str | None
    fault_id: str | None

    def __post_init__(self) -> None:
        if self.git_sha is not None and _GIT_SHA.fullmatch(self.git_sha) is None:
            raise ValueError("sensitivity base must be a full lowercase Git SHA")
        if self.fault_id is not None and not self.fault_id.strip():
            raise ValueError("sensitivity fault id must not be blank")


@dataclass(frozen=True, slots=True)
class SensitivityRed:
    phase: SensitivityPhase
    failure_fingerprint: str
    duration_ms: int
    peak_owned_mib: PeakOwnedMemory
    artifacts: tuple[str, ...] = ()
    status: RunStatus = RunStatus.FAIL

    def __post_init__(self) -> None:
        if not isinstance(self.phase, SensitivityPhase):
            raise ValueError("sensitivity red phase must be a typed enum")
        if self.status is not RunStatus.FAIL:
            raise ValueError("sensitivity red result must fail")
        if not self.failure_fingerprint.strip():
            raise ValueError("failure fingerprint must not be blank")
        _validate_sensitivity_attempt(self.duration_ms, self.peak_owned_mib, self.artifacts)


@dataclass(frozen=True, slots=True)
class SensitivityGreen:
    git_sha: str
    duration_ms: int
    peak_owned_mib: PeakOwnedMemory
    artifacts: tuple[str, ...] = ()
    status: RunStatus = RunStatus.PASS

    def __post_init__(self) -> None:
        if self.status is not RunStatus.PASS:
            raise ValueError("sensitivity green result must pass")
        if _GIT_SHA.fullmatch(self.git_sha) is None:
            raise ValueError("green Git SHA must be full and lowercase")
        _validate_sensitivity_attempt(self.duration_ms, self.peak_owned_mib, self.artifacts)


def _validate_sensitivity_attempt(
    duration_ms: int,
    peak_owned_mib: PeakOwnedMemory,
    artifacts: tuple[str, ...],
) -> None:
    if type(duration_ms) is not int or duration_ms < 0:
        raise ValueError("sensitivity attempt duration must be a nonnegative integer")
    if not isinstance(peak_owned_mib, PeakOwnedMemory):
        raise ValueError("sensitivity attempt memory must be typed evidence")
    if any(not _repository_relative(artifact) for artifact in artifacts):
        raise ValueError("sensitivity attempt artifacts must be repository-relative")


@dataclass(frozen=True, slots=True)
class Sensitivity:
    proof: str
    changed_paths: tuple[str, ...]
    proof_digest: str
    method: SensitivityMethod
    against: SensitivityAgainst
    red: SensitivityRed
    green: SensitivityGreen

    def __post_init__(self) -> None:
        if not isinstance(self.method, SensitivityMethod):
            raise ValueError("sensitivity method must be a typed enum")
        if not self.proof.strip() or not self.changed_paths:
            raise ValueError("sensitivity requires a proof, changed paths, and proof digest")
        if any(not _repository_relative(path) for path in self.changed_paths):
            raise ValueError("sensitivity changed paths must be repository-relative")
        if _SHA256.fullmatch(self.proof_digest) is None:
            raise ValueError("sensitivity proof digest must be lowercase sha256")
        if self.method is SensitivityMethod.BASE:
            valid_against = bool(self.against.git_sha) and self.against.fault_id is None
        else:
            valid_against = bool(self.against.fault_id) and self.against.git_sha is None
        if not valid_against:
            raise ValueError("sensitivity against state must match its method")


class SelectionScope(StrEnum):
    CHANGED = "changed"
    AFFECTED = "affected"
    COMPLETE = "complete"


@dataclass(frozen=True, slots=True)
class CapabilityRequirement:
    capability: Capability
    scope: SelectionScope


@dataclass(frozen=True, slots=True)
class WorkflowDefinition:
    workflow: Workflow
    requirements: tuple[CapabilityRequirement, ...]


def _requirements(
    scope: SelectionScope, capabilities: tuple[Capability, ...]
) -> tuple[CapabilityRequirement, ...]:
    return tuple(CapabilityRequirement(capability, scope) for capability in capabilities)


_FAST_COMPLETE = (
    Capability.POLICY,
    Capability.POLICY_SELF_TESTS,
    Capability.STATIC_PYTHON,
    Capability.STATIC_WEB,
    Capability.STATIC_WORKFLOWS,
    Capability.KERNEL_PYTHON,
    Capability.KERNEL_WEB,
)

_PR_COMPLETE = (
    *_FAST_COMPLETE,
    Capability.SENSITIVITY,
    Capability.SERVICE,
    Capability.COMPONENT,
    Capability.MIGRATIONS,
    Capability.BUNDLE,
    Capability.JOURNEYS_CRITICAL,
)

_FULL_NON_BROWSER = (
    *_PR_COMPLETE[:-1],
    Capability.CORPUS,
    Capability.PROVIDER_RUNTIME,
    Capability.LLM_EVAL,
    Capability.ANDROID_HOST,
)

_FULL_COMPLETE = (
    *_FULL_NON_BROWSER,
    Capability.JOURNEYS_ALL,
    Capability.EXTENSION,
)

_CHANGED_AFFECTED = (
    Capability.POLICY_SELF_TESTS,
    Capability.KERNEL_PYTHON,
    Capability.KERNEL_WEB,
    Capability.SERVICE,
    Capability.COMPONENT,
    Capability.MIGRATIONS,
    Capability.JOURNEYS_ALL,
)

WORKFLOW_REGISTRY: Mapping[Workflow, WorkflowDefinition] = MappingProxyType(
    {
        Workflow.CHANGED: WorkflowDefinition(
            Workflow.CHANGED,
            (
                *_requirements(
                    SelectionScope.CHANGED,
                    (
                        Capability.POLICY,
                        Capability.STATIC_PYTHON,
                        Capability.STATIC_WEB,
                        Capability.STATIC_WORKFLOWS,
                    ),
                ),
                *_requirements(
                    SelectionScope.AFFECTED,
                    _CHANGED_AFFECTED,
                ),
            ),
        ),
        Workflow.CONFIDENCE: WorkflowDefinition(
            Workflow.CONFIDENCE,
            (
                *_requirements(SelectionScope.COMPLETE, _FAST_COMPLETE),
                CapabilityRequirement(Capability.SERVICE, SelectionScope.AFFECTED),
                CapabilityRequirement(Capability.COMPONENT, SelectionScope.AFFECTED),
            ),
        ),
        Workflow.PR: WorkflowDefinition(
            Workflow.PR, _requirements(SelectionScope.COMPLETE, _PR_COMPLETE)
        ),
        Workflow.FULL: WorkflowDefinition(
            Workflow.FULL, _requirements(SelectionScope.COMPLETE, _FULL_COMPLETE)
        ),
        Workflow.NIGHTLY: WorkflowDefinition(
            Workflow.NIGHTLY,
            _requirements(
                SelectionScope.COMPLETE,
                (
                    *_FULL_NON_BROWSER,
                    Capability.AUDIT,
                    Capability.HOSTED,
                    Capability.ANDROID_DEVICE,
                    Capability.JOURNEYS_ALL,
                    Capability.EXTENSION,
                ),
            ),
        ),
        Workflow.RELEASE: WorkflowDefinition(
            Workflow.RELEASE,
            _requirements(
                SelectionScope.COMPLETE,
                (
                    *_FULL_NON_BROWSER,
                    Capability.PROVIDER_CERTIFICATION,
                    Capability.ANDROID_RELEASE,
                    Capability.RELEASE_ARTIFACT,
                    Capability.JOURNEYS_ALL,
                    Capability.EXTENSION,
                ),
            ),
        ),
        Workflow.DOCTOR: WorkflowDefinition(
            Workflow.DOCTOR,
            (CapabilityRequirement(Capability.DOCTOR, SelectionScope.COMPLETE),),
        ),
    }
)

DEFERRED_CAPABILITY_OWNER: Mapping[Capability, Workflow] = MappingProxyType(
    {
        Capability.SENSITIVITY: Workflow.PR,
        Capability.MIGRATIONS: Workflow.PR,
        Capability.BUNDLE: Workflow.PR,
        Capability.JOURNEYS_ALL: Workflow.FULL,
        Capability.CORPUS: Workflow.FULL,
        Capability.PROVIDER_RUNTIME: Workflow.FULL,
        Capability.LLM_EVAL: Workflow.FULL,
        Capability.EXTENSION: Workflow.FULL,
        Capability.ANDROID_HOST: Workflow.FULL,
        Capability.AUDIT: Workflow.NIGHTLY,
        Capability.HOSTED: Workflow.NIGHTLY,
        Capability.ANDROID_DEVICE: Workflow.NIGHTLY,
        Capability.PROVIDER_CERTIFICATION: Workflow.RELEASE,
        Capability.ANDROID_RELEASE: Workflow.RELEASE,
        Capability.RELEASE_ARTIFACT: Workflow.RELEASE,
    }
)

_TEST_ROUTING_CONTRACT = "\n".join(
    (
        *(
            f"workflow|{workflow.value}|{requirement.capability.value}|{requirement.scope.value}"
            for workflow, definition in WORKFLOW_REGISTRY.items()
            for requirement in definition.requirements
        ),
        *(
            f"deferred|{capability.value}|{workflow.value}"
            for capability, workflow in DEFERRED_CAPABILITY_OWNER.items()
        ),
    )
)
TEST_ROUTING_SHA256 = hashlib.sha256(_TEST_ROUTING_CONTRACT.encode()).hexdigest()
