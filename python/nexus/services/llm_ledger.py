"""The LLM-call ledger: sole writer of ``llm_calls`` + the one ``llm.request.*`` emitter.

``observed_generate`` / ``observed_generate_stream`` wrap the two ``ModelRuntime``
call shapes. Each provider call emits ``llm.request.started`` and exactly one of
``llm.request.finished`` / ``llm.request.failed`` (one shared field schema), and
records exactly one ``llm_calls`` row — on success AND failure — with
``call_seq`` allocated per owner. The row is flushed, not committed: it lives in
the caller's transaction (run_kit doctrine). Stream consumers that stop early
must call ``aclose()`` or ``record_abandoned()`` on the returned stream handle
before their terminal commit. The harness owns this mechanics; surfaces own
prompts, schemas, and finalization.

:func:`emit_llm_request_started` owns the ``llm.request.*`` field schema. The
saved-key probe (``user_keys.test_user_key``) shares this emitter — it logs the
same event triple, omitting owner ids — but writes no ``llm_calls`` row, since a
probe has no run to attribute the call to.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Literal, cast
from uuid import UUID

from provider_runtime import (
    DEFAULT_CATALOG,
    DEFAULT_PRICING_SOURCE,
    ModelRuntime,
    ProviderApiKey,
    lower_generate_request,
)
from provider_runtime.catalog import ModelCapability
from provider_runtime.errors import ModelCallError
from provider_runtime.types import (
    ModelCall,
    ModelChunk,
    ModelResponse,
    PromptCacheTTL,
    ProviderApiKeySource,
    RetryAttempt,
    TokenUsage,
)
from provider_runtime.usage import estimate_catalog_cost
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import LLMCall
from nexus.errors import api_error_code_for_model_call, exception_error_detail
from nexus.logging import get_logger
from nexus.services.chat_run_usage import usage_log_fields, usage_provider_json, usage_tokens
from nexus.services.redact import safe_kv

logger = get_logger(__name__)


def _provider_api_key(api_key: str, *, key_mode: str) -> ProviderApiKey:
    source: ProviderApiKeySource = "byok" if key_mode == "byok" else "platform"
    return ProviderApiKey(api_key, source=source)


@dataclass(frozen=True)
class LlmCallOwner:
    """The run parent a provider call is attributed to in the ledger."""

    kind: Literal[
        "chat_run",
        "oracle_reading",
        "li_revision",
        "media_summary",
        "media_enrichment",
        "synapse_scan",
    ]
    id: UUID


async def observed_generate(
    db: Session,
    *,
    owner: LlmCallOwner,
    llm: ModelRuntime,
    provider: str,
    request: ModelCall,
    api_key: str,
    timeout_s: int,
    llm_operation: str,
    key_mode_requested: str,
    key_mode_used: str,
) -> ModelResponse:
    """One observed non-streamed provider call; exceptions propagate unchanged."""
    call = _begin(
        owner=owner,
        provider=provider,
        request=request,
        streaming=False,
        llm_operation=llm_operation,
        key_mode_requested=key_mode_requested,
        key_mode_used=key_mode_used,
    )
    try:
        response = await llm.generate(
            request,
            key=_provider_api_key(api_key, key_mode=key_mode_used),
            timeout_s=timeout_s,
        )
    except Exception as exc:
        call.record(db, usage=None, provider_request_id=None, exc=exc)
        raise
    call.record(
        db,
        usage=response.usage,
        provider_request_id=response.provider_request_id,
        attempts=response.attempts,
    )
    return response


def observed_generate_stream(
    db: Session,
    *,
    owner: LlmCallOwner,
    llm: ModelRuntime,
    provider: str,
    request: ModelCall,
    api_key: str,
    timeout_s: int,
    llm_operation: str,
    key_mode_requested: str,
    key_mode_used: str,
) -> ObservedModelStream:
    """One observed streamed provider call, yielding chunks through unchanged.

    The row is written when the terminal (``done``) chunk is observed — before
    yielding it, so a consumer that stops iterating there still leaves a row —
    or, failing that, when the stream raises, ends without a terminal chunk, or
    the consumer closes the stream handle before terminal.
    """
    call = _begin(
        owner=owner,
        provider=provider,
        request=request,
        streaming=True,
        llm_operation=llm_operation,
        key_mode_requested=key_mode_requested,
        key_mode_used=key_mode_used,
    )
    return ObservedModelStream(
        db=db,
        call=call,
        source=llm.stream(
            request,
            key=_provider_api_key(api_key, key_mode=key_mode_used),
            timeout_s=timeout_s,
        ),
    )


@dataclass
class ObservedModelStream:
    """Async iterator carrying the one ledger row for a provider stream."""

    db: Session
    call: _Call
    source: AsyncIterator[ModelChunk]
    recorded: bool = False
    exhausted: bool = False
    closed: bool = False
    _source_close: Callable[[], Awaitable[None]] | None = field(init=False, repr=False)

    def __post_init__(self) -> None:
        close = getattr(self.source, "aclose", None)
        self._source_close = cast(
            Callable[[], Awaitable[None]] | None,
            close if callable(close) else None,
        )

    def __aiter__(self) -> ObservedModelStream:
        return self

    async def __anext__(self) -> ModelChunk:
        if self.closed:
            raise StopAsyncIteration
        try:
            chunk = await anext(self.source)
        except StopAsyncIteration:
            self.exhausted = True
            self.closed = True
            if not self.recorded:
                self.record_abandoned(error_detail="stream ended before terminal chunk")
            raise
        except asyncio.CancelledError as exc:
            if not self.recorded:
                self.recorded = True
                self.call.record(self.db, usage=None, provider_request_id=None, exc=exc)
            raise
        except Exception as exc:
            if not self.recorded:
                self.recorded = True
                self.call.record(self.db, usage=None, provider_request_id=None, exc=exc)
            raise

        if chunk.done and not self.recorded:
            self.recorded = True
            self.call.record(
                self.db,
                usage=chunk.usage,
                provider_request_id=chunk.provider_request_id,
                attempts=chunk.attempts,
            )
        return chunk

    def record_abandoned(
        self,
        *,
        error_class: str = "E_LLM_INTERRUPTED",
        error_detail: str = "stream abandoned before terminal chunk",
    ) -> None:
        """Record an early consumer stop before the caller commits terminal state."""
        if self.recorded:
            return
        self.recorded = True
        self.call.record(
            self.db,
            usage=None,
            provider_request_id=None,
            error_class=error_class,
            error_detail=error_detail,
        )

    async def aclose(self) -> None:
        """Close the upstream stream and ledger an unrecorded early stop."""
        if self.closed:
            return
        if not self.exhausted and not self.recorded:
            self.record_abandoned()
        self.closed = True
        if callable(self._source_close):
            await self._source_close()


@dataclass(frozen=True)
class LedgeredLLM:
    """``run_structured_synthesis``'s llm seam bound to one owner: each
    ``generate`` is an :func:`observed_generate`, so a repaired synthesis
    ledgers one row per application generate call. Provider-runtime retries stay
    inside the row's bounded attempt trace."""

    db: Session
    owner: LlmCallOwner
    router: ModelRuntime
    llm_operation: str
    key_mode_requested: str
    key_mode_used: str

    async def generate(self, req: ModelCall, *, key: str, timeout_s: int) -> ModelResponse:
        return await observed_generate(
            self.db,
            owner=self.owner,
            llm=self.router,
            provider=req.model.route or req.model.provider,
            request=req,
            api_key=key,
            timeout_s=timeout_s,
            llm_operation=self.llm_operation,
            key_mode_requested=self.key_mode_requested,
            key_mode_used=self.key_mode_used,
        )


