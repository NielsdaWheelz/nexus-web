"""llm_ledger: one llm_calls row + one llm.request.* event pair per provider call."""

from uuid import uuid4

import pytest
from llm_calling.errors import LLMError, LLMErrorCode
from llm_calling.types import LLMChunk, LLMRequest, LLMResponse, LLMUsage, Turn
from sqlalchemy import select

from nexus.db.models import LLMCall
from nexus.services.llm_ledger import LlmCallOwner, observed_generate, observed_generate_stream

pytestmark = pytest.mark.integration

_USAGE = LLMUsage(input_tokens=11, output_tokens=7, total_tokens=18, reasoning_tokens=3)


class _FakeRouter:
    """External-LLM boundary fake: canned response/chunks or a raised error."""

    def __init__(self, *, response=None, chunks=(), error=None):
        self._response = response
        self._chunks = chunks
        self._error = error

    async def generate(self, provider, req, api_key, *, timeout_s):
        if self._error is not None:
            raise self._error
        return self._response

    async def generate_stream(self, provider, req, api_key, *, timeout_s):
        for chunk in self._chunks:
            yield chunk
        if self._error is not None:
            raise self._error


def _request() -> LLMRequest:
    return LLMRequest(
        model_name="claude-test",
        messages=[Turn(role="user", content="ten chars!")],
        max_tokens=100,
        reasoning_effort="none",
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
    router = _FakeRouter(response=LLMResponse(text="ok", usage=_USAGE, provider_request_id="req_1"))

    response = await _observe(db_session, router, owner=owner, streaming=False)
    await _observe(db_session, router, owner=owner, streaming=False)

    assert response.text == "ok"
    rows = _rows(db_session, owner)
    assert [row.call_seq for row in rows] == [1, 2], "call_seq must increment per owner"
    row = rows[0]
    assert (row.provider, row.model_name, row.llm_operation) == (
        "anthropic",
        "claude-test",
        "oracle_reading",
    )
    assert row.streaming is False
    assert row.reasoning_effort == "none"
    assert (row.key_mode_requested, row.key_mode_used) == ("auto", "platform")
    assert (row.input_tokens, row.output_tokens, row.total_tokens, row.reasoning_tokens) == (
        11,
        7,
        18,
        3,
    )
    assert row.latency_ms is not None and row.latency_ms >= 0
    assert row.error_class is None and row.error_detail is None
    assert row.provider_request_id == "req_1"
    assert row.provider_usage == {
        "input_tokens": 11,
        "output_tokens": 7,
        "total_tokens": 18,
        "reasoning_tokens": 3,
        "cache_write_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "cached_input_tokens": 0,
    }

    started = _events(log_sink, "llm.request.started")
    finished = _events(log_sink, "llm.request.finished")
    assert len(started) == 2 and len(finished) == 2
    assert started[0] == {
        "event": "llm.request.started",
        "provider": "anthropic",
        "model_name": "claude-test",
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
    assert finished[0]["provider_request_id"] == "req_1"


async def test_generate_provider_error_writes_failure_row_and_reraises(db_session, log_sink):
    owner = LlmCallOwner(kind="media_enrichment", id=uuid4())
    router = _FakeRouter(error=LLMError(LLMErrorCode.TIMEOUT, "took too long"))

    with pytest.raises(LLMError):
        await _observe(db_session, router, owner=owner, streaming=False)

    (row,) = _rows(db_session, owner)
    assert row.error_class == "E_LLM_TIMEOUT", "LLMError maps to the API error code"
    assert row.error_detail == "LLMError: took too long"
    assert row.total_tokens is None
    failed = _events(log_sink, "llm.request.failed")
    assert len(failed) == 1
    assert failed[0]["outcome"] == "error"
    assert failed[0]["error_class"] == "E_LLM_TIMEOUT"


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
            LLMChunk(delta_text="hel"),
            LLMChunk(delta_text="lo"),
            LLMChunk(done=True, usage=_USAGE, provider_request_id="req_s"),
        )
    )

    chunks = await _observe(db_session, router, owner=owner, streaming=True)

    assert [chunk.delta_text for chunk in chunks] == ["hel", "lo", ""]
    (row,) = _rows(db_session, owner)
    assert row.streaming is True
    assert row.total_tokens == 18
    assert row.provider_request_id == "req_s"
    assert row.error_class is None
    assert len(_events(log_sink, "llm.request.finished")) == 1


async def test_stream_row_written_before_terminal_chunk_yields(db_session, log_sink):
    """A consumer that stops at the done chunk (the chat loop) still leaves a row."""
    owner = LlmCallOwner(kind="chat_run", id=uuid4())
    router = _FakeRouter(chunks=(LLMChunk(delta_text="x"), LLMChunk(done=True, usage=_USAGE)))

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
    async for chunk in stream:
        if chunk.done:
            break
    await stream.aclose()

    (row,) = _rows(db_session, owner)
    assert row.total_tokens == 18 and row.error_class is None


async def test_stream_failure_mid_iteration_writes_failure_row_and_reraises(db_session, log_sink):
    owner = LlmCallOwner(kind="li_revision", id=uuid4())
    router = _FakeRouter(
        chunks=(LLMChunk(delta_text="partial"),),
        error=LLMError(LLMErrorCode.PROVIDER_DOWN, "gone"),
    )

    with pytest.raises(LLMError):
        await _observe(db_session, router, owner=owner, streaming=True)

    (row,) = _rows(db_session, owner)
    assert row.error_class == "E_LLM_PROVIDER_DOWN"
    assert row.error_detail == "LLMError: gone"
    assert row.total_tokens is None
    assert len(_events(log_sink, "llm.request.failed")) == 1


async def test_stream_without_terminal_chunk_still_writes_one_row(db_session, log_sink):
    owner = LlmCallOwner(kind="chat_run", id=uuid4())
    router = _FakeRouter(chunks=(LLMChunk(delta_text="never finishes"),))

    await _observe(db_session, router, owner=owner, streaming=True)

    (row,) = _rows(db_session, owner)
    assert row.error_class is None
    assert row.total_tokens is None, "no terminal chunk means no usage to record"
    assert len(_events(log_sink, "llm.request.finished")) == 1
