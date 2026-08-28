from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Literal, assert_never
from uuid import uuid4

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import Media, MediaKind, MediaSourceAttempt, ProcessingStatus
from nexus.db.session import create_session_factory
from nexus.jobs.queue import (
    PERIODIC_PRIORITY_RECONCILIATION_LIMIT,
    claim_job,
    claim_next_job,
    complete_job,
    enqueue_job,
    fail_job,
    update_running_job_payload,
)
from nexus.jobs.registry import get_default_registry, periodic_dedupe_key, periodic_slot_start
from nexus.jobs.worker import JobWorker
from nexus.runtime_health import is_database_ready
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.ingest_recovery import get_ingest_recovery_health
from tests.testkit.unreachable_state import (
    age_completed_job,
    delete_jobs_by_ids,
    delete_jobs_of_kinds,
    delete_source_attempt_and_media,
    expire_job_claim,
    make_pending_job_due,
)


def test_deployed_database_readiness_requires_the_latest_reconciler_to_succeed_freshly(
    engine: Engine,
) -> None:
    with engine.connect() as connection:
        revision = str(
            connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
        )
    session_factory = create_session_factory(engine)
    future = datetime.now(UTC) + timedelta(days=1)
    with session_factory() as db:
        delete_jobs_of_kinds(db, kinds=("reconcile_stale_ingest_media_job",))
        job = enqueue_job(
            db,
            kind="reconcile_stale_ingest_media_job",
            payload={"request_id": "readiness-proof"},
            max_attempts=1,
            available_at=future,
        )
        db.commit()

    assert not is_database_ready(
        database_url=get_settings().database_url,
        expected_revision=revision,
        reconciler_max_age_seconds=120,
    )

    with session_factory() as db:
        make_pending_job_due(db, job_id=job.id)
        claimed = claim_job(
            db,
            job_id=job.id,
            worker_id="readiness-proof-worker",
            lease_seconds=30,
            allowed_kinds=("reconcile_stale_ingest_media_job",),
            heavy_kinds=(),
        )
        assert claimed is not None
        assert complete_job(
            db,
            job_id=job.id,
            worker_id="readiness-proof-worker",
        )
        db.commit()

    assert is_database_ready(
        database_url=get_settings().database_url,
        expected_revision=revision,
        reconciler_max_age_seconds=120,
    )

    with session_factory() as db:
        next_job = enqueue_job(
            db,
            kind="reconcile_stale_ingest_media_job",
            payload={"request_id": "readiness-next-cycle"},
            max_attempts=1,
            available_at=future,
        )
        db.commit()

    assert is_database_ready(
        database_url=get_settings().database_url,
        expected_revision=revision,
        reconciler_max_age_seconds=120,
    ), "a fresh last-success must keep readiness stable while the next cycle is pending"

    age_completed_job(engine, job_id=job.id, seconds=121)

    assert not is_database_ready(
        database_url=get_settings().database_url,
        expected_revision=revision,
        reconciler_max_age_seconds=120,
    )
    with session_factory() as db:
        delete_jobs_by_ids(db, job_ids=(job.id, next_job.id))
        db.commit()


def test_ingest_health_uses_last_success_while_pending_and_surfaces_later_dead_cycle(
    engine: Engine,
) -> None:
    session_factory = create_session_factory(engine)
    future = datetime.now(UTC) + timedelta(days=1)
    created_job_ids = []
    try:
        with session_factory() as db:
            delete_jobs_of_kinds(db, kinds=("reconcile_stale_ingest_media_job",))
            succeeded = enqueue_job(
                db,
                kind="reconcile_stale_ingest_media_job",
                payload={"request_id": "operator-health-success"},
                max_attempts=1,
                available_at=future,
            )
            created_job_ids.append(succeeded.id)
            db.commit()
            make_pending_job_due(db, job_id=succeeded.id)
            claimed = claim_job(
                db,
                job_id=succeeded.id,
                worker_id="operator-health-success-worker",
                lease_seconds=30,
                allowed_kinds=("reconcile_stale_ingest_media_job",),
                heavy_kinds=(),
            )
            assert claimed is not None
            assert complete_job(
                db,
                job_id=succeeded.id,
                worker_id="operator-health-success-worker",
            )
            pending = enqueue_job(
                db,
                kind="reconcile_stale_ingest_media_job",
                payload={"request_id": "operator-health-next-pending"},
                max_attempts=1,
                available_at=future,
            )
            created_job_ids.append(pending.id)
            db.commit()

            pending_health = get_ingest_recovery_health(db)
            assert pending_health["latest_reconciler_succeeded"] is True
            assert pending_health["latest_reconciler_age_seconds"].kind == "Present"

            failed = enqueue_job(
                db,
                kind="reconcile_stale_ingest_media_job",
                payload={"request_id": "operator-health-later-dead"},
                max_attempts=1,
                available_at=future,
            )
            created_job_ids.append(failed.id)
            db.commit()
            make_pending_job_due(db, job_id=failed.id)
            claimed_failed = claim_job(
                db,
                job_id=failed.id,
                worker_id="operator-health-failed-worker",
                lease_seconds=30,
                allowed_kinds=("reconcile_stale_ingest_media_job",),
                heavy_kinds=(),
            )
            assert claimed_failed is not None
            assert (
                fail_job(
                    db,
                    job_id=failed.id,
                    worker_id="operator-health-failed-worker",
                    error_code="E_RECONCILE_PROBE",
                    error_message="later completed cycle failed",
                    retry_delays_seconds=(),
                )
                == "dead"
            )
            db.commit()

            failed_health = get_ingest_recovery_health(db)
            assert failed_health["latest_reconciler_succeeded"] is False
            assert failed_health["latest_reconciler_age_seconds"].kind == "Present"
            assert failed_health["degraded"] is True
    finally:
        with session_factory() as cleanup:
            delete_jobs_by_ids(cleanup, job_ids=tuple(created_job_ids))
            cleanup.commit()