@dataclass(frozen=True)
class LlmRequestLog:
    """The sole owner of the ``llm.request.*`` field schema (no DB row).

    :func:`emit_llm_request_started` logs ``started`` and returns this handle;
    :meth:`finished` / :meth:`failed` log the one terminal event and return the
    measured ``latency_ms``. The key-probe shares this emitter but never ledgers.
    """

    fields: dict
    started: float

    def finished(self, *, provider_request_id: str | None, usage: TokenUsage | None) -> int:
        latency_ms = int((time.monotonic() - self.started) * 1000)
        logger.info(
            "llm.request.finished",
            **safe_kv(
                **self.fields,
                outcome="success",
                latency_ms=latency_ms,
                provider_request_id=provider_request_id,
                **usage_log_fields(usage),
            ),
        )
        return latency_ms

    def failed(
        self,
        *,
        error_class: str,
        provider_request_id: str | None = None,
        usage: TokenUsage | None = None,
    ) -> int:
        latency_ms = int((time.monotonic() - self.started) * 1000)
        logger.error(
            "llm.request.failed",
            **safe_kv(
                **self.fields,
                outcome="error",
                error_class=error_class,
                latency_ms=latency_ms,
                provider_request_id=provider_request_id,
                **usage_log_fields(usage),
            ),
        )
        return latency_ms


