"""Batch hydration of ResourceRefs for prompt assembly, UI, and API (spec §9.2).

The single per-scheme data-access + presentation layer: each scheme's SQL,
permission check, and label/summary/inline-body presentation exists exactly
once. ``load_resource_batch`` (per-scheme bodies) is also consumed by
``agent_tools.read_resource`` so a scheme's read path never forks.

Missing, forbidden, or unknown refs hydrate as ``missing=True`` for display
(errors.md: this layer never raises); writes reject missing targets in
``resource_graph.edges``, backed by :func:`assert_ref_visible`.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from typing import assert_never
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_conversation,
    can_read_highlight,
    can_read_media,
    is_library_member,
    visible_podcast_ids_cte_sql,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services import library_entries
from nexus.services.locator_resolver import locator_from_resolution, resolve_evidence_span
from nexus.services.media_read_map import load_media_document_summary
from nexus.services.resource_graph.highlight_notes import linked_note_blocks_for_highlights
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme

INLINE_THRESHOLD_CHARS = 1500

# Joined media author aggregation, shared by media and highlight loads.
_AUTHORS_SQL = (
    "COALESCE("
    "NULLIF(string_agg(DISTINCT cc.credited_name, ', ' ORDER BY cc.credited_name), ''),"
    " ''"
    ") AS authors"
)


@dataclass(frozen=True)
class LoadedQuote:
    exact: str
    prefix: str  # highlights.prefix is NOT NULL (may be "")
    suffix: str  # highlights.suffix is NOT NULL (may be "")
    source_label: str | None  # "“Title” by Author"
    note: str | None  # joined note_blocks text, or None


@dataclass(frozen=True)
class LoadedResource:
    """Superset of the identity/body fields the resolve and read presenters need.

    Each scheme populates only the fields its presenters read; the rest stay
    ``None``. A discriminated union per scheme would be heavier than the small
    flat bag and buys no safety — every presenter branches on ``scheme`` anyway.
    """

    uri: str
    scheme: ResourceScheme
    missing: bool = False
    body: str | None = None  # span/chunk/page/note_block/fragment/message/snippet text
    quote: LoadedQuote | None = None  # highlight only
    title: str | None = None  # media/span/chunk/fragment/conversation/page title; library name
    author: str | None = None  # media authors, aggregated
    media_kind: str | None = None  # media summary ("{kind} · ~N words · M sections")
    source_label: str | None = None  # parent/source label for child evidence rows
    section_count: int | None = None  # media summary (pages for pdf, else map sections)
    word_count: int | None = None  # media summary
    fragment_idx: int | None = None  # fragment label "fragment {idx+1}"
    citation_label: str | None = None  # evidence-span label
    message_role: str | None = None  # message "{role}: …"
    message_count: int | None = None  # conversation summary
    item_count: int | None = None  # library summary
    related_library_id: UUID | None = None  # LI output -> the library: scope for app_search
    related_artifact_id: UUID | None = None  # LI revision -> artifact head
    related_revision_id: UUID | None = None  # LI artifact head -> current revision
    related_revision_status: str | None = None
    related_revision_is_current: bool | None = None
    locator_label: str | None = None  # oracle corpus passage locator
    apparatus_kind: str | None = None


@dataclass(frozen=True)
class ResolvedResource:
    uri: str
    label: str
    summary: str
    inline_body: str | None
    fetch_hint: str
    quote: LoadedQuote | None = None  # set for highlights → <quote> instead of <body>
    missing: bool = False
    resolved_revision_ref: str | None = None


def resolve_ref(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> ResolvedResource:
    return resolve_refs(db, viewer_id=viewer_id, refs=[ref])[0]


def resolve_refs(
    db: Session,
    *,
    viewer_id: UUID,
    refs: Sequence[ResourceRef],
) -> list[ResolvedResource]:
    unique: dict[str, ResourceRef] = {}
    for ref in refs:
        unique.setdefault(ref.uri, ref)
    loaded = load_resource_batch(db, list(unique.values()), viewer_id=viewer_id)
    presented = {uri: _present(entry) for uri, entry in loaded.items()}
    return [presented[ref.uri] for ref in refs]


def assert_ref_visible(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> None:
    """Raise ``NotFoundError`` unless ``ref`` resolves visible to the viewer."""
    if resolve_ref(db, viewer_id=viewer_id, ref=ref).missing:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")


def missing_resolved_resource(uri: str) -> ResolvedResource:
    """The canonical missing/forbidden hydration for display (§7.3)."""
    return ResolvedResource(
        uri=uri,
        label="(resource unavailable)",
        summary="",
        inline_body=None,
        fetch_hint="",
        missing=True,
    )


def covering_evidence_span_for_highlight(
    db: Session, *, viewer_id: UUID, highlight_id: UUID
) -> ResourceRef | None:
    """Best-effort resolve a highlight to the evidence_span covering its anchor.

    Bridges the two coordinate systems — highlights anchor in fragment-offset /
    PDF-page-geometry space; evidence_spans anchor in content-block space —
    through the content-chunk ``summary_locator`` layer that already reconciles
    them (§4.7). Returns ``None`` when no chunk covers the anchor, so the caller
    falls back to ``media`` grain (D8). Bounded to the highlight's own anchor
    media; the highlight's own visibility is the caller's (P-6).
    """
    row = (
        db.execute(
            text(
                """
                SELECT h.anchor_media_id, h.anchor_kind,
                       hfa.fragment_id, hfa.start_offset,
                       hpa.page_number
                FROM highlights h
                LEFT JOIN highlight_fragment_anchors hfa ON hfa.highlight_id = h.id
                LEFT JOIN highlight_pdf_anchors hpa ON hpa.highlight_id = h.id
                WHERE h.id = :highlight_id AND h.user_id = :viewer_id
                """
            ),
            {"highlight_id": highlight_id, "viewer_id": viewer_id},
        )
        .mappings()
        .first()
    )
    if row is None or row["anchor_media_id"] is None:
        return None
    media_id = row["anchor_media_id"]
    if row["anchor_kind"] == "fragment_offsets" and row["fragment_id"] is not None:
        span_id = db.scalar(
            text(
                """
                SELECT cc.primary_evidence_span_id
                FROM content_chunks cc
                WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
                  AND cc.summary_locator->>'fragment_id' = :fragment_id
                  AND (cc.summary_locator->>'start_offset')::int <= :offset
                  AND (cc.summary_locator->>'end_offset')::int >= :offset
                  AND cc.primary_evidence_span_id IS NOT NULL
                ORDER BY cc.chunk_idx
                LIMIT 1
                """
            ),
            {
                "media_id": media_id,
                "fragment_id": str(row["fragment_id"]),
                "offset": int(row["start_offset"]),
            },
        )
    elif row["anchor_kind"] == "pdf_page_geometry" and row["page_number"] is not None:
        span_id = db.scalar(
            text(
                """
                SELECT cc.primary_evidence_span_id
                FROM content_chunks cc
                WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
                  AND (cc.summary_locator->>'page_number')::int = :page_number
                  AND cc.primary_evidence_span_id IS NOT NULL
                ORDER BY cc.chunk_idx
                LIMIT 1
                """
            ),
            {"media_id": media_id, "page_number": int(row["page_number"])},
        )
    else:
        return None
    if span_id is None:
        return None
    return ResourceRef(scheme="evidence_span", id=span_id)


# ---------- per-scheme loading ------------------------------------------------


def load_resource_batch(
    db: Session,
    refs: Sequence[ResourceRef],
    *,
    viewer_id: UUID,
) -> dict[str, LoadedResource]:
    """Load each ref's scheme-specific row + permission check, keyed by ``ref.uri``."""
    by_scheme: dict[ResourceScheme, list[ResourceRef]] = defaultdict(list)
    for ref in refs:
        by_scheme[ref.scheme].append(ref)

    out: dict[str, LoadedResource] = {}
    for scheme, items in by_scheme.items():
        if scheme == "media":
            loaded = _load_media(db, items, viewer_id=viewer_id)
        elif scheme == "library":
            loaded = _load_library(db, items, viewer_id=viewer_id)
        elif scheme == "artifact":
            loaded = _load_artifact(db, items, viewer_id=viewer_id)
        elif scheme == "artifact_revision":
            loaded = _load_artifact_revision(db, items, viewer_id=viewer_id)
        elif scheme == "evidence_span":
            loaded = _load_evidence_span(db, items, viewer_id=viewer_id)
        elif scheme == "content_chunk":
            loaded = _load_content_chunk(db, items, viewer_id=viewer_id)
        elif scheme == "highlight":
            loaded = _load_highlight(db, items, viewer_id=viewer_id)
        elif scheme == "page":
            loaded = _load_page(db, items, viewer_id=viewer_id)
        elif scheme == "note_block":
            loaded = _load_note_block(db, items, viewer_id=viewer_id)
        elif scheme == "fragment":
            loaded = _load_fragment(db, items, viewer_id=viewer_id)
        elif scheme == "conversation":
            loaded = _load_conversation(db, items, viewer_id=viewer_id)
        elif scheme == "message":
            loaded = _load_message(db, items, viewer_id=viewer_id)
        elif scheme == "oracle_reading":
            loaded = _load_oracle_reading(db, items, viewer_id=viewer_id)
        elif scheme == "oracle_passage_anchor":
            loaded = _load_oracle_passage_anchor(db, items)
        elif scheme == "external_snapshot":
            loaded = _load_external_snapshot(db, items, viewer_id=viewer_id)
        elif scheme == "contributor":
            loaded = _load_contributor(db, items)
        elif scheme == "podcast":
            loaded = _load_podcast(db, items, viewer_id=viewer_id)
        elif scheme == "reader_apparatus_item":
            loaded = _load_reader_apparatus_item(db, items, viewer_id=viewer_id)
        else:
            assert_never(scheme)
        for entry in loaded:
            out[entry.uri] = entry
    return out