def test_deployed_readiness_requires_one_exact_owned_nonsucceeded_source_job(
    engine: Engine,
) -> None:
    with engine.connect() as connection:
        revision = str(
            connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
        )
    viewer_id = uuid4()
    media_id = uuid4()
    attempt_id = uuid4()
    exact_job_ids = []
    reconciler_job_id = None
    future = datetime.now(UTC) + timedelta(days=1)
    try:
        with Session(engine) as db:
            ensure_user_and_default_library(
                db,
                viewer_id,
                f"readiness-owner-{viewer_id}@example.invalid",
            )
            media = Media(
                id=media_id,
                kind=MediaKind.pdf.value,
                title="Readiness owner proof",
                processing_status=ProcessingStatus.extracting,
                created_by_user_id=viewer_id,
            )
            db.add(media)
            db.add(
                MediaSourceAttempt(
                    id=attempt_id,
                    media_id=media_id,
                    created_by_user_id=viewer_id,
                    source_type="uploaded_pdf_file",
                    attempt_no=1,
                    run_count=0,
                    status="accepted",
                    intent_key=f"readiness:{attempt_id}",
                    processing_stage="Accepted",
                )
            )
            reconciler = enqueue_job(
                db,
                kind="reconcile_stale_ingest_media_job",
                payload={"request_id": "readiness-owner-proof"},
                max_attempts=1,
                available_at=future,
            )
            reconciler_job_id = reconciler.id
            db.commit()
            make_pending_job_due(db, job_id=reconciler.id)
            claimed_reconciler = claim_job(
                db,
                job_id=reconciler.id,
                worker_id="readiness-owner-worker",
                lease_seconds=30,
                allowed_kinds=("reconcile_stale_ingest_media_job",),
                heavy_kinds=(),
            )
            assert claimed_reconciler is not None
            assert complete_job(
                db,
                job_id=reconciler.id,
                worker_id="readiness-owner-worker",
            )
            db.commit()

        assert not is_database_ready(
            database_url=get_settings().database_url,
            expected_revision=revision,
            reconciler_max_age_seconds=120,
        ), "an in-flight source attempt without its exact owned job is a readiness defect"

        with Session(engine) as db:
            exact = enqueue_job(
                db,
                kind="ingest_media_source",
                payload={"media_id": str(media_id), "attempt_id": str(attempt_id)},
                max_attempts=1,
                available_at=future,
            )
            exact_job_ids.append(exact.id)
            attempt = db.get(MediaSourceAttempt, attempt_id)
            assert attempt is not None
            attempt.job_id = exact.id
            db.commit()

        assert is_database_ready(
            database_url=get_settings().database_url,
            expected_revision=revision,
            reconciler_max_age_seconds=120,
        )

        with Session(engine) as db:
            make_pending_job_due(db, job_id=exact.id)
            claimed_exact = claim_job(
                db,
                job_id=exact.id,
                worker_id="readiness-source-worker",
                lease_seconds=30,
                allowed_kinds=("ingest_media_source",),
                heavy_kinds=("ingest_media_source",),
            )
            assert claimed_exact is not None
            assert complete_job(db, job_id=exact.id, worker_id="readiness-source-worker")
            db.commit()

        assert not is_database_ready(
            database_url=get_settings().database_url,
            expected_revision=revision,
            reconciler_max_age_seconds=120,
        ), "a succeeded job cannot own an attempt that still claims to be in flight"

        with Session(engine) as db:
            attempt = db.get(MediaSourceAttempt, attempt_id)
            assert attempt is not None
            attempt.job_id = None
            db.flush()
            delete_jobs_by_ids(db, job_ids=(exact.id,))
            dead = enqueue_job(
                db,
                kind="ingest_media_source",
                payload={"media_id": str(media_id), "attempt_id": str(attempt_id)},
                max_attempts=1,
                available_at=future,
            )
            exact_job_ids.append(dead.id)
            attempt.job_id = dead.id
            db.commit()
            make_pending_job_due(db, job_id=dead.id)
            claimed_dead = claim_job(
                db,
                job_id=dead.id,
                worker_id="readiness-dead-worker",
                lease_seconds=30,
                allowed_kinds=("ingest_media_source",),
                heavy_kinds=("ingest_media_source",),
            )
            assert claimed_dead is not None
            assert (
                fail_job(
                    db,
                    job_id=dead.id,
                    worker_id="readiness-dead-worker",
                    error_code="E_RESOURCE_LIMIT",
                    error_message="bounded",
                    retry_delays_seconds=(),
                )
                == "dead"
            )
            db.commit()

        assert is_database_ready(
            database_url=get_settings().database_url,
            expected_revision=revision,
            reconciler_max_age_seconds=120,
        ), "a dead exact job remains the durable owner of its failed-but-unprojected attempt"

        with Session(engine) as db:
            duplicate = enqueue_job(
                db,
                kind="ingest_media_source",
                payload={"media_id": str(media_id), "attempt_id": str(attempt_id)},
                max_attempts=1,
                available_at=future,
            )
            exact_job_ids.append(duplicate.id)
            db.commit()
            make_pending_job_due(db, job_id=duplicate.id)
            claimed_duplicate = claim_job(
                db,
                job_id=duplicate.id,
                worker_id="readiness-succeeded-worker",
                lease_seconds=30,
                allowed_kinds=("ingest_media_source",),
                heavy_kinds=("ingest_media_source",),
            )
            assert claimed_duplicate is not None
            assert complete_job(
                db,
                job_id=duplicate.id,
                worker_id="readiness-succeeded-worker",
                result_payload={"kind": "UnexpectedDuplicateSuccess"},
            )
            db.commit()

        assert not is_database_ready(
            database_url=get_settings().database_url,
            expected_revision=revision,
            reconciler_max_age_seconds=120,
        ), "a linked dead job plus a second succeeded exact job is a readiness defect"
    finally:
        with Session(engine) as cleanup:
            delete_source_attempt_and_media(
                cleanup,
                attempt_id=attempt_id,
                media_id=media_id,
            )
            delete_jobs_by_ids(
                cleanup,
                job_ids=tuple(value for value in (*exact_job_ids, reconciler_job_id) if value),
            )
            cleanup.commit()


