"""Durable, route-neutral execution for one frozen ``GenerationSpec``.

This is the sole bridge between a domain-owned replay journal and the shared
Codex/API backend. It owns parent/child ledger transactions, continuation
sealing, and terminal publication. It never resolves mutable policy, selects
another model, or holds a database transaction across external I/O.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from enum import Enum
from typing import Literal, Protocol, assert_never
from uuid import UUID, uuid5

from llm_agent_kernel.generation import GenerationStopped
from provider_runtime.types import (
    Absent as RuntimeAbsent,
)
from provider_runtime.types import (
    Cancelled as ProviderCancelled,
)
from provider_runtime.types import (
    ExpectedModelFailure,
    InvalidStructuredOutput,
    InvalidToolArguments,
    ProviderContextTooLarge,
    ProviderHttpUnavailable,
    ProviderRateLimit,
    ProviderStreamInterrupted,
    ProviderTimeout,
    TransientExhausted,
    TransportUnavailable,
)
from provider_runtime.types import (
    Failed as ProviderFailed,
)
from provider_runtime.types import (
    FailureCode as ProviderFailureCode,
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
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session, sessionmaker

from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    ScheduleAt,
    get_job,
    lock_running_job_claim,
    update_running_job_payload,
)
from nexus.schemas.llm import CapacityPaused
from nexus.schemas.presence import Absent, Present, absent, present
from nexus.services.codex_generation_contract import (
    GenerationCommandDraft,
    GenerationTerminal,
    NormalizedFailureCode,
    normalized_failure,
    retained_terminal_error_detail,
)
from nexus.services.durable_step_journal import (
    Completed,
    Prepared,
    ProveNotDispatched,
    StepReplayState,
    Uncertain,
    checkpoint_step_state,
    payload_with_step_state,
    read_step_states,
)
from nexus.services.generation_admission import (
    FrozenHostEvidence,
    GenerationAdmissionPort,
    GenerationOperationUnavailable,
)
from nexus.services.generation_backend import (
    BackendChildCompletion,
    BackendChildDispatch,
    BackendEventObserver,
    BackendGenerationOutcome,
    BackendGenerationRequest,
    BackendToolExecutionRequest,
    BackendToolExecutionResult,
    BackendToolExecutor,
    CodexAdmissionBinder,
    GenerationBackend,
    GenerationBackendExecution,
    ProviderContinuationIdentity,
    ProviderResumeState,
)
from nexus.services.generation_continuations import (
    GenerationContinuationCipher,
    GenerationContinuationContext,
)
from nexus.services.generation_events import (
    BackendEvent,
    BackendTerminal,
    CodexTerminalEvidence,
    ProviderTerminalEvidence,
)
from nexus.services.generation_intent import GenerationIntent
from nexus.services.generation_policy import BACKGROUND_CAPACITY_PROBE_SECONDS
from nexus.services.generation_selection import ProviderApiSelection
from nexus.services.generation_spec import (
    BackgroundOperationKey,
    FrozenToolScope,
    GenerationSpec,
    ImmutablePromptPayloadRef,
    decode_generation_spec_document,
    generation_fact_digest,
)
from nexus.services.llm_ledger import (
    GenerationStart,
    LlmCallOwner,
    ModelTurnCompletion,
    ModelTurnStart,
    arm_model_turn_dispatch_in_current_transaction,
    arm_resumed_model_turn_dispatch_in_current_transaction,
    complete_generation_in_current_transaction,
    complete_model_turn_in_current_transaction,
    generation_spec_document,
    lock_generation_for_authority_in_current_transaction,
    lock_generation_owner_in_current_transaction,
    open_generation_continuation_in_current_transaction,
    read_model_turns,
    read_pending_generation_continuation_in_current_transaction,
    reset_generation_after_proven_non_dispatch_in_current_transaction,
    start_generation_in_current_transaction,
    start_model_turn_in_current_transaction,
    stop_generation_in_current_transaction,
)
from nexus.services.provider_generation_contract import (
    provider_turn_continuation_fingerprint,
)

type LockedDispatch = Callable[[Session], JobRow | None]
type EncodeTerminal = Callable[[BackendTerminal], "EncodedGenerationTerminal"]
type GenerationFailureCode = NormalizedFailureCode | Literal["cancelled", "turn_limit"]
type EncodeFailure = Callable[[GenerationFailureCode, str], str]
type ObserveEvent = Callable[[BackendEvent], Awaitable[None]]
type BeforeTerminal = Callable[[], Awaitable[None]]
type ResolveTerminal = Callable[[Session, BackendTerminal], "EncodedGenerationTerminal"]
type BindAdmission = CodexAdmissionBinder
type BindAdmissionFactory = Callable[[GenerationSpec], BindAdmission]
type ToolExecutorFactory = Callable[[GenerationSpec], BackendToolExecutor]

_MODEL_TURN_COMPONENT = "nexus-generation-model-turn.v1"


class ExecutionRuntime(Protocol):
    """Fully composed backend plus shared tool and continuation authorities."""

    @property
    def continuation_cipher(self) -> GenerationContinuationCipher: ...

    @property
    def admission(self) -> GenerationAdmissionPort: ...

    async def execute(self, execution: GenerationBackendExecution) -> BackendGenerationOutcome: ...


@dataclass(frozen=True, slots=True)
class ComposedExecutionRuntime:
    backend: GenerationBackend
    continuation_cipher: GenerationContinuationCipher = field(repr=False)
    admission: GenerationAdmissionPort

    async def execute(self, execution: GenerationBackendExecution) -> BackendGenerationOutcome:
        return await self.backend.execute(execution)


class CancellationSignal(Protocol):
    async def wait(self) -> bool: ...

    def is_set(self) -> bool: ...


class GenerationJournal(Protocol):
    """Domain replay journal; implementations never commit or roll back."""

    def read(self, db: Session) -> StepReplayState | None: ...

    def arm(
        self,
        db: Session,
        *,
        expected: StepReplayState,
        next_state: StepReplayState,
    ) -> bool: ...

    def complete(
        self,
        db: Session,
        *,
        expected: StepReplayState,
        next_state: StepReplayState,
    ) -> bool: ...


class GenerationAdmissionJournal(GenerationJournal, Protocol):
    """Journal that atomically owns prompt/spec admission beside replay state."""

    def read_admission(self, db: Session) -> tuple[GenerationSpec, GenerationIntent] | None: ...

    def prepare_admission(
        self,
        db: Session,
        *,
        generation_id: UUID,
        spec: GenerationSpec,
        intent: GenerationIntent,
    ) -> tuple[GenerationSpec, GenerationIntent]: ...

    def park_capacity_pause(self, db: Session, pause: CapacityPaused) -> None: ...

    def clear_capacity_pause(self, db: Session) -> None: ...


@dataclass(frozen=True, slots=True)
class JobGenerationJournal:
    """Lease-fenced generation journal stored in ``background_jobs.payload``."""

    context: JobExecutionContext
    step_path: str
    lock_dispatch: LockedDispatch

    def __post_init__(self) -> None:
        if not self.step_path:
            raise ValueError("generation step_path must not be blank")

    def read(self, db: Session) -> StepReplayState | None:
        job = get_job(db, self.context.job_id)
        if job is None:
            raise AssertionError(f"generation job {self.context.job_id} disappeared")
        return read_step_states(job).get(self.step_path)

    def arm(
        self,
        db: Session,
        *,
        expected: StepReplayState,
        next_state: StepReplayState,
    ) -> bool:
        job = self.lock_dispatch(db)
        if job is None or not lock_running_job_claim(db, context=self.context):
            return False
        _assert_expected_state(read_step_states(job).get(self.step_path), expected)
        return checkpoint_step_state(
            db,
            ctx=self.context,
            job=job,
            step_path=self.step_path,
            state=next_state,
        )

    def complete(
        self,
        db: Session,
        *,
        expected: StepReplayState,
        next_state: StepReplayState,
    ) -> bool:
        if not lock_running_job_claim(db, context=self.context):
            return False
        job = get_job(db, self.context.job_id)
        if job is None:
            raise AssertionError(f"generation job {self.context.job_id} disappeared")
        _assert_expected_state(read_step_states(job).get(self.step_path), expected)
        return checkpoint_step_state(
            db,
            ctx=self.context,
            job=job,
            step_path=self.step_path,
            state=next_state,
        )

    def read_admission(self, db: Session) -> tuple[GenerationSpec, GenerationIntent] | None:
        """Read the one exact prompt/spec pair owned by this step path."""

        job = get_job(db, self.context.job_id)
        if job is None:
            raise AssertionError(f"generation job {self.context.job_id} disappeared")
        raw_admissions = job.payload.get("generation_admissions")
        if raw_admissions is None:
            if self.read(db) is not None:
                raise AssertionError("generation step exists without its frozen admission")
            return None
        if not isinstance(raw_admissions, dict):
            raise AssertionError("generation_admissions payload is not an object")
        raw = raw_admissions.get(self.step_path)
        if raw is None:
            if self.read(db) is not None:
                raise AssertionError("generation step exists without its frozen admission")
            return None
        if not isinstance(raw, dict) or set(raw) != {"spec", "intent"}:
            raise AssertionError("frozen generation admission has invalid fields")
        spec = decode_generation_spec_document(raw["spec"])
        intent_value = raw["intent"]
        if not isinstance(intent_value, dict):
            raise AssertionError("frozen generation intent is not an object")
        intent = GenerationIntent.model_validate(intent_value)
        return spec, intent

    def prepare_admission(
        self,
        db: Session,
        *,
        generation_id: UUID,
        spec: GenerationSpec,
        intent: GenerationIntent,
    ) -> tuple[GenerationSpec, GenerationIntent]:
        """Persist prompt/spec and Prepared state in the lease-fenced transaction."""

        job = self.lock_dispatch(db)
        if job is None or not lock_running_job_claim(db, context=self.context):
            raise GenerationDispatchAborted(
                f"generation {generation_id} lost its claim before admission"
            )
        observed = self.read_admission(db)
        if observed is not None:
            _assert_frozen_admission(observed, spec=spec, intent=intent)
            self.clear_capacity_pause(db)
            return observed
        if read_step_states(job).get(self.step_path) is not None:
            raise AssertionError("generation admission collided with an existing step")
        admissions = job.payload.get("generation_admissions", {})
        if not isinstance(admissions, dict):
            raise AssertionError("generation_admissions payload is not an object")
        next_admissions = {
            **admissions,
            self.step_path: {
                "spec": spec.model_dump(mode="json", by_alias=True),
                "intent": intent.model_dump(mode="json", by_alias=True),
            },
        }
        prepared = StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Prepared,
            request_fingerprint=present(spec.fingerprint),
            terminal_result=absent(),
        )
        payload_without_pause = _payload_without_capacity_pause(
            job.payload,
            step_path=self.step_path,
        )
        payload = payload_with_step_state(
            {**payload_without_pause, "generation_admissions": next_admissions},
            step_path=self.step_path,
            state=prepared,
        )
        if not update_running_job_payload(
            db,
            job_id=self.context.job_id,
            worker_id=self.context.worker_id,
            attempt_no=self.context.attempt_no,
            payload=payload,
        ):
            raise GenerationDispatchAborted(
                f"generation {generation_id} lost its claim before admission"
            )
        return spec, intent

    def park_capacity_pause(self, db: Session, pause: CapacityPaused) -> None:
        job = self.lock_dispatch(db)
        if job is None or not lock_running_job_claim(db, context=self.context):
            raise GenerationDispatchAborted("generation lost its claim while parking capacity")
        raw = job.payload.get("generation_capacity_pauses", {})
        if not isinstance(raw, dict):
            raise AssertionError("generation_capacity_pauses payload is not an object")
        payload = {
            **job.payload,
            "generation_capacity_pauses": {
                **raw,
                self.step_path: pause.model_dump(mode="json"),
            },
        }
        if not update_running_job_payload(
            db,
            job_id=self.context.job_id,
            worker_id=self.context.worker_id,
            attempt_no=self.context.attempt_no,
            payload=payload,
        ):
            raise GenerationDispatchAborted("generation lost its claim while parking capacity")

    def clear_capacity_pause(self, db: Session) -> None:
        job = self.lock_dispatch(db)
        if job is None or not lock_running_job_claim(db, context=self.context):
            raise GenerationDispatchAborted("generation lost its claim while clearing capacity")
        payload = _payload_without_capacity_pause(job.payload, step_path=self.step_path)
        if payload == job.payload:
            return
        if not update_running_job_payload(
            db,
            job_id=self.context.job_id,
            worker_id=self.context.worker_id,
            attempt_no=self.context.attempt_no,
            payload=payload,
        ):
            raise GenerationDispatchAborted("generation lost its claim while clearing capacity")


def read_capacity_pauses(payload: Mapping[str, object]) -> dict[str, CapacityPaused]:
    """Decode every durable pause parked by ``park_capacity_pause``, keyed by step path.

    The payload stores ``CapacityPaused.model_dump(mode="json")``. Re-entering the
    strict model through its JSON validator restores the instants exactly as
    ``decode_generation_spec_document`` does for the frozen spec; the schema is
    not loosened and no other module parses this shape.
    """

    raw = payload.get("generation_capacity_pauses")
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise AssertionError("generation_capacity_pauses payload is not an object")
    pauses: dict[str, CapacityPaused] = {}
    for step_path, value in raw.items():
        if not isinstance(step_path, str) or not step_path:
            raise AssertionError("generation_capacity_pauses is not keyed by step path")
        try:
            encoded = json.dumps(value, ensure_ascii=True, allow_nan=False, sort_keys=True)
        except (TypeError, ValueError) as error:
            raise AssertionError(
                f"capacity pause for step {step_path!r} is not JSON data"
            ) from error
        pauses[step_path] = CapacityPaused.model_validate_json(encoded)
    return pauses


def _payload_without_capacity_pause(
    payload: Mapping[str, object],
    *,
    step_path: str,
) -> dict[str, object]:
    next_payload = dict(payload)
    raw = next_payload.get("generation_capacity_pauses")
    if raw is None:
        return next_payload
    if not isinstance(raw, dict):
        raise AssertionError("generation_capacity_pauses payload is not an object")
    pauses = dict(raw)
    pauses.pop(step_path, None)
    if pauses:
        next_payload["generation_capacity_pauses"] = pauses
    else:
        next_payload.pop("generation_capacity_pauses", None)
    return next_payload


@dataclass(frozen=True, slots=True)
class GenerationExecutionRequest:
    """Complete immutable request consumed by one durable owner."""

    owner: LlmCallOwner
    generation_id: UUID
    spec: GenerationSpec
    intent: GenerationIntent = field(repr=False)
    journal: GenerationAdmissionJournal
    bind_admission: BindAdmission | None = field(default=None, repr=False)
    tool_executor: BackendToolExecutor | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if hashlib.sha256(self.intent.instructions.encode()).hexdigest() != (
            self.spec.instructions_digest
        ):
            raise ValueError("generation intent instructions differ from frozen spec")
        if hashlib.sha256(self.intent.input.encode()).hexdigest() != self.spec.input_digest:
            raise ValueError("generation intent input differs from frozen spec")
        has_tools = isinstance(self.spec.model_tool_plan_snapshot, Present)
        is_codex = self.spec.selection.route == "CodexPersonal"
        if (self.bind_admission is not None) != (has_tools and is_codex):
            raise ValueError("only tool-bearing Codex accepts an admission binder")
        if (self.tool_executor is not None) != (has_tools and not is_codex):
            raise ValueError("only tool-bearing ProviderApi accepts a direct tool executor")


class AttachReconciledGenerationTerminal(BaseModel):
    """Digest-bound raw Codex host transcript captured by an operator."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    raw_stream: bytes = Field(min_length=1)
    raw_stream_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    latency_ms: int = Field(ge=0)


