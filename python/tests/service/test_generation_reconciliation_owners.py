"""Proof that non-prompt-persisting owners recover only known non-dispatches."""

from __future__ import annotations

import asyncio
import json
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date
from typing import Literal, Never
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, select, text
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache, get_settings
from nexus.db.models import (
    ArtifactBuild,
    ArtifactBuildCancellation,
    ArtifactBuildFailure,
    ArtifactLearnRequest,
    Highlight,
    Media,
    MediaKind,
    Page,
    SynthesisArtifact,
)
from nexus.db.session import create_session_factory
from nexus.errors import InvalidRequestError
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    complete_job,
    dead_letter_expired_job,
    enqueue_job,
    fail_job,
    find_nonterminal_jobs_for_payload,
    get_job,
    update_running_job_payload,
)
from nexus.schemas.presence import Present, absent, present
from nexus.services import library_entries, notes
from nexus.services.artifacts import learn as learn_service
from nexus.services.artifacts.coordination import DossierBuildRuntime
from nexus.services.artifacts.dossier_types import SubjectResource
from nexus.services.artifacts.engine import (
    bootstrap_resource_dossier,
    cancel_build,
    on_subject_deleted,
    reconcile_uncertain_build,
    reconcile_uncertain_idea_resolution,
    regenerate_artifact,
    run_build,
)
from nexus.services.codex_generation_contract import (
    GenerationCommandDraft,
)
from nexus.services.dawn_write import reconcile_uncertain_dawn_write_generation
from nexus.services.durable_step_journal import (
    AttachReconciledResult,
    Completed,
    Prepared,
    ProveNotDispatched,
    StepReplayState,
    Uncertain,
    decode_step_states,
    payload_with_step_state,
    read_step_states,
    stable_generation_id,
)
from nexus.services.generation_spec import GenerationOperation
from nexus.services.llm_execution import GenerationUncertain
from nexus.services.llm_ledger import (
    LlmCallOwner,
    lock_generation_owner_in_current_transaction,
    read_generation,
    read_model_turns,
)
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.synapse import reconcile_uncertain_synapse_generation, run_synapse_scan
from nexus.tasks.artifacts import compose_dossier_tool_runtime
from nexus.tasks.enrich_metadata import METADATA_STEP_PATH, reconcile_uncertain_metadata_generation
from tests.testkit.codex_generation import (
    codex_generation_draft,
    stage_uncertain_codex_generation,
)
from tests.testkit.queue_claims import claim_job_row
from tests.testkit.unreachable_state import (
    expire_artifact_learn_resolver_lease,
    expire_job_claim,
)

_SYNAPSE_STEP_PATH = "synthesis"


def _await_backend_blocked_by(
    engine: Engine,
    *,
    blocking_pid: int,
) -> None:
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        with engine.connect() as connection:
            waiting_pid = connection.scalar(
                text(
                    """
                    SELECT pid
                    FROM pg_stat_activity
                    WHERE :blocking_pid = ANY(pg_blocking_pids(pid))
                      AND query ILIKE '%pg_advisory_xact_lock%'
                    ORDER BY query_start, pid
                    LIMIT 1
                    """
                ),
                {"blocking_pid": blocking_pid},
            )
            if waiting_pid is not None:
                return
            connection.execute(text("SELECT pg_sleep(0.01)"))
    raise AssertionError("Dossier teardown never reached its generation-owner lock")


class _NeverDispatchRuntime:
    @property
    def continuation_cipher(self) -> Never:
        raise AssertionError("terminal Synapse no-op reached continuation authority")

    @property
    def admission(self) -> Never:
        raise AssertionError("terminal Synapse no-op reached host health")

    async def execute(self, execution: object) -> Never:
        del execution
        raise AssertionError("terminal Synapse no-op dispatched")


class _NeverDossierDispatchRuntime:
    @property
    def continuation_cipher(self) -> Never:
        raise AssertionError("preaccept Dossier terminalization reached continuation authority")

    @property
    def admission(self) -> Never:
        raise AssertionError("preaccept Dossier terminalization reached host health")

    async def execute(self, execution: object) -> Never:
        del execution
        raise AssertionError("preaccept Dossier terminalization dispatched")


@dataclass(frozen=True, slots=True)
class _DossierGenerationOwner:
    user_id: UUID
    subject_ref: ResourceRef
    artifact_id: UUID
    build_id: UUID
    job: JobRow
    context: JobExecutionContext
    generation_id: UUID


