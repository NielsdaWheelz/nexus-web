"""Worker entrypoint for library-intelligence artifact generation (the reduce)."""

from __future__ import annotations

import asyncio
from uuid import UUID

import httpx
from llm_calling.router import LLMRouter

from nexus.config import get_settings
from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.library_intelligence_reduce import (
    fail_artifact_generation_after_worker_exception,
    run_artifact_generation,
)

logger = get_logger(__name__)


def library_intelligence_artifact_generate(revision_id: str) -> dict:
    revision_uuid = UUID(revision_id)
    settings = get_settings()
    db = get_session_factory()()

    async def _call() -> None:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, connect=10.0),
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        ) as client:
            router = LLMRouter(
                client,
                enable_openai=settings.enable_openai,
                enable_anthropic=settings.enable_anthropic,
                enable_gemini=settings.enable_gemini,
                enable_deepseek=settings.enable_deepseek,
            )
            await run_artifact_generation(db, revision_id=revision_uuid, llm=router)

    logger.info("library_intelligence_generate_started", revision_id=revision_id)
    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(_call())
        logger.info("library_intelligence_generate_completed", revision_id=revision_id)
        return {"status": "ok", "revision_id": revision_id}
    # justify-ignore-error: worker boundary stores a safe terminal revision failure.
    except Exception:
        logger.exception("library_intelligence_generate_failed_unexpected", revision_id=revision_id)
        fail_artifact_generation_after_worker_exception(db, revision_id=revision_uuid)
        return {"status": "failed", "revision_id": revision_id}
    finally:
        loop.close()
        db.close()
