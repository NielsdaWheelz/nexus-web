"""Strict durable step records and runtime for one claimed chat job."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import AsyncIterator
from dataclasses import replace
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from provider_runtime import (
    Absent as RuntimeAbsent,
)
from provider_runtime import (
    AssistantMessage,
    CancelSignal,
    CanonicalTool,
    ContinuationArtifact,
    ConversationScope,
    Dynamic,
    FinalizedProviderCall,
    GenerateIntent,
    GlobalScope,
    OwnerScope,
    PromptBlock,
    ProviderCredential,
    ProviderTarget,
    RuntimeStreamEvent,
    Stable,
    StrictJsonOutput,
    SystemMessage,
    TextOutput,
    ToolCall,
    ToolResultMessage,
    UserMessage,
    parse_canonical_schema,
    to_json_schema,
)
from provider_runtime import (
    CallOutcome as ProviderCallOutcome,
)
from provider_runtime import (
    Present as RuntimePresent,
)
from pydantic import BaseModel, ConfigDict, Field, JsonValue, RootModel
from sqlalchemy import select
from sqlalchemy.orm import Session
from web_search_tool.types import WebSearchProvider

from nexus.db.models import ChatRun, ChatRunEvent, LLMCall, MessageToolCall
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    current_dead_job_for_payload,
    lock_running_job_claim,
    replace_dead_job_payload,
    requeue_dead_job,
    update_running_job_payload,
)
from nexus.schemas.conversation import ChatRunToolResultEventPayload
from nexus.schemas.presence import Absent, Presence, Present, absent, present
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


class _StateModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ProviderTargetState(_StateModel):
    provider: Literal["openai", "anthropic", "gemini", "moonshot", "openrouter"]
    model: str = Field(min_length=1)


class GlobalScopeState(_StateModel):
    kind: Literal["Global"] = "Global"


class OwnerScopeState(_StateModel):
    kind: Literal["Owner"] = "Owner"
    owner_id: UUID


class ConversationScopeState(_StateModel):
    kind: Literal["Conversation"] = "Conversation"
    conversation_id: UUID


type CacheScopeState = Annotated[
    GlobalScopeState | OwnerScopeState | ConversationScopeState,
    Field(discriminator="kind"),
]


class DynamicState(_StateModel):
    kind: Literal["Dynamic"] = "Dynamic"


class StableState(_StateModel):
    kind: Literal["Stable"] = "Stable"
    scope: CacheScopeState


type BlockStabilityState = Annotated[
    DynamicState | StableState,
    Field(discriminator="kind"),
]


class PromptBlockState(_StateModel):
    text: str
    stability: BlockStabilityState


class ContinuationState(_StateModel):
    target: ProviderTargetState
    codec_id: str = Field(min_length=1)
    opaque_payload: dict[str, JsonValue]


class ToolCallState(_StateModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    arguments: dict[str, JsonValue]


class SystemMessageState(_StateModel):
    kind: Literal["System"] = "System"
    blocks: tuple[PromptBlockState, ...]


class UserMessageState(_StateModel):
    kind: Literal["User"] = "User"
    blocks: tuple[PromptBlockState, ...]


class AssistantMessageState(_StateModel):
    kind: Literal["Assistant"] = "Assistant"
    text: str
    tool_calls: tuple[ToolCallState, ...]
    continuation: Presence[ContinuationState]


class ToolResultMessageState(_StateModel):
    kind: Literal["ToolResult"] = "ToolResult"
    call_id: str = Field(min_length=1)
    output: str
    is_error: bool


type PromptMessageState = Annotated[
    SystemMessageState | UserMessageState | AssistantMessageState | ToolResultMessageState,
    Field(discriminator="kind"),
]


class CanonicalToolState(_StateModel):
    name: str = Field(min_length=1)
    description: str
    parameters: dict[str, JsonValue]


class TextOutputState(_StateModel):
    kind: Literal["Text"] = "Text"


class StrictJsonOutputState(_StateModel):
    kind: Literal["StrictJson"] = "StrictJson"
    name: str = Field(min_length=1)
    json_schema: dict[str, JsonValue]


type OutputState = Annotated[
    TextOutputState | StrictJsonOutputState,
    Field(discriminator="kind"),
]


class GenerateIntentState(_StateModel):
    target: ProviderTargetState
    messages: tuple[PromptMessageState, ...]
    max_output_tokens: int = Field(gt=0)
    reasoning: Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]
    tools: tuple[CanonicalToolState, ...]
    tool_choice: Literal["auto", "none"]
    output: OutputState

    @classmethod
    def from_intent(cls, intent: GenerateIntent) -> GenerateIntentState:
        return cls(
            target=_target_state(intent.target),
            messages=tuple(_message_state(message) for message in intent.messages),
            max_output_tokens=intent.max_output_tokens,
            reasoning=intent.reasoning,
            tools=tuple(
                CanonicalToolState(
                    name=tool.name,
                    description=tool.description,
                    parameters=cast(
                        dict[str, JsonValue],
                        to_json_schema(
                            tool.parameters,
                            inline_defs=False,
                            include_annotations=True,
                        ),
                    ),
                )
                for tool in intent.tools
            ),
            tool_choice=intent.tool_choice,
            output=(
                TextOutputState()
                if isinstance(intent.output, TextOutput)
                else StrictJsonOutputState(
                    name=intent.output.name,
                    json_schema=cast(
                        dict[str, JsonValue],
                        to_json_schema(
                            intent.output.schema,
                            inline_defs=False,
                            include_annotations=True,
                        ),
                    ),
                )
            ),
        )

    def to_intent(self) -> GenerateIntent:
        output = (
            TextOutput()
            if isinstance(self.output, TextOutputState)
            else StrictJsonOutput(
                name=self.output.name,
                schema=parse_canonical_schema(self.output.json_schema),
            )
        )
        return GenerateIntent(
            target=_target(self.target),
            messages=tuple(_message(message) for message in self.messages),
            max_output_tokens=self.max_output_tokens,
            reasoning=self.reasoning,
            tools=tuple(
                CanonicalTool(
                    name=tool.name,
                    description=tool.description,
                    parameters=parse_canonical_schema(tool.parameters),
                )
                for tool in self.tools
            ),
            tool_choice=self.tool_choice,
            output=output,
        )


class PreparedChatRun(_StateModel):
    generate_intent: GenerateIntentState
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


class ToolModelOutput(_StateModel):
    call_id: str = Field(min_length=1)
    output: str
    is_error: bool


class ToolStepResult(_StateModel):
    tool_call_id: UUID
    tool_name: str = Field(min_length=1)
    tool_call_index: int = Field(ge=1)
    model_output: ToolModelOutput
    next_citation_ordinal: int = Field(ge=1)
    result_event: ChatRunToolResultEventPayload


class PublicationStepResult(_StateModel):
    outcome: Literal["Published", "Degraded", "Failed", "Cancelled"]
    message_id: UUID
    terminal_event_seq: int = Field(ge=1)


class PublicationRequest(_StateModel):
    generated_markdown: str
    usage: Presence[dict[str, JsonValue]]
    last_provider_event_seq: Presence[int]


class ToolStepRequest(_StateModel):
    provider_call_id: str = Field(min_length=1)
    tool_name: str = Field(min_length=1)
    tool_call_index: int = Field(ge=1)
    arguments: dict[str, JsonValue]


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


def tool_replay_policy(tool_name: str) -> ReplayPolicy:
    if tool_name in {"app_search", "read_resource", "inspect_resource"}:
        return ReplayPolicy.ReDispatchable
    return ReplayPolicy.BilledOnce


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
        web_search_provider: Presence[WebSearchProvider],
    ) -> None:
        self.db = db
        self.run_id = run_id
        self.job = job
        self.execution_context = execution_context
        self.llm_runtime = llm_runtime
        self.web_search_provider = web_search_provider

    def generation_runtime(self, path: str) -> ExecutionRuntime:
        return _GenerationDispatchRuntime(owner=self, path=path)

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


class _GenerationDispatchRuntime:
    """Commit Uncertain at the exact provider-runtime dispatch boundary."""

    def __init__(self, *, owner: ChatStepRuntime, path: str) -> None:
        self.owner = owner
        self.path = path

    async def generate(
        self,
        intent: GenerateIntent,
        plan: FinalizedProviderCall,
        credential: ProviderCredential,
    ) -> ProviderCallOutcome:
        self.owner.mark_uncertain(self.path)
        return await self.owner.llm_runtime.generate(intent, plan, credential)

    def stream(
        self,
        intent: GenerateIntent,
        plan: FinalizedProviderCall,
        credential: ProviderCredential,
        *,
        cancel: CancelSignal | None,
    ) -> AsyncIterator[RuntimeStreamEvent]:
        self.owner.mark_uncertain(self.path)
        return self.owner.llm_runtime.stream(intent, plan, credential, cancel=cancel)

def decode_prepared(state: StepReplayState) -> PreparedChatRun:
    return _decode_completed(state, PreparedChatRun)


def decode_generation(state: StepReplayState) -> GenerationStepResult:
    return _decode_completed(state, GenerationStepResultEnvelope).root


def decode_tool(state: StepReplayState) -> ToolStepResult:
    return _decode_completed(state, ToolStepResult)


def reconcile_uncertain_chat_step(
    db: Session,
    *,
    run_id: UUID,
    step_path: str,
    resolution: UncertainStepResolution,
) -> None:
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
        next_state = state.model_copy(update={"dispatch_phase": Prepared})
    elif isinstance(resolution, AttachReconciledResult):
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
        return ToolStepResult
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
        if not isinstance(result, ToolStepResult):
            raise AssertionError("tool reconciliation decoded the wrong schema")
        event = result.result_event
        if (
            event.tool_call_id != result.tool_call_id
            or event.assistant_message_id != run.assistant_message_id
            or event.tool_name != result.tool_name
            or event.tool_call_index != result.tool_call_index
        ):
            raise ValueError("reconciled tool result has inconsistent identity")
        tool_row = db.get(MessageToolCall, result.tool_call_id)
        if (
            tool_row is None
            or tool_row.assistant_message_id != run.assistant_message_id
            or tool_row.tool_name != result.tool_name
            or tool_row.tool_call_index != result.tool_call_index
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


def _target_state(target: ProviderTarget) -> ProviderTargetState:
    return ProviderTargetState(provider=target.provider, model=target.model)


def _target(state: ProviderTargetState) -> ProviderTarget:
    return ProviderTarget(provider=state.provider, model=state.model)


def _scope_state(scope: Any) -> CacheScopeState:
    if isinstance(scope, GlobalScope):
        return GlobalScopeState()
    if isinstance(scope, OwnerScope):
        return OwnerScopeState(owner_id=scope.owner_id)
    if isinstance(scope, ConversationScope):
        return ConversationScopeState(conversation_id=scope.conversation_id)
    raise AssertionError("unknown provider cache scope")


def _scope(state: CacheScopeState) -> Any:
    if isinstance(state, GlobalScopeState):
        return GlobalScope()
    if isinstance(state, OwnerScopeState):
        return OwnerScope(owner_id=state.owner_id)
    if isinstance(state, ConversationScopeState):
        return ConversationScope(conversation_id=state.conversation_id)
    raise AssertionError("unknown stored cache scope")


def _block_state(block: PromptBlock) -> PromptBlockState:
    stability = block.stability
    return PromptBlockState(
        text=block.text,
        stability=(
            DynamicState()
            if isinstance(stability, Dynamic)
            else StableState(scope=_scope_state(stability.scope))
        ),
    )


def _block(state: PromptBlockState) -> PromptBlock:
    stability = state.stability
    return PromptBlock(
        text=state.text,
        stability=(Dynamic() if isinstance(stability, DynamicState) else Stable(_scope(stability.scope))),
    )


def _continuation_state(value: ContinuationArtifact) -> ContinuationState:
    return ContinuationState(
        target=_target_state(value.target),
        codec_id=value.codec_id,
        opaque_payload=cast(
            dict[str, JsonValue],
            json.loads(json.dumps(value.opaque_payload, ensure_ascii=False)),
        ),
    )


def _continuation(value: Presence[ContinuationState]) -> Any:
    if isinstance(value, Absent):
        return RuntimeAbsent()
    return RuntimePresent(
        ContinuationArtifact(
            target=_target(value.value.target),
            codec_id=value.value.codec_id,
            opaque_payload=value.value.opaque_payload,
        )
    )


def _tool_call_state(value: ToolCall) -> ToolCallState:
    return ToolCallState(
        id=value.id,
        name=value.name,
        arguments=cast(dict[str, JsonValue], dict(value.arguments)),
    )


def tool_call_from_state(value: ToolCallState) -> ToolCall:
    return ToolCall(id=value.id, name=value.name, arguments=value.arguments)


def assistant_message_from_turn(value: AssistantTurn) -> AssistantMessage:
    return AssistantMessage(
        text=value.text,
        tool_calls=tuple(tool_call_from_state(call) for call in value.tool_calls),
        continuation=_continuation(value.continuation),
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
        tool_calls=tuple(_tool_call_state(call) for call in tool_calls),
        continuation=(
            absent()
            if isinstance(continuation, RuntimeAbsent)
            else present(_continuation_state(continuation.value))
        ),
        usage=absent() if usage is None else present(usage),
        support_id=absent() if support_id is None else present(support_id),
        last_provider_event_seq=(
            absent() if last_provider_event_seq is None else present(last_provider_event_seq)
        ),
    )


def tool_result_message(value: ToolStepResult) -> ToolResultMessage:
    return ToolResultMessage(
        call_id=value.model_output.call_id,
        output=value.model_output.output,
        is_error=value.model_output.is_error,
    )


def _message_state(value: Any) -> PromptMessageState:
    if isinstance(value, SystemMessage):
        return SystemMessageState(blocks=tuple(_block_state(block) for block in value.blocks))
    if isinstance(value, UserMessage):
        return UserMessageState(blocks=tuple(_block_state(block) for block in value.blocks))
    if isinstance(value, AssistantMessage):
        continuation = (
            absent()
            if isinstance(value.continuation, RuntimeAbsent)
            else present(_continuation_state(value.continuation.value))
        )
        return AssistantMessageState(
            text=value.text,
            tool_calls=tuple(_tool_call_state(call) for call in value.tool_calls),
            continuation=continuation,
        )
    if isinstance(value, ToolResultMessage):
        return ToolResultMessageState(
            call_id=value.call_id,
            output=value.output,
            is_error=value.is_error,
        )
    raise AssertionError("unknown provider prompt message")


def _message(value: PromptMessageState) -> Any:
    if isinstance(value, SystemMessageState):
        return SystemMessage(blocks=tuple(_block(block) for block in value.blocks))
    if isinstance(value, UserMessageState):
        return UserMessage(blocks=tuple(_block(block) for block in value.blocks))
    if isinstance(value, AssistantMessageState):
        return AssistantMessage(
            text=value.text,
            tool_calls=tuple(tool_call_from_state(call) for call in value.tool_calls),
            continuation=_continuation(value.continuation),
        )
    if isinstance(value, ToolResultMessageState):
        return ToolResultMessage(
            call_id=value.call_id,
            output=value.output,
            is_error=value.is_error,
        )
    raise AssertionError("unknown stored prompt message")
