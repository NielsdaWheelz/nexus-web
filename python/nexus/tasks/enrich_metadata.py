"""Worker job handler for LLM-based metadata enrichment.

Best-effort background task that runs after ingest completes. LLM/parse
failures are recorded as `failure_stage='metadata'` on the media row
(soft warning) without touching `processing_status`.
"""

from datetime import UTC, datetime
from uuid import UUID

import httpx
from llm_calling.errors import LLMError
from llm_calling.router import LLMRouter
from llm_calling.types import LLMRequest, Turn
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import FailureStage, Media, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.errors import LLM_ERROR_CODE_TO_API_ERROR_CODE, ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.api_key_resolver import resolve_api_key, update_user_key_status
from nexus.services.llm_ledger import LlmCallOwner, observed_generate
from nexus.services.metadata_dispatch import try_enqueue_metadata_enrichment
from nexus.services.metadata_enrichment import (
    build_enrichment_prompt,
    get_content_sample,
    merge_enrichment,
    metadata_structured_output_spec,
    select_enrichment_providers,
    validate_structured_enrichment,
)
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
    if isinstance(exc, ApiError):
        return exc.code.value
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

    logger.info(
        "enrich_metadata_started",
        media_id=media_id,
        request_id=request_id,
    )

    async def _run(db: Session, router: LLMRouter, _client: httpx.AsyncClient) -> dict:
        settings = get_settings()
        media = db.get(Media, media_uuid)
        if media is None:
            return {"status": "skipped", "reason": "media_not_found"}

        # Bail if not in a ready state
        if media.processing_status not in _READY_STATES:
            return {"status": "skipped", "reason": "not_ready"}

        providers = select_enrichment_providers(settings)
        owner_user_id = media.created_by_user_id
        if not providers or owner_user_id is None:
            error_code = ApiErrorCode.E_METADATA_NO_PROVIDER.value
            _record_metadata_failure(
                media,
                error_code,
                "No metadata enrichment provider is configured."
                if not providers
                else "Media has no owning user to resolve an API key for.",
            )
            db.commit()
            return _failed_result(reason="no_provider", error_code=error_code)

        owner = LlmCallOwner(kind="media_enrichment", id=media.id)
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

        for provider, model in providers:
            attempted_providers.append({"provider": provider, "model": model})
            try:
                resolved = resolve_api_key(db, owner_user_id, provider, "auto")
            except (ApiError, LLMError) as exc:
                logger.warning(
                    "enrich_metadata_key_unavailable",
                    media_id=media_id,
                    provider=provider,
                    error=str(exc),
                )
                last_failure = {
                    "reason": "key_unavailable",
                    "error_code": _llm_error_code(exc),
                    "error_message": str(exc),
                    "provider": provider,
                    "model": model,
                }
                continue

            req = LLMRequest(
                model_name=model,
                messages=[Turn(role="user", content=prompt)],
                max_tokens=settings.metadata_enrichment_max_output_tokens,
                temperature=0.0,
                structured_output=structured_output,
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
                last_failure = {
                    "reason": "llm_failed",
                    "error_code": error_code,
                    "error_message": str(exc),
                    "provider": provider,
                    "model": model,
                }
                continue

            if response.status == "incomplete":
                last_failure = {
                    "reason": "llm_incomplete",
                    "error_code": ApiErrorCode.E_LLM_INCOMPLETE.value,
                    "error_message": str(response.incomplete_details or "llm response incomplete"),
                    "provider": provider,
                    "model": model,
                }
                continue

            enrichment = validate_structured_enrichment(response.structured_output)
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
            if resolved.mode == "byok":
                update_user_key_status(db, resolved.user_key_id, "valid")
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

    def _record_unexpected(db: Session, exc: Exception) -> dict:
        db.rollback()
        media = db.get(Media, media_uuid)
        if media is not None:
            _record_metadata_failure(media, "E_METADATA_UNEXPECTED", str(exc))
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
