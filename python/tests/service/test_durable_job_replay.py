"""Priority proof: an expired worker lease replays through the real worker safely."""

from __future__ import annotations

from uuid import uuid4

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.db.models import User
from nexus.db.session import create_session_factory
from nexus.jobs.queue import claim_job, complete_job, enqueue_job
from nexus.jobs.registry import get_default_registry
from nexus.jobs.worker import JobWorker
from nexus.services.auth_handoff_codes import create_auth_handoff_code
from tests.testkit.unreachable_state import expire_claim_and_handoff_code

_KIND = "purge_expired_auth_handoff_codes"


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
