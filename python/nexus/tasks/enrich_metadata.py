"""Worker job handler for LLM-based metadata enrichment.

Best-effort background task that runs after ingest completes. LLM/parse
failures are recorded as `failure_stage='metadata'` on the media row
(soft warning) without touching `processing_status`.
"""

import asyncio
import time
from datetime import UTC, datetime
from uuid import UUID

import httpx
from llm_calling.errors import LLMError
from llm_calling.router import LLMRouter
from llm_calling.types import LLMRequest, Turn

from nexus.config import get_settings
from nexus.db.models import FailureStage, Media, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.errors import LLM_ERROR_CODE_TO_API_ERROR_CODE, ApiErrorCode
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger
from nexus.services.metadata_enrichment import (
    build_enrichment_prompt,
    get_content_sample,
    merge_enrichment,
    metadata_structured_output_spec,
    select_enrichment_providers,
    validate_structured_enrichment,
)
from nexus.services.redact import safe_kv

logger = get_logger(__name__)

_MAX_ERROR_MSG_LEN = 1000

_READY_STATES = frozenset(
    {
        ProcessingStatus.pending,
        ProcessingStatus.ready_for_reading,
        ProcessingStatus.embedding,
        ProcessingStatus.ready,
    }
)


def _record_metadata_failure(media: Media, error_code: str, error_message: str) -> None:
    """Write failure_stage=metadata + last_error_* without touching processing_status."""
    if media.processing_status == ProcessingStatus.failed:
        return
    media.failure_stage = FailureStage.metadata
    media.last_error_code = error_code
    media.last_error_message = error_message[:_MAX_ERROR_MSG_LEN]
    media.updated_at = datetime.now(UTC)


def _failed_result(
    *,
    reason: str,
    error_code: str,
    provider: str | None = None,
    model: str | None = None,
    attempted_providers: list[dict[str, str]] | None = None,
) -> dict:
    result: dict[str, object] = {
        "status": "failed",
        "reason": reason,
        "error_code": error_code,
    }
    if provider:
        result["provider"] = provider
    if model:
        result["model"] = model
    if attempted_providers:
        result["attempted_providers"] = attempted_providers
    return result


def _llm_error_code(exc: Exception) -> str:
    if isinstance(exc, LLMError):
        return LLM_ERROR_CODE_TO_API_ERROR_CODE.get(
            exc.error_code, ApiErrorCode.E_LLM_PROVIDER_DOWN
        ).value
    return ApiErrorCode.E_LLM_PROVIDER_DOWN.value


