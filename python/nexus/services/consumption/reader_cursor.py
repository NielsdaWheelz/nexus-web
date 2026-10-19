"""One revisioned cursor per viewer/publication; source edits never invent a position.

The register is null, Positioned or Unresolved. Equal saves converge; stale bases
conflict. Only explicit adoption replaces Unresolved. Publication captures old text
under its locks and reconciles after replacement without recording reading activity.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError
from nexus.schemas.reader import (
    CursorWrite,
    EpubReaderResumeState,
    ReaderCursorEmpty,
    ReaderCursorPositioned,
    ReaderCursorSnapshot,
    ReaderCursorUnresolved,
    ReaderEpubTarget,
    ReaderFragmentTarget,
    ReaderQuoteContext,
    ReaderTextLocations,
    StoredReaderCursor,
    StoredReaderCursorPositioned,
    StoredReaderCursorUnresolved,
    WebReaderResumeState,
    XReaderResumeState,
)
from nexus.schemas.reader_document import ReaderPdfFileOut, ReaderTextDocumentOut, ReaderUnitOut
from nexus.services.canonicalize import canonicalize_structure

_LOCATOR_KIND = {
    "pdf": "pdf",
    "epub": "epub",
    "web_article": "web",
    "video": "transcript",
    "podcast_episode": "transcript",
}
_CURSOR = TypeAdapter(StoredReaderCursor)
type TextCursor = WebReaderResumeState | EpubReaderResumeState | XReaderResumeState


@dataclass(frozen=True, slots=True)
class XCursorRemapSnapshot:
    """Old publication and cursor facts retained only for the publication transaction."""

    media_id: UUID
    generation: int
    units: list[ReaderUnitOut]
    positions: tuple[tuple[UUID, TextCursor], ...]


def _document(db: Session, media_id: UUID, viewer_id: UUID | None = None) -> ReaderTextDocumentOut:
    from nexus.services.reader_document import build_reader_document

    def no_pdf() -> ReaderPdfFileOut:
        # justify-defect: only text publications participate in X containment.
        raise AssertionError("X cursor reconciliation received a PDF")

    document = build_reader_document(db, media_id=media_id, viewer_id=viewer_id, pdf_file=no_pdf)
    if not isinstance(document, ReaderTextDocumentOut):
        # justify-defect: the publication closure is made of text documents.
        raise AssertionError("X cursor reconciliation requires text")
    return document


def capture_x_cursor_remap(
    db: Session, *, media_ids: Sequence[UUID]
) -> tuple[XCursorRemapSnapshot, ...]:
    """Before replacing bodies/edges, lock cursors after the caller's ordered media locks."""
    if not media_ids:
        return ()
    positions: dict[UUID, list[tuple[UUID, TextCursor]]] = {}
    for row in db.execute(
        text("""SELECT media_id, user_id, cursor FROM reader_media_state
                WHERE media_id=ANY(:ids) ORDER BY media_id, user_id FOR UPDATE"""),
        {"ids": list(media_ids)},
    ):
        if row.cursor is None:
            continue
        cursor = _CURSOR.validate_python(row.cursor)
        if isinstance(cursor, StoredReaderCursorPositioned) and isinstance(
            cursor.locator, (WebReaderResumeState, EpubReaderResumeState, XReaderResumeState)
        ):
            positions.setdefault(row.media_id, []).append((row.user_id, cursor.locator))
    snapshots: list[XCursorRemapSnapshot] = []
    for media_id, cursors in positions.items():
        document = _document(db, media_id)
        snapshots.append(
            XCursorRemapSnapshot(
                media_id, int(document.identity[1:]), document.units, tuple(cursors)
            )
        )
    return tuple(snapshots)


def _unit_for(locator: TextCursor, units: list[ReaderUnitOut]) -> ReaderUnitOut | None:
    unit_id = (
        locator.occurrence_id
        if isinstance(locator, XReaderResumeState)
        else str(locator.target.fragment_id)
    )
    return next((unit for unit in units if unit.id == unit_id), None)


