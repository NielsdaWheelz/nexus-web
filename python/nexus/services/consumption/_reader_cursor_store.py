"""Sole persistence owner of ``reader_media_state``.

An absent row is Empty revision 0. A row with a null locator is a revisioned
Empty tombstone; a positioned locator is schema-validated before it leaves this
store. Every write composes inside the caller's open transaction.
"""

from __future__ import annotations

from typing import Any, cast
from uuid import UUID

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Session

from nexus.db.models import MediaKind
from nexus.errors import ApiError, ApiErrorCode, ConflictError, InvalidRequestError
from nexus.schemas.reader import (
    CursorWrite,
    ReaderCursorEmpty,
    ReaderCursorPositioned,
    ReaderCursorSnapshot,
    ReaderResumeState,
)

READER_MEDIA_STATE_MEDIA_FK = "fk_reader_media_state_media"
_READER_RESUME_STATE_ADAPTER = TypeAdapter(ReaderResumeState)
_SELECT_CURSOR_SQL = text("""
    SELECT id, locator, revision
    FROM reader_media_state
    WHERE user_id = :viewer_id AND media_id = :media_id
""")
_INSERT_CURSOR_SQL = text("""
    INSERT INTO reader_media_state (user_id, media_id, locator, revision)
    VALUES (:viewer_id, :media_id, CAST(:locator AS jsonb), 1)
""").bindparams(bindparam("locator", type_=JSONB))
_INSERT_EMPTY_CURSOR_SQL = text("""
    INSERT INTO reader_media_state (user_id, media_id, locator, revision)
    VALUES (:viewer_id, :media_id, NULL, 1)
""")
_UPDATE_CURSOR_SQL = text("""
    UPDATE reader_media_state
    SET locator = CAST(:locator AS jsonb), revision = revision + 1, updated_at = now()
    WHERE id = :state_id AND revision = :base_revision
""").bindparams(bindparam("locator", type_=JSONB))
_RESET_CURSOR_SQL = text("""
    UPDATE reader_media_state
    SET locator = NULL, revision = revision + 1, updated_at = now()
    WHERE id = :state_id AND revision = :base_revision
""")


def supports_media_kind(media_kind: str) -> bool:
    return media_kind in {
        MediaKind.pdf.value,
        MediaKind.epub.value,
        MediaKind.web_article.value,
        MediaKind.video.value,
        MediaKind.podcast_episode.value,
    }


def validate_locator_for_media(media_kind: str, locator: ReaderResumeState) -> None:
    """Reject a cursor locator whose one supported kind mismatches its media."""
    expected_kind = _expected_locator_kind(media_kind)
    if expected_kind is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Reader state is not supported for media kind '{media_kind}'",
        )
    if locator.kind != expected_kind:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Reader state kind '{locator.kind}' does not match media kind '{media_kind}'",
        )


def load_snapshot(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    media_kind: str,
) -> ReaderCursorSnapshot:
    """Read the canonical positioned cursor or revisioned Empty snapshot."""
    row = (
        db.execute(
            _SELECT_CURSOR_SQL,
            {"viewer_id": viewer_id, "media_id": media_id},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        return ReaderCursorEmpty()
    return _snapshot_from_row(
        row["locator"],
        int(row["revision"]),
        media_kind=media_kind,
    )


def put_in_txn(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    media_kind: str,
    write: CursorWrite,
) -> ReaderCursorPositioned:
    """CAS-replace a positioned cursor within the caller's transaction."""
    validate_locator_for_media(media_kind, write.locator)
    row = (
        db.execute(
            _SELECT_CURSOR_SQL,
            {"viewer_id": viewer_id, "media_id": media_id},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        if write.base_revision != 0:
            raise _cursor_conflict(ReaderCursorEmpty())
        db.execute(
            _INSERT_CURSOR_SQL,
            {
                "viewer_id": viewer_id,
                "media_id": media_id,
                "locator": write.locator.model_dump(mode="json"),
            },
        )
        return ReaderCursorPositioned(revision=1, locator=write.locator)

    current = _snapshot_from_row(
        row["locator"],
        int(row["revision"]),
        media_kind=media_kind,
    )
    if isinstance(current, ReaderCursorPositioned) and current.locator == write.locator:
        return current
    if write.base_revision != current.revision:
        raise _cursor_conflict(current)
    result = cast(
        CursorResult[Any],
        db.execute(
            _UPDATE_CURSOR_SQL,
            {
                "state_id": row["id"],
                "base_revision": current.revision,
                "locator": write.locator.model_dump(mode="json"),
            },
        ),
    )
    # justify-defect: the caller serializes this viewer and this transaction
    # already read the exact revision that the CAS replaces.
    assert result.rowcount == 1
    return ReaderCursorPositioned(revision=current.revision + 1, locator=write.locator)


def reset_in_txn(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    media_kind: str,
) -> ReaderCursorEmpty:
    """Replace the cursor with a revisioned Empty tombstone."""
    row = (
        db.execute(
            _SELECT_CURSOR_SQL,
            {"viewer_id": viewer_id, "media_id": media_id},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        db.execute(
            _INSERT_EMPTY_CURSOR_SQL,
            {"viewer_id": viewer_id, "media_id": media_id},
        )
        return ReaderCursorEmpty(revision=1)

    current = _snapshot_from_row(
        row["locator"],
        int(row["revision"]),
        media_kind=media_kind,
    )
    result = cast(
        CursorResult[Any],
        db.execute(
            _RESET_CURSOR_SQL,
            {
                "state_id": row["id"],
                "base_revision": current.revision,
            },
        ),
    )
    # justify-defect: the caller serializes this viewer and this transaction
    # already read the exact revision that reset replaces.
    assert result.rowcount == 1
    return ReaderCursorEmpty(revision=current.revision + 1)


def delete_all_users_in_txn(db: Session, *, media_id: UUID) -> None:
    """Delete every cursor row for a media during physical teardown."""
    db.execute(
        text("DELETE FROM reader_media_state WHERE media_id = :media_id"),
        {"media_id": media_id},
    )


def _expected_locator_kind(media_kind: str) -> str | None:
    if media_kind == MediaKind.pdf.value:
        return "pdf"
    if media_kind == MediaKind.epub.value:
        return "epub"
    if media_kind == MediaKind.web_article.value:
        return "web"
    if media_kind in {MediaKind.video.value, MediaKind.podcast_episode.value}:
        return "transcript"
    return None


def _snapshot_from_row(
    locator_payload: object | None,
    revision: int,
    *,
    media_kind: str,
) -> ReaderCursorSnapshot:
    if revision < 1:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Stored reader state revision is invalid")
    if locator_payload is None:
        return ReaderCursorEmpty(revision=revision)
    try:
        locator = _READER_RESUME_STATE_ADAPTER.validate_python(locator_payload)
        validate_locator_for_media(media_kind, locator)
    except (ValidationError, InvalidRequestError) as exc:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Stored reader state is invalid") from exc
    return ReaderCursorPositioned(revision=revision, locator=locator)


def _cursor_conflict(current: ReaderCursorSnapshot) -> ConflictError:
    return ConflictError(
        ApiErrorCode.E_READER_STATE_CONFLICT,
        "Reader cursor was updated elsewhere",
        details={"current": current.model_dump(mode="json")},
    )
