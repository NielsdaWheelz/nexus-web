"""The LLM-call ledger: sole writer of ``llm_calls`` + the one ``llm.request.*`` emitter.

``observed_generate`` / ``observed_generate_stream`` wrap the two ``LLMRouter``
call shapes. Each provider call emits ``llm.request.started`` and exactly one of
``llm.request.finished`` / ``llm.request.failed`` (one shared field schema), and
records exactly one ``llm_calls`` row — on success AND failure — with
``call_seq`` allocated per owner. The row is flushed, not committed: it lives in
the caller's transaction (run_kit doctrine). The harness owns this mechanics;
surfaces own prompts, schemas, and finalization.

One honest gap: a stream abandoned by its consumer before the terminal chunk
(cancel paths) leaves only ``started`` telemetry — the generator must not touch
the session from ``GeneratorExit``, where the caller may be mid-unwind.

:func:`emit_llm_request_started` owns the ``llm.request.*`` field schema. The
saved-key probe (``user_keys.test_user_key``) shares this emitter — it logs the
same event triple, omitting owner ids — but writes no ``llm_calls`` row, since a
probe has no run to attribute the call to.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from llm_calling.errors import LLMError
from llm_calling.router import LLMRouter
from llm_calling.types import LLMChunk, LLMRequest, LLMResponse, LLMUsage
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import LLMCall
from nexus.errors import LLM_ERROR_CODE_TO_API_ERROR_CODE
from nexus.logging import get_logger
from nexus.services.chat_run_usage import usage_log_fields, usage_provider_json, usage_tokens
from nexus.services.redact import safe_kv

logger = get_logger(__name__)

_ERROR_DETAIL_MAX_CHARS = 1000


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
    llm: LLMRouter,
    provider: str,
    request: LLMRequest,
    api_key: str,
    timeout_s: int,
    llm_operation: str,
    key_mode_requested: str,
    key_mode_used: str,
) -> LLMResponse:
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
        response = await llm.generate(provider, request, api_key, timeout_s=timeout_s)
    except Exception as exc:
        call.record(db, usage=None, provider_request_id=None, exc=exc)
        raise
    call.record(db, usage=response.usage, provider_request_id=response.provider_request_id)
    return response


async def observed_generate_stream(
    db: Session,
    *,
    owner: LlmCallOwner,
    llm: LLMRouter,
    provider: str,
    request: LLMRequest,
    api_key: str,
    timeout_s: int,
    llm_operation: str,
    key_mode_requested: str,
    key_mode_used: str,
) -> AsyncIterator[LLMChunk]:
    """One observed streamed provider call, yielding chunks through unchanged.

    The row is written when the terminal (``done``) chunk is observed — before
    yielding it, so a consumer that stops iterating there still leaves a row —
    or, failing that, when the stream raises or ends without a terminal chunk.
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
    recorded = False
    try:
        async for chunk in llm.generate_stream(provider, request, api_key, timeout_s=timeout_s):
            if chunk.done and not recorded:
                recorded = True
                call.record(db, usage=chunk.usage, provider_request_id=chunk.provider_request_id)
            yield chunk
        if not recorded:
            call.record(db, usage=None, provider_request_id=None)
    except Exception as exc:
        if not recorded:
            call.record(db, usage=None, provider_request_id=None, exc=exc)
        raise


@dataclass(frozen=True)
class LedgeredLLM:
    """``run_structured_synthesis``'s llm seam bound to one owner: each
    ``generate`` is an :func:`observed_generate`, so a repaired synthesis
    ledgers one row per attempt."""

    db: Session
    owner: LlmCallOwner
    router: LLMRouter
    llm_operation: str
    key_mode_requested: str
    key_mode_used: str

    async def generate(
        self, provider: str, req: LLMRequest, api_key: str, *, timeout_s: int
    ) -> LLMResponse:
        return await observed_generate(
            self.db,
            owner=self.owner,
            llm=self.router,
            provider=provider,
            request=req,
            api_key=api_key,
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

    def finished(self, *, provider_request_id: str | None, usage: LLMUsage | None) -> int:
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
        usage: LLMUsage | None = None,
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
    request: LLMRequest,
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
        model_name=request.model_name,
        reasoning_effort=request.reasoning_effort,
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
    log: LlmRequestLog

    def record(
        self,
        db: Session,
        *,
        usage: LLMUsage | None,
        provider_request_id: str | None,
        exc: Exception | None = None,
    ) -> None:
        """Emit the terminal telemetry event and flush the one ledger row."""
        if exc is None:
            error_class = error_detail = None
            latency_ms = self.log.finished(provider_request_id=provider_request_id, usage=usage)
        else:
            error_class = (
                LLM_ERROR_CODE_TO_API_ERROR_CODE[exc.error_code].value
                if isinstance(exc, LLMError)
                else type(exc).__name__
            )
            error_detail = f"{type(exc).__name__}: {exc}"[:_ERROR_DETAIL_MAX_CHARS]
            latency_ms = self.log.failed(
                error_class=error_class, provider_request_id=provider_request_id, usage=usage
            )
        fields = self.log.fields
        db.add(
            LLMCall(
                owner_kind=self.owner.kind,
                owner_id=self.owner.id,
                call_seq=_next_call_seq(db, self.owner),
                provider=fields["provider"],
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
                provider_usage=usage_provider_json(usage),
            )
        )
        db.flush()


def _begin(
    *,
    owner: LlmCallOwner,
    provider: str,
    request: LLMRequest,
    streaming: bool,
    llm_operation: str,
    key_mode_requested: str,
    key_mode_used: str,
) -> _Call:
    log = emit_llm_request_started(
        provider=provider,
        request=request,
        streaming=streaming,
        llm_operation=llm_operation,
        key_mode=key_mode_used,
        owner=owner,
    )
    return _Call(owner, key_mode_requested, key_mode_used, log)


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