type GenerationUncertainResolution = ProveNotDispatched | AttachReconciledGenerationTerminal


@dataclass(frozen=True, slots=True)
class GenerationReconciliationRequest:
    owner: LlmCallOwner
    draft: GenerationCommandDraft
    state: StepReplayState
    resolution: GenerationUncertainResolution


@dataclass(frozen=True, slots=True)
class CompletedGeneration:
    terminal_result: str
    terminal: BackendTerminal | None
    replayed: bool


@dataclass(frozen=True, slots=True)
class AcceptedGenerationFailure:
    code: Literal["invalid_output"]
    detail: str

    def __post_init__(self) -> None:
        if not self.detail.strip():
            raise ValueError("accepted generation failure detail must not be blank")


@dataclass(frozen=True, slots=True)
class EncodedGenerationTerminal:
    terminal_result: str
    accepted_failure: AcceptedGenerationFailure | None = None
    orchestration_stop: Literal["cancelled"] | None = None

    def __post_init__(self) -> None:
        if self.accepted_failure is not None and self.orchestration_stop is not None:
            raise ValueError("generation projection cannot both fail and cancel")


type GenerationExecutionResult = CompletedGeneration | RescheduleRequested


class GenerationUncertain(RuntimeError):
    """An armed model call may have run and cannot automatically repeat."""


