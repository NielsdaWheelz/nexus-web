from __future__ import annotations

import threading
from collections.abc import Generator
from datetime import UTC, datetime
from uuid import UUID

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from nexus.db.session import create_session_factory
from nexus.jobs.queue import (
    JobExecutionContext,
    claim_job,
    claim_next_job,
    complete_job,
    dead_letter_expired_job,
    enqueue_job,
    fail_job,
    heartbeat_job,
    lock_and_renew_running_job_claim,
    requeue_dead_job,
    reschedule_running_job,
)
from nexus.jobs.registry import JobDefinition
from nexus.jobs.worker import JobWorker
from tests.testkit.unreachable_state import (
    assign_dead_job_to_heavy_capacity,
    clear_heavy_capacity_holder,
    delete_jobs_of_kinds,
    expire_heavy_job_claim,
    release_heavy_capacity_row,
)

# Every synthetic queue kind this module enqueues. Teardown removes exactly these
# rows, so a new scenario must add its kind here.
_PROBE_KINDS = (
    "heavy_worker_context_probe",
    "heavy_concurrency_probe",
    "heavy_capacity_block_probe",
    "light_capacity_block_probe",
    "heavy_transition_probe",
    "heavy_dead_capacity_probe",
    "heavy_expiry_probe",
    "heavy_missing_holder_probe",
    "heavy_publication_contention_probe",
    "light_publication_contention_probe",
)


@pytest.fixture(scope="module", autouse=True)
def released_capacity_and_probe_jobs(engine: Engine) -> Generator[None, None, None]:
    """Return the one global Heavy capacity row and this module's queue rows to base state.

    These proofs need committed multi-connection visibility, so they mutate the
    single seeded capacity row and real queue rows instead of running inside the
    rolled-back `db_session`. Without this teardown one failed scenario would
    leave the lease held or a due probe row claimable, and every later module
    sharing the run database would inherit that failure.
    """
    try:
        yield
    finally:
        with Session(engine) as db:
            release_heavy_capacity_row(db)
            delete_jobs_of_kinds(db, kinds=_PROBE_KINDS)
            db.commit()


def _capacity_holder(engine: Engine) -> tuple[object, ...]:
    with engine.connect() as connection:
        return tuple(
            connection.execute(
                text(
                    """
                    SELECT job_id, worker_id, attempt_no, lease_expires_at
                    FROM background_job_capacity_leases
                    WHERE resource_class = 'Heavy'
                    """
                )
            ).one()
        )


def test_worker_threads_registry_resource_class_into_execution_context(engine: Engine) -> None:
    kind = "heavy_worker_context_probe"
    observed: list[str] = []

    def handler(*, payload: object, context: JobExecutionContext) -> None:
        observed.append(context.resource_class)

    with Session(engine) as db:
        enqueue_job(db, kind=kind, priority=0)
        db.commit()
    worker = JobWorker(
        session_factory=create_session_factory(engine),
        worker_id="heavy-context-worker",
        registry={kind: JobDefinition(kind=kind, handler=handler, resource_class="Heavy")},
        allowed_kinds=(kind,),
    )

    assert worker.run_once() is True
    assert observed == ["Heavy"]
    assert _capacity_holder(engine) == (None, None, None, None)