def test_reconciler_scheduler_priority_preempts_older_ordinary_background_backlog(
    engine: Engine,
) -> None:
    session_factory = create_session_factory(engine)
    production_definition = get_default_registry()["reconcile_stale_ingest_media_job"]
    assert production_definition.periodic_priority == -1000
    definition = replace(
        production_definition,
        kind="reconciler_priority_schedule_probe",
    )
    backlog_kind = "reconciler_priority_backlog_probe"
    created_job_ids = []
    worker_id = "reconciler-priority-proof"
    try:
        with session_factory() as db:
            backlog = enqueue_job(
                db,
                kind=backlog_kind,
                payload={"probe": "older-ordinary-backlog"},
                priority=100,
            )
            created_job_ids.append(backlog.id)
            db.commit()

        worker = JobWorker(
            session_factory=session_factory,
            worker_id=worker_id,
            registry={definition.kind: definition},
            allowed_kinds=(definition.kind,),
        )
        assert worker.run_scheduler_once(now=datetime(2020, 1, 1, tzinfo=UTC)) == 1

        with session_factory() as db:
            claimed = claim_next_job(
                db,
                worker_id=worker_id,
                lease_seconds=30,
                allowed_kinds=(backlog_kind, definition.kind),
                heavy_kinds=(),
            )
            assert claimed is not None
            created_job_ids.append(claimed.id)
            assert claimed.kind == definition.kind
            assert claimed.priority == definition.periodic_priority
            assert complete_job(db, job_id=claimed.id, worker_id=worker_id)
            db.commit()
    finally:
        with session_factory() as cleanup:
            delete_jobs_by_ids(cleanup, job_ids=tuple(created_job_ids))
            cleanup.commit()