def enrich_metadata(
    media_id: str,
    request_id: str | None = None,
) -> dict:
    """Enrich media metadata using a cheap LLM call.

    Skips silently if:
    - Media is still actively extracting
    - No LLM provider configured

    On LLM/parse failure records failure_stage=metadata + last_error_* on
    the media row without touching processing_status, then returns
    {"status": "failed", ...}.
    """
    media_uuid = UUID(media_id)
    settings = get_settings()

    logger.info(
        "enrich_metadata_started",
        media_id=media_id,
        request_id=request_id,
    )

    session_factory = get_session_factory()
    db = session_factory()

    try:
        media = db.get(Media, media_uuid)
        if media is None:
            return {"status": "skipped", "reason": "media_not_found"}

        # Bail if not in a ready state
        if media.processing_status not in _READY_STATES:
            return {"status": "skipped", "reason": "not_ready"}

        providers = select_enrichment_providers(settings)
        if not providers:
            error_code = ApiErrorCode.E_METADATA_NO_PROVIDER.value
            _record_metadata_failure(
                media,
                error_code,
                "No metadata enrichment provider is configured.",
            )
            db.commit()
            return _failed_result(reason="no_provider", error_code=error_code)

        content_sample = get_content_sample(db, media)
        prompt = build_enrichment_prompt(db, media, content_sample)
        structured_output = metadata_structured_output_spec()
        attempted_providers: list[dict[str, str]] = []
        last_failure = {
            "reason": "llm_failed",
            "error_code": ApiErrorCode.E_LLM_PROVIDER_DOWN.value,
            "error_message": "Metadata enrichment did not complete.",
            "provider": None,
            "model": None,
        }

        for provider, model, api_key in providers:
            attempted_providers.append({"provider": provider, "model": model})
            req = LLMRequest(
                model_name=model,
                messages=[Turn(role="user", content=prompt)],
                max_tokens=settings.metadata_enrichment_max_output_tokens,
                temperature=0.0,
                structured_output=structured_output,
            )

            llm_start = time.monotonic()
            llm_log_fields = safe_kv(
                provider=provider,
                model_name=req.model_name,
                reasoning_effort=req.reasoning_effort,
                key_mode="platform",
                streaming=False,
                llm_operation="metadata_enrichment",
                media_id=media_id,
                message_chars=sum(len(message.content) for message in req.messages),
            )
            logger.info("llm.request.started", **llm_log_fields)

            try:

                async def _call(provider=provider, req=req, api_key=api_key):
                    async with httpx.AsyncClient() as client:
                        router = LLMRouter(
                            client,
                            enable_openai=settings.enable_openai,
                            enable_anthropic=settings.enable_anthropic,
                            enable_gemini=settings.enable_gemini,
                            enable_deepseek=settings.enable_deepseek,
                        )
                        return await router.generate(provider, req, api_key, timeout_s=30)

                # Use an explicit event loop so the handler stays self-contained in
                # the long-lived worker process.
                loop = asyncio.new_event_loop()
                try:
                    response = loop.run_until_complete(_call())
                finally:
                    loop.close()
            except Exception as exc:
                error_code = _llm_error_code(exc)
                logger.error(
                    "llm.request.failed",
                    **safe_kv(
                        **llm_log_fields,
                        outcome="error",
                        error_class=error_code,
                        latency_ms=int((time.monotonic() - llm_start) * 1000),
                        exception_type=type(exc).__name__,
                    ),
                )
                logger.warning(
                    "enrich_metadata_llm_failed",
                    media_id=media_id,
                    provider=provider,
                    model=model,
                    error=str(exc),
                )
                last_failure = {
                    "reason": "llm_failed",
                    "error_code": error_code,
                    "error_message": str(exc),
                    "provider": provider,
                    "model": model,
                }
                continue

            if getattr(response, "status", None) == "incomplete":
                usage = getattr(response, "usage", None)
                logger.error(
                    "llm.request.failed",
                    **safe_kv(
                        **llm_log_fields,
                        outcome="error",
                        error_class=ApiErrorCode.E_LLM_INCOMPLETE.value,
                        incomplete_details=getattr(response, "incomplete_details", None),
                        latency_ms=int((time.monotonic() - llm_start) * 1000),
                        tokens_input=usage.input_tokens if usage else None,
                        tokens_output=usage.output_tokens if usage else None,
                        tokens_total=usage.total_tokens if usage else None,
                        tokens_reasoning=usage.reasoning_tokens if usage else None,
                        provider_request_id=getattr(response, "provider_request_id", None),
                    ),
                )
                last_failure = {
                    "reason": "llm_incomplete",
                    "error_code": ApiErrorCode.E_LLM_INCOMPLETE.value,
                    "error_message": str(
                        getattr(response, "incomplete_details", None) or "llm response incomplete"
                    ),
                    "provider": provider,
                    "model": model,
                }
                continue

            usage = getattr(response, "usage", None)
            logger.info(
                "llm.request.finished",
                **safe_kv(
                    **llm_log_fields,
                    outcome="success",
                    latency_ms=int((time.monotonic() - llm_start) * 1000),
                    tokens_input=usage.input_tokens if usage else None,
                    tokens_output=usage.output_tokens if usage else None,
                    tokens_total=usage.total_tokens if usage else None,
                    provider_request_id=getattr(response, "provider_request_id", None),
                ),
            )

            structured_payload = getattr(response, "structured_output", None)
            enrichment = validate_structured_enrichment(structured_payload)
            if enrichment is None:
                logger.warning(
                    "enrich_metadata_parse_failed",
                    media_id=media_id,
                    provider=provider,
                    model=model,
                )
                last_failure = {
                    "reason": "parse_failed",
                    "error_code": ApiErrorCode.E_METADATA_PARSE_FAILED.value,
                    "error_message": "provider did not return valid structured metadata",
                    "provider": provider,
                    "model": model,
                }
                continue

            if not enrichment:
                last_failure = {
                    "reason": "no_fields",
                    "error_code": ApiErrorCode.E_METADATA_NO_FIELDS.value,
                    "error_message": "LLM returned no confident metadata fields.",
                    "provider": provider,
                    "model": model,
                }
                continue

            merge_result = merge_enrichment(db, media, enrichment)
            if not merge_result.accepted_fields:
                last_failure = {
                    "reason": "no_applicable_fields",
                    "error_code": ApiErrorCode.E_METADATA_NO_FIELDS.value,
                    "error_message": "LLM returned no applicable metadata fields.",
                    "provider": provider,
                    "model": model,
                }
                continue

            if media.failure_stage == FailureStage.metadata:
                media.failure_stage = None
                media.last_error_code = None
                media.last_error_message = None
            db.commit()

            logger.info(
                "enrich_metadata_completed",
                media_id=media_id,
                provider=provider,
                model=model,
                fields_enriched=list(merge_result.accepted_fields),
                request_id=request_id,
            )
            return {
                "status": "success",
                "fields": list(merge_result.accepted_fields),
                "provider": provider,
                "model": model,
                "attempted_providers": attempted_providers,
            }

        error_code = str(last_failure["error_code"])
        _record_metadata_failure(media, error_code, str(last_failure["error_message"]))
        db.commit()
        return _failed_result(
            reason=str(last_failure["reason"]),
            error_code=error_code,
            provider=(
                str(last_failure["provider"]) if last_failure["provider"] is not None else None
            ),
            model=str(last_failure["model"]) if last_failure["model"] is not None else None,
            attempted_providers=attempted_providers,
        )

    except Exception as exc:
        db.rollback()
        logger.warning(
            "enrich_metadata_unexpected_error",
            media_id=media_id,
            error=str(exc),
        )
        media = db.get(Media, media_uuid)
        if media is not None:
            _record_metadata_failure(media, "E_METADATA_UNEXPECTED", str(exc))
            db.commit()
        return _failed_result(reason="unexpected_error", error_code="E_METADATA_UNEXPECTED")
    finally:
        db.close()


def dispatch_enrich_metadata(media_id: str, request_id: str | None) -> None:
    """Best-effort enqueue of the metadata-enrichment job on its own session.

    Owned by this module because it owns the `enrich_metadata` job. Ingest tasks
    call this after extraction completes. Failure to enqueue is logged, never
    raised — enrichment is a soft post-ingest enhancement.
    """
    db = get_session_factory()()
    try:
        enqueue_job(
            db,
            kind="enrich_metadata",
            payload={"media_id": media_id, "request_id": request_id},
            max_attempts=1,
        )
        db.commit()
    except Exception:
        db.rollback()
        logger.warning("enrich_metadata_dispatch_failed", media_id=media_id)
    finally:
        db.close()
