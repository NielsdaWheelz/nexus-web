"""Worker job handler for one synapse scan."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.jobs.queue import JobExecutionContext, RescheduleRequested
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.resource_graph.refs import assert_resource_ref
from nexus.services.synapse import run_synapse_scan
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

_SPEC = LlmTaskSpec(label="synapse_scan")


def synapse_scan(
    user_id: str,
    ref: str,
    reason: str,
    *,
    context: JobExecutionContext,
) -> dict | RescheduleRequested:
    user_uuid = UUID(user_id)
    parsed_ref = assert_resource_ref(ref)

    async def _handler(db: Session, runtime: ExecutionRuntime) -> dict | RescheduleRequested:
        result = await run_synapse_scan(
            db,
            user_id=user_uuid,
            ref=parsed_ref,
            context=context,
            runtime=runtime,
        )
        if isinstance(result, RescheduleRequested):
            return result
        # "trigger", not "reason": the worker failure protocol reads
        # result["reason"] as the error message for a failed status.
        return {
            "status": result.status,
            "error_code": result.error_code,
            "ref": ref,
            "trigger": reason,
        }

    return run_llm_task(_SPEC, _handler)
