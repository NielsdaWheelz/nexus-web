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
from typing import assert_never, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_conversation,
    can_read_highlight,
    can_read_media,
    is_library_member,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.services import library_entries, library_entry_listing
from nexus.services.artifacts.registry import visible_persisted_subject_sql
from nexus.services.artifacts.subject_policy import DossierSubjectScheme
from nexus.services.contributor_credits import (
    media_author_credits_join_sql,
    media_author_names_agg_sql,
)
from nexus.services.media_read_map import load_media_document_summary
from nexus.services.resource_graph.highlight_notes import linked_note_blocks_for_highlights
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme

INLINE_THRESHOLD_CHARS = 1500

# Joined media author aggregation, shared by media and highlight loads.
# Byline label for resolved media/quote rows: composed from the canonical credit
# read owner so the sole raw ``contributor_credits`` read lives there (spec §3).
_AUTHORS_SQL = media_author_names_agg_sql()
_AUTHORS_JOIN_SQL = media_author_credits_join_sql()


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
    related_library_id: UUID | None = None  # Library Dossier -> app-search scope
    related_artifact_id: UUID | None = None  # Dossier revision -> artifact head
    related_revision_id: UUID | None = None  # Dossier head -> current revision
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
    include_media_document_summary: bool = True,
) -> list[ResolvedResource]:
    unique: dict[str, ResourceRef] = {}
    for ref in refs:
        unique.setdefault(ref.uri, ref)
    loaded = load_resource_batch(
        db,
        list(unique.values()),
        viewer_id=viewer_id,
        include_media_document_summary=include_media_document_summary,
    )
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


# ---------- batched visibility reads (action-snapshot aggregator) -------------
#
# Set-based twins of the per-ref visibility checks the loaders below apply, one
# bounded ``= ANY(:ids)`` query each. The action-snapshot aggregator sources
# visibility for these media-owned/polymorphic schemes from these reads instead
# of the per-ref ``can_read_media`` loop inside ``resolve_refs`` (AC9). Each read
# reuses the same ``visible_media_ids_cte_sql`` rule the matching ``_load_*``
# loader uses, so the batched and per-ref forms cannot drift.


def visible_fragment_ids(db: Session, *, viewer_id: UUID, fragment_ids: list[UUID]) -> set[UUID]:
    """The subset of the supplied fragment ids whose parent media the viewer can read."""
    ordered = list(dict.fromkeys(fragment_ids))
    if not ordered:
        return set()
    rows = db.execute(
        text(
            f"""
            SELECT f.id
            FROM fragments f
            WHERE f.id = ANY(:fragment_ids)
              AND f.media_id IN ({visible_media_ids_cte_sql()})
            """
        ),
        {"viewer_id": viewer_id, "fragment_ids": ordered},
    ).all()
    return {UUID(str(row[0])) for row in rows}


def visible_evidence_span_ids(
    db: Session, *, viewer_id: UUID, evidence_span_ids: list[UUID]
) -> set[UUID]:
    """The subset of the supplied evidence-span ids the viewer can read.

    Media-owned spans are visible when their parent media is readable; note-owned
    spans when the viewer owns the note block — mirroring the resolve loader."""
    ordered = list(dict.fromkeys(evidence_span_ids))
    if not ordered:
        return set()
    rows = db.execute(
        text(
            f"""
            SELECT es.id
            FROM evidence_spans es
            LEFT JOIN note_blocks nb
              ON nb.id = es.owner_id AND es.owner_kind = 'note_block'
            WHERE es.id = ANY(:evidence_span_ids)
              AND (
                (es.owner_kind = 'media' AND es.owner_id IN ({visible_media_ids_cte_sql()}))
                OR (es.owner_kind = 'note_block' AND nb.user_id = :viewer_id)
              )
            """
        ),
        {"viewer_id": viewer_id, "evidence_span_ids": ordered},
    ).all()
    return {UUID(str(row[0])) for row in rows}