def _missing(uri: str, scheme: ResourceScheme) -> LoadedResource:
    return LoadedResource(uri=uri, scheme=scheme, missing=True)


def parent_media_id_for_read_pointer(
    db: Session, *, scheme: ResourceScheme, resource_id: UUID
) -> UUID | None:
    """Return the parent media id for media-derived read pointers.

    ``fragments`` still carries an intrinsic ``media_id`` column. ``evidence_spans``
    and ``content_chunks`` are polymorphic over ``(owner_kind, owner_id)``; only
    media-owned rows have a parent media id, so a note-owned span/chunk resolves to
    ``NULL`` here and is correctly treated as non-readable in this context.
    """
    if scheme == "fragment":
        return db.scalar(text("SELECT media_id FROM fragments WHERE id = :id"), {"id": resource_id})
    table = {"evidence_span": "evidence_spans", "content_chunk": "content_chunks"}.get(scheme)
    if table is None:
        return None
    return db.scalar(
        text(f"SELECT owner_id FROM {table} WHERE id = :id AND owner_kind = 'media'"),
        {"id": resource_id},
    )


def reader_target_for_citation_target(
    db: Session, *, viewer_id: UUID, target: ResourceRef
) -> tuple[UUID | None, dict[str, object] | None]:
    """Reconstruct the in-reader jump ``(media_id, locator)`` for a citation target.

    The render contract (G6): the same single ``ReaderCitationData`` jump path lights
    up for chat, Oracle, and the library dossier, all of which cite the finest-grained
    object (``evidence_span``/``content_chunk``/``media``). Position lives in the target,
    not the edge (D11), so it is recomputed here from the target's own anchoring using
    the single locator owner (``locator_resolver``), exactly as search and LI synthesis do.

    Note-owned evidence returns ``(None, note_block_offsets)``. The frontend citation
    adapter treats that locator as a note activation target, not a media jump.
    """
    if target.scheme == "media":
        return target.id, None
    if target.scheme == "highlight":
        media_id = db.scalar(
            text("SELECT anchor_media_id FROM highlights WHERE id = :id"),
            {"id": target.id},
        )
        if media_id is None or not can_read_media(db, viewer_id, media_id):
            return None, None
        return media_id, None
    if target.scheme == "fragment":
        row = db.execute(
            text(
                """
                SELECT media_id
                FROM fragments
                WHERE id = :id
                """
            ),
            {"id": target.id},
        ).first()
        if row is None or not can_read_media(db, viewer_id, row[0]):
            return None, None
        return row[0], None
    if target.scheme == "reader_apparatus_item":
        return _reader_target_for_reader_apparatus_item(
            db, viewer_id=viewer_id, apparatus_item_id=target.id
        )
    if target.scheme == "note_block":
        return None, _note_block_locator_for_block(db, viewer_id=viewer_id, block_id=target.id)
    if target.scheme == "content_chunk":
        return _reader_target_for_content_chunk(db, viewer_id=viewer_id, chunk_id=target.id)
    if target.scheme == "oracle_passage_anchor":
        current = oracle_anchor_current_target(db, target.id)
        if current is None:
            return None, None
        return reader_target_for_citation_target(db, viewer_id=viewer_id, target=current)
    if target.scheme != "evidence_span":
        return None, None
    try:
        resolution = resolve_evidence_span(db, viewer_id=viewer_id, evidence_span_id=target.id)
    except NotFoundError:
        # justify-ignore-error: the cited span was deleted or is no longer visible; the
        # cited edge outlives it (N4), so the chip renders from its stored snapshot.
        return None, None
    resolver = resolution.get("resolver")
    if isinstance(resolver, dict) and resolver.get("kind") == "note":
        return None, locator_from_resolution(
            resolution,
            media_id=UUID(str(resolution["media_id"])),
            media_kind="note",
        )
    media_id = parent_media_id_for_read_pointer(db, scheme="evidence_span", resource_id=target.id)
    if media_id is None:
        return None, None
    media_kind = db.scalar(text("SELECT kind FROM media WHERE id = :id"), {"id": media_id})
    locator = locator_from_resolution(
        resolution, media_id=media_id, media_kind=str(media_kind or "")
    )
    return media_id, locator


