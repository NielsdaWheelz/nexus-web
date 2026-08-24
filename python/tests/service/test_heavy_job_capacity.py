from __future__ import annotations

import threading
import time
from collections.abc import Generator
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from nexus.db.session import create_session_factory
from nexus.jobs.queue import (
    JobExecutionContext,
    ScheduleAt,
    claim_job,
    claim_next_job,
    complete_job,
    dead_letter_expired_job,
    enqueue_job,
    fail_job,
    get_job,
    heartbeat_job,
    lock_and_renew_running_job_claim,
    requeue_dead_job,
    reschedule_running_job,
    revoke_jobs_for_payload,
)
from nexus.jobs.registry import JobDefinition, get_default_registry
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
    "heavy_lock_order_probe",
    "heavy_heartbeat_boundary_probe",
    "heartbeat_unrelated_state_probe",
    "heavy_light_drift_probe",
    "heavy_dead_capacity_probe",
    "heavy_expiry_probe",
    "heavy_same_worker_reclaim_probe",
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


def _wait_for_backend_blocked_by(
    engine: Engine,
    *,
    blocking_pid: int,
) -> int | None:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        with Session(engine) as db:
            waiting_pid = db.scalar(
                text(
                    """
                    SELECT pid
                    FROM pg_stat_activity
                    WHERE :blocking_pid = ANY(pg_blocking_pids(pid))
                      AND query LIKE '%UPDATE background_jobs%'
                    ORDER BY pid
                    LIMIT 1
                    """
                ),
                {"blocking_pid": blocking_pid},
            )
        if waiting_pid is not None:
            return int(waiting_pid)
    return None


def test_worker_threads_registry_resource_class_into_execution_context(
    engine: Engine,
) -> None:
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


@pytest.mark.parametrize("holder_kind", ["ingest_media_source", "media_content_reindex_job"])
def test_metadata_is_heavy_and_excludes_parser_and_reindex_capacity(
    engine: Engine,
    holder_kind: str,
) -> None:
    registry = get_default_registry()
    assert registry["enrich_metadata"].resource_class == "Heavy"
    assert registry[holder_kind].resource_class == "Heavy"
    heavy_kinds = tuple(
        definition.kind for definition in registry.values() if definition.resource_class == "Heavy"
    )
    token = uuid4().hex
    payload = {"capacity_probe": token}

    try:
        with Session(engine) as db:
            holder = enqueue_job(db, kind=holder_kind, payload=payload, priority=0)
            metadata = enqueue_job(
                db,
                kind="enrich_metadata",
                payload={**payload, "capacity_wait_index": 0},
                priority=1,
                max_attempts=2,
            )
            db.commit()

            admitted = claim_job(
                db,
                job_id=holder.id,
                worker_id=f"{holder_kind}-capacity-holder",
                lease_seconds=300,
                allowed_kinds=(holder_kind, "enrich_metadata"),
                heavy_kinds=heavy_kinds,
            )
            db.commit()
            assert admitted is not None and admitted.id == holder.id

            assert (
                claim_job(
                    db,
                    job_id=metadata.id,
                    worker_id="metadata-capacity-contender",
                    lease_seconds=300,
                    allowed_kinds=(holder_kind, "enrich_metadata"),
                    heavy_kinds=heavy_kinds,
                )
                is None
            )
            unchanged = get_job(db, metadata.id)
            assert unchanged is not None
            assert (unchanged.status, unchanged.attempts, unchanged.claimed_by) == (
                "pending",
                0,
                None,
            )

            assert complete_job(
                db,
                job_id=holder.id,
                worker_id=f"{holder_kind}-capacity-holder",
            )
            db.commit()
            metadata_claim = claim_job(
                db,
                job_id=metadata.id,
                worker_id="metadata-capacity-worker",
                lease_seconds=300,
                allowed_kinds=(holder_kind, "enrich_metadata"),
                heavy_kinds=heavy_kinds,
            )
            db.commit()
            assert metadata_claim is not None and metadata_claim.id == metadata.id
            assert complete_job(
                db,
                job_id=metadata.id,
                worker_id="metadata-capacity-worker",
            )
            db.commit()
    finally:
        with Session(engine) as db:
            revoke_jobs_for_payload(db, kind=holder_kind, expected_payload_match=payload)
            revoke_jobs_for_payload(
                db,
                kind="enrich_metadata",
                expected_payload_match=payload,
            )
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


