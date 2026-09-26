"""The chat worker: one claimed job executes one admission-frozen generation.

The step journal on the job payload makes a retried attempt replay instead of
redispatching a billed call; provider output is coalesced into durable SSE text
frames; cancellation is polled while streaming and folded at every terminal
boundary; publication is the final effect, taken under the run lock.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import replace
from typing import Annotated, Literal, assert_never
from uuid import UUID, uuid4

from provider_runtime.types import (
    Absent as RuntimeAbsent,
)
from provider_runtime.types import (
    Cancelled as ProviderCancelled,
)
from provider_runtime.types import (
    ContinuationTooLarge,
    InvalidStructuredOutput,
    InvalidToolArguments,
    ProviderContextTooLarge,
    TextContent,
    TokenUsage,
    TransientExhausted,
)
from provider_runtime.types import (
    Failed as ProviderFailed,
)
from provider_runtime.types import (
    Incomplete as ProviderIncomplete,
)
from provider_runtime.types import (
    Present as RuntimePresent,
)
from provider_runtime.types import (
    Succeeded as ProviderSucceeded,
)
from pydantic import BaseModel, ConfigDict, Field, JsonValue, RootModel, TypeAdapter
from sqlalchemy import select, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import ChatPromptAssembly, ChatRun
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    get_job,
    lock_running_job_claim,
    update_running_job_payload,
)
from nexus.logging import get_logger, set_flow_id
from nexus.schemas.presence import Presence, Present, absent, present
from nexus.services.chat_run_citations import (
    DegradedCitations,
    publish_chat_citations,
)
from nexus.services.chat_run_event_store import (
    TERMINAL_RUN_STATUSES,
    ChatRunEventEmitter,
    finalize_run,
    is_cancel_requested,
    lock_chat_run_for_update,
    mark_running,
)
from nexus.services.chat_run_selection import chat_generation_spec
from nexus.services.codex_generation_contract import GenerationUsage, normalized_failure
from nexus.services.durable_step_journal import (
    Completed,
    Prepared,
    StepReplayState,
    Uncertain,
    decode_step_result,
    encode_step_result,
    payload_with_step_state,
    read_step_states,
    stable_generation_id,
)
from nexus.services.generation_backend import (
    BackendEvent,
    BackendTerminal,
    BackendTextDelta,
    BackendToolObserved,
    BackendToolProposed,
    BackendUsageObserved,
    CodexTerminalEvidence,
    ProviderTerminalEvidence,
)
from nexus.services.generation_spec import (
    CodexPersonalSelection,
    GenerationIntent,
    GenerationSpec,
    ProviderApiSelection,
)
from nexus.services.llm_execution import (
    EncodedGenerationTerminal,
    ExecutionRuntime,
    GenerationExecutionRequest,
    JobGenerationJournal,
    execute_generation,
)
from nexus.services.llm_ledger import LlmCallOwner, read_model_turns
from nexus.services.tool_authority import DeferredGenerationToolExecutor
from nexus.services.tool_runtime.catalog import FrozenToolOperation

logger = get_logger(__name__)

CHAT_TEXT_FLUSH_INTERVAL_MS = 33
CHAT_TEXT_FLUSH_MAX_CHARS = 512
CHAT_TEXT_FLUSH_MAX_BYTES = 2048
CHAT_CANCEL_POLL_INTERVAL_SECONDS = 0.25

_GENERATION_STEP = "generation/1"
_PUBLICATION_STEP = "publication"


# =============================================================================
# The durable step journal
# =============================================================================


class _StateModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class AssistantTurn(_StateModel):
    kind: Literal["AssistantTurn"] = "AssistantTurn"
    text: str
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


class PublicationRequest(_StateModel):
    generated_markdown: str
    usage: Presence[dict[str, JsonValue]]
    last_provider_event_seq: Presence[int]


class LostChatJobLease(RuntimeError):
    """The claimed attempt lost its queue lease before a checkpoint landed."""


def step_fingerprint(value: BaseModel) -> str:
    return hashlib.sha256(
        json.dumps(
            value.model_dump(mode="json"),
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()


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

    def read(self, path: str) -> StepReplayState | None:
        state = read_step_states(self.job).get(path)
        if state is not None and state.generation_id != stable_generation_id(self.run_id, path):
            raise AssertionError(f"chat step {path!r} has a noncanonical generation id")
        return state

    def prepare(self, path: str, fingerprint: str) -> StepReplayState:
        state = StepReplayState(
            generation_id=stable_generation_id(self.run_id, path),
            dispatch_phase=Prepared,
            request_fingerprint=present(fingerprint),
            terminal_result=absent(),
        )
        job = self.lock_dispatch(self.db)
        if job is None:
            self.db.rollback()
            raise LostChatJobLease(f"chat job {self.job.id} lost its lease")
        if path in read_step_states(job):
            self.db.rollback()
            raise AssertionError(f"chat step {path!r} was already prepared")
        self._write(payload_with_step_state(job.payload, step_path=path, state=state))
        return state

    def clear(self) -> None:
        self._write({"run_id": str(self.run_id)})

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

    def _write(self, payload: dict[str, object]) -> None:
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


# =============================================================================
# The step loop
# =============================================================================


async def execute_chat_run(
    db: Session,
    *,
    run_id: UUID,
    job: JobRow,
    execution_context: JobExecutionContext,
    session_factory: sessionmaker[Session],
    runtime: ExecutionRuntime,
) -> RescheduleRequested | None:
    """Execute one claimed chat job; defects escape into queue recovery."""

    steps = ChatStepRuntime(
        db,
        run_id=run_id,
        job=job,
        execution_context=execution_context,
        llm_runtime=runtime,
    )
    set_flow_id(str(run_id))
    try:
        return await _execute(db, run_id=run_id, steps=steps, session_factory=session_factory)
    except Exception:
        db.rollback()
        logger.exception("chat_run.attempt_failed", run_id=str(run_id), job_id=str(job.id))
        raise
    finally:
        set_flow_id(None)


async def _execute(
    db: Session,
    *,
    run_id: UUID,
    steps: ChatStepRuntime,
    session_factory: sessionmaker[Session],
) -> RescheduleRequested | None:
    run = db.get(ChatRun, run_id)
    if run is None or run.status in TERMINAL_RUN_STATUSES:
        steps.clear()
        return None
    spec, intent = _frozen_admission(db, run=run, job=steps.job)
    operation = steps.llm_runtime.admission.model_tool_operation(spec)
    if operation is None:
        raise AssertionError("Chat GenerationSpec is missing its model-tool plan")

    mark_running(db, run.id)
    run = db.get(ChatRun, run_id)
    if run is None:
        raise AssertionError("running chat run disappeared")
    if run.status in TERMINAL_RUN_STATUSES:
        steps.clear()
        return None

    generation_state = steps.read(_GENERATION_STEP)
    if generation_state is None and is_cancel_requested(db, run.id):
        _finalize_cancelled(db, run=run, steps=steps)
        return None
    if generation_state is None:
        generation_state = steps.prepare(_GENERATION_STEP, spec.fingerprint)
    elif generation_state.dispatch_phase not in {Prepared, Uncertain, Completed}:
        raise AssertionError("chat generation step is not dispatchable")

    emitter = ChatRunEventEmitter(db, run, lease_fence=steps.lock_active_attempt)
    result = await _dispatch_generation(
        db,
        run=run,
        steps=steps,
        generation_id=generation_state.generation_id,
        spec=spec,
        intent=intent,
        operation=operation,
        session_factory=session_factory,
        emitter=emitter,
    )
    if isinstance(result, RescheduleRequested):
        return result

    usage = _value(result.usage)
    last_provider_event_seq = _value(result.last_provider_event_seq)
    if isinstance(result, CancelledGeneration):
        _finalize_cancelled(
            db,
            run=run,
            steps=steps,
            assistant_content=result.assistant_content,
            usage=usage,
            last_provider_event_seq=last_provider_event_seq,
        )
        return None
    if isinstance(result, ExpectedFailure):
        # Publication order is run -> job everywhere: take the run lock before
        # deciding between the failure and a cancellation that raced it.
        locked_run = lock_chat_run_for_update(db, run.id)
        if locked_run is None:
            raise AssertionError("chat run disappeared before terminal fold")
        if locked_run.cancel_requested_at is not None:
            _finalize_cancelled(
                db,
                run=locked_run,
                steps=steps,
                assistant_content=result.assistant_content,
                usage=usage,
                last_provider_event_seq=last_provider_event_seq,
            )
            return None
        finalize_run(
            db,
            run_id=locked_run.id,
            status="error",
            assistant_content=result.assistant_content,
            error_code=result.error_code,
            support_id=_value(result.support_id),
            usage=usage,
            last_provider_event_seq=last_provider_event_seq,
        )
        steps.clear()
        return None

    if is_cancel_requested(db, run.id):
        _finalize_cancelled(
            db,
            run=run,
            steps=steps,
            assistant_content=result.text,
            usage=usage,
            last_provider_event_seq=last_provider_event_seq,
        )
        return None
    _publish(
        db,
        run=run,
        steps=steps,
        emitter=emitter,
        generated_markdown=result.text,
        usage=usage,
        last_provider_event_seq=last_provider_event_seq,
    )
    return None


def _frozen_admission(
    db: Session,
    *,
    run: ChatRun,
    job: JobRow,
) -> tuple[GenerationSpec, GenerationIntent]:
    """Load the exact admission-time spec/prompt pair; never reconstruct it."""

    spec = chat_generation_spec(run)
    # The queue row can be stale after a superseding admission; the spec is not.
    if job.payload.get("generation_spec_fingerprint") != spec.fingerprint:
        raise AssertionError("Chat job differs from its frozen GenerationSpec")
    assembly = db.scalar(select(ChatPromptAssembly).where(ChatPromptAssembly.chat_run_id == run.id))
    if assembly is None or assembly.assistant_message_id != run.assistant_message_id:
        raise AssertionError("Chat run is missing its frozen prompt assembly")
    try:
        intent = GenerationIntent.model_validate(assembly.generation_intent)
    except ValueError as error:
        raise AssertionError("Chat prompt assembly contains an invalid GenerationIntent") from error
    return spec, intent


def _publish(
    db: Session,
    *,
    run: ChatRun,
    steps: ChatStepRuntime,
    emitter: ChatRunEventEmitter,
    generated_markdown: str,
    usage: dict[str, JsonValue] | None,
    last_provider_event_seq: int | None,
) -> None:
    """Canonicalize citations and make the answer reader-visible, once."""

    fingerprint = step_fingerprint(
        PublicationRequest(
            generated_markdown=generated_markdown,
            usage=_presence(usage),
            last_provider_event_seq=_presence(last_provider_event_seq),
        )
    )
    state = steps.read(_PUBLICATION_STEP)
    if state is None:
        state = steps.prepare(_PUBLICATION_STEP, fingerprint)
    elif state.request_fingerprint != present(fingerprint):
        raise AssertionError("durable chat step request fingerprint changed")
    if state.dispatch_phase is not Prepared:
        raise AssertionError("publication step cannot be replayed on an active run")

    # Publication is the final domain-effect boundary. Lock the run before the
    # queue claim so cancellation and every publication effect share one global
    # run -> job order; the earlier cancellation read is only a fast path.
    locked_run = lock_chat_run_for_update(db, run.id)
    if locked_run is None:
        raise AssertionError("chat run disappeared before publication")
    steps.lock_active_attempt()
    if locked_run.cancel_requested_at is not None:
        _finalize_cancelled(
            db,
            run=locked_run,
            steps=steps,
            assistant_content=generated_markdown,
            usage=usage,
            last_provider_event_seq=last_provider_event_seq,
        )
        return

    citations = publish_chat_citations(
        db,
        run=locked_run,
        generated_markdown=generated_markdown,
        emitter=emitter,
    )
    support_id: str | None = None
    warning_code: Literal["CitationsUnavailable"] | None = None
    if isinstance(citations, DegradedCitations):
        support_id = uuid4().hex[:12]
        warning_code = citations.warning_code
        logger.warning(
            "chat_citations_degraded",
            chat_run_id=str(locked_run.id),
            support_id=support_id,
            detail=citations.detail,
        )
    finalize_run(
        db,
        run_id=locked_run.id,
        status="complete",
        assistant_content=citations.content_md,
        support_id=support_id,
        publication_warning_code=warning_code,
        usage=usage,
        last_provider_event_seq=last_provider_event_seq,
    )
    steps.clear()


def _finalize_cancelled(
    db: Session,
    *,
    run: ChatRun,
    steps: ChatStepRuntime,
    assistant_content: str = "",
    usage: dict[str, JsonValue] | None = None,
    last_provider_event_seq: int | None = None,
) -> None:
    """Keep whatever text arrived; ``cancelled`` alone drives the failure card."""

    finalize_run(
        db,
        run_id=run.id,
        status="cancelled",
        assistant_content=assistant_content,
        usage=usage,
        last_provider_event_seq=last_provider_event_seq,
    )
    steps.clear()


# =============================================================================
# One frozen generation through either supported route
# =============================================================================


async def _dispatch_generation(
    db: Session,
    *,
    run: ChatRun,
    steps: ChatStepRuntime,
    generation_id: UUID,
    spec: GenerationSpec,
    intent: GenerationIntent,
    operation: FrozenToolOperation,
    session_factory: sessionmaker[Session],
    emitter: ChatRunEventEmitter,
) -> AssistantTurn | ExpectedFailure | CancelledGeneration | RescheduleRequested:
    from nexus.services.tool_runtime.chat_projection import ChatToolExecutionProjection

    observed_text_parts: list[str] = []
    observed_text_by_child: dict[int, list[str]] = {}
    observed_usage_by_child = _recorded_usage(db, generation_id=generation_id)
    recorded_usage_by_child = dict(observed_usage_by_child)
    observed_event_count = 0
    text_coalescer = _ChatTextCoalescer(emitter)

    async def observe(event: BackendEvent) -> None:
        nonlocal observed_event_count
        observed_event_count += 1
        sequence = observed_event_count
        if isinstance(event, BackendTextDelta):
            observed_text_parts.append(event.text)
            observed_text_by_child.setdefault(event.child_seq, []).append(event.text)
            await text_coalescer.add(text=event.text, sequence=sequence)
            return
        await text_coalescer.flush()
        if isinstance(event, BackendToolObserved | BackendToolProposed):
            emitter.assistant_activity(
                phase="tool_calling",
                provider_event_seq_start=sequence,
                provider_event_seq_end=sequence,
            )
        elif isinstance(event, BackendUsageObserved):
            usage = _usage_document(event.usage)
            recorded_usage = recorded_usage_by_child.get(event.child_seq)
            if recorded_usage is not None and recorded_usage != usage:
                raise AssertionError("Chat streamed usage differs from its accepted child ledger")
            observed_usage_by_child[event.child_seq] = usage

    projection = ChatToolExecutionProjection(
        run_id=run.id,
        initial_citation_ordinal=_initial_citation_ordinal(db, run=run),
    )
    cancel_signal = asyncio.Event()
    if is_cancel_requested(db, run.id):
        cancel_signal.set()
    cancel_watcher: asyncio.Task[None] | None = None

    # First dispatch commits through the prepare step, while a Prepared capacity
    # replay arrives with the post-mark-running read transaction still active.
    # Close both shapes before health or UDS I/O begins.
    db.commit()

    def encode_terminal(
        terminal: BackendTerminal, *, host_cancelled: bool = False
    ) -> EncodedGenerationTerminal:
        return EncodedGenerationTerminal(
            terminal_result=encode_step_result(
                GenerationStepResultEnvelope(
                    root=_terminal_result(
                        terminal,
                        observed_text="".join(observed_text_parts),
                        observed_text_by_child=observed_text_by_child,
                        observed_usage_by_child=observed_usage_by_child,
                        last_sequence=observed_event_count + 1,
                        generation_id=generation_id,
                        host_cancelled=host_cancelled,
                    )
                )
            ),
            orchestration_stop="cancelled" if host_cancelled else None,
        )

    def resolve_terminal(
        terminal_db: Session, terminal: BackendTerminal
    ) -> EncodedGenerationTerminal:
        locked_run = lock_chat_run_for_update(terminal_db, run.id)
        if locked_run is None:
            raise AssertionError("chat run disappeared before generation terminal")
        host_cancelled = locked_run.cancel_requested_at is not None and not _terminal_is_cancelled(
            terminal
        )
        if host_cancelled:
            cancel_signal.set()
        return encode_terminal(terminal, host_cancelled=host_cancelled)

    tool_executor = None
    if isinstance(spec.selection, ProviderApiSelection):
        tool_executor = DeferredGenerationToolExecutor(
            session_factory=session_factory,
            user_id=run.owner_user_id,
            owner=LlmCallOwner(kind="chat_run", id=run.id),
            generation_id=generation_id,
            job_context=steps.execution_context,
            operation=operation,
            projection=projection,
        )
    elif not isinstance(spec.selection, CodexPersonalSelection):
        assert_never(spec.selection)

    try:
        cancel_watcher = asyncio.create_task(
            _watch_cancel(session_factory, run_id=run.id, cancel_signal=cancel_signal)
        )
        result = await execute_generation(
            GenerationExecutionRequest(
                owner=LlmCallOwner(kind="chat_run", id=run.id),
                generation_id=generation_id,
                spec=spec,
                intent=intent,
                journal=JobGenerationJournal(
                    context=steps.execution_context,
                    step_path=_GENERATION_STEP,
                    lock_dispatch=steps.lock_dispatch,
                ),
                tool_executor=tool_executor,
            ),
            session_factory=session_factory,
            runtime=steps.llm_runtime,
            observe_event=observe,
            cancel_signal=cancel_signal,
            resolve_terminal=resolve_terminal,
            encode_terminal=encode_terminal,
            encode_failure=lambda code, _detail: _encode_failure(
                code,
                generation_id=generation_id,
                observed_text="".join(observed_text_parts),
                usage=_aggregate_usage(observed_usage_by_child),
                last_sequence=observed_event_count,
            ),
        )
    finally:
        try:
            await text_coalescer.flush()
        finally:
            if cancel_watcher is not None:
                cancel_watcher.cancel()
                with suppress(asyncio.CancelledError):
                    await cancel_watcher

    if isinstance(result, RescheduleRequested):
        return result
    return decode_step_result(result.terminal_result, GenerationStepResultEnvelope).root


async def _watch_cancel(
    session_factory: sessionmaker[Session],
    *,
    run_id: UUID,
    cancel_signal: asyncio.Event,
) -> None:
    # justify-polling: cancel_requested_at is an UPDATE on the run row, while the
    # SSE push channel only notifies appended event rows. This watcher is scoped
    # to one active generation stream and exits as soon as the stream ends.
    while not cancel_signal.is_set():
        with session_factory() as cancel_db:
            cancelled = is_cancel_requested(cancel_db, run_id)
        if cancelled:
            cancel_signal.set()
            return
        await asyncio.sleep(CHAT_CANCEL_POLL_INTERVAL_SECONDS)


def _initial_citation_ordinal(db: Session, *, run: ChatRun) -> int:
    """Recover the immutable attached-evidence cursor, excluding later tools."""

    value = db.scalar(
        text(
            """
            SELECT COALESCE(MAX(retrieval.citation_candidate_ordinal), 0) + 1
            FROM message_retrievals AS retrieval
            JOIN message_tool_calls AS tool_call ON tool_call.id = retrieval.tool_call_id
            WHERE tool_call.assistant_message_id = :assistant_message_id
              AND tool_call.tool_call_index = 0
            """
        ),
        {"assistant_message_id": run.assistant_message_id},
    )
    if type(value) is not int or value < 1:
        raise AssertionError("Chat attached citation cursor is invalid")
    return value


# =============================================================================
# Terminal decoding
# =============================================================================


def _terminal_result(
    terminal: BackendTerminal,
    *,
    observed_text: str,
    observed_text_by_child: dict[int, list[str]],
    observed_usage_by_child: dict[int, dict[str, JsonValue]],
    last_sequence: int | None,
    generation_id: UUID,
    host_cancelled: bool,
) -> AssistantTurn | ExpectedFailure | CancelledGeneration:
    """Decode one route's terminal evidence into the journaled step result."""

    usages = dict(observed_usage_by_child)
    terminal_usage = _terminal_usage_document(terminal)
    if terminal_usage is not None:
        observed_terminal_usage = usages.get(terminal.child_seq)
        if observed_terminal_usage is not None and observed_terminal_usage != terminal_usage:
            raise AssertionError("Chat terminal usage differs from its streamed usage")
        usages[terminal.child_seq] = terminal_usage
    usage = _aggregate_usage(usages)
    child_text = "".join(observed_text_by_child.get(terminal.child_seq, ()))

    if isinstance(terminal.evidence, CodexTerminalEvidence):
        native = terminal.evidence.native
        if native.status == "succeeded" and native.final_text != child_text:
            raise AssertionError("Codex terminal text differs from its streamed text fold")
        if native.status != "succeeded" and native.final_text:
            raise AssertionError("non-success Codex terminal exposed provider text")
        status = native.status
        error_code = (
            normalized_failure(native.failure.kind)
            if native.status == "failed" and native.failure is not None
            else None
        )
        if native.status == "failed" and error_code is None:
            raise AssertionError("failed Codex generation omitted failure")
    elif isinstance(terminal.evidence, ProviderTerminalEvidence):
        outcome = terminal.evidence.outcome
        if isinstance(outcome, ProviderSucceeded):
            content = outcome.response.content
            if not isinstance(content, TextContent):
                raise AssertionError("Chat ProviderApi success returned structured output")
            if content.tool_calls:
                raise AssertionError("final Chat ProviderApi terminal retained tool proposals")
            if content.text != child_text:
                raise AssertionError("Provider terminal text differs from its streamed text fold")
            status = "succeeded"
            error_code = None
        elif isinstance(outcome, ProviderCancelled):
            status = "cancelled"
            error_code = None
        elif isinstance(outcome, ProviderIncomplete | ProviderFailed):
            status = "failed"
            error_code = _provider_failure_code(outcome)
        else:
            assert_never(outcome)
    else:
        assert_never(terminal.evidence)

    if host_cancelled or status == "cancelled":
        return CancelledGeneration(
            assistant_content=observed_text,
            usage=_presence(usage),
            last_provider_event_seq=_presence(last_sequence),
        )
    if status == "failed":
        if error_code is None:
            raise AssertionError("failed Chat generation omitted its domain failure")
        return ExpectedFailure(
            assistant_content=observed_text,
            error_code=error_code,
            usage=_presence(usage),
            support_id=_presence(generation_id.hex[:12]),
            last_provider_event_seq=_presence(last_sequence),
        )
    return AssistantTurn(
        text=observed_text,
        usage=_presence(usage),
        support_id=_presence(generation_id.hex[:12]),
        last_provider_event_seq=_presence(last_sequence),
    )


