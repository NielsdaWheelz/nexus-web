import hashlib
import json
import math
import os
import re
import tempfile
from collections.abc import Iterable, Mapping
from dataclasses import InitVar, dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

from nexus_test_control.model import (
    WORKFLOW_REGISTRY,
    Capability,
    RunStatus,
    Selection,
    SelectionReason,
    Sensitivity,
    SensitivityAgainst,
    SensitivityGreen,
    SensitivityMethod,
    SensitivityPhase,
    SensitivityRed,
    Workflow,
    aggregate_status,
)

type JsonScalar = str | int | float | bool | None
type JsonValue = JsonScalar | list["JsonValue"] | dict[str, "JsonValue"]

REDACTED = "[REDACTED]"
_SENSITIVE_KEY_PARTS = (
    "authorization",
    "command",
    "cookie",
    "credential",
    "environment",
    "password",
    "secret",
    "token",
)
_BEARER = re.compile(r"(?i)\bbearer\s+[^\s,;]+")
_RUN_ID = re.compile(r"[0-9a-f]{16}\Z")
_FINGERPRINT = re.compile(r"[0-9a-f]{64}\Z")
_EXACT_EXECUTION_INPUTS = frozenset(
    {
        "ANDROID_HOME",
        "ANDROID_RELEASE_TAG",
        "ANDROID_SDK_ROOT",
        "ANTHROPIC_API_KEY",
        "CI",
        "DOCKER_CONTEXT",
        "DOCKER_HOST",
        "GEMINI_API_KEY",
        "GRADLE_USER_HOME",
        "HOME",
        "JAVA_HOME",
        "LANG",
        "LC_ALL",
        "NO_COLOR",
        "MOONSHOT_API_KEY",
        "OPENAI_API_KEY",
        "PATH",
        "PLAYWRIGHT_BROWSERS_PATH",
        "TERM",
        "TMPDIR",
        "TZ",
        "UV_CACHE_DIR",
        "XDG_CACHE_HOME",
    }
)
_IGNORED_EXECUTION_INPUTS = frozenset({"NEXUS_TEST_RESULTS_DIR", "NEXUS_TEST_RUN_ID"})


def _nonnegative(name: str, value: int | float) -> None:
    if value < 0 or isinstance(value, float) and not math.isfinite(value):
        raise ValueError(f"{name} must be finite and nonnegative")


@dataclass(frozen=True, slots=True)
class PeakOwnedMemory:
    process_tree_rss: int
    container_working_set: int
    total: int
    measurement_complete: bool = True

    def __post_init__(self) -> None:
        _nonnegative("process tree RSS", self.process_tree_rss)
        _nonnegative("container working set", self.container_working_set)
        if self.total != self.process_tree_rss + self.container_working_set:
            raise ValueError("total owned memory must equal its recorded owners")
        if not isinstance(self.measurement_complete, bool):
            raise ValueError("owned memory measurement state must be boolean")


@dataclass(frozen=True, slots=True)
class CapabilityEvidence:
    id: Capability
    status: RunStatus
    duration_ms: int
    peak_owned_mib: int
    provider_calls: int = 0
    estimated_cost_usd: float = 0
    artifacts: tuple[str, ...] = ()
    detail: str = ""

    def __post_init__(self) -> None:
        if not isinstance(self.id, Capability) or not isinstance(self.status, RunStatus):
            raise ValueError("capability id and status must be typed enums")
        _nonnegative("duration", self.duration_ms)
        _nonnegative("peak owned memory", self.peak_owned_mib)
        _nonnegative("provider calls", self.provider_calls)
        _nonnegative("estimated cost", self.estimated_cost_usd)
        for artifact in self.artifacts:
            path = PurePosixPath(artifact)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError("evidence artifacts must be repository-relative")


@dataclass(frozen=True, slots=True)
class InvocationEvidence:
    ui: bool = False
    input_fingerprint: str = hashlib.sha256(b"{}").hexdigest()

    def __post_init__(self) -> None:
        if not isinstance(self.ui, bool):
            raise ValueError("invocation UI mode must be boolean")
        if _FINGERPRINT.fullmatch(self.input_fingerprint) is None:
            raise ValueError("invocation input fingerprint must be SHA-256")


