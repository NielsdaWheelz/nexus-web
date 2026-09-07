"""Durable pagination boundary proof for the storage orphan sweep."""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine

import nexus.tasks.storage_orphan_sweep as storage_orphan_sweep_module
from nexus.db.session import create_session_factory
from nexus.jobs.queue import JobExecutionContext, claim_job, enqueue_job, get_job
from tests.testkit.unreachable_state import delete_jobs_by_ids


@pytest.mark.parametrize(
    "persisted_token",
    ("", " padded", 7),
    ids=(
        "empty-persisted-token",
        "padded-persisted-token",
        "non-text-persisted-token",
    ),
)
def test_storage_orphan_sweep_defects_on_a_malformed_persisted_page_token(
    engine: Engine,
    persisted_token: object,
) -> None:
    session_factory = create_session_factory(engine)
    worker_id = f"storage-orphan-page-token-proof-{uuid4()}"
    job_ids: list[UUID] = []
    payload: dict[str, object] = {
        "request_id": f"periodic:storage_orphan_sweep:{uuid4()}",
        "scheduler_identity": "storage-orphan-page-token-proof",
    }
    payload["continuationToken"] = persisted_token

    try:
        with session_factory() as db:
            job = enqueue_job(
                db,
                kind="storage_orphan_sweep",
                payload=payload,
                max_attempts=1,
            )
            job_ids.append(job.id)
            db.commit()
            claimed = claim_job(
                db,
                job_id=job.id,
                worker_id=worker_id,
                lease_seconds=300,
                heavy_kinds=(),
                allowed_kinds=("storage_orphan_sweep",),
            )
            assert claimed is not None
            context = JobExecutionContext(
                job_id=claimed.id,
                worker_id=worker_id,
                attempt_no=claimed.attempts,
                resource_class="Light",
            )
            db.commit()
            before = get_job(db, claimed.id)
            assert before is not None

        with pytest.raises(
            AssertionError,
            match="storage orphan sweep has an invalid continuation token",
        ):
            storage_orphan_sweep_module.storage_orphan_sweep(context=context)

        with session_factory() as db:
            assert get_job(db, context.job_id) == before
    finally:
        with session_factory() as cleanup:
            delete_jobs_by_ids(cleanup, job_ids=job_ids)
            cleanup.commit()
