"""Dossier-specific runtime capabilities and bounded research yielding."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Final
from uuid import UUID

from sqlalchemy.orm import Session
from web_search_tool.types import WebSearchProvider

from nexus.jobs.queue import JobExecutionContext, JobRow
from nexus.schemas.presence import Presence
from nexus.services import durable_step_journal
from nexus.services.llm_execution import ExecutionRuntime


class DossierResearchPending(Exception):
    """A durable dependency is pending; the job should yield until ``available_at``."""

    def __init__(self, available_at: datetime) -> None:
        super().__init__("Dossier research dependency is pending")
        self.available_at = available_at


_REQUEUE_CADENCE: Final = timedelta(seconds=5)


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
        replay_policy: durable_step_journal.ReplayPolicy,
    ) -> durable_step_journal.StepReplayState | None:
        expected_policy = (
            durable_step_journal.ReplayPolicy.ReDispatchable
            if path.startswith("research/")
            else durable_step_journal.ReplayPolicy.BilledOnce
        )
        if replay_policy is not expected_policy:
            raise AssertionError(f"Dossier step {path!r} changed replay policy")
        state = durable_step_journal.read_step_states(self.job).get(path)
        return state

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
