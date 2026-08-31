"""The sole Nexus dispatch boundary for durable Codex generations."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, Protocol
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    ScheduleAfter,
    get_job,
    lock_chat_generation_admission_in_current_transaction,
    lock_running_job_claim,
    update_running_job_payload,
)
from nexus.schemas.presence import Present, absent, present
from nexus.services import generation_policy
from nexus.services.codex_generation_contract import (
    ChatOperation,
    GenerationAdmission,
    GenerationCommand,
    GenerationFrame,
    GenerationHealth,
    GenerationTerminal,
    NormalizedFailureCode,
    command_policy,
    request_fingerprint,
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
from nexus.services.llm_ledger import (
    GenerationRecord,
    GenerationStart,
    LlmCallOwner,
    cancel_preaccept_generation_if_started_in_current_transaction,
    complete_generation_in_current_transaction,
    complete_preaccept_failure_if_started_in_current_transaction,
    lock_generation_for_authority_in_current_transaction,
    lock_generation_owner_in_current_transaction,
    start_generation_in_current_transaction,
)

type LockedDispatch = Callable[[Session], JobRow | None]
type EncodeTerminal = Callable[[GenerationTerminal], "EncodedGenerationTerminal"]
type EncodePreacceptFailure = Callable[[NormalizedFailureCode, str], str]
type ObserveFrame = Callable[[GenerationFrame], Awaitable[None]]
type BeforeTerminal = Callable[[], Awaitable[None]]
type ResolveTerminal = Callable[[Session, GenerationTerminal], GenerationTerminal]
type BindAdmission = Callable[[GenerationAdmission], Awaitable[GenerationCommand]]


def _capacity_wait_delays_seconds(command: GenerationCommand) -> tuple[int, ...]:
    """Resolve the fixed wait policy from the canonical operation identity."""

    return generation_policy.capacity_wait_delays_seconds(command.operation.kind)


class ExecutionRuntime(Protocol):
    """The strict Codex host surface consumed by generation orchestration."""

    async def health(self) -> GenerationHealth: ...

    def stream(
        self,
        command: GenerationCommand,
        *,
        bind_admission: BindAdmission | None = None,
    ) -> AsyncIterator[GenerationFrame]: ...

    async def cancel(self, request_id: UUID) -> None: ...


class CancellationSignal(Protocol):
    """One-way owner cancellation notification for an accepted generation."""

    async def wait(self) -> bool: ...


class GenerationJournal(Protocol):
    """Durable owner checkpoint contract composed with the generation ledger.

    Implementations lock and validate their own owner/fence, but never commit
    or roll back. The execution service always takes the ledger advisory lock
    first and owns the surrounding transaction.
    """

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

    def restore_prepared(
        self,
        db: Session,
        *,
        expected: StepReplayState,
        next_state: StepReplayState,
        next_capacity_wait_index: int,
    ) -> dict[str, object]: ...


@dataclass(frozen=True, slots=True)
class JobGenerationJournal:
    """Lease-fenced generation journal stored in ``background_jobs.payload``."""

    context: JobExecutionContext
    step_path: str
    capacity_wait_index: int
    lock_dispatch: LockedDispatch

    def __post_init__(self) -> None:
        if not self.step_path:
            raise ValueError("generation step_path must not be blank")
        if self.capacity_wait_index < 0:
            raise ValueError("generation capacity_wait_index must not be negative")

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

    def restore_prepared(
        self,
        db: Session,
        *,
        expected: StepReplayState,
        next_state: StepReplayState,
        next_capacity_wait_index: int,
    ) -> dict[str, object]:
        if not lock_running_job_claim(db, context=self.context):
            raise GenerationUncertain(
                f"generation {expected.generation_id} lost its claim at capacity refusal"
            )
        job = get_job(db, self.context.job_id)
        if job is None:
            raise AssertionError(f"generation job {self.context.job_id} disappeared")
        _assert_expected_state(read_step_states(job).get(self.step_path), expected)
        if job.payload.get("capacity_wait_index") != self.capacity_wait_index:
            raise AssertionError("generation capacity wait index changed during dispatch")
        payload = payload_with_step_state(
            {**job.payload, "capacity_wait_index": next_capacity_wait_index},
            step_path=self.step_path,
            state=next_state,
        )
        if not update_running_job_payload(
            db,
            job_id=self.context.job_id,
            worker_id=self.context.worker_id,
            attempt_no=self.context.attempt_no,
            payload=payload,
        ):
            raise GenerationUncertain(
                f"generation {expected.generation_id} lost its claim at capacity refusal"
            )
        return payload


@dataclass(frozen=True, slots=True)
class GenerationExecutionRequest:
    """Owner-neutral facts needed to execute one journaled generation."""

    owner: LlmCallOwner
    command: GenerationCommand
    journal: GenerationJournal
    capacity_wait_index: int
    streaming: bool = False
    bind_admission: BindAdmission | None = None

    def __post_init__(self) -> None:
        if self.capacity_wait_index < 0:
            raise ValueError("generation capacity_wait_index must not be negative")
        if self.capacity_wait_index > len(_capacity_wait_delays_seconds(self.command)):
            raise ValueError("generation capacity_wait_index exceeds its schedule")
        if isinstance(self.command.operation, ChatOperation) != (self.bind_admission is not None):
            raise ValueError("ChatTools alone requires an admission-bound command factory")


class AttachReconciledGenerationTerminal(BaseModel):
    """Digest-bound raw host transcript captured by the operator."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    raw_stream: bytes = Field(min_length=1)
    raw_stream_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    latency_ms: int = Field(ge=0)