def _reader_target_for_content_chunk(
    db: Session, *, viewer_id: UUID, chunk_id: UUID
) -> tuple[UUID | None, dict[str, object] | None]:
    row = (
        db.execute(
            text(
                """
                SELECT owner_kind, owner_id, primary_evidence_span_id, summary_locator
                FROM content_chunks
                WHERE id = :chunk_id
                """
            ),
            {"chunk_id": chunk_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        return None, None
    owner_kind = str(row["owner_kind"])
    if owner_kind == "media":
        return row["owner_id"], None
    if owner_kind != "note_block":
        return None, None
    span_id = row["primary_evidence_span_id"]
    if span_id is not None:
        try:
            resolution = resolve_evidence_span(db, viewer_id=viewer_id, evidence_span_id=span_id)
        except NotFoundError:
            return None, None
        return None, locator_from_resolution(
            resolution,
            media_id=UUID(str(row["owner_id"])),
            media_kind="note",
        )
    return None, _note_locator_from_summary_locator(row["summary_locator"])


def _note_block_locator_for_block(
    db: Session, *, viewer_id: UUID, block_id: UUID
) -> dict[str, object] | None:
    row = db.execute(
        text(
            """
            SELECT body_text
            FROM note_blocks
            WHERE id = :block_id
              AND user_id = :viewer_id
            """
        ),
        {"viewer_id": viewer_id, "block_id": block_id},
    ).first()
    if row is None:
        return None
    body = str(row[0] or "")
    if not body:
        return None
    return retrieval_locator_json(
        {
            "type": "note_block_offsets",
            "block_id": str(block_id),
            "start_offset": 0,
            "end_offset": len(body),
        }
    )


def _note_locator_from_summary_locator(raw: object) -> dict[str, object] | None:
    locator = raw if isinstance(raw, dict) else {}
    note_block_id = locator.get("note_block_id")
    start_offset = locator.get("start_offset")
    end_offset = locator.get("end_offset")
    if (
        not isinstance(note_block_id, str)
        or not isinstance(start_offset, int)
        or not isinstance(end_offset, int)
    ):
        return None
    return retrieval_locator_json(
        {
            "type": "note_block_offsets",
            "block_id": note_block_id,
            "start_offset": start_offset,
            "end_offset": end_offset,
        }
    )


def _reader_target_for_reader_apparatus_item(
    db: Session, *, viewer_id: UUID, apparatus_item_id: UUID
) -> tuple[UUID | None, dict[str, object] | None]:
    row = db.execute(
        text(
            """
            SELECT rai.media_id, rai.locator
            FROM reader_apparatus_items rai
            JOIN reader_apparatus_states ras ON ras.id = rai.state_id
            WHERE rai.id = :id
              AND ras.status IN ('ready', 'partial')
              AND rai.locator IS NOT NULL
              AND rai.locator_status != 'missing'
            """
        ),
        {"id": apparatus_item_id},
    ).first()
    if row is None or not can_read_media(db, viewer_id, row[0]):
        return None, None
    return row[0], retrieval_locator_json(row[1])


def _load_media(db: Session, items: list[ResourceRef], *, viewer_id: UUID) -> list[LoadedResource]:
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            f"""
            SELECT m.id, m.title, m.kind, {_AUTHORS_SQL}
            FROM media m
            LEFT JOIN contributor_credits cc ON cc.media_id = m.id AND cc.role = 'author'
            WHERE m.id = ANY(:ids)
            GROUP BY m.id, m.title, m.kind
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or not can_read_media(db, viewer_id, ref.id):
            out.append(_missing(ref.uri, "media"))
            continue
        kind = str(row[2])
        summary = load_media_document_summary(db, viewer_id, ref.id)
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="media",
                title=str(row[1]),
                author=str(row[3]) or None,
                media_kind=kind,
                section_count=summary.section_count if summary is not None else None,
                word_count=summary.word_count if summary is not None else None,
            )
        )
    return out


def _load_library(
    db: Session, items: list[ResourceRef], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            """
            SELECT l.id, l.name
            FROM libraries l
            WHERE l.id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    counts = library_entries.count_entries_by_library(db, ids)
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or not is_library_member(db, viewer_id, ref.id):
            out.append(_missing(ref.uri, "library"))
            continue
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="library",
                title=str(row[1]),
                item_count=int(counts.get(row[0], 0)),
            )
        )
    return out


def _load_artifact(
    db: Session, items: list[ResourceRef], *, viewer_id: UUID
) -> list[LoadedResource]:
    """Resolve each library-dossier artifact head to its CURRENT revision content_md.

    Joins head -> libraries (name) -> LEFT JOIN current revision (content_md). The
    head resolves to whatever is current at this call (fresh per assembly). A head
    with ``current_revision_id IS NULL`` is non-missing with ``body=None``. Gated by
    library membership; a non-member or unknown id is masked as missing.
    """
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            """
            SELECT a.id, a.subject_id AS library_id, l.name, r.id AS revision_id, r.content_md,
                   r.status, a.current_revision_id = r.id AS revision_is_current
            FROM artifacts a
            JOIN libraries l ON l.id = a.subject_id
            LEFT JOIN artifact_revisions r
                ON r.id = a.current_revision_id
            WHERE a.id = ANY(:ids) AND a.subject_scheme = 'library'
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or not is_library_member(db, viewer_id, row[1]):
            out.append(_missing(ref.uri, "artifact"))
            continue
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="artifact",
                title=str(row[2]),
                body=str(row[4]) if row[4] is not None else None,
                related_artifact_id=UUID(str(row[0])),
                related_library_id=UUID(str(row[1])),
                related_revision_id=UUID(str(row[3])) if row[3] is not None else None,
                related_revision_status=str(row[5]) if row[5] is not None else None,
                related_revision_is_current=bool(row[6]) if row[6] is not None else None,
            )
        )
    return out


def _load_artifact_revision(
    db: Session, items: list[ResourceRef], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            """
            SELECT r.id, r.artifact_id, a.subject_id AS library_id, l.name, r.content_md, r.status,
                   a.current_revision_id = r.id AS is_current
            FROM artifact_revisions r
            JOIN artifacts a ON a.id = r.artifact_id
            JOIN libraries l ON l.id = a.subject_id
            WHERE r.id = ANY(:ids) AND a.subject_scheme = 'library'
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or not is_library_member(db, viewer_id, row[2]):
            out.append(_missing(ref.uri, "artifact_revision"))
            continue
        suffix = "current" if row[6] else str(row[5])
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="artifact_revision",
                title=f"{row[3]} ({suffix})",
                body=str(row[4] or ""),
                related_artifact_id=UUID(str(row[1])),
                related_library_id=UUID(str(row[2])),
                related_revision_id=UUID(str(row[0])),
                related_revision_status=str(row[5]),
                related_revision_is_current=bool(row[6]),
            )
        )
    return out


