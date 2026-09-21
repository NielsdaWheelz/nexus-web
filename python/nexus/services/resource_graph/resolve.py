"""Batch hydration of resource refs for prompts, UI and the API.

One loader per scheme owns that scheme's SQL, its viewer gate and its display strings.
A missing, forbidden or unknown ref hydrates as ``missing`` — this layer never raises;
writes reject invisible endpoints through :func:`assert_ref_visible`.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any
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
from nexus.services.contributor_credits import (
    media_author_credits_join_sql,
    media_author_names_agg_sql,
)
from nexus.services.media_read_map import load_media_document_summary
from nexus.services.resource_graph.highlight_notes import linked_note_blocks_for_highlights
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme

INLINE_THRESHOLD_CHARS = 1500

_AUTHORS_SQL = media_author_names_agg_sql()
_AUTHORS_JOIN_SQL = media_author_credits_join_sql()

# The Dossier subject title, resolved across every persisted subject scheme.
_SUBJECT_TITLE_SQL = """
    COALESCE(
        m.title, c.title,
        CASE WHEN l.is_default THEN 'All' ELSE l.name END,
        p.title, co.display_name,
        pg.title, CASE WHEN nb.id IS NOT NULL THEN 'Note' END,
        idea.display_title
    ) AS subject_title
"""
_SUBJECT_JOINS_SQL = """
    LEFT JOIN media m ON a.subject_scheme = 'media' AND m.id = a.subject_id
    LEFT JOIN conversations c ON a.subject_scheme = 'conversation' AND c.id = a.subject_id
    LEFT JOIN libraries l ON a.subject_scheme = 'library' AND l.id = a.subject_id
    LEFT JOIN podcasts p ON a.subject_scheme = 'podcast' AND p.id = a.subject_id
    LEFT JOIN contributors co ON a.subject_scheme = 'contributor' AND co.id = a.subject_id
    LEFT JOIN pages pg ON a.subject_scheme = 'page' AND pg.id = a.subject_id
    LEFT JOIN note_blocks nb ON a.subject_scheme = 'note_block' AND nb.id = a.subject_id
    LEFT JOIN artifact_idea_subjects idea ON a.subject_scheme = 'idea' AND idea.id = a.subject_id
"""


@dataclass(frozen=True)
class ResolvedQuote:
    exact: str
    prefix: str
    suffix: str
    source_label: str | None
    note: str | None


@dataclass(frozen=True)
class ResolvedResource:
    """One hydrated ref: presentation for prompts and UI, body for the read tool."""

    uri: str
    label: str
    summary: str
    inline_body: str | None = None
    fetch_hint: str = ""
    quote: ResolvedQuote | None = None
    missing: bool = False
    resolved_revision_ref: str | None = None
    body: str | None = None
    title: str | None = None
    message_role: str | None = None
    message_count: int | None = None


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
    return [loaded[ref.uri] for ref in refs]


def assert_ref_visible(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> None:
    """Raise ``NotFoundError`` unless ``ref`` resolves visible to the viewer."""
    if resolve_ref(db, viewer_id=viewer_id, ref=ref).missing:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")


def load_resource_batch(
    db: Session,
    refs: Sequence[ResourceRef],
    *,
    viewer_id: UUID,
    include_media_document_summary: bool = True,
) -> dict[str, ResolvedResource]:
    """Hydrate each ref through its scheme's loader, keyed by ``ref.uri``."""
    by_scheme: dict[ResourceScheme, list[ResourceRef]] = defaultdict(list)
    for ref in refs:
        by_scheme[ref.scheme].append(ref)
    out: dict[str, ResolvedResource] = {}
    for scheme, items in by_scheme.items():
        loaded = (
            _load_media(db, items, viewer_id, include_media_document_summary)
            if scheme == "media"
            else _LOADERS[scheme](db, items, viewer_id)
        )
        out.update({entry.uri: entry for entry in loaded})
    return out


