"""Owner-neutral replay state for queue-backed durable operation steps.

The queue payload is the storage adapter for this small state machine. This
module owns its strict state, codec, stable identity, lease-fenced checkpoint,
and execution-phase projection. It runs no domain step.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Final, Self
from uuid import UUID, uuid5

from pydantic import BaseModel, ConfigDict, ValidationError, model_validator
from sqlalchemy.orm import Session

from nexus.jobs.queue import (
    DEAD,
    FAILED,
    PENDING,
    RUNNING,
    SUCCEEDED,
    JobExecutionContext,
    JobRow,
    update_running_job_payload,
)
from nexus.schemas.presence import Absent, Presence, Present


class DispatchPhase(StrEnum):
    """The durable commit points of one externally effectful step."""

    Prepared = "Prepared"
    Uncertain = "Uncertain"
    Completed = "Completed"


Prepared: Final = DispatchPhase.Prepared
Uncertain: Final = DispatchPhase.Uncertain
Completed: Final = DispatchPhase.Completed


class ReplayPolicy(StrEnum):
    """Whether an interrupted uncertain step may safely dispatch again."""

    BilledOnce = "BilledOnce"
    ReDispatchable = "ReDispatchable"


class DurableExecutionPhase(StrEnum):
    """Advisory liveness projected from one live durable queue job."""

    Queued = "Queued"
    Running = "Running"
    Recovering = "Recovering"
    Suspended = "Suspended"


class StepReplayState(BaseModel):
    """One step's strict coordination record in an owner payload."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    generation_id: UUID
    dispatch_phase: DispatchPhase
    request_fingerprint: Presence[str]
    terminal_result: Presence[str]

    @model_validator(mode="after")
    def validate_phase_fields(self) -> Self:
        if isinstance(self.request_fingerprint, Absent):
            raise ValueError("durable step request fingerprint must be present")
        if self.dispatch_phase is Completed:
            if isinstance(self.terminal_result, Absent):
                raise ValueError("Completed durable step must have a terminal result")
        elif isinstance(self.terminal_result, Present):
            raise ValueError(
                f"{self.dispatch_phase.value} durable step cannot have a terminal result"
            )
        return self


class ProveNotDispatched(BaseModel):
    """Operator evidence that an uncertain request never reached its provider."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class AttachReconciledResult(BaseModel):
    """An out-of-band result normalized by the owning step binding."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    terminal_result: str


UncertainStepResolution = ProveNotDispatched | AttachReconciledResult


_GENERATION_NAMESPACE: Final = UUID("6f1d3f2e-6a3b-5c7d-8e9f-0a1b2c3d4e5f")
_COORDINATION_KEY: Final = "coordination"


def stable_generation_id(operation_id: UUID, step_path: str) -> UUID:
    """Return the replay-stable UUID for one operation step."""
    return uuid5(_GENERATION_NAMESPACE, f"{operation_id}:{step_path}")


def read_step_states(job: JobRow) -> dict[str, StepReplayState]:
    """Decode every persisted per-step record from a claimed job row."""
    return decode_step_states(job.payload)


def decode_step_states(payload: dict[str, object]) -> dict[str, StepReplayState]:
    """Decode one owner payload's coordination map, failing closed."""
    raw = payload.get(_COORDINATION_KEY, {})
    if not isinstance(raw, dict):
        raise AssertionError("Durable step journal payload must be an object")
    return {str(path): StepReplayState.model_validate(record) for path, record in raw.items()}


def payload_with_step_state(
    payload: dict[str, object],
    *,
    step_path: str,
    state: StepReplayState,
) -> dict[str, object]:
    """Return one owner payload with an exact updated coordination record."""
    if not step_path or step_path.startswith("/") or step_path.endswith("/"):
        raise ValueError("Durable step path must be a non-empty relative path")
    raw = payload.get(_COORDINATION_KEY, {})
    if not isinstance(raw, dict):
        raise AssertionError("Durable step journal payload must be an object")
    coordination: dict[str, object] = {str(path): record for path, record in raw.items()}
    validated = StepReplayState.model_validate(state.model_dump(mode="python"))
    coordination[step_path] = validated.model_dump(mode="json")
    return {**payload, _COORDINATION_KEY: coordination}


def encode_step_result(result: BaseModel) -> str:
    """Encode one strict step-owned result into the shared string envelope."""
    return result.model_dump_json()


def decode_step_result[T: BaseModel](raw: str, schema: type[T]) -> T:
    """Decode a completed envelope with its step-owned strict schema."""
    try:
        return schema.model_validate_json(raw)
    except ValidationError as exc:
        raise AssertionError(
            f"Completed durable step has malformed {schema.__name__} result"
        ) from exc


def checkpoint_step_state(
    db: Session,
    *,
    ctx: JobExecutionContext,
    job: JobRow,
    step_path: str,
    state: StepReplayState,
) -> bool:
    """Lease-fenced durable write of one step record into the job payload."""
    return update_running_job_payload(
        db,
        job_id=ctx.job_id,
        worker_id=ctx.worker_id,
        attempt_no=ctx.attempt_no,
        payload=payload_with_step_state(
            job.payload,
            step_path=step_path,
            state=state,
        ),
    )


def project_execution_phase(
    *,
    job_status: str,
    attempts: int,
    error_code: str | None,
) -> DurableExecutionPhase:
    """Strictly project one non-succeeded queue job into advisory liveness.

    Product owners classify a missing or succeeded job against their own domain
    row before calling this shared projection.
    """
    if attempts < 0:
        raise AssertionError(f"durable job {job_status!r} has negative attempts {attempts}")
    has_failure_history = error_code is not None
    if job_status == PENDING:
        return (
            DurableExecutionPhase.Recovering
            if has_failure_history
            else DurableExecutionPhase.Queued
        )
    if job_status == RUNNING:
        if attempts < 1:
            raise AssertionError("running durable job has no claimed attempt")
        return (
            DurableExecutionPhase.Running
            if attempts == 1 and not has_failure_history
            else DurableExecutionPhase.Recovering
        )
    if job_status == FAILED:
        if attempts < 1:
            raise AssertionError("failed durable job has no completed attempt")
        return DurableExecutionPhase.Recovering
    if job_status == DEAD:
        if attempts < 1:
            raise AssertionError("dead durable job has no completed attempt")
        return DurableExecutionPhase.Suspended
    if job_status == SUCCEEDED:
        raise AssertionError("succeeded durable job has no active execution phase")
    raise AssertionError(f"unknown durable job status {job_status!r}")
