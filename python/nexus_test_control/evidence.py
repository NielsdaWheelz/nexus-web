import hashlib
import math
import re
from collections.abc import Iterable
from dataclasses import InitVar, dataclass
from pathlib import Path, PurePosixPath

from nexus_test_control.model import (
    WORKFLOW_REGISTRY,
    Capability,
    RunStatus,
    Selection,
    Sensitivity,
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
class RunEvidence:
    repo_root: InitVar[Path]
    run_id: str
    workflow: Workflow
    git_sha: str
    base_sha: str | None
    duration_ms: int
    peak_owned_mib: PeakOwnedMemory
    selection: tuple[Selection, ...]
    sensitivity: tuple[Sensitivity, ...]
    capabilities: tuple[CapabilityEvidence, ...]

    def __post_init__(self, repo_root: Path) -> None:
        if not isinstance(self.workflow, Workflow):
            raise ValueError("workflow must be a typed Workflow")
        if not self.run_id.strip() or re.fullmatch(r"[0-9a-f]{40}", self.git_sha) is None:
            raise ValueError("run id must not be blank and git SHA must be full and lowercase")
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
            if missing_sensitivity:
                raise ValueError(
                    f"materially changed proofs lack sensitivity: {missing_sensitivity}"
                )

    @property
    def status(self) -> RunStatus:
        return aggregate_status(tuple(item.status for item in self.capabilities))


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


def evidence_json(evidence: RunEvidence, secrets: Iterable[str] = ()) -> dict[str, JsonValue]:
    payload: dict[str, JsonValue] = {
        "version": 1,
        "run_id": evidence.run_id,
        "workflow": evidence.workflow.value,
        "git_sha": evidence.git_sha,
        "base_sha": evidence.base_sha,
        "status": evidence.status.value,
        "duration_ms": evidence.duration_ms,
        "peak_owned_mib": {
            "process_tree_rss": evidence.peak_owned_mib.process_tree_rss,
            "container_working_set": evidence.peak_owned_mib.container_working_set,
            "total": evidence.peak_owned_mib.total,
            "measurement_complete": evidence.peak_owned_mib.measurement_complete,
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
        "capabilities": [
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
            for capability in evidence.capabilities
        ],
    }
    return redact_json(payload, secrets)  # type: ignore[return-value]  # justify-type-assertion: payload is a JSON object and redaction preserves its outer shape.