def test_concurrent_claims_admit_only_one_heavy_job(engine: Engine) -> None:
    kind = "heavy_concurrency_probe"
    with Session(engine) as db:
        jobs = [
            enqueue_job(db, kind=kind, priority=0),
            enqueue_job(db, kind=kind, priority=0),
        ]
        db.commit()

    barrier = threading.Barrier(2)
    claimed: list[tuple[str, UUID] | None] = []
    failures: list[BaseException] = []

    def claim(worker_id: str) -> None:
        try:
            with Session(engine) as db:
                barrier.wait()
                row = claim_next_job(
                    db,
                    worker_id=worker_id,
                    lease_seconds=300,
                    allowed_kinds=(kind,),
                    heavy_kinds=(kind,),
                )
                db.commit()
                claimed.append((worker_id, row.id) if row is not None else None)
        except BaseException as exc:
            failures.append(exc)

    threads = [threading.Thread(target=claim, args=(f"worker-{index}",)) for index in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert not [thread for thread in threads if thread.is_alive()], "concurrent claims deadlocked"
    assert not failures, f"concurrent claims failed: {failures!r}"
    admitted = [item for item in claimed if item is not None]
    assert len(admitted) == 1, f"expected one Heavy admission, got {claimed!r}"
    worker_id, job_id = admitted[0]
    assert _capacity_holder(engine)[:3] == (job_id, worker_id, 1)

    with Session(engine) as db:
        rows = db.execute(
            text(
                """
                SELECT status, attempts
                FROM background_jobs
                WHERE id = ANY(:job_ids)
                ORDER BY id
                """
            ),
            {"job_ids": [job.id for job in jobs]},
        ).all()
        assert sorted(rows) == [("pending", 0), ("running", 1)]
        assert complete_job(db, job_id=job_id, worker_id=worker_id)
        db.commit()
    assert _capacity_holder(engine) == (None, None, None, None)


def test_blocked_heavy_is_unchanged_and_light_work_proceeds(engine: Engine) -> None:
    heavy_kind = "heavy_capacity_block_probe"
    light_kind = "light_capacity_block_probe"
    with Session(engine) as db:
        admitted = enqueue_job(db, kind=heavy_kind, priority=0)
        blocked = enqueue_job(db, kind=heavy_kind, priority=1)
        light = enqueue_job(db, kind=light_kind, priority=2)
        db.commit()

        first = claim_job(
            db,
            job_id=admitted.id,
            worker_id="heavy-holder",
            lease_seconds=300,
            allowed_kinds=(heavy_kind, light_kind),
            heavy_kinds=(heavy_kind,),
        )
        db.commit()
        assert first is not None

        next_job = claim_next_job(
            db,
            worker_id="light-worker",
            lease_seconds=300,
            allowed_kinds=(heavy_kind, light_kind),
            heavy_kinds=(heavy_kind,),
        )
        db.commit()
        assert next_job is not None and next_job.id == light.id

        denied = claim_job(
            db,
            job_id=blocked.id,
            worker_id="denied-worker",
            lease_seconds=300,
            allowed_kinds=(heavy_kind, light_kind),
            heavy_kinds=(heavy_kind,),
        )
        db.commit()
        assert denied is None
        blocked_state = db.execute(
            text(
                """
                SELECT status, attempts, claimed_by, lease_expires_at
                FROM background_jobs
                WHERE id = :job_id
                """
            ),
            {"job_id": blocked.id},
        ).one()
        assert blocked_state == ("pending", 0, None, None)

        assert complete_job(db, job_id=light.id, worker_id="light-worker")
        assert complete_job(db, job_id=admitted.id, worker_id="heavy-holder")
        db.commit()


def test_open_light_publication_does_not_block_concurrent_heavy_admission(
    engine: Engine,
) -> None:
    """A Light publication transaction must never pin the single Heavy capacity row.

    Publication holds its transaction open for the whole artifact write, so a
    capacity lock taken there would serialize every lane behind one Light job.
    """
    heavy_kind = "heavy_publication_contention_probe"
    light_kind = "light_publication_contention_probe"
    with Session(engine) as db:
        heavy = enqueue_job(db, kind=heavy_kind, priority=0)
        light = enqueue_job(db, kind=light_kind, priority=0)
        db.commit()
        claimed_light = claim_job(
            db,
            job_id=light.id,
            worker_id="light-publication-worker",
            lease_seconds=300,
            allowed_kinds=(light_kind,),
            heavy_kinds=(heavy_kind,),
        )
        db.commit()
        assert claimed_light is not None

    with Session(engine) as publication:
        assert (
            lock_and_renew_running_job_claim(
                publication,
                context=JobExecutionContext(
                    job_id=light.id,
                    worker_id="light-publication-worker",
                    attempt_no=1,
                    resource_class="Light",
                ),
                lease_seconds=300,
            )
            is not None
        )

        with Session(engine) as admission:
            # A regression fails on this bounded wait instead of hanging the suite.
            admission.execute(text("SET LOCAL statement_timeout = '5s'"))
            try:
                admitted = claim_next_job(
                    admission,
                    worker_id="heavy-admission-worker",
                    lease_seconds=300,
                    allowed_kinds=(heavy_kind,),
                    heavy_kinds=(heavy_kind,),
                )
            except OperationalError as exc:
                pytest.fail(f"Heavy admission blocked behind an open Light publication: {exc}")
            admission.commit()

        assert admitted is not None and admitted.id == heavy.id
        assert _capacity_holder(engine)[:3] == (heavy.id, "heavy-admission-worker", 1)

    with Session(engine) as db:
        assert complete_job(db, job_id=heavy.id, worker_id="heavy-admission-worker")
        assert complete_job(db, job_id=light.id, worker_id="light-publication-worker")
        db.commit()
    assert _capacity_holder(engine) == (None, None, None, None)


def test_heavy_holder_follows_heartbeat_reschedule_failure_repair_and_completion(
    engine: Engine,
) -> None:
    kind = "heavy_transition_probe"
    with Session(engine) as db:
        job = enqueue_job(db, kind=kind, max_attempts=2)
        db.commit()
        claimed = claim_job(
            db,
            job_id=job.id,
            worker_id="transition-worker",
            lease_seconds=60,
            heavy_kinds=(kind,),
        )
        db.commit()
        assert claimed is not None

        assert heartbeat_job(
            db,
            job_id=job.id,
            worker_id="transition-worker",
            lease_seconds=120,
            resource_class="Heavy",
        )
        db.commit()
        job_lease = db.execute(
            text("SELECT lease_expires_at FROM background_jobs WHERE id = :job_id"),
            {"job_id": job.id},
        ).scalar_one()
        assert _capacity_holder(engine) == (job.id, "transition-worker", 1, job_lease)

        assert reschedule_running_job(
            db,
            job_id=job.id,
            worker_id="transition-worker",
            attempt_no=1,
            available_at=datetime.now(UTC),
        )
        db.commit()
        assert _capacity_holder(engine) == (None, None, None, None)

        reclaimed = claim_job(
            db,
            job_id=job.id,
            worker_id="transition-worker",
            lease_seconds=60,
            heavy_kinds=(kind,),
        )
        db.commit()
        assert reclaimed is not None and reclaimed.attempts == 1
        assert (
            fail_job(
                db,
                job_id=job.id,
                worker_id="transition-worker",
                error_code="E_PROBE",
                error_message="probe failure",
                retry_delays_seconds=(),
            )
            == "failed"
        )
        db.commit()
        assert _capacity_holder(engine) == (None, None, None, None)

        final_attempt = claim_job(
            db,
            job_id=job.id,
            worker_id="transition-worker",
            lease_seconds=60,
            heavy_kinds=(kind,),
        )
        db.commit()
        assert final_attempt is not None and final_attempt.attempts == 2
        assert (
            fail_job(
                db,
                job_id=job.id,
                worker_id="transition-worker",
                error_code="E_PROBE",
                error_message="probe failure",
                retry_delays_seconds=(),
            )
            == "dead"
        )
        db.commit()
        assert _capacity_holder(engine) == (None, None, None, None)

        assert requeue_dead_job(db, job_id=job.id)
        repaired = claim_job(
            db,
            job_id=job.id,
            worker_id="repair-worker",
            lease_seconds=60,
            heavy_kinds=(kind,),
        )
        db.commit()
        assert repaired is not None and repaired.attempts == 1
        assert complete_job(db, job_id=job.id, worker_id="repair-worker")
        db.commit()
        assert _capacity_holder(engine) == (None, None, None, None)


def test_dead_repair_defects_instead_of_reconciling_impossible_capacity(
    engine: Engine,
) -> None:
    kind = "heavy_dead_capacity_probe"
    with Session(engine) as db:
        job = enqueue_job(db, kind=kind, max_attempts=1)
        db.commit()
        assert (
            claim_job(
                db,
                job_id=job.id,
                worker_id="dead-capacity-worker",
                lease_seconds=60,
                heavy_kinds=(kind,),
            )
            is not None
        )
        assert (
            fail_job(
                db,
                job_id=job.id,
                worker_id="dead-capacity-worker",
                error_code="E_PROBE",
                error_message="probe failure",
                retry_delays_seconds=(),
            )
            == "dead"
        )
        db.commit()

        assign_dead_job_to_heavy_capacity(db, job_id=job.id)
        db.commit()
        with pytest.raises(AssertionError, match="dead job still owns Heavy capacity"):
            requeue_dead_job(db, job_id=job.id)
        db.rollback()
        clear_heavy_capacity_holder(db, job_id=job.id)
        db.commit()


def test_expired_heavy_reclaim_is_fenced_and_records_worker_interruption(engine: Engine) -> None:
    kind = "heavy_expiry_probe"
    with Session(engine) as db:
        job = enqueue_job(db, kind=kind, max_attempts=2)
        db.commit()
        first = claim_job(
            db,
            job_id=job.id,
            worker_id="expired-worker",
            lease_seconds=300,
            heavy_kinds=(kind,),
        )
        assert first is not None
        expire_heavy_job_claim(db, job_id=job.id)
        db.commit()

        recovered = claim_job(
            db,
            job_id=job.id,
            worker_id="recovery-worker",
            lease_seconds=300,
            heavy_kinds=(kind,),
        )
        db.commit()
        assert recovered is not None
        assert recovered.attempts == 2
        assert recovered.error_code == "E_WORKER_INTERRUPTED"
        assert (
            heartbeat_job(
                db,
                job_id=job.id,
                worker_id="expired-worker",
                lease_seconds=300,
                resource_class="Heavy",
            )
            is False
        )
        assert complete_job(db, job_id=job.id, worker_id="expired-worker") is False
        assert _capacity_holder(engine)[:3] == (job.id, "recovery-worker", 2)
        assert complete_job(db, job_id=job.id, worker_id="recovery-worker")
        db.commit()

        exhausted = enqueue_job(db, kind=kind, max_attempts=1)
        db.commit()
        assert (
            claim_job(
                db,
                job_id=exhausted.id,
                worker_id="dead-worker",
                lease_seconds=300,
                heavy_kinds=(kind,),
            )
            is not None
        )
        expire_heavy_job_claim(db, job_id=exhausted.id)
        db.commit()

        dead = dead_letter_expired_job(db, allowed_kinds=(kind,))
        db.commit()
        assert dead is not None and dead.id == exhausted.id
        assert dead.error_code == "E_WORKER_INTERRUPTED"
        assert _capacity_holder(engine) == (None, None, None, None)


def test_heavy_renewal_rejects_missing_or_different_capacity_holder(engine: Engine) -> None:
    kind = "heavy_missing_holder_probe"
    with Session(engine) as db:
        orphaned = enqueue_job(db, kind=kind, priority=0)
        other = enqueue_job(db, kind=kind, priority=1)
        db.commit()
        first = claim_job(
            db,
            job_id=orphaned.id,
            worker_id="orphaned-worker",
            lease_seconds=300,
            heavy_kinds=(kind,),
        )
        assert first is not None
        clear_heavy_capacity_holder(db, job_id=orphaned.id)
        db.commit()

        lease_before = db.execute(
            text("SELECT lease_expires_at FROM background_jobs WHERE id = :job_id"),
            {"job_id": orphaned.id},
        ).scalar_one()
        assert (
            heartbeat_job(
                db,
                job_id=orphaned.id,
                worker_id="orphaned-worker",
                lease_seconds=600,
                resource_class="Heavy",
            )
            is False
        )
        assert (
            lock_and_renew_running_job_claim(
                db,
                context=JobExecutionContext(
                    job_id=orphaned.id,
                    worker_id="orphaned-worker",
                    attempt_no=1,
                    resource_class="Heavy",
                ),
                lease_seconds=600,
            )
            is None
        )
        db.commit()
        assert (
            db.execute(
                text("SELECT lease_expires_at FROM background_jobs WHERE id = :job_id"),
                {"job_id": orphaned.id},
            ).scalar_one()
            == lease_before
        )

        second = claim_job(
            db,
            job_id=other.id,
            worker_id="other-worker",
            lease_seconds=300,
            heavy_kinds=(kind,),
        )
        db.commit()
        assert second is not None
        assert _capacity_holder(engine)[:3] == (other.id, "other-worker", 1)
        assert (
            heartbeat_job(
                db,
                job_id=orphaned.id,
                worker_id="orphaned-worker",
                lease_seconds=600,
                resource_class="Heavy",
            )
            is False
        )
        assert (
            lock_and_renew_running_job_claim(
                db,
                context=JobExecutionContext(
                    job_id=orphaned.id,
                    worker_id="orphaned-worker",
                    attempt_no=1,
                    resource_class="Heavy",
                ),
                lease_seconds=600,
            )
            is None
        )
        db.rollback()
        assert complete_job(db, job_id=other.id, worker_id="other-worker")
        assert complete_job(db, job_id=orphaned.id, worker_id="orphaned-worker")
        db.commit()
        assert _capacity_holder(engine) == (None, None, None, None)
