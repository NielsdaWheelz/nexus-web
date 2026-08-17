from __future__ import annotations

import threading
import time
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
    revoke_jobs_by_dedupe_keys,
)
from nexus.jobs.registry import JobDefinition
from nexus.jobs.worker import JobWorker, _terminal_resource_failure
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
    "heavy_open_publication_contention_probe",
    "light_publication_contention_probe",
    "heavy_claim_complete_order_probe",
    "heavy_revoke_claim_order_probe",
)


def _resource_class_handler(*, payload: object, context: JobExecutionContext) -> dict[str, object]:
    return {"resource_class": context.resource_class}


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


def _wait_for_backend_lock(engine: Engine, backend_pid: int) -> None:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        with engine.connect() as connection:
            wait_event_type = connection.execute(
                text("SELECT wait_event_type FROM pg_stat_activity WHERE pid = :pid"),
                {"pid": backend_pid},
            ).scalar_one_or_none()
        if wait_event_type == "Lock":
            return
    raise AssertionError(f"backend {backend_pid} did not reach its expected lock wait")


def test_worker_threads_registry_resource_class_into_execution_context(engine: Engine) -> None:
    kind = "heavy_worker_context_probe"

    with Session(engine) as db:
        enqueue_job(db, kind=kind, priority=0)
        db.commit()
    worker = JobWorker(
        session_factory=create_session_factory(engine),
        worker_id="heavy-context-worker",
        registry={
            kind: JobDefinition(
                kind=kind,
                handler_path="tests.service.test_heavy_job_capacity:_resource_class_handler",
                resource_class="Heavy",
            )
        },
        allowed_kinds=(kind,),
    )

    assert worker.run_once() is True
    with Session(engine) as db:
        result = db.scalar(
            text("SELECT result FROM background_jobs WHERE kind = :kind"),
            {"kind": kind},
        )
    assert result == {"resource_class": "Heavy"}
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


def test_heavy_claim_and_completion_cannot_form_an_inverse_lock_cycle(engine: Engine) -> None:
    kind = "heavy_claim_complete_order_probe"
    with Session(engine) as db:
        holder = enqueue_job(db, kind=kind, priority=0)
        candidate = enqueue_job(db, kind=kind, priority=1)
        db.commit()
        assert (
            claim_job(
                db,
                job_id=holder.id,
                worker_id="lock-order-holder",
                lease_seconds=300,
                heavy_kinds=(kind,),
            )
            is not None
        )
        db.commit()

    holder_locked = threading.Event()
    complete_now = threading.Event()
    completion_done = threading.Event()
    claim_backend_ready = threading.Event()
    claim_backend_pid: list[int] = []
    outcomes: list[tuple[str, object]] = []
    failures: list[BaseException] = []

    def complete_holder() -> None:
        try:
            with Session(engine) as db:
                db.execute(text("SET LOCAL statement_timeout = '5s'"))
                db.execute(
                    text("SELECT id FROM background_jobs WHERE id = :job_id FOR UPDATE"),
                    {"job_id": holder.id},
                ).one()
                holder_locked.set()
                assert complete_now.wait(timeout=5)
                completed = complete_job(
                    db,
                    job_id=holder.id,
                    worker_id="lock-order-holder",
                )
                db.commit()
                outcomes.append(("complete", completed))
        except BaseException as exc:
            failures.append(exc)
        finally:
            completion_done.set()

    def claim_candidate() -> None:
        try:
            with Session(engine) as db:
                db.execute(text("SET LOCAL statement_timeout = '5s'"))
                claim_backend_pid.append(int(db.scalar(text("SELECT pg_backend_pid()"))))
                claim_backend_ready.set()
                claimed = claim_job(
                    db,
                    job_id=candidate.id,
                    worker_id="lock-order-candidate",
                    lease_seconds=300,
                    heavy_kinds=(kind,),
                )
                db.commit()
                outcomes.append(("claim", claimed.id if claimed is not None else None))
        except BaseException as exc:
            failures.append(exc)

    with Session(engine) as candidate_blocker:
        candidate_blocker.execute(
            text("SELECT id FROM background_jobs WHERE id = :job_id FOR UPDATE"),
            {"job_id": candidate.id},
        ).one()
        completion_thread = threading.Thread(target=complete_holder)
        completion_thread.start()
        assert holder_locked.wait(timeout=5)
        claim_thread = threading.Thread(target=claim_candidate)
        claim_thread.start()
        assert claim_backend_ready.wait(timeout=5)
        _wait_for_backend_lock(engine, claim_backend_pid[0])
        complete_now.set()
        assert completion_done.wait(timeout=5), (
            "completion blocked behind capacity held before the candidate job lock"
        )
        candidate_blocker.commit()

    completion_thread.join(timeout=5)
    claim_thread.join(timeout=5)
    assert not completion_thread.is_alive() and not claim_thread.is_alive(), (
        "claim and completion deadlocked"
    )
    assert not failures, f"claim/completion concurrency failed: {failures!r}"
    assert ("complete", True) in outcomes
    assert ("claim", candidate.id) in outcomes
    assert _capacity_holder(engine)[:3] == (
        candidate.id,
        "lock-order-candidate",
        1,
    )
    with Session(engine) as db:
        assert complete_job(
            db,
            job_id=candidate.id,
            worker_id="lock-order-candidate",
        )
        db.commit()


