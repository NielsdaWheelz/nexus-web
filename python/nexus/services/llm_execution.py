"""The sole Nexus dispatch boundary for durable Codex generations."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, Protocol

from sqlalchemy.orm import Session, sessionmaker

from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    ScheduleAfter,
    get_job,
    lock_running_job_claim,
    update_running_job_payload,
)
from nexus.schemas.presence import Present, absent, present
from nexus.services.codex_generation_contract import (
    GenerationCommand,
    GenerationFrame,
    GenerationHealth,
    GenerationTerminal,
    NormalizedFailureCode,
    request_fingerprint,
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
from nexus.services.llm_ledger import (
    GenerationStart,
    LlmCallOwner,
    complete_generation_in_current_transaction,
    complete_preaccept_failure_if_started_in_current_transaction,
    lock_generation_owner_in_current_transaction,
    start_generation_in_current_transaction,
)

type LockedDispatch = Callable[[Session], JobRow | None]
type EncodeTerminal = Callable[[GenerationTerminal], "EncodedGenerationTerminal"]
type EncodePreacceptFailure = Callable[[NormalizedFailureCode, str], str]
type ObserveFrame = Callable[[GenerationFrame], Awaitable[None]]


class ExecutionRuntime(Protocol):
    """The strict Codex host surface consumed by generation orchestration."""

    async def health(self) -> GenerationHealth: ...

    def stream(self, command: GenerationCommand) -> AsyncIterator[GenerationFrame]: ...


@dataclass(frozen=True, slots=True)
class GenerationExecutionRequest:
    """Owner-neutral facts needed to execute one journaled generation."""

    owner: LlmCallOwner
    command: GenerationCommand
    context: JobExecutionContext
    step_path: str
    capacity_wait_index: int
    capacity_wait_delays_seconds: tuple[int, ...]
    streaming: bool = False

    def __post_init__(self) -> None:
        if not self.step_path:
            raise ValueError("generation step_path must not be blank")
        if self.capacity_wait_index < 0:
            raise ValueError("generation capacity_wait_index must not be negative")
        if any(delay <= 0 for delay in self.capacity_wait_delays_seconds):
            raise ValueError("generation capacity waits must be positive")
        if self.capacity_wait_index > len(self.capacity_wait_delays_seconds):
            raise ValueError("generation capacity_wait_index exceeds its schedule")


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
    lock_dispatch: LockedDispatch,
    encode_terminal: EncodeTerminal,
    encode_preaccept_failure: EncodePreacceptFailure,
    observe_frame: ObserveFrame | None = None,
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

    # Image/policy drift is proven before the dispatch transaction can make the
    # generation Uncertain. CodexGenerationClient.stream rechecks health at its
    # own wire boundary as defense in depth.
    await runtime.health()
    _arm_dispatch(
        session_factory,
        request,
        lock_dispatch=lock_dispatch,
    )

    started = time.monotonic()
    terminal: GenerationTerminal | None = None
    try:
        async for frame in runtime.stream(request.command):
            if observe_frame is not None:
                await observe_frame(frame)
            if isinstance(frame.event, GenerationTerminal):
                terminal = frame.event
    except CodexGenerationCapacityUnavailable as error:
        return _restore_capacity_or_complete(
            session_factory,
            request,
            encode_preaccept_failure=encode_preaccept_failure,
            detail=str(error),
        )
    except (CodexGenerationClientError, CodexGenerationProtocolDefect) as error:
        raise GenerationUncertain(str(error)) from error

    if terminal is None:
        # The strict client normally raises transport ambiguity first; keeping
        # this assertion local prevents a permissive alternate runtime from
        # fabricating completion.
        raise GenerationUncertain("Codex generation stream ended without terminal")
    encoded = encode_terminal(terminal)
    _land_terminal(
        session_factory,
        request,
        terminal=terminal,
        encoded=encoded,
        latency_ms=int((time.monotonic() - started) * 1000),
    )
    return CompletedGeneration(
        terminal_result=encoded.terminal_result,
        terminal=terminal,
        replayed=False,
    )


def _read_replay(
    session_factory: sessionmaker[Session],
    request: GenerationExecutionRequest,
) -> CompletedGeneration | None:
    with session_factory() as db:
        job = get_job(db, request.context.job_id)
        if job is None:
            raise AssertionError(
                f"generation job {request.context.job_id} disappeared before execution"
            )
        state = read_step_states(job).get(request.step_path)
        if state is None:
            raise AssertionError("generation execution requires a Prepared checkpoint")
        _assert_identity(state, request)
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
    lock_dispatch: LockedDispatch,
) -> None:
    with session_factory() as db:
        lock_generation_owner_in_current_transaction(db, request.owner)
        job = lock_dispatch(db)
        if job is None or not lock_running_job_claim(db, context=request.context):
            db.rollback()
            raise GenerationDispatchAborted(
                f"generation {request.command.request_id} lost its claim before dispatch"
            )
        state = read_step_states(job).get(request.step_path)
        if state is None or state.dispatch_phase is not Prepared:
            raise AssertionError("generation dispatch requires the Prepared checkpoint")
        _assert_identity(state, request)
        start_generation_in_current_transaction(
            db,
            GenerationStart(
                owner=request.owner,
                command=request.command,
                streaming=request.streaming,
            ),
        )
        landed = checkpoint_step_state(
            db,
            ctx=request.context,
            job=job,
            step_path=request.step_path,
            state=StepReplayState(
                generation_id=request.command.request_id,
                dispatch_phase=Uncertain,
                request_fingerprint=present(request_fingerprint(request.command)),
                terminal_result=absent(),
            ),
        )
        if not landed:
            db.rollback()
            raise GenerationDispatchAborted(
                f"generation {request.command.request_id} lost its claim before dispatch"
            )
        db.commit()


def _land_terminal(
    session_factory: sessionmaker[Session],
    request: GenerationExecutionRequest,
    *,
    terminal: GenerationTerminal,
    encoded: EncodedGenerationTerminal,
    latency_ms: int,
) -> None:
    with session_factory() as db:
        lock_generation_owner_in_current_transaction(db, request.owner)
        job = get_job(db, request.context.job_id)
        if job is None:
            raise AssertionError(f"generation job {request.context.job_id} disappeared at terminal")
        state = read_step_states(job).get(request.step_path)
        if state is None or state.dispatch_phase is not Uncertain:
            raise AssertionError("generation terminal requires the Uncertain checkpoint")
        _assert_identity(state, request)
        complete_generation_in_current_transaction(
            db,
            owner=request.owner,
            generation_id=request.command.request_id,
            terminal=terminal,
            latency_ms=latency_ms,
            accepted_failure_code=(
                encoded.accepted_failure.code if encoded.accepted_failure is not None else None
            ),
            accepted_failure_detail=(
                encoded.accepted_failure.detail if encoded.accepted_failure is not None else None
            ),
        )
        landed = checkpoint_step_state(
            db,
            ctx=request.context,
            job=job,
            step_path=request.step_path,
            state=StepReplayState(
                generation_id=request.command.request_id,
                dispatch_phase=Completed,
                request_fingerprint=present(request_fingerprint(request.command)),
                terminal_result=present(encoded.terminal_result),
            ),
        )
        if not landed:
            db.rollback()
            raise GenerationUncertain(
                f"generation {request.command.request_id} lost its claim at terminal"
            )
        db.commit()


def _restore_capacity_or_complete(
    session_factory: sessionmaker[Session],
    request: GenerationExecutionRequest,
    *,
    encode_preaccept_failure: EncodePreacceptFailure,
    detail: str,
) -> GenerationExecutionResult:
    index = request.capacity_wait_index
    if index < len(request.capacity_wait_delays_seconds):
        delay_seconds = request.capacity_wait_delays_seconds[index]
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
        job = get_job(db, request.context.job_id)
        if job is None:
            raise AssertionError(
                f"generation job {request.context.job_id} disappeared at capacity exhaustion"
            )
        state = read_step_states(job).get(request.step_path)
        if state is None or state.dispatch_phase is not Uncertain:
            raise AssertionError("capacity exhaustion requires the Uncertain checkpoint")
        _assert_identity(state, request)
        if not complete_preaccept_failure_if_started_in_current_transaction(
            db,
            owner=request.owner,
            generation_id=request.command.request_id,
            error_code=code,
            error_detail=detail,
        ):
            raise AssertionError("capacity exhaustion has no started ledger row")
        landed = checkpoint_step_state(
            db,
            ctx=request.context,
            job=job,
            step_path=request.step_path,
            state=StepReplayState(
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
        if not lock_running_job_claim(db, context=request.context):
            db.rollback()
            raise GenerationUncertain(
                f"generation {request.command.request_id} lost its claim at capacity refusal"
            )
        job = get_job(db, request.context.job_id)
        if job is None:
            raise AssertionError(
                f"generation job {request.context.job_id} disappeared at capacity refusal"
            )
        state = read_step_states(job).get(request.step_path)
        if state is None or state.dispatch_phase is not Uncertain:
            raise AssertionError("capacity refusal requires the Uncertain checkpoint")
        _assert_identity(state, request)
        observed_index = job.payload.get("capacity_wait_index")
        if observed_index != request.capacity_wait_index:
            raise AssertionError("generation capacity wait index changed during dispatch")
        payload = payload_with_step_state(
            {**job.payload, "capacity_wait_index": next_wait_index},
            step_path=request.step_path,
            state=StepReplayState(
                generation_id=request.command.request_id,
                dispatch_phase=Prepared,
                request_fingerprint=present(request_fingerprint(request.command)),
                terminal_result=absent(),
            ),
        )
        if not update_running_job_payload(
            db,
            job_id=request.context.job_id,
            worker_id=request.context.worker_id,
            attempt_no=request.context.attempt_no,
            payload=payload,
        ):
            db.rollback()
            raise GenerationUncertain(
                f"generation {request.command.request_id} lost its claim at capacity refusal"
            )
        db.commit()
        return payload


def _assert_identity(state: StepReplayState, request: GenerationExecutionRequest) -> None:
    if state.generation_id != request.command.request_id:
        raise AssertionError("generation journal identity differs from command")
    if not isinstance(state.request_fingerprint, Present):
        raise AssertionError("generation journal has no request fingerprint")
    if state.request_fingerprint.value != request_fingerprint(request.command):
        raise AssertionError("generation journal request fingerprint drifted")


__all__ = [
    "AcceptedGenerationFailure",
    "CompletedGeneration",
    "EncodedGenerationTerminal",
    "ExecutionRuntime",
    "GenerationDispatchAborted",
    "GenerationExecutionRequest",
    "GenerationExecutionResult",
    "GenerationUncertain",
    "execute_generation",
]
