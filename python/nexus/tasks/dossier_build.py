"""The ``dossier_build`` queue entry: compose the web search provider, run one attempt.

``run.run_build`` owns every terminal write; an unexpected exception goes to the
queue's retry and dead-letter policy, which the head reads as Suspended.
"""

from collections.abc import Mapping
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.jobs.queue import JobExecutionContext, RescheduleRequested
from nexus.services.dossier.run import run_build
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.tool_runtime.catalog import compose_configured_web_search_provider
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task


def dossier_build(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested:
    build_id = UUID(str(payload["build_id"]))

    async def handler(
        db: Session, runtime: ExecutionRuntime
    ) -> Mapping[str, Any] | RescheduleRequested:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, connect=10.0), trust_env=False
        ) as client:
            web = compose_configured_web_search_provider(client, settings=get_settings())
            reschedule = await run_build(
                db, build_id=build_id, ctx=context, runtime=runtime, web=web
            )
        return reschedule or {"status": "ok", "build_id": str(build_id)}

    return run_llm_task(LlmTaskSpec(label="dossier_build"), handler)
