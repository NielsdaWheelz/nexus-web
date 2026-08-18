"""Strict durable step records and runtime for one claimed chat job."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, replace
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from llm_tools import ToolResult
from provider_runtime import (
    Absent as RuntimeAbsent,
)
from provider_runtime import (
    AssistantMessage,
    ToolResultMessage,
)
from provider_runtime.types import ToolCall
from pydantic import BaseModel, ConfigDict, Field, JsonValue, RootModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, ChatRunEvent, LLMCall, MessageToolCall
from nexus.jobs.queue import (
    RUNNING,
    JobExecutionContext,
    JobRow,
    current_dead_job_for_payload,
    get_job,
    lock_running_job_claim,
    replace_dead_job_payload,
    requeue_dead_job,
    update_running_job_payload,
)
from nexus.schemas.conversation import ChatRunToolResultEventPayload
from nexus.schemas.presence import Presence, Present, absent, present
from nexus.services.chat_run_tools import (
    RecordKind,
    ToolModelOutput,
    ToolStepResult,
)
from nexus.services.durable_step_journal import (
    AttachReconciledResult,
    Completed,
    Prepared,
    ProveNotDispatched,
    ReplayPolicy,
    StepReplayState,
    Uncertain,
    UncertainStepResolution,
    decode_step_result,
    encode_step_result,
    payload_with_step_state,
    read_step_states,
    stable_generation_id,
)
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.llm_intent_state import (
    ContinuationState,
    GenerateIntentState,
    ToolCallState,
    assistant_message_from_state,
    continuation_state,
    tool_call_state,
)
from nexus.services.tool_runtime.composition import (
    FrozenToolOperation,
    compose_product_tool_runtime,
    freeze_tool_plan_snapshot,
    validate_tool_plan_snapshot,
)
from nexus.services.tool_runtime.execution import (
    reconcile_uncertain_tool_completion,
    stage_reconciled_chat_tool_terminal,
)


class _StateModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class PreparedChatRun(_StateModel):
    generate_intent: GenerateIntentState
    admitted_resource_uris: tuple[str, ...]
    initial_citation_ordinal: int = Field(ge=1)
    initial_tool_call_index: int = Field(ge=0)


class AssistantTurn(_StateModel):
    kind: Literal["AssistantTurn"] = "AssistantTurn"
    text: str
    tool_calls: tuple[ToolCallState, ...]
    continuation: Presence[ContinuationState]
    usage: Presence[dict[str, JsonValue]]
    support_id: Presence[str]
    last_provider_event_seq: Presence[int]


class ExpectedFailure(_StateModel):
    kind: Literal["ExpectedFailure"] = "ExpectedFailure"
    assistant_content: str
    error_code: str = Field(min_length=1)
    error_origin: str = Field(min_length=1)
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


class RejectedToolStepRequest(_StateModel):
    provider_call_id: str = Field(min_length=1)
    provider_wire_name: str = Field(min_length=1, max_length=128)
    tool_call_index: int = Field(ge=1)


class RejectedToolStepResult(_StateModel):
    tool_call_id: UUID
    canonical_tool_id: None = None
    record_kind: Literal[RecordKind.rejected_provider_call] = RecordKind.rejected_provider_call
    provider_wire_name: str = Field(min_length=1, max_length=128)
    canonical_input_sha256: None = None
    tool_contract_revision: None = None
    binding_policy_revision: None = None
    tool_call_index: int = Field(ge=1)
    model_output: ToolModelOutput
    next_citation_ordinal: int = Field(ge=1)
    result_event: ChatRunToolResultEventPayload


type ToolJournalResult = Annotated[
    ToolStepResult | RejectedToolStepResult,
    Field(discriminator="record_kind"),
]


class ToolJournalResultEnvelope(RootModel[ToolJournalResult]):
    model_config = ConfigDict(frozen=True)


@dataclass(frozen=True, slots=True)
class ChatToolProfileAdmission:
    profile_id: str
    profile_revision: str
    snapshot: dict[str, object]


def chat_tool_profile_admission(operation: FrozenToolOperation) -> ChatToolProfileAdmission:
    """Freeze the semantic tool authority persisted on a newly admitted run."""

    snapshot = freeze_tool_plan_snapshot(operation)
    if snapshot.exposure.type != "Native" or snapshot.profile_id != "chat":
        raise ValueError("Chat requires the exact Native chat tool operation")
    return ChatToolProfileAdmission(
        profile_id=snapshot.profile_id,
        profile_revision=snapshot.profile_revision,
        snapshot=snapshot.model_dump(mode="json"),
    )


def validate_chat_tool_profile(run: ChatRun, operation: FrozenToolOperation) -> None:
    """Reject a run whose admitted semantic tool authority has drifted."""

    if (
        run.tool_profile_id is None
        or run.tool_profile_revision is None
        or run.tool_profile_snapshot is None
    ):
        raise AssertionError("chat run is missing its tool profile snapshot")
    decoded = validate_tool_plan_snapshot(
        json.dumps(run.tool_profile_snapshot, separators=(",", ":"), sort_keys=True),
        operation=operation,
    )
    if (
        run.tool_profile_id != decoded.profile_id
        or run.tool_profile_revision != decoded.profile_revision
        or decoded.exposure.type != "Native"
        or decoded.profile_id != "chat"
    ):
        raise AssertionError("chat run tool profile columns disagree with its snapshot")


class UncertainChatStep(RuntimeError):
    """A paid or write effect may have landed and requires operator repair."""


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
    """The durable capabilities of one currently claimed chat attempt."""

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
        state = read_step_states(self.job).get(path)
        if state is not None and state.generation_id != stable_generation_id(self.run_id, path):
            raise AssertionError(f"chat step {path!r} has a noncanonical generation id")
        if state is not None and state.dispatch_phase is Uncertain:
            if policy is ReplayPolicy.BilledOnce:
                raise UncertainChatStep(f"chat step {path!r} has an uncertain external outcome")
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

    def mark_uncertain(self, path: str) -> StepReplayState:
        current = self._required_state(path, Prepared)
        state = current.model_copy(update={"dispatch_phase": Uncertain})
        self._checkpoint(path, state)
        return state

    def complete(self, path: str, result: BaseModel) -> StepReplayState:
        current = read_step_states(self.job).get(path)
        if current is None or current.dispatch_phase not in {Prepared, Uncertain}:
            raise AssertionError(f"chat step {path!r} cannot complete from its current phase")
        state = current.model_copy(
            update={
                "dispatch_phase": Completed,
                "terminal_result": present(encode_step_result(result)),
            }
        )
        self._checkpoint(path, state)
        return state

    def complete_database_step(
        self,
        path: str,
        *,
        fingerprint: str,
        result: BaseModel,
    ) -> StepReplayState:
        """Commit one pure/database step and its exact result in one boundary."""
        if read_step_states(self.job).get(path) is not None:
            raise AssertionError(f"chat database step {path!r} is already journaled")
        state = StepReplayState(
            generation_id=stable_generation_id(self.run_id, path),
            dispatch_phase=Completed,
            request_fingerprint=present(fingerprint),
            terminal_result=present(encode_step_result(result)),
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

    def generation_id(self, path: str) -> UUID:
        state = read_step_states(self.job).get(path)
        if state is None:
            raise AssertionError(f"chat step {path!r} is not prepared")
        if state.generation_id != stable_generation_id(self.run_id, path):
            raise AssertionError(f"chat step {path!r} has a noncanonical generation id")
        return state.generation_id

    def refresh_job(self) -> None:
        """Reload recorder-owned checkpoints before Chat writes another step."""

        refreshed = get_job(self.db, self.execution_context.job_id)
        if (
            refreshed is None
            or refreshed.status != RUNNING
            or refreshed.claimed_by != self.execution_context.worker_id
            or refreshed.attempts != self.execution_context.attempt_no
        ):
            self.db.rollback()
            raise LostChatJobLease(f"chat job {self.job.id} lost its lease")
        self.job = refreshed

    def lock_active_attempt(self) -> None:
        """Lock this live claim into the caller's current effect transaction."""
        if not lock_running_job_claim(self.db, context=self.execution_context):
            self.db.rollback()
            raise LostChatJobLease(f"chat job {self.job.id} lost its lease")

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


