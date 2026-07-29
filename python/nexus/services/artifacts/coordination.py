"""Owner-neutral per-step replay state for durable Dossier work.

The queue job and Learn request stores are adapters for the same small state
machine.  This module owns the strict state/codec and the queue adapter only; it
does not run research or synthesis and is not a generalized workflow framework.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Final
from uuid import UUID, uuid5

from pydantic import BaseModel, ConfigDict, ValidationError
from sqlalchemy.orm import Session
from web_search_tool.types import WebSearchProvider

from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    update_running_job_payload,
)
from nexus.schemas.presence import Presence
from nexus.services.llm_execution import ExecutionRuntime

# ---------------------------------------------------------------------------
# Dispatch-phase machine (distinct from the DossierBuildExecutionPhase advisory).
# ---------------------------------------------------------------------------


class DispatchPhase(StrEnum):
    """The commit points of one provider step. Ordering is the commit order:
    ``Prepared`` (may dispatch) -> ``Uncertain`` (committed immediately before the
    network call) -> ``Completed`` (committed after the response)."""

    Prepared = "Prepared"
    Uncertain = "Uncertain"
    Completed = "Completed"


# Re-exported members: the coordination surface names the phases directly.
Prepared: Final = DispatchPhase.Prepared
Uncertain: Final = DispatchPhase.Uncertain
Completed: Final = DispatchPhase.Completed


class ReplayPolicy(StrEnum):
    """Whether an interrupted uncertain step may safely dispatch again."""

    BilledOnce = "BilledOnce"
    ReDispatchable = "ReDispatchable"


# ---------------------------------------------------------------------------
# Per-step replay record (A8) — stored in the job payload, not a dossier table.
# ---------------------------------------------------------------------------


class StepReplayState(BaseModel):
    """One provider step's coordination record.

    ``generation_id`` is replay-stable (deterministic from ``(build_id, step_path)``
    — see :func:`stable_generation_id`), NOT the ledger's ``uuid4`` (the LLM ledger
    stays billing/provenance, memoization is this record). ``request_fingerprint``
    is captured when ``Uncertain`` is committed pre-dispatch; ``terminal_result``
    is the normalized accepted output memoized at ``Completed`` for replay reuse."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    generation_id: UUID
    dispatch_phase: DispatchPhase
    request_fingerprint: Presence[str]
    terminal_result: Presence[str]


class ProveNotDispatched(BaseModel):
    """Operator evidence that the uncertain request never reached the provider."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class AttachReconciledResult(BaseModel):
    """A provider result recovered out of band and normalized by the binding."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    terminal_result: str


UncertainStepResolution = ProveNotDispatched | AttachReconciledResult


class DossierResearchPending(Exception):
    """A durable dependency is pending; the job should yield until ``available_at``."""

    def __init__(self, available_at: datetime) -> None:
        super().__init__("Dossier research dependency is pending")
        self.available_at = available_at


# Stable namespace for deterministic per-step generation ids.
_GENERATION_NAMESPACE: Final = UUID("6f1d3f2e-6a3b-5c7d-8e9f-0a1b2c3d4e5f")

# The single JSON key under which per-step records live in the job payload.
_COORDINATION_KEY: Final = "coordination"
_REQUEUE_CADENCE: Final = timedelta(seconds=5)


def stable_generation_id(build_id: UUID, step_path: str) -> UUID:
    """The replay-stable generation id for a step (uuid5 over build + path)."""
    return uuid5(_GENERATION_NAMESPACE, f"{build_id}:{step_path}")


def read_step_states(job: JobRow) -> dict[str, StepReplayState]:
    """Decode every persisted per-step record from a claimed job row."""
    return decode_step_states(job.payload)


def decode_step_states(payload: dict[str, object]) -> dict[str, StepReplayState]:
    """Decode the coordination map from any owner store, failing closed."""
    raw = payload.get(_COORDINATION_KEY, {})
    if not isinstance(raw, dict):
        raise AssertionError("Dossier coordination payload must be an object")
    return {str(path): StepReplayState.model_validate(record) for path, record in raw.items()}