def emit_llm_request_started(
    *,
    provider: str,
    request: ModelCall,
    streaming: bool,
    llm_operation: str,
    key_mode: str,
    owner: LlmCallOwner | None = None,
) -> LlmRequestLog:
    """Log ``llm.request.started`` and return the terminal-event handle.

    ``owner`` ids are included only on the ledgered path; the key probe omits
    them (it has no owner row to attribute the call to).
    """
    fields = safe_kv(
        provider=provider,
        model_name=request.model.model,
        reasoning_effort=request.reasoning.effort,
        key_mode=key_mode,
        streaming=streaming,
        llm_operation=llm_operation,
        prompt_chars=sum(len(turn.content) for turn in request.messages),
        **({"owner_kind": owner.kind, "owner_id": str(owner.id)} if owner else {}),
    )
    logger.info("llm.request.started", **fields)
    return LlmRequestLog(fields, time.monotonic())


@dataclass(frozen=True)
class _Call:
    """One started provider call: its telemetry handle + the owner/key-mode the
    ledger row carries beyond the shared ``llm.request.*`` schema."""

    owner: LlmCallOwner
    key_mode_requested: str
    key_mode_used: str
    request: ModelCall
    log: LlmRequestLog

    def record(
        self,
        db: Session,
        *,
        usage: TokenUsage | None,
        provider_request_id: str | None,
        exc: BaseException | None = None,
        error_class: str | None = None,
        error_detail: str | None = None,
        attempts: tuple[RetryAttempt, ...] | None = None,
    ) -> None:
        """Emit the terminal telemetry event and flush the one ledger row."""
        if provider_request_id is None and isinstance(exc, ModelCallError):
            provider_request_id = exc.provider_request_id
        if attempts is None and isinstance(exc, ModelCallError):
            attempts = exc.attempts
        if exc is None and error_class is None:
            error_detail = None
            latency_ms = self.log.finished(provider_request_id=provider_request_id, usage=usage)
            terminal_attempt_status = "success"
        else:
            if error_class is None:
                error_class = (
                    api_error_code_for_model_call(exc.error_code).value
                    if isinstance(exc, ModelCallError)
                    else type(exc).__name__
                    if exc is not None
                    else "Exception"
                )
            if error_detail is None and exc is not None:
                error_detail = exception_error_detail(exc, provider_request_id=provider_request_id)
            latency_ms = self.log.failed(
                error_class=error_class, provider_request_id=provider_request_id, usage=usage
            )
            terminal_attempt_status = (
                "abandoned" if error_class == "E_LLM_INTERRUPTED" else "terminal_error"
            )
        fields = self.log.fields
        attempt_fields = _attempt_fields(
            attempts=attempts or (),
            terminal_attempt_status=terminal_attempt_status,
        )
        cost_fields = _cost_fields(
            request=self.request,
            usage=usage,
            streaming=bool(fields["streaming"]),
        )
        db.add(
            LLMCall(
                owner_kind=self.owner.kind,
                owner_id=self.owner.id,
                call_seq=_next_call_seq(db, self.owner),
                provider=fields["provider"],
                provider_route=self.request.model.route or self.request.model.provider,
                model_name=fields["model_name"],
                llm_operation=fields["llm_operation"],
                streaming=fields["streaming"],
                reasoning_effort=fields["reasoning_effort"],
                key_mode_requested=self.key_mode_requested,
                key_mode_used=self.key_mode_used,
                **usage_tokens(usage),
                latency_ms=latency_ms,
                error_class=error_class,
                error_detail=error_detail,
                provider_request_id=provider_request_id,
                **cost_fields,
                **attempt_fields,
                provider_usage=usage_provider_json(usage),
            )
        )
        db.flush()


