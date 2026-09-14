"""Account- and publication-fenced access to the canonical reader cursor."""

from __future__ import annotations

from functools import partial
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.auth.account_binding import require_expected_account
from nexus.db.retries import retry_serializable
from nexus.errors import (
    ApiErrorCode,
    ConflictError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.schemas.reader import CursorWrite, PublicationCursorSource, TimelineCursorSource
from nexus.schemas.reader_progress import ReaderProgressState, ReaderProgressWrite
from nexus.services import reader_publication
from nexus.services.consumption import service as consumption

# A media whose cursor carries transcript locators is a timeline: it publishes no
# reader generation, and its progress is fenced by the timeline contract instead.
_TIMELINE_LOCATOR_KIND = "transcript"


def get(
    db: Session,
    *,
    viewer_id: UUID,
    expected_account_id: UUID,
    media_id: UUID,
) -> ReaderProgressState:
    require_expected_account(viewer_id, expected_account_id)
    visible = consumption.get_reader_cursor(db, viewer_id, media_id)
    generation = reader_publication.read_publication_generation(db, media_id=media_id)
    if generation is None and visible.locator_kind != _TIMELINE_LOCATOR_KIND:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return ReaderProgressState(
        account_id=viewer_id,
        reader_generation=generation,
        cursor=visible.cursor,
    )


def put(
    *,
    viewer_id: UUID,
    expected_account_id: UUID,
    media_id: UUID,
    write: ReaderProgressWrite,
) -> ReaderProgressState:
    require_expected_account(viewer_id, expected_account_id)
    # The consumption package owns this precondition: a session that already
    # holds a transaction would silently keep the ambient isolation level and
    # cost this write its serializable-equivalent linearization.
    db = consumption.fresh_session()
    try:
        return retry_serializable(
            db,
            "reader_progress_write",
            partial(_put_in_serializable_attempt, db, viewer_id, media_id, write),
        )
    finally:
        db.close()


def _put_in_serializable_attempt(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    write: ReaderProgressWrite,
) -> ReaderProgressState:
    # Visibility is checked before the generation comparison so a stale or
    # foreign media id cannot become an existence oracle.
    visible = consumption.get_reader_cursor(db, viewer_id, media_id)
    generation = reader_publication.lock_publication_generation(db, media_id=media_id)
    if generation is None:
        if visible.locator_kind != _TIMELINE_LOCATOR_KIND:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if write.expected_reader_generation is not None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Timeline progress has no publication generation"
            )
        source = TimelineCursorSource()
    else:
        source = PublicationCursorSource(reader_generation=generation)
    if generation != write.expected_reader_generation:
        raise ConflictError(
            ApiErrorCode.E_READER_CONTENT_CHANGED,
            "Reader publication changed",
        )
    cursor = consumption.put_reader_cursor_in_txn(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        write=CursorWrite(locator=write.locator, base_revision=write.base_revision),
        source=source,
    )
    db.commit()
    return ReaderProgressState(
        account_id=viewer_id,
        reader_generation=generation,
        cursor=cursor,
    )
