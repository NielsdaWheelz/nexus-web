"""Worker entrypoint for the universal dossier engine.

``dossier_build`` is the sole task body for the ``dossier_build`` job kind
(CONTRACTS.md A19/B1a): it reads the job's build id, opens the shared LLM
worker envelope (db session, event loop, ``ExecutionRuntime``), and hands off
to ``engine.run_build`` for the entire durable reduce (collect -> ensure MI ->
reduce[coordination] -> validate citations -> terminal). ``engine.run_build``
owns every terminal write (success/modeled-failure/cancel), so there is no
worker-exception status flip here (contrast the deleted D-6
``_fail_revision_after_worker_exception``): an unexpected exception propagates
to the queue's own retry/dead-letter policy, which is the durable-execution
Suspended-advisory model (A8/B4) -- a suspended build is left exactly as it
was, never gets a synthesized failure written for it, and is repaired only by
an operator ``requeue_dead_job`` (after fixing the underlying cause) or a user
Cancel (which terminalizes it and unlocks a new Generate).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy.orm import Session

from nexus.jobs.queue import JobExecutionContext, JobRow, RescheduleRequested
from nexus.logging import get_logger
from nexus.services.artifacts import engine
from nexus.services.llm_execution import ExecutionRuntime
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

logger = get_logger(__name__)


def dossier_build(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested:
    """Run one dossier build attempt (job kind ``dossier_build``, A19).

    ``engine.run_build`` is replay-safe (a no-op once the build already has a
    terminal child) and owns the whole reduce loop + every terminal write.
    Deliberately no ``on_worker_exception`` boundary: a bare exception here is
    left to propagate so the queue's normal retry/dead-letter machinery
    applies (see module docstring).
    """
    build_id = UUID(str(payload["build_id"]))
    spec = LlmTaskSpec(label="dossier_build", http_timeout_s=120.0)

    async def _handler(
        db: Session, runtime: ExecutionRuntime, _client: httpx.AsyncClient
    ) -> Mapping[str, Any] | RescheduleRequested:
        reschedule = await engine.run_build(
            db, build_id=build_id, ctx=context, runtime=runtime
        )
        if reschedule is not None:
            return reschedule
        return {"status": "ok", "build_id": str(build_id)}

    return run_llm_task(spec, _handler)


def dead_letter_dossier_build(db: Session, job: JobRow) -> None:
    """Diagnostic-only dead-letter hook for a dead-lettered ``dossier_build`` job.

    A dead job row IS the Suspended signal (it stays queryable forever --
    ``JobDefinition.never_prune_dead=True``); this hook writes no domain state
    and never touches the build. It only surfaces the build id in the
    operator-facing dead-letter log line (``jobs/worker.py`` logs the generic
    ``worker_job_dead_letter_handled`` line right after this returns). Repair
    is an operator ``requeue_dead_job`` once the underlying cause is fixed, or
    a user Cancel to terminalize the suspended build and unlock a new
    Generate -- this hook must never synthesize a failure or redispatch.
    """
    logger.warning(
        "dossier_build_dead_lettered",
        job_id=str(job.id),
        build_id=str(job.payload.get("build_id")),
    )
