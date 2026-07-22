"""llm_ledger: start_call/commit_plan_facts/terminalize/terminalize_defect —
the sole writer of ``llm_calls``, called only by ``llm_execution``."""

from __future__ import annotations

from uuid import uuid4

import pytest
from provider_runtime import (
    Absent,
    CallMeta,
    Cancelled,
    Failed,
    FinalAttempt,
    GlobalScope,
    Incomplete,
    InvalidToolArguments,
    NotDispatched,
    PlanRejected,
    PossiblyBillable,
    Present,
    ProviderContextTooLarge,
    ProviderRateLimit,
    ProviderTarget,
    Refused,
    ResponsePayload,
    Stable,
    Succeeded,
    TextContent,
    TextOutput,
    TokenUsage,
    TransientExhausted,
    plan_generate,
)
from provider_runtime.types import (
    AttemptRecord,
    Dynamic,
    GenerateIntent,
    PromptBlock,
    SystemMessage,
    UserMessage,
)

from nexus.db.models import LLMCall
from nexus.services.llm_ledger import (
    LlmCallOwner,
    commit_plan_facts,
    start_call,
    terminalize,
    terminalize_defect,
)
from nexus.services.llm_profiles import profile as profile_lookup
from tests.utils.db import task_session_factory

pytestmark = pytest.mark.integration

_PROFILE = profile_lookup("fast")
assert _PROFILE is not None


def _owner() -> LlmCallOwner:
    return LlmCallOwner(kind="chat_run", id=uuid4(), user_id=uuid4())


def _intent(target: ProviderTarget, *, text: str = "hello") -> GenerateIntent:
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