class GenerationDispatchAborted(RuntimeError):
    """The live lease or domain claim disappeared before dispatch."""


class GenerationAdmissionInputsChanged(RuntimeError):
    """Mutable domain input no longer matches a frozen Prepared admission."""


class GenerationCapacityPaused(RuntimeError):
    """A durable background admission is parked outside the retry budget."""

    def __init__(self, pause: CapacityPaused) -> None:
        self.pause = pause
        super().__init__(pause.explanation)

    @property
    def schedule(self) -> ScheduleAt:
        instant = (
            self.pause.reset_at.value
            if isinstance(self.pause.reset_at, Present)
            else self.pause.next_check_at
        )
        return ScheduleAt(instant)


async def admit_job_generation(
    *,
    owner: LlmCallOwner,
    generation_id: UUID,
    operation: BackgroundOperationKey,
    intent: GenerationIntent,
    prompt_template_revision: str,
    prompt_payload_ref: ImmutablePromptPayloadRef,
    journal: GenerationAdmissionJournal,
    session_factory: sessionmaker[Session],
    runtime: ExecutionRuntime,
    scope: FrozenToolScope | None = None,
    host: FrozenHostEvidence | None = None,
    bind_admission_factory: BindAdmissionFactory | None = None,
    tool_executor_factory: ToolExecutorFactory | None = None,
) -> GenerationExecutionRequest:
    """Freeze and persist one background admission before any backend I/O.

    The catalog read happens outside the transaction. The second, fenced read
    handles a concurrent winner and prevents policy/catalog drift from
    replacing an already Prepared generation.
    """

    with session_factory() as db:
        observed = journal.read_admission(db)
    if observed is None:
        try:
            candidate = await runtime.admission.freeze_background(
                operation=operation,
                intent=intent,
                prompt_template_revision=prompt_template_revision,
                prompt_payload_ref=prompt_payload_ref,
                scope=scope,
                host=host,
            )
        except GenerationOperationUnavailable as error:
            if not isinstance(error.reason, CapacityPaused):
                raise
            with session_factory() as db:
                journal.park_capacity_pause(db, error.reason)
                db.commit()
            raise GenerationCapacityPaused(error.reason) from error
        with session_factory() as db:
            lock_generation_owner_in_current_transaction(db, owner)
            spec, frozen_intent = journal.prepare_admission(
                db,
                generation_id=generation_id,
                spec=candidate,
                intent=intent,
            )
            db.commit()
    else:
        spec, frozen_intent = observed
    if frozen_intent != intent:
        raise GenerationAdmissionInputsChanged(
            "domain prompt changed after the generation was Prepared"
        )
    if spec.operation != operation or spec.selection_source != "BackgroundPolicy":
        raise AssertionError("frozen job admission has the wrong operation identity")
    has_tools = isinstance(spec.model_tool_plan_snapshot, Present)
    is_codex = spec.selection.route == "CodexPersonal"
    binder = (
        bind_admission_factory(spec)
        if has_tools and is_codex and bind_admission_factory is not None
        else None
    )
    tool_executor = (
        tool_executor_factory(spec)
        if has_tools and not is_codex and tool_executor_factory is not None
        else None
    )
    return GenerationExecutionRequest(
        owner=owner,
        generation_id=generation_id,
        spec=spec,
        intent=frozen_intent,
        journal=journal,
        bind_admission=binder,
        tool_executor=tool_executor,
    )