def execution_input_fingerprint(environment: Mapping[str, str]) -> str:
    inputs: dict[str, str | bool] = {}
    for key, value in sorted(environment.items()):
        if key in _IGNORED_EXECUTION_INPUTS:
            continue
        if key not in _EXACT_EXECUTION_INPUTS and not key.startswith("NEXUS_"):
            continue
        normalized = re.sub(r"[^a-z]", "", key.casefold())
        if any(part in normalized for part in _SENSITIVE_KEY_PARTS):
            inputs[key] = bool(value)
        else:
            inputs[key] = value
    encoded = json.dumps(inputs, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True, slots=True)
class RunEvidence:
    repo_root: InitVar[Path]
    run_id: str
    workflow: Workflow
    git_sha: str | None
    base_sha: str | None
    duration_ms: int
    peak_owned_mib: PeakOwnedMemory
    selection: tuple[Selection, ...]
    sensitivity: tuple[Sensitivity, ...]
    capabilities: tuple[CapabilityEvidence, ...]
    invocation: InvocationEvidence = field(default_factory=InvocationEvidence)

    def __post_init__(self, repo_root: Path) -> None:
        if not isinstance(self.workflow, Workflow):
            raise ValueError("workflow must be a typed Workflow")
        if not isinstance(self.invocation, InvocationEvidence):
            raise ValueError("invocation must be typed evidence")
        if not self.run_id.strip():
            raise ValueError("run id must not be blank")
        if self.git_sha is not None and re.fullmatch(r"[0-9a-f]{40}", self.git_sha) is None:
            raise ValueError("run Git SHA must be full and lowercase when resolved")
        if self.base_sha is not None and re.fullmatch(r"[0-9a-f]{40}", self.base_sha) is None:
            raise ValueError("base Git SHA must be full and lowercase")
        _nonnegative("duration", self.duration_ms)
        ids = tuple(capability.id for capability in self.capabilities)
        if len(ids) != len(set(ids)):
            raise ValueError("capability evidence ids must be unique")
        required = {
            requirement.capability for requirement in WORKFLOW_REGISTRY[self.workflow].requirements
        }
        if set(ids) != required:
            missing = sorted(capability.value for capability in required.difference(ids))
            extra = sorted(capability.value for capability in set(ids).difference(required))
            raise ValueError(f"capability evidence differs; missing={missing}, extra={extra}")
        if self.git_sha is None and self.status is RunStatus.PASS:
            raise ValueError("a passing run requires an exact Git SHA")

        selected_proofs = {item.proof for item in self.selection if item.proof is not None}
        sensitivity_by_proof = {item.proof: item for item in self.sensitivity}
        if len(sensitivity_by_proof) != len(self.sensitivity):
            raise ValueError("sensitivity proof ids must be unique")
        for item in self.sensitivity:
            if item.proof not in selected_proofs:
                raise ValueError("sensitivity must belong to a selected proof")
            selected_paths = {selection.path for selection in self.selection}
            if not set(item.changed_paths).issubset(selected_paths):
                raise ValueError("sensitivity changed paths must belong to the run selection")
            if item.proof_digest != compute_proof_digest(repo_root, item.proof, item.changed_paths):
                raise ValueError("sensitivity digest must match the selected proof contents")
            if item.green.git_sha != self.git_sha:
                raise ValueError("sensitivity green SHA must match the current run")
            if item.method.value == "base" and item.against.git_sha != self.base_sha:
                raise ValueError("sensitivity base SHA must match the current run base")
        if self.workflow is Workflow.PR:
            missing_sensitivity = [
                item.proof
                for item in self.selection
                if item.sensitivity_required and item.proof not in sensitivity_by_proof
            ]
            sensitivity_capability = next(
                item for item in self.capabilities if item.id is Capability.SENSITIVITY
            )
            if missing_sensitivity and sensitivity_capability.status is RunStatus.PASS:
                raise ValueError(
                    f"materially changed proofs lack sensitivity: {missing_sensitivity}"
                )

    @property
    def status(self) -> RunStatus:
        return aggregate_status(tuple(item.status for item in self.capabilities))