def _load_evidence_span(
    db: Session, items: list[ResourceRef], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            """
            SELECT es.id,
                   es.owner_kind,
                   es.owner_id,
                   es.span_text,
                   es.citation_label,
                   m.title AS media_title,
                   nb.user_id AS note_user_id
            FROM evidence_spans es
            LEFT JOIN media m ON m.id = es.owner_id AND es.owner_kind = 'media'
            LEFT JOIN note_blocks nb ON nb.id = es.owner_id AND es.owner_kind = 'note_block'
            WHERE es.id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None:
            out.append(_missing(ref.uri, "evidence_span"))
            continue
        owner_kind = str(row[1])
        if owner_kind == "media":
            if not can_read_media(db, viewer_id, row[2]):
                out.append(_missing(ref.uri, "evidence_span"))
                continue
            title = str(row[5])
        elif owner_kind == "note_block":
            if row[6] != viewer_id:
                out.append(_missing(ref.uri, "evidence_span"))
                continue
            title = "Note"
        else:
            out.append(_missing(ref.uri, "evidence_span"))
            continue
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="evidence_span",
                body=str(row[3] or ""),
                title=title,
                citation_label=str(row[4] or ""),
            )
        )
    return out


def _load_content_chunk(
    db: Session, items: list[ResourceRef], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            """
            SELECT cc.id,
                   cc.owner_kind,
                   cc.owner_id,
                   cc.chunk_text,
                   m.title AS media_title,
                   nb.user_id AS note_user_id
            FROM content_chunks cc
            LEFT JOIN media m ON m.id = cc.owner_id AND cc.owner_kind = 'media'
            LEFT JOIN note_blocks nb ON nb.id = cc.owner_id AND cc.owner_kind = 'note_block'
            WHERE cc.id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None:
            out.append(_missing(ref.uri, "content_chunk"))
            continue
        owner_kind = str(row[1])
        if owner_kind == "media":
            if not can_read_media(db, viewer_id, row[2]):
                out.append(_missing(ref.uri, "content_chunk"))
                continue
            title = str(row[4])
        elif owner_kind == "note_block":
            if row[5] != viewer_id:
                out.append(_missing(ref.uri, "content_chunk"))
                continue
            title = "Note"
        else:
            out.append(_missing(ref.uri, "content_chunk"))
            continue
        out.append(
            LoadedResource(uri=ref.uri, scheme="content_chunk", body=str(row[3] or ""), title=title)
        )
    return out


def _load_highlight(
    db: Session, items: list[ResourceRef], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            f"""
            SELECT h.id, h.exact, h.prefix, h.suffix, m.title, {_AUTHORS_SQL}
            FROM highlights h
            JOIN media m ON m.id = h.anchor_media_id
            LEFT JOIN contributor_credits cc ON cc.media_id = m.id AND cc.role = 'author'
            WHERE h.id = ANY(:ids)
            GROUP BY h.id, h.exact, h.prefix, h.suffix, m.title
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    # can_read_highlight validates the typed anchor; when it passes, anchor_media_id
    # (the row's joined media) is the authorized parent.
    visible = {
        ref.id for ref in items if ref.id in by_id and can_read_highlight(db, viewer_id, ref.id)
    }
    notes = linked_note_blocks_for_highlights(db, viewer_id, list(visible))
    out: list[LoadedResource] = []
    for ref in items:
        if ref.id not in visible:
            out.append(_missing(ref.uri, "highlight"))
            continue
        row = by_id[ref.id]
        title = str(row[4])
        authors = str(row[5])
        source_label = f"“{title}” by {authors}" if authors else f"“{title}”"
        blocks = notes.get(ref.id, [])
        note = "\n\n".join(b.body_text for b in blocks if b.body_text) or None
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="highlight",
                quote=LoadedQuote(
                    exact=str(row[1] or ""),
                    prefix=str(row[2] or ""),
                    suffix=str(row[3] or ""),
                    source_label=source_label,
                    note=note,
                ),
            )
        )
    return out


def _load_page(db: Session, items: list[ResourceRef], *, viewer_id: UUID) -> list[LoadedResource]:
    ids = [ref.id for ref in items]
    rows = db.execute(
        text("SELECT id, user_id, title FROM pages WHERE id = ANY(:ids)"),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or row[1] != viewer_id:
            out.append(_missing(ref.uri, "page"))
            continue
        title = str(row[2])
        out.append(LoadedResource(uri=ref.uri, scheme="page", title=title, body=title))
    return out


def _load_note_block(
    db: Session, items: list[ResourceRef], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [ref.id for ref in items]
    rows = db.execute(
        text("SELECT id, user_id, body_text FROM note_blocks WHERE id = ANY(:ids)"),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or row[1] != viewer_id:
            out.append(_missing(ref.uri, "note_block"))
            continue
        out.append(LoadedResource(uri=ref.uri, scheme="note_block", body=str(row[2] or "")))
    return out


def _load_fragment(
    db: Session, items: list[ResourceRef], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            """
            SELECT f.id, f.media_id, f.idx, f.canonical_text, m.title
            FROM fragments f
            JOIN media m ON m.id = f.media_id
            WHERE f.id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or not can_read_media(db, viewer_id, row[1]):
            out.append(_missing(ref.uri, "fragment"))
            continue
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="fragment",
                body=str(row[3] or ""),
                title=str(row[4]),
                fragment_idx=int(row[2]),
            )
        )
    return out