async def execute_generation(
    request: GenerationExecutionRequest,
    *,
    session_factory: sessionmaker[Session],
    runtime: ExecutionRuntime,
    encode_terminal: EncodeTerminal,
    encode_failure: EncodeFailure,
    observe_event: ObserveEvent | None = None,
    cancel_signal: CancellationSignal | None = None,
    before_terminal: BeforeTerminal | None = None,
    resolve_terminal: ResolveTerminal | None = None,
) -> GenerationExecutionResult:
    """Execute or exactly replay one generation without hidden redispatch."""

    replay, resume = _read_replay(session_factory, request, runtime.continuation_cipher)
    if replay is not None:
        return replay
    if cancel_signal is None or not cancel_signal.is_set():
        try:
            await runtime.admission.require_dispatch_ready(request.spec)
        except GenerationOperationUnavailable as error:
            if not isinstance(error.reason, CapacityPaused):
                raise
            return _handle_capacity_pause(
                session_factory,
                request,
                pause=error.reason,
                encode_failure=encode_failure,
                continuation_is_safe=resume is not None,
            )
    with session_factory() as db:
        request.journal.clear_capacity_pause(db)
        db.commit()
    lifecycle = _LedgerChildLifecycle(
        request=request,
        session_factory=session_factory,
        cipher=runtime.continuation_cipher,
        encode_terminal=encode_terminal,
        before_terminal=before_terminal,
        resolve_terminal=resolve_terminal,
    )
    try:
        terminal = await runtime.execute(
            GenerationBackendExecution(
                request=BackendGenerationRequest(
                    generation_id=request.generation_id,
                    spec=request.spec,
                    intent=request.intent,
                ),
                lifecycle=lifecycle,
                tool_executor=request.tool_executor or _ForbiddenToolExecutor(),
                observer=_Observer(observe_event),
                cancellation=cancel_signal or _NeverCancelled(),
                codex_bind_admission=request.bind_admission,
                provider_resume=resume,
            )
        )
    except Exception as error:
        from nexus.services.codex_generation_client import CodexGenerationCapacityUnavailable

        if isinstance(error, CodexGenerationCapacityUnavailable):
            return _capacity_refusal(
                session_factory,
                request,
                encode_failure=encode_failure,
            )
        if _journal_is_uncertain(session_factory, request):
            raise GenerationUncertain(
                f"generation {request.generation_id} failed after durable dispatch"
            ) from error
        raise
    if isinstance(terminal, GenerationStopped):
        if before_terminal is not None:
            await before_terminal()
        detail = (
            "Generation cancelled before the next dispatch."
            if terminal.reason == "cancelled"
            else "Generation reached its frozen model-turn limit."
        )
        terminal_result = encode_failure(terminal.reason, detail)
        with session_factory() as db:
            lock_generation_owner_in_current_transaction(db, request.owner)
            state = _require_journal_state(db, request)
            if terminal.last_ordinal == 0:
                if state.dispatch_phase is not Prepared:
                    raise AssertionError("undispatched cancellation has an armed owner")
            else:
                if state.dispatch_phase is not Uncertain:
                    raise AssertionError("generation stop requires its armed owner")
                stop_generation_in_current_transaction(
                    db,
                    owner=request.owner,
                    generation_id=request.generation_id,
                    source_turn_seq=terminal.last_ordinal,
                    reason=terminal.reason,
                )
            landed = request.journal.complete(
                db,
                expected=state,
                next_state=StepReplayState(
                    generation_id=request.generation_id,
                    dispatch_phase=Completed,
                    request_fingerprint=present(request.spec.fingerprint),
                    terminal_result=present(terminal_result),
                ),
            )
            if not landed:
                raise GenerationUncertain(
                    f"generation {request.generation_id} lost its claim while stopping"
                )
            db.commit()
        return CompletedGeneration(terminal_result=terminal_result, terminal=None, replayed=False)
    if lifecycle.completed is None or lifecycle.completed.terminal is not terminal:
        raise AssertionError("backend returned a terminal not committed by its lifecycle")
    if lifecycle.encoded is None:
        raise AssertionError("final terminal did not complete its owner journal")
    return CompletedGeneration(
        terminal_result=lifecycle.encoded.terminal_result,
        terminal=terminal,
        replayed=False,
    )