@dataclass(frozen=True, slots=True)
class ProveEvidence:
    repo_root: InitVar[Path]
    run_id: str
    proof: str
    method: SensitivityMethod
    against: str
    git_sha: str | None
    duration_ms: int
    status: RunStatus
    sensitivity: tuple[Sensitivity, ...]
    detail: str = ""
    invocation: InvocationEvidence = field(default_factory=InvocationEvidence)

    def __post_init__(self, repo_root: Path) -> None:
        if _RUN_ID.fullmatch(self.run_id) is None:
            raise ValueError("prove run id must be 16 lowercase hex characters")
        if not self.proof.strip() or not self.against.strip():
            raise ValueError("prove requires an exact proof and against target")
        if not isinstance(self.method, SensitivityMethod) or not isinstance(self.status, RunStatus):
            raise ValueError("prove method and status must be typed enums")
        if not isinstance(self.invocation, InvocationEvidence):
            raise ValueError("prove invocation must be typed evidence")
        if self.git_sha is not None and re.fullmatch(r"[0-9a-f]{40}", self.git_sha) is None:
            raise ValueError("prove Git SHA must be full and lowercase when resolved")
        _nonnegative("prove duration", self.duration_ms)
        if self.status is RunStatus.PASS:
            if self.git_sha is None or len(self.sensitivity) != 1 or self.detail:
                raise ValueError("passing prove evidence requires one result and an exact Git SHA")
            record = self.sensitivity[0]
            if record.proof != self.proof or record.green.git_sha != self.git_sha:
                raise ValueError("prove sensitivity must match its exact proof and Git SHA")
            if record.proof_digest != compute_proof_digest(
                repo_root,
                record.proof,
                record.changed_paths,
            ):
                raise ValueError("prove sensitivity digest must match current proof contents")
            if record.method is not self.method:
                raise ValueError("prove sensitivity method does not match its invocation")
            if self.method is SensitivityMethod.FAULT and record.against.fault_id != self.against:
                raise ValueError("prove fault result does not match its invocation")
        elif self.sensitivity or not self.detail.strip():
            raise ValueError(
                "unsuccessful prove evidence requires one decisive detail and no result"
            )


@dataclass(frozen=True, slots=True)
class DiagnosticRerunEvidence:
    run_id: str
    workflow: Workflow
    git_sha: str
    diagnostic_of_run_id: str
    duration_ms: int
    peak_owned_mib: PeakOwnedMemory
    capabilities: tuple[CapabilityEvidence, ...]
    invocation: InvocationEvidence = field(default_factory=InvocationEvidence)

    def __post_init__(self) -> None:
        if not isinstance(self.workflow, Workflow):
            raise ValueError("diagnostic workflow must be typed")
        if not isinstance(self.invocation, InvocationEvidence):
            raise ValueError("diagnostic invocation must be typed evidence")
        if (
            _RUN_ID.fullmatch(self.run_id) is None
            or _RUN_ID.fullmatch(self.diagnostic_of_run_id) is None
        ):
            raise ValueError("diagnostic run ids must be 16 lowercase hex characters")
        if self.run_id == self.diagnostic_of_run_id:
            raise ValueError("diagnostic and original run ids must differ")
        if re.fullmatch(r"[0-9a-f]{40}", self.git_sha) is None:
            raise ValueError("diagnostic Git SHA must be full and lowercase")
        _nonnegative("diagnostic duration", self.duration_ms)
        ids = tuple(capability.id for capability in self.capabilities)
        required = {
            requirement.capability for requirement in WORKFLOW_REGISTRY[self.workflow].requirements
        }
        if len(ids) != len(set(ids)) or set(ids) != required:
            raise ValueError("diagnostic capabilities must exactly match the original workflow")

    @property
    def status(self) -> RunStatus:
        return RunStatus.FAIL

    @property
    def diagnostic_status(self) -> RunStatus:
        return aggregate_status(tuple(item.status for item in self.capabilities))