def _load_conversation(
    db: Session, items: list[ResourceRef], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            """
            SELECT c.id, c.title,
                   (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
            FROM conversations c
            WHERE c.id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or not can_read_conversation(db, viewer_id, ref.id):
            out.append(_missing(ref.uri, "conversation"))
            continue
        title = str(row[1] or "").strip() or "Untitled conversation"
        out.append(
            LoadedResource(
                uri=ref.uri, scheme="conversation", title=title, message_count=int(row[2] or 0)
            )
        )
    return out


def _load_message(
    db: Session, items: list[ResourceRef], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            """
            SELECT id, conversation_id, role, content
            FROM messages
            WHERE id = ANY(:ids) AND status != 'pending'
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or not can_read_conversation(db, viewer_id, row[1]):
            out.append(_missing(ref.uri, "message"))
            continue
        out.append(
            LoadedResource(
                uri=ref.uri, scheme="message", body=str(row[3] or ""), message_role=str(row[2])
            )
        )
    return out


def _load_oracle_reading(
    db: Session, items: list[ResourceRef], *, viewer_id: UUID
) -> list[LoadedResource]:
    """Resolve each oracle reading (owner-only).

    ``title`` is the question and ``citation_label`` the bound folio theme — the
    pointer-only fields the prompt-assembly/UI ``_present`` renders. ``body`` is
    the full readable reading (question + motto/argument + interpretation) that
    ``agent_tools.read_resource`` returns as a non-citable ``oracle_reading``;
    the per-phase folio passages now live on the reading's citation edges
    (``oracle_reading_folios``/edge snapshots), not in this body. Ownership is
    ``user_id == viewer_id`` (single-user readings); a non-owner or unknown id is
    masked as missing.
    """
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            """
            SELECT id, user_id, question_text, folio_theme,
                   folio_motto, folio_motto_gloss, argument_text, interpretation_text
            FROM oracle_readings
            WHERE id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or row[1] != viewer_id:
            out.append(_missing(ref.uri, "oracle_reading"))
            continue
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="oracle_reading",
                title=str(row[2]),
                citation_label=str(row[3]) if row[3] is not None else None,
                body=_oracle_reading_body(
                    question=str(row[2]),
                    motto=row[4],
                    motto_gloss=row[5],
                    argument=row[6],
                    interpretation=row[7],
                ),
            )
        )
    return out


def _oracle_reading_body(
    *,
    question: str,
    motto: str | None,
    motto_gloss: str | None,
    argument: str | None,
    interpretation: str | None,
) -> str:
    """Compose the readable oracle-reading body from the reading's own columns."""
    lines = [f"Question: {question}"]
    if motto:
        lines.append(f"Motto: {motto}" + (f" — {motto_gloss}" if motto_gloss else ""))
    if argument:
        lines.append(f"Argument: {argument}")
    if interpretation:
        lines.append(f"\nInterpretation:\n{interpretation}")
    return "\n".join(lines)


def oracle_anchor_current_target(db: Session, anchor_id: UUID) -> ResourceRef | None:
    """The current index pointer a resolved Oracle passage anchor points at, or None.

    Prefers the evidence span, falling back to the content chunk. None when the
    anchor is unresolved or its cached pointers were cleared by a reindex — the
    citation then fails closed (typographic, no jump) until re-resolution.
    """
    row = db.execute(
        text(
            """
            SELECT current_evidence_span_id, current_content_chunk_id
            FROM oracle_passage_anchors
            WHERE id = :id AND resolution_status = 'resolved'
            """
        ),
        {"id": anchor_id},
    ).first()
    if row is None:
        return None
    if row[0] is not None:
        return ResourceRef(scheme="evidence_span", id=row[0])
    if row[1] is not None:
        return ResourceRef(scheme="content_chunk", id=row[1])
    return None


def _load_oracle_passage_anchor(db: Session, items: list[ResourceRef]) -> list[LoadedResource]:
    """Public-domain passage anchors are global: any existing row is visible.

    ``body`` resolves to the current evidence-span text (the live media evidence the
    anchor points at). Unresolved or stale anchors fail closed as missing until the
    corpus anchor resolver refreshes them.
    """
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            """
            SELECT
                a.id,
                a.display_label,
                s.title,
                s.author_text,
                COALESCE(es.span_text, cc.chunk_text) AS body
            FROM oracle_passage_anchors a
            JOIN oracle_corpus_sources s ON s.id = a.corpus_source_id
            JOIN content_chunks cc ON cc.id = a.current_content_chunk_id
                AND cc.owner_kind = 'media' AND cc.owner_id = s.media_id
            LEFT JOIN evidence_spans es ON es.id = a.current_evidence_span_id
                AND es.owner_kind = 'media' AND es.owner_id = s.media_id
            WHERE a.id = ANY(:ids)
              AND a.resolution_status = 'resolved'
              AND (
                a.current_evidence_span_id IS NULL
                OR es.id IS NOT NULL
              )
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None:
            out.append(_missing(ref.uri, "oracle_passage_anchor"))
            continue
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="oracle_passage_anchor",
                body=str(row[4] or ""),
                title=str(row[2]),
                author=str(row[3] or "") or None,
                locator_label=str(row[1] or ""),
            )
        )
    return out


def _load_external_snapshot(
    db: Session, items: list[ResourceRef], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            """
            SELECT id, user_id, title, snippet
            FROM resource_external_snapshots
            WHERE id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or row[1] != viewer_id:
            out.append(_missing(ref.uri, "external_snapshot"))
            continue
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="external_snapshot",
                title=str(row[2]),
                body=str(row[3] or ""),
            )
        )
    return out


