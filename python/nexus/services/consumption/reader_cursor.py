"""Sole persistence owner of ``reader_media_state``.

No row is Empty at revision 0; a row with a null locator is a revisioned Empty
tombstone; a positioned locator is admitted against its own source fragment
before it is stored. Every write composes inside the caller's transaction.
"""

from __future__ import annotations

from uuid import UUID

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.db.models import MediaKind
from nexus.errors import ApiError, ApiErrorCode, ConflictError, InvalidRequestError
from nexus.schemas.reader import (
    CursorWrite,
    EpubReaderResumeState,
    ReaderCursorEmpty,
    ReaderCursorPositioned,
    ReaderCursorSnapshot,
    ReaderResumeState,
    WebReaderResumeState,
)
from nexus.services.canonicalize import canonicalize_structure

MEDIA_FK = "fk_reader_media_state_media"

_LOCATOR_KIND: dict[str, str] = {
    MediaKind.pdf.value: "pdf",
    MediaKind.epub.value: "epub",
    MediaKind.web_article.value: "web",
    MediaKind.video.value: "transcript",
    MediaKind.podcast_episode.value: "transcript",
}
_RESUME_STATE = TypeAdapter(ReaderResumeState)
_SELECT = text("""
    SELECT id, locator, revision
    FROM reader_media_state
    WHERE user_id = :viewer_id AND media_id = :media_id
""")
_UPDATE = text("""
    UPDATE reader_media_state
    SET locator = CAST(:locator AS jsonb), revision = revision + 1, updated_at = now()
    WHERE id = :state_id
""").bindparams(bindparam("locator", type_=JSONB))
_INSERT = text("""
    INSERT INTO reader_media_state (user_id, media_id, locator, revision)
    VALUES (:viewer_id, :media_id, CAST(:locator AS jsonb), 1)
""").bindparams(bindparam("locator", type_=JSONB))


def current_position_rows_sql() -> str:
    """Current viewer cursor facts; a missing row and an empty locator both start at zero.

    ``positioned`` distinguishes unknown whole-document progress from an empty
    cursor. PDF page positions deliberately carry no whole-document progression.
    The composing query binds ``viewer_id``.
    """
    return """
        SELECT media_id,
               locator IS NOT NULL AS positioned,
               CASE WHEN locator->>'kind' IN ('web', 'epub')
                    THEN (locator->'locations'->>'total_progression')::float8
                    ELSE NULL::float8
               END AS total_progression
        FROM reader_media_state
        WHERE user_id = :viewer_id
    """


def supports_media_kind(media_kind: str) -> bool:
    return media_kind in _LOCATOR_KIND


def validate_locator_for_media(media_kind: str, locator: ReaderResumeState) -> None:
    """Reject a cursor locator whose kind does not match its media."""
    expected = _LOCATOR_KIND.get(media_kind)
    if expected is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Reader state is not supported for media kind '{media_kind}'",
        )
    if locator.kind != expected:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Reader state kind '{locator.kind}' does not match media kind '{media_kind}'",
        )


def load_snapshot(
    db: Session, *, viewer_id: UUID, media_id: UUID, media_kind: str
) -> ReaderCursorSnapshot:
    row = (
        db.execute(_SELECT, {"viewer_id": viewer_id, "media_id": media_id}).mappings().one_or_none()
    )
    if row is None:
        return ReaderCursorEmpty()
    return _snapshot(row["locator"], int(row["revision"]), media_kind=media_kind)


def put_in_txn(
    db: Session, *, viewer_id: UUID, media_id: UUID, media_kind: str, write: CursorWrite
) -> ReaderCursorPositioned:
    """CAS-replace the cursor; an identical locator re-save is a no-op success."""
    validate_locator_for_media(media_kind, write.locator)
    if isinstance(write.locator, EpubReaderResumeState):
        _admit_epub(db, media_id=media_id, locator=write.locator)
    elif isinstance(write.locator, WebReaderResumeState):
        _admit_web(db, media_id=media_id, locator=write.locator)

    row = (
        db.execute(_SELECT, {"viewer_id": viewer_id, "media_id": media_id}).mappings().one_or_none()
    )
    payload = write.locator.model_dump(mode="json")
    if row is None:
        if write.base_revision != 0:
            raise _conflict(ReaderCursorEmpty())
        db.execute(_INSERT, {"viewer_id": viewer_id, "media_id": media_id, "locator": payload})
        return ReaderCursorPositioned(revision=1, locator=write.locator)

    current = _snapshot(row["locator"], int(row["revision"]), media_kind=media_kind)
    if isinstance(current, ReaderCursorPositioned) and current.locator == write.locator:
        return current
    if write.base_revision != current.revision:
        raise _conflict(current)
    db.execute(_UPDATE, {"state_id": row["id"], "locator": payload})
    return ReaderCursorPositioned(revision=current.revision + 1, locator=write.locator)


