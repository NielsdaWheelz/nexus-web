"""Integration tests for Postgres worker execution + scheduler behavior."""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

import nexus.jobs.worker as worker_module
from nexus.jobs.queue import enqueue_job
from nexus.jobs.registry import JobDefinition
from nexus.jobs.worker import JobWorker
from tests.utils.db import DirectSessionManager, task_session_factory

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _isolate_background_jobs(db_session: Session):
    """Keep worker tests deterministic regardless of suite order."""
    db_session.execute(text("DELETE FROM background_jobs"))
    db_session.commit()
    yield
    db_session.execute(text("DELETE FROM background_jobs"))
    db_session.commit()


def _fetch_job_row(db: Session, job_id: UUID) -> dict[str, object]:
    row = (
        db.execute(
            text(
                """
            SELECT status, attempts, claimed_by, result, dedupe_key
            FROM background_jobs
            WHERE id = :job_id
            """
            ),
            {"job_id": job_id},
        )
        .mappings()
        .one()
    )
    return dict(row)


def test_worker_run_once_executes_handler_and_marks_job_succeeded(db_session: Session):
    observed_payloads: list[dict[str, object]] = []

    def handler(*, payload: dict[str, object]) -> dict[str, object]:
        observed_payloads.append(payload)
        return {"ok": True, "payload_value": payload.get("value")}

    worker = JobWorker(
        session_factory=task_session_factory(db_session),
        worker_id="worker-test-success",
        registry={
            "test_success_job": JobDefinition(
                kind="test_success_job",
                handler=handler,
                max_attempts=3,
                retry_delays_seconds=(1, 5, 10),
                lease_seconds=60,
            )
        },
    )

    job = enqueue_job(
        db_session,
        kind="test_success_job",
        payload={"value": "abc"},
        max_attempts=3,
    )
    db_session.commit()

    processed = worker.run_once()
    assert processed is True, "Expected worker to process one queued job iteration."

    db_session.expire_all()
    row = _fetch_job_row(db_session, job.id)
    assert row["status"] == "succeeded", (
        f"Expected successful handler execution to mark job succeeded. Row state={row}"
    )
    assert observed_payloads == [{"value": "abc"}], (
        "Expected worker to pass payload through to handler unchanged. "
        f"Observed payloads={observed_payloads}"
    )


