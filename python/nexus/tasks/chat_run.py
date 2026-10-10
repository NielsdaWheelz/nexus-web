"""Worker job handler for durable chat runs."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun
from nexus.db.session import get_session_factory
from nexus.jobs.queue import JobExecutionContext, JobRow, get_job
from nexus.logging import get_logger
from nexus.services.chat_run_worker import execute_chat_run, settle_cancelled_dead_chat_run
from nexus.services.llm_execution import ExecutionRuntime
from nexus.tasks.llm_task import run_llm_task

logger = get_logger(__name__)


def chat_run(run_id: str, *, context: JobExecutionContext) -> None:
    """Run one claimed chat job.

    Defects escape unchanged: the queue owns retries and durable suspension,
    and expected product failures are already folded by the worker.
    """

    async def handler(db: Session, runtime: ExecutionRuntime) -> None:
        job = get_job(db, context.job_id)
        if job is None or str(job.payload.get("run_id")) != run_id:
            raise AssertionError("claimed chat job does not match its run payload")
        return await execute_chat_run(
            db,
            run_id=UUID(run_id),
            job=job,
            execution_context=context,
            session_factory=get_session_factory(),
            runtime=runtime,
        )

    run_llm_task("chat_run", handler)


def record_dead_lettered_chat_run(db: Session, job: JobRow) -> None:
    """Settle a prior stop only if the dead job has locally conclusive evidence."""

    raw_run_id = job.payload.get("run_id")
    if raw_run_id is None:
        raise ValueError("chat_run dead-letter payload is missing run_id")
    run_id = UUID(str(raw_run_id))

    # The queue owns the job lock before this projection. Never block on a lock
    # taken earlier by cancel (admission -> owner -> run -> job): cancel will
    # inspect this dead job after the projection commits.
    owner_locked = db.scalar(
        text("SELECT pg_try_advisory_xact_lock(hashtextextended(:owner_key, 0))"),
        {"owner_key": f"chat_run:{run_id}"},
    )
    settled = False
    if owner_locked:
        run = db.scalar(
            select(ChatRun)
            .where(ChatRun.id == run_id)
            .execution_options(populate_existing=True)
            .with_for_update(skip_locked=True)
        )
        if run is not None and run.status in {"queued", "running"} and run.cancel_requested_at:
            settled = settle_cancelled_dead_chat_run(db, run=run, job=job)
    logger.warning(
        "chat_run_cancel_settled" if settled else "chat_run_suspended",
        run_id=str(run_id),
        job_id=str(job.id),
        attempts=job.attempts,
        error_code=job.error_code,
    )
