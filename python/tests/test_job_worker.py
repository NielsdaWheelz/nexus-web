"""Integration tests for Postgres worker execution + scheduler behavior."""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import event, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Message
from nexus.jobs.queue import enqueue_job, fail_job
from nexus.jobs.registry import JobDefinition
from nexus.jobs.worker import JobWorker
from tests.factories import create_test_conversation, create_test_message, create_test_model
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
            SELECT status, attempts, claimed_by, result, dedupe_key, error_code, last_error
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


def test_worker_can_treat_failed_task_result_as_failed_job(db_session: Session):
    def handler(*, payload: dict[str, object]) -> dict[str, object]:
        return {
            "status": "failed",
            "reason": "parse_failed",
            "error_code": "E_METADATA_PARSE_FAILED",
            "media_id": payload.get("media_id"),
        }

    worker = JobWorker(
        session_factory=task_session_factory(db_session),
        worker_id="worker-test-failed-result",
        registry={
            "test_failed_result_job": JobDefinition(
                kind="test_failed_result_job",
                handler=handler,
                max_attempts=1,
                retry_delays_seconds=(0,),
                lease_seconds=60,
                failed_result_statuses=("failed",),
            )
        },
    )

    job = enqueue_job(
        db_session,
        kind="test_failed_result_job",
        payload={"media_id": "media-1"},
        max_attempts=1,
    )
    db_session.commit()

    assert worker.run_once() is True

    db_session.expire_all()
    row = _fetch_job_row(db_session, job.id)
    assert row["status"] == "dead"
    assert row["attempts"] == 1
    assert row["error_code"] == "E_METADATA_PARSE_FAILED"
    assert row["last_error"] == "parse_failed"
    assert row["result"] == {
        "status": "failed",
        "reason": "parse_failed",
        "error_code": "E_METADATA_PARSE_FAILED",
        "media_id": "media-1",
    }


def test_worker_runs_dead_letter_handler_when_task_exhausts_attempts(db_session: Session):
    handled: list[tuple[str, str | None]] = []

    def handler(*, payload: dict[str, object]) -> dict[str, object]:
        return {
            "status": "failed",
            "reason": "terminal_failure",
            "error_code": "E_TERMINAL_TEST",
        }

    def dead_letter_handler(db: Session, job) -> None:
        handled.append((str(job.id), job.error_code))
        db.execute(text("SELECT 1"))

    worker = JobWorker(
        session_factory=task_session_factory(db_session),
        worker_id="worker-test-dead-letter-result",
        registry={
            "test_dead_letter_result_job": JobDefinition(
                kind="test_dead_letter_result_job",
                handler=handler,
                max_attempts=1,
                retry_delays_seconds=(0,),
                lease_seconds=60,
                failed_result_statuses=("failed",),
                dead_letter_handler=dead_letter_handler,
            )
        },
    )

    job = enqueue_job(
        db_session,
        kind="test_dead_letter_result_job",
        payload={},
        max_attempts=1,
    )
    db_session.commit()

    assert worker.run_once() is True

    db_session.expire_all()
    row = _fetch_job_row(db_session, job.id)
    assert row["status"] == "dead"
    assert handled == [(str(job.id), "E_TERMINAL_TEST")]


