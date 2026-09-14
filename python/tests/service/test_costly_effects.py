"""Priority proof: one production LLM dispatch has one durable charge."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from time import monotonic
from typing import Literal
from uuid import UUID, uuid4

import pytest
from provider_runtime import (
    Absent,
    CallMeta,
    GenerateIntent,
    Present,
    PromptBlock,
    Succeeded,
    SystemMessage,
    TerminalEvent,
    TextContent,
    TextDelta,
    TextOutput,
    TokenUsage,
    UserMessage,
)
from provider_runtime.testing import ScriptedRuntime
from provider_runtime.types import (
    AttemptRecord,
    FinalAttempt,
    PossiblyBillable,
    ResponsePayload,
)
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.session import create_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.llm_execution import (
    GenerationRequest,
    execute_generation,
    execute_generation_stream,
)
from nexus.services.llm_intent_state import conservative_token_admission_bound
from nexus.services.llm_ledger import (
    ExistingTerminalCall,
    LlmCallOwner,
    TerminalFacts,
    start_call,
    terminalize,
)
from nexus.services.llm_profiles import profile as profile_lookup
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter

_PROFILE = profile_lookup("fast")
assert _PROFILE is not None


def _request(user_id: UUID) -> GenerationRequest:
    intent = GenerateIntent(
        target=_PROFILE.target,
        messages=(
            SystemMessage(blocks=(PromptBlock(text="Answer tersely."),)),
            UserMessage(blocks=(PromptBlock(text="What did I read?"),)),
        ),
        max_output_tokens=64,
        reasoning=_PROFILE.default_reasoning_option_id,
        tools=(),
        tool_choice="auto",
        output=TextOutput(),
    )
    return GenerationRequest(
        generation_id=uuid4(),
        owner=LlmCallOwner(kind="chat_run", id=uuid4(), user_id=user_id),
        operation="chat",
        profile=_PROFILE,
        reasoning=_PROFILE.default_reasoning_option_id,
        intent=intent,
    )


def _success_outcome() -> Succeeded:
    return Succeeded(
        meta=CallMeta(
            provider=_PROFILE.target.provider,
            model=_PROFILE.target.model,
            provider_request_id=Present("req-cost-proof"),
            upstream_provider=Absent(),
            usage=Present(
                TokenUsage(
                    input_tokens=50,
                    output_tokens=20,
                    total_tokens=70,
                    reasoning_tokens=Absent(),
                    cache_read_input_tokens=Absent(),
                    cache_write_input_tokens=Absent(),
                )
            ),
            attempt_trace=(
                AttemptRecord(
                    attempt=1,
                    signal=FinalAttempt(),
                    status_code=Present(200),
                    started_at_ms=0,
                    ended_at_ms=1,
                ),
            ),
            billability=PossiblyBillable(),
            native_reasoning=Present("low"),
            registry_revision="2026-08-11.1",
        ),
        response=ResponsePayload(
            content=TextContent(text="A concise answer.", tool_calls=()),
            continuation=Absent(),
        ),
    )


def _provision_ai_user(
    engine: Engine,
    user_id: UUID,
    *,
    quota_mode: Literal["custom", "unlimited"] = "unlimited",
    token_limit: int | None = None,
) -> None:
    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            user_id,
            f"cost-proof-{user_id}@example.invalid",
        )
        grant_entitlement_override(
            db,
            user_id=user_id,
            plan_tier="ai_pro",
            platform_token_quota_mode=quota_mode,
            platform_token_limit_monthly=token_limit,
            transcription_quota_mode="unlimited",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="production generation cost proof",
            actor_label="nexus-test",
        )
        db.commit()


def _admit_request(
    session_factory: sessionmaker[Session],
    limiter: RateLimiter,
    request: GenerationRequest,
) -> UUID:
    return start_call(
        session_factory,
        generation_id=request.generation_id,
        owner=request.owner,
        operation=request.operation,
        profile=request.profile,
        requested_reasoning=request.reasoning,
        streaming=False,
        admit=lambda db: limiter.reserve_token_budget_in_transaction(
            db,
            user_id=request.owner.user_id,
            reservation_id=request.generation_id,
            est_tokens=conservative_token_admission_bound(request.intent),
        ),
    )


def test_generation_dispatches_once_and_settles_success_or_interruption_exactly_once(
    engine: Engine,
) -> None:
    """Protect money + cancellation at the production ``llm_execution`` owner."""
    user_id = uuid4()
    session_factory = create_session_factory(engine)
    _provision_ai_user(engine, user_id)

    success_request = _request(user_id)
    interrupted_request = _request(user_id)
    success_outcome = _success_outcome()
    expected_interrupted_charge = conservative_token_admission_bound(interrupted_request.intent)
    success_provider = ScriptedRuntime(generate_outcomes=(success_outcome,))
    interrupted_provider = ScriptedRuntime(
        stream_scripts=((TextDelta(text="partial"), TerminalEvent(outcome=success_outcome)),)
    )
    pre_dispatch: list[UUID] = []

    def assert_admitted_before_dispatch(request: GenerationRequest) -> None:
        with Session(engine) as oracle:
            assert oracle.execute(
                text("SELECT outcome FROM llm_calls WHERE id = :generation_id"),
                {"generation_id": request.generation_id},
            ).one() == (None,)
            assert (
                oracle.scalar(
                    text(
                        "SELECT COUNT(*) FROM token_budget_reservations "
                        "WHERE reservation_id = :generation_id"
                    ),
                    {"generation_id": request.generation_id},
                )
                == 1
            )
        pre_dispatch.append(request.generation_id)

    async def execute_scenarios() -> tuple[UUID, TextDelta]:
        success = await execute_generation(
            success_request,
            session_factory=session_factory,
            runtime=success_provider,
            before_dispatch=lambda: assert_admitted_before_dispatch(success_request),
        )
        stream = execute_generation_stream(
            interrupted_request,
            session_factory=session_factory,
            runtime=interrupted_provider,
            cancel=asyncio.Event(),
            before_dispatch=lambda: assert_admitted_before_dispatch(interrupted_request),
        )
        first = await anext(stream)
        await stream.aclose()
        assert isinstance(first.event, TextDelta)
        return success.generation_id, first.event

    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=session_factory))
    try:
        success_id, first_event = asyncio.run(execute_scenarios())
    finally:
        set_rate_limiter(previous_limiter)

    assert first_event.text == "partial", "stream did not reach provider dispatch before closure"
    assert [call.operation for call in success_provider.calls] == ["generate"], (
        "one generation must dispatch exactly once"
    )
    assert [call.operation for call in interrupted_provider.calls] == ["stream"], (
        "one streaming generation must dispatch exactly once"
    )
    assert pre_dispatch == [success_request.generation_id, interrupted_request.generation_id]

    with Session(engine) as oracle:
        success_ledger = oracle.execute(
            text(
                """
                SELECT outcome, total_tokens, error_code
                FROM llm_calls
                WHERE id = :generation_id
                """
            ),
            {"generation_id": success_id},
        ).one()
        success_cost = oracle.execute(
            text(
                """
                SELECT
                    COUNT(charge.reservation_id),
                    COALESCE(SUM(charge.charged_tokens), 0),
                    COUNT(reservation.reservation_id)
                FROM token_budget_charges charge
                FULL JOIN token_budget_reservations reservation
                  ON reservation.reservation_id = charge.reservation_id
                WHERE COALESCE(charge.reservation_id, reservation.reservation_id) = :generation_id
                """
            ),
            {"generation_id": success_id},
        ).one()
        interrupted = oracle.execute(
            text(
                """
                SELECT id, outcome, error_origin, error_code
                FROM llm_calls
                WHERE owner_id = :owner_id
                """
            ),
            {"owner_id": interrupted_request.owner.id},
        ).one()
        interrupted_cost = oracle.execute(
            text(
                """
                SELECT
                    COUNT(charge.reservation_id),
                    COALESCE(SUM(charge.charged_tokens), 0),
                    COUNT(reservation.reservation_id)
                FROM token_budget_charges charge
                FULL JOIN token_budget_reservations reservation
                  ON reservation.reservation_id = charge.reservation_id
                WHERE COALESCE(charge.reservation_id, reservation.reservation_id) = :generation_id
                """
            ),
            {"generation_id": interrupted.id},
        ).one()

    assert success_ledger == ("succeeded", 70, None), (
        f"successful dispatch ledger lost its terminal usage: {success_ledger!r}"
    )
    assert success_cost == (1, 70, 0), (
        f"successful dispatch did not settle one actual-token charge: {success_cost!r}"
    )
    assert interrupted[1:] == (
        "failed",
        "provider_stream",
        "stream_interrupted",
    ), f"consumer cancellation was not durably terminalized: {interrupted!r}"
    assert interrupted_cost == (1, expected_interrupted_charge, 0), (
        "consumer cancellation did not conservatively settle one full reservation: "
        f"{interrupted_cost!r}"
    )


def test_replay_after_start_and_reservation_reuses_one_logical_generation(
    engine: Engine,
) -> None:
    """Injected pre-dispatch crash state resumes one row and one reservation."""
    user_id = uuid4()
    _provision_ai_user(engine, user_id)
    session_factory = create_session_factory(engine)
    request = _request(user_id)
    limiter = RateLimiter(session_factory=session_factory)

    assert _admit_request(session_factory, limiter, request) == request.generation_id
    provider = ScriptedRuntime(generate_outcomes=(_success_outcome(),))
    previous_limiter = get_rate_limiter()
    set_rate_limiter(limiter)
    try:
        result = asyncio.run(
            execute_generation(request, session_factory=session_factory, runtime=provider)
        )
    finally:
        set_rate_limiter(previous_limiter)

    assert result.generation_id == request.generation_id
    assert [call.operation for call in provider.calls] == ["generate"]
    with Session(engine) as db:
        assert (
            db.execute(
                text("SELECT COUNT(*) FROM llm_calls WHERE id = :id AND outcome = 'succeeded'"),
                {"id": request.generation_id},
            ).scalar_one()
            == 1
        )
        assert (
            db.execute(
                text("SELECT COUNT(*) FROM token_budget_charges WHERE reservation_id = :id"),
                {"id": request.generation_id},
            ).scalar_one()
            == 1
        )
        assert (
            db.execute(
                text("SELECT COUNT(*) FROM token_budget_reservations WHERE reservation_id = :id"),
                {"id": request.generation_id},
            ).scalar_one()
            == 0
        )


def test_replay_after_budget_denial_recovers_the_same_expected_failure(engine: Engine) -> None:
    """A committed pre-dispatch denial remains replayable without a second row."""
    user_id = uuid4()
    _provision_ai_user(engine, user_id, quota_mode="custom", token_limit=0)
    session_factory = create_session_factory(engine)
    request = _request(user_id)
    provider = ScriptedRuntime(generate_outcomes=(_success_outcome(),))
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=session_factory))
    try:
        for _ in range(2):
            with pytest.raises(ApiError) as raised:
                asyncio.run(
                    execute_generation(request, session_factory=session_factory, runtime=provider)
                )
            assert raised.value.code == ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED
    finally:
        set_rate_limiter(previous_limiter)

    assert provider.calls == []
    with Session(engine) as db:
        assert (
            db.execute(
                text(
                    "SELECT COUNT(*) FROM llm_calls "
                    "WHERE id = :id AND outcome = 'failed' AND error_code = 'budget_exceeded'"
                ),
                {"id": request.generation_id},
            ).scalar_one()
            == 1
        )


def test_terminal_ledger_and_budget_settlement_roll_back_and_commit_together(
    engine: Engine,
) -> None:
    """A settlement failure cannot publish half of the terminal transaction."""
    user_id = uuid4()
    _provision_ai_user(engine, user_id)
    session_factory = create_session_factory(engine)
    request = _request(user_id)
    limiter = RateLimiter(session_factory=session_factory)
    assert _admit_request(session_factory, limiter, request) == request.generation_id
    outcome = _success_outcome()

    def fail_after_settlement(db: Session, _facts: TerminalFacts) -> None:
        limiter.commit_token_budget_in_transaction(
            db,
            user_id=user_id,
            reservation_id=request.generation_id,
            actual_tokens=70,
        )
        raise RuntimeError("injected failure after budget settlement")

    with pytest.raises(RuntimeError, match="injected failure"):
        terminalize(
            session_factory,
            generation_id=request.generation_id,
            outcome=outcome,
            latency_ms=1,
            settle=fail_after_settlement,
        )

    with Session(engine) as db:
        assert (
            db.scalar(
                text("SELECT outcome FROM llm_calls WHERE id = :id"),
                {"id": request.generation_id},
            )
            is None
        )
        assert (
            db.scalar(
                text("SELECT COUNT(*) FROM token_budget_reservations WHERE reservation_id = :id"),
                {"id": request.generation_id},
            )
            == 1
        )
        assert (
            db.scalar(
                text("SELECT COUNT(*) FROM token_budget_charges WHERE reservation_id = :id"),
                {"id": request.generation_id},
            )
            == 0
        )

    terminalize(
        session_factory,
        generation_id=request.generation_id,
        outcome=outcome,
        latency_ms=1,
        settle=lambda db, _facts: limiter.commit_token_budget_in_transaction(
            db,
            user_id=user_id,
            reservation_id=request.generation_id,
            actual_tokens=70,
        ),
    )
    with Session(engine) as db:
        assert (
            db.scalar(
                text("SELECT outcome FROM llm_calls WHERE id = :id"),
                {"id": request.generation_id},
            )
            == "succeeded"
        )
        assert (
            db.scalar(
                text("SELECT COUNT(*) FROM token_budget_reservations WHERE reservation_id = :id"),
                {"id": request.generation_id},
            )
            == 0
        )
        assert (
            db.scalar(
                text("SELECT COUNT(*) FROM token_budget_charges WHERE reservation_id = :id"),
                {"id": request.generation_id},
            )
            == 1
        )


def test_terminal_settlement_serializes_against_same_generation_readmission(
    engine: Engine,
) -> None:
    """A replay cannot recreate a reservation after the terminal commit."""
    user_id = uuid4()
    _provision_ai_user(engine, user_id)
    session_factory = create_session_factory(engine)
    request = _request(user_id)
    limiter = RateLimiter(session_factory=session_factory)
    assert _admit_request(session_factory, limiter, request) == request.generation_id

    terminal_has_locks = Event()
    replay_started = Event()
    release_terminal = Event()

    def terminal_worker() -> None:
        def settle(db: Session, _facts: TerminalFacts) -> None:
            limiter.commit_token_budget_in_transaction(
                db,
                user_id=user_id,
                reservation_id=request.generation_id,
                actual_tokens=70,
            )
            terminal_has_locks.set()
            assert release_terminal.wait(timeout=10), "test did not release terminal transaction"

        terminalize(
            session_factory,
            generation_id=request.generation_id,
            outcome=_success_outcome(),
            latency_ms=1,
            settle=settle,
        )

    def replay_worker() -> str:
        replay_started.set()
        try:
            _admit_request(session_factory, limiter, request)
        except ExistingTerminalCall:
            return "terminal_seen"
        return "unexpectedly_readmitted"

    with ThreadPoolExecutor(max_workers=2) as pool:
        terminal_future = pool.submit(terminal_worker)
        assert terminal_has_locks.wait(timeout=5), "terminal did not acquire settlement locks"
        replay_future = pool.submit(replay_worker)
        assert replay_started.wait(timeout=5), "replay worker did not start"
        try:
            assert _wait_for_advisory_lock_waiter(engine), (
                "replay did not block on the generation owner's Postgres advisory lock"
            )
        finally:
            release_terminal.set()
        terminal_future.result(timeout=10)
        assert replay_future.result(timeout=10) == "terminal_seen"

    with Session(engine) as db:
        assert (
            db.scalar(
                text("SELECT COUNT(*) FROM llm_calls WHERE id = :id AND outcome = 'succeeded'"),
                {"id": request.generation_id},
            )
            == 1
        )
        assert (
            db.scalar(
                text("SELECT COUNT(*) FROM token_budget_reservations WHERE reservation_id = :id"),
                {"id": request.generation_id},
            )
            == 0
        )
        assert (
            db.scalar(
                text("SELECT COUNT(*) FROM token_budget_charges WHERE reservation_id = :id"),
                {"id": request.generation_id},
            )
            == 1
        )


def _wait_for_advisory_lock_waiter(engine: Engine) -> bool:
    deadline = monotonic() + 5
    while monotonic() < deadline:
        with Session(engine) as db:
            waiting = db.scalar(
                text(
                    """
                    SELECT EXISTS (
                        SELECT 1
                        FROM pg_locks AS lock
                        JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
                        WHERE lock.locktype = 'advisory'
                          AND lock.granted = FALSE
                          AND activity.datname = current_database()
                          AND activity.pid <> pg_backend_pid()
                          AND activity.query LIKE '%pg_advisory_xact_lock%'
                    )
                    """
                )
            )
        if waiting:
            return True
    return False
