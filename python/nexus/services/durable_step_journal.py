"""Owner-neutral replay state for queue-backed durable operation steps.

The queue payload is the storage adapter for this small state machine. This
module owns its strict state, codec, stable identity, lease-fenced checkpoint,
and execution-phase projection. It runs no domain step.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Final, Self
from uuid import UUID, uuid5

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
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


class ToolExecutionIdentity(BaseModel):
    """Immutable identity of one tool invocation at a durable position."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    tool_id: str
    tool_contract_revision: str
    policy_revision: str
    plan_revision: str
    input_digest: str
    replay_policy: ReplayPolicy

    @model_validator(mode="after")
    def validate_identity(self) -> Self:
        from llm_tools import ToolId

        try:
            ToolId(self.tool_id)
        except ValueError as exc:
            raise ValueError("tool execution identity has an invalid tool id") from exc
        revisions = (
            self.tool_contract_revision,
            self.policy_revision,
            self.plan_revision,
        )
        if any(not _is_sha256(value) for value in revisions):
            raise ValueError("tool execution revisions must be lowercase sha256")
        if not _is_sha256(self.input_digest):
            raise ValueError("tool execution input digest must be lowercase sha256")
        return self


class ToolExecutionReservation(BaseModel):
    """The immutable per-position budget reservation and its decision."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    calls: int
    input_bytes: int
    max_attempts: int
    max_output_bytes: int
    accepted: bool

    @model_validator(mode="after")
    def validate_reservation(self) -> Self:
        if self.calls != 1:
            raise ValueError("tool execution reserves exactly one call")
        if self.input_bytes < 0:
            raise ValueError("tool execution input bytes must not be negative")
        if self.max_attempts < 0:
            raise ValueError("tool execution max attempts must not be negative")
        if self.max_output_bytes <= 0:
            raise ValueError("tool execution output limit must be positive")
        return self


class ToolExecutionSettlement(BaseModel):
    """Actual usage committed with one terminal tool result."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    actual_attempts: int
    actual_output_bytes: int

    @model_validator(mode="after")
    def validate_settlement(self) -> Self:
        if self.actual_attempts < 0 or self.actual_output_bytes < 0:
            raise ValueError("tool execution settlement must not be negative")
        return self


class ToolDispatchClaim(BaseModel):
    """Queue-attempt identity that durably owns an in-flight dispatch."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    worker_id: str = Field(min_length=1)
    attempt_no: int = Field(ge=1)


class ToolExecutionState(BaseModel):
    """Strict tool-only state embedded in the shared step journal."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    identity: ToolExecutionIdentity
    reservation: Presence[ToolExecutionReservation] = Absent()
    settlement: Presence[ToolExecutionSettlement] = Absent()
    dispatch_claim: Presence[ToolDispatchClaim] = Absent()
    abandoned_attempts: int = 0

    @model_validator(mode="after")
    def validate_accounting(self) -> Self:
        if self.abandoned_attempts < 0:
            raise ValueError("abandoned tool attempts must not be negative")
        if isinstance(self.reservation, Present):
            reservation = self.reservation.value
            if self.abandoned_attempts > reservation.max_attempts:
                raise ValueError("abandoned tool attempts exceed the reservation")
            if isinstance(self.settlement, Present):
                settlement = self.settlement.value
                if settlement.actual_attempts < self.abandoned_attempts:
                    raise ValueError("settled attempts omit abandoned attempts")
                if settlement.actual_attempts > reservation.max_attempts:
                    raise ValueError("settled attempts exceed the reservation")
                if settlement.actual_output_bytes > reservation.max_output_bytes:
                    raise ValueError("settled output exceeds the reservation")
            if not reservation.accepted:
                if self.abandoned_attempts != 0:
                    raise ValueError("rejected reservation cannot have abandoned attempts")
                if isinstance(self.dispatch_claim, Present):
                    raise ValueError("rejected reservation cannot have a dispatch claim")
                if isinstance(self.settlement, Present) and (
                    self.settlement.value.actual_attempts != 0
                    or self.settlement.value.actual_output_bytes != 0
                ):
                    raise ValueError("rejected reservation must settle zero usage")
        else:
            if self.abandoned_attempts != 0:
                raise ValueError("abandoned tool attempts require a reservation")
            if isinstance(self.settlement, Present):
                raise ValueError("tool settlement requires a reservation")
            if isinstance(self.dispatch_claim, Present):
                raise ValueError("tool dispatch claim requires a reservation")
        return self


class StepReplayState(BaseModel):
    """One step's strict coordination record in an owner payload."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    generation_id: UUID
    dispatch_phase: DispatchPhase
    request_fingerprint: Presence[str]
    terminal_result: Presence[str]
    tool_execution: Presence[ToolExecutionState] = Absent()

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
        if isinstance(self.tool_execution, Present):
            tool_execution = self.tool_execution.value
            assert isinstance(self.request_fingerprint, Present)
            if self.request_fingerprint.value != tool_execution.identity.input_digest:
                raise ValueError("tool request fingerprint differs from its input digest")
            if self.dispatch_phase is Prepared:
                if isinstance(tool_execution.settlement, Present):
                    raise ValueError("Prepared tool execution cannot have a settlement")
                if isinstance(tool_execution.dispatch_claim, Present):
                    raise ValueError("Prepared tool execution cannot have a dispatch claim")
            elif self.dispatch_phase is Uncertain:
                if not isinstance(tool_execution.reservation, Present):
                    raise ValueError("Uncertain tool execution requires a reservation")
                if not tool_execution.reservation.value.accepted:
                    raise ValueError("Uncertain tool execution requires an accepted reservation")
                if isinstance(tool_execution.settlement, Present):
                    raise ValueError("Uncertain tool execution cannot have a settlement")
                if not isinstance(tool_execution.dispatch_claim, Present):
                    raise ValueError("Uncertain tool execution requires a dispatch claim")
            elif self.dispatch_phase is Completed:
                if not isinstance(tool_execution.reservation, Present):
                    raise ValueError("Completed tool execution requires a reservation")
                if not isinstance(tool_execution.settlement, Present):
                    raise ValueError("Completed tool execution requires a settlement")
                if isinstance(tool_execution.dispatch_claim, Present):
                    raise ValueError("Completed tool execution cannot have a dispatch claim")
                assert isinstance(self.terminal_result, Present)
                if (
                    tool_execution.reservation.value.accepted
                    and tool_execution.settlement.value.actual_output_bytes
                    != len(self.terminal_result.value.encode("utf-8"))
                ):
                    raise ValueError("settled tool output differs from terminal UTF-8 length")
        return self


def _is_sha256(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)


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
    excluded = {"tool_execution"} if isinstance(validated.tool_execution, Absent) else None
    coordination[step_path] = validated.model_dump(mode="json", exclude=excluded)
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
