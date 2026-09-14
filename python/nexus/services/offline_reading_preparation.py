"""Authorize/deduplicate worker preparation and read the ready archive reference."""

from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import Media, ReaderPublicationArtifact
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.jobs.queue import enqueue_unique_job
from nexus.schemas.offline_reading_package import OFFLINE_READING_READER_CONTRACT_VERSION
from nexus.schemas.offline_reading_preparation import (
    OFFLINE_ARCHIVE_MEMBER_KEY,
    OFFLINE_ARCHIVE_SCHEMA_VERSION,
    OFFLINE_PACKAGE_FAILURE_REASONS,
    OfflinePackageFailed,
    OfflinePackagePreparing,
    OfflinePackageReady,
    OfflinePackageStatus,
)
from nexus.services.reader_publication_read import get_reader_publication_member_for_viewer

OFFLINE_PACKAGE_PREPARATION_JOB_KIND = "prepare_offline_reading_package"


def _job_key(media_id: UUID, generation: int) -> str:
    return (
        f"offline-reading:{media_id}:{generation}"
        f":package-{OFFLINE_ARCHIVE_SCHEMA_VERSION}"
        f":reader-{OFFLINE_READING_READER_CONTRACT_VERSION}"
    )


def require_offline_publication_for_viewer(
    db: Session, *, viewer_id: UUID, media_id: UUID, generation: int
) -> None:
    get_reader_publication_member_for_viewer(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        generation=generation,
        key="descriptor.json",
        role="descriptor",
    )


def read_ready_offline_archive(
    db: Session, *, media_id: UUID, generation: int
) -> ReaderPublicationArtifact | None:
    return db.scalar(
        select(ReaderPublicationArtifact).where(
            ReaderPublicationArtifact.media_id == media_id,
            ReaderPublicationArtifact.generation == generation,
            ReaderPublicationArtifact.path == OFFLINE_ARCHIVE_MEMBER_KEY,
            ReaderPublicationArtifact.role == "archive",
        )
    )


def ensure_offline_package_for_viewer(
    db: Session, *, viewer_id: UUID, media_id: UUID, generation: int
) -> bool:
    require_offline_publication_for_viewer(
        db, viewer_id=viewer_id, media_id=media_id, generation=generation
    )
    if read_ready_offline_archive(db, media_id=media_id, generation=generation) is not None:
        return True
    # Media precedes jobs, as in media deletion and existing source publication.
    db.execute(select(Media.id).where(Media.id == media_id).with_for_update()).scalar_one()
    # A dead-lettered preparation stays dead: this request only enqueues absent
    # work. Re-arming it is an operator repair, not a side effect of a read-
    # authorized POST, and the status route reports its typed failure instead.
    enqueue_unique_job(
        db,
        kind=OFFLINE_PACKAGE_PREPARATION_JOB_KIND,
        payload={"media_id": str(media_id), "generation": generation},
        dedupe_key=_job_key(media_id, generation),
    )
    db.commit()
    return False


def read_offline_package_status_for_viewer(
    db: Session, *, viewer_id: UUID, media_id: UUID, generation: int
) -> OfflinePackageStatus:
    require_offline_publication_for_viewer(
        db, viewer_id=viewer_id, media_id=media_id, generation=generation
    )
    if read_ready_offline_archive(db, media_id=media_id, generation=generation) is not None:
        return OfflinePackageStatus(reader_generation=generation, state=OfflinePackageReady())
    job = db.execute(
        text("SELECT status, error_code FROM background_jobs WHERE dedupe_key = :key"),
        {"key": _job_key(media_id, generation)},
    ).one_or_none()
    if job is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Offline preparation was not requested")
    if job.status == "succeeded":
        # justify-defect: the task commits the archive row in the same
        # transaction that renews its claim, so a succeeded preparation without
        # a ready archive means that commit or its row was lost.
        raise AssertionError("successful offline preparation has no ready archive")
    if job.status == "dead":
        state = OfflinePackageFailed(
            reason=OFFLINE_PACKAGE_FAILURE_REASONS.get(job.error_code, "Server")
        )
    else:
        state = OfflinePackagePreparing()
    return OfflinePackageStatus(reader_generation=generation, state=state)