def _unique_match(needle: str, units: list[ReaderUnitOut]) -> tuple[ReaderUnitOut, int] | None:
    if not needle:
        return None
    match: tuple[ReaderUnitOut, int] | None = None
    for unit in units:
        offset = unit.canonical_text.find(needle)
        if offset < 0:
            continue
        if match is not None or unit.canonical_text.find(needle, offset + 1) >= 0:
            return None
        match = unit, offset
    return match


def _match_position(
    original: ReaderUnitOut, offset: int, candidates: list[ReaderUnitOut]
) -> tuple[ReaderUnitOut, int] | None:
    if not 0 <= offset <= original.char_count:
        return None
    same = next(
        (
            unit
            for unit in candidates
            if unit.id == original.id and unit.canonical_text == original.canonical_text
        ),
        None,
    )
    if same is not None:
        return same, offset
    match = _unique_match(original.canonical_text, candidates)
    relative = offset
    if match is None:
        start = max(0, offset - 64)
        match = _unique_match(original.canonical_text[start : offset + 64], candidates)
        relative = offset - start
    return None if match is None else (match[0], match[1] + relative)


def _correspondence(
    locator: TextCursor, old: ReaderUnitOut, before: list[ReaderUnitOut], after: list[ReaderUnitOut]
) -> tuple[ReaderUnitOut, int] | None:
    offset = locator.locations.text_offset
    if offset is None:
        return None
    if not isinstance(locator, XReaderResumeState):
        return _match_position(old, offset, [unit for unit in after if unit.x_post is None])
    metadata = old.x_post
    if (
        metadata is None
        or metadata.owner is None
        or metadata.owner.media_id != locator.post_media_id
    ):
        return None
    candidates = [
        unit
        for unit in after
        if unit.x_post is not None
        and unit.x_post.owner is not None
        and unit.x_post.owner.media_id == locator.post_media_id
    ]
    if metadata.relation != "embedded":
        return _match_position(old, offset, [unit for unit in candidates if unit.id == old.id])
    parent = next((unit for unit in before if unit.id == metadata.parent_unit_id), None)
    if parent is None or metadata.insertion_offset is None:
        return None
    slot = _match_position(
        parent, metadata.insertion_offset, [unit for unit in after if unit.x_post is None]
    )
    if slot is None:
        return None
    parent_now, offset_now = slot
    candidates = [
        unit
        for unit in candidates
        if unit.x_post is not None
        and unit.x_post.relation == "embedded"
        and unit.x_post.parent_unit_id == parent_now.id
        and unit.x_post.insertion_offset == offset_now
    ]
    if len(candidates) > 1 and parent_now.id == parent.id:
        candidates = [
            unit
            for unit in candidates
            if unit.x_post is not None
            and unit.x_post.embed_occurrence_key == metadata.embed_occurrence_key
        ]
    return _match_position(old, offset, candidates) if len(candidates) == 1 else None


def _progress(units: list[ReaderUnitOut], unit_id: str, offset: int) -> float:
    from nexus.services.reader_document import reading_source_ranges

    ranges = reading_source_ranges(units)
    total = sum(end - start for _, start, end in ranges)
    preceding = 0
    position: int | None = None
    for unit, start, end in ranges:
        if unit.id == unit_id and start <= offset <= end and (end > start or unit.char_count == 0):
            # A boundary names the next source character, after any inserted posts.
            position = preceding + offset - start
        preceding += end - start
    if position is not None:
        return position / total if total else 0.0
    # justify-defect: the admitted source point occurs in this publication's reading order.
    raise AssertionError("Reader position is outside its source ranges")


