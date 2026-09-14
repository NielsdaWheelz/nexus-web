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
    ReaderCursorSource,
    ReaderResumeState,
    TimelineCursorSource,
)

_EXPECTED_LOCATOR_KINDS = {
    MediaKind.pdf.value: "pdf",
    MediaKind.epub.value: "epub",
    MediaKind.web_article.value: "web",
    MediaKind.video.value: "transcript",
    MediaKind.podcast_episode.value: "transcript",
}
_READER_RESUME_STATE_ADAPTER = TypeAdapter(ReaderResumeState)
_READER_CURSOR_SOURCE_ADAPTER = TypeAdapter(ReaderCursorSource)
_SELECT_CURSOR_SQL = text("""
    SELECT id, locator, revision, source
    FROM reader_media_state
    WHERE user_id = :viewer_id AND media_id = :media_id
""")
_INSERT_CURSOR_SQL = text("""
    INSERT INTO reader_media_state (user_id, media_id, locator, revision, source)
    VALUES (:viewer_id, :media_id, CAST(:locator AS jsonb), 1, CAST(:source AS jsonb))
""").bindparams(bindparam("locator", type_=JSONB), bindparam("source", type_=JSONB))
_INSERT_EMPTY_CURSOR_SQL = text("""
    INSERT INTO reader_media_state (user_id, media_id, locator, revision)
    VALUES (:viewer_id, :media_id, NULL, 1)
""")
_UPDATE_CURSOR_SQL = text("""
    UPDATE reader_media_state
    SET locator = CAST(:locator AS jsonb), source = CAST(:source AS jsonb),
        revision = revision + 1, updated_at = now()
    WHERE id = :state_id AND revision = :base_revision
""").bindparams(bindparam("locator", type_=JSONB), bindparam("source", type_=JSONB))
_RESET_CURSOR_SQL = text("""
    UPDATE reader_media_state
    SET locator = NULL, source = NULL, revision = revision + 1, updated_at = now()
    WHERE id = :state_id AND revision = :base_revision
""")


def supports_media_kind(media_kind: str) -> bool:
    return media_kind in _EXPECTED_LOCATOR_KINDS


def expected_locator_kind(media_kind: str) -> str:
    """The one locator kind a supported reader media may carry."""
    locator_kind = _EXPECTED_LOCATOR_KINDS.get(media_kind)
    if locator_kind is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Reader state is not supported for media kind '{media_kind}'",
        )
    return locator_kind


def validate_locator_for_media(media_kind: str, locator: ReaderResumeState) -> None:
    """Reject a cursor locator whose one supported kind mismatches its media."""
    if locator.kind != expected_locator_kind(media_kind):
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
        row["source"],
        media_kind=media_kind,
    )


def put_in_txn(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    media_kind: str,
    write: CursorWrite,
    source: ReaderCursorSource,
) -> ReaderCursorPositioned:
    """CAS-replace a positioned cursor within the caller's transaction."""
    validate_locator_for_media(media_kind, write.locator)
    _validate_source_for_locator(source, write.locator)
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
                "source": source.model_dump(mode="json"),
            },
        )
        return ReaderCursorPositioned(revision=1, locator=write.locator, source=source)

    current = _snapshot_from_row(
        row["locator"],
        int(row["revision"]),
        row["source"],
        media_kind=media_kind,
    )
    if (
        isinstance(current, ReaderCursorPositioned)
        and current.locator == write.locator
        and current.source == source
    ):
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
                "source": source.model_dump(mode="json"),
            },
        ),
    )
    # justify-defect: the caller serializes this viewer and this transaction
    # already read the exact revision that the CAS replaces.
    assert result.rowcount == 1
    return ReaderCursorPositioned(
        revision=current.revision + 1, locator=write.locator, source=source
    )


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
        row["source"],
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


def _snapshot_from_row(
    locator_payload: object | None,
    revision: int,
    source_payload: object | None,
    *,
    media_kind: str,
) -> ReaderCursorSnapshot:
    if revision < 1:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Stored reader state revision is invalid")
    if locator_payload is None:
        if source_payload is not None:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Empty reader state has a source")
        return ReaderCursorEmpty(revision=revision)
    try:
        locator = _READER_RESUME_STATE_ADAPTER.validate_python(locator_payload)
        source = _READER_CURSOR_SOURCE_ADAPTER.validate_python(source_payload)
        validate_locator_for_media(media_kind, locator)
        _validate_source_for_locator(source, locator)
    except (ValidationError, InvalidRequestError) as exc:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Stored reader state is invalid") from exc
    return ReaderCursorPositioned(revision=revision, locator=locator, source=source)


def _validate_source_for_locator(source: ReaderCursorSource, locator: ReaderResumeState) -> None:
    if isinstance(source, TimelineCursorSource) != (locator.kind == "transcript"):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Reader cursor source does not match its locator"
        )


def _cursor_conflict(current: ReaderCursorSnapshot) -> ConflictError:
    return ConflictError(
        ApiErrorCode.E_READER_STATE_CONFLICT,
        "Reader cursor was updated elsewhere",
        details={"current": current.model_dump(mode="json")},
    )