def test_default_periodic_work_yields_to_new_ordinary_background_work(
    engine: Engine,
) -> None:
    session_factory = create_session_factory(engine)
    definition = replace(
        get_default_registry()["podcast_refresh_due_job"],
        kind="periodic_fairness_schedule_probe",
    )
    ordinary_kind = "periodic_fairness_ordinary_probe"
    created_job_ids = []
    worker_id = "periodic-fairness-proof"
    try:
        with session_factory() as db:
            ordinary = enqueue_job(
                db,
                kind=ordinary_kind,
                payload={"probe": "new-ordinary-work"},
            )
            created_job_ids.append(ordinary.id)
            db.commit()

        worker = JobWorker(
            session_factory=session_factory,
            worker_id=worker_id,
            registry={definition.kind: definition},
            allowed_kinds=(definition.kind,),
        )
        assert worker.run_scheduler_once(now=datetime(2020, 1, 1, tzinfo=UTC)) == 1

        with session_factory() as db:
            scheduled_id = db.scalar(
                text("SELECT id FROM background_jobs WHERE kind = :kind"),
                {"kind": definition.kind},
            )
            assert scheduled_id is not None
            created_job_ids.append(scheduled_id)
            claimed = claim_next_job(
                db,
                worker_id=worker_id,
                lease_seconds=30,
                allowed_kinds=(ordinary_kind, definition.kind),
                heavy_kinds=(),
            )
            assert claimed is not None
            assert claimed.id == ordinary.id
            assert definition.periodic_priority > ordinary.priority
            assert complete_job(db, job_id=claimed.id, worker_id=worker_id)
            db.commit()
    finally:
        with session_factory() as cleanup:
            delete_jobs_by_ids(cleanup, job_ids=tuple(created_job_ids))
            cleanup.commit()


def test_scheduler_reconciles_persisted_periodic_priority_without_rewriting_execution(
    engine: Engine,
) -> None:
    session_factory = create_session_factory(engine)
    definition = replace(
        get_default_registry()["podcast_refresh_due_job"],
        kind="persisted_periodic_fairness_schedule_probe",
    )
    ordinary_kind = "persisted_periodic_fairness_ordinary_probe"
    worker_id = "persisted-periodic-fairness-proof"
    scheduler_now = datetime(2020, 1, 1, tzinfo=UTC)
    slot_start = periodic_slot_start(
        now=scheduler_now,
        interval_seconds=int(definition.periodic_interval_seconds or 0),
    )
    dedupe_key = periodic_dedupe_key(kind=definition.kind, slot_start=slot_start)
    periodic_payload = {
        "request_id": dedupe_key,
        "scheduler_identity": "pre-upgrade-scheduler",
    }
    created_job_ids = []
    try:
        with session_factory() as db:
            ordinary = enqueue_job(
                db,
                kind=ordinary_kind,
                payload={"probe": "new-ordinary-work-after-upgrade"},
            )
            persisted_periodic = enqueue_job(
                db,
                kind=definition.kind,
                payload=periodic_payload,
                priority=100,
                max_attempts=definition.max_attempts,
                available_at=slot_start,
                dedupe_key=dedupe_key,
            )
            created_job_ids.extend((ordinary.id, persisted_periodic.id))
            db.commit()

        worker = JobWorker(
            session_factory=session_factory,
            worker_id=worker_id,
            registry={definition.kind: definition},
            allowed_kinds=(definition.kind,),
        )
        assert worker.run_scheduler_once(now=scheduler_now) == 0

        with session_factory() as db:
            reconciled = (
                db.execute(
                    text("SELECT * FROM background_jobs WHERE id = :job_id"),
                    {"job_id": persisted_periodic.id},
                )
                .mappings()
                .one()
            )
            assert int(reconciled["priority"]) == definition.periodic_priority
            assert dict(reconciled["payload"]) == persisted_periodic.payload
            assert reconciled["status"] == persisted_periodic.status
            assert int(reconciled["attempts"]) == persisted_periodic.attempts
            assert int(reconciled["max_attempts"]) == persisted_periodic.max_attempts
            assert reconciled["available_at"] == persisted_periodic.available_at
            assert reconciled["lease_expires_at"] == persisted_periodic.lease_expires_at
            assert reconciled["claimed_by"] == persisted_periodic.claimed_by
            assert reconciled["error_code"] == persisted_periodic.error_code
            assert reconciled["last_error"] == persisted_periodic.last_error
            assert reconciled["result"] == persisted_periodic.result
            assert reconciled["started_at"] == persisted_periodic.started_at
            assert reconciled["finished_at"] == persisted_periodic.finished_at
            assert reconciled["created_at"] == persisted_periodic.created_at
            assert reconciled["updated_at"] == persisted_periodic.updated_at

            claimed = claim_next_job(
                db,
                worker_id=worker_id,
                lease_seconds=30,
                allowed_kinds=(ordinary_kind, definition.kind),
                heavy_kinds=(),
            )
            assert claimed is not None
            assert claimed.id == ordinary.id
            assert complete_job(db, job_id=claimed.id, worker_id=worker_id)
            db.commit()
    finally:
        with session_factory() as cleanup:
            delete_jobs_by_ids(cleanup, job_ids=tuple(created_job_ids))
            cleanup.commit()