type GenerationUncertainResolution = ProveNotDispatched | AttachReconciledGenerationTerminal


@dataclass(frozen=True, slots=True)
class GenerationReconciliationRequest:
    """Exact persisted identity and operator decision for one uncertain turn."""

    owner: LlmCallOwner
    command: GenerationCommand
    state: StepReplayState
    streaming: bool
    resolution: GenerationUncertainResolution


@dataclass(frozen=True, slots=True)
class CompletedGeneration:
    """One durable Completed memo, whether newly landed or replayed."""

    terminal_result: str
    terminal: GenerationTerminal | None
    replayed: bool


@dataclass(frozen=True, slots=True)
class AcceptedGenerationFailure:
    """Domain validation that overrides an accepted host success in the ledger."""

    code: Literal["invalid_output"]
    detail: str

    def __post_init__(self) -> None:
        if not self.detail.strip():
            raise ValueError("accepted generation failure detail must not be blank")


@dataclass(frozen=True, slots=True)
class EncodedGenerationTerminal:
    """Replay memo plus an optional effective outcome for semantic validation."""

    terminal_result: str
    accepted_failure: AcceptedGenerationFailure | None = None


type GenerationExecutionResult = CompletedGeneration | RescheduleRequested


class GenerationUncertain(RuntimeError):
    """An armed generation may have run and must not dispatch automatically."""


class GenerationDispatchAborted(RuntimeError):
    """The live lease or owner validation prevented dispatch before host I/O."""


async def execute_generation(
    request: GenerationExecutionRequest,
    *,
    session_factory: sessionmaker[Session],
    runtime: ExecutionRuntime,
    encode_terminal: EncodeTerminal,
    encode_preaccept_failure: EncodePreacceptFailure,
    observe_frame: ObserveFrame | None = None,
    cancel_signal: CancellationSignal | None = None,
    before_terminal: BeforeTerminal | None = None,
    resolve_terminal: ResolveTerminal | None = None,
) -> GenerationExecutionResult:
    """Execute once with durable ambiguity and no transaction across UDS I/O.

    The adapter prepares the journal before entering and supplies one callback
    that, after this service has taken the advisory owner lock, locks and
    revalidates its domain rows and returns the current claimed job row.
    """

    # The concrete client lowers chat tools through app-owned declarations,
    # whose import graph also contains operation adapters. Resolve its closed
    # exception family only at execution time so the abstract orchestration
    # module remains an acyclic dependency for those adapters.
    from nexus.services.codex_generation_client import (
        CodexGenerationCapacityUnavailable,
        CodexGenerationClientError,
        CodexGenerationProtocolDefect,
    )

    replay = _read_replay(session_factory, request)
    if replay is not None:
        return replay

    courtesy = _defer_background_while_chat_is_waiting(
        session_factory,
        request,
        encode_preaccept_failure=encode_preaccept_failure,
    )
    if courtesy is not None:
        return courtesy

    # Image/policy drift is proven before the dispatch transaction can make the
    # generation Uncertain. CodexGenerationClient.stream rechecks health at its
    # own wire boundary as defense in depth.
    await runtime.health()
    admission_result = _arm_dispatch(
        session_factory,
        request,
        encode_preaccept_failure=encode_preaccept_failure,
    )
    if admission_result is not None:
        return admission_result

    started = time.monotonic()
    try:
        terminal = await _consume_generation(
            request,
            runtime=runtime,
            observe_frame=observe_frame,
            cancel_signal=cancel_signal,
        )
    except CodexGenerationCapacityUnavailable:
        return _restore_capacity_or_complete(
            session_factory,
            request,
            encode_preaccept_failure=encode_preaccept_failure,
        )
    except (CodexGenerationClientError, CodexGenerationProtocolDefect) as error:
        raise GenerationUncertain(str(error)) from error

    if terminal is None:
        # The strict client normally raises transport ambiguity first; keeping
        # this assertion local prevents a permissive alternate runtime from
        # fabricating completion.
        raise GenerationUncertain("Codex generation stream ended without terminal")
    if before_terminal is not None:
        # Chat uses this hook to close MCP admission and drain already-admitted
        # tool work while the generation ledger is still nonterminal. A failed
        # drain therefore preserves the Uncertain checkpoint instead of
        # allowing a host terminal to outrun an app-owned effect receipt.
        await before_terminal()
    terminal, encoded = _land_terminal(
        session_factory,
        request,
        terminal=terminal,
        encode_terminal=encode_terminal,
        resolve_terminal=resolve_terminal,
        latency_ms=int((time.monotonic() - started) * 1000),
    )
    return CompletedGeneration(
        terminal_result=encoded.terminal_result,
        terminal=terminal,
        replayed=False,
    )


