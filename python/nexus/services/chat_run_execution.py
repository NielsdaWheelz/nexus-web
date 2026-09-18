"""Derived execution liveness for queue-backed chat runs.

The run owns product state; its one ``chat_run:{id}`` queue row owns execution
liveness. This adapter correlates those owners in one batched read and delegates
the queue-state mapping to the durable-step journal kernel.
"""

from __future__ import annotations

from collections.abc import Sequence
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

_TERMINAL_RUN_STATUSES = frozenset({"complete", "error", "cancelled"})


def project_chat_run_executions(
    db: Session,
    runs: Sequence[ChatRun],
) -> dict[UUID, Presence[DurableExecutionOut]]:
    """Project many run/job pairs with one queue query.

    Terminal runs never require a retained queue row; every nonterminal run
    owns exactly one ``chat_run:{id}`` queue row, and its absence is a
    correlation defect.
    """
    out: dict[UUID, Presence[DurableExecutionOut]] = {}
    live_by_key: dict[str, ChatRun] = {}
    for run in runs:
        if run.status in _TERMINAL_RUN_STATUSES:
            out[run.id] = absent()
            continue
        live_by_key[f"chat_run:{run.id}"] = run

    if not live_by_key:
        return out

    rows = db.execute(
        text(
            "SELECT dedupe_key, status, attempts, error_code "
            "FROM background_jobs WHERE dedupe_key = ANY(:dedupe_keys)"
        ),
        {"dedupe_keys": list(live_by_key)},
    ).mappings()
    jobs_by_key = {str(row["dedupe_key"]): row for row in rows}

    for dedupe_key, run in live_by_key.items():
        job = jobs_by_key.get(dedupe_key)
        if job is None:
            raise AssertionError(f"Nonterminal chat run has no queue job: {run.id}")
        phase = project_execution_phase(
            job_status=str(job["status"]),
            attempts=int(job["attempts"]),
            error_code=(str(job["error_code"]) if job["error_code"] is not None else None),
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
