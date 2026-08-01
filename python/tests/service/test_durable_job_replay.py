"""Priority proof: an expired worker lease replays through the real worker safely."""

from __future__ import annotations

import socket
import time
from pathlib import Path
from uuid import UUID, uuid4

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, User
from nexus.db.session import create_session_factory
from nexus.jobs.queue import claim_job, complete_job, enqueue_job
from nexus.jobs.registry import get_default_registry
from nexus.jobs.worker import JobWorker
from nexus.services.auth_handoff_codes import create_auth_handoff_code
from nexus.services.note_indexing import enqueue_note_reindex
from nexus_test_control import services as test_services
from tests.testkit.unreachable_state import (
    expire_claim_and_handoff_code,
    expire_job_claim,
    prioritize_job_for_worker_proof,
)
from tests.testkit.worker import (
    assert_production_worker,
    controller_run,
    kill_and_forget_worker,
    wait_for_job,
)

_KIND = "purge_expired_auth_handoff_codes"
_REPO_ROOT = Path(__file__).resolve().parents[3]
_TEST_ENV = {"NEXUS_ENV": "test"}


def _index_snapshot(engine: Engine, note_block_id: UUID) -> tuple[object, ...]:
    with engine.connect() as oracle:
        row = oracle.execute(
            text(
                """
                SELECT
                    (SELECT status FROM content_index_states
                     WHERE owner_kind = 'note_block' AND owner_id = :owner_id),
                    (SELECT COUNT(*) FROM content_blocks
                     WHERE owner_kind = 'note_block' AND owner_id = :owner_id),
                    (SELECT COUNT(*) FROM evidence_spans
                     WHERE owner_kind = 'note_block' AND owner_id = :owner_id),
                    (SELECT COUNT(*) FROM content_chunks
                     WHERE owner_kind = 'note_block' AND owner_id = :owner_id),
                    (SELECT COUNT(*) FROM content_embeddings ce
                     JOIN content_chunks cc ON cc.id = ce.chunk_id
                     WHERE cc.owner_kind = 'note_block' AND cc.owner_id = :owner_id)
                """
            ),
            {"owner_id": note_block_id},
        ).one()
    return tuple(row)


def _wait_for_index_checkpoint(
    engine: Engine,
    note_block_id: UUID,
    *,
    timeout_seconds: float = 30,
) -> tuple[object, ...]:
    deadline = time.monotonic() + timeout_seconds
    observed: tuple[object, ...] | None = None
    while time.monotonic() < deadline:
        observed = _index_snapshot(engine, note_block_id)
        if observed == ("ready", 1, 1, 1, 1):
            return observed
    raise AssertionError(
        f"note index checkpoint did not commit exactly once; last snapshot: {observed!r}"
    )


def test_expired_claim_replays_once_and_fences_the_crashed_worker(engine: Engine) -> None:
    user_id = uuid4()
    with Session(engine) as db:
        db.add(User(id=user_id, email=f"replay-proof-{user_id}@example.invalid"))
        db.commit()
        create_auth_handoff_code(
            db,
            user_id,
            access_token="synthetic-access-token",
            refresh_token="synthetic-refresh-token",
            challenge="a" * 64,
        )
        job = enqueue_job(
            db,
            kind=_KIND,
            payload={"request_id": "durable-replay-proof"},
            priority=0,
            max_attempts=3,
        )
        db.commit()
        crashed_claim = claim_job(
            db,
            job_id=job.id,
            worker_id="crashed-worker",
            lease_seconds=300,
            allowed_kinds=(_KIND,),
        )
        assert crashed_claim is not None, "synthetic crashed worker did not acquire its job"
        expire_claim_and_handoff_code(db, job_id=job.id, user_id=user_id)
        db.commit()

    definition = get_default_registry()[_KIND]
    worker = JobWorker(
        session_factory=create_session_factory(engine),
        worker_id="recovery-worker",
        registry={_KIND: definition},
        allowed_kinds=(_KIND,),
    )
    assert worker.run_once() is True, "recovery worker did not replay the expired claim"

    with Session(engine) as oracle:
        row = oracle.execute(
            text(
                """
                SELECT status, attempts, claimed_by, lease_expires_at, result
                FROM background_jobs
                WHERE id = :job_id
                """
            ),
            {"job_id": job.id},
        ).one()
        remaining_codes = oracle.execute(
            text("SELECT COUNT(*) FROM auth_handoff_codes WHERE user_id = :user_id"),
            {"user_id": user_id},
        ).scalar_one()
        stale_completion = complete_job(
            oracle,
            job_id=job.id,
            worker_id="crashed-worker",
            result_payload={"deleted_count": 999},
        )

    assert row == ("succeeded", 2, None, None, {"deleted_count": 1}), (
        f"replayed job did not converge to one successful terminal result: {row!r}"
    )
    assert remaining_codes == 0, f"replayed purge left {remaining_codes} expired code(s)"
    assert stale_completion is False, "expired claimant mutated the recovered terminal job"


