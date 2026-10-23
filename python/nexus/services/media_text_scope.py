"""the canonical text admission owner for sources and source-backed reading identities.

audience authorization belongs to the calling reader/grant owner. resolution never
accepts a client-supplied source id. intervals and durable coordinates stay source
local; only proved rich slices leave a piece. SQL and point checks use the same
half-open range contract. ordinary x/transcript composition retains its own reader.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, cast
from uuid import UUID

from lxml.html import fragment_fromstring
from pydantic import TypeAdapter
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaPart
from nexus.errors import ApiError, ApiErrorCode, ConflictError, NotFoundError
from nexus.schemas.retrieval import (
    EpubFragmentOffsetsLocator,
    RetrievalLocator,
    WebTextOffsetsLocator,
)
from nexus.services.reader_publication import read_ready_publication_generation
from nexus.services.reader_structure import DocumentPoint, DomCut
from nexus.services.reader_text_slice import ReaderTextSlice, clip_reader_fragment

if TYPE_CHECKING:
    from nexus.services.media_parts import ProvedPartSelection


@dataclass(frozen=True, slots=True)
class _TextRange:
    start: DocumentPoint
    end: DocumentPoint
    start_cut: DomCut
    end_cut: DomCut


@dataclass(frozen=True, slots=True)
class FragmentInterval:
    fragment_id: UUID
    fragment_idx: int
    start_offset: int
    end_offset: int
    start_cut: DomCut
    end_cut: DomCut


@dataclass(frozen=True, slots=True)
class MediaTextScope:
    reading_media_id: UUID
    body_generation: int
    source_media_id: UUID
    source_generation: int
    source_format: Literal["epub", "web_article"]
    fragment_intervals: tuple[FragmentInterval, ...]
    permitted_apparatus: frozenset[UUID]
    permitted_assets: frozenset[str]

    def contains(self, fragment_id: UUID, start_offset: int, end_offset: int) -> bool:
        return 0 <= start_offset < end_offset and any(
            interval.fragment_id == fragment_id
            and interval.start_offset <= start_offset
            and end_offset <= interval.end_offset
            for interval in self.fragment_intervals
        )


def text_scope_rows_sql(reading_ids_sql: str) -> str:
    """setwise (reading_media_id,source_media_id,fragment_id,idx,start_offset,end_offset).

    supplied reading ids already carry their audience contract. this relation
    alone owns source indirection and canonical interval admission for consumers.
    """
    return f"""
        SELECT m.id AS reading_media_id, COALESCE(p.source_media_id,m.id) AS source_media_id,
               f.id AS fragment_id, f.idx AS fragment_idx,
               CASE WHEN p.media_id IS NOT NULL AND f.idx=p.start_fragment_idx
                    THEN p.start_offset ELSE 0 END AS start_offset,
               CASE WHEN p.media_id IS NOT NULL AND f.idx=p.end_fragment_idx
                    THEN p.end_offset ELSE char_length(f.canonical_text) END AS end_offset
        FROM media m
        JOIN ({reading_ids_sql}) requested ON requested.media_id=m.id
        LEFT JOIN media_parts p ON p.media_id=m.id
        JOIN fragments f ON f.media_id=COALESCE(p.source_media_id,m.id)
        WHERE p.media_id IS NULL OR f.idx BETWEEN p.start_fragment_idx AND p.end_fragment_idx
    """


def apparatus_scope_rows_sql(reading_ids_sql: str) -> str:
    """setwise (reading_media_id,apparatus_item_id), including direct required notes.

    full sources admit their existing apparatus. pieces admit exact in-body
    items, then one edge from a genuine reference to its matching note kind.
    locators are the writer-validated stored grammar; no ancestor/group/return
    traversal or reverse source authority participates.
    """
    scopes = text_scope_rows_sql(reading_ids_sql)
    return f"""
        WITH admitted AS (
            SELECT DISTINCT bounded.reading_media_id,item.id,item.kind,item.media_id
            FROM ({scopes}) bounded
            JOIN reader_apparatus_items item ON item.media_id=bounded.source_media_id
              AND item.locator_status='exact'
              AND item.locator->>'type' IN ('epub_fragment_offsets','web_text_offsets')
              AND item.locator->>'media_id'=bounded.source_media_id::text
              AND item.locator->>'fragment_id'=bounded.fragment_id::text
              AND (item.locator->>'start_offset')::integer>=bounded.start_offset
              AND (item.locator->>'end_offset')::integer<=bounded.end_offset
            UNION
            SELECT requested.media_id,item.id,item.kind,item.media_id
            FROM ({reading_ids_sql}) requested
            JOIN media m ON m.id=requested.media_id AND m.kind!='text_part'
            JOIN reader_apparatus_items item ON item.media_id=m.id
        )
        SELECT reading_media_id,id AS apparatus_item_id FROM admitted
        UNION
        SELECT admitted.reading_media_id,target.id
        FROM admitted JOIN reader_apparatus_edges edge
          ON edge.from_item_id=admitted.id AND edge.media_id=admitted.media_id
        JOIN reader_apparatus_items target ON target.id=edge.to_item_id AND target.media_id=admitted.media_id
        WHERE admitted.kind IN ('footnote_ref','endnote_ref','sidenote_ref','margin_note_ref','bibliography_ref')
          AND ((edge.relation='points_to_note' AND target.kind='footnote')
            OR (edge.relation='points_to_endnote' AND target.kind='endnote')
            OR (edge.relation='points_to_sidenote' AND target.kind='sidenote')
            OR (edge.relation='points_to_margin_note' AND target.kind='margin_note')
            OR (edge.relation='cites_bibliography_entry' AND target.kind='bibliography_entry'))
    """


def highlight_in_reading_scope_sql(highlight_expr: str, reading_media_expr: str) -> str:
    """all canonical anchors must fit ONE reading identity, never a union of siblings."""
    scopes = text_scope_rows_sql(f"SELECT {reading_media_expr} AS media_id")
    return f"""(
        EXISTS (SELECT 1 FROM highlight_fragment_anchors shfa WHERE shfa.highlight_id={highlight_expr})
        AND NOT EXISTS (
            SELECT 1 FROM highlight_fragment_anchors shfa
            WHERE shfa.highlight_id={highlight_expr} AND NOT EXISTS (
                SELECT 1 FROM ({scopes}) bounded
                WHERE bounded.fragment_id=shfa.fragment_id
                  AND bounded.start_offset<=shfa.start_offset AND bounded.end_offset>=shfa.end_offset
            )
        )
    )"""


def read_scope_fragment(
    db: Session, scope: MediaTextScope, interval: FragmentInterval
) -> ReaderTextSlice:
    """project an admitted fragment using its frozen representation witnesses."""
    row = db.execute(
        text("""
        SELECT html_sanitized,canonical_text FROM fragments
        WHERE id=:id AND media_id=:source
    """),
        {"id": interval.fragment_id, "source": scope.source_media_id},
    ).one()
    return clip_reader_fragment(
        html_sanitized=row.html_sanitized,
        canonical_text=row.canonical_text,
        start_offset=interval.start_offset,
        end_offset=interval.end_offset,
        start_cut=interval.start_cut,
        end_cut=interval.end_cut,
    )


def html_asset_urls(html: str) -> frozenset[str]:
    """exact retained source URLs for img/srcset and SVG image/use dependencies.

    these are URLs, never asset keys or caller-authored locations. consumers map
    them to stored EPUB keys or saved HTML proxy URLs at their own serving edge.
    """
    from nexus.services.epub_ingest import srcset_candidates

    root = fragment_fromstring(html, create_parent=True)
    urls: set[str] = set()
    for node in root.iterdescendants():
        if not isinstance(node.tag, str):
            continue
        tag = node.tag.lower().rsplit("}", 1)[-1]
        if tag == "img":
            if node.get("src"):
                urls.add(node.get("src"))
            urls.update(url for url, _ in srcset_candidates(node.get("srcset") or ""))
        elif tag in ("image", "use"):
            for attribute, value in node.attrib.items():
                if attribute.rsplit("}", 1)[-1] in ("href", "xlink:href") and not value.startswith(
                    "#"
                ):
                    urls.add(value)
    return frozenset(urls)


def read_media_text_scope(db: Session, media_id: UUID) -> MediaTextScope:
    """resolve one already-authorized publication inside the caller's stable snapshot."""
    media = db.get(Media, media_id)
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "media not found")
    generation = read_ready_publication_generation(db, media_id=media_id)
    if generation is None:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "media is not ready for reading")
    part = db.get(MediaPart, media_id)
    source_id = media_id if part is None else part.source_media_id
    source = media if part is None else db.get(Media, source_id)
    if source is None or source.kind not in ("epub", "web_article"):
        raise ApiError(ApiErrorCode.E_INVALID_KIND, "media has no ordinary text scope")
    source_generation = generation if part is None else part.source_generation
    if read_ready_publication_generation(db, media_id=source_id) != source_generation:
        raise ConflictError(ApiErrorCode.E_READER_CONTENT_CHANGED, "source publication changed")
    bounds = (
        None
        if part is None
        else _TextRange(
            DocumentPoint(part.start_fragment_idx, part.start_offset),
            DocumentPoint(part.end_fragment_idx, part.end_offset),
            DomCut(tuple(part.start_dom_path), part.start_dom_edge),
            DomCut(tuple(part.end_dom_path), part.end_dom_edge),
        )
    )
    return _resolve_scope(
        db,
        reading_media_id=media_id,
        generation=generation,
        source_id=source_id,
        source_generation=source_generation,
        source_format=cast(Literal["epub", "web_article"], source.kind),
        bounds=bounds,
    )


