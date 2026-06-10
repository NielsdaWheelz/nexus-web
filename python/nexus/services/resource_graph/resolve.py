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
from nexus.services import library_entries
from nexus.services.locator_resolver import locator_from_resolution, resolve_evidence_span
from nexus.services.media_document_map import load_media_document_summary
from nexus.services.notes import linked_note_blocks_for_highlights
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
    section_count: int | None = None  # media summary (pages for pdf, else map sections)
    word_count: int | None = None  # media summary
    fragment_idx: int | None = None  # fragment label "fragment {idx+1}"
    citation_label: str | None = None  # evidence-span label
    message_role: str | None = None  # message "{role}: …"
    message_count: int | None = None  # conversation summary
    item_count: int | None = None  # library summary
    related_library_id: UUID | None = None  # LI artifact -> the library: scope for app_search
    locator_label: str | None = None  # oracle corpus passage locator


@dataclass(frozen=True)
class ResolvedResource:
    uri: str
    label: str
    summary: str
    inline_body: str | None
    fetch_hint: str
    quote: LoadedQuote | None = None  # set for highlights → <quote> instead of <body>
    missing: bool = False


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
        elif scheme == "library_intelligence_artifact":
            loaded = _load_library_intelligence_artifact(db, items, viewer_id=viewer_id)
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
        elif scheme == "oracle_corpus_passage":
            loaded = _load_oracle_corpus_passage(db, items)
        elif scheme == "external_snapshot":
            loaded = _load_external_snapshot(db, items, viewer_id=viewer_id)
        elif scheme == "contributor":
            loaded = _load_contributor(db, items)
        elif scheme == "podcast":
            loaded = _load_podcast(db, items, viewer_id=viewer_id)
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
    media-owned rows have a parent media id, so a page-owned span/chunk resolves to
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
    up for chat, Oracle, and Library Intelligence, all of which cite the finest-grained
    object (``evidence_span``/``content_chunk``/``media``). Position lives in the target,
    not the edge (D11), so it is recomputed here from the target's own anchoring using
    the single locator owner (``locator_resolver``), exactly as search and LI synthesis do.

    Returns ``(None, None)`` for targets with no media reader (note-block-owned spans,
    ``note_block``/``external_snapshot``/``oracle_corpus_passage`` chips, or a vanished
    target — citation edges outlive their targets, N4); the chip then renders link-only
    via its snapshot ``deep_link``.
    """
    if target.scheme == "media":
        return target.id, None
    if target.scheme == "content_chunk":
        chunk_media_id = parent_media_id_for_read_pointer(
            db, scheme="content_chunk", resource_id=target.id
        )
        return chunk_media_id, None
    if target.scheme != "evidence_span":
        return None, None
    # Media-owned spans only: a page-owned (note) span resolves to a note locator whose
    # parent is a page, not media, which the media jump path cannot render — fall back to
    # the snapshot deep_link instead of leaking a page id as a media id.
    media_id = parent_media_id_for_read_pointer(db, scheme="evidence_span", resource_id=target.id)
    if media_id is None:
        return None, None
    try:
        resolution = resolve_evidence_span(db, viewer_id=viewer_id, evidence_span_id=target.id)
    except NotFoundError:
        # justify-ignore-error: the cited span was deleted or is no longer visible; the
        # cited edge outlives it (N4), so the chip renders from its stored snapshot.
        return None, None
    media_kind = db.scalar(text("SELECT kind FROM media WHERE id = :id"), {"id": media_id})
    locator = locator_from_resolution(
        resolution, media_id=media_id, media_kind=str(media_kind or "")
    )
    return media_id, locator


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


def _load_library_intelligence_artifact(
    db: Session, items: list[ResourceRef], *, viewer_id: UUID
) -> list[LoadedResource]:
    """Resolve each artifact head to its CURRENT revision content_md.

    Joins head -> libraries (name) -> LEFT JOIN current revision (content_md). The
    head resolves to whatever is current at this call (fresh per assembly). A head
    with ``current_revision_id IS NULL`` is non-missing with ``body=None``. Gated by
    library membership; a non-member or unknown id is masked as missing.
    """
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            """
            SELECT a.id, a.library_id, l.name, r.content_md
            FROM library_intelligence_artifacts a
            JOIN libraries l ON l.id = a.library_id
            LEFT JOIN library_intelligence_artifact_revisions r
                ON r.id = a.current_revision_id
            WHERE a.id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or not is_library_member(db, viewer_id, row[1]):
            out.append(_missing(ref.uri, "library_intelligence_artifact"))
            continue
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="library_intelligence_artifact",
                title=str(row[2]),
                body=str(row[3]) if row[3] is not None else None,
                related_library_id=UUID(str(row[1])),
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
            SELECT es.id, es.owner_id AS media_id, es.span_text, es.citation_label, m.title
            FROM evidence_spans es
            JOIN media m ON m.id = es.owner_id AND es.owner_kind = 'media'
            WHERE es.id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or not can_read_media(db, viewer_id, row[1]):
            out.append(_missing(ref.uri, "evidence_span"))
            continue
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="evidence_span",
                body=str(row[2] or ""),
                title=str(row[4]),
                citation_label=str(row[3] or ""),
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
            SELECT cc.id, cc.owner_id AS media_id, cc.chunk_text, m.title
            FROM content_chunks cc
            JOIN media m ON m.id = cc.owner_id AND cc.owner_kind = 'media'
            WHERE cc.id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or not can_read_media(db, viewer_id, row[1]):
            out.append(_missing(ref.uri, "content_chunk"))
            continue
        out.append(
            LoadedResource(
                uri=ref.uri, scheme="content_chunk", body=str(row[2] or ""), title=str(row[3])
            )
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
        text("SELECT id, user_id, title, description FROM pages WHERE id = ANY(:ids)"),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or row[1] != viewer_id:
            out.append(_missing(ref.uri, "page"))
            continue
        out.append(
            LoadedResource(uri=ref.uri, scheme="page", body=str(row[3] or ""), title=str(row[2]))
        )
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


def _load_oracle_corpus_passage(db: Session, items: list[ResourceRef]) -> list[LoadedResource]:
    """Public-domain corpus passages are global: any existing row is visible."""
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            """
            SELECT p.id, p.canonical_text, p.locator_label, w.title, w.author
            FROM oracle_corpus_passages p
            JOIN oracle_corpus_works w ON w.id = p.work_id
            WHERE p.id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None:
            out.append(_missing(ref.uri, "oracle_corpus_passage"))
            continue
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="oracle_corpus_passage",
                body=str(row[1] or ""),
                title=str(row[3]),
                author=str(row[4] or "") or None,
                locator_label=str(row[2] or ""),
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
    if scheme == "library_intelligence_artifact":
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
        return ResolvedResource(
            uri=loaded.uri,
            label=f"Library Intelligence — {name}",
            summary=_first_line(content_md) or f"Library Intelligence for {name}",
            inline_body=(
                content_md if content_md and len(content_md) < INLINE_THRESHOLD_CHARS else None
            ),
            fetch_hint=(f'read_resource("{loaded.uri}") for the full synthesis{library_search}'),
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
        return _read_resolved(loaded, label=loaded.title or "")
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
    if scheme == "oracle_corpus_passage":
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
    assert_never(scheme)