def _draft(
    generation_id: UUID,
    *,
    operation: GenerationOperation,
) -> GenerationCommandDraft:
    return codex_generation_draft(
        request_id=generation_id,
        operation=operation,
        instructions="Return one bounded result.",
        input_text="durable reconciliation proof",
        model="gpt-5.6-terra",
        reasoning="high",
        turn_timeout_seconds=180,
    )


def _seed_dossier_generation_owner(
    engine: Engine,
    *,
    phase: Literal["prepared", "uncertain"],
) -> _DossierGenerationOwner:
    user_id = uuid4()
    media_id = uuid4()
    with Session(engine, expire_on_commit=False) as db:
        from nexus.services.bootstrap import ensure_user_and_default_library

        ensure_user_and_default_library(
            db,
            user_id,
            f"dossier-cancellation-{user_id}@example.invalid",
        )
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title="Dossier preaccept cancellation source",
                created_by_user_id=user_id,
            )
        )
        db.flush()
        assert library_entries.ensure_media_in_default_library(db, user_id, media_id)
        subject_ref = ResourceRef(scheme="media", id=media_id)
        db.commit()

        ticket = bootstrap_resource_dossier(
            db,
            locator=SubjectResource(ref=subject_ref),
            requester_user_id=user_id,
            idempotency_key=f"dossier-cancellation-{uuid4()}",
            instruction=None,
        )
        jobs = find_nonterminal_jobs_for_payload(
            db,
            kind="dossier_build",
            expected_payload_match={"build_id": str(ticket.build_id)},
        )
        assert len(jobs) == 1
        job_id = jobs[0].id
        worker_id = f"dossier-cancellation-{job_id}"
        claimed = claim_job_row(
            db,
            job_id=job_id,
            worker_id=worker_id,
            lease_seconds=300,
            heavy_kinds=("dossier_build",),
            allowed_kinds=("dossier_build",),
        )
        assert claimed is not None
        context = JobExecutionContext(
            job_id=claimed.id,
            worker_id=worker_id,
            attempt_no=claimed.attempts,
            resource_class="Heavy",
            execution_id=claimed.execution_id,
        )
        generation_id = stable_generation_id(ticket.build_id, "synthesis")
        draft = _draft(
            generation_id,
            operation="dossier_media",
        )
        state = StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Uncertain if phase == "uncertain" else Prepared,
            request_fingerprint=present(draft.spec.fingerprint),
            terminal_result=absent(),
        )
        assert update_running_job_payload(
            db,
            job_id=claimed.id,
            worker_id=worker_id,
            attempt_no=claimed.attempts,
            payload=payload_with_step_state(
                claimed.payload,
                step_path="synthesis",
                state=state,
            ),
        )
        if phase == "uncertain":
            stage_uncertain_codex_generation(
                db,
                owner=LlmCallOwner(kind="artifact_build", id=ticket.build_id),
                draft=draft,
            )
        db.commit()

        job = get_job(db, claimed.id)
        assert job is not None
        return _DossierGenerationOwner(
            user_id=user_id,
            subject_ref=subject_ref,
            artifact_id=ticket.artifact_id,
            build_id=ticket.build_id,
            job=job,
            context=context,
            generation_id=generation_id,
        )


def _close_dossier_claim(db: Session, seeded: _DossierGenerationOwner) -> None:
    """Close the exact fixture claim through the production queue state machine."""
    job = get_job(db, seeded.job.id)
    if job is None or job.status != "running":
        return
    state = read_step_states(job)["synthesis"]
    if state.dispatch_phase is Completed:
        assert complete_job(
            db,
            job_id=job.id,
            worker_id=seeded.context.worker_id,
            attempt_no=seeded.context.attempt_no,
        )
        db.commit()
        return
    if state.dispatch_phase is not Uncertain:
        raise AssertionError("Dossier claim has no closed queue transition")
    attempt_no = seeded.context.attempt_no
    while True:
        transition = fail_job(
            db,
            job_id=job.id,
            worker_id=seeded.context.worker_id,
            attempt_no=attempt_no,
            error_code="E_RECONCILIATION_REQUIRED",
            error_message="generation ownership proof completed",
            retry_delays_seconds=(),
        )
        assert transition in {"failed", "dead"}
        db.commit()
        if transition == "dead":
            return
        claimed = claim_job_row(
            db,
            job_id=job.id,
            worker_id=seeded.context.worker_id,
            lease_seconds=300,
            heavy_kinds=("dossier_build",),
            allowed_kinds=("dossier_build",),
        )
        assert claimed is not None
        attempt_no = claimed.attempts
        db.commit()


