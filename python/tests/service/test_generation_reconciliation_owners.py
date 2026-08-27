"""Proof that non-prompt-persisting owners recover only known non-dispatches."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date
from typing import Literal
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, select, text
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
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
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    claim_job,
    complete_job,
    dead_letter_expired_job,
    enqueue_job,
    fail_job,
    find_nonterminal_jobs_for_payload,
    get_job,
    update_running_job_payload,
)
from nexus.schemas.presence import Present, absent, present
from nexus.services import generation_policy, library_entries, notes
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
    GenerationCommand,
    GenerationFrame,
    GenerationHealth,
    request_fingerprint,
)
from nexus.services.dawn_write import reconcile_uncertain_dawn_write_generation
from nexus.services.durable_step_journal import (
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
from nexus.services.llm_execution import ExecutionRuntime, GenerationUncertain
from nexus.services.llm_ledger import (
    GenerationStart,
    LlmCallOwner,
    lock_generation_owner_in_current_transaction,
    read_generation,
    start_generation_in_current_transaction,
)
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.structured_synthesis import build_synthesis_intent
from nexus.services.synapse import reconcile_uncertain_synapse_generation, run_synapse_scan
from nexus.tasks.artifacts import compose_dossier_tool_runtime
from nexus.tasks.enrich_metadata import METADATA_STEP_PATH, reconcile_uncertain_metadata_generation
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


class _NeverDispatchRuntime(ExecutionRuntime):
    async def health(self) -> GenerationHealth:
        raise AssertionError("terminal Synapse no-op reached host health")

    def stream(self, command: GenerationCommand) -> AsyncIterator[GenerationFrame]:
        del command
        raise AssertionError("terminal Synapse no-op dispatched")

    async def cancel(self, request_id: UUID) -> None:
        del request_id
        raise AssertionError("terminal Synapse no-op cancelled a host turn")


class _NeverDossierDispatchRuntime(ExecutionRuntime):
    async def health(self) -> GenerationHealth:
        raise AssertionError("preaccept Dossier terminalization reached host health")

    def stream(self, command: GenerationCommand) -> AsyncIterator[GenerationFrame]:
        del command
        raise AssertionError("preaccept Dossier terminalization dispatched")

    async def cancel(self, request_id: UUID) -> None:
        del request_id
        raise AssertionError("preaccept Dossier terminalization cancelled a host turn")


@dataclass(frozen=True, slots=True)
class _DossierGenerationOwner:
    user_id: UUID
    subject_ref: ResourceRef
    artifact_id: UUID
    build_id: UUID
    job: JobRow
    context: JobExecutionContext
    generation_id: UUID


def _command(
    generation_id: UUID,
    *,
    operation: Literal[
        "metadata_enrichment",
        "synapse",
        "dawn_write",
        "dossier_media",
    ],
) -> GenerationCommand:
    return GenerationCommand.model_validate(
        {
            "schema_version": "nexus-generation-command.v2",
            "request_id": generation_id,
            "operation": {
                "kind": operation,
                "revision": generation_policy.operation_revision(operation),
            },
            "policy_revision": generation_policy.POLICY_REVISION,
            "policy_fingerprint": generation_policy.POLICY_FINGERPRINT,
            "intent": {
                "instructions": "Return one bounded result.",
                "input": "durable reconciliation proof",
                "output": {"kind": "Text"},
            },
        }
    )


def _seed_dossier_generation_owner(
    engine: Engine,
    *,
    phase: Literal["prepared", "uncertain"],
    retained_start: bool = True,
) -> _DossierGenerationOwner:
    if phase == "uncertain" and not retained_start:
        raise ValueError("an Uncertain generation requires its retained ledger start")
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
        claimed = claim_job(
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
        )
        generation_id = stable_generation_id(ticket.build_id, "synthesis")
        command = _command(
            generation_id,
            operation="dossier_media",
        )
        uncertain = StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Uncertain,
            request_fingerprint=present(request_fingerprint(command)),
            terminal_result=absent(),
        )
        prepared = uncertain.model_copy(update={"dispatch_phase": Prepared})
        assert update_running_job_payload(
            db,
            job_id=claimed.id,
            worker_id=worker_id,
            attempt_no=claimed.attempts,
            payload=payload_with_step_state(
                claimed.payload,
                step_path="synthesis",
                state=uncertain if retained_start else prepared,
            ),
        )
        if retained_start:
            start_generation_in_current_transaction(
                db,
                GenerationStart(
                    owner=LlmCallOwner(kind="artifact_build", id=ticket.build_id),
                    command=command,
                    streaming=True,
                ),
            )
        db.commit()

        if phase == "prepared" and retained_start:
            current = get_job(db, claimed.id)
            assert current is not None
            assert update_running_job_payload(
                db,
                job_id=claimed.id,
                worker_id=worker_id,
                attempt_no=claimed.attempts,
                payload=payload_with_step_state(
                    current.payload,
                    step_path="synthesis",
                    state=prepared,
                ),
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


def _close_retained_dossier_claim(db: Session, seeded: _DossierGenerationOwner) -> None:
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
        )
        db.commit()
        return
    if state.dispatch_phase is not Uncertain:
        raise AssertionError("retained Dossier claim has no closed queue transition")
    while True:
        transition = fail_job(
            db,
            job_id=job.id,
            worker_id=seeded.context.worker_id,
            error_code="E_RECONCILIATION_REQUIRED",
            error_message="retained generation proof completed",
            retry_delays_seconds=(),
        )
        assert transition in {"failed", "dead"}
        db.commit()
        if transition == "dead":
            return
        claimed = claim_job(
            db,
            job_id=job.id,
            worker_id=seeded.context.worker_id,
            lease_seconds=300,
            heavy_kinds=("dossier_build",),
            allowed_kinds=("dossier_build",),
        )
        assert claimed is not None
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
) -> tuple[JobRow, GenerationCommand]:
    job = enqueue_job(db, kind=kind, payload=payload, max_attempts=1)
    worker_id = f"generation-reconciliation-{job.id}"
    claimed = claim_job(
        db,
        job_id=job.id,
        worker_id=worker_id,
        lease_seconds=60,
        heavy_kinds=(),
        allowed_kinds=(kind,),
    )
    assert claimed is not None
    command = _command(
        stable_generation_id(job.id, step_path),
        operation=operation,
    )
    state = StepReplayState(
        generation_id=command.request_id,
        dispatch_phase=Uncertain,
        request_fingerprint=present(request_fingerprint(command)),
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
    start_generation_in_current_transaction(
        db,
        GenerationStart(
            owner=LlmCallOwner(
                kind=owner_kind,
                id=command.request_id if owner_id is None else owner_id,
            ),
            command=command,
            streaming=False,
        ),
    )
    return job, command


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
        metadata_job, metadata_command = _suspend_uncertain_generation(
            db,
            kind="enrich_metadata",
            payload={"media_id": str(media_id), "capacity_wait_index": 0},
            step_path=METADATA_STEP_PATH,
            owner_kind="media_enrichment",
            owner_id=media_id,
            operation="metadata_enrichment",
        )
        synapse_job, synapse_command = _suspend_uncertain_generation(
            db,
            kind="synapse_scan",
            payload={"user_id": str(user_id), "ref": ref.uri, "capacity_wait_index": 0},
            step_path=_SYNAPSE_STEP_PATH,
            owner_kind="synapse_scan",
            owner_id=media_id,
            operation="synapse",
        )
        dawn_job, dawn_command = _suspend_uncertain_generation(
            db,
            kind="dawn_write_job",
            payload={
                "capacity_wait_index": 0,
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

        for job_id, step_path, command in (
            (metadata_job.id, METADATA_STEP_PATH, metadata_command),
            (synapse_job.id, _SYNAPSE_STEP_PATH, synapse_command),
            (dawn_job.id, dawn_step_path, dawn_command),
        ):
            repaired = get_job(db, job_id)
            assert repaired is not None and repaired.status == "pending"
            assert read_step_states(repaired)[step_path].dispatch_phase.value == "Prepared"
            record = read_generation(db, generation_id=command.request_id)
            assert record is not None and record.outcome is None


def test_synapse_terminal_noop_cancels_a_retained_preaccept_start(
    engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Risk: a disabled replay completes its job beside an open generation ledger."""

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
            job, command = _suspend_uncertain_generation(
                db,
                kind="synapse_scan",
                payload={"user_id": str(user_id), "ref": ref.uri, "capacity_wait_index": 0},
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
            claimed = claim_job(
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
            record = read_generation(db, generation_id=command.request_id)
            assert result.status == "skipped"
            assert persisted is not None
            completed = read_step_states(persisted)[_SYNAPSE_STEP_PATH]
            assert completed.dispatch_phase is Completed
            assert isinstance(completed.terminal_result, Present)
            assert json.loads(completed.terminal_result.value) == {
                "outcome": "skipped",
                "reason": "disabled",
            }
            assert record is not None and record.outcome == "Cancelled"
    finally:
        clear_settings_cache()


def test_dossier_generation_non_dispatch_proof_requeues_the_same_build(
    engine: Engine,
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
            payload={"build_id": str(build.id), "capacity_wait_index": 0},
            dedupe_key=f"dossier_build:{build.id}",
            max_attempts=1,
        )
        worker_id = f"dossier-reconciliation-{job.id}"
        claimed = claim_job(
            db,
            job_id=job.id,
            worker_id=worker_id,
            lease_seconds=60,
            heavy_kinds=("dossier_build",),
            allowed_kinds=("dossier_build",),
        )
        assert claimed is not None
        step_path = "synthesis"
        generation_id = stable_generation_id(build.id, step_path)
        command = _command(generation_id, operation="dossier_media")
        uncertain = StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Uncertain,
            request_fingerprint=present(request_fingerprint(command)),
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
        start_generation_in_current_transaction(
            db,
            GenerationStart(
                owner=LlmCallOwner(kind="artifact_build", id=build.id),
                command=command,
                streaming=True,
            ),
        )
        assert (
            fail_job(
                db,
                job_id=job.id,
                worker_id=worker_id,
                error_code="E_RECONCILIATION_REQUIRED",
                error_message="accepted dossier generation is ambiguous",
                retry_delays_seconds=(),
            )
            == "dead"
        )
        db.commit()

        reconcile_uncertain_build(
            db,
            build_id=build.id,
            resolution=ProveNotDispatched(),
        )

        repaired = get_job(db, job.id)
        assert repaired is not None and repaired.status == "pending"
        assert read_step_states(repaired)[step_path].dispatch_phase.value == "Prepared"
        record = read_generation(db, generation_id=generation_id)
        assert record is not None and record.outcome is None


@pytest.mark.parametrize(
    ("phase", "retained_start"),
    [
        pytest.param("prepared", True, id="prepared-retained-start"),
        pytest.param("prepared", False, id="prepared-before-first-start"),
        pytest.param("uncertain", True, id="uncertain-retained-start"),
    ],
)
def test_dossier_cancellation_closes_only_a_prepared_generation(
    engine: Engine,
    phase: Literal["prepared", "uncertain"],
    retained_start: bool,
) -> None:
    """Risk: user cancellation either strands or rewrites external work."""

    seeded = _seed_dossier_generation_owner(
        engine,
        phase=phase,
        retained_start=retained_start,
    )
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
            if not retained_start:
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
                _close_retained_dossier_claim(db, seeded)
                return
            assert record is not None
            assert (
                record.outcome,
                record.error_code,
                record.session_ref,
                record.accepted_at,
                record.sdk_version,
                record.runtime_version,
                record.latency_ms,
                record.input_tokens,
                record.output_tokens,
                record.total_tokens,
            ) == ("Cancelled", None, None, None, None, None, None, None, None, None)
            assert record.error_detail == "dossier build was cancelled before host acceptance"
            assert record.completed_at is not None
            ledger_xmin, job_xmin, cancellation_xmin = db.execute(
                text(
                    "SELECT "
                    "(SELECT xmin::text FROM llm_calls WHERE id = :generation_id), "
                    "(SELECT xmin::text FROM background_jobs WHERE id = :job_id), "
                    "(SELECT xmin::text FROM artifact_build_cancellations "
                    " WHERE build_id = :build_id)"
                ),
                {
                    "generation_id": seeded.generation_id,
                    "job_id": seeded.job.id,
                    "build_id": seeded.build_id,
                },
            ).one()
            assert ledger_xmin == job_xmin == cancellation_xmin
        else:
            assert record is not None
            assert state.dispatch_phase is Uncertain
            assert not isinstance(state.terminal_result, Present)
            assert (
                record.outcome,
                record.error_code,
                record.error_detail,
                record.accepted_at,
                record.completed_at,
            ) == (None, None, None, None, None)
        _close_retained_dossier_claim(db, seeded)


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
    """Risk: hard purge either strands Prepared work or destroys ambiguous evidence."""

    prepared = _seed_dossier_generation_owner(engine, phase="prepared")
    with Session(engine, expire_on_commit=False) as db:
        on_subject_deleted(db, prepared.subject_ref)
        teardown_xid = str(db.execute(text("SELECT txid_current()::text")).scalar_one())
        db.commit()

    with Session(engine, expire_on_commit=False) as db:
        assert db.get(SynthesisArtifact, prepared.artifact_id) is None
        assert db.get(ArtifactBuild, prepared.build_id) is None
        assert get_job(db, prepared.job.id) is None
        record = read_generation(db, generation_id=prepared.generation_id)
        assert record is not None
        assert (
            record.outcome,
            record.error_code,
            record.session_ref,
            record.accepted_at,
            record.sdk_version,
            record.runtime_version,
        ) == ("Cancelled", None, None, None, None, None)
        assert record.error_detail == "dossier build was purged before host acceptance"
        ledger_xmin = db.execute(
            text("SELECT xmin::text FROM llm_calls WHERE id = :generation_id"),
            {"generation_id": prepared.generation_id},
        ).scalar_one()
        assert ledger_xmin == teardown_xid

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
            record.error_code,
            record.error_detail,
            record.accepted_at,
            record.completed_at,
        ) == (None, None, None, None, None)
        _close_retained_dossier_claim(db, uncertain)


def test_dossier_modeled_failure_closes_prepared_generation_in_the_same_transaction(
    engine: Engine,
) -> None:
    """Risk: a pre-dispatch Dossier failure leaves a retained ledger start open."""

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
            assert record is not None
            assert (
                record.outcome,
                record.error_code,
                record.session_ref,
                record.accepted_at,
                record.sdk_version,
                record.runtime_version,
            ) == ("Cancelled", None, None, None, None, None)
            assert record.error_detail == "dossier build terminalized before host acceptance"
            assert record.completed_at is not None
            ledger_xmin, job_xmin, failure_xmin = db.execute(
                text(
                    "SELECT "
                    "(SELECT xmin::text FROM llm_calls WHERE id = :generation_id), "
                    "(SELECT xmin::text FROM background_jobs WHERE id = :job_id), "
                    "(SELECT xmin::text FROM artifact_build_failures "
                    " WHERE build_id = :build_id)"
                ),
                {
                    "generation_id": seeded.generation_id,
                    "job_id": seeded.job.id,
                    "build_id": seeded.build_id,
                },
            ).one()
            assert ledger_xmin == job_xmin == failure_xmin
            _close_retained_dossier_claim(db, seeded)
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
        command = GenerationCommand.model_validate(
            {
                "request_id": generation_id,
                "operation": {
                    "kind": "dossier_idea_resolve",
                    "revision": generation_policy.operation_revision("dossier_idea_resolve"),
                },
                "policy_revision": generation_policy.POLICY_REVISION,
                "policy_fingerprint": generation_policy.POLICY_FINGERPRINT,
                "intent": build_synthesis_intent(
                    system_prompt="Resolve one selected phrase.",
                    user_content="bounded rationality",
                    schema=learn_service.IdeaResolverEnvelope,
                ),
            }
        )
        uncertain = StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Uncertain,
            request_fingerprint=present(request_fingerprint(command)),
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
        start_generation_in_current_transaction(
            db,
            GenerationStart(
                owner=LlmCallOwner(
                    kind="artifact_learn_request",
                    id=request.request_id,
                ),
                command=command,
                streaming=False,
            ),
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
        record = read_generation(db, generation_id=generation_id)
        assert record is not None and record.outcome is None
