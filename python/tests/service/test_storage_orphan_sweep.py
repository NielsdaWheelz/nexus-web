"""Durable pagination boundary proof for the storage orphan sweep."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine

import nexus.tasks.storage_orphan_sweep as storage_orphan_sweep_module
from nexus.db.session import create_session_factory
from nexus.jobs.queue import JobExecutionContext, claim_job, enqueue_job, get_job
from nexus.storage.client import ObjectPage, StorageClientBase, StorageObjectEntry
from tests.testkit.unreachable_state import delete_jobs_by_ids

_ABSENT = object()


class _ListingStorage:
    def __init__(
        self,
        *,
        objects: tuple[StorageObjectEntry, ...],
        next_continuation_token: Any,
    ) -> None:
        self.objects = objects
        self.next_continuation_token = next_continuation_token
        self.received_continuation_tokens: list[str | None] = []
        self.deleted_paths: list[str] = []

    def list_objects(
        self,
        prefix: str,
        *,
        continuation_token: str | None = None,
    ) -> ObjectPage:
        assert prefix == "media/"
        self.received_continuation_tokens.append(continuation_token)
        return ObjectPage(
            objects=self.objects,
            next_continuation_token=self.next_continuation_token,
        )

    def delete_object(self, path: str) -> None:
        self.deleted_paths.append(path)


@pytest.mark.parametrize(
    ("persisted_token", "provider_token", "expected_storage_calls", "expected_error"),
    (
        ("", None, 0, "storage orphan sweep has an invalid continuation token"),
        (" padded", None, 0, "storage orphan sweep has an invalid continuation token"),
        (7, None, 0, "storage orphan sweep has an invalid continuation token"),
        (_ABSENT, "", 1, "storage orphan sweep received an invalid continuation token"),
        (
            _ABSENT,
            "padded ",
            1,
            "storage orphan sweep received an invalid continuation token",
        ),
        (_ABSENT, 7, 1, "storage orphan sweep received an invalid continuation token"),
        (
            "same-page",
            "same-page",
            1,
            "storage orphan sweep received a non-advancing continuation token",
        ),
    ),
    ids=(
        "empty-persisted-token",
        "padded-persisted-token",
        "non-text-persisted-token",
        "empty-provider-token",
        "padded-provider-token",
        "non-text-provider-token",
        "repeated-provider-token",
    ),
)
def test_storage_orphan_sweep_defects_before_replaying_a_malformed_page_token(
    engine: Engine,
    persisted_token: object,
    provider_token: Any,
    expected_storage_calls: int,
    expected_error: str,
) -> None:
    session_factory = create_session_factory(engine)
    worker_id = f"storage-orphan-page-token-proof-{uuid4()}"
    job_ids: list[UUID] = []
    payload: dict[str, object] = {
        "request_id": f"periodic:storage_orphan_sweep:{uuid4()}",
        "scheduler_identity": "storage-orphan-page-token-proof",
    }
    if persisted_token is not _ABSENT:
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

        storage = _ListingStorage(
            objects=(
                StorageObjectEntry(
                    path=f"media/{uuid4()}/orphan.bin",
                    last_modified=datetime(2000, 1, 1, tzinfo=UTC),
                    size_bytes=1,
                ),
            ),
            next_continuation_token=provider_token,
        )

        with pytest.raises(
            AssertionError,
            match=expected_error,
        ):
            storage_orphan_sweep_module.storage_orphan_sweep(
                context=context,
                storage_client=cast(StorageClientBase, storage),
            )

        assert len(storage.received_continuation_tokens) == expected_storage_calls
        assert storage.deleted_paths == []
        with session_factory() as db:
            assert get_job(db, context.job_id) == before
    finally:
        with session_factory() as cleanup:
            delete_jobs_by_ids(cleanup, job_ids=job_ids)
            cleanup.commit()