def _suspend_uncertain_generation(
    db: Session,
    *,
    kind: str,
    payload: dict[str, object],
    step_path: str,
    owner_kind: Literal["media_enrichment", "synapse_scan", "dawn_write"],
    owner_id: UUID | None,
    operation: Literal["metadata_enrichment", "synapse", "dawn_write"],
) -> tuple[JobRow, GenerationCommandDraft]:
    job = enqueue_job(db, kind=kind, payload=payload, max_attempts=1)
    worker_id = f"generation-reconciliation-{job.id}"
    claimed = claim_job_row(
        db,
        job_id=job.id,
        worker_id=worker_id,
        lease_seconds=60,
        heavy_kinds=(),
        allowed_kinds=(kind,),
    )
    assert claimed is not None
    draft = _draft(
        stable_generation_id(job.id, step_path),
        operation=operation,
    )
    state = StepReplayState(
        generation_id=draft.request_id,
        dispatch_phase=Uncertain,
        request_fingerprint=present(draft.spec.fingerprint),
        terminal_result=absent(),
    )
    suspended_payload = {
        **payload,
        "coordination": {step_path: state.model_dump(mode="json")},
    }
    assert update_running_job_payload(
        db,
        job_id=job.id,
        worker_id=worker_id,
        attempt_no=claimed.attempts,
        payload=suspended_payload,
    )
    expire_job_claim(db, job_id=job.id)
    dead = dead_letter_expired_job(db, allowed_kinds=(kind,))
    assert dead is not None and dead.id == job.id
    stage_uncertain_codex_generation(
        db,
        owner=LlmCallOwner(
            kind=owner_kind,
            id=draft.request_id if owner_id is None else owner_id,
        ),
        draft=draft,
    )
    return job, draft


def test_prove_not_dispatched_requeues_metadata_synapse_and_dawn_write(
    engine: Engine,
) -> None:
    """All three owners retain only immutable identity, never mutable prompts."""

    user_id = uuid4()
    media_id = uuid4()
    local_date = date(2026, 8, 24)
    ref = ResourceRef(scheme="media", id=media_id)
    dawn_step_path = f"generation/{user_id}/{local_date.isoformat()}"

    with Session(engine, expire_on_commit=False) as db:
        from nexus.services.bootstrap import ensure_user_and_default_library

        ensure_user_and_default_library(db, user_id, f"generation-owner-{user_id}@example.invalid")
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title="Reconciliation proof source",
                created_by_user_id=user_id,
            )
        )
        db.flush()
        metadata_job, metadata_draft = _suspend_uncertain_generation(
            db,
            kind="enrich_metadata",
            payload={"media_id": str(media_id)},
            step_path=METADATA_STEP_PATH,
            owner_kind="media_enrichment",
            owner_id=media_id,
            operation="metadata_enrichment",
        )
        synapse_job, synapse_draft = _suspend_uncertain_generation(
            db,
            kind="synapse_scan",
            payload={"user_id": str(user_id), "ref": ref.uri},
            step_path=_SYNAPSE_STEP_PATH,
            owner_kind="synapse_scan",
            owner_id=media_id,
            operation="synapse",
        )
        dawn_job, dawn_draft = _suspend_uncertain_generation(
            db,
            kind="dawn_write_job",
            payload={
                "dawn_write_worklist": [
                    {
                        "user_id": str(user_id),
                        "time_zone": "UTC",
                        "local_date": local_date.isoformat(),
                    }
                ],
            },
            step_path=dawn_step_path,
            owner_kind="dawn_write",
            owner_id=None,
            operation="dawn_write",
        )
        db.commit()

        reconciliation = ProveNotDispatched()
        reconcile_uncertain_metadata_generation(
            db,
            media_id=media_id,
            resolution=reconciliation,
        )
        reconcile_uncertain_synapse_generation(
            db,
            user_id=user_id,
            ref=ref,
            resolution=reconciliation,
        )
        reconcile_uncertain_dawn_write_generation(
            db,
            job_id=dawn_job.id,
            user_id=user_id,
            local_date=local_date,
            resolution=reconciliation,
        )

        for job_id, step_path, draft in (
            (metadata_job.id, METADATA_STEP_PATH, metadata_draft),
            (synapse_job.id, _SYNAPSE_STEP_PATH, synapse_draft),
            (dawn_job.id, dawn_step_path, dawn_draft),
        ):
            repaired = get_job(db, job_id)
            assert repaired is not None and repaired.status == "pending"
            assert read_step_states(repaired)[step_path].dispatch_phase.value == "Prepared"
            assert read_generation(db, generation_id=draft.request_id) is None


