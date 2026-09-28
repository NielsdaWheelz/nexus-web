"""The reader cursor, one ``reader_media_state`` row per viewer and media.

No row reads as Empty at revision 0; a null locator is a revisioned Empty
tombstone. Every write advances the revision, admits a positioned locator
against its own source fragment first, and composes inside the caller's
transaction.
"""

from __future__ import annotations

from uuid import UUID

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

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
_LOCATOR_KIND = {
    "pdf": "pdf",
    "epub": "epub",
    "web_article": "web",
    "video": "transcript",
    "podcast_episode": "transcript",
}
_RESUME_STATE = TypeAdapter(ReaderResumeState)


def current_position_rows_sql() -> str:
    """Per-media cursor facts for one viewer (binds ``:viewer_id``).

    ``positioned`` tells an empty cursor from unknown progress; PDF pages carry
    no whole-document progression.
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


def load_snapshot(
    db: Session, *, viewer_id: UUID, media_id: UUID, media_kind: str
) -> ReaderCursorSnapshot:
    row = db.execute(
        text(
            "SELECT locator, revision FROM reader_media_state"
            " WHERE user_id = :viewer_id AND media_id = :media_id"
        ),
        {"viewer_id": viewer_id, "media_id": media_id},
    ).one_or_none()
    if row is None:
        return ReaderCursorEmpty()
    if row.locator is None:
        return ReaderCursorEmpty(revision=row.revision)
    try:
        locator = _RESUME_STATE.validate_python(row.locator)
        _check_kind(media_kind, locator)
    except (ValidationError, InvalidRequestError) as exc:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Stored reader state is invalid") from exc
    return ReaderCursorPositioned(revision=row.revision, locator=locator)


def put_in_txn(
    db: Session, *, viewer_id: UUID, media_id: UUID, media_kind: str, write: CursorWrite
) -> ReaderCursorPositioned:
    """Compare-and-set on ``base_revision``; re-saving the identical locator succeeds unchanged."""
    _check_kind(media_kind, write.locator)
    if isinstance(write.locator, EpubReaderResumeState):
        _admit_epub(db, media_id, write.locator)
    elif isinstance(write.locator, WebReaderResumeState):
        _admit_web(db, media_id, write.locator)
    current = load_snapshot(db, viewer_id=viewer_id, media_id=media_id, media_kind=media_kind)
    if isinstance(current, ReaderCursorPositioned) and current.locator == write.locator:
        return current
    if write.base_revision != current.revision:
        raise ConflictError(
            ApiErrorCode.E_READER_STATE_CONFLICT,
            "Reader cursor was updated elsewhere",
            details={"current": current.model_dump(mode="json")},
        )
    revision = _write(db, viewer_id, media_id, write.locator.model_dump(mode="json"))
    return ReaderCursorPositioned(revision=revision, locator=write.locator)


def reset_in_txn(db: Session, *, viewer_id: UUID, media_id: UUID) -> ReaderCursorEmpty:
    """Replace the cursor with a revisioned Empty tombstone."""
    return ReaderCursorEmpty(revision=_write(db, viewer_id, media_id, None))


def _write(db: Session, viewer_id: UUID, media_id: UUID, locator: object | None) -> int:
    return db.scalar(
        text("""
            INSERT INTO reader_media_state (user_id, media_id, locator, revision)
            VALUES (:viewer_id, :media_id, CAST(:locator AS jsonb), 1)
            ON CONFLICT (user_id, media_id) DO UPDATE
            SET locator = EXCLUDED.locator, revision = reader_media_state.revision + 1
            RETURNING revision
        """).bindparams(bindparam("locator", type_=JSONB(none_as_null=True))),
        {"viewer_id": viewer_id, "media_id": media_id, "locator": locator},
    )


def _admit_epub(db: Session, media_id: UUID, locator: EpubReaderResumeState) -> None:
    """An EPUB cursor addresses an owned source fragment at a real offset or anchor."""
    source = db.execute(
        text("""
            SELECT char_length(f.canonical_text) AS char_count, s.package_href, f.html_sanitized
            FROM fragments f
            JOIN epub_fragment_sources s ON s.media_id = f.media_id AND s.fragment_id = f.id
            WHERE f.media_id = :media_id AND f.id = :fragment_id
        """),
        {"media_id": media_id, "fragment_id": locator.target.fragment_id},
    ).one_or_none()
    if source is None or source.package_href != locator.target.href_path:
        raise InvalidRequestError(message="EPUB cursor must address an owned source fragment")
    offset, anchor = locator.locations.text_offset, locator.target.anchor_id
    if offset is not None:
        if offset > source.char_count:
            raise InvalidRequestError(message="EPUB cursor offset exceeds its source fragment")
    elif anchor.kind == "Absent":
        raise InvalidRequestError(message="EPUB cursor requires an exact offset or source anchor")
    elif anchor.value not in canonicalize_structure(source.html_sanitized).anchors:
        raise InvalidRequestError(message="EPUB cursor anchor must identify one source element")


def _admit_web(db: Session, media_id: UUID, locator: WebReaderResumeState) -> None:
    """A web cursor names a canonical owned fragment id and a real offset."""
    try:
        fragment_id = UUID(locator.target.fragment_id)
    except ValueError:
        fragment_id = None
    if fragment_id is None or str(fragment_id) != locator.target.fragment_id:
        raise InvalidRequestError(message="Web cursor fragment identity must be canonical")
    char_count = db.scalar(
        text(
            "SELECT char_length(canonical_text) FROM fragments"
            " WHERE media_id = :media_id AND id = :fragment_id"
        ),
        {"media_id": media_id, "fragment_id": fragment_id},
    )
    if char_count is None:
        raise InvalidRequestError(message="Web cursor must address an owned source fragment")
    offset = locator.locations.text_offset
    if offset is not None and offset > char_count:
        raise InvalidRequestError(message="Web cursor offset exceeds its source fragment")


def _check_kind(media_kind: str, locator: ReaderResumeState) -> None:
    if locator.kind != _LOCATOR_KIND[media_kind]:
        raise InvalidRequestError(
            message=f"Reader state kind '{locator.kind}' does not match media kind '{media_kind}'"
        )
