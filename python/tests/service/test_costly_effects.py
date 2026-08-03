"""Priority proof: one production LLM dispatch has one durable charge."""

from __future__ import annotations

import asyncio
from uuid import UUID, uuid4

from provider_runtime import (
    Absent,
    CallMeta,
    Dynamic,
    GenerateIntent,
    GlobalScope,
    PossiblyBillable,
    Present,
    PromptBlock,
    ResponsePayload,
    Stable,
    Succeeded,
    SystemMessage,
    TerminalEvent,
    TextContent,
    TextDelta,
    TextOutput,
    TokenUsage,
    UserMessage,
    plan_generate,
)
from provider_runtime.testing import ScriptedRuntime
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.config import Settings
from nexus.db.session import create_session_factory
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.llm_execution import (
    GenerationRequest,
    ProductionExecutionRuntime,
    execute_generation,
    execute_generation_stream,
)
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.llm_profiles import profile as profile_lookup
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter

_PROFILE = profile_lookup("fast")
assert _PROFILE is not None


def _settings() -> Settings:
    return Settings(
        _env_file=None,
        DATABASE_URL="postgresql+psycopg://localhost/test",
        NEXUS_ENV="test",
        SUPABASE_JWKS_URL="http://localhost:54321/auth/v1/.well-known/jwks.json",
        SUPABASE_ISSUER="http://localhost:54321/auth/v1",
        SUPABASE_AUDIENCES="authenticated",
        APP_PUBLIC_URL="http://localhost:3000",
        STRIPE_SECRET_KEY="sk_test",
        STRIPE_WEBHOOK_SECRET="whsec_test",
        STRIPE_PLUS_PRICE_ID="price_plus",
        STRIPE_AI_PLUS_PRICE_ID="price_ai_plus",
        STRIPE_AI_PRO_PRICE_ID="price_ai_pro",
        PODCASTS_ENABLED=True,
        PODCAST_INDEX_API_KEY="test-key",
        PODCAST_INDEX_API_SECRET="test-secret",
        YOUTUBE_DATA_API_KEY="test-youtube-key",
        X_API_BEARER_TOKEN="test-x-token",
        OPENAI_API_KEY="sk-test-openai-key",
    )


def _request(user_id: UUID) -> GenerationRequest:
    intent = GenerateIntent(
        target=_PROFILE.target,
        messages=(
            SystemMessage(
                blocks=(
                    PromptBlock(
                        text="Answer tersely.",
                        stability=Stable(GlobalScope()),
                    ),
                )
            ),
            UserMessage(blocks=(PromptBlock(text="What did I read?", stability=Dynamic()),)),
        ),
        max_output_tokens=64,
        reasoning=_PROFILE.default_reasoning_option_id,
        tools=(),
        tool_choice="auto",
        output=TextOutput(),
    )
    return GenerationRequest(
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
            attempt_trace=(),
            billability=PossiblyBillable(),
        ),
        response=ResponsePayload(
            content=TextContent(text="A concise answer.", tool_calls=()),
            continuation=Absent(),
        ),
    )


def test_generation_dispatches_once_and_settles_success_or_interruption_exactly_once(
    engine: Engine,
) -> None:
    """Protect money + cancellation at the production ``llm_execution`` owner."""
    user_id = uuid4()
    session_factory = create_session_factory(engine)
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
            platform_token_quota_mode="unlimited",
            platform_token_limit_monthly=None,
            transcription_quota_mode="unlimited",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="production generation cost proof",
            actor_label="nexus-test",
        )
        db.commit()

    success_request = _request(user_id)
    interrupted_request = _request(user_id)
    success_outcome = _success_outcome()
    expected_interrupted_charge = plan_generate(
        interrupted_request.intent
    ).accounting.platform_token_reservation
    success_provider = ScriptedRuntime(generate_outcomes=(success_outcome,))
    interrupted_provider = ScriptedRuntime(
        stream_scripts=((TextDelta(text="partial"), TerminalEvent(outcome=success_outcome)),)
    )

    async def execute_scenarios() -> tuple[UUID, TextDelta]:
        success = await execute_generation(
            success_request,
            session_factory=session_factory,
            runtime=ProductionExecutionRuntime(success_provider),
            settings=_settings(),
        )
        stream = execute_generation_stream(
            interrupted_request,
            session_factory=session_factory,
            runtime=ProductionExecutionRuntime(interrupted_provider),
            settings=_settings(),
            cancel=asyncio.Event(),
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