class _LedgerChildLifecycle:
    """Transaction owner injected into the backend child state machine."""

    def __init__(
        self,
        *,
        request: GenerationExecutionRequest,
        session_factory: sessionmaker[Session],
        cipher: GenerationContinuationCipher,
        encode_terminal: EncodeTerminal,
        before_terminal: BeforeTerminal | None,
        resolve_terminal: ResolveTerminal | None,
    ) -> None:
        self._request = request
        self._session_factory = session_factory
        self._cipher = cipher
        self._encode_terminal = encode_terminal
        self._before_terminal = before_terminal
        self._resolve_terminal = resolve_terminal
        self.completed: BackendChildCompletion | None = None
        self.encoded: EncodedGenerationTerminal | None = None

    async def arm_child(self, child: BackendChildDispatch) -> None:
        request = self._request
        _assert_child_identity(child, request)
        start = _model_turn_start(child)
        with self._session_factory() as db:
            lock_generation_owner_in_current_transaction(db, request.owner)
            state = _require_journal_state(db, request)
            if child.child_seq == 1:
                if state.dispatch_phase is not Prepared:
                    raise GenerationUncertain(
                        f"generation {request.generation_id} initial child is not Prepared"
                    )
                start_generation_in_current_transaction(
                    db,
                    GenerationStart(
                        generation_id=request.generation_id,
                        owner=request.owner,
                        spec=generation_spec_document(request.spec),
                    ),
                )
                start_model_turn_in_current_transaction(db, start)
                arm_model_turn_dispatch_in_current_transaction(
                    db,
                    generation_id=request.generation_id,
                    model_turn_id=start.model_turn_id,
                )
                landed = request.journal.arm(
                    db,
                    expected=state,
                    next_state=StepReplayState(
                        generation_id=request.generation_id,
                        dispatch_phase=Uncertain,
                        request_fingerprint=present(request.spec.fingerprint),
                        terminal_result=absent(),
                    ),
                )
                if not landed:
                    raise GenerationDispatchAborted(
                        f"generation {request.generation_id} lost its claim before dispatch"
                    )
            else:
                if state.dispatch_phase is not Uncertain:
                    raise AssertionError("provider successor requires an Uncertain owner")
                pending = read_pending_generation_continuation_in_current_transaction(
                    db,
                    generation_id=request.generation_id,
                    cipher=self._cipher,
                )
                if pending is None:
                    raise GenerationUncertain(
                        f"generation {request.generation_id} has no reopenable successor"
                    )
                arm_resumed_model_turn_dispatch_in_current_transaction(
                    db,
                    source_model_turn_id=pending.source_turn.id,
                    successor=start,
                )
            db.commit()

    async def complete_child(
        self,
        completion: BackendChildCompletion,
    ) -> BackendChildCompletion:
        request = self._request
        _assert_child_identity(completion.child, request)
        is_final = isinstance(completion.successor, Absent)
        if is_final and self._before_terminal is not None:
            await self._before_terminal()
        with self._session_factory() as db:
            lock_generation_owner_in_current_transaction(db, request.owner)
            state = _require_journal_state(db, request)
            if state.dispatch_phase is not Uncertain:
                raise AssertionError("model child terminal requires an Uncertain owner")
            effective_terminal = _terminal_for_durable_landing(completion.terminal)
            effective = BackendChildCompletion(
                child=completion.child,
                terminal=effective_terminal,
                successor=completion.successor,
            )
            sealed = absent()
            if isinstance(effective.successor, Present):
                material = effective.successor.value
                sealed = present(
                    self._cipher.seal(
                        canonical_continuation=material.canonical_bytes,
                        context=_continuation_context(material.identity),
                    )
                )
            child_terminal, usage, billability, accepted_at = _child_terminal_documents(
                effective_terminal
            )
            complete_model_turn_in_current_transaction(
                db,
                generation_id=request.generation_id,
                model_turn_id=_model_turn_id(request.generation_id, completion.child.child_seq),
                completion=ModelTurnCompletion(
                    terminal=child_terminal,
                    usage=usage,
                    billability=billability,
                    accepted_at=accepted_at,
                    successor=sealed,
                ),
            )
            encoded: EncodedGenerationTerminal | None = None
            if is_final:
                encoded = (
                    self._resolve_terminal(db, effective_terminal)
                    if self._resolve_terminal is not None
                    else self._encode_terminal(effective_terminal)
                )
                complete_generation_in_current_transaction(
                    db,
                    owner=request.owner,
                    generation_id=request.generation_id,
                    terminal=_parent_terminal_document(
                        child_terminal,
                        final_child_seq=completion.child.child_seq,
                        accepted_failure=encoded.accepted_failure,
                        orchestration_stop=encoded.orchestration_stop,
                    ),
                )
                landed = request.journal.complete(
                    db,
                    expected=state,
                    next_state=StepReplayState(
                        generation_id=request.generation_id,
                        dispatch_phase=Completed,
                        request_fingerprint=present(request.spec.fingerprint),
                        terminal_result=present(encoded.terminal_result),
                    ),
                )
                if not landed:
                    raise GenerationUncertain(
                        f"generation {request.generation_id} lost its claim at terminal"
                    )
            db.commit()
        self.completed = effective
        if encoded is not None:
            self.encoded = encoded
        return effective

    async def open_successor(self, identity: ProviderContinuationIdentity) -> bytes:
        request = self._request
        if identity.generation_id != request.generation_id:
            raise AssertionError("provider continuation belongs to another generation")
        with self._session_factory() as db:
            lock_generation_owner_in_current_transaction(db, request.owner)
            source = next(
                (
                    turn
                    for turn in read_model_turns(db, generation_id=request.generation_id)
                    if turn.turn_seq == identity.source_child_seq
                ),
                None,
            )
            if source is None:
                raise AssertionError("provider continuation source child is missing")
            opened = open_generation_continuation_in_current_transaction(
                db,
                source_model_turn_id=source.id,
                expected_context=_continuation_context(identity),
                cipher=self._cipher,
            )
            db.commit()
            return opened


def _read_replay(
    session_factory: sessionmaker[Session],
    request: GenerationExecutionRequest,
    cipher: GenerationContinuationCipher,
) -> tuple[CompletedGeneration | None, ProviderResumeState | None]:
    with session_factory() as db:
        lock_generation_owner_in_current_transaction(db, request.owner)
        state = _require_journal_state(db, request)
        if state.dispatch_phase is Prepared:
            return None, None
        if state.dispatch_phase is Completed:
            if not isinstance(state.terminal_result, Present):
                raise AssertionError("Completed generation has no terminal memo")
            return (
                CompletedGeneration(
                    terminal_result=state.terminal_result.value,
                    terminal=None,
                    replayed=True,
                ),
                None,
            )
        if state.dispatch_phase is not Uncertain:
            raise AssertionError(f"unknown generation phase {state.dispatch_phase!r}")
        if not isinstance(request.spec.selection, ProviderApiSelection):
            raise GenerationUncertain(
                f"generation {request.generation_id} has an unresolved Codex dispatch"
            )
        pending = read_pending_generation_continuation_in_current_transaction(
            db,
            generation_id=request.generation_id,
            cipher=cipher,
        )
        if pending is None:
            raise GenerationUncertain(
                f"generation {request.generation_id} has an unresolved provider dispatch"
            )
        context = pending.context
        resume = ProviderResumeState(
            identity=ProviderContinuationIdentity(
                generation_id=context.generation_id,
                source_child_seq=context.source_turn_seq,
                successor_child_seq=context.successor_turn_seq,
                target_fingerprint=context.target_fingerprint,
                codec_id=context.codec_id,
                policy_revision=context.policy_revision,
                canonical_fingerprint=provider_turn_continuation_fingerprint(
                    pending.canonical_continuation
                ),
            ),
            canonical_bytes=pending.canonical_continuation,
        )
        db.commit()
        return None, resume


