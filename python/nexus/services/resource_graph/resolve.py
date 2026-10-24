"""Prompt and read bodies of resource refs: one loader per scheme owns its SQL and its
display strings. Visibility is the item gate's (``items.visible_refs``): a loader reads
only refs it admitted, so a missing, forbidden or unknown ref hydrates as ``missing``
and this layer never raises. Writes reject invisible endpoints through
:func:`assert_ref_visible`.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, NotFoundError
from nexus.services import library_entries, library_listing
from nexus.services.contributor_credits import (
    media_author_credits_join_sql,
    media_author_names_agg_sql,
)
from nexus.services.media_read_map import load_media_document_summary
from nexus.services.resource_graph.highlight_notes import linked_note_blocks_for_highlights
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_items.items import visible_refs

INLINE_THRESHOLD_CHARS = 1500


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
    body: str | None = None
    title: str | None = None


def resolve_ref(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> ResolvedResource:
    return resolve_refs(db, viewer_id=viewer_id, refs=[ref])[0]


def resolve_refs(
    db: Session, *, viewer_id: UUID, refs: Sequence[ResourceRef]
) -> list[ResolvedResource]:
    loaded = load_resource_batch(db, refs, viewer_id=viewer_id)
    return [loaded[ref.uri] for ref in refs]


def assert_ref_visible(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> None:
    """Raise ``NotFoundError`` unless the viewer may see ``ref`` (the item gate)."""
    if ref.uri not in visible_refs(db, viewer_id=viewer_id, refs=[ref]):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")


def load_resource_batch(
    db: Session, refs: Sequence[ResourceRef], *, viewer_id: UUID
) -> dict[str, ResolvedResource]:
    """Hydrate each visible ref through its scheme's loader, keyed by ``ref.uri``."""
    out = {
        ref.uri: ResolvedResource(ref.uri, "(resource unavailable)", "", missing=True)
        for ref in refs
    }
    visible = visible_refs(db, viewer_id=viewer_id, refs=refs)
    for scheme in dict.fromkeys(ref.scheme for ref in refs):
        group = {ref.id: ref for ref in refs if ref.scheme == scheme and ref.uri in visible}
        if not group:
            continue
        ids = list(group)
        if scheme == "media":
            found = _media(db, ids, viewer_id)
        elif scheme == "library":
            found = _library(db, ids, viewer_id)
        elif scheme == "highlight":
            found = _highlight(db, ids, viewer_id)
        else:
            sql, build = _LOADERS[scheme]
            rows = db.execute(text(sql), {"ids": ids, "viewer_id": viewer_id})
            found = [build(group[row.id], row) for row in rows]
        out.update({item.uri: item for item in found})
    return out


def parent_media_id_for_read_pointer(
    db: Session, *, scheme: ResourceScheme, resource_id: UUID
) -> UUID | None:
    """The parent media of a fragment, or of a media-owned evidence span or chunk; a
    note-owned row has none."""
    sql = {
        "fragment": "SELECT media_id FROM fragments WHERE id = :id",
        "evidence_span": "SELECT owner_id FROM evidence_spans"
        " WHERE id = :id AND owner_kind = 'media'",
        "content_chunk": "SELECT owner_id FROM content_chunks"
        " WHERE id = :id AND owner_kind = 'media'",
    }.get(scheme)
    return None if sql is None else db.scalar(text(sql), {"id": resource_id})


def _first_line(body: str) -> str:
    return next((line.strip()[:200] for line in body.splitlines() if line.strip()), "")


def _read(ref: ResourceRef, label: str, body: str, title: str | None = None) -> ResolvedResource:
    """A body-bearing scheme: first line as summary, body inlined under the threshold."""
    return ResolvedResource(
        ref.uri,
        label,
        _first_line(body),
        inline_body=body if len(body) < INLINE_THRESHOLD_CHARS else None,
        fetch_hint=f'nexus__resource__read("{ref.uri}")',
        body=body,
        title=title,
    )


def _media(db: Session, ids: list[UUID], viewer_id: UUID) -> list[ResolvedResource]:
    rows = db.execute(
        text(f"""
        SELECT m.id, m.title, m.kind, {media_author_names_agg_sql()}
        FROM media m {media_author_credits_join_sql()}
        WHERE m.id = ANY(:ids)
        GROUP BY m.id, m.title, m.kind
        """),
        {"ids": ids, "viewer_id": viewer_id},
    )
    out = []
    for row in rows:
        uri = f"media:{row.id}"
        kind = row.kind
        parts = [kind]
        document = load_media_document_summary(db, viewer_id, row.id)
        if document is not None and document.word_count:
            parts.append(f"~{document.word_count:,} words")
        if document is not None and document.section_count:
            parts.append(f"{document.section_count} {'pages' if kind == 'pdf' else 'sections'}")
        out.append(
            ResolvedResource(
                uri,
                f"{row.title} by {row.authors}" if row.authors else str(row.title),
                " · ".join(parts),
                fetch_hint=(
                    f'nexus__resource__inspect("{uri}") to map; '
                    f'nexus__resource__read("{uri}") to read; '
                    f'nexus__search(scopes=["{uri}"], query=...) to search'
                ),
                title=str(row.title),
            )
        )
    return out


