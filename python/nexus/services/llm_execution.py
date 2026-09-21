"""Durable, route-neutral execution for one frozen ``GenerationSpec``.

The sole bridge between a domain-owned replay journal and the shared
Codex/provider backend. It owns parent/child ledger transactions, continuation
sealing, and terminal publication; it never resolves mutable policy, selects
another model, or holds a transaction across external I/O.
"""

from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import json
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from enum import Enum
from typing import TYPE_CHECKING, Literal, Protocol, assert_never
from uuid import UUID, uuid5

from llm_agent_kernel.generation import GenerationStopped
from provider_runtime.types import Absent as RuntimeAbsent
from provider_runtime.types import Cancelled as ProviderCancelled
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
from provider_runtime.types import Failed as ProviderFailed
from provider_runtime.types import FailureCode as ProviderFailureCode
from provider_runtime.types import Incomplete as ProviderIncomplete
from provider_runtime.types import Present as RuntimePresent
from provider_runtime.types import Succeeded as ProviderSucceeded
from pydantic import BaseModel
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
    GenerationTerminal,
    NormalizedFailureCode,
    normalized_failure,
)
from nexus.services.durable_step_journal import (
    Completed,
    Prepared,
    StepReplayState,
    Uncertain,
    checkpoint_step_state,
    payload_with_step_state,
    read_step_states,
)
from nexus.services.generation_backend import (
    BackendChildCompletion,
    BackendChildDispatch,
    BackendEvent,
    BackendTerminal,
    BackendToolExecutionRequest,
    BackendToolExecutionResult,
    BackendToolExecutor,
    CodexAdmissionBinder,
    CodexTerminalEvidence,
    ProviderContinuationIdentity,
    ProviderResumeState,
    ProviderTerminalEvidence,
)
from nexus.services.generation_continuations import (
    GenerationContinuationCipher,
    GenerationContinuationContext,
)
from nexus.services.generation_policy import BACKGROUND_CAPACITY_PROBE_SECONDS
from nexus.services.generation_spec import (
    BackgroundOperationKey,
    FrozenHostToolPlanSnapshot,
    FrozenToolScope,
    GenerationIntent,
    GenerationSpec,
    ImmutablePromptPayloadRef,
    ProviderApiSelection,
    decode_generation_spec_document,
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
    lock_generation_for_authority_in_current_transaction,
    lock_generation_owner_in_current_transaction,
    open_generation_continuation_in_current_transaction,
    read_model_turns,
    read_pending_generation_continuation_in_current_transaction,
    start_generation_in_current_transaction,
    start_model_turn_in_current_transaction,
    stop_generation_in_current_transaction,
)
from nexus.services.provider_generation_contract import provider_turn_continuation_fingerprint

if TYPE_CHECKING:
    from nexus.services.generation_backend import GenerationBackend
    from nexus.services.generation_service import GenerationService

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
    """Fully composed backend plus shared admission and continuation authorities."""

    @property
    def backend(self) -> GenerationBackend: ...

    @property
    def continuation_cipher(self) -> GenerationContinuationCipher: ...

    @property
    def admission(self) -> GenerationService: ...


@dataclass(frozen=True, slots=True)
class ComposedExecutionRuntime:
    backend: GenerationBackend
    continuation_cipher: GenerationContinuationCipher = field(repr=False)
    admission: GenerationService


class CancellationSignal(Protocol):
    async def wait(self) -> bool: ...

    def is_set(self) -> bool: ...


