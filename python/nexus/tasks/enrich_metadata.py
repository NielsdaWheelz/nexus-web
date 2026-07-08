"""Worker job handler for LLM-based metadata enrichment.

Best-effort background task that runs after ingest completes. LLM/parse
failures are recorded as `failure_stage='metadata'` on the media row
(soft warning) without touching `processing_status`.
"""

from datetime import UTC, datetime
from uuid import UUID

import httpx
from provider_runtime import ModelRuntime
from provider_runtime.errors import ModelCallError
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import FailureStage, Media, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    api_error_code_for_model_call,
    exception_error_detail,
)
from nexus.logging import get_logger
from nexus.services.api_key_resolver import resolve_api_key, update_user_key_status
from nexus.services.chat_run_usage import usage_tokens
from nexus.services.llm_ledger import LlmCallOwner, observed_generate
from nexus.services.metadata_dispatch import try_enqueue_metadata_enrichment
from nexus.services.metadata_enrichment import (
    build_enrichment_prompt,
    build_metadata_enrichment_call,
    get_content_sample,
    merge_enrichment,
    select_enrichment_model,
    validate_structured_enrichment,
)
from nexus.services.prompt_budget import estimate_tokens
from nexus.services.rate_limit import get_rate_limiter
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

logger = get_logger(__name__)

_MAX_ERROR_MSG_LEN = 1000