def _defer_background_while_chat_is_waiting(
    session_factory: sessionmaker[Session],
    request: GenerationExecutionRequest,
    *,
    encode_preaccept_failure: EncodePreacceptFailure,
) -> GenerationExecutionResult | None:
    """Apply the fixed Chat courtesy before health or generation I/O."""

    if request.owner.kind == "chat_run":
        return None

    with session_factory() as db:
        lock_generation_owner_in_current_transaction(db, request.owner)
        lock_chat_generation_admission_in_current_transaction(db)
        result = _defer_background_while_chat_is_waiting_in_current_transaction(
            db,
            request,
            encode_preaccept_failure=encode_preaccept_failure,
        )
        if result is not None:
            db.commit()
        return result


def _defer_background_while_chat_is_waiting_in_current_transaction(
    db: Session,
    request: GenerationExecutionRequest,
    *,
    encode_preaccept_failure: EncodePreacceptFailure,
) -> GenerationExecutionResult | None:
    """Defer under the already-held owner and Chat-admission locks."""

    waiting = db.scalar(
        text(
            """
            SELECT EXISTS (
                SELECT 1
                FROM background_jobs
                WHERE kind = 'chat_run'
                  AND (
                      status IN ('pending', 'running')
                      OR (status = 'failed' AND attempts < max_attempts)
                  )
            )
            """
        )
    )
    if waiting is not True:
        return None

    state = request.journal.read(db)
    if state is None or state.dispatch_phase is not Prepared:
        raise AssertionError("Chat courtesy requires the Prepared checkpoint")
    _assert_identity(state, request.command)
    index = request.capacity_wait_index
    capacity_wait_delays_seconds = _capacity_wait_delays_seconds(request.command)
    if index < len(capacity_wait_delays_seconds):
        delay_seconds = capacity_wait_delays_seconds[index]
        payload = request.journal.restore_prepared(
            db,
            expected=state,
            next_state=state,
            next_capacity_wait_index=index + 1,
        )
        return RescheduleRequested(
            schedule=ScheduleAfter(delay_seconds),
            payload=payload,
        )

    detail = "codex generation capacity unavailable"
    terminal_result = encode_preaccept_failure("capacity_unavailable", detail)
    start_generation_in_current_transaction(
        db,
        GenerationStart(
            owner=request.owner,
            command=request.command,
            streaming=request.streaming,
        ),
    )
    if not complete_preaccept_failure_if_started_in_current_transaction(
        db,
        owner=request.owner,
        generation_id=request.command.request_id,
        error_code="capacity_unavailable",
        error_detail=detail,
    ):
        raise AssertionError("Chat courtesy capacity terminal has no ledger start")
    landed = request.journal.complete(
        db,
        expected=state,
        next_state=StepReplayState(
            generation_id=request.command.request_id,
            dispatch_phase=Completed,
            request_fingerprint=present(request_fingerprint(request.command)),
            terminal_result=present(terminal_result),
        ),
    )
    if not landed:
        raise GenerationDispatchAborted(
            f"generation {request.command.request_id} lost its claim at Chat courtesy"
        )
    return CompletedGeneration(
        terminal_result=terminal_result,
        terminal=None,
        replayed=False,
    )


