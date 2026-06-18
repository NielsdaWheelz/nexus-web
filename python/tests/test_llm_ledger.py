"""llm_ledger: one llm_calls row + one llm.request.* event pair per provider call."""

from uuid import uuid4

import pytest
from provider_runtime import (
    ModelCapability,
    ModelCatalog,
    Pricing,
    PromptCacheCapability,
    RouteCapability,
)
from provider_runtime.errors import ModelCallError, ModelCallErrorCode
from provider_runtime.types import (
    ModelCall,
    ModelMessage,
    ModelRef,
    ModelResponse,
    ModelStreamEvent,
    PromptCacheTTL,
    ReasoningConfig,
    RetryAttempt,
    TokenUsage,
)
from sqlalchemy import select

import nexus.services.llm_ledger as llm_ledger
from nexus.db.models import LLMCall
from nexus.services.llm_ledger import LlmCallOwner, observed_generate, observed_generate_stream

pytestmark = pytest.mark.integration

_USAGE = TokenUsage(
    input_tokens=11,
    output_tokens=7,
    total_tokens=18,
    reasoning_tokens=3,
    cache_creation_input_tokens=5,
    cache_read_input_tokens=6,
    cached_tokens=6,
)


def _text_event(text: str) -> ModelStreamEvent:
    return ModelStreamEvent(
        type="text_delta", provider="anthropic", model="claude-haiku-4-5-20251001", text=text
    )


def _done_event(
    *,
    usage: TokenUsage | None = None,
    provider_request_id: str | None = None,
    attempts: tuple[RetryAttempt, ...] = (),
) -> ModelStreamEvent:
    return ModelStreamEvent(
        type="completed",
        provider="anthropic",
        model="claude-haiku-4-5-20251001",
        usage=usage,
        provider_request_id=provider_request_id,
        status="completed",
        attempts=attempts,
    )


class _FakeRouter:
    """External-LLM boundary fake: canned response/chunks or a raised error."""

    def __init__(self, *, response=None, chunks=(), error=None):
        self._response = response
        self._chunks = chunks
        self._error = error

    async def generate(self, req, *, key, timeout_s):
        if self._error is not None:
            raise self._error
        return self._response

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        for chunk in self._chunks:
            yield chunk
        if self._error is not None:
            raise self._error


def _request(*, cache_ttl: PromptCacheTTL = "none") -> ModelCall:
    return ModelCall(
        model=ModelRef(provider="anthropic", model="claude-haiku-4-5-20251001"),
        messages=[ModelMessage(role="user", content="ten chars!", cache_ttl=cache_ttl)],
        max_output_tokens=100,
        reasoning=ReasoningConfig(effort="none"),
    )


async def _observe(db, router, *, owner: LlmCallOwner, streaming: bool):
    kwargs = dict(
        owner=owner,
        llm=router,
        provider="anthropic",
        request=_request(),
        api_key="k",
        timeout_s=30,
        llm_operation="oracle_reading",
        key_mode_requested="auto",
        key_mode_used="platform",
    )
    if not streaming:
        return await observed_generate(db, **kwargs)
    chunks = []
    async for chunk in observed_generate_stream(db, **kwargs):
        chunks.append(chunk)
    return chunks


def _rows(db, owner: LlmCallOwner) -> list[LLMCall]:
    return list(
        db.scalars(
            select(LLMCall)
            .where(LLMCall.owner_kind == owner.kind, LLMCall.owner_id == owner.id)
            .order_by(LLMCall.call_seq)
        )
    )


def _events(log_sink, name: str) -> list[dict]:
    return [event for event in log_sink if event["event"] == name]


