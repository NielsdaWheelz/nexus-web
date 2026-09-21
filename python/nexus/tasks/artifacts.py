"""The ``dossier_build`` worker entry point.

``engine.run_build`` owns the whole attempt and every terminal write, so there
is no status flip here: an unexpected exception propagates to the queue's
retry/dead-letter policy, which surfaces the build as Suspended for an operator
rather than synthesizing a failure for it.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID

import httpx
from llm_tools import WebSearchProvider
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import ArtifactBuild
from nexus.jobs.queue import JobExecutionContext, RescheduleRequested, get_job
from nexus.services.artifacts import engine
from nexus.services.artifacts.coordination import DossierBuildRuntime
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.tool_runtime.catalog import (
    compose_configured_web_search_provider,
    compose_tool_runtime,
)
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task


def dossier_build(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested:
    """Run one dossier build attempt; replay-safe once a terminal child exists."""
    build_id = UUID(str(payload["build_id"]))
    settings = get_settings()

    async def handler(
        db: Session, runtime: ExecutionRuntime
    ) -> Mapping[str, Any] | RescheduleRequested:
        build = db.get(ArtifactBuild, build_id)
        job = get_job(db, context.job_id)
        if build is None or job is None:
            return {"status": "ok", "build_id": str(build_id)}
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, connect=10.0),
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
            trust_env=False,
        ) as client:
            provider: WebSearchProvider | None = compose_configured_web_search_provider(
                client, settings=settings
            )
            reschedule = await engine.run_build(
                db,
                build_id=build_id,
                ctx=context,
                runtime=DossierBuildRuntime(
                    build_id=build_id,
                    artifact_id=build.artifact_id,
                    job=job,
                    execution_context=context,
                    llm_runtime=runtime,
                    research_tool_operation=compose_tool_runtime(provider).operations[
                        "idea_dossier_research"
                    ],
                    settings=settings,
                ),
            )
        return reschedule or {"status": "ok", "build_id": str(build_id)}

    return run_llm_task(LlmTaskSpec(label="dossier_build"), handler)
