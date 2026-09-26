"""Worker job handler for durable chat runs."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, LLMModelTurnContinuation, LLMToolPosition
from nexus.db.session import get_session_factory
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    get_job,
    requeue_dead_job,
)
from nexus.logging import get_logger
from nexus.services.chat_run_worker import execute_chat_run
from nexus.services.durable_step_journal import Uncertain, read_step_states, stable_generation_id
from nexus.services.llm_execution import ExecutionRuntime
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

logger = get_logger(__name__)

_CHAT_RUN_SPEC = LlmTaskSpec(label="chat_run")


def chat_run(run_id: str, *, context: JobExecutionContext) -> RescheduleRequested | None:
    """Run one claimed chat job.

    Defects escape unchanged: the queue owns retries and durable suspension,
    and expected product failures are already folded by the worker.
    """

    async def handler(db: Session, runtime: ExecutionRuntime) -> RescheduleRequested | None:
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

    outcome = run_llm_task(_CHAT_RUN_SPEC, handler)
    return outcome if isinstance(outcome, RescheduleRequested) else None


def record_dead_lettered_chat_run(db: Session, job: JobRow) -> None:
    """Suspend the run, or requeue the same job to fold a prior cancellation."""

    raw_run_id = job.payload.get("run_id")
    if raw_run_id is None:
        raise ValueError("chat_run dead-letter payload is missing run_id")
    run_id = UUID(str(raw_run_id))
    run = db.execute(
        select(ChatRun.status, ChatRun.cancel_requested_at, ChatRun.generation_spec).where(
            ChatRun.id == run_id
        )
    ).one_or_none()
    requeued_for_cancellation = bool(
        run is not None
        and run.status in {"queued", "running"}
        and run.cancel_requested_at is not None
    )
    if requeued_for_cancellation and run is not None:
        step_path = "generation/1"
        state = read_step_states(job).get(step_path)
        if state is not None and state.generation_id != stable_generation_id(run_id, step_path):
            requeued_for_cancellation = False
        elif state is not None and state.dispatch_phase is Uncertain:
            selection = run.generation_spec.get("selection")
            if not isinstance(selection, dict) or selection.get("route") != "ProviderApi":
                requeued_for_cancellation = False
            else:
                pending = db.scalar(
                    select(func.count())
                    .select_from(LLMModelTurnContinuation)
                    .where(LLMModelTurnContinuation.generation_id == state.generation_id)
                )
                unfinished_tool = db.scalar(
                    select(LLMToolPosition.id)
                    .where(
                        LLMToolPosition.generation_id == state.generation_id,
                        LLMToolPosition.replay_status != "Completed",
                    )
                    .limit(1)
                )
                requeued_for_cancellation = pending == 1 and unfinished_tool is None
    if requeued_for_cancellation and not requeue_dead_job(db, job_id=job.id):
        raise AssertionError("cancelled chat job changed during dead-letter handling")
    logger.warning(
        "chat_run_cancel_requeued" if requeued_for_cancellation else "chat_run_suspended",
        run_id=str(run_id),
        job_id=str(job.id),
        attempts=job.attempts,
        error_code=job.error_code,
    )
