"""Owner-API builders for the Imports query's synthetic backlog.

Imports projects three independent owners — source attempts, their queue rows,
and upload sessions — so every proof of that projection has to stand one up
before it can assert anything. These builders own that plumbing alone; each
scenario still writes its own states and assertions.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy.orm import Session

from nexus.db.models import (
    Media,
    MediaKind,
    MediaSourceAttempt,
    MediaUploadSession,
    ProcessingStatus,
)
from nexus.jobs.queue import JobRow, enqueue_job
from nexus.services.library_entries import ensure_media_in_default_library
from tests.testkit.queue_claims import claim_job_row


def create_source_media(
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
    """Create one library-visible media and the source attempt that carries it."""
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
        intent_key=f"imports-{uuid4()}",
        processing_stage="Extract",
        progress_completed=progress[0] if progress else 0,
        progress_total=progress[1] if progress else None,
        progress_unit="Page" if progress else None,
        progress_updated_at=datetime.now(UTC),
    )
    db.add(attempt)
    db.flush()
    return media_id, attempt


def enqueue_source_job(
    db: Session,
    *,
    media_id: UUID,
    attempt: MediaSourceAttempt,
    max_attempts: int,
) -> JobRow:
    """Enqueue the ingest operation one source attempt names as its exact job."""
    job = enqueue_job(
        db,
        kind="ingest_media_source",
        payload={"media_id": str(media_id), "attempt_id": str(attempt.id)},
        max_attempts=max_attempts,
    )
    attempt.job_id = job.id
    db.flush()
    return job


def claim_heavy_job(
    db: Session,
    job_id: UUID,
    worker_id: str,
    *,
    allowed_kinds: tuple[str, ...] = ("ingest_media_source",),
) -> JobRow:
    """Claim one exact Heavy operation through the canonical queue transition."""
    claimed = claim_job_row(
        db,
        job_id=job_id,
        worker_id=worker_id,
        lease_seconds=300,
        allowed_kinds=allowed_kinds,
        heavy_kinds=("ingest_media_source", "media_content_reindex_job"),
    )
    assert claimed is not None, f"expected {job_id} to be claimable"
    return claimed


def create_upload_session(
    db: Session,
    *,
    viewer_id: UUID,
    filename: str,
    expires_at: datetime,
    transport_failure_kind: str | None = None,
    verification_error_code: str | None = None,
) -> MediaUploadSession:
    """Create one durable upload obligation with its named failure fact, if any."""
    now = datetime.now(UTC)
    session = MediaUploadSession(
        id=uuid4(),
        created_by_user_id=viewer_id,
        candidate_media_id=uuid4(),
        kind="epub",
        filename=filename,
        content_type="application/epub+zip",
        expected_size_bytes=4096,
        idempotency_key=f"imports-upload-{uuid4()}",
        request_id=f"imports-request-{uuid4()}",
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