def run_evidence_from_json(repo_root: Path, value: object) -> RunEvidence:
    payload = _exact_object(
        value,
        {
            "version",
            "run_id",
            "workflow",
            "git_sha",
            "base_sha",
            "status",
            "duration_ms",
            "peak_owned_mib",
            "invocation",
            "selection",
            "sensitivity",
            "capabilities",
        },
        "run summary",
    )
    if type(payload["version"]) is not int or payload["version"] != 2:
        raise ValueError("run summary version must be exactly 2")
    invocation = _parse_invocation(payload["invocation"])
    peak = _parse_memory(payload["peak_owned_mib"])
    selection = tuple(_parse_selection(item) for item in _list(payload["selection"], "selection"))
    sensitivity = tuple(
        _parse_sensitivity(item) for item in _list(payload["sensitivity"], "sensitivity")
    )
    capabilities = tuple(
        _parse_capability(item) for item in _list(payload["capabilities"], "capabilities")
    )
    evidence = RunEvidence(
        repo_root=repo_root,
        run_id=_string(payload["run_id"], "run id"),
        workflow=_enum(Workflow, payload["workflow"], "workflow"),
        git_sha=_optional_string(payload["git_sha"], "Git SHA"),
        base_sha=_optional_string(payload["base_sha"], "base SHA"),
        duration_ms=_integer(payload["duration_ms"], "duration"),
        peak_owned_mib=peak,
        selection=selection,
        sensitivity=sensitivity,
        capabilities=capabilities,
        invocation=invocation,
    )
    status = _enum(RunStatus, payload["status"], "status")
    if status is not evidence.status:
        raise ValueError("recorded run status does not match capability evidence")
    return evidence


def prove_evidence_from_json(repo_root: Path, value: object) -> ProveEvidence:
    payload = _exact_object(
        value,
        {
            "version",
            "command",
            "run_id",
            "proof",
            "method",
            "against",
            "git_sha",
            "status",
            "duration_ms",
            "invocation",
            "sensitivity",
            "detail",
        },
        "prove summary",
    )
    if type(payload["version"]) is not int or payload["version"] != 2:
        raise ValueError("prove summary version must be exactly 2")
    if payload["command"] != "prove":
        raise ValueError("prove summary command must be exact")
    return ProveEvidence(
        repo_root=repo_root,
        run_id=_string(payload["run_id"], "run id"),
        proof=_string(payload["proof"], "proof"),
        method=_enum(SensitivityMethod, payload["method"], "sensitivity method"),
        against=_string(payload["against"], "against target"),
        git_sha=_optional_string(payload["git_sha"], "Git SHA"),
        duration_ms=_integer(payload["duration_ms"], "duration"),
        status=_enum(RunStatus, payload["status"], "status"),
        sensitivity=tuple(
            _parse_sensitivity(item) for item in _list(payload["sensitivity"], "sensitivity")
        ),
        detail=_string(payload["detail"], "detail"),
        invocation=_parse_invocation(payload["invocation"]),
    )


def _parse_memory(value: object) -> PeakOwnedMemory:
    payload = _exact_object(
        value,
        {"process_tree_rss", "container_working_set", "total", "measurement_complete"},
        "owned memory",
    )
    measurement_complete = payload["measurement_complete"]
    if type(measurement_complete) is not bool:
        raise ValueError("memory measurement state must be boolean")
    return PeakOwnedMemory(
        _integer(payload["process_tree_rss"], "process tree RSS"),
        _integer(payload["container_working_set"], "container working set"),
        _integer(payload["total"], "total owned memory"),
        measurement_complete,
    )


def _parse_invocation(value: object) -> InvocationEvidence:
    payload = _exact_object(value, {"ui", "input_fingerprint"}, "invocation")
    ui = payload["ui"]
    if type(ui) is not bool:
        raise ValueError("invocation UI mode must be boolean")
    return InvocationEvidence(
        ui=ui,
        input_fingerprint=_string(payload["input_fingerprint"], "input fingerprint"),
    )