def _encode_failure(
    code: str,
    *,
    generation_id: UUID,
    observed_text: str,
    usage: dict[str, JsonValue] | None,
    last_sequence: int,
) -> str:
    last_event = present(last_sequence) if last_sequence else absent()
    result: ExpectedFailure | CancelledGeneration
    if code == "cancelled":
        result = CancelledGeneration(
            assistant_content=observed_text,
            usage=_presence(usage),
            last_provider_event_seq=last_event,
        )
    else:
        result = ExpectedFailure(
            assistant_content=observed_text,
            error_code=code,
            usage=_presence(usage),
            support_id=_presence(generation_id.hex[:12]),
            last_provider_event_seq=last_event,
        )
    return encode_step_result(GenerationStepResultEnvelope(root=result))


def _terminal_is_cancelled(terminal: BackendTerminal) -> bool:
    evidence = terminal.evidence
    if isinstance(evidence, CodexTerminalEvidence):
        return evidence.native.status == "cancelled"
    if isinstance(evidence, ProviderTerminalEvidence):
        return isinstance(evidence.outcome, ProviderCancelled)
    assert_never(evidence)


def _provider_failure_code(outcome: ProviderIncomplete | ProviderFailed) -> str:
    if isinstance(outcome, ProviderIncomplete):
        return "output_limit"
    failure = outcome.failure
    if isinstance(failure, ProviderContextTooLarge):
        return "context_too_large"
    if isinstance(failure, ContinuationTooLarge):
        return "output_limit"
    if isinstance(failure, InvalidStructuredOutput | InvalidToolArguments):
        return "invalid_output"
    if isinstance(failure, TransientExhausted):
        return "runtime_unavailable"
    assert_never(failure)