def _meta(**overrides: object) -> CallMeta:
    fields: dict[str, object] = {
        "provider": _PROFILE.target.provider,
        "model": _PROFILE.target.model,
        "provider_request_id": Present("req-123"),
        "upstream_provider": Absent(),
        "usage": Present(
            TokenUsage(
                input_tokens=100,
                output_tokens=40,
                total_tokens=140,
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


def _plan(target: ProviderTarget):
    plan = plan_generate(_intent(target))
    assert not isinstance(plan, PlanRejected)
    return plan


class TestStartCall:
    def test_inserts_a_start_row_before_any_plan_facts(self, db_session):
        owner = _owner()
        generation_id = start_call(
            task_session_factory(db_session),
            owner=owner,
            operation="chat",
            profile=_PROFILE,
            streaming=False,
        )
        db_session.expire_all()
        call = db_session.get(LLMCall, generation_id)
        assert call is not None
        assert call.owner_kind == "chat_run"
        assert call.owner_id == owner.id
        assert call.call_seq == 1
        assert call.provider == _PROFILE.target.provider
        assert call.model_name == _PROFILE.target.model
        assert call.streaming is False
        assert call.reasoning_effort == _PROFILE.default_reasoning_option_id
        assert call.cost_status == "missing_usage"
        assert call.outcome is None

    def test_call_seq_increments_per_owner(self, db_session):
        owner = _owner()
        factory = task_session_factory(db_session)
        first = start_call(
            factory, owner=owner, operation="chat", profile=_PROFILE, streaming=False
        )
        second = start_call(
            factory, owner=owner, operation="chat", profile=_PROFILE, streaming=True
        )
        db_session.expire_all()
        assert db_session.get(LLMCall, first).call_seq == 1
        assert db_session.get(LLMCall, second).call_seq == 2

    def test_call_seq_is_independent_per_owner(self, db_session):
        factory = task_session_factory(db_session)
        one = start_call(
            factory, owner=_owner(), operation="chat", profile=_PROFILE, streaming=False
        )
        two = start_call(
            factory, owner=_owner(), operation="chat", profile=_PROFILE, streaming=False
        )
        db_session.expire_all()
        assert db_session.get(LLMCall, one).call_seq == 1
        assert db_session.get(LLMCall, two).call_seq == 1


class TestCommitPlanFacts:
    def test_updates_row_with_finalized_plan_facts(self, db_session):
        factory = task_session_factory(db_session)
        generation_id = start_call(
            factory, owner=_owner(), operation="chat", profile=_PROFILE, streaming=False
        )
        plan = _plan(_PROFILE.target)

        commit_plan_facts(factory, generation_id=generation_id, profile=_PROFILE, plan=plan)

        db_session.expire_all()
        call = db_session.get(LLMCall, generation_id)
        assert call.reasoning_effort == plan.native_reasoning
        assert call.catalog_revision == plan.catalog_revision
        assert call.request_fingerprint == plan.request_fingerprint
        assert call.pricing_snapshot is not None
        assert (
            call.pricing_snapshot["platform_token_reservation"]
            == plan.accounting.platform_token_reservation
        )
        assert call.cache_strategy is not None


class TestTerminalizeSucceeded:
    def test_succeeded_populates_tokens_and_cost_no_support_id(self, db_session):
        factory = task_session_factory(db_session)
        generation_id = start_call(
            factory, owner=_owner(), operation="chat", profile=_PROFILE, streaming=False
        )
        plan = _plan(_PROFILE.target)
        commit_plan_facts(factory, generation_id=generation_id, profile=_PROFILE, plan=plan)

        outcome = Succeeded(
            meta=_meta(),
            response=ResponsePayload(
                content=TextContent(text="hi", tool_calls=()), continuation=Absent()
            ),
        )
        facts = terminalize(
            factory,
            generation_id=generation_id,
            outcome=outcome,
            accounting=Present(plan.accounting),
            latency_ms=250,
        )

        assert facts.outcome_tag == "succeeded"
        assert isinstance(facts.support_id, Absent)

        db_session.expire_all()
        call = db_session.get(LLMCall, generation_id)
        assert call.outcome == "succeeded"
        assert call.error_origin is None
        assert call.error_code is None
        assert call.input_tokens == 100
        assert call.output_tokens == 40
        assert call.total_tokens == 140
        assert call.cost_status == "estimated"
        assert call.total_cost_usd_micros is not None
        assert call.latency_ms == 250
        assert call.provider_request_id == "req-123"
        assert call.attempt_count == 1
        assert call.retry_count == 0
        assert call.terminal_attempt_status == "success"

    def test_usage_absent_leaves_cost_columns_null(self, db_session):
        factory = task_session_factory(db_session)
        generation_id = start_call(
            factory, owner=_owner(), operation="chat", profile=_PROFILE, streaming=False
        )
        outcome = Succeeded(
            meta=_meta(usage=Absent()),
            response=ResponsePayload(
                content=TextContent(text="hi", tool_calls=()), continuation=Absent()
            ),
        )
        terminalize(
            factory,
            generation_id=generation_id,
            outcome=outcome,
            accounting=Absent(),
            latency_ms=10,
        )
        db_session.expire_all()
        call = db_session.get(LLMCall, generation_id)
        assert call.input_tokens is None
        assert call.total_cost_usd_micros is None
        assert call.cost_status == "missing_usage"


class TestTerminalizeRefusedAndIncomplete:
    def test_refused_non_stream(self, db_session):
        factory = task_session_factory(db_session)
        generation_id = start_call(
            factory, owner=_owner(), operation="chat", profile=_PROFILE, streaming=False
        )
        outcome = Refused(meta=_meta(usage=Absent()), safe_detail="policy refusal")
        facts = terminalize(
            factory, generation_id=generation_id, outcome=outcome, accounting=Absent(), latency_ms=5
        )
        assert facts.outcome_tag == "refused"
        assert isinstance(facts.support_id, Present)
        assert facts.support_id.value == generation_id.hex[:12]

        db_session.expire_all()
        call = db_session.get(LLMCall, generation_id)
        assert call.outcome == "refused"
        assert call.error_origin == "provider_http"
        assert call.error_code == "refused"
        assert call.error_detail == "policy refusal"

    def test_incomplete_status_refused_is_streamed_refusal(self, db_session):
        factory = task_session_factory(db_session)
        generation_id = start_call(
            factory, owner=_owner(), operation="chat", profile=_PROFILE, streaming=True
        )
        outcome = Incomplete(
            meta=_meta(usage=Absent()),
            reason="content_filter_partial",
            status="refused",
            safe_detail=Present("fable refusal"),
        )
        terminalize(
            factory, generation_id=generation_id, outcome=outcome, accounting=Absent(), latency_ms=5
        )
        db_session.expire_all()
        call = db_session.get(LLMCall, generation_id)
        assert call.outcome == "refused"
        assert call.error_origin == "provider_stream"
        assert call.error_code == "refused"
        assert call.error_detail == "fable refusal"

    def test_incomplete_status_provider_incomplete(self, db_session):
        factory = task_session_factory(db_session)
        generation_id = start_call(
            factory, owner=_owner(), operation="chat", profile=_PROFILE, streaming=False
        )
        outcome = Incomplete(
            meta=_meta(usage=Absent()),
            reason="max_output_tokens",
            status="provider_incomplete",
            safe_detail=Absent(),
        )
        terminalize(
            factory, generation_id=generation_id, outcome=outcome, accounting=Absent(), latency_ms=5
        )
        db_session.expire_all()
        call = db_session.get(LLMCall, generation_id)
        assert call.outcome == "incomplete"
        assert call.error_origin == "provider_response"
        assert call.error_code == "incomplete"
        assert call.error_detail is None


class TestTerminalizeCancelled:
    def test_cancelled_has_no_support_id_and_no_error_columns(self, db_session):
        factory = task_session_factory(db_session)
        generation_id = start_call(
            factory, owner=_owner(), operation="chat", profile=_PROFILE, streaming=True
        )
        outcome = Cancelled(meta=_meta(usage=Absent(), billability=NotDispatched()))
        facts = terminalize(
            factory, generation_id=generation_id, outcome=outcome, accounting=Absent(), latency_ms=5
        )
        assert facts.outcome_tag == "cancelled"
        assert isinstance(facts.support_id, Absent)

        db_session.expire_all()
        call = db_session.get(LLMCall, generation_id)
        assert call.outcome == "cancelled"
        assert call.error_origin is None
        assert call.error_code is None
        assert call.terminal_attempt_status == "abandoned"


class TestTerminalizeFailed:
    def test_failed_rate_limited_maps_origin_code_and_attempt_trace(self, db_session):
        factory = task_session_factory(db_session)
        generation_id = start_call(
            factory, owner=_owner(), operation="chat", profile=_PROFILE, streaming=False
        )
        trace = (
            AttemptRecord(
                attempt=1,
                signal=ProviderRateLimit(retry_after=Present(2.5)),
                status_code=Present(429),
                started_at_ms=0,
                ended_at_ms=100,
            ),
            AttemptRecord(
                attempt=2,
                signal=FinalAttempt(),
                status_code=Present(429),
                started_at_ms=200,
                ended_at_ms=300,
            ),
        )
        failure = TransientExhausted(attempts=2, cause=ProviderRateLimit(retry_after=Absent()))
        outcome = Failed(meta=_meta(usage=Absent(), attempt_trace=trace), failure=failure)

        facts = terminalize(
            factory,
            generation_id=generation_id,
            outcome=outcome,
            accounting=Absent(),
            latency_ms=400,
        )
        assert facts.outcome_tag == "failed"
        assert isinstance(facts.support_id, Present)
        assert facts.support_id.value == generation_id.hex[:12]

        db_session.expire_all()
        call = db_session.get(LLMCall, generation_id)
        assert call.outcome == "failed"
        assert call.error_origin == "provider_http"
        assert call.error_code == "rate_limited"
        assert call.attempt_count == 2
        assert call.retry_count == 1
        assert call.terminal_attempt_status == "terminal_error"
        attempts = call.provider_attempts
        assert attempts[0]["attempt"] == 1
        assert attempts[0]["origin"] == "provider_http"
        assert attempts[0]["code"] == "rate_limited"
        assert attempts[0]["retry_after"] == 2.5
        assert attempts[0]["status_code"] == 429
        assert attempts[1]["signal"] == "final"
        assert "origin" not in attempts[1]

    def test_invalid_tool_arguments_carries_safe_detail(self, db_session):
        factory = task_session_factory(db_session)
        generation_id = start_call(
            factory, owner=_owner(), operation="chat", profile=_PROFILE, streaming=False
        )
        failure = InvalidToolArguments(safe_detail="malformed arguments for tool X")
        outcome = Failed(meta=_meta(usage=Absent()), failure=failure)
        terminalize(
            factory, generation_id=generation_id, outcome=outcome, accounting=Absent(), latency_ms=1
        )
        db_session.expire_all()
        call = db_session.get(LLMCall, generation_id)
        assert call.error_origin == "tool_arguments"
        assert call.error_code == "invalid_tool_arguments"
        assert call.error_detail == "malformed arguments for tool X"

    def test_provider_context_too_large_is_provider_http_origin(self, db_session):
        factory = task_session_factory(db_session)
        generation_id = start_call(
            factory, owner=_owner(), operation="chat", profile=_PROFILE, streaming=False
        )
        outcome = Failed(meta=_meta(usage=Absent()), failure=ProviderContextTooLarge())
        terminalize(
            factory, generation_id=generation_id, outcome=outcome, accounting=Absent(), latency_ms=1
        )
        db_session.expire_all()
        call = db_session.get(LLMCall, generation_id)
        assert call.error_origin == "provider_http"
        assert call.error_code == "context_too_large"


class TestTerminalizeDefect:
    def test_sets_failed_outcome_and_returns_support_id(self, db_session):
        factory = task_session_factory(db_session)
        generation_id = start_call(
            factory, owner=_owner(), operation="chat", profile=_PROFILE, streaming=False
        )
        support_id = terminalize_defect(
            factory,
            generation_id=generation_id,
            origin="plan",
            code="schema_violation",
            detail="bad schema",
        )
        assert support_id == generation_id.hex[:12]

        db_session.expire_all()
        call = db_session.get(LLMCall, generation_id)
        assert call.outcome == "failed"
        assert call.error_origin == "plan"
        assert call.error_code == "schema_violation"
        assert call.error_detail == "bad schema"
        assert call.cost_status == "missing_usage"
        assert call.terminal_attempt_status == "terminal_error"
        assert call.attempt_count == 1
        assert call.retry_count == 0