def test_heavy_heartbeat_never_pins_capacity_while_waiting_on_the_job_row(
    engine: Engine,
) -> None:
    """Risk: heartbeat holds the single Heavy capacity row across a blocked job wait.

    A publication transaction may hold the job row FOR UPDATE for its whole
    artifact write. The heartbeat that blocks behind it must not be holding the
    global Heavy capacity row meanwhile, or every other lane's claim stalls
    behind one publication.
    """
    kind = "heavy_lock_order_probe"
    worker_id = "heavy-lock-order-worker"
    with Session(engine) as db:
        job = enqueue_job(db, kind=kind, priority=0)
        db.commit()
        claimed = claim_job(
            db,
            job_id=job.id,
            worker_id=worker_id,
            lease_seconds=300,
            allowed_kinds=(kind,),
            heavy_kinds=(kind,),
        )
        db.commit()
        assert claimed is not None

    with Session(engine) as before:
        lease_before = before.execute(
            text(
                """
                SELECT lease_expires_at
                FROM background_job_capacity_leases
                WHERE resource_class = 'Heavy'
                """
            )
        ).scalar_one()

    heartbeat_ready = threading.Event()
    heartbeat_results: list[bool] = []
    heartbeat_failures: list[BaseException] = []
    session_factory = create_session_factory(engine)

    def run_heartbeat() -> None:
        try:
            heartbeat_ready.set()
            heartbeat_results.append(
                heartbeat_job(
                    session_factory=session_factory,
                    context=JobExecutionContext(
                        job_id=job.id,
                        worker_id=worker_id,
                        attempt_no=claimed.attempts,
                        resource_class="Heavy",
                    ),
                    lease_seconds=300,
                )
            )
        except BaseException as exc:
            heartbeat_failures.append(exc)

    publication = Session(engine)
    heartbeat_thread = threading.Thread(target=run_heartbeat)
    heartbeat_started = False
    try:
        publication_pid = int(publication.scalar(text("SELECT pg_backend_pid()")))
        assert (
            lock_and_renew_running_job_claim(
                publication,
                context=JobExecutionContext(
                    job_id=job.id,
                    worker_id=worker_id,
                    attempt_no=1,
                    resource_class="Heavy",
                ),
                lease_seconds=300,
            )
            is not None
        )

        heartbeat_thread.start()
        heartbeat_started = True
        assert heartbeat_ready.wait(timeout=5), "Heavy heartbeat did not start"
        heartbeat_pid = _wait_for_backend_blocked_by(
            engine,
            blocking_pid=publication_pid,
        )
        assert heartbeat_pid is not None, (
            "Heavy heartbeat did not reach the job-row lock wait; "
            f"publication_pid={publication_pid}, job_id={job.id}"
        )

        # The true invariant: while the heartbeat queues behind the publication's
        # job-row lock, it holds nothing else, so the single Heavy capacity row is
        # free to lock RIGHT NOW. NOWAIT makes that unforgeable -- any pinned
        # capacity row raises 55P03 instead of queueing. Under the round-1
        # single-transaction heartbeat (capacity FOR UPDATE, then the job-row
        # UPDATE in the same transaction) the blocked heartbeat still held the
        # capacity lock here, so this probe failed with lock_not_available; that
        # is the regression this guards. Note claim_next_job cannot serve as
        # this probe: its own admission path locks the HOLDER'S job row FOR
        # UPDATE (_heavy_capacity_is_available), so it legitimately queues behind
        # the publication regardless of what the heartbeat holds.
        with Session(engine) as probe:
            try:
                capacity_row = probe.execute(
                    text(
                        """
                        SELECT job_id, worker_id, attempt_no, lease_expires_at
                        FROM background_job_capacity_leases
                        WHERE resource_class = 'Heavy'
                        FOR UPDATE NOWAIT
                        """
                    )
                ).one()
            except OperationalError as exc:
                if getattr(exc.orig, "sqlstate", None) != "55P03":
                    raise
                probe.rollback()
                pytest.fail(
                    "Heavy heartbeat pinned the capacity row while waiting on the job "
                    f"row; every other lane's claim would stall behind the publication "
                    f"of job {job.id}"
                )
            observed_holder = tuple(capacity_row[:3])
            observed_lease = capacity_row.lease_expires_at
            probe.rollback()
        assert observed_holder == (job.id, worker_id, 1)
        # The capacity renewal follows the job renewal, so while the heartbeat
        # waits on the job row the capacity lease is still the claim's: a
        # capacity lease can never run ahead of the holder it fences.
        assert observed_lease == lease_before
    finally:
        publication.rollback()
        publication.close()
        if heartbeat_started:
            # Bounded completion: once the publication ends, the heartbeat's
            # job-row transaction proceeds immediately -- no deadlock against the
            # capacity->job lock order every other Heavy transition uses.
            heartbeat_thread.join(timeout=10)
        if not heartbeat_thread.is_alive():
            with Session(engine) as observer:
                renewed_job, renewed_capacity = observer.execute(
                    text(
                        """
                        SELECT holder.lease_expires_at, capacity.lease_expires_at
                        FROM background_job_capacity_leases capacity
                        JOIN background_jobs holder ON holder.id = capacity.job_id
                        WHERE capacity.resource_class = 'Heavy'
                        """
                    )
                ).one()
            with Session(engine) as cleanup:
                current = get_job(cleanup, job.id)
                if current is not None and current.status == "running":
                    assert complete_job(cleanup, job_id=job.id, worker_id=worker_id)
                cleanup.commit()

    assert heartbeat_started
    assert not heartbeat_thread.is_alive(), "Heavy heartbeat did not finish after job release"
    assert not heartbeat_failures, f"Heavy heartbeat failed: {heartbeat_failures!r}"
    assert heartbeat_results == [True]
    # Once both owned transactions committed, the capacity lease is exactly the
    # holder's committed job lease -- the same instant claim admission wrote.
    assert renewed_capacity == renewed_job > lease_before
    assert _capacity_holder(engine) == (None, None, None, None)


