"""Strict wire shape for derived chat execution liveness."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from nexus.jobs.queue import DurableExecutionPhase


class ChatRunExecutionOut(BaseModel):
    """The queue phase and the run's durable stop intent in one observation."""

    phase: DurableExecutionPhase
    cancel_requested: bool

    model_config = ConfigDict(extra="forbid", frozen=True)


EXECUTION_ADVISORY_EVENT_TYPE = "ExecutionAdvisory"