def test_scheduler_reconciles_older_persisted_periodic_priority_before_claim(
    engine: Engine,
) -> None:
    session_factory = create_session_factory(engine)
    definition = replace(
        get_default_registry()["podcast_refresh_due_job"],
        kind="older_persisted_periodic_fairness_schedule_probe",
    )
    ordinary_kind = "older_persisted_periodic_fairness_ordinary_probe"
    worker_id = "older-persisted-periodic-fairness-proof"
    scheduler_now = datetime(2020, 1, 1, 1, tzinfo=UTC)
    current_slot = periodic_slot_start(
        now=scheduler_now,
        interval_seconds=int(definition.periodic_interval_seconds or 0),
    )
    older_slot = current_slot - timedelta(seconds=int(definition.periodic_interval_seconds or 0))
    older_dedupe_key = periodic_dedupe_key(kind=definition.kind, slot_start=older_slot)
    created_job_ids = []
    try:
        with session_factory() as db:
            ordinary = enqueue_job(
                db,
                kind=ordinary_kind,
                payload={"probe": "new-ordinary-work-after-upgrade"},
            )
            manual_same_kind = enqueue_job(
                db,
                kind=definition.kind,
                payload={"request_id": "manual-same-kind-operation"},
                priority=173,
                dedupe_key="manual-same-kind-operation",
            )
            older_periodic = enqueue_job(
                db,
                kind=definition.kind,
                payload={
                    "request_id": older_dedupe_key,
                    "scheduler_identity": "pre-upgrade-scheduler",
                },
                priority=100,
                max_attempts=definition.max_attempts,
                available_at=older_slot,
                dedupe_key=older_dedupe_key,
            )
            created_job_ids.extend((ordinary.id, manual_same_kind.id, older_periodic.id))
            db.commit()

        worker = JobWorker(
            session_factory=session_factory,
            worker_id=worker_id,
            registry={definition.kind: definition},
            allowed_kinds=(definition.kind,),
        )
        assert worker.run_scheduler_once(now=scheduler_now) == 1

        with session_factory() as db:
            scheduled_ids = db.scalars(
                text("SELECT id FROM background_jobs WHERE kind = :kind"),
                {"kind": definition.kind},
            ).all()
            created_job_ids.extend(
                job_id for job_id in scheduled_ids if job_id not in created_job_ids
            )
            older_priority = db.scalar(
                text("SELECT priority FROM background_jobs WHERE id = :job_id"),
                {"job_id": older_periodic.id},
            )
            assert older_priority == definition.periodic_priority
            preserved_manual = (
                db.execute(
                    text("SELECT * FROM background_jobs WHERE id = :job_id"),
                    {"job_id": manual_same_kind.id},
                )
                .mappings()
                .one()
            )
            assert int(preserved_manual["priority"]) == manual_same_kind.priority
            assert dict(preserved_manual["payload"]) == manual_same_kind.payload
            assert preserved_manual["status"] == manual_same_kind.status
            assert int(preserved_manual["attempts"]) == manual_same_kind.attempts
            assert preserved_manual["available_at"] == manual_same_kind.available_at
            assert preserved_manual["updated_at"] == manual_same_kind.updated_at

            claimed = claim_next_job(
                db,
                worker_id=worker_id,
                lease_seconds=30,
                allowed_kinds=(ordinary_kind, definition.kind),
                heavy_kinds=(),
            )
            assert claimed is not None
            assert claimed.id == ordinary.id
            assert complete_job(db, job_id=claimed.id, worker_id=worker_id)
            db.commit()
    finally:
        with session_factory() as cleanup:
            delete_jobs_by_ids(cleanup, job_ids=tuple(created_job_ids))
            cleanup.commit()


@pytest.mark.parametrize("lifecycle", ("failed", "expired_running"))
def test_scheduler_reconciles_persisted_periodic_replay_priority_only(
    engine: Engine,
    lifecycle: Literal["failed", "expired_running"],
) -> None:
    session_factory = create_session_factory(engine)
    definition = replace(
        get_default_registry()["podcast_refresh_due_job"],
        kind=f"persisted_periodic_{lifecycle}_priority_probe",
        max_attempts=2,
    )
    owner_id = f"persisted-periodic-{lifecycle}-owner"
    scheduler_now = datetime(2020, 1, 1, tzinfo=UTC)
    slot_start = periodic_slot_start(
        now=scheduler_now,
        interval_seconds=int(definition.periodic_interval_seconds or 0),
    )
    dedupe_key = periodic_dedupe_key(kind=definition.kind, slot_start=slot_start)
    created_job_ids = []
    try:
        with session_factory() as db:
            persisted = enqueue_job(
                db,
                kind=definition.kind,
                payload={
                    "request_id": dedupe_key,
                    "scheduler_identity": "pre-upgrade-scheduler",
                },
                priority=100,
                max_attempts=definition.max_attempts,
                available_at=slot_start,
                dedupe_key=dedupe_key,
            )
            created_job_ids.append(persisted.id)
            db.commit()

        with session_factory() as db:
            claimed = claim_job(
                db,
                job_id=persisted.id,
                worker_id=owner_id,
                lease_seconds=30,
                allowed_kinds=(definition.kind,),
                heavy_kinds=(),
            )
            assert claimed is not None
            if lifecycle == "failed":
                assert (
                    fail_job(
                        db,
                        job_id=persisted.id,
                        worker_id=owner_id,
                        error_code="E_PERIODIC_REPLAY_PROBE",
                        error_message="modeled retry",
                        retry_delays_seconds=(0,),
                    )
                    == "failed"
                )
            elif lifecycle == "expired_running":
                expire_job_claim(db, job_id=persisted.id)
            else:
                assert_never(lifecycle)
            db.commit()

        with session_factory() as db:
            before = dict(
                db.execute(
                    text("SELECT * FROM background_jobs WHERE id = :job_id"),
                    {"job_id": persisted.id},
                )
                .mappings()
                .one()
            )

        worker = JobWorker(
            session_factory=session_factory,
            worker_id=f"post-upgrade-{lifecycle}-scheduler",
            registry={definition.kind: definition},
            allowed_kinds=(definition.kind,),
        )
        assert worker.run_scheduler_once(now=scheduler_now) == 0

        with session_factory() as db:
            after = dict(
                db.execute(
                    text("SELECT * FROM background_jobs WHERE id = :job_id"),
                    {"job_id": persisted.id},
                )
                .mappings()
                .one()
            )
        assert int(after.pop("priority")) == definition.periodic_priority
        assert int(before.pop("priority")) == 100
        assert after == before
    finally:
        with session_factory() as cleanup:
            delete_jobs_by_ids(cleanup, job_ids=tuple(created_job_ids))
            cleanup.commit()


