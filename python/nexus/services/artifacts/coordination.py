"""Per-step replay coordination for a dossier build (CP2-TYPES, CONTRACTS.md
A8/B4).

The dossier durable op runs on the Postgres job queue (``nexus.jobs.queue``),
NOT a generalized coordination kernel. A build performs one provider step per
reduction node (usually a single ``synthesis``); each step carries a
replay-stable coordination record persisted *inside the job payload* and
checkpointed through the lease-fenced CAS ``update_running_job_payload``.

This module owns the closed dispatch-phase machine, the per-step record, and the
thin payload read/write primitives. It does NOT run the orchestration — the
engine (CP2-ENGINE) sequences Prepared -> commit Uncertain -> dispatch -> commit
Completed, with NO network call inside a database transaction.

Replay semantics the engine implements on top of these types:
- ``Prepared`` / absent: may dispatch (commit ``Uncertain`` first).
- ``Completed``: reuse the memoized ``terminal_result``; never re-dispatch.
- ``Uncertain`` on replay: with no provider idempotency/reconciliation key, a
  billed call is NEVER auto-repeated -> defect for the operator (Suspended).
"""

from __future__ import annotations

from enum import StrEnum
from typing import Final
from uuid import UUID, uuid5

from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from nexus.jobs.queue import JobExecutionContext, JobRow, update_running_job_payload
from nexus.schemas.presence import Presence

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


# Stable namespace for deterministic per-step generation ids.
_GENERATION_NAMESPACE: Final = UUID("6f1d3f2e-6a3b-5c7d-8e9f-0a1b2c3d4e5f")

# The single JSON key under which per-step records live in the job payload.
_COORDINATION_KEY: Final = "coordination"


def stable_generation_id(build_id: UUID, step_path: str) -> UUID:
    """The replay-stable generation id for a step (uuid5 over build + path)."""
    return uuid5(_GENERATION_NAMESPACE, f"{build_id}:{step_path}")


def read_step_states(job: JobRow) -> dict[str, StepReplayState]:
    """Decode every persisted per-step record from a claimed job row's payload.

    The map is keyed by structural step path; an absent key is an unstarted step
    (membership is the presence check — no ambiguous ``None`` is manufactured)."""
    raw = job.payload.get(_COORDINATION_KEY) or {}
    return {path: StepReplayState.model_validate(record) for path, record in raw.items()}


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
    coordination = dict(job.payload.get(_COORDINATION_KEY) or {})
    coordination[step_path] = state.model_dump(mode="json")
    return update_running_job_payload(
        db,
        job_id=ctx.job_id,
        worker_id=ctx.worker_id,
        attempt_no=ctx.attempt_no,
        payload={**job.payload, _COORDINATION_KEY: coordination},
    )