def reconcile_uncertain_generation_in_current_transaction(
    db: Session,
    request: GenerationReconciliationRequest,
    *,
    encode_terminal: EncodeTerminal,
    resolve_terminal: ResolveTerminal | None = None,
) -> StepReplayState:
    """Stage one evidence-backed repair without committing or publishing.

    The caller takes the generation-owner advisory lock before locking its
    domain and suspended-work rows, then supplies the exact persisted state and
    reconstructed command. It must persist the returned state in this same
    transaction. Publication remains a later replay through the domain owner.
    """

    lock_generation_owner_in_current_transaction(db, request.owner)
    state = request.state
    if state.dispatch_phase is not Uncertain:
        raise AssertionError("generation reconciliation requires the Uncertain checkpoint")
    if isinstance(state.tool_execution, Present):
        raise AssertionError("generation reconciliation cannot repair a tool execution")
    _assert_identity(state, request.command)
    resolution = request.resolution
    if isinstance(resolution, ProveNotDispatched):
        return prove_uncertain_generation_not_dispatched_in_current_transaction(
            db,
            owner=request.owner,
            state=state,
        )

    # Import at the repair boundary for the same reason execute_generation imports
    # the concrete client lazily: orchestration remains acyclic for operation adapters.
    from nexus.services.codex_generation_client import (
        decode_reconciled_generation_terminal_evidence,
    )

    terminal = decode_reconciled_generation_terminal_evidence(
        raw_stream=resolution.raw_stream,
        raw_stream_sha256=resolution.raw_stream_sha256,
        command=request.command,
    )
    maximum_latency_ms = command_policy(request.command).transport_deadline_seconds * 1_000
    if resolution.latency_ms > maximum_latency_ms:
        raise ValueError("reconciled generation latency exceeds its transport deadline")
    _terminal, _encoded, completed = _stage_generation_terminal_in_current_transaction(
        db,
        owner=request.owner,
        command=request.command,
        state=state,
        streaming=request.streaming,
        terminal=terminal,
        encode_terminal=encode_terminal,
        resolve_terminal=resolve_terminal,
        latency_ms=resolution.latency_ms,
    )
    return completed


def prove_uncertain_generation_not_dispatched_in_current_transaction(
    db: Session,
    *,
    owner: LlmCallOwner,
    state: StepReplayState,
) -> StepReplayState:
    """Stage the safe half of generation repair without reconstructing input.

    Some durable owners retain only the exact request fingerprint, deliberately
    not raw prompts or mutable domain projections.  They can therefore prove a
    missing dispatch from their journal and ledger start, but cannot safely
    attach a recovered terminal.  The owner persists this returned state and
    requeues its own suspended job in the same transaction.
    """

    lock_generation_owner_in_current_transaction(db, owner)
    if state.dispatch_phase is not Uncertain:
        raise AssertionError("generation reconciliation requires the Uncertain checkpoint")
    if isinstance(state.tool_execution, Present):
        raise AssertionError("generation reconciliation cannot repair a tool execution")
    if not isinstance(state.request_fingerprint, Present):
        raise AssertionError("generation reconciliation has no request fingerprint")
    generation = lock_generation_for_authority_in_current_transaction(
        db,
        owner=owner,
        generation_id=state.generation_id,
    )

    if generation is None:
        raise AssertionError("generation reconciliation has no exact ledger start")
    if generation.request_fingerprint != state.request_fingerprint.value:
        raise AssertionError("generation reconciliation request fingerprint drifted")
    terminal_facts = (
        generation.session_ref,
        generation.outcome,
        generation.error_code,
        generation.error_detail,
        generation.input_tokens,
        generation.output_tokens,
        generation.total_tokens,
        generation.reasoning_tokens,
        generation.cache_read_input_tokens,
        generation.cache_write_input_tokens,
        generation.sdk_version,
        generation.runtime_version,
        generation.latency_ms,
        generation.accepted_at,
        generation.completed_at,
    )
    if any(fact is not None for fact in terminal_facts):
        raise AssertionError("generation already has terminal or partial terminal facts")
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
    reason: str,
) -> StepReplayState:
    """Stage one honest owner cancellation after dispatch was proven absent."""

    lock_generation_owner_in_current_transaction(db, owner)
    if state.dispatch_phase is not Prepared:
        raise AssertionError("pre-accept cancellation requires the Prepared checkpoint")
    if isinstance(state.tool_execution, Present):
        raise AssertionError("pre-accept cancellation cannot close a tool execution")
    if not isinstance(state.request_fingerprint, Present):
        raise AssertionError("pre-accept cancellation has no request fingerprint")
    generation = lock_generation_for_authority_in_current_transaction(
        db,
        owner=owner,
        generation_id=state.generation_id,
    )
    if generation is not None:
        if generation.request_fingerprint != state.request_fingerprint.value:
            raise AssertionError("pre-accept cancellation request fingerprint drifted")
        if not cancel_preaccept_generation_if_started_in_current_transaction(
            db,
            owner=owner,
            generation_id=state.generation_id,
            reason=reason,
        ):
            raise AssertionError("pre-accept cancellation lost its ledger start")
    return StepReplayState(
        generation_id=state.generation_id,
        dispatch_phase=Completed,
        request_fingerprint=state.request_fingerprint,
        terminal_result=present(terminal_result),
    )


