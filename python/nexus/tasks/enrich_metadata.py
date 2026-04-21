"""Worker job handler for LLM-based metadata enrichment.

Best-effort background task that runs after ingest completes.
Never fails the media — if the LLM call fails, logs a warning and returns.
"""

import asyncio
from uuid import UUID

import httpx

from nexus.config import get_settings
from nexus.db.models import Media, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.llm.router import LLMRouter
from nexus.services.llm.types import LLMRequest, Turn
from nexus.services.metadata_enrichment import (
    build_enrichment_prompt,
    detect_metadata_gaps,
    get_content_sample,
    has_any_gaps,
    merge_enrichment,
    parse_enrichment_response,
    select_enrichment_provider,
)

logger = get_logger(__name__)

_READY_STATES = frozenset(
    {
        ProcessingStatus.pending,
        ProcessingStatus.ready_for_reading,
        ProcessingStatus.embedding,
        ProcessingStatus.ready,
        ProcessingStatus.failed,
    }
)


def enrich_metadata(
    media_id: str,
    request_id: str | None = None,
) -> dict:
    """Enrich media metadata using a cheap LLM call.

    Skips silently if:
    - Media is still actively extracting
    - No metadata gaps detected
    - No LLM provider configured
    - LLM call fails (best-effort)
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

        # Detect gaps
        gaps = detect_metadata_gaps(media)
        if not has_any_gaps(gaps):
            return {"status": "skipped", "reason": "no_gaps"}

        # Select provider
        provider_info = select_enrichment_provider(settings)
        if provider_info is None:
            return {"status": "skipped", "reason": "no_provider"}

        provider, model, api_key = provider_info

        # Build content sample and prompt
        content_sample = get_content_sample(db, media)
        prompt = build_enrichment_prompt(db, media, content_sample, gaps)

        # Call LLM
        req = LLMRequest(
            model_name=model,
            messages=[Turn(role="user", content=prompt)],
            max_tokens=512,
            temperature=0.0,
        )

        try:

            async def _call():
                async with httpx.AsyncClient() as client:
                    router = LLMRouter(
                        client,
                        enable_openai=settings.enable_openai,
                        enable_anthropic=settings.enable_anthropic,
                        enable_gemini=settings.enable_gemini,
                        enable_deepseek=settings.enable_deepseek,
                    )
                    return await router.generate(
                        provider, req, api_key, timeout_s=30, key_mode="platform"
                    )

            # Use an explicit event loop so the handler stays self-contained in
            # the long-lived worker process.
            loop = asyncio.new_event_loop()
            try:
                response = loop.run_until_complete(_call())
            finally:
                loop.close()
        except Exception as exc:
            logger.warning(
                "enrich_metadata_llm_failed",
                media_id=media_id,
                provider=provider,
                error=str(exc),
            )
            return {"status": "skipped", "reason": "llm_failed"}

        # Parse and merge
        enrichment = parse_enrichment_response(response.text)
        if enrichment is None:
            logger.warning(
                "enrich_metadata_parse_failed",
                media_id=media_id,
                raw_text=response.text[:200],
            )
            return {"status": "skipped", "reason": "parse_failed"}

        merge_enrichment(db, media, enrichment, gaps)
        db.commit()

        logger.info(
            "enrich_metadata_completed",
            media_id=media_id,
            provider=provider,
            fields_enriched=list(enrichment.keys()),
            request_id=request_id,
        )
        return {"status": "success", "fields": list(enrichment.keys())}

    except Exception as exc:
        db.rollback()
        logger.warning(
            "enrich_metadata_unexpected_error",
            media_id=media_id,
            error=str(exc),
        )
        return {"status": "skipped", "reason": "unexpected_error"}
    finally:
        db.close()
