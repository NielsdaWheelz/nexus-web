"""Worker job handler for one per-media intelligence unit build."""

from __future__ import annotations

from uuid import UUID

import httpx
from sqlalchemy.orm import Session

from nexus.jobs.queue import JobExecutionContext
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.media_intelligence import run_media_unit_build
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

_SPEC = LlmTaskSpec(label="media_unit_build")


def media_unit_build(
    *, media_id: str, content_fingerprint: str, context: JobExecutionContext
) -> dict:
    media_uuid = UUID(media_id)

    async def _handler(db: Session, runtime: ExecutionRuntime, _client: httpx.AsyncClient) -> dict:
        outcome = await run_media_unit_build(
            db,
            media_id=media_uuid,
            content_fingerprint=content_fingerprint,
            ctx=context,
            runtime=runtime,
        )
        # A modeled domain failure is a completed durable job, not a queue
        # infrastructure failure. Unexpected exceptions propagate to retry.
        return {"status": "ok", "outcome": outcome, "media_id": media_id}

    return run_llm_task(_SPEC, _handler)
