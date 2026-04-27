"""Worker job handler for durable chat runs."""

from __future__ import annotations

import asyncio
from uuid import UUID

import httpx
from nexus_web_search.brave import BraveSearchProvider

from nexus.config import get_settings
from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.chat_runs import execute_chat_run
from nexus.services.llm import LLMRouter

logger = get_logger(__name__)


def chat_run(run_id: str) -> dict:
    run_uuid = UUID(run_id)
    settings = get_settings()
    session_factory = get_session_factory()
    db = session_factory()

    async def _call() -> dict:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=10.0),
            limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
        ) as client:
            router = LLMRouter(
                client,
                enable_openai=settings.enable_openai,
                enable_anthropic=settings.enable_anthropic,
                enable_gemini=settings.enable_gemini,
                enable_deepseek=settings.enable_deepseek,
            )
            web_search_provider = (
                BraveSearchProvider(
                    client,
                    api_key=settings.brave_search_api_key,
                    base_url=settings.brave_search_base_url,
                    timeout_seconds=settings.brave_search_timeout_seconds,
                )
                if settings.brave_search_api_key
                else None
            )
            return await execute_chat_run(
                db,
                run_id=run_uuid,
                llm_router=router,
                web_search_provider=web_search_provider,
                web_search_country=settings.brave_search_country,
                web_search_language=settings.brave_search_language,
                web_search_safe_search=settings.brave_search_safe_search,
            )

    logger.info("chat_run_started", run_id=run_id)
    loop = asyncio.new_event_loop()
    try:
        result = loop.run_until_complete(_call())
        logger.info("chat_run_completed", run_id=run_id, result=result)
        return result
    finally:
        loop.close()
        db.close()