def _read_replay(
    session_factory: sessionmaker[Session],
    request: GenerationExecutionRequest,
) -> CompletedGeneration | None:
    with session_factory() as db:
        state = request.journal.read(db)
        if state is None:
            raise AssertionError("generation execution requires a Prepared checkpoint")
        _assert_identity(state, request.command)
        if state.dispatch_phase is Prepared:
            return None
        if state.dispatch_phase is Uncertain:
            raise GenerationUncertain(
                f"generation {request.command.request_id} has an unresolved dispatch"
            )
        if state.dispatch_phase is not Completed:
            raise AssertionError(f"unknown generation phase {state.dispatch_phase!r}")
        if not isinstance(state.terminal_result, Present):
            raise AssertionError("Completed generation has no terminal result")
        return CompletedGeneration(
            terminal_result=state.terminal_result.value,
            terminal=None,
            replayed=True,
        )


def _arm_dispatch(
    session_factory: sessionmaker[Session],
    request: GenerationExecutionRequest,
    *,
    encode_preaccept_failure: EncodePreacceptFailure,
) -> GenerationExecutionResult | None:
    with session_factory() as db:
        lock_generation_owner_in_current_transaction(db, request.owner)
        if request.owner.kind != "chat_run":
            lock_chat_generation_admission_in_current_transaction(db)
            courtesy = _defer_background_while_chat_is_waiting_in_current_transaction(
                db,
                request,
                encode_preaccept_failure=encode_preaccept_failure,
            )
            if courtesy is not None:
                db.commit()
                return courtesy
        state = request.journal.read(db)
        if state is None or state.dispatch_phase is not Prepared:
            raise AssertionError("generation dispatch requires the Prepared checkpoint")
        _assert_identity(state, request.command)
        start_generation_in_current_transaction(
            db,
            GenerationStart(
                owner=request.owner,
                command=request.command,
                streaming=request.streaming,
            ),
        )
        landed = request.journal.arm(
            db,
            expected=state,
            next_state=StepReplayState(
                generation_id=request.command.request_id,
                dispatch_phase=Uncertain,
                request_fingerprint=present(request_fingerprint(request.command)),
                terminal_result=absent(),
            ),
        )
        if not landed:
            raise GenerationDispatchAborted(
                f"generation {request.command.request_id} lost its claim before dispatch"
            )
        db.commit()
    return None


def _land_terminal(
    session_factory: sessionmaker[Session],
    request: GenerationExecutionRequest,
    *,
    terminal: GenerationTerminal,
    encode_terminal: EncodeTerminal,
    resolve_terminal: ResolveTerminal | None,
    latency_ms: int,
) -> tuple[GenerationTerminal, EncodedGenerationTerminal]:
    with session_factory() as db:
        lock_generation_owner_in_current_transaction(db, request.owner)
        state = request.journal.read(db)
        if state is None or state.dispatch_phase is not Uncertain:
            raise AssertionError("generation terminal requires the Uncertain checkpoint")
        _assert_identity(state, request.command)
        terminal, encoded, next_state = _stage_generation_terminal_in_current_transaction(
            db,
            owner=request.owner,
            command=request.command,
            state=state,
            streaming=request.streaming,
            terminal=terminal,
            encode_terminal=encode_terminal,
            resolve_terminal=resolve_terminal,
            latency_ms=latency_ms,
        )
        landed = request.journal.complete(
            db,
            expected=state,
            next_state=next_state,
        )
        if not landed:
            db.rollback()
            raise GenerationUncertain(
                f"generation {request.command.request_id} lost its claim at terminal"
            )
        db.commit()
    return terminal, encoded