# =============================================================================
# Usage folding across the generation's children
# =============================================================================


def _usage_document(usage: GenerationUsage | TokenUsage) -> dict[str, JsonValue]:
    if isinstance(usage, GenerationUsage):
        return usage.model_dump(mode="json")
    return {
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "total_tokens": usage.total_tokens,
        "reasoning_tokens": _runtime_optional_int(usage.reasoning_tokens),
        "cache_read_input_tokens": _runtime_optional_int(usage.cache_read_input_tokens),
        "cache_write_input_tokens": _runtime_optional_int(usage.cache_write_input_tokens),
    }


def _runtime_optional_int(value: RuntimePresent[int] | RuntimeAbsent) -> int | None:
    if isinstance(value, RuntimePresent):
        return value.value
    if isinstance(value, RuntimeAbsent):
        return None
    assert_never(value)


def _terminal_usage_document(terminal: BackendTerminal) -> dict[str, JsonValue] | None:
    evidence = terminal.evidence
    if isinstance(evidence, CodexTerminalEvidence):
        usage = evidence.native.usage
        return None if usage is None else _usage_document(usage)
    if isinstance(evidence, ProviderTerminalEvidence):
        usage = evidence.outcome.meta.usage
        return _usage_document(usage.value) if isinstance(usage, RuntimePresent) else None
    assert_never(evidence)