def test_worker_runs_dead_letter_handler_for_exhausted_expired_lease(
    db_session: Session,
):
    handled: list[tuple[str, str | None]] = []

    def handler(*, payload: dict[str, object]) -> dict[str, object]:
        raise AssertionError("expired exhausted job must not run handler again")

    def dead_letter_handler(db: Session, job) -> None:
        handled.append((str(job.id), job.error_code))
        db.execute(text("SELECT 1"))

    worker = JobWorker(
        session_factory=task_session_factory(db_session),
        worker_id="worker-test-dead-letter-expired",
        registry={
            "test_dead_letter_expired_job": JobDefinition(
                kind="test_dead_letter_expired_job",
                handler=handler,
                max_attempts=2,
                retry_delays_seconds=(0,),
                lease_seconds=60,
                dead_letter_handler=dead_letter_handler,
            )
        },
    )

    job = enqueue_job(
        db_session,
        kind="test_dead_letter_expired_job",
        payload={"value": "abc"},
        max_attempts=2,
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET
                status = 'running',
                attempts = 2,
                claimed_by = 'dead-worker',
                lease_expires_at = now() - interval '1 minute'
            WHERE id = :job_id
            """
        ),
        {"job_id": job.id},
    )
    db_session.commit()

    assert worker.run_once() is True

    db_session.expire_all()
    row = _fetch_job_row(db_session, job.id)
    assert row["status"] == "dead"
    assert handled == [(str(job.id), "E_JOB_LEASE_EXPIRED")]


def test_chat_run_dead_letter_finalizes_run_in_worker_transaction(
    db_session: Session,
    bootstrapped_user: UUID,
):
    model_id = create_test_model(db_session)
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    user_message_id = create_test_message(
        db_session,
        conversation_id,
        seq=1,
        role="user",
        content="Start a response",
    )
    assistant_message_id = create_test_message(
        db_session,
        conversation_id,
        seq=2,
        role="assistant",
        content="",
        status="pending",
        model_id=model_id,
        parent_message_id=user_message_id,
    )
    run_id = uuid4()
    db_session.add(
        ChatRun(
            id=run_id,
            owner_user_id=bootstrapped_user,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            idempotency_key=f"dead-letter-{uuid4()}",
            payload_hash="dead-letter-payload",
            status="running",
            model_id=model_id,
            reasoning="none",
            key_mode="auto",
        )
    )
    db_session.commit()

    job = enqueue_job(
        db_session,
        kind="chat_run",
        payload={"run_id": str(run_id)},
        max_attempts=1,
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET
                status = 'running',
                attempts = 1,
                claimed_by = 'dead-worker',
                lease_expires_at = now() - interval '1 minute'
            WHERE id = :job_id
            """
        ),
        {"job_id": job.id},
    )
    db_session.commit()

    worker = JobWorker(
        session_factory=task_session_factory(db_session),
        worker_id="worker-chat-run-dead-letter",
        allowed_kinds=("chat_run",),
    )

    assert worker.run_once() is True

    db_session.expire_all()
    row = _fetch_job_row(db_session, job.id)
    assert row["status"] == "dead"
    assert row["error_code"] == "E_JOB_LEASE_EXPIRED"

    run = db_session.get(ChatRun, run_id)
    assert run is not None
    assert run.status == "error"
    assert run.error_code == "E_JOB_LEASE_EXPIRED"

    assistant_message = db_session.get(Message, assistant_message_id)
    assert assistant_message is not None
    assert assistant_message.status == "error"
    assert assistant_message.error_code == "E_JOB_LEASE_EXPIRED"
    assert "exhausted its attempts" in assistant_message.content

    done_payload = db_session.execute(
        text(
            """
            SELECT payload
            FROM chat_run_events
            WHERE run_id = :run_id AND event_type = 'done'
            ORDER BY seq DESC
            LIMIT 1
            """
        ),
        {"run_id": run_id},
    ).scalar_one()
    assert done_payload == {
        "status": "error",
        "usage": None,
        "error_code": "E_JOB_LEASE_EXPIRED",
        "final_chars": None,
    }