def test_scheduler_refuses_to_reprioritize_a_nonperiodic_dedupe_collision(
    engine: Engine,
) -> None:
    session_factory = create_session_factory(engine)
    definition = replace(
        get_default_registry()["podcast_refresh_due_job"],
        kind="periodic_priority_identity_collision_probe",
    )
    scheduler_now = datetime(2020, 1, 1, tzinfo=UTC)
    slot_start = periodic_slot_start(
        now=scheduler_now,
        interval_seconds=int(definition.periodic_interval_seconds or 0),
    )
    dedupe_key = periodic_dedupe_key(kind=definition.kind, slot_start=slot_start)
    created_job_ids = []
    try:
        with session_factory() as db:
            collision = enqueue_job(
                db,
                kind=definition.kind,
                payload={"request_id": dedupe_key, "origin": "not-the-scheduler"},
                priority=100,
                available_at=slot_start,
                dedupe_key=dedupe_key,
            )
            created_job_ids.append(collision.id)
            db.commit()

        worker = JobWorker(
            session_factory=session_factory,
            worker_id="periodic-priority-identity-proof",
            registry={definition.kind: definition},
            allowed_kinds=(definition.kind,),
        )
        with pytest.raises(RuntimeError, match="does not match the exact operation"):
            worker.run_scheduler_once(now=scheduler_now)

        with session_factory() as db:
            unchanged_priority = db.scalar(
                text("SELECT priority FROM background_jobs WHERE id = :job_id"),
                {"job_id": collision.id},
            )
        assert unchanged_priority == 100
    finally:
        with session_factory() as cleanup:
            delete_jobs_by_ids(cleanup, job_ids=tuple(created_job_ids))
            cleanup.commit()


def test_scheduler_refuses_an_older_cross_kind_periodic_namespace_collision(
    engine: Engine,
) -> None:
    session_factory = create_session_factory(engine)
    definition = replace(
        get_default_registry()["podcast_refresh_due_job"],
        kind="cross_kind_periodic_namespace_owner_probe",
    )
    foreign_kind = "cross_kind_periodic_namespace_foreign_probe"
    scheduler_now = datetime(2020, 1, 1, 1, tzinfo=UTC)
    current_slot = periodic_slot_start(
        now=scheduler_now,
        interval_seconds=int(definition.periodic_interval_seconds or 0),
    )
    older_slot = current_slot - timedelta(seconds=int(definition.periodic_interval_seconds or 0))
    claimed_dedupe_key = periodic_dedupe_key(kind=definition.kind, slot_start=older_slot)
    try:
        with session_factory() as db:
            collision = enqueue_job(
                db,
                kind=foreign_kind,
                payload={
                    "request_id": claimed_dedupe_key,
                    "scheduler_identity": "foreign-kind-scheduler",
                },
                priority=100,
                available_at=older_slot,
                dedupe_key=claimed_dedupe_key,
            )
            db.commit()

        worker = JobWorker(
            session_factory=session_factory,
            worker_id="cross-kind-periodic-namespace-proof",
            registry={definition.kind: definition},
            allowed_kinds=(definition.kind,),
        )
        with pytest.raises(RuntimeError, match="does not match the exact operation"):
            worker.run_scheduler_once(now=scheduler_now)

        with session_factory() as db:
            unchanged_priority = db.scalar(
                text("SELECT priority FROM background_jobs WHERE id = :job_id"),
                {"job_id": collision.id},
            )
            inserted_owner_rows = db.scalar(
                text("SELECT count(*) FROM background_jobs WHERE kind = :kind"),
                {"kind": definition.kind},
            )
        assert unchanged_priority == 100
        assert inserted_owner_rows == 0
    finally:
        with session_factory() as cleanup:
            delete_jobs_of_kinds(cleanup, kinds=(definition.kind, foreign_kind))
            cleanup.commit()