def _aggregate_usage(
    usage_by_child: dict[int, dict[str, JsonValue]],
) -> dict[str, JsonValue] | None:
    if not usage_by_child:
        return None
    result: dict[str, JsonValue] = {
        key: sum(_usage_int(usage, key) for usage in usage_by_child.values())
        for key in ("input_tokens", "output_tokens", "total_tokens")
    }
    for key in ("reasoning_tokens", "cache_read_input_tokens", "cache_write_input_tokens"):
        values = [usage.get(key) for usage in usage_by_child.values()]
        result[key] = (
            sum(_non_negative_int(value, key=key) for value in values if value is not None)
            if any(value is not None for value in values)
            else None
        )
    return result


def _recorded_usage(db: Session, *, generation_id: UUID) -> dict[int, dict[str, JsonValue]]:
    """Restore accepted paid usage without republishing historical events."""

    usages: dict[int, dict[str, JsonValue]] = {}
    token_presence = TypeAdapter(Presence[int])
    for child in read_model_turns(db, generation_id=generation_id):
        if child.usage is None:
            continue
        usage: dict[str, JsonValue] = {
            key: _usage_int(child.usage, key)
            for key in ("input_tokens", "output_tokens", "total_tokens")
        }
        for key in ("reasoning_tokens", "cache_read_input_tokens", "cache_write_input_tokens"):
            value = child.usage.get(key)
            if child.route_request_identity["kind"] == "ProviderApi":
                presence = token_presence.validate_python(value, strict=True)
                value = presence.value if isinstance(presence, Present) else None
            usage[key] = None if value is None else _non_negative_int(value, key=key)
        usages[child.turn_seq] = usage
    return usages