def test_heavy_heartbeat_partial_commit_never_leaves_capacity_ahead_of_its_holder(
    engine: Engine,
) -> None:
    """Risk: a crash between the heartbeat's two commits reserves the Heavy slot past
    its holder's own expiry, blocking every Heavy claim across all replicas.

    The heartbeat is an operation boundary whose only injectable seam is the
    session factory it owns; losing the database between its two owned
    transactions is the crash the split introduces. Whatever the partial state,
    the occupancy predicate must free the slot at the holder job's true expiry,
    which holds only while the capacity lease never runs ahead of the job lease.
    """
    kind = "heavy_partial_commit_probe"
    worker_id = "heavy-partial-commit-worker"
    with Session(engine) as db:
        job = enqueue_job(db, kind=kind, priority=0)
        db.commit()
        claimed = claim_job(
            db,
            job_id=job.id,
            worker_id=worker_id,
            lease_seconds=300,
            allowed_kinds=(kind,),
            heavy_kinds=(kind,),
        )
        db.commit()
        assert claimed is not None
    holder_before = _capacity_holder(engine)

    real_factory = create_session_factory(engine)
    sessions_opened = 0

    def factory_lost_after_first_transaction() -> Session:
        nonlocal sessions_opened
        sessions_opened += 1
        if sessions_opened > 1:
            raise OperationalError("connection lost between heartbeat transactions", {}, None)
        return real_factory()

    with pytest.raises(OperationalError):
        heartbeat_job(
            session_factory=factory_lost_after_first_transaction,
            context=JobExecutionContext(
                job_id=job.id,
                worker_id=worker_id,
                attempt_no=claimed.attempts,
                resource_class="Heavy",
            ),
            lease_seconds=900,
        )
    assert sessions_opened == 2

    with Session(engine) as observer:
        job_lease, capacity_lease = observer.execute(
            text(
                """
                SELECT holder.lease_expires_at, capacity.lease_expires_at
                FROM background_job_capacity_leases capacity
                JOIN background_jobs holder ON holder.id = capacity.job_id
                WHERE capacity.resource_class = 'Heavy'
                """
            )
        ).one()
    assert job_lease > holder_before[3], "the job renewal must have committed first"
    assert capacity_lease <= job_lease, (
        "a partial heartbeat commit left the Heavy capacity lease ahead of its holder"
    )

    # The slot is still held while the holder is alive ...
    with Session(engine) as probe:
        assert (
            claim_job(
                probe,
                job_id=enqueue_job(probe, kind=kind, priority=0).id,
                worker_id="heavy-partial-commit-rival",
                lease_seconds=300,
                allowed_kinds=(kind,),
                heavy_kinds=(kind,),
            )
            is None
        )
        probe.rollback()

    # ... and a completed heartbeat lands both leases on one instant again.
    assert heartbeat_job(
        session_factory=real_factory,
        context=JobExecutionContext(
            job_id=job.id,
            worker_id=worker_id,
            attempt_no=claimed.attempts,
            resource_class="Heavy",
        ),
        lease_seconds=300,
    )
    with Session(engine) as observer:
        job_lease, capacity_lease = observer.execute(
            text(
                """
                SELECT holder.lease_expires_at, capacity.lease_expires_at
                FROM background_job_capacity_leases capacity
                JOIN background_jobs holder ON holder.id = capacity.job_id
                WHERE capacity.resource_class = 'Heavy'
                """
            )
        ).one()
    assert capacity_lease == job_lease

    with Session(engine) as cleanup:
        assert complete_job(cleanup, job_id=job.id, worker_id=worker_id)
        cleanup.commit()
    assert _capacity_holder(engine) == (None, None, None, None)