def payload_with_step_state(
    payload: dict[str, object],
    *,
    step_path: str,
    state: StepReplayState,
) -> dict[str, object]:
    """Return one owner payload with an exact updated coordination record."""
    if not step_path or step_path.startswith("/") or step_path.endswith("/"):
        raise ValueError("Dossier step path must be a non-empty relative path")
    raw = payload.get(_COORDINATION_KEY, {})
    if not isinstance(raw, dict):
        raise AssertionError("Dossier coordination payload must be an object")
    coordination: dict[str, object] = {str(path): record for path, record in raw.items()}
    coordination[step_path] = state.model_dump(mode="json")
    return {**payload, _COORDINATION_KEY: coordination}


def encode_step_result(result: BaseModel) -> str:
    """Encode one strict step-owned result into the shared terminal envelope."""
    return result.model_dump_json()


def decode_step_result[T: BaseModel](raw: str, schema: type[T]) -> T:
    """Decode a completed terminal envelope with its step-owned strict schema."""
    try:
        return schema.model_validate_json(raw)
    except ValidationError as exc:
        raise AssertionError(
            f"Completed Dossier step has malformed {schema.__name__} result"
        ) from exc


def checkpoint_step_state(
    db: Session,
    *,
    ctx: JobExecutionContext,
    job: JobRow,
    step_path: str,
    state: StepReplayState,
) -> bool:
    """Lease-fenced durable write of one step's record into the job payload.

    Merges ``state`` under ``payload[coordination][step_path]`` and CAS-writes via
    :func:`nexus.jobs.queue.update_running_job_payload` (only lands for the exact
    running attempt/claimant with an unexpired lease). Returns ``False`` when the
    lease was lost mid-checkpoint — the caller aborts so a reclaim redoes it."""
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


@dataclass(slots=True)
class DossierBuildRuntime:
    """The exact durable capabilities available to a Dossier binding."""

    build_id: UUID
    artifact_id: UUID
    job: JobRow
    execution_context: JobExecutionContext
    llm_runtime: ExecutionRuntime
    web_search_provider: Presence[WebSearchProvider]

    def read_step(
        self,
        path: str,
        replay_policy: ReplayPolicy,
    ) -> StepReplayState | None:
        expected_policy = (
            ReplayPolicy.ReDispatchable if path.startswith("research/") else ReplayPolicy.BilledOnce
        )
        if replay_policy is not expected_policy:
            raise AssertionError(f"Dossier step {path!r} changed replay policy")
        state = read_step_states(self.job).get(path)
        return state

    def checkpoint_step(
        self,
        db: Session,
        *,
        path: str,
        state: StepReplayState,
    ) -> bool:
        landed = checkpoint_step_state(
            db,
            ctx=self.execution_context,
            job=self.job,
            step_path=path,
            state=state,
        )
        if landed:
            self.job = replace(
                self.job,
                payload=payload_with_step_state(
                    self.job.payload,
                    step_path=path,
                    state=state,
                ),
            )
        return landed

    def yield_until(self, deadline: datetime) -> None:
        """Yield on the queue's fixed cadence, bounded by an absolute deadline."""
        # justify-polling: Web Article ingestion exposes durable ready state but no
        # completion subscription, so page readiness is observed by requeueing on the
        # queue's fixed _REQUEUE_CADENCE (five seconds). Each observation is one
        # ReDispatchable step and the absolute ten-minute-from-acceptance deadline
        # terminates the loop, so no worker ever busy-polls.
        now = datetime.now(UTC)
        # If the clock crosses the deadline after the readiness observation,
        # yield immediately once; the next observation owns the modeled
        # Deadline omission. A scheduler timing race must not become a defect.
        raise DossierResearchPending(
            now if now >= deadline else min(deadline, now + _REQUEUE_CADENCE)
        )
