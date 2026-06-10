"""Worker job handler for durable chat runs."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID

import httpx
from llm_calling.router import LLMRouter
from sqlalchemy.orm import Session
from web_search_tool.brave import BraveSearchProvider
from web_search_tool.types import WebSearchProvider

from nexus.config import get_settings
from nexus.db.models import ChatRun
from nexus.errors import ApiErrorCode
from nexus.jobs.queue import JobRow
from nexus.logging import get_logger
from nexus.schemas.conversation import ReaderContextHint, ReaderSelectionRequest
from nexus.services.chat_run_event_store import TERMINAL_RUN_STATUSES
from nexus.services.chat_run_finalize import finalize_error
from nexus.services.chat_runs import execute_chat_run
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

logger = get_logger(__name__)

_CHAT_RUN_SPEC = LlmTaskSpec(label="chat_run", http_timeout_s=60.0, http_limits=(100, 20))


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

    async def _handler(db: Session, router: LLMRouter, client: httpx.AsyncClient) -> dict:
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

    # No on_worker_exception: chat's per-attempt boundary lives inside
    # execute_chat_run; an exception escaping it (finalize itself failed) must
    # propagate to the queue's retry policy and, at exhaustion, the dead-letter
    # finalizer below.
    logger.info("chat_run_started", run_id=run_id)
    result = run_llm_task(_CHAT_RUN_SPEC, _handler)
    logger.info("chat_run_completed", run_id=run_id, result=result)
    return result


def finalize_dead_lettered_chat_run(db: Session, job: JobRow) -> None:
    """Finalize the chat run for a dead-lettered chat_run queue row."""
    raw_run_id = job.payload.get("run_id")
    if raw_run_id is None:
        raise ValueError("chat_run dead-letter payload is missing run_id")

    run_id = UUID(str(raw_run_id))
    run = db.get(ChatRun, run_id)
    if run is None or run.status in TERMINAL_RUN_STATUSES:
        return

    finalize_error(
        db,
        run_id=run.id,
        error_code=job.error_code or ApiErrorCode.E_INTERNAL.value,
        error_detail=job.last_error[:1000] if job.last_error else None,
        assistant_content=(
            "The background job handling this response exhausted its attempts before "
            "the model response could finish. Please retry."
        ),
        commit=False,
    )
