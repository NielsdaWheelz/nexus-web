"""Worker job handler for durable chat runs."""

from __future__ import annotations

from uuid import UUID

import httpx
from provider_runtime import ModelRuntime
from sqlalchemy.orm import Session
from web_search_tool.brave import BraveSearchProvider
from web_search_tool.types import WebSearchProvider

from nexus.config import get_settings
from nexus.db.models import ChatRun
from nexus.errors import ApiErrorCode
from nexus.jobs.queue import JobRow
from nexus.logging import get_logger
from nexus.services.chat_run_event_store import TERMINAL_RUN_STATUSES
from nexus.services.chat_run_finalize import finalize_error
from nexus.services.chat_runs import execute_chat_run
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

logger = get_logger(__name__)

_CHAT_RUN_SPEC = LlmTaskSpec(label="chat_run", http_timeout_s=60.0, http_limits=(100, 20))


def chat_run(run_id: str) -> dict:
    run_uuid = UUID(run_id)
    settings = get_settings()

    async def _handler(db: Session, router: ModelRuntime, client: httpx.AsyncClient) -> dict:
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