def decode_prepared(state: StepReplayState) -> PreparedChatRun:
    return _decode_completed(state, PreparedChatRun)


def decode_generation(state: StepReplayState) -> GenerationStepResult:
    return _decode_completed(state, GenerationStepResultEnvelope).root


def decode_rejected_tool(state: StepReplayState) -> RejectedToolStepResult:
    return _decode_completed(state, RejectedToolStepResult)


def reconcile_uncertain_chat_step(
    db: Session,
    *,
    run_id: UUID,
    step_path: str,
    resolution: UncertainStepResolution,
) -> None:
    try:
        job = current_dead_job_for_payload(
            db,
            kind="chat_run",
            expected_payload_match={"run_id": str(run_id)},
        )
        if job is None:
            raise ValueError("chat run has no suspended job")
        state = read_step_states(job).get(step_path)
        if state is None or state.dispatch_phase is not Uncertain:
            raise ValueError("chat step is not uncertain")
        if state.generation_id != stable_generation_id(run_id, step_path):
            raise ValueError("chat step has a noncanonical generation id")
        if isinstance(resolution, ProveNotDispatched):
            tool_execution = state.tool_execution
            if isinstance(tool_execution, Present):
                if tool_execution.value.identity.replay_policy is not ReplayPolicy.BilledOnce:
                    raise ValueError("ReDispatchable tool recovery is owned by lease abandonment")
                tool_execution = present(
                    tool_execution.value.model_copy(update={"dispatch_claim": absent()})
                )
            next_state = state.model_copy(
                update={
                    "dispatch_phase": Prepared,
                    "tool_execution": tool_execution,
                }
            )
        elif isinstance(resolution, AttachReconciledResult):
            if isinstance(state.tool_execution, Present):
                if not isinstance(resolution.tool_settlement, Present):
                    raise ValueError("reconciled tool result requires an exact settlement")
                run = db.get(ChatRun, run_id)
                if run is None or run.status not in {"queued", "running"}:
                    raise ValueError("reconciled chat result requires one active run")
                tool_match = re.fullmatch(r"turn/\d+/tool/(\d+)", step_path)
                if tool_match is None:
                    raise ValueError("tool execution occupies a non-tool Chat step")
                operation = compose_product_tool_runtime(None).operations["chat"]
                validate_chat_tool_profile(run, operation)
                next_state = reconcile_uncertain_tool_completion(
                    operation=operation,
                    state=state,
                    raw_result=resolution.terminal_result,
                    settlement=resolution.tool_settlement.value,
                )
                if not isinstance(next_state.terminal_result, Present):
                    raise AssertionError("reconciled tool completion omitted its terminal result")
                result = cast(ToolResult, json.loads(next_state.terminal_result.value))
                stage_reconciled_chat_tool_terminal(
                    db=db,
                    operation=operation,
                    run=run,
                    tool_call_index=int(tool_match.group(1)),
                    identity=state.tool_execution.value.identity,
                    result=result,
                )
            else:
                if isinstance(resolution.tool_settlement, Present):
                    raise ValueError("non-tool reconciliation cannot carry a tool settlement")
                schema = _result_schema(step_path)
                decoded = decode_step_result(resolution.terminal_result, schema)
                _validate_reconciled_domain_facts(
                    db,
                    run_id=run_id,
                    step_path=step_path,
                    result=decoded,
                )
                next_state = state.model_copy(
                    update={
                        "dispatch_phase": Completed,
                        "terminal_result": present(resolution.terminal_result),
                    }
                )
        else:
            raise AssertionError("unknown uncertain chat-step resolution")
        payload = payload_with_step_state(job.payload, step_path=step_path, state=next_state)
        if not replace_dead_job_payload(db, job_id=job.id, payload=payload):
            raise AssertionError("suspended chat job changed while locked")
        if not requeue_dead_job(db, job_id=job.id):
            raise AssertionError("suspended chat job could not be requeued")
        db.commit()
    except BaseException:
        db.rollback()
        raise


