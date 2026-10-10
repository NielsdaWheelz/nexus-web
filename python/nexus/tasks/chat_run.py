"""Worker job handler for durable chat runs."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun
from nexus.jobs.queue import JobExecutionContext, JobRow, get_job
from nexus.logging import get_logger
from nexus.services.chat_run_event_store import finalize_dead_run
from nexus.services.chat_run_worker import execute_chat_run
from nexus.services.generation.ledger import interrupt_job_generations
from nexus.services.generation.runtime import Runtime, run_generation_job

logger = get_logger(__name__)


def chat_run(run_id: str, *, context: JobExecutionContext) -> None:
    """Run one claimed chat job; the queue owns retries of a defect."""

    async def work(db: Session, runtime: Runtime) -> None:
        job = get_job(db, context.job_id)
        if job is None or str(job.payload.get("run_id")) != run_id:
            raise AssertionError("claimed chat job does not match its run payload")
        await execute_chat_run(db, run_id=UUID(run_id), context=context, runtime=runtime)

    run_generation_job("chat_run", context, work)


def record_dead_lettered_chat_run(db: Session, job: JobRow) -> None:
    """A dead chat job ends its run: ``cancelled`` if asked, else ``interrupted``."""

    run_id = UUID(str(job.payload["run_id"]))
    interrupt_job_generations(db, job_id=job.id, detail="its chat job died")
    # The queue holds the job row; never wait on a run a cancel has locked (run -> job).
    # That cancel finds this dead job once the transition commits, and ends the run.
    run = db.scalar(
        select(ChatRun)
        .where(ChatRun.id == run_id)
        .execution_options(populate_existing=True)
        .with_for_update(skip_locked=True)
    )
    if run is not None:
        finalize_dead_run(db, run)
    logger.warning(
        "chat_run_dead_lettered",
        run_id=str(run_id),
        job_id=str(job.id),
        attempts=job.attempts,
        error_code=job.error_code,
    )