def visible_content_chunk_ids(
    db: Session, *, viewer_id: UUID, content_chunk_ids: list[UUID]
) -> set[UUID]:
    """The subset of the supplied content-chunk ids the viewer can read.

    Media-owned chunks are visible when their parent media is readable; note-owned
    chunks when the viewer owns the note block — mirroring the resolve loader."""
    ordered = list(dict.fromkeys(content_chunk_ids))
    if not ordered:
        return set()
    rows = db.execute(
        text(
            f"""
            SELECT cc.id
            FROM content_chunks cc
            LEFT JOIN note_blocks nb
              ON nb.id = cc.owner_id AND cc.owner_kind = 'note_block'
            WHERE cc.id = ANY(:content_chunk_ids)
              AND (
                (cc.owner_kind = 'media' AND cc.owner_id IN ({visible_media_ids_cte_sql()}))
                OR (cc.owner_kind = 'note_block' AND nb.user_id = :viewer_id)
              )
            """
        ),
        {"viewer_id": viewer_id, "content_chunk_ids": ordered},
    ).all()
    return {UUID(str(row[0])) for row in rows}


# ---------- per-scheme loading ------------------------------------------------


def load_resource_batch(
    db: Session,
    refs: Sequence[ResourceRef],
    *,
    viewer_id: UUID,
    include_media_document_summary: bool = True,
) -> dict[str, LoadedResource]:
    """Load each ref's scheme-specific row + permission check, keyed by ``ref.uri``."""
    by_scheme: dict[ResourceScheme, list[ResourceRef]] = defaultdict(list)
    for ref in refs:
        by_scheme[ref.scheme].append(ref)

    out: dict[str, LoadedResource] = {}
    for scheme, items in by_scheme.items():
        if scheme == "media":
            loaded = _load_media(
                db,
                items,
                viewer_id=viewer_id,
                include_document_summary=include_media_document_summary,
            )
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
        elif scheme == "passage_anchor":
            loaded = _load_passage_anchor(db, items, viewer_id=viewer_id)
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