def _begin(
    *,
    owner: LlmCallOwner,
    provider: str,
    request: ModelCall,
    streaming: bool,
    llm_operation: str,
    key_mode_requested: str,
    key_mode_used: str,
) -> _Call:
    DEFAULT_CATALOG.require_capabilities(request.model)
    log = emit_llm_request_started(
        provider=provider,
        request=request,
        streaming=streaming,
        llm_operation=llm_operation,
        key_mode=key_mode_used,
        owner=owner,
    )
    return _Call(owner, key_mode_requested, key_mode_used, request, log)


def _attempt_fields(
    *,
    attempts: tuple[RetryAttempt, ...],
    terminal_attempt_status: str,
) -> dict[str, object]:
    if not attempts:
        return {
            "attempt_count": 1,
            "retry_count": 0,
            "terminal_attempt_status": terminal_attempt_status,
            "provider_attempts": None,
        }
    return {
        "attempt_count": len(attempts),
        "retry_count": max(0, len(attempts) - 1),
        "terminal_attempt_status": attempts[-1].status,
        "provider_attempts": [attempt.to_json() for attempt in attempts],
    }


def _cost_fields(
    *,
    request: ModelCall,
    usage: TokenUsage | None,
    streaming: bool,
) -> dict[str, object]:
    capability = DEFAULT_CATALOG.require_capabilities(request.model)
    cache_write_ttl = _effective_cache_write_ttl(
        request,
        capability=capability,
        streaming=streaming,
    )
    estimate = estimate_catalog_cost(
        usage,
        capability.pricing,
        cache_write_ttl=cache_write_ttl,
        pricing_source=DEFAULT_PRICING_SOURCE,
    )
    breakdown = estimate.breakdown
    return {
        "input_cost_usd_micros": breakdown.input_cost_usd_micros,
        "output_cost_usd_micros": breakdown.output_cost_usd_micros,
        "cache_write_cost_usd_micros": breakdown.cache_write_cost_usd_micros,
        "cache_read_cost_usd_micros": breakdown.cache_read_cost_usd_micros,
        "reasoning_cost_usd_micros": breakdown.reasoning_cost_usd_micros,
        "total_cost_usd_micros": breakdown.total_cost_usd_micros,
        "cost_status": estimate.status,
        "pricing_snapshot": {
            "pricing_source": estimate.pricing_source,
            "provider": request.model.provider,
            "model": request.model.model,
            "route": request.model.route or request.model.provider,
            "cache_write_ttl": cache_write_ttl,
            "pricing": estimate.pricing.to_json(),
        },
    }


def _cache_write_ttl(request: ModelCall) -> PromptCacheTTL | None:
    for message in request.messages:
        if message.cache_ttl != "none":
            return message.cache_ttl
    return None


def _effective_cache_write_ttl(
    request: ModelCall,
    *,
    capability: ModelCapability,
    streaming: bool,
) -> PromptCacheTTL | None:
    plan = lower_generate_request(request, capability, streaming=streaming)
    return _cache_write_ttl(plan.call)


def _next_call_seq(db: Session, owner: LlmCallOwner) -> int:
    return int(
        db.execute(
            text(
                "SELECT COALESCE(MAX(call_seq), 0) + 1 FROM llm_calls "
                "WHERE owner_kind = :kind AND owner_id = :id"
            ),
            {"kind": owner.kind, "id": owner.id},
        ).scalar_one()
    )
