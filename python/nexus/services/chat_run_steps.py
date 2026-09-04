"""Strict durable Chat domain steps around the shared generation journal.

Generation and model-tool replay are owned by ``llm_execution`` and
``tool_authority``. This module retains only Chat's publication journal and
the closed terminal value encoded into the shared generation checkpoint.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, RootModel
from sqlalchemy.orm import Session

from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    get_job,
    lock_running_job_claim,
    update_running_job_payload,
)
from nexus.schemas.presence import Presence, Present, absent, present
from nexus.services.durable_step_journal import (
    Completed,
    Prepared,
    ReplayPolicy,
    StepReplayState,
    encode_step_result,
    payload_with_step_state,
    read_step_states,
    stable_generation_id,
)
from nexus.services.llm_execution import ExecutionRuntime


class _StateModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ChatToolCall(_StateModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    arguments: dict[str, JsonValue]


class AssistantTurn(_StateModel):
    kind: Literal["AssistantTurn"] = "AssistantTurn"
    text: str
    tool_calls: tuple[ChatToolCall, ...]
    usage: Presence[dict[str, JsonValue]]
    support_id: Presence[str]
    last_provider_event_seq: Presence[int]


class ExpectedFailure(_StateModel):
    kind: Literal["ExpectedFailure"] = "ExpectedFailure"
    assistant_content: str
    error_code: str = Field(min_length=1)
    usage: Presence[dict[str, JsonValue]]
    support_id: Presence[str]
    last_provider_event_seq: Presence[int]


class CancelledGeneration(_StateModel):
    kind: Literal["Cancelled"] = "Cancelled"
    assistant_content: str
    usage: Presence[dict[str, JsonValue]]
    last_provider_event_seq: Presence[int]


type GenerationStepResult = Annotated[
    AssistantTurn | ExpectedFailure | CancelledGeneration,
    Field(discriminator="kind"),
]


class GenerationStepResultEnvelope(RootModel[GenerationStepResult]):
    model_config = ConfigDict(frozen=True)


class PublicationStepResult(_StateModel):
    outcome: Literal["Published", "Degraded", "Failed", "Cancelled"]
    message_id: UUID
    terminal_event_seq: int = Field(ge=1)


class PublicationRequest(_StateModel):
    generated_markdown: str
    usage: Presence[dict[str, JsonValue]]
    last_provider_event_seq: Presence[int]


class LostChatJobLease(RuntimeError):
    """The claimed attempt lost its queue lease before a checkpoint landed."""


def step_fingerprint(value: BaseModel) -> str:
    encoded = json.dumps(
        value.model_dump(mode="json"),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class ChatStepRuntime:
    """The Chat-owned journal capabilities of one currently claimed attempt."""

    def __init__(
        self,
        db: Session,
        *,
        run_id: UUID,
        job: JobRow,
        execution_context: JobExecutionContext,
        llm_runtime: ExecutionRuntime,
    ) -> None:
        self.db = db
        self.run_id = run_id
        self.job = job
        self.execution_context = execution_context
        self.llm_runtime = llm_runtime

    def read(self, path: str, policy: ReplayPolicy) -> StepReplayState | None:
        # Replay ownership is route-neutral. ``execute_generation`` decides
        # whether an Uncertain provider continuation is reopenable or a Codex
        # dispatch needs explicit repair.
        del policy
        state = read_step_states(self.job).get(path)
        if state is not None and state.generation_id != stable_generation_id(self.run_id, path):
            raise AssertionError(f"chat step {path!r} has a noncanonical generation id")
        return state

    def prepare(self, path: str, fingerprint: str) -> StepReplayState:
        if read_step_states(self.job).get(path) is not None:
            raise AssertionError(f"chat step {path!r} is already prepared")
        state = StepReplayState(
            generation_id=stable_generation_id(self.run_id, path),
            dispatch_phase=Prepared,
            request_fingerprint=present(fingerprint),
            terminal_result=absent(),
        )
        self._checkpoint(path, state)
        return state

    def complete_publication(self, result: PublicationStepResult) -> None:
        path = "publication"
        current = self._required_state(path, Prepared)
        completed = current.model_copy(
            update={
                "dispatch_phase": Completed,
                "terminal_result": present(encode_step_result(result)),
            }
        )
        completed_payload = payload_with_step_state(
            self.job.payload,
            step_path=path,
            state=completed,
        )
        if not update_running_job_payload(
            self.db,
            job_id=self.execution_context.job_id,
            worker_id=self.execution_context.worker_id,
            attempt_no=self.execution_context.attempt_no,
            payload=completed_payload,
        ):
            self.db.rollback()
            raise LostChatJobLease(f"chat job {self.job.id} lost its lease")
        if not update_running_job_payload(
            self.db,
            job_id=self.execution_context.job_id,
            worker_id=self.execution_context.worker_id,
            attempt_no=self.execution_context.attempt_no,
            payload={"run_id": str(self.run_id)},
        ):
            self.db.rollback()
            raise LostChatJobLease(f"chat job {self.job.id} lost its lease")
        self.job = replace(self.job, payload={"run_id": str(self.run_id)})
        self.db.commit()

    def clear(self) -> None:
        if not update_running_job_payload(
            self.db,
            job_id=self.execution_context.job_id,
            worker_id=self.execution_context.worker_id,
            attempt_no=self.execution_context.attempt_no,
            payload={"run_id": str(self.run_id)},
        ):
            self.db.rollback()
            raise LostChatJobLease(f"chat job {self.job.id} lost its lease")
        self.job = replace(self.job, payload={"run_id": str(self.run_id)})
        self.db.commit()

    def lock_active_attempt(self) -> None:
        """Lock this live claim into the caller's current effect transaction."""

        if not lock_running_job_claim(self.db, context=self.execution_context):
            self.db.rollback()
            raise LostChatJobLease(f"chat job {self.job.id} lost its lease")

    def lock_dispatch(self, db: Session) -> JobRow | None:
        """Return the currently fenced job for ``JobGenerationJournal``."""

        if not lock_running_job_claim(db, context=self.execution_context):
            return None
        return get_job(db, self.execution_context.job_id)

    def _required_state(self, path: str, phase: Any) -> StepReplayState:
        state = read_step_states(self.job).get(path)
        if state is None or state.dispatch_phase is not phase:
            raise AssertionError(f"chat step {path!r} is not {phase}")
        return state

    def _checkpoint(self, path: str, state: StepReplayState) -> None:
        payload = payload_with_step_state(self.job.payload, step_path=path, state=state)
        if not update_running_job_payload(
            self.db,
            job_id=self.execution_context.job_id,
            worker_id=self.execution_context.worker_id,
            attempt_no=self.execution_context.attempt_no,
            payload=payload,
        ):
            self.db.rollback()
            raise LostChatJobLease(f"chat job {self.job.id} lost its lease")
        self.job = replace(self.job, payload=payload)
        self.db.commit()


def assistant_turn_result(
    *,
    text: str,
    tool_calls: tuple[ChatToolCall, ...],
    usage: dict[str, JsonValue] | None,
    support_id: str | None,
    last_provider_event_seq: int | None,
) -> AssistantTurn:
    return AssistantTurn(
        text=text,
        tool_calls=tool_calls,
        usage=absent() if usage is None else Present(value=usage),
        support_id=absent() if support_id is None else Present(value=support_id),
        last_provider_event_seq=(
            absent() if last_provider_event_seq is None else Present(value=last_provider_event_seq)
        ),
    )


__all__ = [
    "AssistantTurn",
    "CancelledGeneration",
    "ChatStepRuntime",
    "ChatToolCall",
    "ExpectedFailure",
    "GenerationStepResult",
    "GenerationStepResultEnvelope",
    "LostChatJobLease",
    "PublicationRequest",
    "PublicationStepResult",
    "assistant_turn_result",
    "step_fingerprint",
]