def _load_media(
    db: Session,
    items: list[ResourceRef],
    *,
    viewer_id: UUID,
    include_document_summary: bool,
) -> list[LoadedResource]:
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT m.id, m.title, m.kind, {_AUTHORS_SQL}
            FROM media m
            JOIN visible_media visible ON visible.media_id = m.id
            {_AUTHORS_JOIN_SQL}
            WHERE m.id = ANY(:ids)
            GROUP BY m.id, m.title, m.kind
            """
        ),
        {"ids": ids, "viewer_id": viewer_id},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None:
            out.append(_missing(ref.uri, "media"))
            continue
        kind = str(row[2])
        summary = (
            load_media_document_summary(db, viewer_id, ref.id) if include_document_summary else None
        )
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
            SELECT l.id, l.name, l.is_default, l.owner_user_id
            FROM libraries l
            WHERE l.id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    # A library only ever passes the membership gate below as the viewer's OWN
    # Default if `is_default` and `owner_user_id` both match this viewer — any
    # other user's Default library has no membership row for this viewer and is
    # masked as missing before counts matter.
    own_default_ids = {row[0] for row in rows if bool(row[2]) and UUID(str(row[3])) == viewer_id}
    physical_counts = library_entries.count_entries_by_library(
        db, [lid for lid in ids if lid not in own_default_ids]
    )
    virtual_counts = {
        lid: library_entry_listing.count_default_root_inventory(
            db, viewer_id=viewer_id, library_id=lid
        )
        for lid in own_default_ids
    }
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or not is_library_member(db, viewer_id, ref.id):
            out.append(_missing(ref.uri, "library"))
            continue
        count = virtual_counts.get(row[0], physical_counts.get(row[0], 0))
        # The viewer's own Default library presents as "All" on every label
        # surface; its stored seeded name is never shown.
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="library",
                title="All" if bool(row[2]) else str(row[1]),
                item_count=int(count),
            )
        )
    return out


def _load_artifact(
    db: Session, items: list[ResourceRef], *, viewer_id: UUID
) -> list[LoadedResource]:
    """Resolve each audience-visible Dossier head to its current revision."""
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            f"""
            SELECT a.id, a.subject_scheme, a.subject_id,
                   COALESCE(
                       m.title, c.title,
                       CASE WHEN l.is_default THEN 'All' ELSE l.name END,
                       p.title, co.display_name,
                       pg.title, CASE WHEN nb.id IS NOT NULL THEN 'Note' END,
                       idea.display_title
                   ) AS subject_title,
                   r.id AS revision_id, r.content_text
            FROM artifacts a
            LEFT JOIN artifact_revisions r ON r.id = a.current_revision_id
            LEFT JOIN media m ON a.subject_scheme = 'media' AND m.id = a.subject_id
            LEFT JOIN conversations c
              ON a.subject_scheme = 'conversation' AND c.id = a.subject_id
            LEFT JOIN libraries l ON a.subject_scheme = 'library' AND l.id = a.subject_id
            LEFT JOIN podcasts p ON a.subject_scheme = 'podcast' AND p.id = a.subject_id
            LEFT JOIN contributors co
              ON a.subject_scheme = 'contributor' AND co.id = a.subject_id
            LEFT JOIN pages pg ON a.subject_scheme = 'page' AND pg.id = a.subject_id
            LEFT JOIN note_blocks nb
              ON a.subject_scheme = 'note_block' AND nb.id = a.subject_id
            LEFT JOIN artifact_idea_subjects idea
              ON a.subject_scheme = 'idea' AND idea.id = a.subject_id
            WHERE a.id = ANY(:ids)
              AND {visible_persisted_subject_sql("a")}
            """
        ),
        {"ids": ids, "viewer_id": viewer_id, "viewer_id_text": str(viewer_id)},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None:
            out.append(_missing(ref.uri, "artifact"))
            continue
        subject_scheme = cast(DossierSubjectScheme, str(row[1]))
        subject_id = UUID(str(row[2]))
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="artifact",
                title=str(row[3] or "Dossier"),
                body=str(row[5]) if row[5] is not None else None,
                related_artifact_id=UUID(str(row[0])),
                related_library_id=subject_id if subject_scheme == "library" else None,
                related_revision_id=UUID(str(row[4])) if row[4] is not None else None,
            )
        )
    return out


def _load_artifact_revision(
    db: Session, items: list[ResourceRef], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            f"""
            SELECT r.id, a.id AS artifact_id, a.subject_scheme, a.subject_id,
                   COALESCE(
                       m.title, c.title,
                       CASE WHEN l.is_default THEN 'All' ELSE l.name END,
                       p.title, co.display_name,
                       pg.title, CASE WHEN nb.id IS NOT NULL THEN 'Note' END,
                       idea.display_title
                   ) AS subject_title,
                   r.content_text, a.current_revision_id = r.id AS is_current
            FROM artifact_revisions r
            JOIN artifact_builds b ON b.id = r.build_id
            JOIN artifacts a ON a.id = b.artifact_id
            LEFT JOIN media m ON a.subject_scheme = 'media' AND m.id = a.subject_id
            LEFT JOIN conversations c
              ON a.subject_scheme = 'conversation' AND c.id = a.subject_id
            LEFT JOIN libraries l ON a.subject_scheme = 'library' AND l.id = a.subject_id
            LEFT JOIN podcasts p ON a.subject_scheme = 'podcast' AND p.id = a.subject_id
            LEFT JOIN contributors co
              ON a.subject_scheme = 'contributor' AND co.id = a.subject_id
            LEFT JOIN pages pg ON a.subject_scheme = 'page' AND pg.id = a.subject_id
            LEFT JOIN note_blocks nb
              ON a.subject_scheme = 'note_block' AND nb.id = a.subject_id
            LEFT JOIN artifact_idea_subjects idea
              ON a.subject_scheme = 'idea' AND idea.id = a.subject_id
            WHERE r.id = ANY(:ids)
              AND {visible_persisted_subject_sql("a")}
            """
        ),
        {"ids": ids, "viewer_id": viewer_id, "viewer_id_text": str(viewer_id)},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None:
            out.append(_missing(ref.uri, "artifact_revision"))
            continue
        subject_scheme = cast(DossierSubjectScheme, str(row[2]))
        subject_id = UUID(str(row[3]))
        suffix = "current" if row[6] else "historical"
        out.append(
            LoadedResource(
                uri=ref.uri,
                scheme="artifact_revision",
                title=f"{row[4] or 'Dossier'} ({suffix})",
                body=str(row[5] or ""),
                related_artifact_id=UUID(str(row[1])),
                related_library_id=subject_id if subject_scheme == "library" else None,
                related_revision_id=UUID(str(row[0])),
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
            {_AUTHORS_JOIN_SQL}
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
        text("SELECT id, display_name FROM contributors WHERE id = ANY(:ids)"),
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
                # D-30: display name is the whole label; no disambiguation summary.
                citation_label=None,
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


def _load_passage_anchor(
    db: Session, items: list[ResourceRef], *, viewer_id: UUID
) -> list[LoadedResource]:
    """Passage anchors are user-owned; ``user_id`` equality is the whole visibility
    gate (Passage Anchor: "Owner visibility ... replace a polymorphic FK" — here
    the anchor row itself has no owner-side visibility to check beyond its own
    ``user_id``, since the owner may itself be gone/unresolved and the anchor
    must still surface as a durable Link endpoint, per Invariant 9).
    """
    ids = [ref.id for ref in items]
    rows = db.execute(
        text("SELECT id, user_id, selector FROM passage_anchors WHERE id = ANY(:ids)"),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or row[1] != viewer_id:
            out.append(_missing(ref.uri, "passage_anchor"))
            continue
        selector = row[2] or {}
        quote = selector.get("quote") if isinstance(selector, dict) else None
        exact = str(quote.get("exact") or "") if isinstance(quote, dict) else ""
        out.append(LoadedResource(uri=ref.uri, scheme="passage_anchor", body=exact))
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
        fetch_hint=f'nexus__resource__read("{loaded.uri}")',
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
            f'nexus__resource__inspect("{loaded.uri}") to map; '
            f'nexus__resource__read("{loaded.uri}") to read; '
            f'nexus__search(scopes=["{loaded.uri}"], query=...) to search'
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
            fetch_hint=f'nexus__search(scopes=["{loaded.uri}"], query=...)',
        )
    if scheme in ("artifact", "artifact_revision"):
        name = loaded.title or ""
        content_text = loaded.body or ""
        library_uri = (
            f"library:{loaded.related_library_id}"
            if loaded.related_library_id is not None
            else None
        )
        library_search = (
            f'; nexus__search(scopes=["{library_uri}"], query=...) to search the library'
            if library_uri is not None
            else ""
        )
        revision_ref = (
            f"artifact_revision:{loaded.related_revision_id}"
            if loaded.related_revision_id is not None
            else None
        )
        label = f"Dossier — {name}" if scheme == "artifact" else f"Dossier revision — {name}"
        return ResolvedResource(
            uri=loaded.uri,
            label=label,
            summary=_first_line(content_text) or f"Dossier for {name}",
            inline_body=(
                content_text
                if content_text and len(content_text) < INLINE_THRESHOLD_CHARS
                else None
            ),
            fetch_hint=(
                f'nexus__resource__read("{loaded.uri}") for the full synthesis{library_search}'
            ),
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
            fetch_hint=f'nexus__resource__read("{loaded.uri}")',
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
            fetch_hint=f'nexus__resource__read("{loaded.uri}")',
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
            fetch_hint=f'nexus__resource__read("{loaded.uri}")',
        )
    if scheme == "message":
        body = loaded.body or ""
        return ResolvedResource(
            uri=loaded.uri,
            label=f"{loaded.message_role}: {body[:40]}".strip(),
            summary=_first_line(body),
            inline_body=body if len(body) < INLINE_THRESHOLD_CHARS else None,
            fetch_hint=f'nexus__resource__read("{loaded.uri}")',
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
            label=loaded.title or "",  # D-30: display name is the whole label
            summary="",
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
    if scheme == "passage_anchor":
        return _read_resolved(loaded, label=_first_line(loaded.body or "")[:120] or "Passage")
    if scheme == "reader_apparatus_item":
        body = loaded.body or ""
        source = f" in {loaded.source_label}" if loaded.source_label else ""
        return ResolvedResource(
            uri=loaded.uri,
            label=f"{loaded.title or 'Reader apparatus'}{source}",
            summary=_first_line(body) or loaded.apparatus_kind or "",
            inline_body=body if body and len(body) < INLINE_THRESHOLD_CHARS else None,
            fetch_hint=f'nexus__resource__read("{loaded.uri}")',
        )
    assert_never(scheme)