def _capacity_refusal(
    session_factory: sessionmaker[Session],
    request: GenerationExecutionRequest,
    *,
    encode_failure: EncodeFailure,
) -> GenerationExecutionResult:
    """Park background quota or close Chat before model-call admission."""

    if _journal_is_uncertain(session_factory, request):
        raise GenerationUncertain(
            f"generation {request.generation_id} reported capacity after admission"
        )
    detail = "Codex Personal capacity is currently unavailable"
    return _handle_capacity_pause(
        session_factory,
        request,
        pause=_fallback_capacity_pause(detail),
        encode_failure=encode_failure,
        continuation_is_safe=False,
    )


def _handle_capacity_pause(
    session_factory: sessionmaker[Session],
    request: GenerationExecutionRequest,
    *,
    pause: CapacityPaused,
    encode_failure: EncodeFailure,
    continuation_is_safe: bool,
) -> GenerationExecutionResult:
    if request.owner.kind != "chat_run" or continuation_is_safe:
        with session_factory() as db:
            request.journal.park_capacity_pause(db, pause)
            db.commit()
        if request.owner.kind == "artifact_learn_request":
            raise GenerationCapacityPaused(pause)
        return RescheduleRequested(schedule=GenerationCapacityPaused(pause).schedule)
    terminal_result = encode_failure(
        "capacity_unavailable",
        pause.explanation,
    )
    with session_factory() as db:
        lock_generation_owner_in_current_transaction(db, request.owner)
        state = _require_journal_state(db, request)
        if state.dispatch_phase is not Prepared:
            raise AssertionError("Chat capacity refusal is not pre-admission")
        landed = request.journal.complete(
            db,
            expected=state,
            next_state=StepReplayState(
                generation_id=request.generation_id,
                dispatch_phase=Completed,
                request_fingerprint=present(request.spec.fingerprint),
                terminal_result=present(terminal_result),
            ),
        )
        if not landed:
            raise GenerationDispatchAborted(
                f"generation {request.generation_id} lost its claim at capacity refusal"
            )
        db.commit()
    return CompletedGeneration(terminal_result=terminal_result, terminal=None, replayed=False)


def _fallback_capacity_pause(explanation: str) -> CapacityPaused:
    observed_at = datetime.now(UTC)
    return CapacityPaused(
        explanation=explanation,
        reset_at=absent(),
        next_check_at=observed_at + timedelta(seconds=BACKGROUND_CAPACITY_PROBE_SECONDS),
        last_checked=observed_at,
    )


def _journal_is_uncertain(
    session_factory: sessionmaker[Session],
    request: GenerationExecutionRequest,
) -> bool:
    with session_factory() as db:
        return _require_journal_state(db, request).dispatch_phase is Uncertain


def _require_journal_state(db: Session, request: GenerationExecutionRequest) -> StepReplayState:
    state = request.journal.read(db)
    if state is None:
        raise AssertionError("generation execution requires a Prepared checkpoint")
    _assert_identity(
        state, generation_id=request.generation_id, fingerprint=request.spec.fingerprint
    )
    return state


def _assert_identity(
    state: StepReplayState,
    *,
    generation_id: UUID,
    fingerprint: str,
) -> None:
    if state.generation_id != generation_id:
        raise AssertionError("generation journal identity differs from request")
    if not isinstance(state.request_fingerprint, Present):
        raise AssertionError("generation journal has no request fingerprint")
    if state.request_fingerprint.value != fingerprint:
        raise AssertionError("generation journal request fingerprint drifted")


def _assert_frozen_admission(
    observed: tuple[GenerationSpec, GenerationIntent],
    *,
    spec: GenerationSpec,
    intent: GenerationIntent,
) -> None:
    observed_spec, observed_intent = observed
    if observed_spec != spec:
        raise AssertionError("frozen generation admission changed concurrently")
    if observed_intent != intent:
        raise GenerationAdmissionInputsChanged(
            "domain prompt changed after the generation was Prepared"
        )
    expected_payload_digest = generation_fact_digest(intent.model_dump(mode="json"))
    if spec.prompt_payload_ref.payload_digest != expected_payload_digest:
        raise AssertionError("frozen prompt payload reference differs from its intent")


def _model_turn_id(generation_id: UUID, child_seq: int) -> UUID:
    return uuid5(generation_id, f"{_MODEL_TURN_COMPONENT}/{child_seq}")


def _model_turn_start(child: BackendChildDispatch) -> ModelTurnStart:
    return ModelTurnStart(
        model_turn_id=_model_turn_id(child.generation_id, child.child_seq),
        generation_id=child.generation_id,
        turn_seq=child.child_seq,
        request_fingerprint=child.request_fingerprint,
        route_request_identity=child.route_request_identity,
    )


def _assert_child_identity(
    child: BackendChildDispatch,
    request: GenerationExecutionRequest,
) -> None:
    if child.generation_id != request.generation_id:
        raise AssertionError("backend child belongs to another generation")
    if child.route != request.spec.selection.route:
        raise AssertionError("backend child route differs from frozen selection")


def _continuation_context(
    identity: ProviderContinuationIdentity,
) -> GenerationContinuationContext:
    return GenerationContinuationContext(
        generation_id=identity.generation_id,
        source_turn_seq=identity.source_child_seq,
        successor_turn_seq=identity.successor_child_seq,
        target_fingerprint=identity.target_fingerprint,
        codec_id=identity.codec_id,
        policy_revision=identity.policy_revision,
    )


def _terminal_for_durable_landing(terminal: BackendTerminal) -> BackendTerminal:
    if isinstance(terminal.evidence, ProviderTerminalEvidence):
        return terminal
    if not isinstance(terminal.evidence, CodexTerminalEvidence):
        assert_never(terminal.evidence)
    native = terminal.evidence.native
    detail = retained_terminal_error_detail(native)
    sanitized = GenerationTerminal.model_validate(
        {**native.model_dump(mode="json"), "diagnostics": [] if detail is None else [detail]}
    )
    return BackendTerminal(
        route=terminal.route,
        child_seq=terminal.child_seq,
        backend_seq=terminal.backend_seq,
        evidence=CodexTerminalEvidence(native=sanitized),
    )