def test_heavy_heartbeat_owns_transactions_without_committing_caller_state(
    engine: Engine,
) -> None:
    """Heartbeat commits only its two queue-owned transactions.

    A caller may have unrelated work staged in its own Session. The heartbeat
    operation must use fresh sessions for its capacity and job renewals, leaving
    that caller transaction invisible and rollbackable.
    """
    heartbeat_kind = "heavy_heartbeat_boundary_probe"
    with Session(engine) as setup:
        heartbeat_target = enqueue_job(setup, kind=heartbeat_kind)
        setup.commit()
        claimed = claim_job(
            setup,
            job_id=heartbeat_target.id,
            worker_id="heartbeat-boundary-worker",
            lease_seconds=300,
            heavy_kinds=(heartbeat_kind,),
        )
        setup.commit()
        assert claimed is not None

    session_factory = create_session_factory(engine)
    with Session(engine) as caller:
        unrelated = enqueue_job(caller, kind="heartbeat_unrelated_state_probe")

        assert heartbeat_job(
            session_factory=session_factory,
            context=JobExecutionContext(
                job_id=heartbeat_target.id,
                worker_id="heartbeat-boundary-worker",
                attempt_no=claimed.attempts,
                resource_class="Heavy",
            ),
            lease_seconds=600,
        )

        with Session(engine) as observer:
            assert get_job(observer, unrelated.id) is None
        caller.rollback()

    with Session(engine) as cleanup:
        assert complete_job(
            cleanup,
            job_id=heartbeat_target.id,
            worker_id="heartbeat-boundary-worker",
        )
        cleanup.commit()
    assert _capacity_holder(engine) == (None, None, None, None)