def parent_media_id_for_read_pointer(
    db: Session, *, scheme: ResourceScheme, resource_id: UUID
) -> UUID | None:
    """The parent media id of a media-derived read pointer, or ``None``.

    ``evidence_spans`` and ``content_chunks`` are polymorphic over ``(owner_kind,
    owner_id)``; a note-owned row has no parent media and is not readable here.
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


def oracle_anchor_current_target(db: Session, anchor_id: UUID) -> ResourceRef | None:
    """The index pointer a resolved Oracle passage anchor points at, span before chunk.

    ``None`` when the anchor is unresolved or its pointers were cleared by a reindex;
    the citation then fails closed (typographic, no jump) until re-resolution.
    """
    row = db.execute(
        text(
            "SELECT current_evidence_span_id, current_content_chunk_id FROM oracle_passage_anchors"
            " WHERE id = :id AND resolution_status = 'resolved'"
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


# ---------- batched visibility reads (action-snapshot aggregator) -------------


def visible_fragment_ids(db: Session, *, viewer_id: UUID, fragment_ids: list[UUID]) -> set[UUID]:
    """The supplied fragments whose parent media the viewer can read."""
    ordered = list(dict.fromkeys(fragment_ids))
    if not ordered:
        return set()
    rows = db.execute(
        text(
            f"SELECT f.id FROM fragments f WHERE f.id = ANY(:fragment_ids) AND f.media_id IN ({visible_media_ids_cte_sql()})"
        ),
        {"viewer_id": viewer_id, "fragment_ids": ordered},
    ).all()
    return {UUID(str(row[0])) for row in rows}


def visible_evidence_span_ids(
    db: Session, *, viewer_id: UUID, evidence_span_ids: list[UUID]
) -> set[UUID]:
    """The supplied evidence spans the viewer can read, mirroring the loader's gate."""
    return _visible_owned_ids(
        db, viewer_id=viewer_id, table="evidence_spans", ids=evidence_span_ids
    )


def visible_content_chunk_ids(
    db: Session, *, viewer_id: UUID, content_chunk_ids: list[UUID]
) -> set[UUID]:
    """The supplied content chunks the viewer can read, mirroring the loader's gate."""
    return _visible_owned_ids(
        db, viewer_id=viewer_id, table="content_chunks", ids=content_chunk_ids
    )


def _visible_owned_ids(db: Session, *, viewer_id: UUID, table: str, ids: list[UUID]) -> set[UUID]:
    ordered = list(dict.fromkeys(ids))
    if not ordered:
        return set()
    rows = db.execute(
        text(
            f"""
            SELECT t.id FROM {table} t
            LEFT JOIN note_blocks nb ON nb.id = t.owner_id AND t.owner_kind = 'note_block'
            WHERE t.id = ANY(:ids)
              AND (
                (t.owner_kind = 'media' AND t.owner_id IN ({visible_media_ids_cte_sql()}))
                OR (t.owner_kind = 'note_block' AND nb.user_id = :viewer_id)
              )
            """
        ),
        {"viewer_id": viewer_id, "ids": ordered},
    ).all()
    return {UUID(str(row[0])) for row in rows}


# ---------- presentation helpers ----------------------------------------------


def _missing(ref: ResourceRef) -> ResolvedResource:
    return ResolvedResource(uri=ref.uri, label="(resource unavailable)", summary="", missing=True)


def _first_line(body: str) -> str:
    for line in body.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped[:200]
    return ""


def _read(ref: ResourceRef, *, label: str, body: str, title: str | None = None) -> ResolvedResource:
    """A body-bearing scheme: first line as summary, body inlined under the threshold."""
    return ResolvedResource(
        uri=ref.uri,
        label=label,
        summary=_first_line(body),
        inline_body=body if len(body) < INLINE_THRESHOLD_CHARS else None,
        fetch_hint=f'nexus__resource__read("{ref.uri}")',
        body=body,
        title=title,
    )


