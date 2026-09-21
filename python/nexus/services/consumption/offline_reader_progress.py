"""Account- and publication-fenced access to the canonical reader cursor."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, ConflictError, ForbiddenError, NotFoundError
from nexus.schemas.offline_reader_progress import OfflineReaderState, OfflineReaderWrite
from nexus.schemas.reader import CursorWrite
from nexus.services import reader_publication
from nexus.services.consumption import service as consumption


def get(
    db: Session, *, viewer_id: UUID, expected_account_id: UUID, media_id: UUID
) -> OfflineReaderState:
    _require_expected_account(viewer_id, expected_account_id)
    cursor = consumption.get_reader_cursor(db, viewer_id, media_id)
    generation = reader_publication.read_publication_generation(db, media_id=media_id)
    if generation is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return OfflineReaderState(account_id=viewer_id, reader_generation=generation, cursor=cursor)


def put(
    *, viewer_id: UUID, expected_account_id: UUID, media_id: UUID, write: OfflineReaderWrite
) -> OfflineReaderState:
    _require_expected_account(viewer_id, expected_account_id)
    # A session already holding a transaction would keep the ambient isolation
    # level and cost this write its serializable-equivalent linearization.
    with consumption.fresh_session() as db:
        return retry_serializable(
            db, "offline_reader_cursor_write", lambda: _put(db, viewer_id, media_id, write)
        )


def _put(
    db: Session, viewer_id: UUID, media_id: UUID, write: OfflineReaderWrite
) -> OfflineReaderState:
    # Visibility is checked before the generation comparison so a stale or
    # foreign media id cannot become an existence oracle.
    consumption.get_reader_cursor(db, viewer_id, media_id)
    generation = reader_publication.lock_publication_generation(db, media_id=media_id)
    if generation is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if generation != write.expected_reader_generation:
        raise ConflictError(ApiErrorCode.E_READER_CONTENT_CHANGED, "Reader publication changed")
    cursor = consumption.put_reader_cursor_in_txn(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        write=CursorWrite(locator=write.locator, base_revision=write.base_revision),
    )
    db.commit()
    return OfflineReaderState(account_id=viewer_id, reader_generation=generation, cursor=cursor)


def _require_expected_account(viewer_id: UUID, expected_account_id: UUID) -> None:
    if expected_account_id != viewer_id:
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN, "Account binding does not match authenticated viewer"
        )