@pytest.mark.parametrize(
    ("production_kind", "checkpoint_payload"),
    (
        (
            "dawn_write_job",
            {
                "capacity_wait_index": 0,
                "coordination": {},
                "dawn_write_worklist": [],
            },
        ),
        ("storage_orphan_sweep", {"continuationToken": "next-page"}),
    ),
    ids=("dawn-worklist", "storage-page"),
)
def test_scheduler_revisits_terminal_periodic_jobs_with_registry_owned_checkpoints(
    engine: Engine,
    production_kind: str,
    checkpoint_payload: dict[str, object],
) -> None:
    session_factory = create_session_factory(engine)
    definition = replace(
        get_default_registry()[production_kind],
        kind=f"{production_kind}_checkpoint_revisit_probe",
    )
    assert definition.periodic_checkpoint_keys == frozenset(checkpoint_payload)
    scheduler_now = datetime(2020, 1, 1, tzinfo=UTC)
    slot_start = periodic_slot_start(
        now=scheduler_now,
        interval_seconds=int(definition.periodic_interval_seconds or 0),
    )
    dedupe_key = periodic_dedupe_key(kind=definition.kind, slot_start=slot_start)
    worker_id = f"{production_kind}-checkpoint-revisit-proof"
    try:
        with session_factory() as db:
            scheduled = enqueue_job(
                db,
                kind=definition.kind,
                payload={
                    "request_id": dedupe_key,
                    "scheduler_identity": "original-scheduler",
                },
                priority=definition.periodic_priority,
                max_attempts=definition.max_attempts,
                available_at=slot_start,
                dedupe_key=dedupe_key,
            )
            db.commit()

        with session_factory() as db:
            claimed = claim_job(
                db,
                job_id=scheduled.id,
                worker_id=worker_id,
                lease_seconds=30,
                allowed_kinds=(definition.kind,),
                heavy_kinds=(),
            )
            assert claimed is not None
            assert update_running_job_payload(
                db,
                job_id=claimed.id,
                worker_id=worker_id,
                attempt_no=claimed.attempts,
                payload={**claimed.payload, **checkpoint_payload},
            )
            assert complete_job(db, job_id=claimed.id, worker_id=worker_id)
            db.commit()

        with session_factory() as db:
            terminal_before = dict(
                db.execute(
                    text("SELECT * FROM background_jobs WHERE id = :job_id"),
                    {"job_id": scheduled.id},
                )
                .mappings()
                .one()
            )

        worker = JobWorker(
            session_factory=session_factory,
            worker_id=f"post-{worker_id}",
            registry={definition.kind: definition},
            allowed_kinds=(definition.kind,),
        )
        assert worker.run_scheduler_once(now=scheduler_now) == 0

        with session_factory() as db:
            terminal_after = dict(
                db.execute(
                    text("SELECT * FROM background_jobs WHERE id = :job_id"),
                    {"job_id": scheduled.id},
                )
                .mappings()
                .one()
            )
        assert terminal_after == terminal_before
    finally:
        with session_factory() as cleanup:
            delete_jobs_of_kinds(cleanup, kinds=(definition.kind,))
            cleanup.commit()


def test_scheduler_refuses_an_undeclared_periodic_checkpoint_key(
    engine: Engine,
) -> None:
    session_factory = create_session_factory(engine)
    definition = replace(
        get_default_registry()["dawn_write_job"],
        kind="undeclared_periodic_checkpoint_probe",
    )
    scheduler_now = datetime(2020, 1, 1, tzinfo=UTC)
    slot_start = periodic_slot_start(
        now=scheduler_now,
        interval_seconds=int(definition.periodic_interval_seconds or 0),
    )
    dedupe_key = periodic_dedupe_key(kind=definition.kind, slot_start=slot_start)
    try:
        with session_factory() as db:
            scheduled = enqueue_job(
                db,
                kind=definition.kind,
                payload={
                    "request_id": dedupe_key,
                    "scheduler_identity": "original-scheduler",
                    "undeclared_checkpoint": {},
                },
                priority=definition.periodic_priority,
                max_attempts=definition.max_attempts,
                available_at=slot_start,
                dedupe_key=dedupe_key,
            )
            db.commit()

        worker = JobWorker(
            session_factory=session_factory,
            worker_id="undeclared-periodic-checkpoint-proof",
            registry={definition.kind: definition},
            allowed_kinds=(definition.kind,),
        )
        with pytest.raises(RuntimeError, match="does not match the exact operation"):
            worker.run_scheduler_once(now=scheduler_now)

        with session_factory() as db:
            unchanged = dict(
                db.execute(
                    text("SELECT * FROM background_jobs WHERE id = :job_id"),
                    {"job_id": scheduled.id},
                )
                .mappings()
                .one()
            )
        assert unchanged["status"] == scheduled.status
        assert unchanged["priority"] == scheduled.priority
        assert dict(unchanged["payload"]) == scheduled.payload
    finally:
        with session_factory() as cleanup:
            delete_jobs_of_kinds(cleanup, kinds=(definition.kind,))
            cleanup.commit()


