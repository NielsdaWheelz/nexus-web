"""Public recovery proof for billed Artifact synthesis and document repair."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from uuid import UUID, uuid4

from provider_runtime import (
    Absent,
    CallMeta,
    Cancelled,
    Present,
    StructuredContent,
    Succeeded,
    TerminalEvent,
)
from provider_runtime.testing import ScriptedRuntime
from provider_runtime.types import (
    AttemptRecord,
    FinalAttempt,
    PossiblyBillable,
    ResponsePayload,
)
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.db.models import (
    ArtifactBuildCancellation,
    ArtifactBuildFailure,
    ArtifactRevision,
    SynthesisArtifact,
)
from nexus.db.session import create_session_factory
from nexus.jobs.queue import (
    PENDING,
    JobExecutionContext,
    JobRow,
    claim_job,
    complete_job,
    fail_job,
    find_nonterminal_jobs_for_payload,
    get_job,
)
from nexus.services import note_bodies
from nexus.services.artifacts.coordination import DossierBuildRuntime
from nexus.services.artifacts.engine import (
    reconcile_uncertain_build,
    regenerate_artifact,
    run_build,
)
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.durable_step_journal import (
    AttachReconciledResult,
    Completed,
    Uncertain,
    read_step_states,
)
from nexus.services.llm_profiles import operation_profile
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from nexus.tasks.artifacts import compose_dossier_tool_runtime
from tests.testkit.unreachable_state import set_pending_job_max_attempts

_PROFILE = operation_profile("dossier_note")


@dataclass(frozen=True, slots=True)
class _NoteBuild:
    user_id: UUID
    artifact_id: UUID
    build_id: UUID
    job_id: UUID


def _meta(label: str) -> CallMeta:
    return CallMeta(
        provider=_PROFILE.target.provider,
        model=_PROFILE.target.model,
        provider_request_id=Present(f"artifact-generation-{label}"),
        upstream_provider=Absent(),
        usage=Absent(),
        attempt_trace=(
            AttemptRecord(
                attempt=1,
                signal=FinalAttempt(),
                status_code=Present(200),
                started_at_ms=0,
                ended_at_ms=1,
            ),
        ),
        billability=PossiblyBillable(),
        native_reasoning=Present("low"),
        registry_revision="artifact-generation-replay-v1",
    )


def _synthesis_payload(*, invalid_document: bool) -> dict[str, object]:
    script = "<script>forbidden()</script>" if invalid_document else ""
    return {
        "content_html": (
            '<article><section id="finding"><h2>Finding</h2><p>A grounded note '
            f'finding <cite data-nexus-citation="1"></cite>.</p>{script}</section></article>'
        ),
        "citations": [{"ordinal": 1, "candidate_index": 0, "role": "supports"}],
    }


def _succeeded(payload: dict[str, object], *, label: str) -> Succeeded:
    encoded = json.dumps(payload, separators=(",", ":"))
    return Succeeded(
        meta=_meta(label),
        response=ResponsePayload(
            content=StructuredContent(payload=payload, text=encoded),
            continuation=Absent(),
        ),
    )


def _create_note_build(db: Session) -> _NoteBuild:
    user_id = uuid4()
    note_id = uuid4()
    ensure_user_and_default_library(
        db,
        user_id,
        f"artifact-generation-{user_id}@example.invalid",
    )
    grant_entitlement_override(
        db,
        user_id=user_id,
        plan_tier="ai_pro",
        platform_token_quota_mode="unlimited",
        platform_token_limit_monthly=None,
        transcription_quota_mode="unlimited",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="Artifact generation replay proof",
        actor_label="nexus-test",
    )
    note_bodies.upsert_note_body(
        db,
        viewer_id=user_id,
        block_id=note_id,
        body_pm_json=note_bodies.pm_doc_from_text("A durable non-ASCII note about café proof."),
    )
    artifact = SynthesisArtifact(
        subject_scheme="note_block",
        subject_id=note_id,
        audience_scheme="user",
        audience_id=str(user_id),
    )
    db.add(artifact)
    db.flush()
    db.commit()
    ticket = regenerate_artifact(
        db,
        artifact_id=artifact.id,
        requester_user_id=user_id,
        idempotency_key=f"artifact-generation-{uuid4()}",
        instruction=None,
    )
    jobs = find_nonterminal_jobs_for_payload(
        db,
        kind="dossier_build",
        expected_payload_match={"build_id": str(ticket.build_id)},
    )
    assert len(jobs) == 1
    set_pending_job_max_attempts(db, job_id=jobs[0].id, max_attempts=1)
    db.commit()
    return _NoteBuild(
        user_id=user_id,
        artifact_id=artifact.id,
        build_id=ticket.build_id,
        job_id=jobs[0].id,
    )


def _claim(db: Session, build: _NoteBuild, *, worker_id: str) -> tuple[JobRow, JobExecutionContext]:
    job = claim_job(
        db,
        job_id=build.job_id,
        worker_id=worker_id,
        lease_seconds=300,
        heavy_kinds=("dossier_build",),
        allowed_kinds=("dossier_build",),
    )
    assert job is not None
    context = JobExecutionContext(
        job_id=job.id,
        worker_id=worker_id,
        attempt_no=job.attempts,
        resource_class="Heavy",
    )
    db.commit()
    return job, context


def _runtime(
    build: _NoteBuild,
    job: JobRow,
    context: JobExecutionContext,
    llm_runtime: ScriptedRuntime,
) -> DossierBuildRuntime:
    return DossierBuildRuntime(
        build_id=build.build_id,
        artifact_id=build.artifact_id,
        job=job,
        execution_context=context,
        llm_runtime=llm_runtime,
        research_tool_operation=compose_dossier_tool_runtime(None).operations[
            "idea_dossier_research"
        ],
    )


def test_uncertain_document_repair_reconciles_and_replays_without_dispatch(engine: Engine) -> None:
    session_factory = create_session_factory(engine)
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=session_factory))
    try:
        with Session(engine, expire_on_commit=False) as db:
            build = _create_note_build(db)
            job, context = _claim(db, build, worker_id="artifact-repair-first")
            scripted = ScriptedRuntime(
                stream_scripts=(
                    (
                        TerminalEvent(
                            outcome=_succeeded(
                                _synthesis_payload(invalid_document=True),
                                label="invalid-primary",
                            )
                        ),
                    ),
                ),
                generate_outcomes=(Cancelled(meta=_meta("uncertain-repair")),),
            )

            assert (
                asyncio.run(
                    run_build(
                        db,
                        build_id=build.build_id,
                        ctx=context,
                        runtime=_runtime(build, job, context, scripted),
                    )
                )
                is None
            )
            assert [call.operation for call in scripted.calls] == ["stream", "generate"]
            interrupted = get_job(db, build.job_id)
            assert interrupted is not None
            interrupted_states = read_step_states(interrupted)
            assert interrupted_states["synthesis"].dispatch_phase is Completed
            assert interrupted_states["document-repair"].dispatch_phase is Uncertain
            assert (
                db.scalar(
                    select(ArtifactRevision).where(ArtifactRevision.build_id == build.build_id)
                )
                is None
            )
            assert (
                db.scalar(
                    select(ArtifactBuildFailure).where(
                        ArtifactBuildFailure.build_id == build.build_id
                    )
                )
                is None
            )
            assert (
                db.scalar(
                    select(ArtifactBuildCancellation).where(
                        ArtifactBuildCancellation.build_id == build.build_id
                    )
                )
                is None
            )

            assert (
                fail_job(
                    db,
                    job_id=build.job_id,
                    worker_id=context.worker_id,
                    error_code="E_RECONCILIATION_REQUIRED",
                    error_message="document repair dispatch outcome is uncertain",
                    retry_delays_seconds=(0,),
                )
                == "dead"
            )
            db.commit()
            recovered = json.dumps(
                _synthesis_payload(invalid_document=False),
                separators=(",", ":"),
            )
            reconcile_uncertain_build(
                db,
                build_id=build.build_id,
                resolution=AttachReconciledResult(terminal_result=recovered),
            )
            reconciled = get_job(db, build.job_id)
            assert reconciled is not None and reconciled.status == PENDING
            assert read_step_states(reconciled)["document-repair"].dispatch_phase is Completed

            replay_job, replay_context = _claim(
                db,
                build,
                worker_id="artifact-repair-replay",
            )
            replay_provider = ScriptedRuntime()
            assert (
                asyncio.run(
                    run_build(
                        db,
                        build_id=build.build_id,
                        ctx=replay_context,
                        runtime=_runtime(
                            build,
                            replay_job,
                            replay_context,
                            replay_provider,
                        ),
                    )
                )
                is None
            )
            assert replay_provider.calls == []
            revision = db.scalar(
                select(ArtifactRevision).where(ArtifactRevision.build_id == build.build_id)
            )
            assert revision is not None
            artifact = db.get(SynthesisArtifact, build.artifact_id)
            assert artifact is not None and artifact.current_revision_id == revision.id
            assert complete_job(
                db,
                job_id=build.job_id,
                worker_id=replay_context.worker_id,
                result_payload={"status": "ok"},
            )
            db.commit()
    finally:
        set_rate_limiter(previous_limiter)
