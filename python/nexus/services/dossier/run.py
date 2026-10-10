"""One ``dossier_build`` attempt: facts, ensure, collect, synthesize, publish or fail.

A build that is no longer active is a no-op. Any attempt that keeps its claim settles
the build, Stopped included, so no active build outlives a succeeded job; a retry
after a dead worker synthesizes again from scratch. No transaction is held across a
network call.
"""

from datetime import UTC, datetime, timedelta
from uuid import UUID

from llm_tools import WebSearchProvider
from sqlalchemy.orm import Session

from nexus.jobs.queue import JobExecutionContext, RescheduleRequested, ScheduleAt, get_job
from nexus.schemas.dossier import DossierFailureCode
from nexus.services.dossier import engine, research, subjects, synthesis
from nexus.services.dossier.inputs import InputTooLarge
from nexus.services.generation.runtime import Runtime

_PENDING_RECHECK = timedelta(seconds=5)


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
            return RescheduleRequested(ScheduleAt(datetime.now(UTC) + _PENDING_RECHECK))
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
            return RescheduleRequested(ScheduleAt(collected))
    else:
        try:
            collected = binding.inputs(db, facts.subject_id, viewer)
        except InputTooLarge:
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