def _decode_completed[T: BaseModel](state: StepReplayState, schema: type[T]) -> T:
    if state.dispatch_phase is not Completed or not isinstance(state.terminal_result, Present):
        raise AssertionError("chat step is not completed")
    return decode_step_result(state.terminal_result.value, schema)


def _result_schema(path: str) -> type[BaseModel]:
    if path == "prepare":
        return PreparedChatRun
    if path == "publication":
        return PublicationStepResult
    if re.fullmatch(r"turn/\d+/generation", path):
        return GenerationStepResultEnvelope
    if re.fullmatch(r"turn/\d+/tool/\d+", path):
        return ToolJournalResultEnvelope
    raise ValueError("unknown chat step path")


def _validate_reconciled_domain_facts(
    db: Session,
    *,
    run_id: UUID,
    step_path: str,
    result: BaseModel,
) -> None:
    """Prove an attached result already has its canonical durable facts.

    Attachment repairs a missing journal terminal only. It never fabricates
    billing, tool, retrieval, snapshot, Undo, or SSE facts from an incomplete
    result envelope.
    """
    run = db.get(ChatRun, run_id)
    if run is None or run.status not in {"queued", "running"}:
        raise ValueError("reconciled chat result requires one active run")

    generation_match = re.fullmatch(r"turn/(\d+)/generation", step_path)
    if generation_match is not None:
        if not isinstance(result, GenerationStepResultEnvelope):
            raise AssertionError("generation reconciliation decoded the wrong schema")
        call_seq = int(generation_match.group(1)) + 1
        call = db.scalar(
            select(LLMCall).where(
                LLMCall.owner_kind == "chat_run",
                LLMCall.owner_id == run_id,
                LLMCall.call_seq == call_seq,
            )
        )
        if call is None or call.outcome is None:
            raise ValueError("reconciled generation has no terminal LLM ledger fact")
        if isinstance(result.root, AssistantTurn) and call.outcome != "succeeded":
            raise ValueError("reconciled assistant turn disagrees with the LLM ledger")
        return

    if re.fullmatch(r"turn/\d+/tool/\d+", step_path) is not None:
        if not isinstance(result, ToolJournalResultEnvelope):
            raise AssertionError("tool reconciliation decoded the wrong schema")
        tool_result = result.root
        event = tool_result.result_event
        if (
            event.tool_call_id != tool_result.tool_call_id
            or event.assistant_message_id != run.assistant_message_id
            or event.record_kind != tool_result.record_kind
            or event.canonical_tool_id != tool_result.canonical_tool_id
            or event.tool_call_index != tool_result.tool_call_index
        ):
            raise ValueError("reconciled tool result has inconsistent identity")
        tool_row = db.get(MessageToolCall, tool_result.tool_call_id)
        if (
            tool_row is None
            or tool_row.assistant_message_id != run.assistant_message_id
            or tool_row.record_kind != tool_result.record_kind
            or tool_row.canonical_tool_id != tool_result.canonical_tool_id
            or tool_row.tool_call_index != tool_result.tool_call_index
            or tool_row.status != event.status
            or tool_row.error_code != event.error_code
        ):
            raise ValueError("reconciled tool result has no matching canonical tool fact")
        stored_events = db.scalars(
            select(ChatRunEvent).where(
                ChatRunEvent.run_id == run_id,
                ChatRunEvent.event_type == "tool_result",
            )
        ).all()
        expected_event = event.model_dump(mode="json")
        if not any(stored.payload == expected_event for stored in stored_events):
            raise ValueError("reconciled tool result has no matching canonical event")
        return

    raise ValueError("this chat step cannot accept an attached result")


def assistant_message_from_turn(value: AssistantTurn) -> AssistantMessage:
    return assistant_message_from_state(
        text=value.text,
        tool_calls=value.tool_calls,
        continuation=value.continuation,
    )


def assistant_turn_result(
    *,
    text: str,
    tool_calls: tuple[ToolCall, ...],
    continuation: Any,
    usage: dict[str, JsonValue] | None,
    support_id: str | None,
    last_provider_event_seq: int | None,
) -> AssistantTurn:
    return AssistantTurn(
        text=text,
        tool_calls=tuple(tool_call_state(call) for call in tool_calls),
        continuation=(
            absent()
            if isinstance(continuation, RuntimeAbsent)
            else present(continuation_state(continuation.value))
        ),
        usage=absent() if usage is None else present(usage),
        support_id=absent() if support_id is None else present(support_id),
        last_provider_event_seq=(
            absent() if last_provider_event_seq is None else present(last_provider_event_seq)
        ),
    )


def tool_result_message(value: ToolJournalResult) -> ToolResultMessage:
    return ToolResultMessage(
        call_id=value.model_output.call_id,
        output=value.model_output.output,
        is_error=value.model_output.is_error,
    )