def _library(db: Session, ids: list[UUID], viewer_id: UUID) -> list[ResolvedResource]:
    rows = db.execute(
        text("""
        SELECT l.id, l.name, l.is_default, l.owner_user_id = :viewer_id AS own
        FROM libraries l WHERE l.id = ANY(:ids)
        """),
        {"ids": ids, "viewer_id": viewer_id},
    ).all()
    # Only the viewer's own Default counts its virtual root inventory; it presents as "All".
    counts = library_entries.count_entries_by_library(
        db, [row.id for row in rows if not (row.is_default and row.own)]
    )
    out = []
    for row in rows:
        if row.is_default and row.own:
            count = library_listing.count_default_root_inventory(
                db, viewer_id=viewer_id, library_id=row.id
            )
        else:
            count = counts.get(row.id, 0)
        name = "All" if row.is_default else str(row.name)
        uri = f"library:{row.id}"
        out.append(
            ResolvedResource(
                uri,
                name,
                f"{name} ({count} items)" if count else name,
                fetch_hint=f'nexus__search(scopes=["{uri}"], query=...)',
                title=name,
            )
        )
    return out


def _highlight(db: Session, ids: list[UUID], viewer_id: UUID) -> list[ResolvedResource]:
    rows = db.execute(
        text(f"""
        SELECT h.id, h.exact, h.prefix, h.suffix, m.title, {media_author_names_agg_sql()}
        FROM highlights h JOIN media m ON m.id = h.anchor_media_id
        {media_author_credits_join_sql()}
        WHERE h.id = ANY(:ids)
        GROUP BY h.id, h.exact, h.prefix, h.suffix, m.title
        """),
        {"ids": ids, "viewer_id": viewer_id},
    ).all()
    notes = linked_note_blocks_for_highlights(db, viewer_id, [row.id for row in rows])
    out = []
    for row in rows:
        source = f"“{row.title}” by {row.authors}" if row.authors else f"“{row.title}”"
        quote = ResolvedQuote(
            exact=str(row.exact or ""),
            prefix=str(row.prefix or ""),
            suffix=str(row.suffix or ""),
            source_label=source,
            note="\n\n".join(b.body_text for b in notes.get(row.id, []) if b.body_text) or None,
        )
        uri = f"highlight:{row.id}"
        out.append(
            ResolvedResource(
                uri,
                f"Highlight in {source}",
                quote.exact,
                fetch_hint=f'nexus__resource__read("{uri}")',
                quote=quote,
            )
        )
    return out


def _owned_text(ref: ResourceRef, row: Any) -> ResolvedResource:
    """A span is labelled by its work and what tells it apart: its citation label, else
    its first line that is not the work's title. A chunk by its work and first line."""
    title = str(row.title) if row.owner_kind == "media" else "Note"
    passage = row.citation_label
    if ref.scheme == "content_chunk":
        label = f"{title} - chunk: {_first_line(row.body)[:80]}"
    elif passage and passage != title:
        label = f"{title} - {passage}"
    else:
        lines = (line.strip() for line in row.body.splitlines())
        distinct = next((line for line in lines if line and line != title), "")
        label = f"{title} - {distinct[:80]}" if distinct else title
    return _read(ref, label, row.body, title)


def _owned_text_sql(table: str, body: str, citation_label: str) -> str:
    return f"""
        SELECT t.id, t.owner_kind, t.{body} AS body,
            {citation_label} AS citation_label, m.title
        FROM {table} t LEFT JOIN media m ON m.id = t.owner_id AND t.owner_kind = 'media'
        WHERE t.id = ANY(:ids)
    """


def _plain(ref: ResourceRef, label: str, summary: str, body: str | None = None) -> ResolvedResource:
    """A scheme the read tool reads by body only, titled by its label."""
    return ResolvedResource(ref.uri, label, summary, body=body, title=label)


def _page(ref: ResourceRef, row: Any) -> ResolvedResource:
    title = str(row.title)
    return ResolvedResource(
        ref.uri,
        title,
        title,
        inline_body=title,
        fetch_hint=f'nexus__resource__read("{ref.uri}")',
        body=title,
        title=title,
    )


def _conversation(ref: ResourceRef, row: Any) -> ResolvedResource:
    title = str(row.title or "").strip() or "Untitled conversation"
    return ResolvedResource(
        ref.uri,
        title,
        f"Chat history with {row.message_count} messages.",
        fetch_hint=f'nexus__resource__read("{ref.uri}")',
        title=title,
    )