def remap_x_cursors(db: Session, snapshots: Sequence[XCursorRemapSnapshot]) -> None:
    """After flushing new bodies/edges, before advancing parent generations; no activity writes."""
    for snapshot in snapshots:
        units = _document(db, snapshot.media_id).units
        for viewer_id, before in snapshot.positions:
            old = _unit_for(before, snapshot.units)
            match = None if old is None else _correspondence(before, old, snapshot.units, units)
            if match is None:
                offset = before.locations.text_offset or 0
                start = max(0, offset - 64)
                excerpt = (
                    old.canonical_text[start : offset + 64]
                    if old is not None
                    else before.text.quote or ""
                )
                cursor = StoredReaderCursorUnresolved(
                    previous_locator=before,
                    from_generation=snapshot.generation,
                    post_media_id=before.post_media_id
                    if isinstance(before, XReaderResumeState)
                    else None,
                    source_revision_id=before.source_revision_id
                    if isinstance(before, XReaderResumeState)
                    else None,
                    excerpt=excerpt,
                    offset_in_excerpt=min(offset - start, len(excerpt)) if old is not None else 0,
                )
                _write(db, viewer_id, snapshot.media_id, cursor.model_dump(mode="json"))
                continue
            unit, offset = match
            locations = ReaderTextLocations(
                text_offset=offset,
                progression=None,
                total_progression=_progress(units, unit.id, offset),
                position=None,
            )
            quote = ReaderQuoteContext(quote=None, quote_prefix=None, quote_suffix=None)
            if isinstance(before, XReaderResumeState):
                metadata = unit.x_post
                if metadata is None or metadata.owner is None:
                    # justify-defect: correspondence admitted an X source owner.
                    raise AssertionError("Remapped X cursor lost its source owner")
                locator: TextCursor = XReaderResumeState(
                    kind="x",
                    occurrence_id=unit.id,
                    post_media_id=metadata.owner.media_id,
                    source_revision_id=metadata.source_revision_id,
                    locations=locations,
                    text=quote,
                )
            elif isinstance(before, EpubReaderResumeState):
                locator = EpubReaderResumeState(
                    kind="epub",
                    target=ReaderEpubTarget(
                        fragment_id=UUID(unit.id),
                        href_path=unit.href_path or before.target.href_path,
                        anchor_id=None,
                    ),
                    locations=locations,
                    text=quote,
                )
            else:
                locator = WebReaderResumeState(
                    kind="web",
                    target=ReaderFragmentTarget(fragment_id=unit.id),
                    locations=locations,
                    text=quote,
                )
            if locator != before:
                _write(
                    db,
                    viewer_id,
                    snapshot.media_id,
                    StoredReaderCursorPositioned(locator=locator).model_dump(mode="json"),
                )


def current_position_rows_sql() -> str:
    """Per-media cursor facts for one viewer (binds ``:viewer_id``).

    ``positioned`` tells an empty cursor from unknown progress; PDF pages carry
    no whole-document progression.
    """
    return """
        SELECT media_id,
               cursor IS NOT NULL AS positioned,
               CASE WHEN cursor->>'tag' = 'Positioned'
                         AND cursor->'locator'->>'kind' IN ('web', 'epub', 'transcript', 'x')
                    THEN (cursor->'locator'->'locations'->>'total_progression')::float8
                    ELSE NULL::float8
               END AS total_progression
        FROM reader_media_state
        WHERE user_id = :viewer_id
    """


def supports(kind: str) -> bool:
    return kind in _LOCATOR_KIND


def load(db: Session, *, viewer_id: UUID, media_id: UUID) -> ReaderCursorSnapshot:
    row = db.execute(
        text(
            "SELECT cursor, revision FROM reader_media_state"
            " WHERE user_id = :viewer_id AND media_id = :media_id"
        ),
        {"viewer_id": viewer_id, "media_id": media_id},
    ).one_or_none()
    if row is None or row.cursor is None:
        return ReaderCursorEmpty(revision=row.revision if row else 0)
    cursor = _CURSOR.validate_python(row.cursor)
    if isinstance(cursor, StoredReaderCursorPositioned):
        return ReaderCursorPositioned(revision=row.revision, locator=cursor.locator)
    return ReaderCursorUnresolved(revision=row.revision, **cursor.model_dump(exclude={"tag"}))