def test_owned_worker_replays_committed_note_index_after_process_death(
    engine: Engine,
) -> None:
    run = controller_run()
    user_id = uuid4()
    note_block_id = uuid4()
    body = "A durable worker replay must converge to one persisted index."
    with Session(engine) as db:
        db.add(User(id=user_id, email=f"worker-replay-{user_id}@example.invalid"))
        db.flush()
        db.add(
            NoteBlock(
                id=note_block_id,
                user_id=user_id,
                body_pm_json={
                    "type": "doc",
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": body}],
                        }
                    ],
                },
                body_text=body,
            )
        )
        db.flush()
        job_id = enqueue_note_reindex(db, note_block_id=note_block_id, reason="note_edit")
        prioritize_job_for_worker_proof(db, job_id=job_id)
        db.commit()

    note_lock = engine.connect()
    note_transaction = note_lock.begin()
    job_lock = None
    job_transaction = None
    try:
        note_lock.execute(text("LOCK TABLE note_blocks IN ACCESS EXCLUSIVE MODE"))
        crashed = test_services.start_python_process(
            _REPO_ROOT, _TEST_ENV, run, "worker-background"
        )

        claimed = wait_for_job(
            engine,
            job_id,
            status="running",
            attempts=1,
            minimum_lease_seconds=600,
        )
        assert_production_worker(crashed, run)
        assert claimed[2] == f"{socket.gethostname()}:{crashed.process_group_id}", (
            f"job was not claimed by the controller-owned production worker: {claimed!r}"
        )

        job_lock = engine.connect()
        job_transaction = job_lock.begin()
        locked_job_id = job_lock.execute(
            text("SELECT id FROM background_jobs WHERE id = :job_id FOR UPDATE"),
            {"job_id": job_id},
        ).scalar_one()
        assert locked_job_id == job_id

        note_transaction.rollback()
        note_lock.close()
        checkpoint = _wait_for_index_checkpoint(engine, note_block_id)
        assert checkpoint == ("ready", 1, 1, 1, 1)
        still_running = wait_for_job(engine, job_id, status="running", attempts=1)
        assert still_running[4] is None, (
            f"queue terminal result committed despite the held queue row: {still_running!r}"
        )

        kill_and_forget_worker(crashed)
        job_transaction.rollback()
        job_lock.close()
        job_transaction = None
        job_lock = None

        with Session(engine) as db:
            expire_job_claim(db, job_id=job_id)
            db.commit()

        recovered = test_services.start_python_process(
            _REPO_ROOT, _TEST_ENV, run, "worker-background"
        )
        terminal = wait_for_job(engine, job_id, status="succeeded", attempts=2)
        assert_production_worker(recovered, run)

        assert terminal == (
            "succeeded",
            2,
            None,
            None,
            {
                "owner": {"kind": "note_block", "id": str(note_block_id)},
                "status": "ready",
                "chunk_count": 1,
            },
        ), f"restarted production worker did not converge exactly: {terminal!r}"
        assert _index_snapshot(engine, note_block_id) == ("ready", 1, 1, 1, 1), (
            "replay duplicated or lost the committed note index materialization"
        )
    finally:
        if note_transaction.is_active:
            note_transaction.rollback()
        note_lock.close()
        if job_transaction is not None and job_transaction.is_active:
            job_transaction.rollback()
        if job_lock is not None:
            job_lock.close()