async def test_generate_success_writes_row_and_increments_call_seq(db_session, log_sink):
    owner = LlmCallOwner(kind="oracle_reading", id=uuid4())
    router = _FakeRouter(
        response=ModelResponse(text="ok", usage=_USAGE, provider_request_id="req_1")
    )

    response = await _observe(db_session, router, owner=owner, streaming=False)
    await _observe(db_session, router, owner=owner, streaming=False)

    assert response.text == "ok"
    rows = _rows(db_session, owner)
    assert [row.call_seq for row in rows] == [1, 2], "call_seq must increment per owner"
    row = rows[0]
    assert (row.provider, row.model_name, row.llm_operation) == (
        "anthropic",
        "claude-haiku-4-5-20251001",
        "oracle_reading",
    )
    assert row.provider_route == "anthropic"
    assert row.streaming is False
    assert row.reasoning_effort == "none"
    assert (row.key_mode_requested, row.key_mode_used) == ("auto", "platform")
    assert (row.input_tokens, row.output_tokens, row.total_tokens, row.reasoning_tokens) == (
        11,
        7,
        18,
        3,
    )
    assert (
        row.cache_write_input_tokens,
        row.cache_read_input_tokens,
        row.cached_input_tokens,
    ) == (5, 6, 6)
    assert row.latency_ms is not None and row.latency_ms >= 0
    assert row.error_class is None and row.error_detail is None
    assert row.provider_request_id == "req_1"
    assert row.cost_status == "missing_pricing"
    assert row.total_cost_usd_micros is None
    assert row.pricing_snapshot == {
        "pricing_source": "provider_runtime.catalog.DEFAULT_CATALOG",
        "provider": "anthropic",
        "model": "claude-haiku-4-5-20251001",
        "route": "anthropic",
        "cache_write_ttl": None,
        "pricing": {
            "input_per_million": "1",
            "output_per_million": "5",
            "cached_input_per_million": "0.1",
            "cache_write_per_million_by_ttl": {"5m": "1.25", "1h": "2"},
            "reasoning_per_million": None,
            "reasoning_billing_mode": "included_in_output",
            "applies_up_to_input_tokens": None,
            "source_url": "https://platform.claude.com/docs/en/about-claude/pricing",
            "verified_at": "2026-06-11",
            "currency": "USD",
            "unit": "per_million_tokens",
        },
    }
    assert (row.attempt_count, row.retry_count, row.terminal_attempt_status) == (
        1,
        0,
        "success",
    )
    assert row.provider_attempts is None
    assert row.provider_usage == {
        "input_tokens": 11,
        "output_tokens": 7,
        "total_tokens": 18,
        "reasoning_tokens": 3,
        "cache_write_input_tokens": 5,
        "cache_read_input_tokens": 6,
        "cached_input_tokens": 6,
    }

    started = _events(log_sink, "llm.request.started")
    finished = _events(log_sink, "llm.request.finished")
    assert len(started) == 2 and len(finished) == 2
    assert started[0] == {
        "event": "llm.request.started",
        "provider": "anthropic",
        "model_name": "claude-haiku-4-5-20251001",
        "reasoning_effort": "none",
        "key_mode": "platform",
        "streaming": False,
        "llm_operation": "oracle_reading",
        "owner_kind": "oracle_reading",
        "owner_id": str(owner.id),
        "prompt_chars": 10,
    }
    assert finished[0]["outcome"] == "success"
    assert finished[0]["tokens_total"] == 18
    assert finished[0]["cache_write_input_tokens"] == 5
    assert finished[0]["cache_read_input_tokens"] == 6
    assert finished[0]["cached_input_tokens"] == 6
    assert finished[0]["provider_request_id"] == "req_1"


async def test_generate_success_writes_catalog_priced_cost_fields(
    db_session, log_sink, monkeypatch
):
    owner = LlmCallOwner(kind="oracle_reading", id=uuid4())
    monkeypatch.setattr(
        llm_ledger,
        "DEFAULT_CATALOG",
        ModelCatalog(
            (
                ModelCapability(
                    provider="anthropic",
                    model="claude-haiku-4-5-20251001",
                    routes=(RouteCapability(route="anthropic", provider="anthropic"),),
                    default_route="anthropic",
                    key_probe_model="claude-haiku-4-5-20251001",
                    reasoning_modes=("none",),
                    prompt_cache=PromptCacheCapability("turn_ttl", ("5m", "1h")),
                    pricing=Pricing(
                        input_per_million=1,
                        output_per_million=2,
                        cached_input_per_million=1,
                        cache_write_per_million_by_ttl={"5m": 3},
                        reasoning_per_million=4,
                        reasoning_billing_mode="separate",
                        source_url="https://example.invalid/pricing",
                        verified_at="2026-06-11",
                    ),
                ),
            )
        ),
    )
    router = _FakeRouter(
        response=ModelResponse(text="ok", usage=_USAGE, provider_request_id="req_cost")
    )

    await observed_generate(
        db_session,
        owner=owner,
        llm=router,
        provider="anthropic",
        request=_request(cache_ttl="5m"),
        api_key="k",
        timeout_s=30,
        llm_operation="oracle_reading",
        key_mode_requested="auto",
        key_mode_used="platform",
    )

    (row,) = _rows(db_session, owner)
    assert row.cost_status == "estimated"
    assert (
        row.input_cost_usd_micros,
        row.output_cost_usd_micros,
        row.cache_write_cost_usd_micros,
        row.cache_read_cost_usd_micros,
        row.reasoning_cost_usd_micros,
        row.total_cost_usd_micros,
    ) == (0, 14, 15, 6, 12, 47)
    assert row.pricing_snapshot == {
        "pricing_source": "provider_runtime.catalog.DEFAULT_CATALOG",
        "provider": "anthropic",
        "model": "claude-haiku-4-5-20251001",
        "route": "anthropic",
        "cache_write_ttl": "5m",
        "pricing": {
            "input_per_million": "1",
            "output_per_million": "2",
            "cached_input_per_million": "1",
            "cache_write_per_million_by_ttl": {"5m": "3"},
            "reasoning_per_million": "4",
            "reasoning_billing_mode": "separate",
            "applies_up_to_input_tokens": None,
            "source_url": "https://example.invalid/pricing",
            "verified_at": "2026-06-11",
            "currency": "USD",
            "unit": "per_million_tokens",
        },
    }


