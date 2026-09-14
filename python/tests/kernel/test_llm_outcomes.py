"""Pure proof for the Nexus-owned provider-outcome ledger vocabulary."""

from __future__ import annotations

from datetime import date

from provider_runtime import Absent, CallMeta, Cancelled, Failed, Incomplete, Present, Refused
from provider_runtime import Succeeded as ProviderSucceeded
from provider_runtime.types import (
    AttemptRecord,
    FinalAttempt,
    InvalidStructuredOutput,
    InvalidToolArguments,
    PossiblyBillable,
    ProviderContextTooLarge,
    ProviderHttpUnavailable,
    ProviderName,
    ProviderRateLimit,
    ProviderStreamInterrupted,
    ProviderTimeout,
    ResponsePayload,
    StructuredContent,
    TokenUsage,
    TransientExhausted,
    TransportUnavailable,
)

from nexus.services.llm_outcomes import (
    attempt_trace_facts,
    outcome_failure_facts,
    terminal_cost_facts,
)


def _meta(
    *,
    provider: ProviderName = "openai",
    model: str = "gpt-5.6-luna",
    usage: TokenUsage | None = None,
) -> CallMeta:
    return CallMeta(
        provider=provider,
        model=model,
        provider_request_id=Present("provider-request-1"),
        upstream_provider=Absent(),
        usage=Absent() if usage is None else Present(usage),
        attempt_trace=(
            AttemptRecord(
                attempt=1,
                signal=FinalAttempt(),
                status_code=Present(200),
                started_at_ms=10,
                ended_at_ms=20,
            ),
        ),
        billability=PossiblyBillable(),
        native_reasoning=Present('{"reasoning":{"effort":"high"}}'),
        registry_revision="registry-test-1",
    )


def _success(meta: CallMeta) -> ProviderSucceeded:
    return ProviderSucceeded(
        meta=meta,
        response=ResponsePayload(
            content=StructuredContent(payload={"answer": "ok"}, text='{"answer":"ok"}'),
            continuation=Absent(),
        ),
    )


def test_outcome_failure_facts_exhaustively_match_the_ledger_contract() -> None:
    """Provider terminals must map to the fixed safe origin/code vocabulary."""
    meta = _meta()
    cases = (
        (_success(meta), ("succeeded", None, None, None)),
        (
            Refused(meta=meta, safe_detail="policy refusal"),
            ("refused", "provider_http", "refused", "policy refusal"),
        ),
        (
            Incomplete(
                meta=meta,
                reason="content_filter_partial",
                status="refused",
                safe_detail=Present("stream refusal"),
            ),
            ("refused", "provider_stream", "refused", "stream refusal"),
        ),
        (
            Incomplete(
                meta=meta,
                reason="max_output_tokens",
                status="provider_incomplete",
                safe_detail=Absent(),
            ),
            ("incomplete", "provider_response", "incomplete", None),
        ),
        (Cancelled(meta=meta), ("cancelled", None, None, None)),
        (
            Failed(meta=meta, failure=ProviderContextTooLarge()),
            ("failed", "provider_http", "context_too_large", None),
        ),
        (
            Failed(meta=meta, failure=InvalidToolArguments(safe_detail="bad tool args")),
            ("failed", "tool_arguments", "invalid_tool_arguments", "bad tool args"),
        ),
        (
            Failed(meta=meta, failure=InvalidStructuredOutput(safe_detail="bad JSON")),
            ("failed", "provider_response", "invalid_structured_output", "bad JSON"),
        ),
        (
            Failed(
                meta=meta,
                failure=TransientExhausted(
                    attempts=1,
                    cause=ProviderRateLimit(retry_after=Present(0.5)),
                ),
            ),
            ("failed", "provider_http", "rate_limited", None),
        ),
        (
            Failed(
                meta=meta,
                failure=TransientExhausted(attempts=1, cause=ProviderTimeout()),
            ),
            ("failed", "transport", "timeout", None),
        ),
        (
            Failed(
                meta=meta,
                failure=TransientExhausted(attempts=1, cause=ProviderHttpUnavailable()),
            ),
            ("failed", "provider_http", "provider_unavailable", None),
        ),
        (
            Failed(
                meta=meta,
                failure=TransientExhausted(attempts=1, cause=TransportUnavailable()),
            ),
            ("failed", "transport", "provider_unavailable", None),
        ),
        (
            Failed(
                meta=meta,
                failure=TransientExhausted(
                    attempts=1,
                    cause=ProviderStreamInterrupted(partial_output=True),
                ),
            ),
            ("failed", "provider_stream", "stream_interrupted", None),
        ),
    )

    for outcome, expected in cases:
        actual = outcome_failure_facts(outcome)
        assert (
            actual.outcome_tag,
            actual.error_origin,
            actual.error_code,
            actual.error_detail,
        ) == expected


def test_terminal_cost_and_attempt_facts_preserve_absence_and_provenance() -> None:
    """Cost tri-state and retry telemetry must not guess absent provider facts."""
    usage = TokenUsage(
        input_tokens=100,
        output_tokens=10,
        total_tokens=110,
        reasoning_tokens=Absent(),
        cache_read_input_tokens=Present(20),
        cache_write_input_tokens=Present(10),
    )
    estimated = terminal_cost_facts(_meta(usage=usage))
    assert (
        estimated.total_cost_usd_micros,
        estimated.cost_status,
        estimated.cost_source,
        estimated.cost_as_of,
    ) == (145, "estimated", "genai-prices@2026-08-10", date(2026, 8, 10))

    missing_usage = terminal_cost_facts(_meta())
    assert (
        missing_usage.total_cost_usd_micros,
        missing_usage.cost_status,
        missing_usage.cost_source,
        missing_usage.cost_as_of,
    ) == (None, "missing_usage", None, None)

    missing_pricing = terminal_cost_facts(
        _meta(provider="openrouter", model="pinned-unpriced", usage=usage)
    )
    assert (
        missing_pricing.total_cost_usd_micros,
        missing_pricing.cost_status,
        missing_pricing.cost_source,
        missing_pricing.cost_as_of,
    ) == (None, "missing_pricing", None, None)

    trace = (
        AttemptRecord(
            attempt=1,
            signal=ProviderRateLimit(retry_after=Present(0.5)),
            status_code=Present(429),
            started_at_ms=10,
            ended_at_ms=20,
        ),
        AttemptRecord(
            attempt=2,
            signal=FinalAttempt(),
            status_code=Present(200),
            started_at_ms=30,
            ended_at_ms=50,
        ),
    )
    attempts = attempt_trace_facts(trace, outcome_tag="succeeded")
    assert attempts.attempt_count == 2
    assert attempts.retry_count == 1
    assert attempts.terminal_attempt_status == "success"
    assert attempts.provider_attempts == [
        {
            "attempt": 1,
            "started_at_ms": 10,
            "ended_at_ms": 20,
            "status_code": 429,
            "origin": "provider_http",
            "code": "rate_limited",
            "retry_after": 0.5,
        },
        {
            "attempt": 2,
            "started_at_ms": 30,
            "ended_at_ms": 50,
            "status_code": 200,
            "signal": "final",
        },
    ]
