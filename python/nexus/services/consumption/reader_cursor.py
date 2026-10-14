"""The reader cursor, one ``reader_media_state`` row per viewer and media.

No row reads as Empty at revision 0; a null locator is a revisioned Empty
tombstone. Changed writes advance the revision; accepted equal saves keep it. Each
save admits a positioned locator against its own source fragment first, and composes
inside the caller's transaction.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
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
    ReaderFragmentTarget,
    ReaderQuoteContext,
    ReaderResumeState,
    ReaderTextLocations,
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


@dataclass(frozen=True, slots=True)
class _CursorRemap:
    user_id: UUID
    before: WebReaderResumeState
    fragment_index: int
    offset: int
    total_progression: float


@dataclass(frozen=True, slots=True)
class CursorRemapPlan:
    """Exact locations prepared under the publication and cursor row locks."""

    media_id: UUID
    moves: tuple[_CursorRemap, ...]


def prepare_source_replacement(
    db: Session, *, media_id: UUID, replacement_texts: Sequence[str]
) -> CursorRemapPlan:
    """Lock every saved cursor and map it before the caller replaces its fragments.

    The caller holds the publication lock. Web saves take it before reading a
    cursor, so even a first save cannot enter between this plan and publication.
    """
    rows = db.execute(
        text(
            "SELECT user_id, locator FROM reader_media_state WHERE media_id = :media_id"
            " ORDER BY user_id FOR UPDATE"
        ),
        {"media_id": media_id},
    ).all()
    fragments = {
        str(row.id): row.canonical_text
        for row in db.execute(
            text("SELECT id, canonical_text FROM fragments WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
    }
    starts: list[int] = []
    total = 0
    for content in replacement_texts:
        starts.append(total)
        total += len(content)
    moves: list[_CursorRemap] = []
    for row in rows:
        if row.locator is None:
            continue
        try:
            before = _RESUME_STATE.validate_python(row.locator)
        except ValidationError:
            raise _unmappable() from None
        if not isinstance(before, WebReaderResumeState):
            raise _unmappable()
        original = fragments.get(before.target.fragment_id)
        offset = before.locations.text_offset
        if original is None or offset is None or not 0 <= offset <= len(original):
            raise _unmappable()
        match = _unique_source_match(original, replacement_texts)
        relative = offset
        if match is None:
            start = max(0, offset - 64)
            window = original[start : offset + 64]
            match = _unique_source_match(window, replacement_texts)
            relative = offset - start
        if match is None:
            raise _unmappable()
        index, start = match
        mapped_offset = start + relative
        moves.append(
            _CursorRemap(
                row.user_id,
                before,
                index,
                mapped_offset,
                (starts[index] + mapped_offset) / total,
            )
        )
    return CursorRemapPlan(media_id, tuple(moves))


def apply_source_replacement(
    db: Session, *, plan: CursorRemapPlan, replacement_fragment_ids: Sequence[UUID]
) -> None:
    """Install prepared locations in the same transaction, without reading activity."""
    for move in plan.moves:
        locator = WebReaderResumeState(
            kind="web",
            target=ReaderFragmentTarget(
                fragment_id=str(replacement_fragment_ids[move.fragment_index])
            ),
            locations=ReaderTextLocations(
                text_offset=move.offset,
                progression=None,
                total_progression=move.total_progression,
                position=None,
            ),
            text=ReaderQuoteContext(quote=None, quote_prefix=None, quote_suffix=None),
        )
        if locator != move.before:
            _write(db, move.user_id, plan.media_id, locator.model_dump(mode="json"))


def _unique_source_match(needle: str, texts: Sequence[str]) -> tuple[int, int] | None:
    if not needle:
        return None
    found: tuple[int, int] | None = None
    for index, content in enumerate(texts):
        offset = content.find(needle)
        if offset < 0:
            continue
        if found is not None or content.find(needle, offset + 1) >= 0:
            raise _unmappable()
        found = (index, offset)
    return found


def _unmappable() -> ConflictError:
    return ConflictError(
        ApiErrorCode.E_SOURCE_POSITION_UNMAPPABLE,
        "A saved reading spot has no clear match in the replacement source.",
    )


def current_position_rows_sql() -> str:
    """Per-media cursor facts for one viewer (binds ``:viewer_id``).

    ``positioned`` tells an empty cursor from unknown progress; PDF pages carry
    no whole-document progression.
    """
    return """
        SELECT media_id,
               locator IS NOT NULL AS positioned,
               CASE WHEN locator->>'kind' IN ('web', 'epub', 'transcript')
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
    """Validate the base revision before accepting even an identical locator."""
    _check_kind(media_kind, write.locator)
    current = load_snapshot(db, viewer_id=viewer_id, media_id=media_id, media_kind=media_kind)
    if write.base_revision != current.revision:
        raise ConflictError(
            ApiErrorCode.E_READER_STATE_CONFLICT,
            "Reader cursor was updated elsewhere",
            details={"current": current.model_dump(mode="json")},
        )
    if isinstance(write.locator, EpubReaderResumeState):
        _admit_epub(db, media_id, write.locator)
    elif isinstance(write.locator, WebReaderResumeState):
        _admit_web(db, media_id, write.locator)
    if isinstance(current, ReaderCursorPositioned) and current.locator == write.locator:
        return current
    revision = _write(db, viewer_id, media_id, write.locator.model_dump(mode="json"))
    return ReaderCursorPositioned(revision=revision, locator=write.locator)


def fence_in_txn(db: Session, *, viewer_id: UUID, media_id: UUID) -> None:
    """Retire earlier saves without moving the bookmark."""
    db.execute(
        text("""
            INSERT INTO reader_media_state (user_id, media_id, locator, revision)
            VALUES (:viewer_id, :media_id, NULL, 1)
            ON CONFLICT (user_id, media_id) DO UPDATE
            SET revision = reader_media_state.revision + 1, updated_at = now()
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )


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