async def test_cost_snapshot_uses_effective_lowered_cache_intent(db_session, log_sink):
    owner = LlmCallOwner(kind="oracle_reading", id=uuid4())
    request = ModelCall(
        model=ModelRef(
            provider="openrouter",
            model="moonshotai/kimi-k2.6",
            route="openrouter",
        ),
        messages=[ModelMessage(role="user", content="cache me", cache_ttl="5m")],
        max_output_tokens=100,
        reasoning=ReasoningConfig(effort="none"),
    )
    router = _FakeRouter(
        response=ModelResponse(
            text="ok",
            usage=TokenUsage(input_tokens=10, output_tokens=5, total_tokens=15),
            provider_request_id="req_openrouter",
        )
    )

    await observed_generate(
        db_session,
        owner=owner,
        llm=router,
        provider="openrouter",
        request=request,
        api_key="k",
        timeout_s=30,
        llm_operation="oracle_reading",
        key_mode_requested="auto",
        key_mode_used="platform",
    )

    (row,) = _rows(db_session, owner)
    assert row.pricing_snapshot["cache_write_ttl"] is None


async def test_generate_provider_error_writes_failure_row_and_reraises(db_session, log_sink):
    owner = LlmCallOwner(kind="media_enrichment", id=uuid4())
    router = _FakeRouter(
        error=ModelCallError(
            ModelCallErrorCode.TIMEOUT,
            "took too long",
            provider_request_id="req_timeout",
            attempts=(
                RetryAttempt(
                    attempt_number=1,
                    max_attempts=2,
                    status="retryable_error",
                    error_code=ModelCallErrorCode.TIMEOUT.value,
                    retryable=True,
                    delay_s=0,
                    provider_request_id="req_timeout_first",
                ),
                RetryAttempt(
                    attempt_number=2,
                    max_attempts=2,
                    status="terminal_error",
                    error_code=ModelCallErrorCode.TIMEOUT.value,
                    retryable=True,
                    provider_request_id="req_timeout",
                ),
            ),
        )
    )

    with pytest.raises(ModelCallError):
        await _observe(db_session, router, owner=owner, streaming=False)

    (row,) = _rows(db_session, owner)
    assert row.error_class == "E_LLM_TIMEOUT", "ModelCallError maps to the API error code"
    assert row.error_detail == "ModelCallError: took too long (provider_request_id=req_timeout)"
    assert row.provider_request_id == "req_timeout"
    assert (row.attempt_count, row.retry_count, row.terminal_attempt_status) == (
        2,
        1,
        "terminal_error",
    )
    assert row.provider_attempts == [
        {
            "attempt_number": 1,
            "max_attempts": 2,
            "status": "retryable_error",
            "error_code": "timeout",
            "retryable": True,
            "delay_s": 0,
            "provider_request_id": "req_timeout_first",
            "streamed_output_started": False,
        },
        {
            "attempt_number": 2,
            "max_attempts": 2,
            "status": "terminal_error",
            "error_code": "timeout",
            "retryable": True,
            "provider_request_id": "req_timeout",
            "streamed_output_started": False,
        },
    ]
    assert row.total_tokens is None
    failed = _events(log_sink, "llm.request.failed")
    assert len(failed) == 1
    assert failed[0]["outcome"] == "error"
    assert failed[0]["error_class"] == "E_LLM_TIMEOUT"
    assert failed[0]["provider_request_id"] == "req_timeout"


async def test_generate_unclassified_exception_records_type_name(db_session, log_sink):
    owner = LlmCallOwner(kind="media_summary", id=uuid4())
    router = _FakeRouter(error=RuntimeError("boom"))

    with pytest.raises(RuntimeError):
        await _observe(db_session, router, owner=owner, streaming=False)

    (row,) = _rows(db_session, owner)
    assert row.error_class == "RuntimeError"
    assert row.error_detail == "RuntimeError: boom"


