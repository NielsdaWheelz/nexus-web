"""Worker job handler for one Black Forest Oracle reading."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.jobs.queue import JobExecutionContext, RescheduleRequested
from nexus.logging import get_logger
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.oracle import execute_reading
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

logger = get_logger(__name__)

_SPEC = LlmTaskSpec(label="oracle_reading")


def oracle_reading_generate(
    reading_id: str,
    *,
    context: JobExecutionContext,
) -> dict | RescheduleRequested:
    reading_uuid = UUID(reading_id)
    logger.info("oracle_reading_started", reading_id=reading_id)

    async def _handler(db: Session, runtime: ExecutionRuntime) -> dict | RescheduleRequested:
        return await execute_reading(
            db,
            reading_id=reading_uuid,
            context=context,
            runtime=runtime,
        )

    # Durable generation or publication defects stay retryable/suspended queue
    # work. Synthesizing an Oracle failure here could publish before a known
    # generation terminal (notably after accepted stream loss) or overwrite a
    # replayable Completed checkpoint.
    result = run_llm_task(_SPEC, _handler)
    logger.info("oracle_reading_completed", reading_id=reading_id, result=result)
    return result