def _usage_int(usage: Mapping[str, object], key: str) -> int:
    return _non_negative_int(usage.get(key), key=key)


def _non_negative_int(value: object, *, key: str) -> int:
    if type(value) is not int or value < 0:
        raise AssertionError(f"Chat usage {key} is not a non-negative integer")
    return value


def _presence[T](value: T | None) -> Presence[T]:
    return absent() if value is None else Present[T](value=value)


def _value[T](value: Presence[T]) -> T | None:
    return value.value if isinstance(value, Present) else None


# =============================================================================
# Streamed text coalescing
# =============================================================================


class _ChatTextCoalescer:
    """The one bounded host-frame to durable-SSE text fold.

    Frames flush at 512 chars, 2048 bytes, or 33 ms, whichever comes first.
    """

    def __init__(self, emitter: ChatRunEventEmitter) -> None:
        self._emitter = emitter
        self._text = ""
        self._sequence_start: int | None = None
        self._sequence_end: int | None = None
        self._timer: asyncio.Task[None] | None = None
        self._failure: BaseException | None = None

    async def add(self, *, text: str, sequence: int) -> None:
        self._raise_if_failed()
        if not text:
            return
        remaining = text
        while remaining:
            prefix = _bounded_text_prefix(
                remaining,
                max_chars=CHAT_TEXT_FLUSH_MAX_CHARS - len(self._text),
                max_bytes=CHAT_TEXT_FLUSH_MAX_BYTES - len(self._text.encode("utf-8")),
            )
            if not prefix:
                await self.flush()
                continue
            if self._sequence_start is None:
                self._sequence_start = sequence
            self._sequence_end = sequence
            self._text += prefix
            remaining = remaining[len(prefix) :]
            if (
                remaining
                or len(self._text) == CHAT_TEXT_FLUSH_MAX_CHARS
                or len(self._text.encode("utf-8")) == CHAT_TEXT_FLUSH_MAX_BYTES
            ):
                await self.flush()
        if self._text and self._timer is None:
            self._timer = asyncio.create_task(self._flush_after_interval())

    async def flush(self) -> None:
        timer = self._timer
        self._timer = None
        if timer is not None and timer is not asyncio.current_task():
            timer.cancel()
            with suppress(asyncio.CancelledError):
                await timer
        self._raise_if_failed()
        self._flush_now()

    async def _flush_after_interval(self) -> None:
        try:
            await asyncio.sleep(CHAT_TEXT_FLUSH_INTERVAL_MS / 1_000)
            self._timer = None
            self._flush_now()
        except asyncio.CancelledError:
            raise
        except BaseException as exc:
            self._failure = exc

    def _flush_now(self) -> None:
        if not self._text:
            return
        if self._sequence_start is None or self._sequence_end is None:
            raise AssertionError("buffered Chat text has no provider sequence")
        self._emitter.assistant_text_delta(
            text=self._text,
            provider_event_seq_start=self._sequence_start,
            provider_event_seq_end=self._sequence_end,
        )
        self._text = ""
        self._sequence_start = None
        self._sequence_end = None

    def _raise_if_failed(self) -> None:
        if self._failure is not None:
            raise RuntimeError("Chat SSE text flush failed") from self._failure


def _bounded_text_prefix(text: str, *, max_chars: int, max_bytes: int) -> str:
    """The largest whole-code-point prefix inside both SSE frame limits."""

    if max_chars < 1 or max_bytes < 1:
        return ""
    byte_count = 0
    end = 0
    for character in text[:max_chars]:
        encoded_bytes = len(character.encode("utf-8"))
        if byte_count + encoded_bytes > max_bytes:
            break
        byte_count += encoded_bytes
        end += 1
    return text[:end]