def _parse_selection(value: object) -> Selection:
    payload = _exact_object(
        value,
        {
            "path",
            "capability",
            "reason",
            "proof",
            "sensitivity_required",
            "deferred_to",
        },
        "selection",
    )
    sensitivity_required = payload["sensitivity_required"]
    if type(sensitivity_required) is not bool:
        raise ValueError("selection sensitivity state must be boolean")
    deferred_value = payload["deferred_to"]
    deferred = None if deferred_value is None else _enum(Workflow, deferred_value, "deferral")
    return Selection(
        _string(payload["path"], "selection path"),
        _enum(Capability, payload["capability"], "selection capability"),
        _enum(SelectionReason, payload["reason"], "selection reason"),
        _optional_string(payload["proof"], "selection proof"),
        sensitivity_required,
        deferred,
    )


def _parse_sensitivity(value: object) -> Sensitivity:
    payload = _exact_object(
        value,
        {"proof", "changed_paths", "proof_digest", "method", "against", "red", "green"},
        "sensitivity",
    )
    against = _exact_object(payload["against"], {"git_sha", "fault_id"}, "sensitivity against")
    red = _exact_object(
        payload["red"], {"status", "phase", "failure_fingerprint"}, "sensitivity red"
    )
    green = _exact_object(payload["green"], {"status", "git_sha"}, "sensitivity green")
    return Sensitivity(
        proof=_string(payload["proof"], "sensitivity proof"),
        changed_paths=tuple(
            _string(path, "sensitivity changed path")
            for path in _list(payload["changed_paths"], "sensitivity changed paths")
        ),
        proof_digest=_string(payload["proof_digest"], "sensitivity proof digest"),
        method=_enum(SensitivityMethod, payload["method"], "sensitivity method"),
        against=SensitivityAgainst(
            _optional_string(against["git_sha"], "sensitivity Git SHA"),
            _optional_string(against["fault_id"], "sensitivity fault id"),
        ),
        red=SensitivityRed(
            phase=_enum(SensitivityPhase, red["phase"], "sensitivity phase"),
            failure_fingerprint=_string(
                red["failure_fingerprint"], "sensitivity failure fingerprint"
            ),
            status=_enum(RunStatus, red["status"], "sensitivity red status"),
        ),
        green=SensitivityGreen(
            git_sha=_string(green["git_sha"], "sensitivity green Git SHA"),
            status=_enum(RunStatus, green["status"], "sensitivity green status"),
        ),
    )


def _parse_capability(value: object) -> CapabilityEvidence:
    payload = _exact_object(
        value,
        {
            "id",
            "status",
            "duration_ms",
            "peak_owned_mib",
            "provider_calls",
            "estimated_cost_usd",
            "artifacts",
            "detail",
        },
        "capability",
    )
    return CapabilityEvidence(
        id=_enum(Capability, payload["id"], "capability id"),
        status=_enum(RunStatus, payload["status"], "capability status"),
        duration_ms=_integer(payload["duration_ms"], "capability duration"),
        peak_owned_mib=_integer(payload["peak_owned_mib"], "capability memory"),
        provider_calls=_integer(payload["provider_calls"], "provider calls"),
        estimated_cost_usd=_number(payload["estimated_cost_usd"], "estimated provider cost"),
        artifacts=tuple(
            _string(item, "capability artifact")
            for item in _list(payload["artifacts"], "capability artifacts")
        ),
        detail=_string(payload["detail"], "capability detail"),
    )