def codex_terminal_evidence(terminal: BackendTerminal) -> GenerationTerminal:
    """Require and unwrap a Codex terminal at a Codex-only domain boundary."""

    if not isinstance(terminal.evidence, CodexTerminalEvidence):
        raise AssertionError("Codex-only operation received a ProviderApi terminal")
    return terminal.evidence.native


def _child_terminal_documents(
    terminal: BackendTerminal,
) -> tuple[
    dict[str, object],
    Present[Mapping[str, object]] | Absent,
    Present[Mapping[str, object]] | Absent,
    Present[datetime] | Absent,
]:
    if isinstance(terminal.evidence, CodexTerminalEvidence):
        native = terminal.evidence.native
        outcome = {
            "succeeded": "Succeeded",
            "failed": "Failed",
            "cancelled": "Cancelled",
        }[native.status]
        document: dict[str, object] = {
            "kind": outcome,
            "route": terminal.route,
            "child_seq": terminal.child_seq,
            "backend_seq": terminal.backend_seq,
            "evidence": native.model_dump(mode="json"),
        }
        if outcome == "Failed":
            document["failure_code"] = (
                normalized_failure(native.failure.kind)
                if native.failure is not None
                else "backend_failed"
            )
        usage: Present[Mapping[str, object]] | Absent = (
            absent() if native.usage is None else present(native.usage.model_dump(mode="json"))
        )
        return (
            document,
            usage,
            present({"kind": "Subscription"}),
            present(datetime.fromisoformat(native.accepted_at[:-1] + "+00:00")),
        )
    if not isinstance(terminal.evidence, ProviderTerminalEvidence):
        assert_never(terminal.evidence)
    native_outcome = terminal.evidence.outcome
    if isinstance(native_outcome, ProviderSucceeded):
        outcome, failure_code = "Succeeded", None
    elif isinstance(native_outcome, ProviderCancelled):
        outcome, failure_code = "Cancelled", None
    elif isinstance(native_outcome, ProviderIncomplete):
        outcome = "Failed"
        failure_code = (
            "output_limit_exceeded"
            if native_outcome.reason == "max_output_tokens"
            else "content_filter_partial"
        )
    elif isinstance(native_outcome, ProviderFailed):
        outcome, failure_code = "Failed", _provider_failure_code(native_outcome.failure)
    else:
        assert_never(native_outcome)
    document = {
        "kind": outcome,
        "route": terminal.route,
        "child_seq": terminal.child_seq,
        "backend_seq": terminal.backend_seq,
        "evidence": _json_value(native_outcome),
        "correlation": _json_value(terminal.evidence.correlation),
    }
    if outcome == "Failed":
        document["failure_code"] = failure_code
    meta = native_outcome.meta
    usage = (
        present(_json_mapping(meta.usage.value))
        if isinstance(meta.usage, RuntimePresent)
        else absent()
    )
    return document, usage, present({"kind": type(meta.billability).__name__}), absent()


def _parent_terminal_document(
    child_terminal: Mapping[str, object],
    *,
    final_child_seq: int,
    accepted_failure: AcceptedGenerationFailure | None,
    orchestration_stop: Literal["cancelled"] | None = None,
) -> dict[str, object]:
    if orchestration_stop is not None:
        return {
            "kind": "Cancelled",
            "orchestration_stop": orchestration_stop,
            "final_model_turn_seq": final_child_seq,
            "model_turn_terminal": dict(child_terminal),
        }
    if accepted_failure is None:
        document = {
            "kind": child_terminal["kind"],
            "final_model_turn_seq": final_child_seq,
            "model_turn_terminal": dict(child_terminal),
        }
        if child_terminal["kind"] == "Failed":
            document["failure_code"] = child_terminal["failure_code"]
        return document
    return {
        "kind": "Failed",
        "failure_code": accepted_failure.code,
        "failure_detail": accepted_failure.detail,
        "final_model_turn_seq": final_child_seq,
        "model_turn_terminal": dict(child_terminal),
    }


def _provider_failure_code(failure: ExpectedModelFailure) -> ProviderFailureCode:
    if isinstance(failure, ProviderContextTooLarge):
        return "context_too_large"
    if isinstance(failure, InvalidToolArguments):
        return "invalid_tool_arguments"
    if isinstance(failure, InvalidStructuredOutput):
        return "invalid_structured_output"
    if isinstance(failure, TransientExhausted):
        cause = failure.cause
        if isinstance(cause, ProviderRateLimit):
            return "rate_limited"
        if isinstance(cause, ProviderTimeout):
            return "timeout"
        if isinstance(cause, ProviderHttpUnavailable | TransportUnavailable):
            return "provider_unavailable"
        if isinstance(cause, ProviderStreamInterrupted):
            return "stream_interrupted"
        assert_never(cause)
    assert_never(failure)


def _json_mapping(value: object) -> Mapping[str, object]:
    encoded = _json_value(value)
    if not isinstance(encoded, dict):
        raise AssertionError("expected a JSON object at generation ledger boundary")
    return encoded


def _json_value(value: object) -> object:
    """Closed recursive projection that refuses continuation material."""

    if value is None or isinstance(value, bool | int | float | str):
        return value
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, date | datetime):
        return value.isoformat()
    if isinstance(value, bytes):
        raise AssertionError("binary material cannot enter terminal evidence")
    if type(value).__name__ == "ContinuationArtifact":
        raise AssertionError("provider continuation cannot enter terminal evidence")
    if isinstance(value, RuntimeAbsent | Absent):
        return {"kind": "Absent"}
    if isinstance(value, RuntimePresent | Present):
        return {"kind": "Present", "value": _json_value(value.value)}
    if isinstance(value, BaseModel):
        return _json_value(value.model_dump(mode="json", by_alias=True))
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {
            item.name: _json_value(getattr(value, item.name))
            for item in dataclasses.fields(value)
            if item.name != "continuation"
        }
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise AssertionError("terminal evidence has a non-text key")
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, tuple | list):
        return [_json_value(item) for item in value]
    raise AssertionError(f"unsupported terminal evidence type {type(value).__name__}")


class _Observer(BackendEventObserver):
    def __init__(self, callback: ObserveEvent | None) -> None:
        self._callback = callback

    async def observe(self, event: BackendEvent) -> None:
        if self._callback is not None:
            await self._callback(event)


class _ForbiddenToolExecutor:
    async def execute(
        self,
        request: BackendToolExecutionRequest,
    ) -> BackendToolExecutionResult:
        del request
        raise AssertionError("NoModelTools backend attempted direct tool execution")


class _NeverCancelled:
    async def wait(self) -> bool:
        import asyncio

        await asyncio.Future()
        return False

    def is_set(self) -> bool:
        return False