def _load_contributor(db: Session, items: list[ResourceRef]) -> list[LoadedResource]:
    """Contributors are global identity rows: any existing row resolves."""
    ids = [ref.id for ref in items]
    rows = db.execute(
        text("SELECT id, display_name, disambiguation FROM contributors WHERE id = ANY(:ids)"),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None:
            out.append(_missing(ref.uri, "contributor"))
            continue
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="contributor",
                title=str(row[1]),
                citation_label=str(row[2]) if row[2] is not None else None,
            )
        )
    return out


def _load_podcast(
    db: Session, items: list[ResourceRef], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            f"""
            SELECT p.id, p.title, p.description
            FROM podcasts p
            WHERE p.id = ANY(:ids)
              AND p.id IN ({visible_podcast_ids_cte_sql()})
            """
        ),
        {"ids": ids, "viewer_id": viewer_id},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None:
            out.append(_missing(ref.uri, "podcast"))
            continue
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="podcast",
                title=str(row[1]),
                body=str(row[2]) if row[2] is not None else None,
            )
        )
    return out


def _load_reader_apparatus_item(
    db: Session, items: list[ResourceRef], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            """
            SELECT rai.id, rai.media_id, rai.kind, rai.label, rai.body_text, m.title
            FROM reader_apparatus_items rai
            JOIN reader_apparatus_states ras ON ras.id = rai.state_id
            JOIN media m ON m.id = rai.media_id
            WHERE rai.id = ANY(:ids)
              AND ras.status IN ('ready', 'partial')
              AND rai.locator IS NOT NULL
              AND rai.locator_status != 'missing'
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or not can_read_media(db, viewer_id, row[1]):
            out.append(_missing(ref.uri, "reader_apparatus_item"))
            continue
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="reader_apparatus_item",
                title=str(row[3] or row[2] or "Reader apparatus"),
                body=str(row[4] or ""),
                source_label=str(row[5] or ""),
                apparatus_kind=str(row[2] or ""),
            )
        )
    return out


# ---------- presentation ------------------------------------------------------


def _first_line(body: str) -> str:
    for line in body.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped[:200]
    return ""


def _read_resolved(loaded: LoadedResource, *, label: str) -> ResolvedResource:
    """Present a body-bearing scheme: summary + inline body under the threshold."""
    body = loaded.body or ""
    return ResolvedResource(
        uri=loaded.uri,
        label=label,
        summary=_first_line(body),
        inline_body=body if len(body) < INLINE_THRESHOLD_CHARS else None,
        fetch_hint=f'read_resource("{loaded.uri}")',
    )


def _present(loaded: LoadedResource) -> ResolvedResource:
    if loaded.missing:
        return missing_resolved_resource(loaded.uri)
    scheme = loaded.scheme
    if scheme == "media":
        title = loaded.title or ""
        label = f"{title} by {loaded.author}" if loaded.author else title
        kind = loaded.media_kind or "document"
        count = loaded.section_count if loaded.section_count is not None else 0
        word_count = loaded.word_count if loaded.word_count is not None else 0
        unit = "pages" if kind == "pdf" else "sections"
        summary_parts = [kind]
        if word_count:
            summary_parts.append(f"~{word_count:,} words")
        if count:
            summary_parts.append(f"{count} {unit}")
        summary = " · ".join(summary_parts)
        fetch_hint = (
            f'inspect_resource("{loaded.uri}") to map; '
            f'read_resource("{loaded.uri}") to read; '
            f'app_search(scopes=["{loaded.uri}"], query=...) to search'
        )
        return ResolvedResource(
            uri=loaded.uri, label=label, summary=summary, inline_body=None, fetch_hint=fetch_hint
        )
    if scheme == "library":
        name = loaded.title or ""
        summary = f"{name} ({loaded.item_count} items)" if loaded.item_count else name
        return ResolvedResource(
            uri=loaded.uri,
            label=name,
            summary=summary,
            inline_body=None,
            fetch_hint=f'app_search(scopes=["{loaded.uri}"], query=...)',
        )
    if scheme in ("artifact", "artifact_revision"):
        name = loaded.title or ""
        content_md = loaded.body or ""
        library_uri = (
            f"library:{loaded.related_library_id}"
            if loaded.related_library_id is not None
            else None
        )
        library_search = (
            f'; app_search(scopes=["{library_uri}"], query=...) to search the library'
            if library_uri is not None
            else ""
        )
        revision_ref = (
            f"artifact_revision:{loaded.related_revision_id}"
            if loaded.related_revision_id is not None
            else None
        )
        label = (
            f"Library dossier — {name}"
            if scheme == "artifact"
            else f"Library dossier revision — {name}"
        )
        return ResolvedResource(
            uri=loaded.uri,
            label=label,
            summary=_first_line(content_md) or f"Library dossier for {name}",
            inline_body=(
                content_md if content_md and len(content_md) < INLINE_THRESHOLD_CHARS else None
            ),
            fetch_hint=(f'read_resource("{loaded.uri}") for the full synthesis{library_search}'),
            resolved_revision_ref=revision_ref,
        )
    if scheme == "highlight":
        quote = loaded.quote
        if quote is None:
            # justify-defect: the highlight loader always sets quote for a visible highlight.
            raise AssertionError(f"highlight {loaded.uri} loaded without a quote")
        label = f"Highlight in {quote.source_label}" if quote.source_label else "Highlight"
        return ResolvedResource(
            uri=loaded.uri,
            label=label,
            summary=quote.exact,
            inline_body=None,
            fetch_hint=f'read_resource("{loaded.uri}")',
            quote=quote,
        )
    if scheme == "evidence_span":
        return _read_resolved(loaded, label=f"{loaded.title} - {loaded.citation_label}")
    if scheme == "content_chunk":
        return _read_resolved(
            loaded, label=f"{loaded.title} - chunk: {_first_line(loaded.body or '')[:80]}"
        )
    if scheme == "page":
        title = loaded.title or ""
        return ResolvedResource(
            uri=loaded.uri,
            label=title,
            summary=title,
            inline_body=title,
            fetch_hint=f'read_resource("{loaded.uri}")',
        )
    if scheme == "note_block":
        return _read_resolved(loaded, label=_first_line(loaded.body or "")[:120] or "Note")
    if scheme == "fragment":
        return _read_resolved(
            loaded, label=f"{loaded.title} — fragment {(loaded.fragment_idx or 0) + 1}"
        )
    if scheme == "conversation":
        return ResolvedResource(
            uri=loaded.uri,
            label=loaded.title or "Untitled conversation",
            summary=f"Chat history with {loaded.message_count or 0} messages.",
            inline_body=None,
            fetch_hint=f'read_resource("{loaded.uri}")',
        )
    if scheme == "message":
        body = loaded.body or ""
        return ResolvedResource(
            uri=loaded.uri,
            label=f"{loaded.message_role}: {body[:40]}".strip(),
            summary=_first_line(body),
            inline_body=body if len(body) < INLINE_THRESHOLD_CHARS else None,
            fetch_hint=f'read_resource("{loaded.uri}")',
        )
    if scheme == "oracle_reading":
        question = _first_line(loaded.title or "")
        return ResolvedResource(
            uri=loaded.uri,
            label=f"Oracle reading: {question[:80]}",
            summary=loaded.citation_label or "",  # folio theme, when bound
            inline_body=None,
            fetch_hint="",
        )
    if scheme == "oracle_passage_anchor":
        return ResolvedResource(
            uri=loaded.uri,
            label=f"{loaded.title} — {loaded.locator_label}",
            summary=_first_line(loaded.body or ""),
            inline_body=None,
            fetch_hint="",
        )
    if scheme == "external_snapshot":
        return ResolvedResource(
            uri=loaded.uri,
            label=loaded.title or "",
            summary=_first_line(loaded.body or ""),
            inline_body=None,
            fetch_hint="",
        )
    if scheme == "contributor":
        return ResolvedResource(
            uri=loaded.uri,
            label=loaded.title or "",
            summary=loaded.citation_label or "",  # disambiguation, when set
            inline_body=None,
            fetch_hint="",
        )
    if scheme == "podcast":
        return ResolvedResource(
            uri=loaded.uri,
            label=loaded.title or "",
            summary=_first_line(loaded.body or ""),
            inline_body=None,
            fetch_hint="",
        )
    if scheme == "reader_apparatus_item":
        body = loaded.body or ""
        source = f" in {loaded.source_label}" if loaded.source_label else ""
        return ResolvedResource(
            uri=loaded.uri,
            label=f"{loaded.title or 'Reader apparatus'}{source}",
            summary=_first_line(body) or loaded.apparatus_kind or "",
            inline_body=body if body and len(body) < INLINE_THRESHOLD_CHARS else None,
            fetch_hint=f'read_resource("{loaded.uri}")',
        )
    assert_never(scheme)