def reset_in_txn(db: Session, *, viewer_id: UUID, media_id: UUID) -> ReaderCursorEmpty:
    """Replace the cursor with a revisioned Empty tombstone."""
    revision = db.scalar(
        text("""
            INSERT INTO reader_media_state (user_id, media_id, locator, revision)
            VALUES (:viewer_id, :media_id, NULL, 1)
            ON CONFLICT (user_id, media_id) DO UPDATE
            SET locator = NULL,
                revision = reader_media_state.revision + 1,
                updated_at = now()
            RETURNING revision
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )
    return ReaderCursorEmpty(revision=int(revision))


def delete_all_users_in_txn(db: Session, *, media_id: UUID) -> None:
    db.execute(
        text("DELETE FROM reader_media_state WHERE media_id = :media_id"), {"media_id": media_id}
    )


def _admit_epub(db: Session, *, media_id: UUID, locator: EpubReaderResumeState) -> None:
    """An EPUB cursor addresses an owned source fragment at a real position."""
    source = db.execute(
        text("""
            SELECT char_length(f.canonical_text) AS char_count, s.package_href
            FROM fragments f
            JOIN epub_fragment_sources s ON s.media_id = f.media_id AND s.fragment_id = f.id
            WHERE f.media_id = :media_id AND f.id = :fragment_id
        """),
        {"media_id": media_id, "fragment_id": locator.target.fragment_id},
    ).one_or_none()
    if source is None or source.package_href != locator.target.href_path:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "EPUB cursor must address an owned source fragment"
        )
    offset = locator.locations.text_offset
    if offset is not None:
        if offset > source.char_count:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "EPUB cursor offset exceeds its source fragment"
            )
        return
    anchor = locator.target.anchor_id
    if anchor.kind == "Absent":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "EPUB cursor requires an exact offset or source anchor"
        )
    html_sanitized = db.scalar(
        text(
            "SELECT html_sanitized FROM fragments WHERE media_id = :media_id AND id = :fragment_id"
        ),
        {"media_id": media_id, "fragment_id": locator.target.fragment_id},
    )
    if anchor.value not in canonicalize_structure(html_sanitized).anchors:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "EPUB cursor anchor must identify one source element"
        )


def _admit_web(db: Session, *, media_id: UUID, locator: WebReaderResumeState) -> None:
    """A web cursor names a canonical owned fragment id and a real offset."""
    try:
        fragment_id = UUID(locator.target.fragment_id)
    except ValueError as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Web cursor fragment identity must be canonical"
        ) from exc
    if str(fragment_id) != locator.target.fragment_id:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Web cursor fragment identity must be canonical"
        )
    char_count = db.scalar(
        text("""
            SELECT char_length(canonical_text) FROM fragments
            WHERE media_id = :media_id AND id = :fragment_id
        """),
        {"media_id": media_id, "fragment_id": fragment_id},
    )
    if char_count is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Web cursor must address an owned source fragment"
        )
    offset = locator.locations.text_offset
    if offset is not None and offset > char_count:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Web cursor offset exceeds its source fragment"
        )


def _snapshot(
    locator_payload: object | None, revision: int, *, media_kind: str
) -> ReaderCursorSnapshot:
    if locator_payload is None:
        return ReaderCursorEmpty(revision=revision)
    try:
        locator = _RESUME_STATE.validate_python(locator_payload)
        validate_locator_for_media(media_kind, locator)
    except (ValidationError, InvalidRequestError) as exc:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Stored reader state is invalid") from exc
    return ReaderCursorPositioned(revision=revision, locator=locator)


def _conflict(current: ReaderCursorSnapshot) -> ConflictError:
    return ConflictError(
        ApiErrorCode.E_READER_STATE_CONFLICT,
        "Reader cursor was updated elsewhere",
        details={"current": current.model_dump(mode="json")},
    )
