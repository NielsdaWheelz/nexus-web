"""Worker job handler for one Black Forest Oracle reading."""

from __future__ import annotations

import asyncio
from uuid import UUID

import httpx
from llm_calling.router import LLMRouter

from nexus.config import get_settings
from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.oracle import execute_reading, fail_reading_after_worker_exception

logger = get_logger(__name__)


def oracle_reading_generate(reading_id: str) -> dict:
    reading_uuid = UUID(reading_id)
    settings = get_settings()
    db = get_session_factory()()

    async def _call() -> dict:
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
            return await execute_reading(db, reading_id=reading_uuid, llm_router=router)

    logger.info("oracle_reading_started", reading_id=reading_id)
    loop = asyncio.new_event_loop()
    try:
        result = loop.run_until_complete(_call())
        logger.info("oracle_reading_completed", reading_id=reading_id, result=result)
        return result
    except Exception:
        logger.exception("oracle_reading_failed_unexpected", reading_id=reading_id)
        result = fail_reading_after_worker_exception(db, reading_id=reading_uuid)
        logger.info("oracle_reading_completed", reading_id=reading_id, result=result)
        return result
    finally:
        loop.close()
        db.close()
