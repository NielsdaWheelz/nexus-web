"""Worker job handler for durable chat runs."""

from __future__ import annotations

from typing import Any, assert_never
from uuid import UUID

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session
from web_search_tool.brave import BraveSearchProvider
from web_search_tool.types import WebSearchProvider

from nexus.config import get_settings
from nexus.db.models import ChatRun
from nexus.db.session import get_session_factory
from nexus.jobs.queue import JobExecutionContext, JobRow, get_job, requeue_dead_job
from nexus.logging import get_logger
from nexus.services.chat_runs import (
    CancelledChatExecution,
    ChatExecutionOutcome,
    DegradedChatExecution,
    FailedChatExecution,
    PublishedChatExecution,
    SkippedChatExecution,
    execute_chat_run,
)
from nexus.services.llm_execution import ExecutionRuntime
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

logger = get_logger(__name__)

_CHAT_RUN_SPEC = LlmTaskSpec(label="chat_run", http_timeout_s=60.0, http_limits=(100, 20))


def chat_run(run_id: str, *, context: JobExecutionContext) -> dict[str, Any]:
    run_uuid = UUID(run_id)
    settings = get_settings()

    async def _handler(
        db: Session, runtime: ExecutionRuntime, client: httpx.AsyncClient
    ) -> ChatExecutionOutcome:
        job = get_job(db, context.job_id)
        if job is None or str(job.payload.get("run_id")) != run_id:
            raise AssertionError("claimed chat job does not match its run payload")
        web_search_provider: WebSearchProvider | None = (
            BraveSearchProvider(client, api_key=settings.brave_search_api_key)
            if settings.brave_search_api_key
            else None
        )
        return await execute_chat_run(
            db,
            run_id=run_uuid,
            job=job,
            execution_context=context,
            session_factory=get_session_factory(),
            runtime=runtime,
            settings=settings,
            web_search_provider=web_search_provider,
        )

    # Defects escape this handler unchanged. The queue owns retries and durable
    # suspension; expected product failures are already folded by the executor.
    logger.info("chat_run_started", run_id=run_id)
    result = _serialize_chat_execution(run_llm_task(_CHAT_RUN_SPEC, _handler))
    logger.info("chat_run_completed", run_id=run_id, result=result)
    return result


def _serialize_chat_execution(outcome: ChatExecutionOutcome) -> dict[str, Any]:
    """The sole chat-owned outcome to generic queue-payload adapter."""
    if isinstance(outcome, PublishedChatExecution):
        return {
            "kind": outcome.kind,
            "run_id": str(outcome.run_id),
            "message_id": str(outcome.message_id),
            "citation_count": outcome.citation_count,
        }
    if isinstance(outcome, DegradedChatExecution):
        return {
            "kind": outcome.kind,
            "run_id": str(outcome.run_id),
            "message_id": str(outcome.message_id),
            "warning_code": outcome.warning_code,
            "support_id": outcome.support_id,
        }
    if isinstance(outcome, FailedChatExecution):
        return {
            "kind": outcome.kind,
            "run_id": str(outcome.run_id),
            "error_code": outcome.error_code.model_dump(mode="json"),
            "support_id": outcome.support_id.model_dump(mode="json"),
        }
    if isinstance(outcome, CancelledChatExecution):
        return {"kind": outcome.kind, "run_id": str(outcome.run_id)}
    if isinstance(outcome, SkippedChatExecution):
        return {"kind": outcome.kind, "reason": outcome.reason}
    assert_never(outcome)


def record_dead_lettered_chat_run(db: Session, job: JobRow) -> None:
    """Suspend the run, or requeue the same job to fold a prior cancellation."""
    raw_run_id = job.payload.get("run_id")
    if raw_run_id is None:
        raise ValueError("chat_run dead-letter payload is missing run_id")
    run_id = UUID(str(raw_run_id))
    run = db.execute(
        select(ChatRun.status, ChatRun.cancel_requested_at).where(ChatRun.id == run_id)
    ).one_or_none()
    requeued_for_cancellation = bool(
        run is not None
        and run.status in {"queued", "running"}
        and run.cancel_requested_at is not None
    )
    if requeued_for_cancellation and not requeue_dead_job(db, job_id=job.id):
        raise AssertionError("cancelled chat job changed during dead-letter handling")
    logger.warning(
        "chat_run_cancel_requeued" if requeued_for_cancellation else "chat_run_suspended",
        run_id=str(run_id),
        job_id=str(job.id),
        attempts=job.attempts,
        error_code=job.error_code,
    )
