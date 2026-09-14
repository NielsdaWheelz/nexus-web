"""The sole Nexus boundary for ledgered direct-provider generation."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Never, Protocol, assert_never, cast
from uuid import UUID

import httpx
from provider_runtime import (
    Absent,
    GenerateIntent,
    Present,
    ProviderRuntime,
    ReasoningLevel,
    RuntimeStreamEvent,
    TerminalEvent,
    TokenUsage,
)
from provider_runtime import CallOutcome as ProviderCallOutcome
from provider_runtime.errors import InvalidRequest, RuntimeDefect, sanitize_provider_text
from provider_runtime.registry import resolve_target
from provider_runtime.types import (
    Billability,
    CancelSignal,
    ConfirmedNonBillable,
    FailureOrigin,
    ImageBlock,
    NotDispatched,
    Presence,
    RetryPolicy,
    StrictJsonOutput,
    UserMessage,
)
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import Settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.billing_entitlements import get_effective_entitlements
from nexus.services.llm_credentials import provider_credentials
from nexus.services.llm_intent_state import conservative_token_admission_bound
from nexus.services.llm_ledger import (
    AdmissionDenied,
    ExistingTerminalCall,
    LlmCallOwner,
    start_call,
    terminalize,
    terminalize_defect,
)
from nexus.services.llm_profiles import LlmOperation, LlmProfile
from nexus.services.rate_limit import RateLimiter, get_rate_limiter

logger = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class GenerationRequest:
    generation_id: UUID
    owner: LlmCallOwner
    operation: LlmOperation
    profile: LlmProfile
    reasoning: ReasoningLevel
    intent: GenerateIntent

    def __post_init__(self) -> None:
        if self.intent.target != self.profile.target:
            raise InvalidRequest(message="generation target does not match its product profile")
        if self.intent.reasoning != self.reasoning:
            raise InvalidRequest(message="generation reasoning does not match its product request")
        if self.reasoning not in {option.id for option in self.profile.reasoning_options}:
            raise InvalidRequest(
                message="generation reasoning is not offered by its product profile"
            )
        if any(
            isinstance(message, UserMessage)
            and any(isinstance(block, ImageBlock) for block in message.blocks)
            for message in self.intent.messages
        ):
            raise InvalidRequest(message="Nexus generation is text-only")
        if self.intent.provider_options:
            raise InvalidRequest(message="Nexus does not accept provider_options")
        if self.intent.tools and isinstance(self.intent.output, StrictJsonOutput):
            raise InvalidRequest(message="tools and strict JSON output cannot be combined")

        row = resolve_target(self.intent.target)
        if self.intent.max_output_tokens <= 0:
            raise InvalidRequest(message="max_output_tokens must be positive")
        if self.intent.max_output_tokens > row.max_output_tokens:
            raise InvalidRequest(message="max_output_tokens exceeds the registry row cap")
        input_bound = (
            conservative_token_admission_bound(self.intent) - self.intent.max_output_tokens
        )
        if input_bound > row.context_window - self.intent.max_output_tokens:
            raise InvalidRequest(message="generation exceeds the conservative context bound")


@dataclass(frozen=True, slots=True)
class CallOutcome:
    generation_id: UUID
    outcome: ProviderCallOutcome
    support_id: Presence[str]


class DispatchTransferred(RuntimeError):
    """Another durable attempt owns the shared generation and reservation."""


class DispatchAborted(RuntimeError):
    """The durable owner proved that this generation must not dispatch."""


class ExecutionRuntime(Protocol):
    async def generate(
        self,
        intent: GenerateIntent,
        *,
        cancel: CancelSignal | None = None,
    ) -> ProviderCallOutcome: ...

    def stream(
        self,
        intent: GenerateIntent,
        *,
        cancel: CancelSignal | None = None,
    ) -> AsyncIterator[RuntimeStreamEvent]: ...


class ProviderRetryMode(StrEnum):
    Default = "Default"
    SingleAttempt = "SingleAttempt"


_SINGLE_ATTEMPT_RETRY = RetryPolicy(
    max_attempts=1,
    initial_delay_s=0,
    max_delay_s=0,
    jitter_s=0,
    deadline_s=Absent(),
)


def build_execution_runtime(
    settings: Settings,
    client: httpx.AsyncClient,
    *,
    retry_mode: ProviderRetryMode = ProviderRetryMode.Default,
) -> ExecutionRuntime:
    credentials = provider_credentials(settings)
    match retry_mode:
        case ProviderRetryMode.Default:
            return ProviderRuntime(credentials, http_client=client)
        case ProviderRetryMode.SingleAttempt:
            return ProviderRuntime(
                credentials,
                retry=_SINGLE_ATTEMPT_RETRY,
                http_client=client,
            )
        case _:
            assert_never(retry_mode)


async def execute_generation(
    req: GenerationRequest,
    *,
    session_factory: sessionmaker[Session],
    runtime: ExecutionRuntime,
    before_dispatch: Callable[[], None] | None = None,
) -> CallOutcome:
    _check_entitlement(session_factory, user_id=req.owner.user_id)
    reservation_amount = conservative_token_admission_bound(req.intent)
    rate_limiter = get_rate_limiter()

    def admit(db: Session) -> None:
        try:
            rate_limiter.reserve_token_budget_in_transaction(
                db,
                user_id=req.owner.user_id,
                reservation_id=req.generation_id,
                est_tokens=reservation_amount,
            )
        except ApiError as exc:
            origin, code, detail = _reservation_defect_facts(exc)
            raise AdmissionDenied(
                origin=origin,
                code=code,
                detail=detail,
                cause=exc,
            ) from exc

    try:
        generation_id = start_call(
            session_factory,
            generation_id=req.generation_id,
            owner=req.owner,
            operation=req.operation,
            profile=req.profile,
            requested_reasoning=req.reasoning,
            streaming=False,
            admit=admit,
        )
    except AdmissionDenied as exc:
        raise exc.cause from exc
    except ExistingTerminalCall as exc:
        _raise_existing_terminal(exc)

    dispatch_attempted = False
    settled = False
    defect: BaseException | None = None
    try:
        if before_dispatch is not None:
            before_dispatch()
        dispatch_attempted = True
        started = time.monotonic()
        outcome = await runtime.generate(req.intent)
        facts = terminalize(
            session_factory,
            generation_id=generation_id,
            outcome=outcome,
            latency_ms=int((time.monotonic() - started) * 1000),
            settle=lambda db, terminal: _settle_success_in_transaction(
                db,
                rate_limiter,
                user_id=req.owner.user_id,
                generation_id=generation_id,
                reservation_amount=reservation_amount,
                billability=terminal.billability,
                usage=terminal.usage,
            ),
        )
        settled = True
        return CallOutcome(generation_id, outcome, facts.support_id)
    except BaseException as exc:
        defect = exc
        raise
    finally:
        if isinstance(defect, DispatchTransferred):
            pass
        elif isinstance(defect, DispatchAborted):
            terminalize_defect(
                session_factory,
                generation_id=generation_id,
                origin="plan",
                code="dispatch_aborted",
                detail=sanitize_provider_text(str(defect))
                or "dispatch aborted before provider I/O",
                settle=lambda db: rate_limiter.release_token_budget_in_transaction(
                    db,
                    user_id=req.owner.user_id,
                    reservation_id=generation_id,
                ),
            )
        elif not settled:
            _settle_defect(
                rate_limiter,
                session_factory,
                user_id=req.owner.user_id,
                generation_id=generation_id,
                reservation_amount=reservation_amount,
                dispatch_attempted=dispatch_attempted,
                defect=defect,
            )


async def execute_generation_stream(
    req: GenerationRequest,
    *,
    session_factory: sessionmaker[Session],
    runtime: ExecutionRuntime,
    cancel: CancelSignal,
    before_dispatch: Callable[[], None] | None = None,
) -> AsyncIterator[RuntimeStreamEvent]:
    _check_entitlement(session_factory, user_id=req.owner.user_id)
    reservation_amount = conservative_token_admission_bound(req.intent)
    rate_limiter = get_rate_limiter()

    def admit(db: Session) -> None:
        try:
            rate_limiter.reserve_token_budget_in_transaction(
                db,
                user_id=req.owner.user_id,
                reservation_id=req.generation_id,
                est_tokens=reservation_amount,
            )
        except ApiError as exc:
            origin, code, detail = _reservation_defect_facts(exc)
            raise AdmissionDenied(
                origin=origin,
                code=code,
                detail=detail,
                cause=exc,
            ) from exc

    try:
        generation_id = start_call(
            session_factory,
            generation_id=req.generation_id,
            owner=req.owner,
            operation=req.operation,
            profile=req.profile,
            requested_reasoning=req.reasoning,
            streaming=True,
            admit=admit,
        )
    except AdmissionDenied as exc:
        raise exc.cause from exc
    except ExistingTerminalCall as exc:
        _raise_existing_terminal(exc)

    dispatch_attempted = False
    settled = False
    defect: BaseException | None = None
    try:
        if before_dispatch is not None:
            before_dispatch()
        dispatch_attempted = True
        started = time.monotonic()
        async for event in runtime.stream(req.intent, cancel=cancel):
            if isinstance(event.event, TerminalEvent):
                terminalize(
                    session_factory,
                    generation_id=generation_id,
                    outcome=event.event.outcome,
                    latency_ms=int((time.monotonic() - started) * 1000),
                    settle=lambda db, terminal: _settle_success_in_transaction(
                        db,
                        rate_limiter,
                        user_id=req.owner.user_id,
                        generation_id=generation_id,
                        reservation_amount=reservation_amount,
                        billability=terminal.billability,
                        usage=terminal.usage,
                    ),
                )
                settled = True
            yield event
    except GeneratorExit:
        raise
    except BaseException as exc:
        defect = exc
        raise
    finally:
        if isinstance(defect, DispatchTransferred):
            pass
        elif isinstance(defect, DispatchAborted):
            terminalize_defect(
                session_factory,
                generation_id=generation_id,
                origin="plan",
                code="dispatch_aborted",
                detail=sanitize_provider_text(str(defect))
                or "dispatch aborted before provider I/O",
                settle=lambda db: rate_limiter.release_token_budget_in_transaction(
                    db,
                    user_id=req.owner.user_id,
                    reservation_id=generation_id,
                ),
            )
        elif not settled:
            _settle_defect(
                rate_limiter,
                session_factory,
                user_id=req.owner.user_id,
                generation_id=generation_id,
                reservation_amount=reservation_amount,
                dispatch_attempted=dispatch_attempted,
                defect=defect,
                fallback_origin="provider_stream",
                fallback_code="stream_interrupted",
                fallback_detail="stream closed before a terminal event was observed",
            )


def _check_entitlement(session_factory: sessionmaker[Session], *, user_id: UUID) -> None:
    with session_factory() as db:
        entitlements = get_effective_entitlements(db, user_id)
        db.commit()
    if not entitlements.can_use_platform_llm:
        raise ApiError(ApiErrorCode.E_BILLING_REQUIRED, "Platform LLM access requires an AI tier.")


def _raise_existing_terminal(exc: ExistingTerminalCall) -> Never:
    code_map = {
        "budget_exceeded": ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED,
        "rate_limiter_unavailable": ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE,
        "billing_required": ApiErrorCode.E_BILLING_REQUIRED,
        "reservation_denied": ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE,
    }
    if exc.code in code_map:
        raise ApiError(code_map[exc.code], exc.detail or exc.code)
    if exc.code == "dispatch_aborted":
        raise DispatchAborted(exc.detail or "dispatch was previously aborted")
    raise RuntimeDefect(
        origin=cast(FailureOrigin, exc.origin or "provider_response"),
        code=exc.code or "terminal_generation_replayed",
        message=exc.detail or str(exc),
    )


def _reservation_defect_facts(exc: ApiError) -> tuple[FailureOrigin, str, str]:
    if exc.code == ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED:
        return "budget", "budget_exceeded", "token budget reservation denied"
    if exc.code == ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE:
        return "budget", "rate_limiter_unavailable", "token-budget limiter unavailable"
    if exc.code == ApiErrorCode.E_BILLING_REQUIRED:
        return "budget", "billing_required", "platform LLM billing required"
    return "budget", "reservation_denied", sanitize_provider_text(str(exc))


def _settle_success_in_transaction(
    db: Session,
    rate_limiter: RateLimiter,
    *,
    user_id: UUID,
    generation_id: UUID,
    reservation_amount: int,
    billability: Billability,
    usage: Presence[TokenUsage],
) -> None:
    if isinstance(billability, (NotDispatched, ConfirmedNonBillable)):
        rate_limiter.release_token_budget_in_transaction(
            db,
            user_id=user_id,
            reservation_id=generation_id,
        )
        return
    if isinstance(usage, Present):
        actual_tokens = usage.value.total_tokens
        if actual_tokens > reservation_amount:
            logger.warning(
                "llm_call.budget_over_bound",
                generation_id=str(generation_id),
                reserved_tokens=reservation_amount,
                actual_tokens=actual_tokens,
            )
        rate_limiter.commit_token_budget_in_transaction(
            db,
            user_id=user_id,
            reservation_id=generation_id,
            actual_tokens=actual_tokens,
        )
        return
    rate_limiter.commit_token_budget_in_transaction(
        db,
        user_id=user_id,
        reservation_id=generation_id,
        actual_tokens=reservation_amount,
    )


def _settle_defect(
    rate_limiter: RateLimiter,
    session_factory: sessionmaker[Session],
    *,
    user_id: UUID,
    generation_id: UUID,
    reservation_amount: int,
    dispatch_attempted: bool,
    defect: BaseException | None,
    fallback_origin: FailureOrigin = "provider_response",
    fallback_code: str = "unclassified_defect",
    fallback_detail: str = "generation ended without a terminal outcome",
) -> None:
    def settle(db: Session) -> None:
        if dispatch_attempted:
            rate_limiter.commit_token_budget_in_transaction(
                db,
                user_id=user_id,
                reservation_id=generation_id,
                actual_tokens=reservation_amount,
            )
        else:
            rate_limiter.release_token_budget_in_transaction(
                db,
                user_id=user_id,
                reservation_id=generation_id,
            )

    origin, code, detail = (
        _defect_facts(defect)
        if defect is not None
        else (fallback_origin, fallback_code, fallback_detail)
    )
    terminalize_defect(
        session_factory,
        generation_id=generation_id,
        origin=origin,
        code=code,
        detail=detail,
        settle=settle,
    )


def _defect_facts(exc: BaseException) -> tuple[FailureOrigin, str, str]:
    if isinstance(exc, RuntimeDefect):
        return exc.origin, exc.code, exc.message
    return "provider_response", "unclassified_defect", sanitize_provider_text(str(exc))