def _oracle_reading(ref: ResourceRef, row: Any) -> ResolvedResource:
    """The readable reading; its folio passages live on its citation edges."""
    question = str(row.question_text)
    lines = [f"Question: {question}"]
    if row.folio_motto:
        gloss = f" — {row.folio_motto_gloss}" if row.folio_motto_gloss else ""
        lines.append(f"Motto: {row.folio_motto}{gloss}")
    if row.argument_text:
        lines.append(f"Argument: {row.argument_text}")
    if row.interpretation_text:
        lines.append(f"\nInterpretation:\n{row.interpretation_text}")
    return ResolvedResource(
        ref.uri,
        f"Oracle reading: {_first_line(question)[:80]}",
        str(row.folio_theme) if row.folio_theme is not None else "",
        body="\n".join(lines),
        title=question,
    )


def _apparatus(ref: ResourceRef, row: Any) -> ResolvedResource:
    title = row.label or row.kind
    source = row.media_title
    return ResolvedResource(
        ref.uri,
        title + (f" in {source}" if source else ""),
        _first_line(row.body) or row.kind,
        inline_body=row.body if row.body and len(row.body) < INLINE_THRESHOLD_CHARS else None,
        fetch_hint=f'nexus__resource__read("{ref.uri}")',
        body=row.body,
        title=title,
    )


# scheme -> (SQL over refs the item gate admitted, build); loaders hold no viewer predicate.
_LOADERS: dict[str, tuple[str, Callable[[ResourceRef, Any], ResolvedResource]]] = {
    "evidence_span": (
        _owned_text_sql("evidence_spans", "span_text", "t.citation_label"),
        _owned_text,
    ),
    "content_chunk": (_owned_text_sql("content_chunks", "chunk_text", "NULL"), _owned_text),
    "page": (
        "SELECT id, title FROM pages WHERE id = ANY(:ids)",
        _page,
    ),
    "note_block": (
        "SELECT id, body_text AS body FROM note_blocks WHERE id = ANY(:ids)",
        lambda ref, row: _read(ref, _first_line(row.body)[:120] or "Note", row.body),
    ),
    "fragment": (
        """SELECT t.id, t.idx, t.canonical_text AS body, m.title
        FROM fragments t JOIN media m ON m.id = t.media_id
        WHERE t.id = ANY(:ids)""",
        lambda ref, row: _read(
            ref, f"{row.title} — fragment {row.idx + 1}", row.body, str(row.title)
        ),
    ),
    "conversation": (
        """SELECT c.id, c.title,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
        FROM conversations c WHERE c.id = ANY(:ids)""",
        _conversation,
    ),
    "message": (
        "SELECT id, role, content AS body FROM messages WHERE id = ANY(:ids)",
        lambda ref, row: _read(ref, f"{row.role}: {row.body[:40]}".strip(), row.body),
    ),
    "oracle_reading": (
        """SELECT id, question_text, folio_theme, folio_motto, folio_motto_gloss,
            argument_text, interpretation_text
        FROM oracle_readings WHERE id = ANY(:ids)""",
        _oracle_reading,
    ),
    "oracle_passage_anchor": (
        # An anchor reads its current span or chunk, else its frozen quote (Q3).
        """SELECT a.id, a.display_label, s.title,
            COALESCE(es.span_text, cc.chunk_text, a.quote) AS body
        FROM oracle_passage_anchors a
        JOIN oracle_corpus_sources s ON s.id = a.corpus_source_id
        LEFT JOIN content_chunks cc ON cc.id = a.current_content_chunk_id
            AND a.resolution_status = 'resolved' AND cc.owner_id = s.media_id
        LEFT JOIN evidence_spans es ON es.id = a.current_evidence_span_id
            AND a.resolution_status = 'resolved' AND es.owner_id = s.media_id
        WHERE a.id = ANY(:ids)""",
        lambda ref, row: ResolvedResource(
            ref.uri,
            f"{row.title} — {row.display_label}",
            _first_line(row.body),
            body=row.body,
            title=str(row.title),
        ),
    ),
    "external_snapshot": (
        "SELECT id, title, snippet AS body FROM resource_external_snapshots WHERE id = ANY(:ids)",
        lambda ref, row: _plain(ref, str(row.title), _first_line(row.body), row.body),
    ),
    "contributor": (
        "SELECT id, display_name FROM contributors WHERE id = ANY(:ids)",
        lambda ref, row: _plain(ref, str(row.display_name), ""),
    ),
    "podcast": (
        "SELECT id, title, description FROM podcasts WHERE id = ANY(:ids)",
        lambda ref, row: _plain(
            ref, str(row.title), _first_line(row.description or ""), row.description
        ),
    ),
    "reader_apparatus_item": (
        """SELECT rai.id, rai.kind, rai.label, COALESCE(rai.body_text, '') AS body,
            m.title AS media_title
        FROM reader_apparatus_items rai JOIN media m ON m.id = rai.media_id
        WHERE rai.id = ANY(:ids)""",
        _apparatus,
    ),
    "passage_anchor": (
        """SELECT id, COALESCE(selector #>> '{quote,exact}', '') AS exact
        FROM passage_anchors WHERE id = ANY(:ids)""",
        lambda ref, row: _read(ref, _first_line(row.exact)[:120] or "Passage", row.exact),
    ),
}