def test_light_heartbeat_refuses_attempt_that_holds_heavy_capacity(
    engine: Engine,
) -> None:
    """Resource-class drift: a redeploy demotes a running kind from Heavy to Light.

    The attempt still holds the single Heavy capacity row it was admitted under,
    but a Light heartbeat never renews capacity. Renewing only the job lease
    would keep the attempt alive while its capacity lease expired underneath it,
    so the heartbeat must refuse (False) and leave both leases untouched. Round-2
    regressed this to a plain job-lease renewal; this pins the restored refusal.
    """
    kind = "heavy_light_drift_probe"
    worker_id = "light-drift-worker"
    session_factory = create_session_factory(engine)
    with Session(engine) as db:
        job = enqueue_job(db, kind=kind)
        db.commit()
        claimed = claim_job(
            db,
            job_id=job.id,
            worker_id=worker_id,
            lease_seconds=300,
            heavy_kinds=(kind,),
        )
        db.commit()
        assert claimed is not None
        holder_before = _capacity_holder(engine)
        assert holder_before[:3] == (job.id, worker_id, 1)
        job_lease_before = db.execute(
            text("SELECT lease_expires_at FROM background_jobs WHERE id = :job_id"),
            {"job_id": job.id},
        ).scalar_one()

        assert (
            heartbeat_job(
                session_factory=session_factory,
                context=JobExecutionContext(
                    job_id=job.id,
                    worker_id=worker_id,
                    attempt_no=claimed.attempts,
                    resource_class="Light",
                ),
                lease_seconds=600,
            )
            is False
        )
        db.commit()
        assert (
            db.execute(
                text("SELECT lease_expires_at FROM background_jobs WHERE id = :job_id"),
                {"job_id": job.id},
            ).scalar_one()
            == job_lease_before
        ), "a refused Light heartbeat must not renew the job lease"
        assert _capacity_holder(engine) == holder_before

        # The same attempt heartbeating under its true class still renews.
        assert heartbeat_job(
            session_factory=session_factory,
            context=JobExecutionContext(
                job_id=job.id,
                worker_id=worker_id,
                attempt_no=claimed.attempts,
                resource_class="Heavy",
            ),
            lease_seconds=600,
        )
        db.commit()
        assert complete_job(db, job_id=job.id, worker_id=worker_id)
        db.commit()
    assert _capacity_holder(engine) == (None, None, None, None)