def test_synapse_terminal_noop_completes_repaired_prepared_without_ledger(
    engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Risk: a disabled replay leaves its repaired Prepared journal open."""

    user_id = uuid4()
    media_id = uuid4()
    ref = ResourceRef(scheme="media", id=media_id)
    monkeypatch.setenv("SYNAPSE_ENABLED", "false")
    clear_settings_cache()
    try:
        with Session(engine, expire_on_commit=False) as db:
            from nexus.services.bootstrap import ensure_user_and_default_library

            ensure_user_and_default_library(
                db,
                user_id,
                f"synapse-cancellation-{user_id}@example.invalid",
            )
            db.add(
                Media(
                    id=media_id,
                    kind=MediaKind.web_article.value,
                    title="Synapse cancellation source",
                    created_by_user_id=user_id,
                )
            )
            db.flush()
            job, draft = _suspend_uncertain_generation(
                db,
                kind="synapse_scan",
                payload={"user_id": str(user_id), "ref": ref.uri},
                step_path=_SYNAPSE_STEP_PATH,
                owner_kind="synapse_scan",
                owner_id=media_id,
                operation="synapse",
            )
            db.commit()
            reconcile_uncertain_synapse_generation(
                db,
                user_id=user_id,
                ref=ref,
                resolution=ProveNotDispatched(),
            )
            worker_id = f"synapse-cancellation-{job.id}"
            claimed = claim_job_row(
                db,
                job_id=job.id,
                worker_id=worker_id,
                lease_seconds=60,
                heavy_kinds=(),
                allowed_kinds=("synapse_scan",),
            )
            assert claimed is not None
            context = JobExecutionContext(
                job_id=job.id,
                worker_id=worker_id,
                attempt_no=claimed.attempts,
                resource_class="Light",
                execution_id=claimed.execution_id,
            )
            db.commit()

            result = asyncio.run(
                run_synapse_scan(
                    db,
                    user_id=user_id,
                    ref=ref,
                    context=context,
                    runtime=_NeverDispatchRuntime(),
                )
            )
            persisted = get_job(db, job.id)
            record = read_generation(db, generation_id=draft.request_id)
            assert result.status == "skipped"
            assert persisted is not None
            completed = read_step_states(persisted)[_SYNAPSE_STEP_PATH]
            assert completed.dispatch_phase is Completed
            assert isinstance(completed.terminal_result, Present)
            assert json.loads(completed.terminal_result.value) == {
                "outcome": "skipped",
                "reason": "disabled",
            }
            assert record is None
    finally:
        clear_settings_cache()


@pytest.mark.parametrize("step_path", ("synthesis", "document-repair"))
def test_dossier_generation_non_dispatch_proof_requeues_the_same_build(
    engine: Engine,
    step_path: Literal["synthesis", "document-repair"],
) -> None:
    user_id = uuid4()
    media_id = uuid4()

    with Session(engine, expire_on_commit=False) as db:
        from nexus.services.bootstrap import ensure_user_and_default_library

        ensure_user_and_default_library(
            db,
            user_id,
            f"dossier-reconciliation-{user_id}@example.invalid",
        )
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title="Dossier reconciliation source",
                created_by_user_id=user_id,
            )
        )
        head = SynthesisArtifact(
            subject_scheme="media",
            subject_id=media_id,
            audience_scheme="user",
            audience_id=str(user_id),
        )
        db.add(head)
        db.flush()
        build = ArtifactBuild(
            artifact_id=head.id,
            requester_user_id=user_id,
            instruction=None,
            idempotency_key=f"dossier-reconciliation-{uuid4()}",
        )
        db.add(build)
        db.flush()
        job = enqueue_job(
            db,
            kind="dossier_build",
            payload={"build_id": str(build.id)},
            dedupe_key=f"dossier_build:{build.id}",
            max_attempts=1,
        )
        worker_id = f"dossier-reconciliation-{job.id}"
        claimed = claim_job_row(
            db,
            job_id=job.id,
            worker_id=worker_id,
            lease_seconds=60,
            heavy_kinds=("dossier_build",),
            allowed_kinds=("dossier_build",),
        )
        assert claimed is not None
        generation_id = stable_generation_id(build.id, step_path)
        draft = _draft(generation_id, operation="dossier_media")
        uncertain = StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Uncertain,
            request_fingerprint=present(draft.spec.fingerprint),
            terminal_result=absent(),
        )
        assert update_running_job_payload(
            db,
            job_id=job.id,
            worker_id=worker_id,
            attempt_no=claimed.attempts,
            payload={
                **claimed.payload,
                "coordination": {step_path: uncertain.model_dump(mode="json")},
            },
        )
        stage_uncertain_codex_generation(
            db,
            owner=LlmCallOwner(kind="artifact_build", id=build.id),
            draft=draft,
        )
        assert (
            fail_job(
                db,
                job_id=job.id,
                worker_id=worker_id,
                attempt_no=claimed.attempts,
                error_code="E_RECONCILIATION_REQUIRED",
                error_message="accepted dossier generation is ambiguous",
                retry_delays_seconds=(),
            )
            == "dead"
        )
        db.commit()

        with pytest.raises(
            InvalidRequestError,
            match="requires immutable original command facts",
        ):
            reconcile_uncertain_build(
                db,
                build_id=build.id,
                resolution=AttachReconciledResult(
                    terminal_result='{"kind":"Accepted","envelope_json":"{}"}'
                ),
            )
        db.rollback()
        unchanged = get_job(db, job.id)
        assert unchanged is not None and unchanged.status == "dead"
        assert read_step_states(unchanged)[step_path] == uncertain

        reconcile_uncertain_build(
            db,
            build_id=build.id,
            resolution=ProveNotDispatched(),
        )

        repaired = get_job(db, job.id)
        assert repaired is not None and repaired.status == "pending"
        assert read_step_states(repaired)[step_path].dispatch_phase.value == "Prepared"
        assert read_generation(db, generation_id=generation_id) is None


@pytest.mark.parametrize("phase", ("prepared", "uncertain"))
def test_dossier_cancellation_closes_only_a_prepared_generation(
    engine: Engine,
    phase: Literal["prepared", "uncertain"],
) -> None:
    """Risk: user cancellation either strands or rewrites external work."""

    seeded = _seed_dossier_generation_owner(engine, phase=phase)
    with Session(engine, expire_on_commit=False) as db:
        cancel_build(
            db,
            build_id=seeded.build_id,
            actor_user_id=seeded.user_id,
        )

        cancellation = db.scalar(
            select(ArtifactBuildCancellation).where(
                ArtifactBuildCancellation.build_id == seeded.build_id
            )
        )
        job = get_job(db, seeded.job.id)
        record = read_generation(db, generation_id=seeded.generation_id)
        assert cancellation is not None and cancellation.actor_user_id == seeded.user_id
        assert job is not None
        state = read_step_states(job)["synthesis"]

        if phase == "prepared":
            assert state.dispatch_phase is Completed
            assert isinstance(state.terminal_result, Present)
            assert json.loads(state.terminal_result.value) == {"kind": "Cancelled"}
            assert record is None
            job_xmin, cancellation_xmin = db.execute(
                text(
                    "SELECT "
                    "(SELECT xmin::text FROM background_jobs WHERE id = :job_id), "
                    "(SELECT xmin::text FROM artifact_build_cancellations "
                    " WHERE build_id = :build_id)"
                ),
                {
                    "job_id": seeded.job.id,
                    "build_id": seeded.build_id,
                },
            ).one()
            assert job_xmin == cancellation_xmin
        else:
            assert record is not None
            assert state.dispatch_phase is Uncertain
            assert not isinstance(state.terminal_result, Present)
            assert (
                record.outcome,
                record.failure_code,
                record.terminal,
                record.completed_at,
            ) == (None, None, None, None)
            turns = read_model_turns(db, generation_id=seeded.generation_id)
            assert len(turns) == 1
            assert turns[0].dispatch_started_at is not None
            assert turns[0].terminal is None
        _close_dossier_claim(db, seeded)


def test_page_teardown_retries_the_whole_delete_when_dossier_build_membership_drifts(
    engine: Engine,
) -> None:
    """Risk: a concurrent regeneration escapes a stale destructive lock set."""

    user_id = uuid4()
    page_id = uuid4()
    with Session(engine, expire_on_commit=False) as db:
        from nexus.services.bootstrap import ensure_user_and_default_library

        ensure_user_and_default_library(
            db,
            user_id,
            f"dossier-teardown-retry-{user_id}@example.invalid",
        )
        db.add(Page(id=page_id, user_id=user_id, title="Retry-owned teardown"))
        db.commit()
        original = bootstrap_resource_dossier(
            db,
            locator=SubjectResource(ref=ResourceRef(scheme="page", id=page_id)),
            requester_user_id=user_id,
            idempotency_key=f"page-teardown-original-{uuid4()}",
            instruction=None,
        )
        cancel_build(
            db,
            build_id=original.build_id,
            actor_user_id=user_id,
        )

    def delete_page() -> None:
        with Session(engine, expire_on_commit=False) as db:
            notes.delete_page(db, user_id, page_id)

    with (
        ThreadPoolExecutor(max_workers=1) as pool,
        Session(engine, expire_on_commit=False) as blocker,
    ):
        lock_generation_owner_in_current_transaction(
            blocker,
            LlmCallOwner(kind="artifact_build", id=original.build_id),
        )
        blocker_pid = int(blocker.scalar(text("SELECT pg_backend_pid()")))
        deletion = pool.submit(delete_page)
        _await_backend_blocked_by(engine, blocking_pid=blocker_pid)
        assert not deletion.done()

        with Session(engine, expire_on_commit=False) as db:
            regenerated = regenerate_artifact(
                db,
                artifact_id=original.artifact_id,
                requester_user_id=user_id,
                idempotency_key=f"page-teardown-regenerated-{uuid4()}",
                instruction=None,
            )
        blocker.commit()
        deletion.result(timeout=10)

    with Session(engine, expire_on_commit=False) as db:
        assert db.get(Page, page_id) is None
        assert db.get(SynthesisArtifact, original.artifact_id) is None
        assert db.get(ArtifactBuild, original.build_id) is None
        assert db.get(ArtifactBuild, regenerated.build_id) is None
        assert (
            db.scalar(
                text(
                    "SELECT count(*) FROM background_jobs "
                    "WHERE kind = 'dossier_build' "
                    "AND dedupe_key = :dedupe_key"
                ),
                {"dedupe_key": f"dossier_build:{regenerated.build_id}"},
            )
            == 0
        )


def test_dossier_subject_teardown_closes_prepared_and_preserves_uncertain_generation(
    engine: Engine,
) -> None:
    """Risk: hard purge either strands Prepared work or destroys armed evidence."""

    prepared = _seed_dossier_generation_owner(engine, phase="prepared")
    with Session(engine, expire_on_commit=False) as db:
        on_subject_deleted(db, prepared.subject_ref)
        db.commit()

    with Session(engine, expire_on_commit=False) as db:
        assert db.get(SynthesisArtifact, prepared.artifact_id) is None
        assert db.get(ArtifactBuild, prepared.build_id) is None
        assert get_job(db, prepared.job.id) is None
        assert read_generation(db, generation_id=prepared.generation_id) is None

    uncertain = _seed_dossier_generation_owner(engine, phase="uncertain")
    with Session(engine, expire_on_commit=False) as db:
        with pytest.raises(GenerationUncertain, match="cannot purge uncertain Dossier generation"):
            on_subject_deleted(db, uncertain.subject_ref)
        db.rollback()

    with Session(engine, expire_on_commit=False) as db:
        assert db.get(SynthesisArtifact, uncertain.artifact_id) is not None
        assert db.get(ArtifactBuild, uncertain.build_id) is not None
        job = get_job(db, uncertain.job.id)
        assert job is not None
        state = read_step_states(job)["synthesis"]
        assert state.dispatch_phase is Uncertain
        assert not isinstance(state.terminal_result, Present)
        record = read_generation(db, generation_id=uncertain.generation_id)
        assert record is not None
        assert (
            record.outcome,
            record.failure_code,
            record.terminal,
            record.completed_at,
        ) == (None, None, None, None)
        turns = read_model_turns(db, generation_id=uncertain.generation_id)
        assert len(turns) == 1 and turns[0].dispatch_started_at is not None
        assert turns[0].terminal is None
        _close_dossier_claim(db, uncertain)


def test_dossier_modeled_failure_closes_prepared_generation_in_the_same_transaction(
    engine: Engine,
) -> None:
    """Risk: a pre-dispatch Dossier failure leaves its job journal open."""

    seeded = _seed_dossier_generation_owner(engine, phase="prepared")
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=create_session_factory(engine)))
    try:
        with Session(engine, expire_on_commit=False) as db:
            job = get_job(db, seeded.job.id)
            assert job is not None
            result = asyncio.run(
                run_build(
                    db,
                    build_id=seeded.build_id,
                    ctx=seeded.context,
                    runtime=DossierBuildRuntime(
                        build_id=seeded.build_id,
                        artifact_id=seeded.artifact_id,
                        job=job,
                        execution_context=seeded.context,
                        llm_runtime=_NeverDossierDispatchRuntime(),
                        research_tool_operation=compose_dossier_tool_runtime(None).operations[
                            "idea_dossier_research"
                        ],
                        settings=get_settings(),
                    ),
                )
            )
            assert result is None

        with Session(engine, expire_on_commit=False) as db:
            failure = db.scalar(
                select(ArtifactBuildFailure).where(ArtifactBuildFailure.build_id == seeded.build_id)
            )
            job = get_job(db, seeded.job.id)
            record = read_generation(db, generation_id=seeded.generation_id)
            assert failure is not None and failure.failure_code == "NoSourceMaterial"
            assert job is not None
            state = read_step_states(job)["synthesis"]
            assert state.dispatch_phase is Completed
            assert isinstance(state.terminal_result, Present)
            assert json.loads(state.terminal_result.value) == {"kind": "Cancelled"}
            assert record is None
            job_xmin, failure_xmin = db.execute(
                text(
                    "SELECT "
                    "(SELECT xmin::text FROM background_jobs WHERE id = :job_id), "
                    "(SELECT xmin::text FROM artifact_build_failures "
                    " WHERE build_id = :build_id)"
                ),
                {
                    "job_id": seeded.job.id,
                    "build_id": seeded.build_id,
                },
            ).one()
            assert job_xmin == failure_xmin
            _close_dossier_claim(db, seeded)
    finally:
        set_rate_limiter(previous_limiter)


def test_prove_not_dispatched_releases_abandoned_request_scoped_idea_resolution(
    engine: Engine,
) -> None:
    user_id = uuid4()
    media_id = uuid4()
    highlight_id = uuid4()

    with Session(engine, expire_on_commit=False) as db:
        from nexus.services.bootstrap import ensure_user_and_default_library

        ensure_user_and_default_library(
            db, user_id, f"idea-reconciliation-{user_id}@example.invalid"
        )
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title="Idea reconciliation source",
                created_by_user_id=user_id,
            )
        )
        db.flush()
        db.add(
            Highlight(
                id=highlight_id,
                user_id=user_id,
                anchor_kind="fragment_offsets",
                anchor_media_id=media_id,
                color="yellow",
                exact="bounded rationality",
                prefix="",
                suffix="",
            )
        )
        db.flush()
        request = learn_service.reserve_learn_request(
            db,
            user_id=user_id,
            highlight_id=highlight_id,
            idempotency_key=f"idea-reconciliation-{uuid4()}",
            initial_coordination={},
        )
        assert isinstance(request, learn_service.PendingLearnRequest)
        step_path = "idea-resolution"
        generation_id = stable_generation_id(request.request_id, step_path)
        draft = _draft(generation_id, operation="dossier_idea_resolve")
        uncertain = StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Uncertain,
            request_fingerprint=present(draft.spec.fingerprint),
            terminal_result=absent(),
        )
        learn_service.checkpoint_learn_coordination(
            db,
            request_id=request.request_id,
            coordination={step_path: uncertain.model_dump(mode="json")},
        )
        expire_artifact_learn_resolver_lease(
            db,
            request_id=request.request_id,
        )
        stage_uncertain_codex_generation(
            db,
            owner=LlmCallOwner(
                kind="artifact_learn_request",
                id=request.request_id,
            ),
            draft=draft,
        )
        db.commit()

        reconcile_uncertain_idea_resolution(
            db,
            request_id=request.request_id,
            requester_user_id=user_id,
            resolution=ProveNotDispatched(),
        )

        db.expire_all()
        row = db.get(ArtifactLearnRequest, request.request_id)
        assert row is not None and row.resolver_lease_expires_at is None
        state = decode_step_states({"coordination": row.coordination})[step_path]
        assert state.dispatch_phase.value == "Prepared"
        assert read_generation(db, generation_id=generation_id) is None
