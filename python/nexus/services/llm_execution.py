"""The sole LLM generation boundary.

``execute_generation`` / ``execute_generation_stream`` are the only nexus
callers of the ``ExecutionRuntime`` seam (production
:class:`ProductionExecutionRuntime` delegating to
``provider_runtime.ProviderRuntime``, or a real-media fixture — see
``nexus.tasks.llm_task``) and of ``nexus.services.llm_ledger``. Every owner
(chat, oracle, synapse, media summary/enrichment, artifact revisions, dawn
write) builds one ``GenerationRequest`` per provider call and calls one of
these two functions; neither ever appears twice in one call.

The 8-step order (``docs/cutovers/llm-provider-runtime-hard-cutover.md``
§9/§11), all ledger mutations in dedicated, immediately-committed sessions
from ``session_factory``:

1. Entitlement check (``billing_entitlements.can_use_platform_llm``) —
   *before* any ``llm_calls`` row. Denial raises :class:`ApiError` with no
   ledger row at all (distinct from ``budget_exceeded``: plan-tier
   ineligibility, not quota).
2. Allocate the generation id + INSERT the ``llm_calls`` start row
   (:func:`llm_ledger.start_call`), committed.
3. ``plan = plan_generate(req.intent)``. ``PlanRejected`` (the intent
   measures oversize) terminalizes {origin="intent", code="context_too_large"}
   and returns a :class:`CallOutcome` carrying a synthesized
   ``provider_runtime.Failed`` (no dispatch attempted). A raised
   ``PlanningDefect``/``RuntimeDefect`` terminalizes with its own
   origin/code and re-raises.
4. ``reserve_token_budget(generation_id, plan.accounting.platform_token_
   reservation)`` — denial terminalizes {origin="budget",
   code="budget_exceeded"} and re-raises the same ``ApiError`` (the sole
   budget-denial site). Reservation succeeding precedes
   :func:`llm_ledger.commit_plan_facts`, committed.
5. Dispatch ``runtime.generate``/``runtime.stream`` with the resolved
   platform ``generation_credential``.
6. Terminalize from the outcome (:func:`llm_ledger.terminalize`), committed
   before any owner-side postprocessing.
7. Settle the reservation exactly once (:func:`_settle` / the defect-path
   ``finally`` blocks below) — never left to limiter TTL expiry.
8. One structured log at terminalize (inside ``llm_ledger``).

No ``GenerationHandle``: the generation id is exposed only via the terminal
path — :class:`CallOutcome` on the non-stream return; on the stream side the
type is exactly ``AsyncIterator[RuntimeStreamEvent]`` (unmodified
``provider_runtime`` envelopes), so entitlement/budget denial — which have no
representable leaf in ``provider_runtime``'s closed outcome unions — raise
rather than being folded into a synthesized terminal event; only
``PlanRejected`` (a real ``IntentContextTooLarge`` leaf) is synthesized as a
terminal ``RuntimeStreamEvent``.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from provider_runtime import (
    Absent,
    Billability,
    CallMeta,
    CancelSignal,
    ConfirmedNonBillable,
    Failed,
    FailureOrigin,
    FinalizedProviderCall,
    GenerateIntent,
    NotDispatched,
    PlanningDefect,
    PlanRejected,
    Presence,
    Present,
    ProviderCredential,
    ProviderRuntime,
    ReasoningLevel,
    RuntimeDefect,
    RuntimeStreamEvent,
    TerminalEvent,
    TokenUsage,
    plan_generate,
    sanitize_provider_text,
)
from provider_runtime import (
    CallOutcome as ProviderCallOutcome,
)
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import Settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.billing_entitlements import get_effective_entitlements
from nexus.services.llm_credentials import generation_credential
from nexus.services.llm_ledger import (
    LlmCallOwner,
    commit_plan_facts,
    start_call,
    terminalize,
    terminalize_defect,
)
from nexus.services.llm_profiles import LlmOperation, LlmProfile
from nexus.services.rate_limit import RateLimiter, get_rate_limiter

logger = get_logger(__name__)

__all__ = [
    "CallOutcome",
    "ExecutionRuntime",
    "GenerationRequest",
    "ProductionExecutionRuntime",
    "execute_generation",
    "execute_generation_stream",
]


# =============================================================================
# Request / result
# =============================================================================


@dataclass(frozen=True, slots=True)
class GenerationRequest:
    """One provider call an owner wants ledgered and dispatched.

    ``intent`` is built eagerly by the owner (so owner-side prompt assembly
    happens before any ledger row, per §9's "domain prompt first" order).
    ``__post_init__`` validates the request is internally consistent — a
    mismatch is a broken owner invariant, so it raises ``PlanningDefect``
    directly at construction, before this request can reach a ledger row.
    """

    owner: LlmCallOwner
    operation: LlmOperation
    profile: LlmProfile
    reasoning: ReasoningLevel
    intent: GenerateIntent

    def __post_init__(self) -> None:
        if self.intent.target != self.profile.target:
            raise PlanningDefect(
                code="intent_profile_target_mismatch",
                message=(
                    f"GenerateIntent.target={self.intent.target!r} does not match "
                    f"GenerationRequest.profile.target={self.profile.target!r}"
                ),
            )
        if self.intent.reasoning != self.reasoning:
            raise PlanningDefect(
                code="intent_profile_reasoning_mismatch",
                message=(
                    f"GenerateIntent.reasoning={self.intent.reasoning!r} does not match "
                    f"GenerationRequest.reasoning={self.reasoning!r}"
                ),
            )


@dataclass(frozen=True, slots=True)
class CallOutcome:
    """``execute_generation``'s return: the provider outcome plus the ledger
    identity needed for operator correlation — exposed only here, at the
    terminal, never via a pre-dispatch handle."""

    generation_id: UUID
    outcome: ProviderCallOutcome
    support_id: Presence[str]


# =============================================================================
# Fixture seam (Option B — ``docs/cutovers/llm-provider-runtime-hard-cutover.md``
# "Fixture seam"): a small structural runtime llm_execution dispatches
# through. Production delegates to ``provider_runtime.ProviderRuntime``
# (ignoring ``intent`` — the finalized plan is authoritative); a real-media
# fixture impl (``nexus.services.real_media_fixture_llm``) scripts outcomes
# from the typed ``intent`` instead. ``nexus.tasks.llm_task`` constructs one
# or the other, keyed on ``settings.real_media_provider_fixtures`` — no
# enable flags. llm_execution is the sole caller of either.
# =============================================================================


class ExecutionRuntime(Protocol):
    async def generate(
        self,
        intent: GenerateIntent,
        plan: FinalizedProviderCall,
        credential: ProviderCredential,
    ) -> ProviderCallOutcome: ...

    def stream(
        self,
        intent: GenerateIntent,
        plan: FinalizedProviderCall,
        credential: ProviderCredential,
        *,
        cancel: CancelSignal | None,
    ) -> AsyncIterator[RuntimeStreamEvent]: ...


@dataclass(frozen=True, slots=True)
class ProductionExecutionRuntime:
    """The production `ExecutionRuntime`: delegates to `ProviderRuntime`,
    ignoring `intent` (the finalized `plan` is authoritative for dispatch)."""

    provider_runtime: ProviderRuntime

    async def generate(
        self,
        intent: GenerateIntent,
        plan: FinalizedProviderCall,
        credential: ProviderCredential,
    ) -> ProviderCallOutcome:
        _ = intent
        return await self.provider_runtime.generate(plan, credential=credential)

    def stream(
        self,
        intent: GenerateIntent,
        plan: FinalizedProviderCall,
        credential: ProviderCredential,
        *,
        cancel: CancelSignal | None,
    ) -> AsyncIterator[RuntimeStreamEvent]:
        _ = intent
        return self.provider_runtime.stream(plan, credential=credential, cancel=cancel)


# =============================================================================
# execute_generation (non-stream)
# =============================================================================


async def execute_generation(
    req: GenerationRequest,
    *,
    session_factory: sessionmaker[Session],
    runtime: ExecutionRuntime,
    settings: Settings,
) -> CallOutcome:
    _check_entitlement(session_factory, user_id=req.owner.user_id)

    generation_id = start_call(
        session_factory,
        owner=req.owner,
        operation=req.operation,
        profile=req.profile,
        streaming=False,
    )

    plan = _plan(session_factory, generation_id=generation_id, req=req)
    if isinstance(plan, PlanRejected):
        rejected_outcome: ProviderCallOutcome = Failed(
            meta=_synthetic_meta(req.profile), failure=plan.failure
        )
        facts = terminalize(
            session_factory,
            generation_id=generation_id,
            outcome=rejected_outcome,
            accounting=Absent(),
            latency_ms=None,
        )
        return CallOutcome(generation_id, rejected_outcome, facts.support_id)

    rate_limiter = get_rate_limiter()
    _reserve(
        session_factory,
        rate_limiter,
        user_id=req.owner.user_id,
        generation_id=generation_id,
        plan=plan,
    )

    # One settle-guarded region for every step past a successful reserve
    # (commit_plan_facts, dispatch, terminalize, success-settle): any exit that
    # has not already settled routes through the `finally`'s `_settle_defect`,
    # so a post-reserve failure is never left to limiter TTL expiry (§9 step
    # 7). `settled` makes settlement happen exactly once.
    dispatch_attempted = False
    settled = False
    defect: BaseException | None = None
    started = time.monotonic()
    try:
        commit_plan_facts(
            session_factory, generation_id=generation_id, profile=req.profile, plan=plan
        )
        credential = generation_credential(settings, req.profile.target.provider)
        dispatch_attempted = True
        started = time.monotonic()
        outcome = await runtime.generate(req.intent, plan, credential)
        latency_ms = int((time.monotonic() - started) * 1000)
        facts = terminalize(
            session_factory,
            generation_id=generation_id,
            outcome=outcome,
            accounting=Present(plan.accounting),
            latency_ms=latency_ms,
        )
        # terminalize committed the terminal row; this call now owns the
        # success-settle. Mark settled *before* it so a raise inside
        # `_settle_success` cannot trigger a second (defect) settle.
        settled = True
        _settle_success(
            rate_limiter,
            user_id=req.owner.user_id,
            generation_id=generation_id,
            reservation_amount=plan.accounting.platform_token_reservation,
            billability=facts.billability,
            usage=facts.usage,
        )
        return CallOutcome(generation_id, outcome, facts.support_id)
    except BaseException as exc:
        defect = exc
        raise
    finally:
        if not settled:
            _settle_defect(
                rate_limiter,
                session_factory,
                user_id=req.owner.user_id,
                generation_id=generation_id,
                reservation_amount=plan.accounting.platform_token_reservation,
                dispatch_attempted=dispatch_attempted,
                defect=defect,
            )


# =============================================================================
# execute_generation_stream
# =============================================================================


async def execute_generation_stream(
    req: GenerationRequest,
    *,
    session_factory: sessionmaker[Session],
    runtime: ExecutionRuntime,
    settings: Settings,
    cancel: CancelSignal,
) -> AsyncIterator[RuntimeStreamEvent]:
    _check_entitlement(session_factory, user_id=req.owner.user_id)

    generation_id = start_call(
        session_factory,
        owner=req.owner,
        operation=req.operation,
        profile=req.profile,
        streaming=True,
    )

    plan = _plan(session_factory, generation_id=generation_id, req=req)
    if isinstance(plan, PlanRejected):
        synthetic: ProviderCallOutcome = Failed(
            meta=_synthetic_meta(req.profile), failure=plan.failure
        )
        terminalize(
            session_factory,
            generation_id=generation_id,
            outcome=synthetic,
            accounting=Absent(),
            latency_ms=None,
        )
        yield RuntimeStreamEvent(seq=1, event=TerminalEvent(outcome=synthetic))
        return

    rate_limiter = get_rate_limiter()
    _reserve(
        session_factory,
        rate_limiter,
        user_id=req.owner.user_id,
        generation_id=generation_id,
        plan=plan,
    )
    # One settle-guarded region for every step past a successful reserve
    # (commit_plan_facts, dispatch, terminalize, success-settle) — see the
    # non-stream twin. `settled` is set only after terminalize *and* the
    # success-settle return, so a terminalize failure (or a consumer closing
    # the iterator early) leaves it False and the `finally` settles the
    # reservation exactly once rather than leaking it to limiter TTL (§9 step 7).
    dispatch_attempted = False
    settled = False
    defect: BaseException | None = None
    started = time.monotonic()
    try:
        commit_plan_facts(
            session_factory, generation_id=generation_id, profile=req.profile, plan=plan
        )
        credential = generation_credential(settings, req.profile.target.provider)
        dispatch_attempted = True
        started = time.monotonic()
        async for event in runtime.stream(req.intent, plan, credential, cancel=cancel):
            if isinstance(event.event, TerminalEvent):
                latency_ms = int((time.monotonic() - started) * 1000)
                facts = terminalize(
                    session_factory,
                    generation_id=generation_id,
                    outcome=event.event.outcome,
                    accounting=Present(plan.accounting),
                    latency_ms=latency_ms,
                )
                # See the non-stream twin: mark settled only after terminalize
                # returns and *before* the success-settle.
                settled = True
                _settle_success(
                    rate_limiter,
                    user_id=req.owner.user_id,
                    generation_id=generation_id,
                    reservation_amount=plan.accounting.platform_token_reservation,
                    billability=facts.billability,
                    usage=facts.usage,
                )
            yield event
    except BaseException as exc:
        defect = exc
        raise
    finally:
        if not settled:
            _settle_defect(
                rate_limiter,
                session_factory,
                user_id=req.owner.user_id,
                generation_id=generation_id,
                reservation_amount=plan.accounting.platform_token_reservation,
                dispatch_attempted=dispatch_attempted,
                defect=defect,
                fallback_origin="provider_stream",
                fallback_code="stream_interrupted",
                fallback_detail="stream closed before a terminal event was observed",
            )


# =============================================================================
# Shared step helpers
# =============================================================================


def _check_entitlement(session_factory: sessionmaker[Session], *, user_id: UUID) -> None:
    with session_factory() as db:
        entitlements = get_effective_entitlements(db, user_id)
        db.commit()
    if not entitlements.can_use_platform_llm:
        raise ApiError(ApiErrorCode.E_BILLING_REQUIRED, "Platform LLM access requires an AI tier.")


def _plan(
    session_factory: sessionmaker[Session],
    *,
    generation_id: UUID,
    req: GenerationRequest,
) -> FinalizedProviderCall | PlanRejected:
    try:
        return plan_generate(req.intent)
    except (PlanningDefect, RuntimeDefect) as exc:
        terminalize_defect(
            session_factory,
            generation_id=generation_id,
            origin=exc.origin,
            code=exc.code,
            detail=exc.message,
        )
        raise


def _reserve(
    session_factory: sessionmaker[Session],
    rate_limiter: RateLimiter,
    *,
    user_id: UUID,
    generation_id: UUID,
    plan: FinalizedProviderCall,
) -> None:
    try:
        rate_limiter.reserve_token_budget(
            user_id, generation_id, plan.accounting.platform_token_reservation
        )
    except ApiError as exc:
        origin, code, detail = _reservation_defect_facts(exc)
        terminalize_defect(
            session_factory,
            generation_id=generation_id,
            origin=origin,
            code=code,
            detail=detail,
        )
        raise


def _reservation_defect_facts(exc: ApiError) -> tuple[FailureOrigin, str, str]:
    """Faithful (origin, code, detail) for a reservation denial. All three
    denials arise in the token-budget subsystem, so origin is the representable
    ``"budget"`` FailureOrigin leaf (no ``platform``/``entitlement`` origin
    exists in provider_runtime's closed set); the *code* carries the true
    cause. Only a real quota denial is ``budget_exceeded`` — a rate-limiter
    outage or a billing gate must never be mislabelled as quota-exhaustion
    (which the chat surface would render as "Monthly AI token quota exceeded").
    For chat these non-budget codes route through ``finalize_defect`` (generic
    non-rerunnable card); no ``ExpectedChatFailure`` variant asserts on them."""
    if exc.code == ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED:
        return "budget", "budget_exceeded", "token budget reservation denied"
    if exc.code == ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE:
        return "budget", "rate_limiter_unavailable", "token-budget limiter unavailable"
    if exc.code == ApiErrorCode.E_BILLING_REQUIRED:
        return "budget", "billing_required", "platform LLM billing required"
    # Any other reservation ApiError: faithful generic, never silent budget.
    return "budget", "reservation_denied", sanitize_provider_text(str(exc))


def _settle_success(
    rate_limiter: RateLimiter,
    *,
    user_id: UUID,
    generation_id: UUID,
    reservation_amount: int,
    billability: Billability,
    usage: Presence[TokenUsage],
) -> None:
    if isinstance(billability, (NotDispatched, ConfirmedNonBillable)):
        rate_limiter.release_token_budget(user_id, generation_id)
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
        rate_limiter.commit_token_budget(user_id, generation_id, actual_tokens)
        return
    # PossiblyBillable + usage Absent: dispatch happened but no usage was
    # reported — commit the full reservation (conservative, §9 step 7).
    rate_limiter.commit_token_budget(user_id, generation_id, reservation_amount)


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
    """Settle-and-terminalize for any exit past step 4 (reserve) that never
    reached a real terminal outcome — an exception, or (stream only) the
    consumer closing the iterator early. Dispatch state unknown ⇒ conservative
    commit-full, matching the runtime's own ``PossiblyBillable`` + usage
    ``Absent`` handling; never released to limiter TTL expiry."""
    if dispatch_attempted:
        rate_limiter.commit_token_budget(user_id, generation_id, reservation_amount)
    else:
        rate_limiter.release_token_budget(user_id, generation_id)

    if defect is not None:
        origin, code, detail = _defect_facts(defect)
    else:
        origin, code, detail = fallback_origin, fallback_code, fallback_detail
    terminalize_defect(
        session_factory, generation_id=generation_id, origin=origin, code=code, detail=detail
    )


def _defect_facts(exc: BaseException) -> tuple[FailureOrigin, str, str]:
    if isinstance(exc, RuntimeDefect):
        return exc.origin, exc.code, exc.message
    return "provider_response", "unclassified_defect", sanitize_provider_text(str(exc))


def _synthetic_meta(profile: LlmProfile) -> CallMeta:
    """A `CallMeta` for outcomes synthesized without a real dispatch
    (`PlanRejected`): no bytes reached the provider, no attempts, no usage."""
    return CallMeta(
        provider=profile.target.provider,
        model=profile.target.model,
        provider_request_id=Absent(),
        upstream_provider=Absent(),
        usage=Absent(),
        attempt_trace=(),
        billability=NotDispatched(),
    )