def test_heavy_holder_follows_heartbeat_reschedule_failure_repair_and_completion(
    engine: Engine,
) -> None:
    kind = "heavy_transition_probe"
    session_factory = create_session_factory(engine)
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
        claim_capacity_lease = _capacity_holder(engine)[3]

        assert heartbeat_job(
            session_factory=session_factory,
            context=JobExecutionContext(
                job_id=job.id,
                worker_id="transition-worker",
                attempt_no=claimed.attempts,
                resource_class="Heavy",
            ),
            lease_seconds=120,
        )
        db.commit()
        job_lease = db.execute(
            text("SELECT lease_expires_at FROM background_jobs WHERE id = :job_id"),
            {"job_id": job.id},
        ).scalar_one()
        holder_job, holder_worker, holder_attempt, capacity_lease = _capacity_holder(engine)
        assert (holder_job, holder_worker, holder_attempt) == (
            job.id,
            "transition-worker",
            1,
        )
        # The two-transaction heartbeat renews the capacity lease first and the
        # job lease after, each from its own commit-time clock, so the leases
        # advance independently: capacity beyond its claim-time value, and the
        # job lease at or beyond the capacity lease it fences.
        assert capacity_lease > claim_capacity_lease
        assert job_lease >= capacity_lease

        assert reschedule_running_job(
            db,
            job_id=job.id,
            worker_id="transition-worker",
            attempt_no=1,
            schedule=ScheduleAt(datetime.now(UTC)),
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


def test_expired_heavy_reclaim_is_fenced_and_records_worker_interruption(
    engine: Engine,
) -> None:
    kind = "heavy_expiry_probe"
    session_factory = create_session_factory(engine)
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
                session_factory=session_factory,
                context=JobExecutionContext(
                    job_id=job.id,
                    worker_id="expired-worker",
                    attempt_no=first.attempts,
                    resource_class="Heavy",
                ),
                lease_seconds=300,
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


def test_heavy_heartbeat_fences_stale_attempt_after_same_worker_id_reclaim(
    engine: Engine,
) -> None:
    """An attempt number, not worker identity alone, owns each heartbeat.

    Worker identifiers may be stable across a process restart. If attempt 1
    expires and that same worker identifier reclaims the job as attempt 2, a
    delayed attempt-1 heartbeat must not renew either attempt-2 lease.
    """
    kind = "heavy_same_worker_reclaim_probe"
    worker_id = "same-worker-reclaim"
    session_factory = create_session_factory(engine)
    with Session(engine) as db:
        job = enqueue_job(db, kind=kind, max_attempts=2)
        db.commit()
        attempt_1 = claim_job(
            db,
            job_id=job.id,
            worker_id=worker_id,
            lease_seconds=300,
            heavy_kinds=(kind,),
        )
        db.commit()
        assert attempt_1 is not None and attempt_1.attempts == 1

        expire_heavy_job_claim(db, job_id=job.id)
        db.commit()
        attempt_2 = claim_job(
            db,
            job_id=job.id,
            worker_id=worker_id,
            lease_seconds=300,
            heavy_kinds=(kind,),
        )
        db.commit()
        assert attempt_2 is not None and attempt_2.attempts == 2

        job_lease_before = db.execute(
            text("SELECT lease_expires_at FROM background_jobs WHERE id = :job_id"),
            {"job_id": job.id},
        ).scalar_one()
        capacity_before = _capacity_holder(engine)
        assert capacity_before[:3] == (job.id, worker_id, 2)

        assert (
            heartbeat_job(
                session_factory=session_factory,
                context=JobExecutionContext(
                    job_id=job.id,
                    worker_id=worker_id,
                    attempt_no=1,
                    resource_class="Heavy",
                ),
                lease_seconds=600,
            )
            is False
        )
        assert (
            db.execute(
                text("SELECT lease_expires_at FROM background_jobs WHERE id = :job_id"),
                {"job_id": job.id},
            ).scalar_one()
            == job_lease_before
        )
        assert _capacity_holder(engine) == capacity_before

        assert heartbeat_job(
            session_factory=session_factory,
            context=JobExecutionContext(
                job_id=job.id,
                worker_id=worker_id,
                attempt_no=2,
                resource_class="Heavy",
            ),
            lease_seconds=600,
        )
        renewed_job_lease = db.execute(
            text("SELECT lease_expires_at FROM background_jobs WHERE id = :job_id"),
            {"job_id": job.id},
        ).scalar_one()
        renewed_capacity = _capacity_holder(engine)
        assert renewed_job_lease > job_lease_before
        assert renewed_capacity[:3] == (job.id, worker_id, 2)
        assert renewed_capacity[3] > capacity_before[3]

        assert complete_job(db, job_id=job.id, worker_id=worker_id)
        db.commit()
    assert _capacity_holder(engine) == (None, None, None, None)


def test_heavy_renewal_rejects_missing_or_different_capacity_holder(
    engine: Engine,
) -> None:
    kind = "heavy_missing_holder_probe"
    session_factory = create_session_factory(engine)
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
                session_factory=session_factory,
                context=JobExecutionContext(
                    job_id=orphaned.id,
                    worker_id="orphaned-worker",
                    attempt_no=first.attempts,
                    resource_class="Heavy",
                ),
                lease_seconds=600,
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
                session_factory=session_factory,
                context=JobExecutionContext(
                    job_id=orphaned.id,
                    worker_id="orphaned-worker",
                    attempt_no=first.attempts,
                    resource_class="Heavy",
                ),
                lease_seconds=600,
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