def test_worker_run_once_reclaims_stale_running_job_and_completes_it(db_session: Session):
    def handler(*, payload: dict[str, object]) -> dict[str, object]:
        return {"reclaimed": payload.get("reclaimed", False)}

    worker = JobWorker(
        session_factory=task_session_factory(db_session),
        worker_id="worker-test-reclaim",
        registry={
            "test_reclaim_job": JobDefinition(
                kind="test_reclaim_job",
                handler=handler,
                max_attempts=3,
                retry_delays_seconds=(1, 5, 10),
                lease_seconds=60,
            )
        },
    )

    stale_job = enqueue_job(
        db_session,
        kind="test_reclaim_job",
        payload={"reclaimed": True},
        max_attempts=3,
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET
                status = 'running',
                attempts = 1,
                claimed_by = 'dead-worker',
                lease_expires_at = :expired_at
            WHERE id = :job_id
            """
        ),
        {"job_id": stale_job.id, "expired_at": datetime.now(UTC) - timedelta(minutes=3)},
    )
    db_session.commit()

    processed = worker.run_once()
    assert processed is True, "Expected worker to reclaim and process stale running job."

    db_session.expire_all()
    row = _fetch_job_row(db_session, stale_job.id)
    assert row["status"] == "succeeded", (
        f"Expected stale-running reclaim path to finish in succeeded state. Row state={row}"
    )
    assert int(row["attempts"]) == 2, (
        f"Expected reclaim claim to increment attempts counter from 1 to 2. Row state={row}"
    )
    assert row["claimed_by"] is None, (
        "Expected terminal transition to clear claim ownership after successful completion. "
        f"Row state={row}"
    )


def test_worker_scheduler_enqueues_periodic_jobs_with_slot_dedupe(db_session: Session):
    worker = JobWorker(
        session_factory=task_session_factory(db_session),
        worker_id="worker-test-scheduler",
        registry={
            "test_periodic_job": JobDefinition(
                kind="test_periodic_job",
                handler=lambda *, payload: {"ok": True},
                max_attempts=1,
                retry_delays_seconds=(1,),
                lease_seconds=60,
                periodic_interval_seconds=30,
            )
        },
    )

    slot_now = datetime(2026, 3, 23, 12, 0, 7, tzinfo=UTC)
    first_insert_count = worker.run_scheduler_once(now=slot_now)
    second_insert_count = worker.run_scheduler_once(now=slot_now + timedelta(seconds=10))
    db_session.commit()

    assert first_insert_count == 1, (
        "Expected scheduler to enqueue one row on first tick in a schedule slot. "
        f"first_insert_count={first_insert_count}"
    )
    assert second_insert_count == 0, (
        "Expected dedupe to prevent duplicate periodic enqueue in same slot. "
        f"second_insert_count={second_insert_count}"
    )
    row_count = db_session.execute(
        text("SELECT COUNT(*) FROM background_jobs WHERE kind = 'test_periodic_job'")
    ).scalar_one()
    assert row_count == 1, (
        "Expected exactly one periodic row for same slot after duplicate scheduler ticks. "
        f"row_count={row_count}"
    )


def test_worker_scheduler_race_enqueues_one_periodic_job(
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
):
    kind = "test_periodic_race_job"
    direct_db.register_cleanup("background_jobs", "kind", kind)

    with direct_db.session() as db:
        db.execute(text("DELETE FROM background_jobs WHERE kind = :kind"), {"kind": kind})
        db.commit()

    barrier = threading.Barrier(2)
    real_enqueue_job = worker_module.enqueue_job

    def gated_enqueue_job(*args, **kwargs):
        barrier.wait(timeout=5)
        return real_enqueue_job(*args, **kwargs)

    monkeypatch.setattr(worker_module, "enqueue_job", gated_enqueue_job)

    registry = {
        kind: JobDefinition(
            kind=kind,
            handler=lambda *, payload: {"ok": True},
            max_attempts=1,
            retry_delays_seconds=(1,),
            lease_seconds=60,
            periodic_interval_seconds=30,
        )
    }
    slot_now = datetime(2026, 3, 23, 12, 0, 7, tzinfo=UTC)

    def run_scheduler(worker_id: str) -> int:
        worker = JobWorker(
            session_factory=direct_db.session,
            worker_id=worker_id,
            registry=registry,
        )
        return worker.run_scheduler_once(now=slot_now)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = sorted(
            future.result(timeout=10)
            for future in (
                executor.submit(run_scheduler, "worker-test-scheduler-race-a"),
                executor.submit(run_scheduler, "worker-test-scheduler-race-b"),
            )
        )

    with direct_db.session() as db:
        row_count = db.execute(
            text("SELECT COUNT(*) FROM background_jobs WHERE kind = :kind"),
            {"kind": kind},
        ).scalar_one()

    assert results == [0, 1], f"Expected one racing scheduler to win. Results={results}"
    assert row_count == 1, (
        "Expected concurrent scheduler ticks for one slot to leave exactly one row. "
        f"row_count={row_count}"
    )


def test_worker_run_once_respects_allowed_kinds(db_session: Session):
    observed_payloads: list[dict[str, object]] = []

    def handler(*, payload: dict[str, object]) -> dict[str, object]:
        observed_payloads.append(payload)
        return {"ok": True}

    worker = JobWorker(
        session_factory=task_session_factory(db_session),
        worker_id="worker-test-allowed-kinds",
        registry={
            "user_job": JobDefinition(
                kind="user_job",
                handler=handler,
                max_attempts=1,
                retry_delays_seconds=(0,),
                lease_seconds=60,
            ),
            "maintenance_job": JobDefinition(
                kind="maintenance_job",
                handler=handler,
                max_attempts=1,
                retry_delays_seconds=(0,),
                lease_seconds=60,
            ),
        },
        allowed_kinds=("user_job",),
    )

    maintenance = enqueue_job(
        db_session,
        kind="maintenance_job",
        payload={"kind": "maintenance"},
        priority=1,
        max_attempts=1,
    )
    user = enqueue_job(
        db_session,
        kind="user_job",
        payload={"kind": "user"},
        priority=10,
        max_attempts=1,
    )
    db_session.commit()

    processed = worker.run_once()
    assert processed is True, "Expected worker to process the allowed user job."

    db_session.expire_all()
    assert _fetch_job_row(db_session, user.id)["status"] == "succeeded"
    assert _fetch_job_row(db_session, maintenance.id)["status"] == "pending"
    assert observed_payloads == [{"kind": "user"}], (
        f"Expected worker to skip disallowed maintenance job. Observed payloads={observed_payloads}"
    )


def test_worker_scheduler_skips_disabled_periodic_jobs_without_db_session():
    def fail_session_factory() -> Session:
        raise AssertionError("scheduler should not open a DB session when no periodic jobs are due")

    worker = JobWorker(
        session_factory=fail_session_factory,
        worker_id="worker-test-disabled-scheduler",
        registry={
            "disabled_periodic_job": JobDefinition(
                kind="disabled_periodic_job",
                handler=lambda *, payload: {"ok": True},
                max_attempts=1,
                retry_delays_seconds=(0,),
                lease_seconds=60,
                periodic_interval_seconds=None,
            )
        },
    )

    inserted = worker.run_scheduler_once(now=datetime(2026, 3, 23, 12, 0, 7, tzinfo=UTC))
    assert inserted == 0, f"Expected disabled scheduler to enqueue nothing, inserted={inserted}."


def test_worker_scheduler_respects_allowed_kinds(db_session: Session):
    worker = JobWorker(
        session_factory=task_session_factory(db_session),
        worker_id="worker-test-scheduler-allowed-kinds",
        registry={
            "allowed_periodic_job": JobDefinition(
                kind="allowed_periodic_job",
                handler=lambda *, payload: {"ok": True},
                max_attempts=1,
                retry_delays_seconds=(0,),
                lease_seconds=60,
                periodic_interval_seconds=30,
            ),
            "blocked_periodic_job": JobDefinition(
                kind="blocked_periodic_job",
                handler=lambda *, payload: {"ok": True},
                max_attempts=1,
                retry_delays_seconds=(0,),
                lease_seconds=60,
                periodic_interval_seconds=30,
            ),
        },
        allowed_kinds=("allowed_periodic_job",),
    )

    inserted = worker.run_scheduler_once(now=datetime(2026, 3, 23, 12, 0, 7, tzinfo=UTC))
    db_session.commit()

    assert inserted == 1, f"Expected only the allowed periodic job to enqueue, inserted={inserted}."
    rows = db_session.execute(text("SELECT kind FROM background_jobs ORDER BY kind")).fetchall()
    assert [row[0] for row in rows] == ["allowed_periodic_job"], (
        f"Expected scheduler to skip blocked periodic job. Rows={rows}"
    )


def test_worker_preserves_explicit_empty_registry():
    def unused_session_factory() -> Session:
        raise AssertionError("session factory should not be used")

    worker = JobWorker(
        session_factory=unused_session_factory,
        worker_id="worker-test-empty-registry",
        registry={},
    )

    assert worker.registry == {}, "Expected explicit empty registry to stay empty."


def test_worker_run_forever_backs_off_db_failure_without_exiting_as_error():
    class RecordingStopEvent:
        def __init__(self) -> None:
            self.waits: list[float] = []
            self.stopped = False

        def is_set(self) -> bool:
            return self.stopped

        def wait(self, timeout: float | None = None) -> bool:
            self.waits.append(float(timeout or 0))
            self.stopped = True
            return True

    stop_event = RecordingStopEvent()

    class FailingClaimWorker(JobWorker):
        def __init__(self, **kwargs) -> None:
            super().__init__(**kwargs)
            self.calls = 0

        def run_once(self) -> bool:
            self.calls += 1
            if self.calls > 1:
                stop_event.stopped = True
            raise SQLAlchemyError("database unavailable")

    def unused_session_factory() -> Session:
        raise SQLAlchemyError("unused")

    worker = FailingClaimWorker(
        session_factory=unused_session_factory,
        worker_id="worker-test-db-failure",
        registry={},
        db_failure_backoff_seconds=0.1,
        db_failure_backoff_max_seconds=0.1,
    )

    worker.run_forever(stop_event=stop_event)
    assert stop_event.waits == [0.1], (
        f"Expected DB failure path to wait for configured backoff once. waits={stop_event.waits}"
    )
