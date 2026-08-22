"""Real-API proof for bounded media activity and exact repair."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session
from starlette.testclient import TestClient

from nexus.db.models import (
    ContentIndexState,
    Media,
    MediaKind,
    MediaSourceAttempt,
    MediaUploadSession,
    ProcessingStatus,
)
from nexus.errors import NotFoundError
from nexus.jobs.queue import (
    claim_job,
    complete_job,
    enqueue_job,
    fail_job,
    replace_dead_job_payload,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.ingest_recovery import get_ingest_recovery_health, repair_media_work
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.media import read_event_snapshot
from nexus.services.media_activity import read_media_activity
from nexus.services.sealed_handles import seal_upload_session
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


def _upload_session(
    db: Session,
    *,
    viewer_id: UUID,
    filename: str,
    expires_at: datetime,
    transport_failure_kind: str | None = None,
    verification_error_code: str | None = None,
) -> MediaUploadSession:
    now = datetime.now(UTC)
    session = MediaUploadSession(
        id=uuid4(),
        created_by_user_id=viewer_id,
        candidate_media_id=uuid4(),
        kind="epub",
        filename=filename,
        content_type="application/epub+zip",
        expected_size_bytes=4096,
        idempotency_key=f"activity-upload-{uuid4()}",
        request_id=f"activity-request-{uuid4()}",
        upload_generation=1,
        upload_url_expires_at=expires_at,
        transport_failure_kind=transport_failure_kind,
        transport_failed_at=(now if transport_failure_kind is not None else None),
        verification_error_code=verification_error_code,
        verification_failed_at=(now if verification_error_code is not None else None),
    )
    db.add(session)
    db.flush()
    return session


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

    expired_upload = _upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="Expired Bakker.epub",
        expires_at=datetime.now(UTC) - timedelta(minutes=1),
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
    _upload_session(
        db_session,
        viewer_id=hidden_user_id,
        filename="Foreign upload.epub",
        expires_at=datetime.now(UTC) - timedelta(minutes=1),
    )
    db_session.flush()

    response = authenticated_client.get("/media/activity?limit=20")

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    payload = response.json()["data"]
    by_title = {item["title"]: item for item in payload["items"] if item["kind"] == "Media"}
    by_filename = {
        item["filename"]: item for item in payload["items"] if item["kind"] == "UploadSession"
    }
    assert "Foreign work" not in by_title
    assert "Foreign upload.epub" not in by_filename
    assert payload["needs_attention_count"] == 2
    assert payload["active_count"] == 4
    assert payload["has_more"] is False
    assert by_title["Running bounded PDF"]["state"]["kind"] == "Active"
    assert by_title["Running bounded PDF"]["state"]["status"] == "Processing"
    assert by_title["Running bounded PDF"]["state"]["progress"] == {
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
    assert (
        sse_snapshot.payload["source_progress"]
        == by_title["Running bounded PDF"]["state"]["progress"]
    ), "Activity and the canonical media SSE projected different source progress"
    assert by_title["Waiting for capacity"]["state"]["waiting_reason"] == {
        "kind": "Present",
        "value": "Capacity",
    }
    assert by_title["Retry backoff"]["state"]["waiting_reason"] == {
        "kind": "Present",
        "value": "RetryBackoff",
    }
    assert by_title["Needs repair"]["state"]["kind"] == "NeedsAttention"
    assert by_title["Needs repair"]["state"]["scope"] == "Source"
    assert by_title["Needs repair"]["capabilities"]["can_repair_source"] is True
    assert by_title["Needs repair"]["state"]["failure_code"] == {
        "kind": "Present",
        "value": "E_WORKER_INTERRUPTED",
    }
    assert by_title["Needs repair"]["request_id"] == {
        "kind": "Present",
        "value": "request-dead-source",
    }
    assert by_title["Running bounded PDF"]["state"]["status_code"] == {"kind": "Absent"}
    assert by_title["Readable while indexing"]["state"]["kind"] == "Active"
    assert by_title["Readable while indexing"]["state"]["stage"] == "Index"
    assert by_title["Readable while indexing"]["capabilities"]["can_open"] is True
    assert by_filename["Expired Bakker.epub"] == {
        "kind": "UploadSession",
        "session_handle": seal_upload_session(expired_upload.id),
        "filename": "Expired Bakker.epub",
        "document_kind": "Epub",
        "expected_size_bytes": 4096,
        "attention": {"kind": "CapabilityExpired"},
        "created_at": expired_upload.created_at.isoformat().replace("+00:00", "Z"),
        "updated_at": expired_upload.updated_at.isoformat().replace("+00:00", "Z"),
        "capabilities": {"can_retry_upload": True, "can_remove": True},
    }
    assert "Fully ready" not in by_title
    assert "Expired Bakker.epub" in by_filename

    limited = authenticated_client.get("/media/activity?limit=3")
    assert limited.status_code == 200, limited.text
    limited_payload = limited.json()["data"]
    assert len(limited_payload["items"]) == 3
    limited_attention = {
        (
            item["kind"],
            item.get("title") if item["kind"] == "Media" else item.get("filename"),
        )
        for item in limited_payload["items"][:2]
    }
    assert limited_attention == {
        ("Media", "Needs repair"),
        ("UploadSession", "Expired Bakker.epub"),
    }
    assert limited_payload["needs_attention_count"] == 2
    assert limited_payload["active_count"] == 4
    assert limited_payload["has_more"] is True

    at_limit = authenticated_client.get("/media/activity?limit=6")
    assert at_limit.status_code == 200, at_limit.text
    at_limit_payload = at_limit.json()["data"]
    assert len(at_limit_payload["items"]) == 6
    assert at_limit_payload["has_more"] is False

    expire_heavy_job_claim(db_session, job_id=running_job.id)
    db_session.flush()
    after_expiry = authenticated_client.get("/media/activity?limit=20")
    assert after_expiry.status_code == 200, after_expiry.text
    after_expiry_by_title = {
        item["title"]: item
        for item in after_expiry.json()["data"]["items"]
        if item["kind"] == "Media"
    }
    assert after_expiry_by_title["Waiting for capacity"]["state"]["waiting_reason"] == {
        "kind": "Present",
        "value": "Queue",
    }


def test_activity_orders_lifecycle_evidence_not_media_edits(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    old_id, old_attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="Old failure",
        attempt_no=1,
        attempt_status="failed",
    )

    new_id, new_attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="New failure",
        attempt_no=1,
        attempt_status="failed",
    )

    old_active_id, old_active_attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="Old active",
        attempt_no=1,
        attempt_status="accepted",
    )
    new_active_id, new_active_attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="New active",
        attempt_no=1,
        attempt_status="accepted",
    )
    old_time = datetime(2020, 1, 1, tzinfo=UTC)
    new_time = datetime(2020, 1, 2, tzinfo=UTC)
    old_attempt.updated_at = old_time
    new_attempt.updated_at = new_time
    old_active_attempt.updated_at = old_time
    new_active_attempt.updated_at = new_time
    # Deliberately reverse unrelated media edits; ordering must not use m.updated_at.
    db_session.get(Media, old_id).updated_at = new_time
    db_session.get(Media, new_id).updated_at = old_time
    db_session.get(Media, old_active_id).updated_at = new_time
    db_session.get(Media, new_active_id).updated_at = old_time
    db_session.flush()

    response = authenticated_client.get("/media/activity?limit=4")
    assert response.status_code == 200, response.text
    assert [item["title"] for item in response.json()["data"]["items"]] == [
        "Old failure",
        "New failure",
        "New active",
        "Old active",
    ]


def test_activity_projects_only_upload_obligations_with_strict_precedence(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    now = datetime.now(UTC)
    expired = _upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="expired.epub",
        expires_at=now - timedelta(minutes=3),
    )
    transport = _upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="transport.epub",
        expires_at=now - timedelta(minutes=4),
        transport_failure_kind="HttpRejected",
    )
    transport.transport_http_status = 503
    transport.transport_failed_at = now - timedelta(minutes=2)
    verification = _upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="verification.epub",
        expires_at=now - timedelta(minutes=5),
        verification_error_code="E_SOURCE_INTEGRITY",
    )
    verification.verification_failed_at = now - timedelta(minutes=1)
    verifying = _upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="verifying.epub",
        expires_at=now - timedelta(minutes=6),
        transport_failure_kind="Timeout",
    )
    verifying.verification_token = uuid4()
    verifying.verification_generation = verifying.upload_generation
    verifying.verification_expires_at = now + timedelta(minutes=1)
    _upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="awaiting.epub",
        expires_at=now + timedelta(minutes=1),
    )
    db_session.flush()

    response = authenticated_client.get("/media/activity?limit=20")

    assert response.status_code == 200, response.text
    payload = response.json()["data"]
    assert payload["needs_attention_count"] == 3
    assert payload["active_count"] == 0
    assert payload["has_more"] is False
    assert [item["filename"] for item in payload["items"]] == [
        "expired.epub",
        "transport.epub",
        "verification.epub",
    ]
    by_filename = {item["filename"]: item for item in payload["items"]}
    assert by_filename["expired.epub"]["session_handle"] == seal_upload_session(expired.id)
    assert by_filename["expired.epub"]["attention"] == {"kind": "CapabilityExpired"}
    assert by_filename["transport.epub"]["attention"] == {
        "kind": "TransportFailed",
        "failure_kind": "HttpRejected",
        "http_status": {"kind": "Present", "value": 503},
    }
    assert by_filename["transport.epub"]["capabilities"] == {
        "can_retry_upload": True,
        "can_remove": True,
    }
    assert by_filename["verification.epub"]["attention"] == {
        "kind": "VerificationFailed",
        "failure_code": "E_SOURCE_INTEGRITY",
    }
    assert by_filename["verification.epub"]["capabilities"] == {
        "can_retry_upload": False,
        "can_remove": True,
    }
    assert "verifying.epub" not in by_filename
    assert "awaiting.epub" not in by_filename


def test_activity_is_silent_for_published_upload_sessions(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    """Publication, not capability freshness, resolves an upload obligation.

    A published session keeps its durable identity row and its long-expired PUT
    capability. If publication stopped resolving the obligation, every successful
    import would reappear forever as a Needs Attention item whose Remove button can
    only ever answer E_UPLOAD_ALREADY_PUBLISHED.
    """
    now = datetime.now(UTC)
    published_media_id, published_attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="Published upload",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
        kind=MediaKind.epub,
    )
    published_attempt.status = "succeeded"
    published = _upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="published.epub",
        expires_at=now - timedelta(minutes=7),
    )
    published.published_media_id = published_media_id
    published.published_source_attempt_id = published_attempt.id
    published.published_at = now - timedelta(minutes=6)
    # One unresolved obligation with the same expired capability is the control: it
    # proves the projection is live and that only publication silences a session.
    _upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="unpublished.epub",
        expires_at=now - timedelta(minutes=7),
    )
    db_session.flush()

    response = authenticated_client.get("/media/activity?limit=20")

    assert response.status_code == 200, response.text
    payload = response.json()["data"]
    assert [item["filename"] for item in payload["items"]] == ["unpublished.epub"]
    assert payload["needs_attention_count"] == 1
    assert payload["active_count"] == 0
    assert payload["has_more"] is False
    assert "Published upload" not in {item.get("title") for item in payload["items"]}


def test_activity_upload_badge_counts_every_unresolved_obligation(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    """The upload half is page-bounded, but the badge counts the whole backlog.

    Both halves of the union are bounded by the caller's page limit so an unbounded
    backlog of abandoned sessions cannot be hydrated on one request; the badge is a
    separate aggregate, so bounding must not silently truncate what it reports.
    """
    now = datetime.now(UTC)
    for index in range(3):
        _upload_session(
            db_session,
            viewer_id=test_user.id,
            filename=f"backlog-{index}.epub",
            expires_at=now - timedelta(minutes=10 - index),
        )
    db_session.flush()

    bounded = authenticated_client.get("/media/activity?limit=2")

    assert bounded.status_code == 200, bounded.text
    payload = bounded.json()["data"]
    assert [item["filename"] for item in payload["items"]] == [
        "backlog-0.epub",
        "backlog-1.epub",
    ]
    assert payload["needs_attention_count"] == 3
    assert payload["active_count"] == 0
    assert payload["has_more"] is True


def test_ingest_health_projects_upload_publication_and_resource_facts(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    now = datetime.now(UTC)
    _upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="expired.epub",
        expires_at=now - timedelta(minutes=1),
    )
    _upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="failed.epub",
        expires_at=now + timedelta(minutes=1),
        transport_failure_kind="Network",
    )
    verifying = _upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="verifying.epub",
        expires_at=now - timedelta(minutes=1),
    )
    verifying.verification_token = uuid4()
    verifying.verification_generation = verifying.upload_generation
    verifying.verification_expires_at = now + timedelta(minutes=1)

    _jobless_id, _jobless_attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="Accepted without exact job",
        attempt_no=1,
        attempt_status="accepted",
    )
    limited_id, limited_attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="Bounded child exhausted",
        attempt_no=2,
        attempt_status="running",
    )
    limited_job = _source_job(
        db_session,
        media_id=limited_id,
        attempt=limited_attempt,
        max_attempts=1,
    )
    _claim(db_session, limited_job.id, "resource-worker")
    assert (
        fail_job(
            db_session,
            job_id=limited_job.id,
            worker_id="resource-worker",
            error_code="E_RESOURCE_LIMIT",
            error_message="bounded child exceeded memory",
            retry_delays_seconds=(),
        )
        == "dead"
    )
    limited_attempt.status = "failed"
    db_session.flush()

    health = get_ingest_recovery_health(db_session)

    assert health["expired_upload_session_count"] == 1
    assert health["failed_upload_session_count"] == 1
    assert health["active_upload_verification_lease_count"] == 1
    assert health["accepted_jobless_source_attempt_count"] == 1
    assert health["resource_limited_source_job_count"] == 1
    assert health["degraded"] is True


def test_terminal_source_without_safe_code_uses_absent_failure_code(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    media_id, _attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title="Pruned terminal source failure",
        attempt_no=1,
        attempt_status="failed",
    )
    db_session.flush()

    response = authenticated_client.get("/media/activity")
    assert response.status_code == 200, response.text
    payload = response.json()["data"]
    assert payload["needs_attention_count"] == 1
    assert payload["active_count"] == 0
    assert payload["items"][0]["media_id"] == str(media_id)
    assert payload["items"][0]["state"] == {
        "kind": "NeedsAttention",
        "scope": "Source",
        "stage": "Extract",
        "failure_code": {"kind": "Absent"},
    }


@pytest.mark.parametrize("exact_status", [None, "pending", "failed", "running", "succeeded"])
def test_failed_index_state_without_exact_current_dead_job_is_invariant_defect(
    db_session: Session,
    test_user: UserRecord,
    exact_status: str | None,
) -> None:
    media_id, attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title=f"Failed index {exact_status or 'none'}",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
        kind=MediaKind.epub,
    )
    attempt.status = "succeeded"
    db_session.add(
        ContentIndexState(
            owner_kind="media",
            owner_id=media_id,
            revision=1,
            status="failed",
        )
    )
    if exact_status is not None:
        job = enqueue_job(
            db_session,
            kind="media_content_reindex_job",
            payload={"media_id": str(media_id), "revision": 1},
        )
        if exact_status == "failed":
            _claim(
                db_session,
                job.id,
                "index-failed-worker",
                allowed_kinds=("media_content_reindex_job",),
            )
            assert (
                fail_job(
                    db_session,
                    job_id=job.id,
                    worker_id="index-failed-worker",
                    error_code="E_INDEX_RETRY",
                    error_message="retryable index failure",
                    retry_delays_seconds=(300,),
                )
                == "failed"
            )
        elif exact_status == "running":
            _claim(
                db_session,
                job.id,
                "index-running-worker",
                allowed_kinds=("media_content_reindex_job",),
            )
        elif exact_status == "succeeded":
            _claim(
                db_session,
                job.id,
                "index-complete-worker",
                allowed_kinds=("media_content_reindex_job",),
            )
            assert complete_job(
                db_session,
                job_id=job.id,
                worker_id="index-complete-worker",
            )
    db_session.flush()

    with pytest.raises(AssertionError, match="invariant defect"):
        read_media_activity(db_session, viewer_id=test_user.id, limit=1)


@pytest.mark.parametrize("index_status", ["no_text", "ocr_required"])
def test_terminal_index_outcomes_are_omitted(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
    index_status: str,
) -> None:
    media_id, attempt = _source_media(
        db_session,
        viewer_id=test_user.id,
        title=f"Terminal index {index_status}",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
        kind=MediaKind.epub,
    )
    attempt.status = "succeeded"
    db_session.add(
        ContentIndexState(
            owner_kind="media",
            owner_id=media_id,
            revision=1,
            status=index_status,
        )
    )
    db_session.flush()

    response = authenticated_client.get("/media/activity")
    assert response.status_code == 200, response.text
    assert response.json()["data"] == {
        "needs_attention_count": 0,
        "active_count": 0,
        "has_more": False,
        "items": [],
    }


def test_published_attempt_ignores_stale_source_failure_without_in_flight_progress(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    """A published run ignores stale source failure and emits no Activity item."""
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
    assert "Published then interrupted" not in by_title
    assert response.json()["data"] == {
        "needs_attention_count": 0,
        "active_count": 0,
        "has_more": False,
        "items": [],
    }


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

    activity = authenticated_client.get("/media/activity")
    assert activity.status_code == 200, activity.text
    activity_item = next(
        item for item in activity.json()["data"]["items"] if item["media_id"] == str(searchable_id)
    )
    assert activity_item["state"] == {
        "kind": "NeedsAttention",
        "scope": "Search",
        "stage": "Index",
        "failure_code": {"kind": "Present", "value": "E_WORKER_INTERRUPTED"},
    }

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