async def test_stream_success_writes_row_from_terminal_chunk(db_session, log_sink):
    owner = LlmCallOwner(kind="chat_run", id=uuid4())
    router = _FakeRouter(
        chunks=(
            _text_event("hel"),
            _text_event("lo"),
            _done_event(
                usage=_USAGE,
                provider_request_id="req_s",
                attempts=(
                    RetryAttempt(
                        attempt_number=1,
                        max_attempts=1,
                        status="success",
                        provider_request_id="req_s",
                        streamed_output_started=True,
                    ),
                ),
            ),
        )
    )

    chunks = await _observe(db_session, router, owner=owner, streaming=True)

    assert [event.text for event in chunks if event.type == "text_delta"] == ["hel", "lo"]
    (row,) = _rows(db_session, owner)
    assert row.streaming is True
    assert row.total_tokens == 18
    assert row.provider_request_id == "req_s"
    assert (row.attempt_count, row.retry_count, row.terminal_attempt_status) == (
        1,
        0,
        "success",
    )
    assert row.provider_attempts == [
        {
            "attempt_number": 1,
            "max_attempts": 1,
            "status": "success",
            "provider_request_id": "req_s",
            "streamed_output_started": True,
        }
    ]
    assert row.error_class is None
    assert len(_events(log_sink, "llm.request.finished")) == 1


async def test_stream_row_written_before_terminal_chunk_yields(db_session, log_sink):
    """A consumer that stops at the done chunk (the chat loop) still leaves a row."""
    owner = LlmCallOwner(kind="chat_run", id=uuid4())
    router = _FakeRouter(chunks=(_text_event("x"), _done_event(usage=_USAGE)))

    stream = observed_generate_stream(
        db_session,
        owner=owner,
        llm=router,
        provider="anthropic",
        request=_request(),
        api_key="k",
        timeout_s=30,
        llm_operation="chat_send",
        key_mode_requested="auto",
        key_mode_used="byok",
    )
    async for event in stream:
        if event.terminal:
            break
    await stream.aclose()

    (row,) = _rows(db_session, owner)
    assert row.total_tokens == 18 and row.error_class is None


async def test_stream_aclose_before_terminal_chunk_writes_abandoned_row(db_session, log_sink):
    owner = LlmCallOwner(kind="chat_run", id=uuid4())
    router = _FakeRouter(chunks=(_text_event("partial"), _done_event(usage=_USAGE)))

    stream = observed_generate_stream(
        db_session,
        owner=owner,
        llm=router,
        provider="anthropic",
        request=_request(),
        api_key="k",
        timeout_s=30,
        llm_operation="chat_send",
        key_mode_requested="auto",
        key_mode_used="byok",
    )

    event = await anext(stream)
    assert event.text == "partial"
    await stream.aclose()
    await stream.aclose()

    (row,) = _rows(db_session, owner)
    assert row.error_class == "E_LLM_INTERRUPTED"
    assert row.error_detail == "stream abandoned before terminal chunk"
    assert (row.attempt_count, row.retry_count, row.terminal_attempt_status) == (
        1,
        0,
        "abandoned",
    )
    assert row.total_tokens is None
    assert len(_events(log_sink, "llm.request.failed")) == 1
    assert len(_events(log_sink, "llm.request.finished")) == 0


async def test_stream_failure_mid_iteration_writes_failure_row_and_reraises(db_session, log_sink):
    owner = LlmCallOwner(kind="li_revision", id=uuid4())
    router = _FakeRouter(
        chunks=(_text_event("partial"),),
        error=ModelCallError(
            ModelCallErrorCode.PROVIDER_DOWN,
            "gone",
            provider_request_id="req_stream_down",
        ),
    )

    with pytest.raises(ModelCallError):
        await _observe(db_session, router, owner=owner, streaming=True)

    (row,) = _rows(db_session, owner)
    assert row.error_class == "E_LLM_PROVIDER_DOWN"
    assert row.error_detail == "ModelCallError: gone (provider_request_id=req_stream_down)"
    assert row.provider_request_id == "req_stream_down"
    assert row.total_tokens is None
    failed = _events(log_sink, "llm.request.failed")
    assert len(failed) == 1
    assert failed[0]["provider_request_id"] == "req_stream_down"


async def test_stream_without_terminal_chunk_still_writes_one_row(db_session, log_sink):
    owner = LlmCallOwner(kind="chat_run", id=uuid4())
    router = _FakeRouter(chunks=(_text_event("never finishes"),))

    await _observe(db_session, router, owner=owner, streaming=True)

    (row,) = _rows(db_session, owner)
    assert row.error_class == "E_LLM_INTERRUPTED"
    assert row.error_detail == "stream ended before terminal chunk"
    assert row.terminal_attempt_status == "abandoned"
    assert row.total_tokens is None, "no terminal chunk means no usage to record"
    assert len(_events(log_sink, "llm.request.failed")) == 1
    assert len(_events(log_sink, "llm.request.finished")) == 0