def _load(
    db: Session,
    items: list[ResourceRef],
    sql: str,
    params: dict[str, Any],
    build: Callable[[ResourceRef, Any], ResolvedResource | None],
) -> list[ResolvedResource]:
    """Run one keyed query and build each ref's record; an absent row or a ``None``
    build (the viewer gate) hydrates as missing."""
    rows = db.execute(text(sql), {"ids": [ref.id for ref in items], **params}).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[ResolvedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        built = build(ref, row) if row is not None else None
        out.append(built if built is not None else _missing(ref))
    return out


# ---------- per-scheme loaders -------------------------------------------------


def _load_media(
    db: Session, items: list[ResourceRef], viewer_id: UUID, include_document_summary: bool
) -> list[ResolvedResource]:
    def build(ref: ResourceRef, row: Any) -> ResolvedResource:
        kind = str(row[2]) or "document"
        authors = str(row[3]) or None
        document = (
            load_media_document_summary(db, viewer_id, ref.id) if include_document_summary else None
        )
        words = document.word_count if document is not None else None
        sections = document.section_count if document is not None else None
        parts = [kind]
        if words:
            parts.append(f"~{words:,} words")
        if sections:
            parts.append(f"{sections} {'pages' if kind == 'pdf' else 'sections'}")
        return ResolvedResource(
            uri=ref.uri,
            label=f"{row[1]} by {authors}" if authors else str(row[1]),
            summary=" · ".join(parts),
            fetch_hint=(
                f'nexus__resource__inspect("{ref.uri}") to map; '
                f'nexus__resource__read("{ref.uri}") to read; '
                f'nexus__search(scopes=["{ref.uri}"], query=...) to search'
            ),
            title=str(row[1]),
        )

    return _load(
        db,
        items,
        f"""
        WITH visible_media AS ({visible_media_ids_cte_sql()})
        SELECT m.id, m.title, m.kind, {_AUTHORS_SQL}
        FROM media m
        JOIN visible_media visible ON visible.media_id = m.id
        {_AUTHORS_JOIN_SQL}
        WHERE m.id = ANY(:ids)
        GROUP BY m.id, m.title, m.kind
        """,
        {"viewer_id": viewer_id},
        build,
    )


def _load_library(db: Session, items: list[ResourceRef], viewer_id: UUID) -> list[ResolvedResource]:
    ids = [ref.id for ref in items]
    rows = db.execute(
        text(
            "SELECT l.id, l.name, l.is_default, l.owner_user_id FROM libraries l WHERE l.id = ANY(:ids)"
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    # Only the viewer's OWN Default counts its virtual root inventory; any other
    # user's Default has no membership row for this viewer and is masked below.
    own_default = {row[0] for row in rows if bool(row[2]) and UUID(str(row[3])) == viewer_id}
    counts = library_entries.count_entries_by_library(
        db, [lid for lid in ids if lid not in own_default]
    )
    counts.update(
        {
            lid: library_entry_listing.count_default_root_inventory(
                db, viewer_id=viewer_id, library_id=lid
            )
            for lid in own_default
        }
    )
    out: list[ResolvedResource] = []
    for ref in items:
        row = by_id.get(ref.id)
        if row is None or not is_library_member(db, viewer_id, ref.id):
            out.append(_missing(ref))
            continue
        # The viewer's own Default presents as "All"; its seeded name is never shown.
        name = "All" if bool(row[2]) else str(row[1])
        count = int(counts.get(ref.id, 0))
        out.append(
            ResolvedResource(
                uri=ref.uri,
                label=name,
                summary=f"{name} ({count} items)" if count else name,
                fetch_hint=f'nexus__search(scopes=["{ref.uri}"], query=...)',
                title=name,
            )
        )
    return out


def _dossier(
    ref: ResourceRef,
    *,
    label: str,
    subject: str,
    content: str | None,
    library_id: UUID | None,
    revision_id: UUID | None,
) -> ResolvedResource:
    body = content or ""
    library_search = (
        f'; nexus__search(scopes=["library:{library_id}"], query=...) to search the library'
        if library_id is not None
        else ""
    )
    return ResolvedResource(
        uri=ref.uri,
        label=label,
        summary=_first_line(body) or f"Dossier for {subject}",
        inline_body=body if body and len(body) < INLINE_THRESHOLD_CHARS else None,
        fetch_hint=f'nexus__resource__read("{ref.uri}") for the full synthesis{library_search}',
        resolved_revision_ref=(
            f"artifact_revision:{revision_id}" if revision_id is not None else None
        ),
        body=content,
        title=subject,
    )


def _load_artifact(
    db: Session, items: list[ResourceRef], viewer_id: UUID
) -> list[ResolvedResource]:
    from nexus.services.artifacts.subjects import visible_persisted_subject_sql

    def build(ref: ResourceRef, row: Any) -> ResolvedResource:
        subject = str(row[3] or "Dossier")
        return _dossier(
            ref,
            label=f"Dossier — {subject}",
            subject=subject,
            content=str(row[5]) if row[5] is not None else None,
            library_id=UUID(str(row[2])) if str(row[1]) == "library" else None,
            revision_id=UUID(str(row[4])) if row[4] is not None else None,
        )

    return _load(
        db,
        items,
        f"""
        SELECT a.id, a.subject_scheme, a.subject_id, {_SUBJECT_TITLE_SQL},
               r.id AS revision_id, r.content_text
        FROM artifacts a
        LEFT JOIN artifact_revisions r ON r.id = a.current_revision_id
        {_SUBJECT_JOINS_SQL}
        WHERE a.id = ANY(:ids) AND {visible_persisted_subject_sql("a")}
        """,
        {"viewer_id": viewer_id, "viewer_id_text": str(viewer_id)},
        build,
    )


def _load_artifact_revision(
    db: Session, items: list[ResourceRef], viewer_id: UUID
) -> list[ResolvedResource]:
    from nexus.services.artifacts.subjects import visible_persisted_subject_sql

    def build(ref: ResourceRef, row: Any) -> ResolvedResource:
        subject = f"{row[4] or 'Dossier'} ({'current' if row[6] else 'historical'})"
        return _dossier(
            ref,
            label=f"Dossier revision — {subject}",
            subject=subject,
            content=str(row[5] or ""),
            library_id=UUID(str(row[3])) if str(row[2]) == "library" else None,
            revision_id=UUID(str(row[0])),
        )

    return _load(
        db,
        items,
        f"""
        SELECT r.id, a.id AS artifact_id, a.subject_scheme, a.subject_id, {_SUBJECT_TITLE_SQL},
               r.content_text, a.current_revision_id = r.id AS is_current
        FROM artifact_revisions r
        JOIN artifact_builds b ON b.id = r.build_id
        JOIN artifacts a ON a.id = b.artifact_id
        {_SUBJECT_JOINS_SQL}
        WHERE r.id = ANY(:ids) AND {visible_persisted_subject_sql("a")}
        """,
        {"viewer_id": viewer_id, "viewer_id_text": str(viewer_id)},
        build,
    )


def _load_owned_text(
    db: Session, items: list[ResourceRef], viewer_id: UUID, *, table: str, body: str, extra: str
) -> list[ResolvedResource]:
    """Evidence spans and content chunks: one polymorphic ``(owner_kind, owner_id)`` row."""

    def build(ref: ResourceRef, row: Any) -> ResolvedResource | None:
        owner_kind = str(row[1])
        if owner_kind == "media":
            if not can_read_media(db, viewer_id, row[2]):
                return None
            title = str(row[5])
        elif owner_kind == "note_block" and row[6] == viewer_id:
            title = "Note"
        else:
            return None
        content = str(row[3] or "")
        label = (
            f"{title} - {str(row[4] or '')}"
            if ref.scheme == "evidence_span"
            else f"{title} - chunk: {_first_line(content)[:80]}"
        )
        return _read(ref, label=label, body=content, title=title)

    return _load(
        db,
        items,
        f"""
        SELECT t.id, t.owner_kind, t.owner_id, t.{body}, {extra}, m.title, nb.user_id
        FROM {table} t
        LEFT JOIN media m ON m.id = t.owner_id AND t.owner_kind = 'media'
        LEFT JOIN note_blocks nb ON nb.id = t.owner_id AND t.owner_kind = 'note_block'
        WHERE t.id = ANY(:ids)
        """,
        {},
        build,
    )


def _load_evidence_span(
    db: Session, items: list[ResourceRef], viewer_id: UUID
) -> list[ResolvedResource]:
    return _load_owned_text(
        db, items, viewer_id, table="evidence_spans", body="span_text", extra="t.citation_label"
    )


def _load_content_chunk(
    db: Session, items: list[ResourceRef], viewer_id: UUID
) -> list[ResolvedResource]:
    return _load_owned_text(
        db, items, viewer_id, table="content_chunks", body="chunk_text", extra="NULL"
    )


def _load_highlight(
    db: Session, items: list[ResourceRef], viewer_id: UUID
) -> list[ResolvedResource]:
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
        {"ids": [ref.id for ref in items]},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    visible = {
        ref.id for ref in items if ref.id in by_id and can_read_highlight(db, viewer_id, ref.id)
    }
    notes = linked_note_blocks_for_highlights(db, viewer_id, list(visible))
    out: list[ResolvedResource] = []
    for ref in items:
        if ref.id not in visible:
            out.append(_missing(ref))
            continue
        row = by_id[ref.id]
        authors = str(row[5])
        source_label = f"“{row[4]}” by {authors}" if authors else f"“{row[4]}”"
        quote = ResolvedQuote(
            exact=str(row[1] or ""),
            prefix=str(row[2] or ""),
            suffix=str(row[3] or ""),
            source_label=source_label,
            note="\n\n".join(b.body_text for b in notes.get(ref.id, []) if b.body_text) or None,
        )
        out.append(
            ResolvedResource(
                uri=ref.uri,
                label=f"Highlight in {source_label}",
                summary=quote.exact,
                fetch_hint=f'nexus__resource__read("{ref.uri}")',
                quote=quote,
            )
        )
    return out


def _load_page(db: Session, items: list[ResourceRef], viewer_id: UUID) -> list[ResolvedResource]:
    def build(ref: ResourceRef, row: Any) -> ResolvedResource | None:
        if row[1] != viewer_id:
            return None
        title = str(row[2])
        return ResolvedResource(
            uri=ref.uri,
            label=title,
            summary=title,
            inline_body=title,
            fetch_hint=f'nexus__resource__read("{ref.uri}")',
            body=title,
            title=title,
        )

    return _load(db, items, "SELECT id, user_id, title FROM pages WHERE id = ANY(:ids)", {}, build)


def _load_note_block(
    db: Session, items: list[ResourceRef], viewer_id: UUID
) -> list[ResolvedResource]:
    def build(ref: ResourceRef, row: Any) -> ResolvedResource | None:
        if row[1] != viewer_id:
            return None
        body = str(row[2] or "")
        return _read(ref, label=_first_line(body)[:120] or "Note", body=body)

    return _load(
        db, items, "SELECT id, user_id, body_text FROM note_blocks WHERE id = ANY(:ids)", {}, build
    )


def _load_fragment(
    db: Session, items: list[ResourceRef], viewer_id: UUID
) -> list[ResolvedResource]:
    def build(ref: ResourceRef, row: Any) -> ResolvedResource | None:
        if not can_read_media(db, viewer_id, row[1]):
            return None
        return _read(
            ref,
            label=f"{row[4]} — fragment {int(row[2]) + 1}",
            body=str(row[3] or ""),
            title=str(row[4]),
        )

    return _load(
        db,
        items,
        "SELECT f.id, f.media_id, f.idx, f.canonical_text, m.title FROM fragments f JOIN media m ON m.id = f.media_id WHERE f.id = ANY(:ids)",
        {},
        build,
    )


def _load_conversation(
    db: Session, items: list[ResourceRef], viewer_id: UUID
) -> list[ResolvedResource]:
    def build(ref: ResourceRef, row: Any) -> ResolvedResource | None:
        if not can_read_conversation(db, viewer_id, ref.id):
            return None
        title = str(row[1] or "").strip() or "Untitled conversation"
        count = int(row[2] or 0)
        return ResolvedResource(
            uri=ref.uri,
            label=title,
            summary=f"Chat history with {count} messages.",
            fetch_hint=f'nexus__resource__read("{ref.uri}")',
            title=title,
            message_count=count,
        )

    return _load(
        db,
        items,
        "SELECT c.id, c.title, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count FROM conversations c WHERE c.id = ANY(:ids)",
        {},
        build,
    )


def _load_message(db: Session, items: list[ResourceRef], viewer_id: UUID) -> list[ResolvedResource]:
    def build(ref: ResourceRef, row: Any) -> ResolvedResource | None:
        if not can_read_conversation(db, viewer_id, row[1]):
            return None
        body = str(row[3] or "")
        return ResolvedResource(
            uri=ref.uri,
            label=f"{row[2]}: {body[:40]}".strip(),
            summary=_first_line(body),
            inline_body=body if len(body) < INLINE_THRESHOLD_CHARS else None,
            fetch_hint=f'nexus__resource__read("{ref.uri}")',
            body=body,
            message_role=str(row[2]),
        )

    return _load(
        db,
        items,
        "SELECT id, conversation_id, role, content FROM messages "
        "WHERE id = ANY(:ids) AND status != 'pending'",
        {},
        build,
    )


def _load_oracle_reading(
    db: Session, items: list[ResourceRef], viewer_id: UUID
) -> list[ResolvedResource]:
    """Owner-only readings; ``body`` is the readable reading, folio passages live on
    the reading's citation edges."""

    def build(ref: ResourceRef, row: Any) -> ResolvedResource | None:
        if row[1] != viewer_id:
            return None
        question = str(row[2])
        lines = [f"Question: {question}"]
        if row[4]:
            lines.append(f"Motto: {row[4]}" + (f" — {row[5]}" if row[5] else ""))
        if row[6]:
            lines.append(f"Argument: {row[6]}")
        if row[7]:
            lines.append(f"\nInterpretation:\n{row[7]}")
        return ResolvedResource(
            uri=ref.uri,
            label=f"Oracle reading: {_first_line(question)[:80]}",
            summary=str(row[3]) if row[3] is not None else "",
            body="\n".join(lines),
            title=question,
        )

    return _load(
        db,
        items,
        """
        SELECT id, user_id, question_text, folio_theme,
               folio_motto, folio_motto_gloss, argument_text, interpretation_text
        FROM oracle_readings
        WHERE id = ANY(:ids)
        """,
        {},
        build,
    )


def _load_oracle_passage_anchor(
    db: Session, items: list[ResourceRef], viewer_id: UUID
) -> list[ResolvedResource]:
    """Public-domain anchors are global; unresolved or stale ones fail closed."""

    def build(ref: ResourceRef, row: Any) -> ResolvedResource:
        body = str(row[4] or "")
        return ResolvedResource(
            uri=ref.uri,
            label=f"{row[2]} — {str(row[1] or '')}",
            summary=_first_line(body),
            body=body,
            title=str(row[2]),
        )

    return _load(
        db,
        items,
        """
        SELECT a.id, a.display_label, s.title, s.author_text,
               COALESCE(es.span_text, cc.chunk_text) AS body
        FROM oracle_passage_anchors a
        JOIN oracle_corpus_sources s ON s.id = a.corpus_source_id
        JOIN content_chunks cc ON cc.id = a.current_content_chunk_id
            AND cc.owner_kind = 'media' AND cc.owner_id = s.media_id
        LEFT JOIN evidence_spans es ON es.id = a.current_evidence_span_id
            AND es.owner_kind = 'media' AND es.owner_id = s.media_id
        WHERE a.id = ANY(:ids)
          AND a.resolution_status = 'resolved'
          AND (a.current_evidence_span_id IS NULL OR es.id IS NOT NULL)
        """,
        {},
        build,
    )


def _load_external_snapshot(
    db: Session, items: list[ResourceRef], viewer_id: UUID
) -> list[ResolvedResource]:
    def build(ref: ResourceRef, row: Any) -> ResolvedResource | None:
        if row[1] != viewer_id:
            return None
        body = str(row[3] or "")
        return ResolvedResource(
            uri=ref.uri,
            label=str(row[2]),
            summary=_first_line(body),
            body=body,
            title=str(row[2]),
        )

    return _load(
        db,
        items,
        "SELECT id, user_id, title, snippet FROM resource_external_snapshots WHERE id = ANY(:ids)",
        {},
        build,
    )


def _load_contributor(
    db: Session, items: list[ResourceRef], viewer_id: UUID
) -> list[ResolvedResource]:
    """Contributors are global identity rows; the display name is the whole label."""
    return _load(
        db,
        items,
        "SELECT id, display_name FROM contributors WHERE id = ANY(:ids)",
        {},
        lambda ref, row: ResolvedResource(
            uri=ref.uri, label=str(row[1]), summary="", title=str(row[1])
        ),
    )


def _load_podcast(db: Session, items: list[ResourceRef], viewer_id: UUID) -> list[ResolvedResource]:
    def build(ref: ResourceRef, row: Any) -> ResolvedResource:
        body = str(row[2]) if row[2] is not None else None
        return ResolvedResource(
            uri=ref.uri,
            label=str(row[1]),
            summary=_first_line(body or ""),
            body=body,
            title=str(row[1]),
        )

    return _load(
        db,
        items,
        f"SELECT p.id, p.title, p.description FROM podcasts p WHERE p.id = ANY(:ids) AND p.id IN ({visible_podcast_ids_cte_sql()})",
        {"viewer_id": viewer_id},
        build,
    )


def _load_reader_apparatus_item(
    db: Session, items: list[ResourceRef], viewer_id: UUID
) -> list[ResolvedResource]:
    def build(ref: ResourceRef, row: Any) -> ResolvedResource | None:
        if not can_read_media(db, viewer_id, row[1]):
            return None
        body = str(row[4] or "")
        source_label = str(row[5] or "")
        kind = str(row[2] or "")
        title = str(row[3] or row[2] or "Reader apparatus")
        return ResolvedResource(
            uri=ref.uri,
            label=title + (f" in {source_label}" if source_label else ""),
            summary=_first_line(body) or kind,
            inline_body=body if body and len(body) < INLINE_THRESHOLD_CHARS else None,
            fetch_hint=f'nexus__resource__read("{ref.uri}")',
            body=body,
            title=title,
        )

    return _load(
        db,
        items,
        """
        SELECT rai.id, rai.media_id, rai.kind, rai.label, rai.body_text, m.title
        FROM reader_apparatus_items rai
        JOIN reader_apparatus_states ras ON ras.id = rai.state_id
        JOIN media m ON m.id = rai.media_id
        WHERE rai.id = ANY(:ids)
          AND ras.status IN ('ready', 'partial')
          AND rai.locator IS NOT NULL
          AND rai.locator_status != 'missing'
        """,
        {},
        build,
    )


def _load_passage_anchor(
    db: Session, items: list[ResourceRef], viewer_id: UUID
) -> list[ResolvedResource]:
    """Passage anchors are user-owned; ``user_id`` equality is the whole gate, so an
    anchor survives as a Link endpoint even when its owner resource is gone."""

    def build(ref: ResourceRef, row: Any) -> ResolvedResource | None:
        if row[1] != viewer_id:
            return None
        selector = row[2] if isinstance(row[2], dict) else {}
        quote = selector.get("quote")
        exact = str(quote.get("exact") or "") if isinstance(quote, dict) else ""
        return _read(ref, label=_first_line(exact)[:120] or "Passage", body=exact)

    return _load(
        db,
        items,
        "SELECT id, user_id, selector FROM passage_anchors WHERE id = ANY(:ids)",
        {},
        build,
    )


_LOADERS: dict[
    ResourceScheme, Callable[[Session, list[ResourceRef], UUID], list[ResolvedResource]]
] = {
    "library": _load_library,
    "artifact": _load_artifact,
    "artifact_revision": _load_artifact_revision,
    "evidence_span": _load_evidence_span,
    "content_chunk": _load_content_chunk,
    "highlight": _load_highlight,
    "page": _load_page,
    "note_block": _load_note_block,
    "fragment": _load_fragment,
    "conversation": _load_conversation,
    "message": _load_message,
    "oracle_reading": _load_oracle_reading,
    "oracle_passage_anchor": _load_oracle_passage_anchor,
    "external_snapshot": _load_external_snapshot,
    "contributor": _load_contributor,
    "podcast": _load_podcast,
    "reader_apparatus_item": _load_reader_apparatus_item,
    "passage_anchor": _load_passage_anchor,
}
