"""Worker job handler for durable chat runs."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any
from uuid import UUID

import httpx
from llm_calling.router import LLMRouter
from sqlalchemy.orm import Session
from web_search_tool.brave import BraveSearchProvider
from web_search_tool.types import WebSearchProvider

from nexus.config import get_settings
from nexus.db.models import ChatRun, Model
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode
from nexus.jobs.queue import JobRow
from nexus.logging import get_logger
from nexus.schemas.conversation import ReaderContextHint, ReaderSelectionRequest
from nexus.services.chat_run_event_store import TERMINAL_RUN_STATUSES
from nexus.services.chat_run_finalize import dummy_resolved_key, finalize_error
from nexus.services.chat_runs import execute_chat_run
from nexus.services.rate_limit import RateLimiter, set_rate_limiter
from nexus.services.real_media_fixture_llm import RealMediaFixtureLLMRouter

logger = get_logger(__name__)


def chat_run(
    run_id: str,
    reader_context: Mapping[str, str] | None = None,
    reader_selection: Mapping[str, Any] | None = None,
) -> dict:
    run_uuid = UUID(run_id)
    reader_context_hint = (
        ReaderContextHint.model_validate(reader_context) if reader_context is not None else None
    )
    reader_selection_anchor = (
        ReaderSelectionRequest.model_validate(reader_selection)
        if reader_selection is not None
        else None
    )
    settings = get_settings()
    session_factory = get_session_factory()
    set_rate_limiter(
        RateLimiter(
            session_factory=session_factory,
            rpm_limit=settings.rate_limit_rpm,
            concurrent_limit=settings.rate_limit_concurrent,
        )
    )
    db = session_factory()

    async def _call() -> dict:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=10.0),
            limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
        ) as client:
            if settings.real_media_provider_fixtures:
                router = RealMediaFixtureLLMRouter(
                    enable_openai=settings.enable_openai,
                    enable_anthropic=settings.enable_anthropic,
                    enable_gemini=settings.enable_gemini,
                    enable_deepseek=settings.enable_deepseek,
                )
            else:
                router = LLMRouter(
                    client,
                    enable_openai=settings.enable_openai,
                    enable_anthropic=settings.enable_anthropic,
                    enable_gemini=settings.enable_gemini,
                    enable_deepseek=settings.enable_deepseek,
                )
            web_search_provider: WebSearchProvider | None = (
                BraveSearchProvider(client, api_key=settings.brave_search_api_key)
                if settings.brave_search_api_key
                else None
            )
            return await execute_chat_run(
                db,
                run_id=run_uuid,
                llm_router=router,
                web_search_provider=web_search_provider,
                reader_context=reader_context_hint,
                reader_selection=reader_selection_anchor,
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


def finalize_dead_lettered_chat_run(db: Session, job: JobRow) -> None:
    """Finalize the chat run for a dead-lettered chat_run queue row."""
    raw_run_id = job.payload.get("run_id")
    if raw_run_id is None:
        raise ValueError("chat_run dead-letter payload is missing run_id")

    run_id = UUID(str(raw_run_id))
    run = db.get(ChatRun, run_id)
    if run is None or run.status in TERMINAL_RUN_STATUSES:
        return

    model = db.get(Model, run.model_id)
    error_code = job.error_code or ApiErrorCode.E_INTERNAL.value
    finalize_error(
        db,
        run_id=run.id,
        error_code=error_code,
        viewer_id=run.owner_user_id,
        model=model,
        resolved_key=dummy_resolved_key(model) if model is not None else None,
        key_mode=run.key_mode,
        assistant_content=(
            "The background job handling this response exhausted its attempts before "
            "the model response could finish. Please retry."
        ),
        commit=False,
    )
