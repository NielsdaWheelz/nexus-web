"""Real-API proof for bounded media activity and exact repair."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session
from starlette.testclient import TestClient

from nexus.db.models import (
    ContentIndexState,
    Media,
    MediaKind,
    MediaSourceAttempt,
    ProcessingStatus,
)
from nexus.errors import NotFoundError
from nexus.jobs.queue import claim_job, enqueue_job, fail_job, replace_dead_job_payload
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.ingest_recovery import repair_media_work
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.media import read_event_snapshot
from tests.testkit.auth import UserRecord
from tests.testkit.unreachable_state import expire_heavy_job_claim


def _source_media(
    db: Session,
    *,
    viewer_id: UUID,
    title: str,
    attempt_no: int,
    processing_status: ProcessingStatus = ProcessingStatus.extracting,
    progress: tuple[int, int] | None = None,
    kind: MediaKind = MediaKind.pdf,
    attempt_status: str = "running",
) -> tuple[UUID, MediaSourceAttempt]:
    media_id = uuid4()
    db.add(
        Media(
            id=media_id,
            kind=kind.value,
            title=title,
            processing_status=processing_status,
            created_by_user_id=viewer_id,
        )
    )
    db.flush()
    ensure_media_in_default_library(db, viewer_id, media_id)
    attempt = MediaSourceAttempt(
        id=uuid4(),
        media_id=media_id,
        created_by_user_id=viewer_id,
        source_type=("uploaded_epub_file" if kind is MediaKind.epub else "uploaded_pdf_file"),
        attempt_no=attempt_no,
        run_count=1,
        status=attempt_status,
        intent_key=f"activity-{uuid4()}",
        processing_stage="Extract",
        progress_completed=progress[0] if progress else 0,
        progress_total=progress[1] if progress else None,
        progress_unit="Page" if progress else None,
        progress_updated_at=datetime.now(UTC),
    )
    db.add(attempt)
    db.flush()
    return media_id, attempt


def _source_job(db: Session, *, media_id: UUID, attempt: MediaSourceAttempt, max_attempts: int):
    job = enqueue_job(
        db,
        kind="ingest_media_source",
        payload={"media_id": str(media_id), "attempt_id": str(attempt.id)},
        max_attempts=max_attempts,
    )
    attempt.job_id = job.id
    db.flush()
    return job


def _claim(
    db: Session,
    job_id: UUID,
    worker_id: str,
    *,
    allowed_kinds: tuple[str, ...] = ("ingest_media_source",),
):
    claimed = claim_job(
        db,
        job_id=job_id,
        worker_id=worker_id,
        lease_seconds=300,
        allowed_kinds=allowed_kinds,
        heavy_kinds=("ingest_media_source", "media_content_reindex_job"),
    )
    assert claimed is not None, f"expected {job_id} to be claimable"
    return claimed


def test_activity_composes_queue_progress_index_and_viewer_visibility(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    retry_id, retry_attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="Retry backoff",
        attempt_no=1,
    )
    retry_job = _source_job(db_session, media_id=retry_id, attempt=retry_attempt, max_attempts=2)
    _claim(db_session, retry_job.id, "retry-worker")
    assert (
        fail_job(
            db_session,
            job_id=retry_job.id,
            worker_id="retry-worker",
            error_code="E_WORKER_INTERRUPTED",
            error_message="worker interrupted",
            retry_delays_seconds=(300,),
        )
        == "failed"
    )

    dead_id, dead_attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="Needs repair",
        attempt_no=2,
    )
    dead_job = _source_job(db_session, media_id=dead_id, attempt=dead_attempt, max_attempts=1)
    dead_attempt.request_id = "request-dead-source"
    _claim(db_session, dead_job.id, "dead-worker")
    assert (
        fail_job(
            db_session,
            job_id=dead_job.id,
            worker_id="dead-worker",
            error_code="E_WORKER_INTERRUPTED",
            error_message="worker interrupted",
            retry_delays_seconds=(),
        )
        == "dead"
    )

    running_id, running_attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="Running bounded PDF",
        attempt_no=3,
        progress=(80, 712),
    )
    running_job = _source_job(
        db_session,
        media_id=running_id,
        attempt=running_attempt,
        max_attempts=3,
    )
    _claim(db_session, running_job.id, "active-worker")

    capacity_id, capacity_attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="Waiting for capacity",
        attempt_no=4,
    )
    _source_job(db_session, media_id=capacity_id, attempt=capacity_attempt, max_attempts=3)

    ready_id, ready_attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="Readable while indexing",
        attempt_no=5,
        processing_status=ProcessingStatus.ready_for_reading,
        kind=MediaKind.epub,
    )
    ready_attempt.status = "succeeded"
    index_state = ContentIndexState(
        owner_kind="media",
        owner_id=ready_id,
        revision=7,
        status="pending",
    )
    db_session.add(index_state)
    enqueue_job(
        db_session,
        kind="media_content_reindex_job",
        payload={"media_id": str(ready_id), "revision": 7},
    )

    _complete_id, complete_attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="Fully ready",
        attempt_no=6,
        processing_status=ProcessingStatus.ready_for_reading,
        kind=MediaKind.epub,
    )
    complete_attempt.status = "succeeded"

    _unconfirmed_id, _unconfirmed_attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="Unconfirmed upload",
        attempt_no=7,
        attempt_status="accepted",
    )

    hidden_user_id = uuid4()
    ensure_user_and_default_library(
        db_session,
        hidden_user_id,
        f"hidden-{hidden_user_id}@example.invalid",
    )
    hidden_id, hidden_attempt = _source_media(
        db_session,
        viewer_id=hidden_user_id,
        title="Foreign work",
        attempt_no=8,
    )
    _source_job(db_session, media_id=hidden_id, attempt=hidden_attempt, max_attempts=3)
    db_session.flush()

    response = authenticated_client.get("/media/activity?limit=20")

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    payload = response.json()["data"]
    by_title = {item["title"]: item for item in payload["items"]}
    assert "Foreign work" not in by_title
    assert "Unconfirmed upload" not in by_title
    assert payload["nonterminal_count"] == 5
    assert by_title["Running bounded PDF"]["status"] == "Processing"
    assert by_title["Running bounded PDF"]["progress"] == {
        "kind": "Present",
        "value": {
            "kind": "Counted",
            "stage": "Extract",
            "completed": 80,
            "total": 712,
            "unit": "Page",
            "run_count": 1,
            "updated_at": running_attempt.progress_updated_at.isoformat().replace("+00:00", "Z"),
        },
    }
    sse_snapshot = read_event_snapshot(
        db_session,
        viewer_id=test_user.id,
        media_id=running_id,
    )
    assert sse_snapshot.payload["source_progress"] == by_title["Running bounded PDF"]["progress"], (
        "Activity and the canonical media SSE projected different source progress"
    )
    assert by_title["Waiting for capacity"]["waiting_reason"] == {
        "kind": "Present",
        "value": "Capacity",
    }
    assert by_title["Retry backoff"]["waiting_reason"] == {
        "kind": "Present",
        "value": "RetryBackoff",
    }
    assert by_title["Needs repair"]["status"] == "NeedsAttention"
    assert by_title["Needs repair"]["capabilities"]["can_repair_source"] is True
    assert by_title["Needs repair"]["failure_code"] == {
        "kind": "Present",
        "value": "E_WORKER_INTERRUPTED",
    }
    assert by_title["Needs repair"]["request_id"] == {
        "kind": "Present",
        "value": "request-dead-source",
    }
    assert by_title["Running bounded PDF"]["failure_code"] == {"kind": "Absent"}
    assert by_title["Readable while indexing"]["status"] == "Ready"
    assert by_title["Readable while indexing"]["stage"] == {
        "kind": "Present",
        "value": "Index",
    }
    assert by_title["Readable while indexing"]["capabilities"]["can_open"] is True
    assert by_title["Fully ready"]["status"] == "Ready"
    assert by_title["Fully ready"]["stage"] == {"kind": "Absent"}

    expire_heavy_job_claim(db_session, job_id=running_job.id)
    db_session.flush()
    after_expiry = authenticated_client.get("/media/activity?limit=20")
    assert after_expiry.status_code == 200, after_expiry.text
    after_expiry_by_title = {item["title"]: item for item in after_expiry.json()["data"]["items"]}
    assert after_expiry_by_title["Waiting for capacity"]["waiting_reason"] == {
        "kind": "Present",
        "value": "Queue",
    }


def test_succeeded_attempt_keeps_its_finalize_stage_without_in_flight_progress(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    """A published run reports its persisted stage as history, never live progress.

    The worker can die between the fenced publication commit and the queue
    completion, so the attempt is `succeeded` while its exact source job
    dead-letters. Activity must then say `Finalize` from the attempt row and
    project no progress, rather than reporting a perpetual in-flight run or
    collapsing back to `Validate`.
    """
    media_id, attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="Published then interrupted",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
    )
    attempt.status = "succeeded"
    attempt.processing_stage = "Finalize"
    job = _source_job(db_session, media_id=media_id, attempt=attempt, max_attempts=1)
    _claim(db_session, job.id, "publication-worker")
    assert (
        fail_job(
            db_session,
            job_id=job.id,
            worker_id="publication-worker",
            error_code="E_WORKER_INTERRUPTED",
            error_message="worker interrupted",
            retry_delays_seconds=(),
        )
        == "dead"
    )
    db_session.flush()

    response = authenticated_client.get("/media/activity?limit=20")

    assert response.status_code == 200, response.text
    by_title = {item["title"]: item for item in response.json()["data"]["items"]}
    published = by_title["Published then interrupted"]
    assert published["status"] == "NeedsAttention"
    assert published["progress"] == {"kind": "Absent"}
    assert published["stage"] == {"kind": "Present", "value": "Finalize"}


def test_repair_requeues_only_exact_current_dead_source_work(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    media_id, attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="Exact repair",
        attempt_no=1,
    )
    job = _source_job(db_session, media_id=media_id, attempt=attempt, max_attempts=1)
    _claim(db_session, job.id, "failed-worker")
    assert (
        fail_job(
            db_session,
            job_id=job.id,
            worker_id="failed-worker",
            error_code="E_WORKER_INTERRUPTED",
            error_message="worker interrupted",
            retry_delays_seconds=(),
        )
        == "dead"
    )
    db_session.flush()

    assert replace_dead_job_payload(
        db_session,
        job_id=job.id,
        payload={"media_id": str(uuid4()), "attempt_id": str(attempt.id)},
    )
    malformed_identity = authenticated_client.post(
        f"/media/{media_id}/repair",
        json={"scope": "Source"},
    )
    assert malformed_identity.status_code == 409, malformed_identity.text
    assert malformed_identity.json()["error"]["code"] == "E_REPAIR_NOT_ALLOWED"
    assert replace_dead_job_payload(
        db_session,
        job_id=job.id,
        payload={"media_id": str(media_id), "attempt_id": str(attempt.id)},
    )

    wrong_scope = authenticated_client.post(
        f"/media/{media_id}/repair",
        json={"scope": "Search"},
    )
    assert wrong_scope.status_code == 409, wrong_scope.text
    assert wrong_scope.json()["error"]["code"] == "E_REPAIR_NOT_ALLOWED"

    repaired = authenticated_client.post(
        f"/media/{media_id}/repair",
        json={"scope": "Source"},
    )
    assert repaired.status_code == 202, repaired.text
    assert repaired.json()["data"] == {
        "media_id": str(media_id),
        "scope": "Source",
        "job_id": str(job.id),
    }

    second_repair = authenticated_client.post(
        f"/media/{media_id}/repair",
        json={"scope": "Source"},
    )
    assert second_repair.status_code == 409, second_repair.text
    assert second_repair.json()["error"]["code"] == "E_REPAIR_NOT_ALLOWED"


def test_repair_exact_search_and_rejects_stale_or_foreign_source_work(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    searchable_id, searchable_attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="Exact search repair",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
        kind=MediaKind.epub,
    )
    searchable_attempt.status = "succeeded"
    db_session.add(
        ContentIndexState(
            owner_kind="media",
            owner_id=searchable_id,
            revision=11,
            status="failed",
        )
    )
    search_job = enqueue_job(
        db_session,
        kind="media_content_reindex_job",
        payload={"media_id": str(searchable_id), "revision": 11},
        max_attempts=1,
    )
    _claim(
        db_session,
        search_job.id,
        "index-worker",
        allowed_kinds=("media_content_reindex_job",),
    )
    assert (
        fail_job(
            db_session,
            job_id=search_job.id,
            worker_id="index-worker",
            error_code="E_WORKER_INTERRUPTED",
            error_message="worker interrupted",
            retry_delays_seconds=(),
        )
        == "dead"
    )

    repaired = authenticated_client.post(
        f"/media/{searchable_id}/repair",
        json={"scope": "Search"},
    )
    assert repaired.status_code == 202, repaired.text
    assert repaired.json()["data"] == {
        "media_id": str(searchable_id),
        "scope": "Search",
        "job_id": str(search_job.id),
    }

    stale_id, stale_attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="Superseded source repair",
        attempt_no=1,
    )
    stale_job = _source_job(
        db_session,
        media_id=stale_id,
        attempt=stale_attempt,
        max_attempts=1,
    )
    _claim(db_session, stale_job.id, "stale-worker")
    assert (
        fail_job(
            db_session,
            job_id=stale_job.id,
            worker_id="stale-worker",
            error_code="E_WORKER_INTERRUPTED",
            error_message="worker interrupted",
            retry_delays_seconds=(),
        )
        == "dead"
    )
    current_attempt = MediaSourceAttempt(
        id=uuid4(),
        media_id=stale_id,
        created_by_user_id=test_user.id,
        source_type="uploaded_pdf_file",
        attempt_no=2,
        run_count=0,
        status="queued",
        intent_key=f"activity-{uuid4()}",
    )
    db_session.add(current_attempt)
    db_session.flush()

    stale = authenticated_client.post(
        f"/media/{stale_id}/repair",
        json={"scope": "Source"},
    )
    assert stale.status_code == 409, stale.text
    assert stale.json()["error"]["code"] == "E_REPAIR_NOT_ALLOWED"

    foreign_user_id = uuid4()
    ensure_user_and_default_library(
        db_session,
        foreign_user_id,
        f"foreign-{foreign_user_id}@example.invalid",
    )
    with pytest.raises(NotFoundError):
        repair_media_work(
            db_session,
            media_id=stale_id,
            scope="Source",
            viewer_id=foreign_user_id,
        )