def test_revoke_serializes_before_claim_and_clears_any_new_heavy_holder(engine: Engine) -> None:
    kind = "heavy_revoke_claim_order_probe"
    dedupe_key = "heavy-revoke-claim-order"
    with Session(engine) as db:
        target = enqueue_job(db, kind=kind, dedupe_key=dedupe_key)
        db.commit()

    claim_backend_ready = threading.Event()
    revoke_backend_ready = threading.Event()
    claim_backend_pid: list[int] = []
    revoke_backend_pid: list[int] = []
    outcomes: list[tuple[str, object]] = []
    failures: list[BaseException] = []

    def claim_target() -> None:
        try:
            with Session(engine) as db:
                db.execute(text("SET LOCAL statement_timeout = '5s'"))
                claim_backend_pid.append(int(db.scalar(text("SELECT pg_backend_pid()"))))
                claim_backend_ready.set()
                claimed = claim_job(
                    db,
                    job_id=target.id,
                    worker_id="revoke-race-claimant",
                    lease_seconds=300,
                    heavy_kinds=(kind,),
                )
                db.commit()
                outcomes.append(("claim", claimed.id if claimed is not None else None))
        except BaseException as exc:
            failures.append(exc)

    def revoke_target() -> None:
        try:
            with Session(engine) as db:
                db.execute(text("SET LOCAL statement_timeout = '5s'"))
                revoke_backend_pid.append(int(db.scalar(text("SELECT pg_backend_pid()"))))
                revoke_backend_ready.set()
                revoke_jobs_by_dedupe_keys(db, kind=kind, dedupe_keys=(dedupe_key,))
                db.commit()
                outcomes.append(("revoke", True))
        except BaseException as exc:
            failures.append(exc)

    with Session(engine) as blocker:
        blocker.execute(
            text("SELECT id FROM background_jobs WHERE id = :job_id FOR UPDATE"),
            {"job_id": target.id},
        ).one()
        claim_thread = threading.Thread(target=claim_target)
        claim_thread.start()
        assert claim_backend_ready.wait(timeout=5)
        _wait_for_backend_lock(engine, claim_backend_pid[0])
        revoke_thread = threading.Thread(target=revoke_target)
        revoke_thread.start()
        assert revoke_backend_ready.wait(timeout=5)
        _wait_for_backend_lock(engine, revoke_backend_pid[0])
        blocker.commit()

    claim_thread.join(timeout=5)
    revoke_thread.join(timeout=5)
    assert not claim_thread.is_alive() and not revoke_thread.is_alive(), (
        "revoke and claim deadlocked"
    )
    assert not failures, f"revoke/claim concurrency failed: {failures!r}"
    assert ("claim", target.id) in outcomes
    assert ("revoke", True) in outcomes
    with Session(engine) as oracle:
        assert (
            oracle.scalar(
                text("SELECT count(*) FROM background_jobs WHERE id = :job_id"),
                {"job_id": target.id},
            )
            == 0
        )
    assert _capacity_holder(engine) == (None, None, None, None)


