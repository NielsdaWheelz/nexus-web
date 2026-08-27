"""Public recovery proof for durable Codex Artifact generation replay."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from uuid import UUID, uuid4

import pytest
from pydantic import JsonValue
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
from nexus.services import generation_policy, note_bodies
from nexus.services.artifacts.coordination import DossierBuildRuntime
from nexus.services.artifacts.engine import (
    reconcile_uncertain_build,
    regenerate_artifact,
    run_build,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.codex_generation_client import CodexGenerationClientError
from nexus.services.codex_generation_contract import (
    GenerationCommand,
    GenerationFrame,
    GenerationHealth,
    GenerationSessionRef,
    GenerationTerminal,
    GenerationUsage,
)
from nexus.services.durable_step_journal import (
    Completed,
    Prepared,
    ProveNotDispatched,
    Uncertain,
    read_step_states,
)
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from nexus.tasks.artifacts import compose_dossier_tool_runtime
from tests.testkit.unreachable_state import set_pending_job_max_attempts


@dataclass(frozen=True, slots=True)
class _NoteBuild:
    user_id: UUID
    artifact_id: UUID
    build_id: UUID
    job_id: UUID


def _synthesis_payload(*, invalid_document: bool) -> dict[str, JsonValue]:
    script = "<script>forbidden()</script>" if invalid_document else ""
    return {
        "content_html": (
            '<article><section id="finding"><h2>Finding</h2><p>A grounded note '
            f'finding <cite data-nexus-citation="1"></cite>.</p>{script}</section></article>'
        ),
        "citations": [{"ordinal": 1, "candidate_index": 0, "role": "supports"}],
    }


def _succeeded(command: GenerationCommand, payload: dict[str, JsonValue]) -> GenerationFrame:
    return GenerationFrame(
        request_id=command.request_id,
        sequence=0,
        event=GenerationTerminal(
            status="succeeded",
            failure=None,
            final_text="",
            structured_output=payload,
            session_ref=GenerationSessionRef(
                schema_version="agent-session-ref.v1",
                backend="codex",
                transport="sdk",
                native_session_id=f"artifact-generation-{command.request_id}",
                profile_key="codex-personal",
                state_root_fingerprint="1" * 64,
                cwd_fingerprint="2" * 64,
            ),
            usage=GenerationUsage(input_tokens=80, output_tokens=20, total_tokens=100),
            diagnostics=(),
            accepted_at="2026-08-24T12:34:56.123456Z",
            sdk_version="0.144.4",
            runtime_version="0.144.4",
        ),
    )


class _ScriptedCodexRuntime(ExecutionRuntime):
    def __init__(self, outcomes: tuple[dict[str, JsonValue] | Exception, ...] = ()) -> None:
        self._outcomes = list(outcomes)
        self.commands: list[GenerationCommand] = []

    async def health(self) -> GenerationHealth:
        return GenerationHealth(
            policy_revision=generation_policy.POLICY_REVISION,
            sdk_version="0.144.4",
            runtime_version="0.144.4",
        )

    def stream(self, command: GenerationCommand) -> AsyncIterator[GenerationFrame]:
        self.commands.append(command)
        if not self._outcomes:
            raise AssertionError("unexpected Artifact generation dispatch")
        outcome = self._outcomes.pop(0)

        async def frames() -> AsyncIterator[GenerationFrame]:
            if isinstance(outcome, Exception):
                raise outcome
            yield _succeeded(command, outcome)

        return frames()

    async def cancel(self, request_id: UUID) -> None:
        raise AssertionError(f"unexpected Artifact generation cancellation for {request_id}")


def _create_note_build(db: Session) -> _NoteBuild:
    user_id = uuid4()
    note_id = uuid4()
    ensure_user_and_default_library(
        db,
        user_id,
        f"artifact-generation-{user_id}@example.invalid",
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
    llm_runtime: ExecutionRuntime,
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


def test_proven_nondispatch_replays_the_exact_document_repair_command(engine: Engine) -> None:
    session_factory = create_session_factory(engine)
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=session_factory))
    try:
        with Session(engine, expire_on_commit=False) as db:
            build = _create_note_build(db)
            job, context = _claim(db, build, worker_id="artifact-repair-first")
            scripted = _ScriptedCodexRuntime(
                (
                    _synthesis_payload(invalid_document=True),
                    CodexGenerationClientError("document repair transport is ambiguous"),
                ),
            )

            with pytest.raises(RuntimeError, match="document repair transport is ambiguous"):
                asyncio.run(
                    run_build(
                        db,
                        build_id=build.build_id,
                        ctx=context,
                        runtime=_runtime(build, job, context, scripted),
                    )
                )
            assert len(scripted.commands) == 2
            assert all(command.operation.kind == "dossier_note" for command in scripted.commands)
            original_repair_command = scripted.commands[1]
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
            reconcile_uncertain_build(
                db,
                build_id=build.build_id,
                resolution=ProveNotDispatched(),
            )
            reconciled = get_job(db, build.job_id)
            assert reconciled is not None and reconciled.status == PENDING
            assert read_step_states(reconciled)["document-repair"].dispatch_phase is Prepared

            replay_job, replay_context = _claim(
                db,
                build,
                worker_id="artifact-repair-replay",
            )
            replay_runtime = _ScriptedCodexRuntime(
                (_synthesis_payload(invalid_document=False),)
            )
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
                            replay_runtime,
                        ),
                    )
                )
                is None
            )
            assert replay_runtime.commands == [original_repair_command]
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