def _stage_generation_terminal_in_current_transaction(
    db: Session,
    *,
    owner: LlmCallOwner,
    command: GenerationCommand,
    state: StepReplayState,
    streaming: bool,
    terminal: GenerationTerminal,
    encode_terminal: EncodeTerminal,
    resolve_terminal: ResolveTerminal | None,
    latency_ms: int,
) -> tuple[GenerationTerminal, EncodedGenerationTerminal, StepReplayState]:
    """Stage the one terminal shape shared by live landing and repair."""

    _lock_exact_nonterminal_generation_start(
        db,
        owner=owner,
        command=command,
        streaming=streaming,
    )
    terminal = _terminal_for_durable_landing(terminal)
    if resolve_terminal is not None:
        terminal = resolve_terminal(db, terminal)
        terminal = _terminal_for_durable_landing(terminal)
    encoded = encode_terminal(terminal)
    complete_generation_in_current_transaction(
        db,
        owner=owner,
        generation_id=command.request_id,
        terminal=terminal,
        latency_ms=latency_ms,
        accepted_failure_code=(
            encoded.accepted_failure.code if encoded.accepted_failure is not None else None
        ),
    )
    return (
        terminal,
        encoded,
        StepReplayState(
            generation_id=state.generation_id,
            dispatch_phase=Completed,
            request_fingerprint=state.request_fingerprint,
            terminal_result=present(encoded.terminal_result),
        ),
    )


def _terminal_for_durable_landing(terminal: GenerationTerminal) -> GenerationTerminal:
    """Strip transport diagnostics before domain or ledger persistence."""

    detail = retained_terminal_error_detail(terminal)
    return GenerationTerminal.model_validate(
        {
            **terminal.model_dump(mode="json"),
            "diagnostics": [] if detail is None else [detail],
        }
    )


def _restore_capacity_or_complete(
    session_factory: sessionmaker[Session],
    request: GenerationExecutionRequest,
    *,
    encode_preaccept_failure: EncodePreacceptFailure,
) -> GenerationExecutionResult:
    detail = "codex generation capacity unavailable"
    index = request.capacity_wait_index
    capacity_wait_delays_seconds = _capacity_wait_delays_seconds(request.command)
    if index < len(capacity_wait_delays_seconds):
        delay_seconds = capacity_wait_delays_seconds[index]
        payload = _restore_prepared(
            session_factory,
            request,
            next_wait_index=index + 1,
        )
        return RescheduleRequested(
            schedule=ScheduleAfter(delay_seconds),
            payload=payload,
        )

    code: NormalizedFailureCode = "capacity_unavailable"
    terminal_result = encode_preaccept_failure(code, detail)
    with session_factory() as db:
        lock_generation_owner_in_current_transaction(db, request.owner)
        state = request.journal.read(db)
        if state is None or state.dispatch_phase is not Uncertain:
            raise AssertionError("capacity exhaustion requires the Uncertain checkpoint")
        _assert_identity(state, request.command)
        if not complete_preaccept_failure_if_started_in_current_transaction(
            db,
            owner=request.owner,
            generation_id=request.command.request_id,
            error_code=code,
            error_detail=detail,
        ):
            raise AssertionError("capacity exhaustion has no started ledger row")
        landed = request.journal.complete(
            db,
            expected=state,
            next_state=StepReplayState(
                generation_id=request.command.request_id,
                dispatch_phase=Completed,
                request_fingerprint=present(request_fingerprint(request.command)),
                terminal_result=present(terminal_result),
            ),
        )
        if not landed:
            db.rollback()
            raise GenerationUncertain(
                f"generation {request.command.request_id} lost its claim at capacity exhaustion"
            )
        db.commit()
    return CompletedGeneration(
        terminal_result=terminal_result,
        terminal=None,
        replayed=False,
    )