def test_concurrent_heavy_heartbeat_and_resource_settlement_share_one_lock_order(
    engine: Engine,
) -> None:
    kind = "heavy_transition_probe"
    for index in range(5):
        worker_id = f"heavy-transition-worker-{index}"
        with Session(engine) as db:
            job = enqueue_job(db, kind=kind, priority=0, max_attempts=3)
            db.commit()
            claimed = claim_job(
                db,
                job_id=job.id,
                worker_id=worker_id,
                lease_seconds=30,
                allowed_kinds=(kind,),
                heavy_kinds=(kind,),
            )
            db.commit()
        assert claimed is not None

        barrier = threading.Barrier(2)
        outcomes: list[tuple[str, bool]] = []
        failures: list[BaseException] = []

        def heartbeat(
            *,
            claimed=claimed,
            worker_id=worker_id,
            barrier=barrier,
            outcomes=outcomes,
            failures=failures,
        ) -> None:
            try:
                with Session(engine) as db:
                    db.execute(text("SET LOCAL statement_timeout = '5s'"))
                    barrier.wait()
                    renewed = heartbeat_job(
                        db,
                        job_id=claimed.id,
                        worker_id=worker_id,
                        lease_seconds=30,
                        resource_class="Heavy",
                    )
                    db.commit()
                    outcomes.append(("heartbeat", renewed))
            except BaseException as exc:
                failures.append(exc)

        def settle(
            *,
            claimed=claimed,
            worker_id=worker_id,
            barrier=barrier,
            outcomes=outcomes,
            failures=failures,
        ) -> None:
            try:
                with Session(engine) as db:
                    db.execute(text("SET LOCAL statement_timeout = '5s'"))
                    barrier.wait()
                    settled = _terminal_resource_failure(
                        db,
                        claimed=claimed,
                        worker_id=worker_id,
                        projection="Job",
                        dimension="Memory",
                    )
                    db.commit()
                    outcomes.append(("settlement", bool(settled)))
            except BaseException as exc:
                failures.append(exc)

        threads = [threading.Thread(target=heartbeat), threading.Thread(target=settle)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        assert not [thread for thread in threads if thread.is_alive()], (
            "queue transitions deadlocked"
        )
        assert not failures, f"concurrent queue transition failed: {failures!r}"
        assert ("settlement", True) in outcomes
        with Session(engine) as oracle:
            row = oracle.execute(
                text(
                    """
                    SELECT status, attempts, claimed_by, lease_expires_at, error_code, result
                    FROM background_jobs
                    WHERE id = :job_id
                    """
                ),
                {"job_id": claimed.id},
            ).one()
        assert tuple(row) == (
            "dead",
            1,
            None,
            None,
            "E_RESOURCE_LIMIT",
            {"kind": "ResourceFailure", "dimension": "Memory"},
        )
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


def test_open_heavy_publication_retains_capacity_until_its_commit(engine: Engine) -> None:
    kind = "heavy_open_publication_contention_probe"
    with Session(engine) as db:
        holder = enqueue_job(db, kind=kind, priority=0)
        candidate = enqueue_job(db, kind=kind, priority=1)
        db.commit()
        claimed_holder = claim_job(
            db,
            job_id=holder.id,
            worker_id="heavy-publication-worker",
            lease_seconds=60,
            allowed_kinds=(kind,),
            heavy_kinds=(kind,),
        )
        db.commit()
        assert claimed_holder is not None

    backend_ready = threading.Event()
    backend_pid: list[int] = []
    outcomes: list[UUID | None] = []
    failures: list[BaseException] = []

    def admit_candidate() -> None:
        try:
            with Session(engine) as db:
                db.execute(text("SET LOCAL statement_timeout = '5s'"))
                backend_pid.append(int(db.scalar(text("SELECT pg_backend_pid()"))))
                backend_ready.set()
                claimed = claim_job(
                    db,
                    job_id=candidate.id,
                    worker_id="blocked-heavy-candidate",
                    lease_seconds=60,
                    allowed_kinds=(kind,),
                    heavy_kinds=(kind,),
                )
                db.commit()
                outcomes.append(claimed.id if claimed is not None else None)
        except BaseException as exc:
            failures.append(exc)

    with Session(engine) as publication:
        renewed_holder = lock_and_renew_running_job_claim(
            publication,
            context=JobExecutionContext(
                job_id=holder.id,
                worker_id="heavy-publication-worker",
                attempt_no=1,
                resource_class="Heavy",
            ),
            lease_seconds=300,
        )
        assert renewed_holder is not None
        assert _capacity_holder(engine)[:3] == (
            holder.id,
            "heavy-publication-worker",
            1,
        )
        admission_thread = threading.Thread(target=admit_candidate)
        admission_thread.start()
        assert backend_ready.wait(timeout=5)
        _wait_for_backend_lock(engine, backend_pid[0])
        with engine.connect() as oracle:
            assert oracle.execute(
                text(
                    """
                    SELECT status, attempts, claimed_by
                    FROM background_jobs
                    WHERE id = :job_id
                    """
                ),
                {"job_id": candidate.id},
            ).one() == ("pending", 0, None)
        publication.commit()

    admission_thread.join(timeout=5)
    assert not admission_thread.is_alive(), "Heavy admission remained blocked after publication"
    assert not failures, f"Heavy publication/admission concurrency failed: {failures!r}"
    assert outcomes == [None]
    with Session(engine) as db:
        candidate_state = db.execute(
            text(
                """
                SELECT status, attempts, claimed_by
                FROM background_jobs
                WHERE id = :job_id
                """
            ),
            {"job_id": candidate.id},
        ).one()
        assert candidate_state == ("pending", 0, None)
        assert complete_job(
            db,
            job_id=holder.id,
            worker_id="heavy-publication-worker",
        )
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
