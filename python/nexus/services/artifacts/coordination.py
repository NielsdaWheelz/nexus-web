"""The durable capabilities one dossier build attempt owns."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Final
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.config import Settings
from nexus.jobs.queue import RUNNING, JobExecutionContext, JobRow, get_job
from nexus.services import durable_step_journal
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.tool_runtime.catalog import FrozenToolOperation


class DossierResearchPending(Exception):
    """A durable dependency is pending; the job yields until ``available_at``."""

    def __init__(self, available_at: datetime) -> None:
        super().__init__("Dossier research dependency is pending")
        self.available_at = available_at


class ResearchLeaseLost(Exception):
    """The dossier job lost its lease while checkpointing a research step."""


_REQUEUE_CADENCE: Final = timedelta(seconds=5)


@dataclass(slots=True)
class DossierBuildRuntime:
    build_id: UUID
    artifact_id: UUID
    job: JobRow
    execution_context: JobExecutionContext
    llm_runtime: ExecutionRuntime
    research_tool_operation: FrozenToolOperation
    settings: Settings

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
                    self.job.payload, step_path=path, state=state
                ),
            )
        return landed

    def refresh_job(self, db: Session) -> None:
        """Re-read the claimed row after a payload checkpoint written elsewhere."""
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
        """Yield on the queue's fixed cadence, bounded by an absolute deadline.

        Web article ingestion exposes durable ready state but no completion
        subscription, so readiness is observed by requeueing. A clock that
        crosses the deadline after the observation yields once more; the next
        observation owns the modeled Deadline omission.
        """
        now = datetime.now(UTC)
        raise DossierResearchPending(
            now if now >= deadline else min(deadline, now + _REQUEUE_CADENCE)
        )