def test_scheduler_ignores_cross_kind_work_that_only_correlates_to_a_periodic_request(
    engine: Engine,
) -> None:
    session_factory = create_session_factory(engine)
    definition = replace(
        get_default_registry()["podcast_refresh_due_job"],
        kind="periodic_request_correlation_owner_probe",
    )
    child_kind = "periodic_request_correlation_child_probe"
    scheduler_now = datetime(2020, 1, 1, tzinfo=UTC)
    slot_start = periodic_slot_start(
        now=scheduler_now,
        interval_seconds=int(definition.periodic_interval_seconds or 0),
    )
    periodic_request_id = periodic_dedupe_key(
        kind=definition.kind,
        slot_start=slot_start,
    )
    try:
        with session_factory() as db:
            correlated_child = enqueue_job(
                db,
                kind=child_kind,
                payload={
                    "request_id": periodic_request_id,
                    "origin": "downstream-correlation",
                },
                priority=73,
                dedupe_key="downstream-correlation",
            )
            db.commit()

        with session_factory() as db:
            child_before = dict(
                db.execute(
                    text("SELECT * FROM background_jobs WHERE id = :job_id"),
                    {"job_id": correlated_child.id},
                )
                .mappings()
                .one()
            )

        worker = JobWorker(
            session_factory=session_factory,
            worker_id="periodic-request-correlation-proof",
            registry={definition.kind: definition},
            allowed_kinds=(definition.kind,),
        )
        assert worker.run_scheduler_once(now=scheduler_now) == 1

        with session_factory() as db:
            child_after = dict(
                db.execute(
                    text("SELECT * FROM background_jobs WHERE id = :job_id"),
                    {"job_id": correlated_child.id},
                )
                .mappings()
                .one()
            )
            inserted_owner_rows = db.scalar(
                text("SELECT count(*) FROM background_jobs WHERE kind = :kind"),
                {"kind": definition.kind},
            )
        assert child_after == child_before
        assert inserted_owner_rows == 1
    finally:
        with session_factory() as cleanup:
            delete_jobs_of_kinds(cleanup, kinds=(definition.kind, child_kind))
            cleanup.commit()


def test_scheduler_refuses_unbounded_periodic_priority_reconciliation(
    engine: Engine,
) -> None:
    session_factory = create_session_factory(engine)
    definition = replace(
        get_default_registry()["podcast_refresh_due_job"],
        kind="bounded_periodic_priority_reconciliation_probe",
    )
    scheduler_now = datetime(2020, 1, 4, tzinfo=UTC)
    current_slot = periodic_slot_start(
        now=scheduler_now,
        interval_seconds=int(definition.periodic_interval_seconds or 0),
    )
    try:
        with session_factory() as db:
            for slot_offset in range(1, PERIODIC_PRIORITY_RECONCILIATION_LIMIT + 2):
                slot_start = current_slot - timedelta(
                    seconds=slot_offset * int(definition.periodic_interval_seconds or 0)
                )
                dedupe_key = periodic_dedupe_key(
                    kind=definition.kind,
                    slot_start=slot_start,
                )
                enqueue_job(
                    db,
                    kind=definition.kind,
                    payload={
                        "request_id": dedupe_key,
                        "scheduler_identity": "bounded-priority-predecessor",
                    },
                    priority=100,
                    available_at=slot_start,
                    dedupe_key=dedupe_key,
                )
            db.commit()

        worker = JobWorker(
            session_factory=session_factory,
            worker_id="bounded-periodic-priority-proof",
            registry={definition.kind: definition},
            allowed_kinds=(definition.kind,),
        )
        with pytest.raises(
            RuntimeError,
            match=(f"active slot limit exceeds {PERIODIC_PRIORITY_RECONCILIATION_LIMIT}"),
        ):
            worker.run_scheduler_once(now=scheduler_now)

        with session_factory() as db:
            priorities = db.scalars(
                text("SELECT priority FROM background_jobs WHERE kind = :kind"),
                {"kind": definition.kind},
            ).all()
        assert len(priorities) == PERIODIC_PRIORITY_RECONCILIATION_LIMIT + 1
        assert set(priorities) == {100}
    finally:
        with session_factory() as cleanup:
            delete_jobs_of_kinds(cleanup, kinds=(definition.kind,))
            cleanup.commit()
