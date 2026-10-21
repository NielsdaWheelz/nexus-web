"""The media processing-status transitions.

The failure pair (code, message) moves with the status (I3), so lifecycles call these and
never write the columns. Metadata research writes none of them.
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy import func, text
from sqlalchemy.orm import Session

from nexus.db.models import Media, ProcessingStatus
from nexus.services.x_source import retained_x_publication_sql

_SET_BY_ID = """
    UPDATE media SET processing_status = :status, last_error_code = :code,
        last_error_message = :message, updated_at = :now
    WHERE id = :media_id
"""


def mark_media_failed_by_id(
    db: Session, *, media_id: UUID, error_code: str, error_message: str, now: datetime
) -> None:
    """Terminal failure of one media row the caller locked."""
    db.execute(
        text(_SET_BY_ID),
        {
            "media_id": media_id,
            "status": ProcessingStatus.failed.value,
            "code": error_code,
            "message": error_message,
            "now": now,
        },
    )


def mark_ready_for_reading_by_id(db: Session, *, media_id: UUID, now: datetime) -> None:
    """Readable, failure cleared; the caller owns the transaction."""
    db.execute(
        text(_SET_BY_ID),
        {
            "media_id": media_id,
            "status": ProcessingStatus.ready_for_reading.value,
            "code": None,
            "message": None,
            "now": now,
        },
    )


def retained_publication_sql(alias: str) -> str:
    """Boolean SQL: the media keeps a readable copy through its source work, a document's
    reader publication (a native x source's needs its saved posts too)."""
    return f"""(CASE WHEN {alias}.provider = 'x' THEN {retained_x_publication_sql(alias)}
        ELSE EXISTS (SELECT 1 FROM reader_publications rp WHERE rp.media_id = {alias}.id) END)"""


def _record(
    db: Session, media: Media, status: ProcessingStatus, code: str | None, message: str | None
) -> None:
    media.processing_status = status
    media.last_error_code = code
    media.last_error_message = message
    media.updated_at = func.now()
    db.flush()


def mark_extracting(db: Session, media: Media) -> None:
    """Queued or starting source work is extracting; any failure clears. A retained
    publication keeps its media readable through a refresh instead."""
    retained = text(f"SELECT {retained_publication_sql('m')} FROM media m WHERE m.id = :id")
    if db.scalar(retained, {"id": media.id}):
        if media.processing_status != ProcessingStatus.ready_for_reading:
            mark_ready_for_reading(db, media)
        return
    _record(db, media, ProcessingStatus.extracting, None, None)


def mark_ready_for_reading(db: Session, media: Media) -> None:
    _record(db, media, ProcessingStatus.ready_for_reading, None, None)


def mark_stage_warning(db: Session, media: Media, *, error_code: str, error_message: str) -> None:
    """A problem that leaves readability as it is: recorded, the status unchanged."""
    _record(db, media, media.processing_status, error_code, error_message)