def _restore_prepared(
    session_factory: sessionmaker[Session],
    request: GenerationExecutionRequest,
    *,
    next_wait_index: int,
) -> dict[str, object]:
    with session_factory() as db:
        lock_generation_owner_in_current_transaction(db, request.owner)
        state = request.journal.read(db)
        if state is None or state.dispatch_phase is not Uncertain:
            raise AssertionError("capacity refusal requires the Uncertain checkpoint")
        _assert_identity(state, request.command)
        payload = request.journal.restore_prepared(
            db,
            expected=state,
            next_state=StepReplayState(
                generation_id=request.command.request_id,
                dispatch_phase=Prepared,
                request_fingerprint=present(request_fingerprint(request.command)),
                terminal_result=absent(),
            ),
            next_capacity_wait_index=next_wait_index,
        )
        db.commit()
        return payload


async def _consume_generation(
    request: GenerationExecutionRequest,
    *,
    runtime: ExecutionRuntime,
    observe_frame: ObserveFrame | None,
    cancel_signal: CancellationSignal | None,
) -> GenerationTerminal | None:
    async def consume() -> GenerationTerminal | None:
        terminal: GenerationTerminal | None = None
        frames = (
            runtime.stream(request.command)
            if request.bind_admission is None
            else runtime.stream(request.command, bind_admission=request.bind_admission)
        )
        async for frame in frames:
            if observe_frame is not None:
                await observe_frame(frame)
            if isinstance(frame.event, GenerationTerminal):
                terminal = frame.event
        return terminal

    if cancel_signal is None:
        return await consume()

    stream_task = asyncio.create_task(consume())
    cancel_task = asyncio.create_task(cancel_signal.wait())
    try:
        done, _ = await asyncio.wait(
            (stream_task, cancel_task),
            return_when=asyncio.FIRST_COMPLETED,
        )
        if stream_task in done:
            return await stream_task
        await runtime.cancel(request.command.request_id)
        return await stream_task
    finally:
        for task in (stream_task, cancel_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(stream_task, cancel_task, return_exceptions=True)


def _lock_exact_nonterminal_generation_start(
    db: Session,
    *,
    owner: LlmCallOwner,
    command: GenerationCommand,
    streaming: bool,
) -> GenerationRecord:
    generation = lock_generation_for_authority_in_current_transaction(
        db,
        owner=owner,
        generation_id=command.request_id,
    )
    if generation is None:
        raise AssertionError("generation terminal has no exact ledger start")
    start_generation_in_current_transaction(
        db,
        GenerationStart(owner=owner, command=command, streaming=streaming),
    )
    terminal_facts = (
        generation.session_ref,
        generation.outcome,
        generation.error_code,
        generation.error_detail,
        generation.input_tokens,
        generation.output_tokens,
        generation.total_tokens,
        generation.reasoning_tokens,
        generation.cache_read_input_tokens,
        generation.cache_write_input_tokens,
        generation.sdk_version,
        generation.runtime_version,
        generation.latency_ms,
        generation.accepted_at,
        generation.completed_at,
    )
    if any(fact is not None for fact in terminal_facts):
        raise AssertionError("generation already has terminal or partial terminal facts")
    return generation


def _assert_identity(state: StepReplayState, command: GenerationCommand) -> None:
    if state.generation_id != command.request_id:
        raise AssertionError("generation journal identity differs from command")
    if not isinstance(state.request_fingerprint, Present):
        raise AssertionError("generation journal has no request fingerprint")
    if state.request_fingerprint.value != request_fingerprint(command):
        raise AssertionError("generation journal request fingerprint drifted")


def _assert_expected_state(
    observed: StepReplayState | None,
    expected: StepReplayState,
) -> None:
    if observed != expected:
        raise AssertionError("generation journal changed during its checkpoint transition")


__all__ = [
    "AcceptedGenerationFailure",
    "AttachReconciledGenerationTerminal",
    "BindAdmission",
    "CancellationSignal",
    "CompletedGeneration",
    "EncodedGenerationTerminal",
    "ExecutionRuntime",
    "GenerationDispatchAborted",
    "GenerationExecutionRequest",
    "GenerationExecutionResult",
    "GenerationJournal",
    "GenerationReconciliationRequest",
    "GenerationUncertain",
    "GenerationUncertainResolution",
    "JobGenerationJournal",
    "execute_generation",
    "cancel_prepared_generation_without_dispatch_in_current_transaction",
    "prove_uncertain_generation_not_dispatched_in_current_transaction",
    "reconcile_uncertain_generation_in_current_transaction",
]