class GenerationAdmissionJournal(Protocol):
    """Domain replay journal owning prompt/spec admission beside replay state.

    Implemented by ``JobGenerationJournal`` over ``background_jobs.payload``.
    Implementations never commit or roll back.
    """

    def read(self, db: Session) -> StepReplayState | None: ...

    def arm(
        self, db: Session, *, expected: StepReplayState, next_state: StepReplayState
    ) -> bool: ...

    def complete(
        self, db: Session, *, expected: StepReplayState, next_state: StepReplayState
    ) -> bool: ...

    def read_admission(self, db: Session) -> tuple[GenerationSpec, GenerationIntent] | None: ...

    def prepare_admission(
        self, db: Session, *, generation_id: UUID, spec: GenerationSpec, intent: GenerationIntent
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
        return read_step_states(self._job(db)).get(self.step_path)

    def arm(self, db: Session, *, expected: StepReplayState, next_state: StepReplayState) -> bool:
        job = self.lock_dispatch(db)
        if job is None or not lock_running_job_claim(db, context=self.context):
            return False
        _assert_expected_state(read_step_states(job).get(self.step_path), expected)
        return checkpoint_step_state(
            db, ctx=self.context, job=job, step_path=self.step_path, state=next_state
        )

    def complete(
        self, db: Session, *, expected: StepReplayState, next_state: StepReplayState
    ) -> bool:
        if not lock_running_job_claim(db, context=self.context):
            return False
        job = self._job(db)
        _assert_expected_state(read_step_states(job).get(self.step_path), expected)
        return checkpoint_step_state(
            db, ctx=self.context, job=job, step_path=self.step_path, state=next_state
        )

    def read_admission(self, db: Session) -> tuple[GenerationSpec, GenerationIntent] | None:
        """Read the one exact prompt/spec pair owned by this step path."""

        raw_admissions = self._job(db).payload.get("generation_admissions")
        raw = raw_admissions.get(self.step_path) if isinstance(raw_admissions, dict) else None
        if raw is None:
            if self.read(db) is not None:
                raise AssertionError("generation step exists without its frozen admission")
            return None
        if not isinstance(raw, dict) or set(raw) != {"spec", "intent"}:
            raise AssertionError("frozen generation admission has invalid fields")
        return (
            decode_generation_spec_document(raw["spec"]),
            GenerationIntent.model_validate(raw["intent"]),
        )

    def prepare_admission(
        self, db: Session, *, generation_id: UUID, spec: GenerationSpec, intent: GenerationIntent
    ) -> tuple[GenerationSpec, GenerationIntent]:
        """Persist prompt/spec and Prepared state in the lease-fenced transaction."""

        job = self.lock_dispatch(db)
        if job is None or not lock_running_job_claim(db, context=self.context):
            raise GenerationDispatchAborted(
                f"generation {generation_id} lost its claim before admission"
            )
        observed = self.read_admission(db)
        if observed is not None:
            if observed[0] != spec:
                raise AssertionError("frozen generation admission changed concurrently")
            if observed[1] != intent:
                raise GenerationAdmissionInputsChanged(
                    "domain prompt changed after the generation was Prepared"
                )
            self.clear_capacity_pause(db)
            return observed
        if read_step_states(job).get(self.step_path) is not None:
            raise AssertionError("generation admission collided with an existing step")
        admissions = job.payload.get("generation_admissions", {})
        if not isinstance(admissions, dict):
            raise AssertionError("generation_admissions payload is not an object")
        payload = payload_with_step_state(
            {
                **_payload_without_capacity_pause(job.payload, step_path=self.step_path),
                "generation_admissions": {
                    **admissions,
                    self.step_path: {
                        "spec": spec.model_dump(mode="json", by_alias=True),
                        "intent": intent.model_dump(mode="json", by_alias=True),
                    },
                },
            },
            step_path=self.step_path,
            state=StepReplayState(
                generation_id=generation_id,
                dispatch_phase=Prepared,
                request_fingerprint=present(spec.fingerprint),
                terminal_result=absent(),
            ),
        )
        self._write_payload(db, payload, "before admission")
        return spec, intent

    def park_capacity_pause(self, db: Session, pause: CapacityPaused) -> None:
        job = self.lock_dispatch(db)
        if job is None or not lock_running_job_claim(db, context=self.context):
            raise GenerationDispatchAborted("generation lost its claim while parking capacity")
        raw = job.payload.get("generation_capacity_pauses", {})
        if not isinstance(raw, dict):
            raise AssertionError("generation_capacity_pauses payload is not an object")
        self._write_payload(
            db,
            {
                **job.payload,
                "generation_capacity_pauses": {
                    **raw,
                    self.step_path: pause.model_dump(mode="json"),
                },
            },
            "while parking capacity",
        )

    def clear_capacity_pause(self, db: Session) -> None:
        job = self.lock_dispatch(db)
        if job is None or not lock_running_job_claim(db, context=self.context):
            raise GenerationDispatchAborted("generation lost its claim while clearing capacity")
        payload = _payload_without_capacity_pause(job.payload, step_path=self.step_path)
        if payload != job.payload:
            self._write_payload(db, payload, "while clearing capacity")

    def _job(self, db: Session) -> JobRow:
        job = get_job(db, self.context.job_id)
        if job is None:
            raise AssertionError(f"generation job {self.context.job_id} disappeared")
        return job

    def _write_payload(self, db: Session, payload: dict[str, object], phase: str) -> None:
        if not update_running_job_payload(
            db,
            job_id=self.context.job_id,
            worker_id=self.context.worker_id,
            attempt_no=self.context.attempt_no,
            payload=payload,
        ):
            raise GenerationDispatchAborted(f"generation lost its claim {phase}")


def read_capacity_pauses(payload: Mapping[str, object]) -> dict[str, CapacityPaused]:
    """Decode every durable pause parked by ``park_capacity_pause``, by step path."""

    raw = payload.get("generation_capacity_pauses")
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise AssertionError("generation_capacity_pauses payload is not an object")
    pauses: dict[str, CapacityPaused] = {}
    for step_path, value in raw.items():
        try:
            encoded = json.dumps(value, ensure_ascii=True, allow_nan=False, sort_keys=True)
        except (TypeError, ValueError) as error:
            raise AssertionError(
                f"capacity pause for step {step_path!r} is not JSON data"
            ) from error
        pauses[step_path] = CapacityPaused.model_validate_json(encoded)
    return pauses


def _payload_without_capacity_pause(
    payload: Mapping[str, object], *, step_path: str
) -> dict[str, object]:
    next_payload = dict(payload)
    raw = next_payload.get("generation_capacity_pauses")
    if raw is None:
        return next_payload
    if not isinstance(raw, dict):
        raise AssertionError("generation_capacity_pauses payload is not an object")
    pauses = {key: value for key, value in raw.items() if key != step_path}
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
        return ScheduleAt(
            self.pause.reset_at.value
            if isinstance(self.pause.reset_at, Present)
            else self.pause.next_check_at
        )


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
    host_plan: FrozenHostToolPlanSnapshot | None = None,
    host_evidence_revision: str | None = None,
    bind_admission_factory: BindAdmissionFactory | None = None,
    tool_executor_factory: ToolExecutorFactory | None = None,
) -> GenerationExecutionRequest:
    """Freeze and persist one background admission before any backend I/O.

    The catalog read happens outside the transaction; the second, fenced read
    handles a concurrent winner and stops policy drift from replacing an
    already Prepared generation.
    """

    with session_factory() as db:
        observed = journal.read_admission(db)
    if observed is None:
        candidate = await runtime.admission.freeze_background(
            operation=operation,
            intent=intent,
            prompt_template_revision=prompt_template_revision,
            prompt_payload_ref=prompt_payload_ref,
            scope=scope,
            host_plan=host_plan,
            host_evidence_revision=host_evidence_revision,
        )
        with session_factory() as db:
            lock_generation_owner_in_current_transaction(db, owner)
            spec, frozen_intent = journal.prepare_admission(
                db, generation_id=generation_id, spec=candidate, intent=intent
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
    return GenerationExecutionRequest(
        owner=owner,
        generation_id=generation_id,
        spec=spec,
        intent=frozen_intent,
        journal=journal,
        bind_admission=(
            bind_admission_factory(spec)
            if has_tools and is_codex and bind_admission_factory is not None
            else None
        ),
        tool_executor=(
            tool_executor_factory(spec)
            if has_tools and not is_codex and tool_executor_factory is not None
            else None
        ),
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
        await runtime.admission.require_dispatch_ready(request.spec)
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
        terminal = await runtime.backend.execute(
            generation_id=request.generation_id,
            spec=request.spec,
            intent=request.intent,
            lifecycle=lifecycle,
            tool_executor=request.tool_executor or _ForbiddenToolExecutor(),
            observe=observe_event or _ignore_event,
            cancellation=cancel_signal or _NeverCancelled(),
            codex_bind_admission=request.bind_admission,
            provider_resume=resume,
        )
    except Exception as error:
        from nexus.services.codex_generation_client import CodexGenerationCapacityUnavailable

        if isinstance(error, CodexGenerationCapacityUnavailable):
            return _capacity_refusal(session_factory, request, encode_failure=encode_failure)
        if _journal_is_uncertain(session_factory, request):
            raise GenerationUncertain(
                f"generation {request.generation_id} failed after durable dispatch"
            ) from error
        raise
    if isinstance(terminal, GenerationStopped):
        return await _complete_stop(
            session_factory,
            request,
            terminal=terminal,
            encode_failure=encode_failure,
            before_terminal=before_terminal,
        )
    if lifecycle.completed is None or lifecycle.completed.terminal is not terminal:
        raise AssertionError("backend returned a terminal not committed by its lifecycle")
    if lifecycle.encoded is None:
        raise AssertionError("final terminal did not complete its owner journal")
    return CompletedGeneration(
        terminal_result=lifecycle.encoded.terminal_result, terminal=terminal, replayed=False
    )


async def _complete_stop(
    session_factory: sessionmaker[Session],
    request: GenerationExecutionRequest,
    *,
    terminal: GenerationStopped[BackendTerminal],
    encode_failure: EncodeFailure,
    before_terminal: BeforeTerminal | None,
) -> CompletedGeneration:
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
        if not request.journal.complete(
            db,
            expected=state,
            next_state=StepReplayState(
                generation_id=request.generation_id,
                dispatch_phase=Completed,
                request_fingerprint=present(request.spec.fingerprint),
                terminal_result=present(terminal_result),
            ),
        ):
            raise GenerationUncertain(
                f"generation {request.generation_id} lost its claim while stopping"
            )
        db.commit()
    return CompletedGeneration(terminal_result=terminal_result, terminal=None, replayed=False)


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
        start = ModelTurnStart(
            model_turn_id=_model_turn_id(child.generation_id, child.child_seq),
            generation_id=child.generation_id,
            turn_seq=child.child_seq,
            request_fingerprint=child.request_fingerprint,
            route_request_identity=child.route_request_identity,
        )
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
                        generation_id=request.generation_id, owner=request.owner, spec=request.spec
                    ),
                )
                start_model_turn_in_current_transaction(db, start)
                arm_model_turn_dispatch_in_current_transaction(
                    db, generation_id=request.generation_id, model_turn_id=start.model_turn_id
                )
                if not request.journal.arm(
                    db,
                    expected=state,
                    next_state=StepReplayState(
                        generation_id=request.generation_id,
                        dispatch_phase=Uncertain,
                        request_fingerprint=present(request.spec.fingerprint),
                        terminal_result=absent(),
                    ),
                ):
                    raise GenerationDispatchAborted(
                        f"generation {request.generation_id} lost its claim before dispatch"
                    )
            else:
                if state.dispatch_phase is not Uncertain:
                    raise AssertionError("provider successor requires an Uncertain owner")
                pending = read_pending_generation_continuation_in_current_transaction(
                    db, generation_id=request.generation_id, cipher=self._cipher
                )
                if pending is None:
                    raise GenerationUncertain(
                        f"generation {request.generation_id} has no reopenable successor"
                    )
                arm_resumed_model_turn_dispatch_in_current_transaction(
                    db, source_model_turn_id=pending.source_turn.id, successor=start
                )
            db.commit()

    async def complete_child(self, completion: BackendChildCompletion) -> BackendChildCompletion:
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
            sealed = absent()
            if isinstance(completion.successor, Present):
                material = completion.successor.value
                sealed = present(
                    self._cipher.seal(
                        canonical_continuation=material.canonical_bytes,
                        context=_continuation_context(material.identity),
                    )
                )
            child_terminal, usage, billability, accepted_at = _child_terminal_documents(
                completion.terminal
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
            if is_final:
                encoded = (
                    self._resolve_terminal(db, completion.terminal)
                    if self._resolve_terminal is not None
                    else self._encode_terminal(completion.terminal)
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
                if not request.journal.complete(
                    db,
                    expected=state,
                    next_state=StepReplayState(
                        generation_id=request.generation_id,
                        dispatch_phase=Completed,
                        request_fingerprint=present(request.spec.fingerprint),
                        terminal_result=present(encoded.terminal_result),
                    ),
                ):
                    raise GenerationUncertain(
                        f"generation {request.generation_id} lost its claim at terminal"
                    )
                self.encoded = encoded
            db.commit()
        self.completed = completion
        return completion

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
                    terminal_result=state.terminal_result.value, terminal=None, replayed=True
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
            db, generation_id=request.generation_id, cipher=cipher
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
    """Park background quota, or close Chat, before model-call admission."""

    if _journal_is_uncertain(session_factory, request):
        raise GenerationUncertain(
            f"generation {request.generation_id} reported capacity after admission"
        )
    observed_at = datetime.now(UTC)
    pause = CapacityPaused(
        explanation="Codex Personal capacity is currently unavailable",
        reset_at=absent(),
        next_check_at=observed_at + timedelta(seconds=BACKGROUND_CAPACITY_PROBE_SECONDS),
        last_checked=observed_at,
    )
    if request.owner.kind != "chat_run":
        with session_factory() as db:
            request.journal.park_capacity_pause(db, pause)
            db.commit()
        return RescheduleRequested(schedule=GenerationCapacityPaused(pause).schedule)
    terminal_result = encode_failure("capacity_unavailable", pause.explanation)
    with session_factory() as db:
        lock_generation_owner_in_current_transaction(db, request.owner)
        state = _require_journal_state(db, request)
        if state.dispatch_phase is not Prepared:
            raise AssertionError("Chat capacity refusal is not pre-admission")
        if not request.journal.complete(
            db,
            expected=state,
            next_state=StepReplayState(
                generation_id=request.generation_id,
                dispatch_phase=Completed,
                request_fingerprint=present(request.spec.fingerprint),
                terminal_result=present(terminal_result),
            ),
        ):
            raise GenerationDispatchAborted(
                f"generation {request.generation_id} lost its claim at capacity refusal"
            )
        db.commit()
    return CompletedGeneration(terminal_result=terminal_result, terminal=None, replayed=False)


def _journal_is_uncertain(
    session_factory: sessionmaker[Session], request: GenerationExecutionRequest
) -> bool:
    with session_factory() as db:
        return _require_journal_state(db, request).dispatch_phase is Uncertain


def _require_journal_state(db: Session, request: GenerationExecutionRequest) -> StepReplayState:
    state = request.journal.read(db)
    if state is None:
        raise AssertionError("generation execution requires a Prepared checkpoint")
    if state.generation_id != request.generation_id:
        raise AssertionError("generation journal identity differs from request")
    if not isinstance(state.request_fingerprint, Present):
        raise AssertionError("generation journal has no request fingerprint")
    if state.request_fingerprint.value != request.spec.fingerprint:
        raise AssertionError("generation journal request fingerprint drifted")
    return state


def _model_turn_id(generation_id: UUID, child_seq: int) -> UUID:
    return uuid5(generation_id, f"{_MODEL_TURN_COMPONENT}/{child_seq}")


def _assert_child_identity(
    child: BackendChildDispatch, request: GenerationExecutionRequest
) -> None:
    if child.generation_id != request.generation_id:
        raise AssertionError("backend child belongs to another generation")
    if child.route != request.spec.selection.route:
        raise AssertionError("backend child route differs from frozen selection")


def _continuation_context(identity: ProviderContinuationIdentity) -> GenerationContinuationContext:
    return GenerationContinuationContext(
        generation_id=identity.generation_id,
        source_turn_seq=identity.source_child_seq,
        successor_turn_seq=identity.successor_child_seq,
        target_fingerprint=identity.target_fingerprint,
        codec_id=identity.codec_id,
        policy_revision=identity.policy_revision,
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
        outcome = {"succeeded": "Succeeded", "failed": "Failed", "cancelled": "Cancelled"}[
            native.status
        ]
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
        return (
            document,
            absent() if native.usage is None else present(native.usage.model_dump(mode="json")),
            present({"kind": "Subscription"}),
            present(datetime.fromisoformat(native.accepted_at[:-1] + "+00:00")),
        )
    if not isinstance(terminal.evidence, ProviderTerminalEvidence):
        assert_never(terminal.evidence)
    native_outcome = terminal.evidence.outcome
    failure_code: str | None = None
    if isinstance(native_outcome, ProviderSucceeded):
        outcome = "Succeeded"
    elif isinstance(native_outcome, ProviderCancelled):
        outcome = "Cancelled"
    elif isinstance(native_outcome, ProviderIncomplete):
        outcome = "Failed"
        failure_code = (
            "output_limit_exceeded"
            if native_outcome.reason == "max_output_tokens"
            else "content_filter_partial"
        )
    elif isinstance(native_outcome, ProviderFailed):
        outcome = "Failed"
        failure_code = _provider_failure_code(native_outcome.failure)
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
    # ``billability`` is the only per-turn record of subscription-vs-metered use.
    return (
        document,
        present(_json_mapping(meta.usage.value))
        if isinstance(meta.usage, RuntimePresent)
        else absent(),
        present({"kind": type(meta.billability).__name__}),
        absent(),
    )


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
    if accepted_failure is not None:
        return {
            "kind": "Failed",
            "failure_code": accepted_failure.code,
            "failure_detail": accepted_failure.detail,
            "final_model_turn_seq": final_child_seq,
            "model_turn_terminal": dict(child_terminal),
        }
    document: dict[str, object] = {
        "kind": child_terminal["kind"],
        "final_model_turn_seq": final_child_seq,
        "model_turn_terminal": dict(child_terminal),
    }
    if child_terminal["kind"] == "Failed":
        document["failure_code"] = child_terminal["failure_code"]
    return document


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


async def _ignore_event(event: BackendEvent) -> None:
    del event


class _ForbiddenToolExecutor:
    async def execute(self, request: BackendToolExecutionRequest) -> BackendToolExecutionResult:
        del request
        raise AssertionError("NoModelTools backend attempted direct tool execution")


class _NeverCancelled:
    async def wait(self) -> bool:
        await asyncio.Future()
        return False

    def is_set(self) -> bool:
        return False


def cancel_prepared_generation_without_dispatch_in_current_transaction(
    db: Session, *, owner: LlmCallOwner, state: StepReplayState, terminal_result: str
) -> StepReplayState:
    """Close a Prepared owner only when no model child was armed."""

    lock_generation_owner_in_current_transaction(db, owner)
    if state.dispatch_phase is not Prepared:
        raise AssertionError("pre-admission cancellation requires Prepared")
    if (
        lock_generation_for_authority_in_current_transaction(
            db, owner=owner, generation_id=state.generation_id
        )
        is not None
    ):
        raise AssertionError("Prepared generation journal unexpectedly has ledger evidence")
    return StepReplayState(
        generation_id=state.generation_id,
        dispatch_phase=Completed,
        request_fingerprint=state.request_fingerprint,
        terminal_result=present(terminal_result),
    )


def _assert_expected_state(observed: StepReplayState | None, expected: StepReplayState) -> None:
    if observed != expected:
        raise AssertionError("generation journal changed during checkpoint transition")