def save(
    db: Session, *, viewer_id: UUID, media_id: UUID, kind: str, write: CursorWrite
) -> tuple[ReaderCursorPositioned, bool]:
    """Equal to the current one -> current (a resend that landed: not accepted again when its
    base is stale, so a fence still retires it); from a stale base -> 409 with current; else
    admit the locator and write the next revision (I6). The flag says whether the save was
    accepted."""
    is_x = isinstance(write.locator, XReaderResumeState)
    if (is_x and kind not in ("web_article", "epub")) or (
        not is_x and write.locator.kind != _LOCATOR_KIND[kind]
    ):
        raise InvalidRequestError(
            message=f"Reader state kind '{write.locator.kind}' does not match media kind '{kind}'"
        )
    current = load(db, viewer_id=viewer_id, media_id=media_id)
    if isinstance(current, ReaderCursorPositioned) and current.locator == write.locator:
        return current, write.base_revision == current.revision
    if write.base_revision != current.revision or (
        isinstance(current, ReaderCursorUnresolved) and not write.adopt_unresolved
    ):
        raise ConflictError(
            ApiErrorCode.E_READER_STATE_CONFLICT,
            "Reader cursor was updated or needs explicit adoption",
            details={"current": current.model_dump(mode="json")},
        )
    if isinstance(write.locator, XReaderResumeState):
        _admit_x(db, viewer_id, media_id, write.locator)
    elif isinstance(write.locator, EpubReaderResumeState):
        _admit_epub(db, media_id, write.locator)
    elif isinstance(write.locator, WebReaderResumeState):
        _admit_web(db, media_id, write.locator)
    revision = _write(
        db,
        viewer_id,
        media_id,
        StoredReaderCursorPositioned(locator=write.locator).model_dump(mode="json"),
    )
    return ReaderCursorPositioned(revision=revision, locator=write.locator), True


def fence(db: Session, *, viewer_id: UUID, media_id: UUID) -> None:
    """Retire earlier saves without moving the bookmark."""
    db.execute(
        text("""
            INSERT INTO reader_media_state (user_id, media_id, cursor, revision)
            VALUES (:viewer_id, :media_id, NULL, 1)
            ON CONFLICT (user_id, media_id) DO UPDATE
            SET revision = reader_media_state.revision + 1
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )


def reset(db: Session, *, viewer_id: UUID, media_id: UUID) -> None:
    """Replace the cursor with a revisioned Empty tombstone."""
    _write(db, viewer_id, media_id, None)


def _write(db: Session, viewer_id: UUID, media_id: UUID, cursor: object | None) -> int:
    return db.scalar(
        text("""
            INSERT INTO reader_media_state (user_id, media_id, cursor, revision)
            VALUES (:viewer_id, :media_id, CAST(:cursor AS jsonb), 1)
            ON CONFLICT (user_id, media_id) DO UPDATE
            SET cursor = EXCLUDED.cursor, revision = reader_media_state.revision + 1
            RETURNING revision
        """).bindparams(bindparam("cursor", type_=JSONB(none_as_null=True))),
        {"viewer_id": viewer_id, "media_id": media_id, "cursor": cursor},
    )


def _admit_x(db: Session, viewer_id: UUID, media_id: UUID, locator: XReaderResumeState) -> None:
    unit = _unit_for(locator, _document(db, media_id, viewer_id).units)
    source = unit.x_post if unit is not None else None
    offset = locator.locations.text_offset
    if (
        source is None
        or source.owner is None
        or source.owner.media_id != locator.post_media_id
        or source.source_revision_id != locator.source_revision_id
        or offset is None
        or unit is None
        or offset > unit.char_count
    ):
        raise InvalidRequestError(message="X cursor must address the current post occurrence")


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
    elif anchor is None:
        raise InvalidRequestError(message="EPUB cursor requires an exact offset or source anchor")
    elif anchor not in canonicalize_structure(source.html_sanitized).anchors:
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
            " AND NOT EXISTS (SELECT 1 FROM x_post_sources WHERE media_id = :media_id)"
        ),
        {"media_id": media_id, "fragment_id": fragment_id},
    )
    if char_count is None:
        raise InvalidRequestError(message="Web cursor must address an owned source fragment")
    offset = locator.locations.text_offset
    if offset is not None and offset > char_count:
        raise InvalidRequestError(message="Web cursor offset exceeds its source fragment")