def _exact_object(value: object, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ValueError(f"{label} must be an object")
    if set(value) != keys:
        raise ValueError(f"{label} fields differ; expected={sorted(keys)}, actual={sorted(value)}")
    return value


def _list(value: object, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{label} must be an array")
    return value


def _string(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string")
    return value


def _optional_string(value: object, label: str) -> str | None:
    return None if value is None else _string(value, label)


def _integer(value: object, label: str) -> int:
    if type(value) is not int:
        raise ValueError(f"{label} must be an integer")
    return value


def _number(value: object, label: str) -> int | float:
    if type(value) not in {int, float}:
        raise ValueError(f"{label} must be numeric")
    return value  # type: ignore[return-value]  # justify-type-assertion: exact runtime type is narrowed above.


def _enum(enum_type: type[Any], value: object, label: str) -> Any:
    raw = _string(value, label)
    try:
        return enum_type(raw)
    except ValueError as error:
        raise ValueError(f"{label} is unknown: {raw}") from error


def compute_proof_digest(repo_root: Path, proof: str, changed_paths: tuple[str, ...]) -> str:
    root = repo_root.resolve(strict=True)
    runner, separator, node = proof.partition(":")
    proof_path = node.split("::", 1)[0]
    if not separator or not runner or not proof_path:
        raise ValueError("proof id must be runner-qualified")
    digest = hashlib.sha256()
    digest.update(proof.encode())
    digest.update(b"\0")
    for relative in sorted({proof_path, *changed_paths}):
        path = (root / relative).resolve(strict=True)
        try:
            canonical_relative = path.relative_to(root).as_posix()
        except ValueError as error:
            raise ValueError("proof digest path must remain inside the repository") from error
        if not path.is_file() or canonical_relative != relative:
            raise ValueError("proof digest inputs must be exact repository files")
        contents = path.read_bytes()
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative.encode())
        digest.update(len(contents).to_bytes(8, "big"))
        digest.update(contents)
    return digest.hexdigest()


def redact_text(value: str, secrets: Iterable[str] = ()) -> str:
    redacted = value
    for secret in sorted({secret for secret in secrets if secret}, key=len, reverse=True):
        redacted = redacted.replace(secret, REDACTED)
    return _BEARER.sub(f"Bearer {REDACTED}", redacted)


def redact_json(value: JsonValue, secrets: Iterable[str] = ()) -> JsonValue:
    secret_values = tuple(secrets)
    if isinstance(value, dict):
        redacted: dict[str, JsonValue] = {}
        for key, item in value.items():
            normalized_key = re.sub(r"[^a-z]", "", key.casefold())
            if any(part in normalized_key for part in _SENSITIVE_KEY_PARTS) or normalized_key in {
                "argv",
                "env",
            }:
                redacted[key] = REDACTED
            else:
                redacted[key] = redact_json(item, secret_values)
        return redacted
    if isinstance(value, list):
        return [redact_json(item, secret_values) for item in value]
    if isinstance(value, str):
        return redact_text(value, secret_values)
    return value


def _sensitivity_json(sensitivity: Sensitivity) -> dict[str, JsonValue]:
    return {
        "proof": sensitivity.proof,
        "changed_paths": list(sensitivity.changed_paths),
        "proof_digest": sensitivity.proof_digest,
        "method": sensitivity.method.value,
        "against": {
            "git_sha": sensitivity.against.git_sha,
            "fault_id": sensitivity.against.fault_id,
        },
        "red": {
            "status": sensitivity.red.status.value,
            "phase": sensitivity.red.phase.value,
            "failure_fingerprint": sensitivity.red.failure_fingerprint,
        },
        "green": {
            "status": sensitivity.green.status.value,
            "git_sha": sensitivity.green.git_sha,
        },
    }


def _memory_json(memory: PeakOwnedMemory) -> dict[str, JsonValue]:
    return {
        "process_tree_rss": memory.process_tree_rss,
        "container_working_set": memory.container_working_set,
        "total": memory.total,
        "measurement_complete": memory.measurement_complete,
    }


def _capabilities_json(
    capabilities: tuple[CapabilityEvidence, ...],
) -> list[JsonValue]:
    return [
        {
            "id": capability.id.value,
            "status": capability.status.value,
            "duration_ms": capability.duration_ms,
            "peak_owned_mib": capability.peak_owned_mib,
            "provider_calls": capability.provider_calls,
            "estimated_cost_usd": capability.estimated_cost_usd,
            "artifacts": list(capability.artifacts),
            "detail": capability.detail,
        }
        for capability in capabilities
    ]


def evidence_json(evidence: RunEvidence, secrets: Iterable[str] = ()) -> dict[str, JsonValue]:
    payload: dict[str, JsonValue] = {
        "version": 2,
        "run_id": evidence.run_id,
        "workflow": evidence.workflow.value,
        "git_sha": evidence.git_sha,
        "base_sha": evidence.base_sha,
        "status": evidence.status.value,
        "duration_ms": evidence.duration_ms,
        "peak_owned_mib": _memory_json(evidence.peak_owned_mib),
        "invocation": {
            "ui": evidence.invocation.ui,
            "input_fingerprint": evidence.invocation.input_fingerprint,
        },
        "selection": [
            {
                "path": selection.path,
                "capability": selection.capability.value,
                "reason": selection.reason.value,
                "proof": selection.proof,
                "sensitivity_required": selection.sensitivity_required,
                "deferred_to": (
                    selection.deferred_to.value if selection.deferred_to is not None else None
                ),
            }
            for selection in evidence.selection
        ],
        "sensitivity": [_sensitivity_json(item) for item in evidence.sensitivity],
        "capabilities": _capabilities_json(evidence.capabilities),
    }
    return redact_json(payload, secrets)  # type: ignore[return-value]  # justify-type-assertion: payload is a JSON object and redaction preserves its outer shape.


def prove_evidence_json(
    evidence: ProveEvidence, secrets: Iterable[str] = ()
) -> dict[str, JsonValue]:
    payload: dict[str, JsonValue] = {
        "version": 2,
        "command": "prove",
        "run_id": evidence.run_id,
        "proof": evidence.proof,
        "method": evidence.method.value,
        "against": evidence.against,
        "git_sha": evidence.git_sha,
        "status": evidence.status.value,
        "duration_ms": evidence.duration_ms,
        "invocation": {
            "ui": evidence.invocation.ui,
            "input_fingerprint": evidence.invocation.input_fingerprint,
        },
        "sensitivity": [_sensitivity_json(item) for item in evidence.sensitivity],
        "detail": evidence.detail,
    }
    redacted = redact_json(payload, secrets)
    if not isinstance(redacted, dict):
        raise AssertionError("prove evidence redaction changed the object shape")
    redacted["command"] = "prove"
    return redacted


def write_evidence_json(path: Path, payload: Mapping[str, JsonValue]) -> None:
    """Publish one complete evidence object without overwriting an existing record."""
    if not path.parent.is_dir():
        raise ValueError("evidence directory is absent")
    temporary: Path | None = None
    directory_fd: int | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            delete=False,
        ) as target:
            temporary = Path(target.name)
            json.dump(payload, target, indent=2, sort_keys=True)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.link(temporary, path)
        temporary.unlink()
        temporary = None
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        os.fsync(directory_fd)
    except OSError as error:
        raise ValueError(f"evidence could not be published: {path}") from error
    finally:
        if directory_fd is not None:
            os.close(directory_fd)
        if temporary is not None and temporary.exists():
            temporary.unlink()


def diagnostic_evidence_json(
    evidence: DiagnosticRerunEvidence, secrets: Iterable[str] = ()
) -> dict[str, JsonValue]:
    original_summary = (
        PurePosixPath("test-results/runs") / evidence.diagnostic_of_run_id / "summary.json"
    )
    payload: dict[str, JsonValue] = {
        "version": 2,
        "command": "diagnose",
        "run_id": evidence.run_id,
        "workflow": evidence.workflow.value,
        "git_sha": evidence.git_sha,
        "status": evidence.status.value,
        "invocation": {
            "ui": evidence.invocation.ui,
            "input_fingerprint": evidence.invocation.input_fingerprint,
        },
        "diagnostic_of": {
            "run_id": evidence.diagnostic_of_run_id,
            "status": RunStatus.FAIL.value,
            "summary": original_summary.as_posix(),
        },
        "diagnostic_result": {
            "status": evidence.diagnostic_status.value,
            "duration_ms": evidence.duration_ms,
            "peak_owned_mib": _memory_json(evidence.peak_owned_mib),
            "capabilities": _capabilities_json(evidence.capabilities),
        },
    }
    redacted = redact_json(payload, secrets)
    if not isinstance(redacted, dict):
        raise AssertionError("diagnostic evidence redaction changed the object shape")
    redacted["command"] = "diagnose"
    return redacted
