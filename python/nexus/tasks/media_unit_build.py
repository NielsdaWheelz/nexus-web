"""Worker job handler for one per-media intelligence unit build."""

from __future__ import annotations

import asyncio
from uuid import UUID

import httpx
from llm_calling.router import LLMRouter

from nexus.config import get_settings
from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.media_intelligence import (
    fail_media_unit_after_worker_exception,
    run_media_unit_build,
)

logger = get_logger(__name__)


def media_unit_build(media_id: str) -> dict:
    media_uuid = UUID(media_id)
    settings = get_settings()
    db = get_session_factory()()

    async def _call() -> str:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=10.0),
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        ) as client:
            router = LLMRouter(
                client,
                enable_openai=settings.enable_openai,
                enable_anthropic=settings.enable_anthropic,
                enable_gemini=settings.enable_gemini,
                enable_deepseek=settings.enable_deepseek,
            )
            return await run_media_unit_build(db, media_id=media_uuid, llm=router)

    logger.info("media_unit_build_started", media_id=media_id)
    loop = asyncio.new_event_loop()
    try:
        status = loop.run_until_complete(_call())
        logger.info("media_unit_build_completed", media_id=media_id, status=status)
        return {"status": status, "media_id": media_id}
    # justify-ignore-error: worker boundary stores a safe terminal unit failure.
    except Exception:
        logger.exception("media_unit_build_failed_unexpected", media_id=media_id)
        fail_media_unit_after_worker_exception(db, media_id=media_uuid)
        return {"status": "failed", "media_id": media_id}
    finally:
        loop.close()
        db.close()
