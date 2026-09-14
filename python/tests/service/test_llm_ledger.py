"""Real-Postgres proof for the sole LLM ledger writer."""

from __future__ import annotations

from datetime import date
from uuid import uuid4

from provider_runtime import Absent, CallMeta, Present, Succeeded, TextContent, TokenUsage
from provider_runtime.types import (
    AttemptRecord,
    FinalAttempt,
    PossiblyBillable,
    ResponsePayload,
)
from sqlalchemy import Engine, text

from nexus.db.session import create_session_factory
from nexus.services.llm_ledger import LlmCallOwner, start_call, terminalize
from nexus.services.llm_profiles import profile as profile_lookup


def test_ledger_preserves_requested_terminal_absence_and_cost_provenance(engine: Engine) -> None:
    """One generation owns one start row and one complete terminal audit record."""
    profile = profile_lookup("fast")
    assert profile is not None
    owner = LlmCallOwner(kind="chat_run", id=uuid4(), user_id=uuid4())
    session_factory = create_session_factory(engine)
    generation_id = uuid4()

    assert (
        start_call(
            session_factory,
            generation_id=generation_id,
            owner=owner,
            operation="chat",
            profile=profile,
            requested_reasoning="high",
            streaming=False,
            admit=lambda _db: None,
        )
        == generation_id
    )
    assert (
        start_call(
            session_factory,
            generation_id=generation_id,
            owner=owner,
            operation="chat",
            profile=profile,
            requested_reasoning="high",
            streaming=False,
            admit=lambda _db: None,
        )
        == generation_id
    )
    with engine.connect() as connection:
        started = connection.execute(
            text(
                """
                SELECT provider, model_name, requested_reasoning, native_reasoning,
                       registry_revision, outcome, cost_status, cost_source, cost_as_of
                FROM llm_calls WHERE id = :id
                """
            ),
            {"id": generation_id},
        ).one()
    assert started == (
        profile.target.provider,
        profile.target.model,
        "high",
        None,
        None,
        None,
        "missing_usage",
        None,
        None,
    )
    with engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT COUNT(*) FROM llm_calls WHERE id = :id"),
                {"id": generation_id},
            ).scalar_one()
            == 1
        )

    usage = TokenUsage(
        input_tokens=100,
        output_tokens=10,
        total_tokens=110,
        reasoning_tokens=Absent(),
        cache_read_input_tokens=Present(20),
        cache_write_input_tokens=Absent(),
    )
    outcome = Succeeded(
        meta=CallMeta(
            provider=profile.target.provider,
            model=profile.target.model,
            provider_request_id=Present("provider-request-ledger"),
            upstream_provider=Absent(),
            usage=Present(usage),
            attempt_trace=(
                AttemptRecord(
                    attempt=1,
                    signal=FinalAttempt(),
                    status_code=Present(200),
                    started_at_ms=100,
                    ended_at_ms=125,
                ),
            ),
            billability=PossiblyBillable(),
            native_reasoning=Present('{"reasoning":{"effort":"high"}}'),
            registry_revision="registry-ledger-1",
        ),
        response=ResponsePayload(
            content=TextContent(text="answer", tool_calls=()),
            continuation=Absent(),
        ),
    )
    facts = terminalize(
        session_factory,
        generation_id=generation_id,
        outcome=outcome,
        latency_ms=25,
        settle=lambda _db, _facts: None,
    )

    assert facts.outcome_tag == "succeeded"
    assert facts.usage == Present(usage)
    assert facts.support_id == Absent()
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                """
                SELECT requested_reasoning, native_reasoning, registry_revision,
                       input_tokens, output_tokens, total_tokens, reasoning_tokens,
                       cache_read_input_tokens, cache_write_input_tokens,
                       outcome, error_origin, error_code, provider_request_id,
                       latency_ms, attempt_count, retry_count, terminal_attempt_status,
                       provider_attempts, total_cost_usd_micros, cost_status,
                       cost_source, cost_as_of
                FROM llm_calls WHERE owner_kind = 'chat_run' AND owner_id = :owner_id
                """
            ),
            {"owner_id": owner.id},
        ).all()
    assert rows == [
        (
            "high",
            '{"reasoning":{"effort":"high"}}',
            "registry-ledger-1",
            100,
            10,
            110,
            None,
            20,
            None,
            "succeeded",
            None,
            None,
            "provider-request-ledger",
            25,
            1,
            0,
            "success",
            [
                {
                    "attempt": 1,
                    "started_at_ms": 100,
                    "ended_at_ms": 125,
                    "status_code": 200,
                    "signal": "final",
                }
            ],
            142,
            "estimated",
            "genai-prices@2026-08-10",
            date(2026, 8, 10),
        )
    ]
