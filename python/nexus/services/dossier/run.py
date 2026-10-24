"""One ``dossier_build`` attempt: facts, ensure, collect, synthesize, publish or fail.

A build that is no longer active is a no-op. Any attempt that keeps its claim settles
the build, Stopped included, so no active build outlives a succeeded job; a retry
after a dead worker synthesizes again from scratch. No transaction is held across a
network call.
"""

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from llm_tools import WebSearchProvider
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.jobs.queue import JobExecutionContext, JobResult, RescheduleRequested, get_job
from nexus.schemas.dossier import DossierFailureCode
from nexus.services.dossier import engine, research, subjects, synthesis
from nexus.services.dossier.inputs import InputTooLarge
from nexus.services.generation.runtime import Runtime, run_generation_job

_PENDING_RECHECK = timedelta(seconds=5)


def run_job(*, payload: Mapping[str, Any], context: JobExecutionContext) -> JobResult:
    """One ``dossier_build`` attempt, with the web search provider its runtime composes.

    ``run_build`` owns every terminal write; an unexpected exception goes to the
    queue's retry and dead-letter policy, which the head reads as Suspended.
    """
    import httpx

    from nexus.services.tools.run import configured_web_search

    build_id = UUID(payload["build_id"])

    async def attempt(db: Session, runtime: Runtime) -> JobResult:
        timeout = httpx.Timeout(120.0, connect=10.0)
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            web = configured_web_search(client, get_settings())
            reschedule = await run_build(
                db, build_id=build_id, ctx=context, runtime=runtime, web=web
            )
        return reschedule or {"status": "ok", "build_id": str(build_id)}

    return run_generation_job("dossier_build", context, attempt)


async def run_build(
    db: Session,
    *,
    build_id: UUID,
    ctx: JobExecutionContext,
    runtime: Runtime,
    web: WebSearchProvider | None,
) -> RescheduleRequested | None:
    facts = engine.build_facts(db, build_id)
    job = get_job(db, ctx.job_id)
    if facts is None or job is None:
        return None

    def fail(code: DossierFailureCode, detail: str | None = None) -> None:
        engine.fail(db, build_id=build_id, ctx=ctx, code=code, detail=detail)

    binding = subjects.BINDINGS[facts.scheme]
    viewer = subjects.input_viewer(db, facts.audience_scheme, facts.audience_id)
    visible = subjects.subject_visible(db, facts.scheme, facts.subject_id, facts.requester_id)
    db.commit()
    if not visible:
        fail(DossierFailureCode.InputsChanged, "the requester can no longer see the subject")
        return None
    if binding.ensure is not None:
        readiness = binding.ensure(db, facts.subject_id, viewer)
        db.commit()
        if readiness == "Pending":
            return RescheduleRequested(datetime.now(UTC) + _PENDING_RECHECK)
        if readiness == "Failed":
            fail(DossierFailureCode.DependencyProjectionFailed)
            return None
    if binding.inputs is None:
        collected = await research.gather(
            db,
            idea_id=facts.subject_id,
            artifact_id=facts.artifact_id,
            build_id=build_id,
            user_id=viewer,
            ctx=ctx,
            job=job,
            web=web,
        )
        if isinstance(collected, datetime):
            return RescheduleRequested(collected)
    else:
        try:
            collected = binding.inputs(db, facts.subject_id, viewer)
        except InputTooLarge:
            db.rollback()  # discard only the failed input read before the terminal owner
            fail(DossierFailureCode.ContextTooLarge)
            return None
    db.commit()
    if not collected.candidates:
        fail(DossierFailureCode.NoSourceMaterial)
        return None
    outcome = await synthesis.run(
        build_id=build_id,
        requester_id=facts.requester_id,
        binding=binding,
        collected=collected,
        instruction=facts.instruction,
        ctx=ctx,
        runtime=runtime,
    )
    if isinstance(outcome, synthesis.Published):
        engine.publish(db, build_id=build_id, ctx=ctx, published=outcome)
    elif isinstance(outcome, synthesis.Failed):
        fail(outcome.code, outcome.detail)
    else:
        fail(DossierFailureCode.RuntimeUnavailable, "generation stopped without a dossier cancel")
    return None
