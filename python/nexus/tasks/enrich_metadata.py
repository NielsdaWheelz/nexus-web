"""Worker job handler for LLM-based metadata enrichment.

Best-effort background task that runs after ingest completes. LLM/parse
failures are recorded as `failure_stage='metadata'` on the media row
(soft warning) without touching `processing_status`.
"""

from datetime import UTC, datetime
from uuid import UUID

import httpx
from provider_runtime import StructuredContent, Succeeded
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import FailureStage, Media, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode, exception_error_detail
from nexus.logging import get_logger
from nexus.services.contributors import MediaTarget, replace_observed_role_slices
from nexus.services.llm_execution import ExecutionRuntime, GenerationRequest, execute_generation
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.llm_profiles import operation_profile
from nexus.services.metadata_dispatch import try_enqueue_metadata_enrichment
from nexus.services.metadata_enrichment import (
    METADATA_ENRICHMENT_OPERATION,
    build_enrichment_user_content,
    build_metadata_enrichment_intent,
    get_content_sample,
    merge_enrichment,
    validate_structured_enrichment,
)
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.structured_synthesis import outcome_failure_facts
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


def _failed_result(*, reason: str, error_code: str) -> dict:
    return {"status": "failed", "reason": reason, "error_code": error_code}


def enrich_metadata(
    media_id: str,
    request_id: str | None = None,
) -> dict:
    """Enrich media metadata using a cheap LLM call.

    Skips silently if:
    - Media is still actively extracting
    - Metadata enrichment is disabled, or the media has no owning user

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

    async def _run(db: Session, runtime: ExecutionRuntime, _client: httpx.AsyncClient) -> dict:
        settings = get_settings()
        media = db.get(Media, media_uuid)
        if media is None:
            return {"status": "skipped", "reason": "media_not_found"}

        # Bail if not in a ready state
        if media.processing_status not in _READY_STATES:
            return {"status": "skipped", "reason": "not_ready"}

        owner_user_id = media.created_by_user_id
        if not settings.metadata_enrichment_enabled or owner_user_id is None:
            error_code = ApiErrorCode.E_METADATA_NO_PROVIDER.value
            _record_metadata_failure(
                media,
                error_code,
                "Metadata enrichment is disabled."
                if not settings.metadata_enrichment_enabled
                else "Media has no owning user to attribute the provider call to.",
            )
            db.commit()
            return _failed_result(reason="no_provider", error_code=error_code)

        owner = LlmCallOwner(kind="media_enrichment", id=media.id, user_id=owner_user_id)
        content_sample = get_content_sample(db, media)
        user_content = build_enrichment_user_content(db, media, content_sample)

        rate_limiter = get_rate_limiter()
        try:
            rate_limiter.acquire_inflight_slot(owner_user_id)
        except ApiError as exc:
            _record_metadata_failure(media, exc.code.value, exc.message)
            db.commit()
            return _failed_result(reason="rate_limit_rejected", error_code=exc.code.value)

        try:
            profile = operation_profile(METADATA_ENRICHMENT_OPERATION)
            intent = build_metadata_enrichment_intent(
                user_content=user_content,
                max_output_tokens=settings.metadata_enrichment_max_output_tokens,
            )
            try:
                call = await execute_generation(
                    GenerationRequest(
                        owner=owner,
                        operation=METADATA_ENRICHMENT_OPERATION,
                        profile=profile,
                        reasoning=profile.default_reasoning_option_id,
                        intent=intent,
                    ),
                    session_factory=get_session_factory(),
                    runtime=runtime,
                    settings=settings,
                )
            except ApiError as exc:
                logger.warning(
                    "enrich_metadata_llm_rejected",
                    media_id=media_id,
                    error_code=exc.code.value,
                )
                _record_metadata_failure(media, exc.code.value, exc.message)
                db.commit()
                return _failed_result(reason="llm_rejected", error_code=exc.code.value)

            if not isinstance(call.outcome, Succeeded):
                error_code, detail = outcome_failure_facts(call.outcome)
                logger.warning(
                    "enrich_metadata_llm_failed",
                    media_id=media_id,
                    error_code=error_code,
                )
                _record_metadata_failure(media, error_code, detail or "provider call failed")
                db.commit()
                return _failed_result(reason="llm_failed", error_code=error_code)

            content = call.outcome.response.content
            if not isinstance(content, StructuredContent):
                # justify-defect: output=StrictJsonOutput plans output_kind=
                # "strict_json", which the runtime never promotes to TextContent.
                raise AssertionError("metadata enrichment outcome decoded as TextContent")

            enrichment = validate_structured_enrichment(content.payload)
            if enrichment is None:
                logger.warning(
                    "enrich_metadata_parse_failed",
                    media_id=media_id,
                )
                error_code = ApiErrorCode.E_METADATA_PARSE_FAILED.value
                _record_metadata_failure(
                    media,
                    error_code,
                    "provider did not return valid structured metadata",
                )
                db.commit()
                return _failed_result(reason="parse_failed", error_code=error_code)

            if not enrichment:
                error_code = ApiErrorCode.E_METADATA_NO_FIELDS.value
                _record_metadata_failure(
                    media, error_code, "LLM returned no confident metadata fields."
                )
                db.commit()
                return _failed_result(reason="no_fields", error_code=error_code)

            merge_result = merge_enrichment(db, media, enrichment)
            if not merge_result.accepted_fields:
                error_code = ApiErrorCode.E_METADATA_NO_FIELDS.value
                _record_metadata_failure(
                    media, error_code, "LLM returned no applicable metadata fields."
                )
                db.commit()
                return _failed_result(reason="no_applicable_fields", error_code=error_code)

            if media.failure_stage == FailureStage.metadata:
                media.failure_stage = None
                media.last_error_code = None
                media.last_error_message = None
            db.commit()

            # Fresh-session author op (spec 2.4, D-14). Non-author enrichment is
            # already durable; the author slice is replaced on the facade's own
            # serializable session. This job is max_attempts=1, so a crash here
            # loses this enrichment's authors until the next refresh (accepted
            # 80/20). NOT_OBSERVED returns without touching credits; a failure
            # propagates to the worker boundary, which marks failure_stage=metadata.
            replace_observed_role_slices(
                target=MediaTarget(media.id),
                observation=merge_result.author_observation,
                source="metadata_enrichment",
            )

            logger.info(
                "enrich_metadata_completed",
                media_id=media_id,
                fields_enriched=list(merge_result.accepted_fields),
                request_id=request_id,
            )
            return {
                "status": "success",
                "fields": list(merge_result.accepted_fields),
                "provider": profile.target.provider,
                "model": profile.target.model,
            }
        finally:
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