_READY_STATES = frozenset(
    {
        ProcessingStatus.pending,
        ProcessingStatus.ready_for_reading,
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
    return result


def _llm_error_code(exc: Exception) -> str:
    if isinstance(exc, ApiError):
        return exc.code.value
    if isinstance(exc, ModelCallError):
        return api_error_code_for_model_call(exc.error_code).value
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

    logger.info(
        "enrich_metadata_started",
        media_id=media_id,
        request_id=request_id,
    )

    async def _run(db: Session, router: ModelRuntime, _client: httpx.AsyncClient) -> dict:
        settings = get_settings()
        media = db.get(Media, media_uuid)
        if media is None:
            return {"status": "skipped", "reason": "media_not_found"}

        # Bail if not in a ready state
        if media.processing_status not in _READY_STATES:
            return {"status": "skipped", "reason": "not_ready"}

        selected_model = select_enrichment_model(settings)
        owner_user_id = media.created_by_user_id
        if selected_model is None or owner_user_id is None:
            error_code = ApiErrorCode.E_METADATA_NO_PROVIDER.value
            _record_metadata_failure(
                media,
                error_code,
                "No metadata enrichment provider is configured."
                if selected_model is None
                else "Media has no owning user to resolve an API key for.",
            )
            db.commit()
            return _failed_result(reason="no_provider", error_code=error_code)

        provider, model = selected_model
        owner = LlmCallOwner(kind="media_enrichment", id=media.id)
        content_sample = get_content_sample(db, media)
        prompt = build_enrichment_prompt(db, media, content_sample)

        try:
            resolved = resolve_api_key(db, owner_user_id, provider, "auto")
        except (ApiError, ModelCallError) as exc:
            logger.warning(
                "enrich_metadata_key_unavailable",
                media_id=media_id,
                provider=provider,
                error=str(exc),
            )
            error_code = _llm_error_code(exc)
            _record_metadata_failure(media, error_code, exception_error_detail(exc))
            db.commit()
            return _failed_result(
                reason="key_unavailable",
                error_code=error_code,
                provider=provider,
                model=model,
            )

        req = build_metadata_enrichment_call(
            provider=provider,
            model=model,
            prompt=prompt,
            max_output_tokens=settings.metadata_enrichment_max_output_tokens,
        )

        rate_limiter = get_rate_limiter()
        try:
            rate_limiter.acquire_inflight_slot(owner_user_id)
        except ApiError as exc:
            _record_metadata_failure(media, exc.code.value, exc.message)
            db.commit()
            return _failed_result(
                reason="rate_limit_rejected",
                error_code=exc.code.value,
                provider=provider,
                model=model,
            )

        budget_reserved = False
        estimated_tokens = 0
        try:
            if resolved.mode == "platform":
                estimated_tokens = (
                    estimate_tokens("\n".join(turn.content for turn in req.messages))
                    + settings.metadata_enrichment_max_output_tokens
                )
                try:
                    rate_limiter.reserve_token_budget(owner_user_id, media.id, estimated_tokens)
                    budget_reserved = True
                except ApiError as exc:
                    _record_metadata_failure(media, exc.code.value, exc.message)
                    db.commit()
                    return _failed_result(
                        reason="budget_rejected",
                        error_code=exc.code.value,
                        provider=provider,
                        model=model,
                    )

            try:
                response = await observed_generate(
                    db,
                    owner=owner,
                    llm=router,
                    provider=provider,
                    request=req,
                    api_key=resolved.api_key,
                    timeout_s=30,
                    llm_operation="metadata_enrichment",
                    key_mode_requested="auto",
                    key_mode_used=resolved.mode,
                )
            except Exception as exc:
                error_code = _llm_error_code(exc)
                logger.warning(
                    "enrich_metadata_llm_failed",
                    media_id=media_id,
                    provider=provider,
                    model=model,
                    error=str(exc),
                )
                if resolved.mode == "byok" and error_code == ApiErrorCode.E_LLM_INVALID_KEY.value:
                    update_user_key_status(db, resolved.user_key_id, "invalid")
                _record_metadata_failure(media, error_code, exception_error_detail(exc))
                db.commit()
                return _failed_result(
                    reason="llm_failed",
                    error_code=error_code,
                    provider=provider,
                    model=model,
                )

            if response.status == "incomplete":
                error_message = str(response.incomplete_details or "llm response incomplete")
                _record_metadata_failure(media, ApiErrorCode.E_LLM_INCOMPLETE.value, error_message)
                db.commit()
                return _failed_result(
                    reason="llm_incomplete",
                    error_code=ApiErrorCode.E_LLM_INCOMPLETE.value,
                    provider=provider,
                    model=model,
                )

            enrichment = validate_structured_enrichment(response.structured_output)
            if enrichment is None:
                logger.warning(
                    "enrich_metadata_parse_failed",
                    media_id=media_id,
                    provider=provider,
                    model=model,
                )
                error_code = ApiErrorCode.E_METADATA_PARSE_FAILED.value
                _record_metadata_failure(
                    media,
                    error_code,
                    "provider did not return valid structured metadata",
                )
                db.commit()
                return _failed_result(
                    reason="parse_failed",
                    error_code=error_code,
                    provider=provider,
                    model=model,
                )

            if not enrichment:
                error_code = ApiErrorCode.E_METADATA_NO_FIELDS.value
                _record_metadata_failure(
                    media, error_code, "LLM returned no confident metadata fields."
                )
                db.commit()
                return _failed_result(
                    reason="no_fields",
                    error_code=error_code,
                    provider=provider,
                    model=model,
                )

            merge_result = merge_enrichment(db, media, enrichment)
            if not merge_result.accepted_fields:
                error_code = ApiErrorCode.E_METADATA_NO_FIELDS.value
                _record_metadata_failure(
                    media, error_code, "LLM returned no applicable metadata fields."
                )
                db.commit()
                return _failed_result(
                    reason="no_applicable_fields",
                    error_code=error_code,
                    provider=provider,
                    model=model,
                )

            if media.failure_stage == FailureStage.metadata:
                media.failure_stage = None
                media.last_error_code = None
                media.last_error_message = None
            if resolved.mode == "byok":
                update_user_key_status(db, resolved.user_key_id, "valid")
            db.commit()

            if budget_reserved:
                actual_tokens = usage_tokens(response.usage)["total_tokens"]
                rate_limiter.commit_token_budget(
                    owner_user_id, media.id, actual_tokens or estimated_tokens
                )
                budget_reserved = False

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
            }
        finally:
            if budget_reserved:
                rate_limiter.release_token_budget(owner_user_id, media.id)
            rate_limiter.release_inflight_slot(owner_user_id)

    def _record_unexpected(db: Session, exc: Exception) -> dict:
        db.rollback()
        media = db.get(Media, media_uuid)
        if media is not None:
            _record_metadata_failure(media, "E_METADATA_UNEXPECTED", exception_error_detail(exc))
            db.commit()
        return _failed_result(reason="unexpected_error", error_code="E_METADATA_UNEXPECTED")

    return run_llm_task(
        LlmTaskSpec(label="enrich_metadata"),
        _run,
        on_worker_exception=_record_unexpected,
    )


def dispatch_enrich_metadata(media_id: str, request_id: str | None) -> None:
    """Best-effort enqueue of the metadata-enrichment job on its own session.

    Owned by this module because it owns the `enrich_metadata` job. Ingest tasks
    call this after extraction completes. Failure to enqueue is logged, never
    raised — enrichment is a soft post-ingest enhancement.
    """
    db = get_session_factory()()
    try:
        try_enqueue_metadata_enrichment(db, media_id=media_id, request_id=request_id)
        db.commit()
    except Exception:
        db.rollback()
        logger.warning("enrich_metadata_dispatch_failed", media_id=media_id)
    finally:
        db.close()
