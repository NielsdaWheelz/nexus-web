"""llm_execution: the sole generation boundary — the 8-step ledger UoW order,
reservation settle-exactly-once, and the ExecutionRuntime fixture seam."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from uuid import UUID, uuid4

import pytest
from provider_runtime import (
    Absent,
    CallMeta,
    Cancelled,
    ConfirmedNonBillable,
    Failed,
    FinalizedProviderCall,
    GenerateIntent,
    GlobalScope,
    Incomplete,
    NotDispatched,
    PossiblyBillable,
    Present,
    ProviderCredential,
    ProviderHttpUnavailable,
    ProviderRuntime,
    ProviderTarget,
    Refused,
    ResponsePayload,
    RuntimeDefect,
    RuntimeStreamEvent,
    Stable,
    Succeeded,
    TerminalEvent,
    TextContent,
    TextDelta,
    TextOutput,
    TokenUsage,
    TransientExhausted,
)
from provider_runtime.types import Dynamic, PromptBlock, SystemMessage, UserMessage
from sqlalchemy import text

from nexus.config import Settings
from nexus.db.models import LLMCall
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.llm_execution import (
    CallOutcome,
    ExecutionRuntime,
    GenerationRequest,
    execute_generation,
    execute_generation_stream,
)
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.llm_profiles import profile as profile_lookup
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from tests.utils.db import task_session_factory

pytestmark = pytest.mark.integration

_PROFILE = profile_lookup("fast")
assert _PROFILE is not None


def _settings(**overrides: object) -> Settings:
    defaults = {
        "DATABASE_URL": "postgresql+psycopg://localhost/test",
        "NEXUS_ENV": "test",
        "SUPABASE_JWKS_URL": "http://localhost:54321/auth/v1/.well-known/jwks.json",
        "SUPABASE_ISSUER": "http://localhost:54321/auth/v1",
        "SUPABASE_AUDIENCES": "authenticated",
        "APP_PUBLIC_URL": "http://localhost:3000",
        "STRIPE_SECRET_KEY": "sk_test",
        "STRIPE_WEBHOOK_SECRET": "whsec_test",
        "STRIPE_PLUS_PRICE_ID": "price_plus",
        "STRIPE_AI_PLUS_PRICE_ID": "price_ai_plus",
        "STRIPE_AI_PRO_PRICE_ID": "price_ai_pro",
        "PODCASTS_ENABLED": True,
        "PODCAST_INDEX_API_KEY": "test-key",
        "PODCAST_INDEX_API_SECRET": "test-secret",
        "YOUTUBE_DATA_API_KEY": "test-youtube-key",
        "X_API_BEARER_TOKEN": "test-x-token",
        "OPENAI_API_KEY": "sk-test-openai-key",
    }
    defaults.update(overrides)
    return Settings(_env_file=None, **defaults)


def _intent(target: ProviderTarget, *, text: str = "hello there") -> GenerateIntent:
    return GenerateIntent(
        target=target,
        messages=(
            SystemMessage(
                blocks=(
                    PromptBlock(
                        text="You are a helpful assistant.", stability=Stable(GlobalScope())
                    ),
                )
            ),
            UserMessage(blocks=(PromptBlock(text=text, stability=Dynamic()),)),
        ),
        max_output_tokens=64,
        reasoning=_PROFILE.default_reasoning_option_id,
        tools=(),
        tool_choice="auto",
        output=TextOutput(),
    )


def _oversized_intent(target: ProviderTarget) -> GenerateIntent:
    # ~1.3MB of user text comfortably exceeds every catalog target's context
    # limit (all >= ~1.0M tokens, bytes-as-tokens conservative bound).
    return _intent(target, text="x" * 1_300_000)


def _meta(**overrides: object) -> CallMeta:
    fields: dict[str, object] = {
        "provider": _PROFILE.target.provider,
        "model": _PROFILE.target.model,
        "provider_request_id": Present("req-abc"),
        "upstream_provider": Absent(),
        "usage": Present(
            TokenUsage(
                input_tokens=50,
                output_tokens=20,
                total_tokens=70,
                reasoning_tokens=Absent(),
                cache_read_input_tokens=Absent(),
                cache_write_input_tokens=Absent(),
            )
        ),
        "attempt_trace": (),
        "billability": PossiblyBillable(),
    }
    fields.update(overrides)
    return CallMeta(**fields)  # type: ignore[arg-type]


@dataclass
class _ScriptedRuntime:
    """A fake `ExecutionRuntime`: scripts one outcome (non-stream) or one
    fixed sequence of stream events, or raises on dispatch."""

    outcome: object = None
    events: list[RuntimeStreamEvent] = field(default_factory=list)
    generate_error: BaseException | None = None
    calls: list[str] = field(default_factory=list)

    async def generate(
        self, intent: GenerateIntent, plan: FinalizedProviderCall, credential: ProviderCredential
    ) -> object:
        self.calls.append("generate")
        if self.generate_error is not None:
            raise self.generate_error
        assert self.outcome is not None
        return self.outcome

    def stream(
        self,
        intent: GenerateIntent,
        plan: FinalizedProviderCall,
        credential: ProviderCredential,
        *,
        cancel: object | None,
    ) -> AsyncIterator[RuntimeStreamEvent]:
        self.calls.append("stream")
        return self._events()

    async def _events(self) -> AsyncIterator[RuntimeStreamEvent]:
        for event in self.events:
            yield event


@pytest.fixture
def user_id(db_session) -> UUID:
    uid = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": uid})
    db_session.flush()
    return uid


@pytest.fixture
def entitled_user_id(db_session, user_id) -> UUID:
    grant_entitlement_override(
        db_session,
        user_id=user_id,
        plan_tier="ai_pro",
        platform_token_quota_mode="unlimited",
        platform_token_limit_monthly=None,
        transcription_quota_mode="unlimited",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="llm_execution integration test",
        actor_label="test",
    )
    return user_id


@pytest.fixture
def factory(db_session):
    return task_session_factory(db_session)


@pytest.fixture(autouse=True)
def _rate_limiter(db_session):
    previous = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=task_session_factory(db_session)))
    yield
    set_rate_limiter(previous)


def _owner(user_id: UUID) -> LlmCallOwner:
    return LlmCallOwner(kind="chat_run", id=uuid4(), user_id=user_id)


def _req(owner: LlmCallOwner) -> GenerationRequest:
    return GenerationRequest(
        owner=owner,
        operation="chat",
        profile=_PROFILE,
        reasoning=_PROFILE.default_reasoning_option_id,
        intent=_intent(_PROFILE.target),
    )


def _reservation_count(db_session, generation_id: UUID) -> int:
    return db_session.execute(
        text("SELECT COUNT(*) FROM token_budget_reservations WHERE reservation_id = :id"),
        {"id": generation_id},
    ).scalar_one()


def _charge_amount(db_session, generation_id: UUID) -> int | None:
    row = db_session.execute(
        text("SELECT charged_tokens FROM token_budget_charges WHERE reservation_id = :id"),
        {"id": generation_id},
    ).first()
    return None if row is None else int(row[0])


class TestEntitlementDenial:
    async def test_execute_generation_raises_with_no_ledger_row(self, db_session, factory, user_id):
        # No entitlement override granted: default free tier, can_use_platform_llm=False.
        req = _req(_owner(user_id))
        runtime = _ScriptedRuntime()

        with pytest.raises(ApiError) as exc_info:
            await execute_generation(
                req, session_factory=factory, runtime=runtime, settings=_settings()
            )
        assert exc_info.value.code == ApiErrorCode.E_BILLING_REQUIRED
        assert runtime.calls == []

        count = db_session.execute(
            text("SELECT COUNT(*) FROM llm_calls WHERE owner_id = :id"), {"id": req.owner.id}
        ).scalar_one()
        assert count == 0

    async def test_execute_generation_stream_raises_with_no_ledger_row(
        self, db_session, factory, user_id
    ):
        req = _req(_owner(user_id))
        runtime = _ScriptedRuntime()

        with pytest.raises(ApiError) as exc_info:
            async for _ in execute_generation_stream(
                req,
                session_factory=factory,
                runtime=runtime,
                settings=_settings(),
                cancel=asyncio.Event(),
            ):
                pass
        assert exc_info.value.code == ApiErrorCode.E_BILLING_REQUIRED

        count = db_session.execute(
            text("SELECT COUNT(*) FROM llm_calls WHERE owner_id = :id"), {"id": req.owner.id}
        ).scalar_one()
        assert count == 0


class TestPlanRejected:
    async def test_context_too_large_terminalizes_intent_origin_no_reservation(
        self, db_session, factory, entitled_user_id
    ):
        owner = _owner(entitled_user_id)
        req = GenerationRequest(
            owner=owner,
            operation="chat",
            profile=_PROFILE,
            reasoning=_PROFILE.default_reasoning_option_id,
            intent=_oversized_intent(_PROFILE.target),
        )
        runtime = _ScriptedRuntime()

        result = await execute_generation(
            req, session_factory=factory, runtime=runtime, settings=_settings()
        )

        assert isinstance(result, CallOutcome)
        assert isinstance(result.outcome, Failed)
        assert runtime.calls == [], "no dispatch on a rejected plan"
        assert isinstance(result.support_id, Present)

        db_session.expire_all()
        call = db_session.get(LLMCall, result.generation_id)
        assert call.outcome == "failed"
        assert call.error_origin == "intent"
        assert call.error_code == "context_too_large"
        assert _reservation_count(db_session, result.generation_id) == 0


class TestSucceeded:
    async def test_succeeded_terminalizes_and_commits_actual_tokens(
        self, db_session, factory, entitled_user_id
    ):
        owner = _owner(entitled_user_id)
        req = _req(owner)
        outcome = Succeeded(
            meta=_meta(),
            response=ResponsePayload(
                content=TextContent(text="hi there", tool_calls=()), continuation=Absent()
            ),
        )
        runtime = _ScriptedRuntime(outcome=outcome)

        result = await execute_generation(
            req, session_factory=factory, runtime=runtime, settings=_settings()
        )

        assert result.outcome is outcome
        assert isinstance(result.support_id, Absent)
        assert runtime.calls == ["generate"]

        db_session.expire_all()
        call = db_session.get(LLMCall, result.generation_id)
        assert call.outcome == "succeeded"
        assert call.total_tokens == 70
        assert call.cost_status == "estimated"
        assert call.provider == _PROFILE.target.provider
        assert call.catalog_revision is not None

        assert _reservation_count(db_session, result.generation_id) == 0
        assert _charge_amount(db_session, result.generation_id) == 70


class TestRefusedIncompleteCancelled:
    async def test_refused_terminalizes_provider_http_with_support_id(
        self, db_session, factory, entitled_user_id
    ):
        req = _req(_owner(entitled_user_id))
        outcome = Refused(meta=_meta(usage=Absent()), safe_detail="declined")
        runtime = _ScriptedRuntime(outcome=outcome)

        result = await execute_generation(
            req, session_factory=factory, runtime=runtime, settings=_settings()
        )

        assert isinstance(result.support_id, Present)
        assert result.support_id.value == result.generation_id.hex[:12]

        db_session.expire_all()
        call = db_session.get(LLMCall, result.generation_id)
        assert call.outcome == "refused"
        assert call.error_origin == "provider_http"
        # NotDispatched|ConfirmedNonBillable would release; here billability is
        # PossiblyBillable + usage Absent -> conservative commit-full.
        assert _charge_amount(db_session, result.generation_id) is not None

    async def test_cancelled_releases_when_not_dispatched(
        self, db_session, factory, entitled_user_id
    ):
        req = _req(_owner(entitled_user_id))
        outcome = Cancelled(meta=_meta(usage=Absent(), billability=NotDispatched()))
        runtime = _ScriptedRuntime(outcome=outcome)

        result = await execute_generation(
            req, session_factory=factory, runtime=runtime, settings=_settings()
        )

        assert isinstance(result.support_id, Absent)
        db_session.expire_all()
        call = db_session.get(LLMCall, result.generation_id)
        assert call.outcome == "cancelled"
        assert call.error_origin is None
        assert _reservation_count(db_session, result.generation_id) == 0
        assert _charge_amount(db_session, result.generation_id) is None

    async def test_confirmed_non_billable_releases(self, db_session, factory, entitled_user_id):
        req = _req(_owner(entitled_user_id))
        outcome = Refused(
            meta=_meta(usage=Absent(), billability=ConfirmedNonBillable()), safe_detail="x"
        )
        runtime = _ScriptedRuntime(outcome=outcome)

        result = await execute_generation(
            req, session_factory=factory, runtime=runtime, settings=_settings()
        )

        db_session.expire_all()
        assert _reservation_count(db_session, result.generation_id) == 0
        assert _charge_amount(db_session, result.generation_id) is None


class TestFailed:
    async def test_failed_transient_exhausted_rate_limited(
        self, db_session, factory, entitled_user_id
    ):
        req = _req(_owner(entitled_user_id))
        failure = TransientExhausted(attempts=1, cause=ProviderHttpUnavailable())
        outcome = Failed(meta=_meta(usage=Absent()), failure=failure)
        runtime = _ScriptedRuntime(outcome=outcome)

        result = await execute_generation(
            req, session_factory=factory, runtime=runtime, settings=_settings()
        )

        assert isinstance(result.support_id, Present)
        db_session.expire_all()
        call = db_session.get(LLMCall, result.generation_id)
        assert call.outcome == "failed"
        assert call.error_origin == "provider_http"
        assert call.error_code == "provider_unavailable"


class TestDefectSettlement:
    async def test_pre_dispatch_defect_releases_reservation(
        self, db_session, factory, entitled_user_id
    ):
        req = _req(_owner(entitled_user_id))
        runtime = _ScriptedRuntime()  # never reached: credential resolution fails first

        with pytest.raises(RuntimeDefect) as exc_info:
            await execute_generation(
                req,
                session_factory=factory,
                runtime=runtime,
                settings=_settings(OPENAI_API_KEY=None),
            )
        assert exc_info.value.code == "credential_missing"
        assert runtime.calls == []

        db_session.expire_all()
        rows = db_session.execute(
            text("SELECT id FROM llm_calls WHERE owner_id = :id"), {"id": req.owner.id}
        ).all()
        assert len(rows) == 1
        generation_id = rows[0][0]
        call = db_session.get(LLMCall, generation_id)
        assert call.outcome == "failed"
        assert call.error_origin == "provider_http"
        assert call.error_code == "credential_missing"
        assert _reservation_count(db_session, generation_id) == 0
        assert _charge_amount(db_session, generation_id) is None

    async def test_post_dispatch_defect_commits_full_reservation(
        self, db_session, factory, entitled_user_id
    ):
        req = _req(_owner(entitled_user_id))
        runtime = _ScriptedRuntime(
            generate_error=RuntimeDefect(
                origin="provider_response", code="unclassified_provider_error", message="boom"
            )
        )

        with pytest.raises(RuntimeDefect):
            await execute_generation(
                req, session_factory=factory, runtime=runtime, settings=_settings()
            )
        assert runtime.calls == ["generate"]

        db_session.expire_all()
        rows = db_session.execute(
            text("SELECT id FROM llm_calls WHERE owner_id = :id"), {"id": req.owner.id}
        ).all()
        generation_id = rows[0][0]
        call = db_session.get(LLMCall, generation_id)
        assert call.outcome == "failed"
        assert call.error_code == "unclassified_provider_error"
        # dispatch was attempted: conservative commit-full, not release.
        assert _reservation_count(db_session, generation_id) == 0
        charged = _charge_amount(db_session, generation_id)
        assert charged is not None and charged > 0


class TestReservationExactlyOnce:
    async def test_settlement_happens_exactly_once_per_generation(
        self, db_session, factory, entitled_user_id
    ):
        req = _req(_owner(entitled_user_id))
        outcome = Succeeded(
            meta=_meta(),
            response=ResponsePayload(
                content=TextContent(text="ok", tool_calls=()), continuation=Absent()
            ),
        )
        runtime = _ScriptedRuntime(outcome=outcome)

        result = await execute_generation(
            req, session_factory=factory, runtime=runtime, settings=_settings()
        )

        db_session.expire_all()
        # Exactly one reservation was ever created (and it is gone: settled) and
        # exactly one charge row exists for this generation id.
        reservation_history = db_session.execute(
            text("SELECT COUNT(*) FROM token_budget_charges WHERE reservation_id = :id"),
            {"id": result.generation_id},
        ).scalar_one()
        assert reservation_history == 1


class TestStreamedRefusal:
    async def test_streamed_incomplete_refused_terminalizes_provider_stream_origin(
        self, db_session, factory, entitled_user_id
    ):
        req = _req(_owner(entitled_user_id))
        terminal = Incomplete(
            meta=_meta(usage=Absent()),
            reason="content_filter_partial",
            status="refused",
            safe_detail=Present("streamed refusal"),
        )
        events = [
            RuntimeStreamEvent(seq=1, event=TextDelta(text="partial")),
            RuntimeStreamEvent(seq=2, event=TerminalEvent(outcome=terminal)),
        ]
        runtime = _ScriptedRuntime(events=events)

        seen = []
        async for event in execute_generation_stream(
            req,
            session_factory=factory,
            runtime=runtime,
            settings=_settings(),
            cancel=asyncio.Event(),
        ):
            seen.append(event)

        assert seen == events
        db_session.expire_all()
        rows = db_session.execute(
            text("SELECT id FROM llm_calls WHERE owner_id = :id"), {"id": req.owner.id}
        ).all()
        assert len(rows) == 1
        call = db_session.get(LLMCall, rows[0][0])
        assert call.outcome == "refused"
        assert call.error_origin == "provider_stream"
        assert call.streaming is True


class TestReservationDefectFaithfulCode:
    """F3: a reservation ApiError must terminalize with its *faithful* code, not
    an unconditional budget_exceeded. F4/F5: any failure after a successful
    reserve settles the reservation exactly once — never leaked to limiter TTL."""

    async def test_reserve_rate_limiter_unavailable_uses_faithful_code(
        self, db_session, factory, entitled_user_id, monkeypatch
    ):
        req = _req(_owner(entitled_user_id))
        runtime = _ScriptedRuntime()
        limiter = get_rate_limiter()

        def _raise(*_args: object, **_kwargs: object) -> None:
            raise ApiError(ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE, "budget limiter down")

        monkeypatch.setattr(limiter, "reserve_token_budget", _raise)

        with pytest.raises(ApiError) as exc_info:
            await execute_generation(
                req, session_factory=factory, runtime=runtime, settings=_settings()
            )
        assert exc_info.value.code == ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE
        assert runtime.calls == []

        db_session.expire_all()
        (generation_id,) = db_session.execute(
            text("SELECT id FROM llm_calls WHERE owner_id = :id"), {"id": req.owner.id}
        ).one()
        call = db_session.get(LLMCall, generation_id)
        assert call.outcome == "failed"
        assert call.error_origin == "budget"
        # Faithful — NOT the budget_exceeded a real quota denial would carry.
        assert call.error_code == "rate_limiter_unavailable"
        assert _reservation_count(db_session, generation_id) == 0
        assert _charge_amount(db_session, generation_id) is None

    async def test_commit_plan_facts_failure_after_reserve_releases(
        self, db_session, factory, entitled_user_id, monkeypatch
    ):
        req = _req(_owner(entitled_user_id))
        outcome = Succeeded(
            meta=_meta(),
            response=ResponsePayload(
                content=TextContent(text="x", tool_calls=()), continuation=Absent()
            ),
        )
        runtime = _ScriptedRuntime(outcome=outcome)

        def _boom(*_args: object, **_kwargs: object) -> None:
            raise RuntimeError("commit_plan_facts DB failure")

        monkeypatch.setattr("nexus.services.llm_execution.commit_plan_facts", _boom)

        with pytest.raises(RuntimeError):
            await execute_generation(
                req, session_factory=factory, runtime=runtime, settings=_settings()
            )
        # commit_plan_facts precedes dispatch: no provider call happened.
        assert runtime.calls == []

        db_session.expire_all()
        (generation_id,) = db_session.execute(
            text("SELECT id FROM llm_calls WHERE owner_id = :id"), {"id": req.owner.id}
        ).one()
        call = db_session.get(LLMCall, generation_id)
        assert call.outcome == "failed"
        # Settled (not left to TTL) and RELEASED — no dispatch was attempted.
        assert _reservation_count(db_session, generation_id) == 0
        assert _charge_amount(db_session, generation_id) is None

    async def test_terminalize_failure_still_settles_committed_full(
        self, db_session, factory, entitled_user_id, monkeypatch
    ):
        req = _req(_owner(entitled_user_id))
        outcome = Succeeded(
            meta=_meta(),
            response=ResponsePayload(
                content=TextContent(text="x", tool_calls=()), continuation=Absent()
            ),
        )
        runtime = _ScriptedRuntime(outcome=outcome)

        def _boom(*_args: object, **_kwargs: object) -> None:
            raise RuntimeError("terminalize DB failure")

        monkeypatch.setattr("nexus.services.llm_execution.terminalize", _boom)

        with pytest.raises(RuntimeError):
            await execute_generation(
                req, session_factory=factory, runtime=runtime, settings=_settings()
            )
        assert runtime.calls == ["generate"]

        db_session.expire_all()
        (generation_id,) = db_session.execute(
            text("SELECT id FROM llm_calls WHERE owner_id = :id"), {"id": req.owner.id}
        ).one()
        call = db_session.get(LLMCall, generation_id)
        # terminalize raised -> defect-settle wrote the terminal row and
        # committed-full (dispatch attempted); reservation not leaked to TTL.
        assert call.outcome == "failed"
        assert _reservation_count(db_session, generation_id) == 0
        charged = _charge_amount(db_session, generation_id)
        assert charged is not None and charged > 0

    async def test_stream_terminalize_failure_still_settles(
        self, db_session, factory, entitled_user_id, monkeypatch
    ):
        req = _req(_owner(entitled_user_id))
        terminal = Succeeded(
            meta=_meta(),
            response=ResponsePayload(
                content=TextContent(text="x", tool_calls=()), continuation=Absent()
            ),
        )
        events = [
            RuntimeStreamEvent(seq=1, event=TextDelta(text="partial")),
            RuntimeStreamEvent(seq=2, event=TerminalEvent(outcome=terminal)),
        ]
        runtime = _ScriptedRuntime(events=events)

        def _boom(*_args: object, **_kwargs: object) -> None:
            raise RuntimeError("terminalize DB failure")

        monkeypatch.setattr("nexus.services.llm_execution.terminalize", _boom)

        with pytest.raises(RuntimeError):
            async for _ in execute_generation_stream(
                req,
                session_factory=factory,
                runtime=runtime,
                settings=_settings(),
                cancel=asyncio.Event(),
            ):
                pass

        db_session.expire_all()
        (generation_id,) = db_session.execute(
            text("SELECT id FROM llm_calls WHERE owner_id = :id"), {"id": req.owner.id}
        ).one()
        call = db_session.get(LLMCall, generation_id)
        assert call.outcome == "failed"
        assert _reservation_count(db_session, generation_id) == 0
        charged = _charge_amount(db_session, generation_id)
        assert charged is not None and charged > 0


class TestExecutionRuntimeProtocol:
    def test_production_execution_runtime_is_structurally_an_execution_runtime(self):
        from nexus.services.llm_execution import ProductionExecutionRuntime

        runtime: ExecutionRuntime = ProductionExecutionRuntime(
            ProviderRuntime.__new__(ProviderRuntime)
        )
        assert hasattr(runtime, "generate")
        assert hasattr(runtime, "stream")
