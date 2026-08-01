"""Derived execution liveness for queue-backed chat runs.

The run owns product state; its one ``chat_run:{id}`` queue row owns execution
liveness. This adapter correlates those owners in one batched read and delegates
the queue-state mapping to the durable-step journal kernel.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.execution import DurableExecutionOut
from nexus.schemas.presence import Presence, absent, present
from nexus.services.durable_step_journal import (
    DurableExecutionPhase,
    project_execution_phase,
)

_CHAT_RUN_JOB_KIND = "chat_run"
_TERMINAL_RUN_STATUSES = frozenset({"complete", "error", "cancelled"})
_NONTERMINAL_RUN_STATUSES = frozenset({"queued", "running"})


@dataclass(frozen=True, slots=True)
class _JobState:
    kind: str
    dedupe_key: str
    status: str
    attempts: int
    error_code: str | None


def _dedupe_key(run_id: UUID) -> str:
    return f"chat_run:{run_id}"


def project_chat_run_executions(
    db: Session,
    runs: Sequence[ChatRun],
) -> dict[UUID, Presence[DurableExecutionOut]]:
    """Project many run/job pairs with one queue query.

    Terminal runs never require a retained queue row. Every nonterminal run
    requires exactly one correctly-kind-ed row; absence, duplication, a foreign
    kind, or an impossible queue state is a correlation defect.
    """
    out: dict[UUID, Presence[DurableExecutionOut]] = {}
    live_by_key: dict[str, ChatRun] = {}
    seen_run_ids: set[UUID] = set()
    for run in runs:
        if run.id in seen_run_ids:
            raise AssertionError(f"Duplicate chat run projection input: {run.id}")
        seen_run_ids.add(run.id)
        if run.status in _TERMINAL_RUN_STATUSES:
            out[run.id] = absent()
            continue
        if run.status not in _NONTERMINAL_RUN_STATUSES:
            raise AssertionError(f"Unknown nonterminal chat run status: {run.status}")
        live_by_key[_dedupe_key(run.id)] = run

    if not live_by_key:
        return out

    rows = db.execute(
        text(
            "SELECT kind, dedupe_key, status, attempts, error_code "
            "FROM background_jobs WHERE dedupe_key = ANY(:dedupe_keys)"
        ),
        {"dedupe_keys": list(live_by_key)},
    ).mappings()
    jobs_by_key: dict[str, _JobState] = {}
    for row in rows:
        dedupe_key = str(row["dedupe_key"])
        if dedupe_key not in live_by_key:
            raise AssertionError(f"Unexpected chat run queue correlation: {dedupe_key}")
        if dedupe_key in jobs_by_key:
            raise AssertionError(f"Duplicate chat run queue job: {dedupe_key}")
        job = _JobState(
            kind=str(row["kind"]),
            dedupe_key=dedupe_key,
            status=str(row["status"]),
            attempts=int(row["attempts"]),
            error_code=(str(row["error_code"]) if row["error_code"] is not None else None),
        )
        if job.kind != _CHAT_RUN_JOB_KIND:
            raise AssertionError(f"Chat run queue correlation has kind {job.kind!r}: {dedupe_key}")
        jobs_by_key[dedupe_key] = job

    for dedupe_key, run in live_by_key.items():
        job = jobs_by_key.get(dedupe_key)
        if job is None:
            raise AssertionError(f"Nonterminal chat run has no queue job: {run.id}")
        phase = project_execution_phase(
            job_status=job.status,
            attempts=job.attempts,
            error_code=job.error_code,
        )
        out[run.id] = present(DurableExecutionOut(phase=phase))
    return out


def chat_run_execution_phase(
    db: Session,
    *,
    run_id: UUID,
) -> DurableExecutionPhase | None:
    """Read the fresh advisory phase for an already-authorized SSE run."""
    run = db.get(ChatRun, run_id)
    if run is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Chat run not found")
    execution = project_chat_run_executions(db, [run])[run.id]
    return execution.value.phase if execution.kind == "Present" else None