def test_worker_run_once_skips_handler_when_start_heartbeat_loses_ownership(
    direct_db: DirectSessionManager,
):
    kind = "test_lost_before_start_job"
    direct_db.register_cleanup("background_jobs", "kind", kind)
    observed_payloads: list[dict[str, object]] = []
    ownership_moved = threading.Event()

    def handler(*, payload: dict[str, object]) -> dict[str, object]:
        observed_payloads.append(payload)
        return {"ok": True}

    def session_factory() -> Session:
        db = direct_db.session()
        if not ownership_moved.is_set():
            event.listen(db, "after_commit", move_ownership_after_claim, once=True)
        return db

    def move_ownership_after_claim(_db: Session) -> None:
        with direct_db.session() as takeover:
            takeover.execute(
                text(
                    """
                    UPDATE background_jobs
                    SET claimed_by = 'other-worker',
                        lease_expires_at = now() + interval '60 seconds'
                    WHERE kind = :kind
                      AND status = 'running'
                    """
                ),
                {"kind": kind},
            )
            takeover.commit()
        ownership_moved.set()

    worker = JobWorker(
        session_factory=session_factory,
        worker_id="worker-test-lost-before-start",
        registry={
            kind: JobDefinition(
                kind=kind,
                handler=handler,
                max_attempts=1,
                retry_delays_seconds=(0,),
                lease_seconds=60,
            )
        },
    )

    with direct_db.session() as db:
        job = enqueue_job(
            db,
            kind=kind,
            payload={"value": "abc"},
            max_attempts=1,
        )
        job_id = job.id
        db.commit()

    assert worker.run_once() is True
    assert observed_payloads == []

    with direct_db.session() as db:
        row = _fetch_job_row(db, job_id)
    assert row["status"] == "running"
    assert row["claimed_by"] == "other-worker"


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
                lease_expires_at = now() - interval '3 minutes'
            WHERE id = :job_id
            """
        ),
        {"job_id": stale_job.id},
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
):
    kind = "test_periodic_race_job"
    direct_db.register_cleanup("background_jobs", "kind", kind)

    with direct_db.session() as db:
        db.execute(text("DELETE FROM background_jobs WHERE kind = :kind"), {"kind": kind})
        db.commit()

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
    start = threading.Barrier(2)

    def run_scheduler(worker_id: str) -> int:
        start.wait(timeout=5)
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


def test_worker_run_forever_wakes_on_enqueue_notification(direct_db: DirectSessionManager):
    kind = "test_notify_wakeup_job"
    direct_db.register_cleanup("background_jobs", "kind", kind)

    with direct_db.session() as db:
        db.execute(text("DELETE FROM background_jobs WHERE kind = :kind"), {"kind": kind})
        db.commit()

    processed = threading.Event()
    stop = threading.Event()

    def handler(*, payload: dict[str, object]) -> dict[str, object]:
        processed.set()
        stop.set()
        return {"ok": True, "payload": payload}

    worker = JobWorker(
        session_factory=direct_db.session,
        worker_id="worker-test-notify-wakeup",
        registry={
            kind: JobDefinition(
                kind=kind,
                handler=handler,
                max_attempts=1,
                retry_delays_seconds=(0,),
                lease_seconds=60,
            )
        },
        poll_interval_seconds=5.0,
        idle_backoff_max_seconds=5.0,
        scheduler_interval_seconds=60.0,
    )

    started_at = time.monotonic()
    worker_thread = threading.Thread(
        target=worker.run_forever,
        kwargs={"stop_event": stop},
        daemon=True,
    )
    worker_thread.start()

    time.sleep(0.2)
    with direct_db.session() as db:
        enqueue_job(db, kind=kind, payload={"source": "notify"}, max_attempts=1)
        db.commit()

    worker_thread.join(timeout=3.0)
    stop.set()
    worker_thread.join(timeout=1.0)

    assert not worker_thread.is_alive(), "Expected LISTEN/NOTIFY to wake the idle worker."
    assert processed.is_set(), "Expected enqueued notification job to be processed."
    elapsed = time.monotonic() - started_at
    assert elapsed < 3.0, (
        "Expected notification wakeup before the 5 second idle backoff elapsed. "
        f"elapsed={elapsed:.3f}s"
    )


def test_worker_run_forever_ignores_disallowed_notification_until_allowed_job(
    direct_db: DirectSessionManager,
):
    blocked_kind = "test_blocked_notify_job"
    allowed_kind = "test_allowed_notify_job"
    direct_db.register_cleanup("background_jobs", "kind", blocked_kind)
    direct_db.register_cleanup("background_jobs", "kind", allowed_kind)

    with direct_db.session() as db:
        db.execute(
            text("DELETE FROM background_jobs WHERE kind IN (:blocked_kind, :allowed_kind)"),
            {"blocked_kind": blocked_kind, "allowed_kind": allowed_kind},
        )
        db.commit()

    processed = threading.Event()
    stop = threading.Event()
    observed_payloads: list[dict[str, object]] = []

    def handler(*, payload: dict[str, object]) -> dict[str, object]:
        observed_payloads.append(payload)
        processed.set()
        stop.set()
        return {"ok": True, "payload": payload}

    worker = JobWorker(
        session_factory=direct_db.session,
        worker_id="worker-test-allowed-notify",
        registry={
            allowed_kind: JobDefinition(
                kind=allowed_kind,
                handler=handler,
                max_attempts=1,
                retry_delays_seconds=(0,),
                lease_seconds=60,
            )
        },
        poll_interval_seconds=5.0,
        idle_backoff_max_seconds=5.0,
        scheduler_interval_seconds=60.0,
        allowed_kinds=(allowed_kind,),
    )

    worker_thread = threading.Thread(
        target=worker.run_forever,
        kwargs={"stop_event": stop},
        daemon=True,
    )
    worker_thread.start()

    time.sleep(0.2)
    with direct_db.session() as db:
        enqueue_job(db, kind=blocked_kind, payload={"source": "blocked"}, max_attempts=1)
        db.commit()
    time.sleep(0.3)
    assert not processed.is_set(), "Disallowed notification should not wake the sharded worker."

    with direct_db.session() as db:
        enqueue_job(db, kind=allowed_kind, payload={"source": "allowed"}, max_attempts=1)
        db.commit()

    worker_thread.join(timeout=3.0)
    stop.set()
    worker_thread.join(timeout=1.0)

    assert not worker_thread.is_alive(), "Expected allowed notification to wake the worker."
    assert observed_payloads == [{"source": "allowed"}]


def test_worker_notification_wait_falls_back_when_driver_connection_is_unavailable():
    class FakeConnection:
        connection = type("DriverConnectionBox", (), {"driver_connection": None})()

    class FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def connection(self, **_kwargs):
            return FakeConnection()

    worker = JobWorker(
        session_factory=FakeSession,
        worker_id="worker-test-no-driver-listen",
        registry={},
    )
    stop = threading.Event()

    worker._wait_for_job_notification(stop_event=stop, timeout=0.01)


def test_worker_run_forever_wakes_when_future_job_becomes_due(direct_db: DirectSessionManager):
    kind = "test_future_due_wakeup_job"
    direct_db.register_cleanup("background_jobs", "kind", kind)

    with direct_db.session() as db:
        db.execute(text("DELETE FROM background_jobs WHERE kind = :kind"), {"kind": kind})
        available_at = db.execute(text("SELECT now() + interval '0.4 seconds'")).scalar_one()
        enqueue_job(
            db,
            kind=kind,
            payload={"source": "future"},
            available_at=available_at,
            max_attempts=1,
        )
        db.commit()

    processed = threading.Event()
    stop = threading.Event()

    def handler(*, payload: dict[str, object]) -> dict[str, object]:
        processed.set()
        stop.set()
        return {"ok": True, "payload": payload}

    worker = JobWorker(
        session_factory=direct_db.session,
        worker_id="worker-test-future-wakeup",
        registry={
            kind: JobDefinition(
                kind=kind,
                handler=handler,
                max_attempts=1,
                retry_delays_seconds=(0,),
                lease_seconds=60,
            )
        },
        poll_interval_seconds=5.0,
        idle_backoff_max_seconds=5.0,
        scheduler_interval_seconds=60.0,
    )

    started_at = time.monotonic()
    worker_thread = threading.Thread(
        target=worker.run_forever,
        kwargs={"stop_event": stop},
        daemon=True,
    )
    worker_thread.start()
    worker_thread.join(timeout=3.0)
    stop.set()
    worker_thread.join(timeout=1.0)

    assert not worker_thread.is_alive(), "Expected due-time cap to wake the idle worker."
    assert processed.is_set(), "Expected future job to process soon after available_at."
    elapsed = time.monotonic() - started_at
    assert elapsed < 3.0, (
        f"Expected future due job before the 5 second idle backoff elapsed. elapsed={elapsed:.3f}s"
    )


def test_worker_run_forever_caps_idle_wait_at_scheduler_deadline(direct_db: DirectSessionManager):
    kind = "test_scheduler_deadline_job"
    direct_db.register_cleanup("background_jobs", "kind", kind)

    with direct_db.session() as db:
        db.execute(text("DELETE FROM background_jobs WHERE kind = :kind"), {"kind": kind})
        db.commit()

    processed_count = 0
    stop = threading.Event()

    def handler(*, payload: dict[str, object]) -> dict[str, object]:
        nonlocal processed_count
        processed_count += 1
        if processed_count >= 2:
            stop.set()
        return {"ok": True, "payload": payload}

    worker = JobWorker(
        session_factory=direct_db.session,
        worker_id="worker-test-scheduler-deadline",
        registry={
            kind: JobDefinition(
                kind=kind,
                handler=handler,
                max_attempts=1,
                retry_delays_seconds=(0,),
                lease_seconds=60,
                periodic_interval_seconds=1,
            )
        },
        poll_interval_seconds=5.0,
        idle_backoff_max_seconds=5.0,
        scheduler_interval_seconds=1.0,
    )

    started_at = time.monotonic()
    worker_thread = threading.Thread(
        target=worker.run_forever,
        kwargs={"stop_event": stop},
        daemon=True,
    )
    worker_thread.start()
    worker_thread.join(timeout=3.0)
    stop.set()
    worker_thread.join(timeout=1.0)

    assert not worker_thread.is_alive(), "Expected scheduler deadline to wake the idle worker."
    assert processed_count >= 2
    elapsed = time.monotonic() - started_at
    assert elapsed < 3.0, (
        "Expected the second periodic job before the 5 second idle backoff elapsed. "
        f"elapsed={elapsed:.3f}s"
    )


def test_worker_run_forever_wakes_on_failed_retry_notification(direct_db: DirectSessionManager):
    kind = "test_failed_retry_notify_job"
    direct_db.register_cleanup("background_jobs", "kind", kind)

    with direct_db.session() as db:
        db.execute(text("DELETE FROM background_jobs WHERE kind = :kind"), {"kind": kind})
        job = enqueue_job(db, kind=kind, payload={"source": "retry"}, max_attempts=3)
        db.execute(
            text(
                """
                UPDATE background_jobs
                SET
                    status = 'running',
                    attempts = 1,
                    claimed_by = 'worker-a',
                    lease_expires_at = now() + interval '1 minute'
                WHERE id = :job_id
                """
            ),
            {"job_id": job.id},
        )
        db.commit()

    processed = threading.Event()
    stop = threading.Event()

    def handler(*, payload: dict[str, object]) -> dict[str, object]:
        processed.set()
        stop.set()
        return {"ok": True, "payload": payload}

    worker = JobWorker(
        session_factory=direct_db.session,
        worker_id="worker-test-failed-retry-notify",
        registry={
            kind: JobDefinition(
                kind=kind,
                handler=handler,
                max_attempts=3,
                retry_delays_seconds=(0,),
                lease_seconds=60,
            )
        },
        poll_interval_seconds=5.0,
        idle_backoff_max_seconds=5.0,
        scheduler_interval_seconds=60.0,
    )

    started_at = time.monotonic()
    worker_thread = threading.Thread(
        target=worker.run_forever,
        kwargs={"stop_event": stop},
        daemon=True,
    )
    worker_thread.start()

    time.sleep(0.2)
    with direct_db.session() as db:
        transition = fail_job(
            db,
            job_id=job.id,
            worker_id="worker-a",
            error_code="E_TEST_RETRY",
            error_message="retry now",
            retry_delays_seconds=(0,),
        )
        db.commit()

    assert transition == "failed"
    worker_thread.join(timeout=3.0)
    stop.set()
    worker_thread.join(timeout=1.0)

    assert not worker_thread.is_alive(), "Expected fail_job notification to wake the idle worker."
    assert processed.is_set(), "Expected failed retry job to be processed."
    elapsed = time.monotonic() - started_at
    assert elapsed < 3.0, (
        "Expected failed retry notification before the 5 second idle backoff elapsed. "
        f"elapsed={elapsed:.3f}s"
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