def read_part_preview_scope(db: Session, *, selection: ProvedPartSelection) -> MediaTextScope:
    """the creator-authorized preview uses source asset routes and no reading identity."""
    source = db.get(Media, selection.source_media_id)
    assert source is not None
    return _resolve_scope(
        db,
        reading_media_id=source.id,
        generation=selection.source_generation,
        source_id=source.id,
        source_generation=selection.source_generation,
        source_format=cast(Literal["epub", "web_article"], source.kind),
        bounds=_TextRange(selection.start, selection.end, selection.start_cut, selection.end_cut),
    )


def _resolve_scope(
    db: Session,
    *,
    reading_media_id: UUID,
    generation: int,
    source_id: UUID,
    source_generation: int,
    source_format: Literal["epub", "web_article"],
    bounds: _TextRange | None,
) -> MediaTextScope:
    rows = db.execute(
        text("""
        SELECT id,idx,canonical_text,html_sanitized FROM fragments
        WHERE media_id=:source
          AND (CAST(:first AS integer) IS NULL OR idx BETWEEN :first AND :last) ORDER BY idx
    """),
        {
            "source": source_id,
            "first": None if bounds is None else bounds.start.fragment_idx,
            "last": None if bounds is None else bounds.end.fragment_idx,
        },
    ).all()
    intervals: list[FragmentInterval] = []
    assets: set[str] = set()
    for row in rows:
        if (
            bounds is not None
            and not bounds.start.fragment_idx <= row.idx <= bounds.end.fragment_idx
        ):
            continue
        start = (
            bounds.start.offset
            if bounds is not None and row.idx == bounds.start.fragment_idx
            else 0
        )
        end = (
            bounds.end.offset
            if bounds is not None and row.idx == bounds.end.fragment_idx
            else len(row.canonical_text)
        )
        start_cut = (
            bounds.start_cut
            if bounds is not None and row.idx == bounds.start.fragment_idx
            else DomCut((), "before")
        )
        end_cut = (
            bounds.end_cut
            if bounds is not None and row.idx == bounds.end.fragment_idx
            else DomCut((), "after")
        )
        interval = FragmentInterval(row.id, row.idx, start, end, start_cut, end_cut)
        intervals.append(interval)
        clipped = (
            row.html_sanitized
            if bounds is None
            else clip_reader_fragment(
                html_sanitized=row.html_sanitized,
                canonical_text=row.canonical_text,
                start_offset=start,
                end_offset=end,
                start_cut=start_cut,
                end_cut=end_cut,
            ).html_sanitized
        )
        assets.update(html_asset_urls(clipped))
    scope = MediaTextScope(
        reading_media_id,
        generation,
        source_id,
        source_generation,
        source_format,
        tuple(intervals),
        frozenset(),
        frozenset(),
    )
    items = db.execute(
        text("""
        SELECT id,kind,locator,locator_status,body_html_sanitized
        FROM reader_apparatus_items WHERE media_id=:source
    """),
        {"source": source_id},
    ).all()
    permitted: set[UUID] = set()
    in_body_references: set[UUID] = set()
    locator_decoder = TypeAdapter(RetrievalLocator)
    for row in items:
        locator = None if row.locator is None else locator_decoder.validate_python(row.locator)
        inside = bounds is None or (
            row.locator_status == "exact"
            and isinstance(locator, (WebTextOffsetsLocator, EpubFragmentOffsetsLocator))
            and str(locator.media_id) == str(source_id)
            and scope.contains(
                UUID(str(locator.fragment_id)), locator.start_offset, locator.end_offset
            )
        )
        if inside:
            permitted.add(row.id)
            if row.kind in (
                "footnote_ref",
                "endnote_ref",
                "sidenote_ref",
                "margin_note_ref",
                "bibliography_ref",
            ):
                in_body_references.add(row.id)
    # Expand once from genuine in-body references to their direct note targets.
    if in_body_references:
        permitted.update(
            db.scalars(
                text("""
            SELECT edge.to_item_id FROM reader_apparatus_edges edge
            JOIN reader_apparatus_items target ON target.id=edge.to_item_id
            WHERE edge.media_id=:source AND edge.from_item_id=ANY(:ids)
              AND ((edge.relation='points_to_note' AND target.kind='footnote')
                OR (edge.relation='points_to_endnote' AND target.kind='endnote')
                OR (edge.relation='points_to_sidenote' AND target.kind='sidenote')
                OR (edge.relation='points_to_margin_note' AND target.kind='margin_note')
                OR (edge.relation='cites_bibliography_entry' AND target.kind='bibliography_entry'))
        """),
                {"source": source_id, "ids": list(in_body_references)},
            )
        )
    for row in items:
        if row.id in permitted and row.body_html_sanitized is not None:
            assets.update(html_asset_urls(row.body_html_sanitized))
    return MediaTextScope(
        reading_media_id,
        generation,
        source_id,
        source_generation,
        source_format,
        tuple(intervals),
        frozenset(permitted),
        frozenset(assets),
    )
