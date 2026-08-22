"""Dossier-specific runtime capabilities and bounded research yielding."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Final
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.jobs.queue import RUNNING, JobExecutionContext, JobRow, get_job
from nexus.services import durable_step_journal
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.tool_runtime.composition import FrozenToolOperation


class DossierResearchPending(Exception):
    """A durable dependency is pending; the job should yield until ``available_at``."""

    def __init__(self, available_at: datetime) -> None:
        super().__init__("Dossier research dependency is pending")
        self.available_at = available_at


class ResearchLeaseLost(Exception):
    """The Dossier job lost its lease while checkpointing a research step."""


_REQUEUE_CADENCE: Final = timedelta(seconds=5)


@dataclass(slots=True)
class DossierBuildRuntime:
    """The exact durable capabilities available to a Dossier binding."""

    build_id: UUID
    artifact_id: UUID
    job: JobRow
    execution_context: JobExecutionContext
    llm_runtime: ExecutionRuntime
    research_tool_operation: FrozenToolOperation

    def read_step(self, path: str) -> durable_step_journal.StepReplayState | None:
        return durable_step_journal.read_step_states(self.job).get(path)

    def checkpoint_step(
        self,
        db: Session,
        *,
        path: str,
        state: durable_step_journal.StepReplayState,
    ) -> bool:
        landed = durable_step_journal.checkpoint_step_state(
            db,
            ctx=self.execution_context,
            job=self.job,
            step_path=path,
            state=state,
        )
        if landed:
            self.job = replace(
                self.job,
                payload=durable_step_journal.payload_with_step_state(
                    self.job.payload,
                    step_path=path,
                    state=state,
                ),
            )
        return landed

    def refresh_job(self, db: Session) -> None:
        """Refresh the claimed row after a recorder-owned payload checkpoint."""

        job = get_job(db, self.execution_context.job_id)
        if (
            job is None
            or job.status != RUNNING
            or job.claimed_by != self.execution_context.worker_id
            or job.attempts != self.execution_context.attempt_no
        ):
            db.rollback()
            raise ResearchLeaseLost
        self.job = job

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