def prove_uncertain_generation_not_dispatched_in_current_transaction(
    db: Session,
    *,
    owner: LlmCallOwner,
    state: StepReplayState,
) -> StepReplayState:
    """Accept proof only when no model child was durably armed."""

    lock_generation_owner_in_current_transaction(db, owner)
    if state.dispatch_phase is not Uncertain:
        raise AssertionError("generation reconciliation requires Uncertain")
    if not isinstance(state.request_fingerprint, Present):
        raise AssertionError("generation reconciliation has no fingerprint")
    generation = lock_generation_for_authority_in_current_transaction(
        db,
        owner=owner,
        generation_id=state.generation_id,
    )
    if generation is None or generation.spec.fingerprint != state.request_fingerprint.value:
        raise AssertionError("generation reconciliation identity drifted")
    reset_generation_after_proven_non_dispatch_in_current_transaction(
        db,
        owner=owner,
        generation_id=state.generation_id,
        generation_fingerprint=state.request_fingerprint.value,
    )
    return StepReplayState(
        generation_id=state.generation_id,
        dispatch_phase=Prepared,
        request_fingerprint=state.request_fingerprint,
        terminal_result=absent(),
    )


def cancel_prepared_generation_without_dispatch_in_current_transaction(
    db: Session,
    *,
    owner: LlmCallOwner,
    state: StepReplayState,
    terminal_result: str,
) -> StepReplayState:
    """Close a Prepared owner only when no model child was armed."""

    lock_generation_owner_in_current_transaction(db, owner)
    if state.dispatch_phase is not Prepared:
        raise AssertionError("pre-admission cancellation requires Prepared")
    generation = lock_generation_for_authority_in_current_transaction(
        db,
        owner=owner,
        generation_id=state.generation_id,
    )
    if generation is not None:
        raise AssertionError("Prepared generation journal unexpectedly has ledger evidence")
    return StepReplayState(
        generation_id=state.generation_id,
        dispatch_phase=Completed,
        request_fingerprint=state.request_fingerprint,
        terminal_result=present(terminal_result),
    )


def reconcile_uncertain_generation_in_current_transaction(
    db: Session,
    request: GenerationReconciliationRequest,
    *,
    encode_terminal: EncodeTerminal,
) -> StepReplayState:
    """Stage one exact Codex terminal repair in the caller-owned transaction."""

    if isinstance(request.resolution, ProveNotDispatched):
        return prove_uncertain_generation_not_dispatched_in_current_transaction(
            db,
            owner=request.owner,
            state=request.state,
        )
    state = request.state
    if state.dispatch_phase is not Uncertain:
        raise AssertionError("generation reconciliation requires Uncertain")
    if request.draft.request_id != state.generation_id:
        raise AssertionError("generation reconciliation draft identity drifted")
    _assert_identity(
        state,
        generation_id=request.draft.request_id,
        fingerprint=request.draft.spec.fingerprint,
    )
    if request.resolution.latency_ms > (
        request.draft.spec.bounds.transport_deadline_seconds * 1_000
    ):
        raise ValueError("reconciled generation latency exceeds its transport deadline")
    from nexus.services.codex_generation_client import (
        decode_reconciled_generation_terminal_evidence,
    )

    native = decode_reconciled_generation_terminal_evidence(
        raw_stream=request.resolution.raw_stream,
        raw_stream_sha256=request.resolution.raw_stream_sha256,
        command=request.draft,
    )
    terminal = _terminal_for_durable_landing(
        BackendTerminal(
            route="CodexPersonal",
            child_seq=1,
            backend_seq=1,
            evidence=CodexTerminalEvidence(native=native),
        )
    )
    encoded = encode_terminal(terminal)
    lock_generation_owner_in_current_transaction(db, request.owner)
    generation = lock_generation_for_authority_in_current_transaction(
        db,
        owner=request.owner,
        generation_id=state.generation_id,
    )
    if generation is None or generation.spec.fingerprint != request.draft.spec.fingerprint:
        raise AssertionError("generation reconciliation ledger identity drifted")
    turns = read_model_turns(db, generation_id=state.generation_id)
    if len(turns) != 1 or turns[0].turn_seq != 1:
        raise AssertionError("Codex reconciliation requires exactly one model child")
    if turns[0].dispatch_started_at is None or turns[0].terminal is not None:
        raise AssertionError("Codex reconciliation child is not unresolved and armed")
    child_terminal, usage, billability, accepted_at = _child_terminal_documents(terminal)
    complete_model_turn_in_current_transaction(
        db,
        generation_id=state.generation_id,
        model_turn_id=turns[0].id,
        completion=ModelTurnCompletion(
            terminal=child_terminal,
            usage=usage,
            billability=billability,
            accepted_at=accepted_at,
            successor=absent(),
        ),
    )
    complete_generation_in_current_transaction(
        db,
        owner=request.owner,
        generation_id=state.generation_id,
        terminal=_parent_terminal_document(
            child_terminal,
            final_child_seq=1,
            accepted_failure=encoded.accepted_failure,
            orchestration_stop=encoded.orchestration_stop,
        ),
    )
    return StepReplayState(
        generation_id=state.generation_id,
        dispatch_phase=Completed,
        request_fingerprint=state.request_fingerprint,
        terminal_result=present(encoded.terminal_result),
    )


def _assert_expected_state(observed: StepReplayState | None, expected: StepReplayState) -> None:
    if observed != expected:
        raise AssertionError("generation journal changed during checkpoint transition")


__all__ = [
    "AcceptedGenerationFailure",
    "AttachReconciledGenerationTerminal",
    "BindAdmission",
    "CancellationSignal",
    "CompletedGeneration",
    "ComposedExecutionRuntime",
    "EncodedGenerationTerminal",
    "ExecutionRuntime",
    "GenerationDispatchAborted",
    "GenerationAdmissionInputsChanged",
    "GenerationAdmissionJournal",
    "GenerationCapacityPaused",
    "GenerationExecutionRequest",
    "GenerationExecutionResult",
    "GenerationJournal",
    "GenerationReconciliationRequest",
    "GenerationUncertain",
    "GenerationUncertainResolution",
    "JobGenerationJournal",
    "admit_job_generation",
    "cancel_prepared_generation_without_dispatch_in_current_transaction",
    "codex_terminal_evidence",
    "execute_generation",
    "prove_uncertain_generation_not_dispatched_in_current_transaction",
    "read_capacity_pauses",
    "reconcile_uncertain_generation_in_current_transaction",
]
