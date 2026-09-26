"""Strict wire shape for derived durable execution liveness."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from nexus.services.durable_step_journal import DurableExecutionPhase


class DurableExecutionOut(BaseModel):
    """Advisory queue/coordination state; never a persisted run status."""

    phase: DurableExecutionPhase

    model_config = ConfigDict(extra="forbid", frozen=True)


class ChatRunExecutionOut(BaseModel):
    """Chat liveness and the separately persisted request to stop it."""

    phase: DurableExecutionPhase
    cancel_requested: bool

    model_config = ConfigDict(extra="forbid", frozen=True)


EXECUTION_ADVISORY_EVENT_TYPE = "ExecutionAdvisory"
