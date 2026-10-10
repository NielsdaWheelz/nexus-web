"""Batch hydration of resource refs: one loader per scheme owns its SQL, its viewer gate
and its display strings. Each loader selects only the rows the viewer may see, so a
missing, forbidden or unknown ref hydrates as ``missing``; this layer never raises.
Writes reject invisible endpoints through :func:`assert_ref_visible`.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    highlight_readability_sql,
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

# The viewer gates, shared by the loaders and ``visible_ids`` so the two cannot drift.
_VISIBLE_MEDIA = f"({visible_media_ids_cte_sql()})"
# Evidence spans and content chunks belong to a visible media or to the viewer's note.
_OWNED_JOINS = """
    LEFT JOIN media m ON m.id = t.owner_id AND t.owner_kind = 'media'
    LEFT JOIN note_blocks nb ON nb.id = t.owner_id AND t.owner_kind = 'note_block'"""
_OWNED_GATE = f"""((t.owner_kind = 'media' AND t.owner_id IN {_VISIBLE_MEDIA})
    OR (t.owner_kind = 'note_block' AND nb.user_id = :viewer_id))"""
_FRAGMENT_GATE = f"t.media_id IN {_VISIBLE_MEDIA}"


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
    db: Session,
    *,
    viewer_id: UUID,
    refs: Sequence[ResourceRef],
    include_media_document_summary: bool = True,
) -> list[ResolvedResource]:
    loaded = load_resource_batch(
        db,
        refs,
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
    out = {
        ref.uri: ResolvedResource(ref.uri, "(resource unavailable)", "", missing=True)
        for ref in refs
    }
    for scheme in dict.fromkeys(ref.scheme for ref in refs):
        group = {ref.id: ref for ref in refs if ref.scheme == scheme}
        ids = list(group)
        if scheme == "media":
            found = _media(db, ids, viewer_id, include_media_document_summary)
        elif scheme == "library":
            found = _library(db, ids, viewer_id)
        elif scheme == "highlight":
            found = _highlight(db, ids, viewer_id)
        elif scheme == "artifact" or scheme == "artifact_revision":
            found = _dossiers(db, scheme, ids, viewer_id)
        else:
            sql, build = _LOADERS[scheme]
            rows = db.execute(text(sql), {"ids": ids, "viewer_id": viewer_id})
            found = [build(group[row.id], row) for row in rows]
        out.update({item.uri: item for item in found})
    return out


def visible_ids(
    db: Session,
    *,
    viewer_id: UUID,
    scheme: Literal["fragment", "evidence_span", "content_chunk"],
    ids: Sequence[UUID],
) -> set[UUID]:
    """The supplied ids the viewer can read, under the loader's own gate."""
    if not ids:
        return set()
    if scheme == "fragment":
        sql = f"SELECT t.id FROM fragments t WHERE t.id = ANY(:ids) AND {_FRAGMENT_GATE}"
    else:
        table = "evidence_spans" if scheme == "evidence_span" else "content_chunks"
        sql = f"SELECT t.id FROM {table} t {_OWNED_JOINS} WHERE t.id = ANY(:ids) AND {_OWNED_GATE}"
    return set(db.scalars(text(sql), {"ids": list(set(ids)), "viewer_id": viewer_id}))


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


def oracle_anchor_current_target(db: Session, anchor_id: UUID) -> ResourceRef | None:
    """The span (else chunk) a resolved Oracle passage anchor points at. ``None`` when it
    is unresolved or a reindex cleared its pointers: the citation then fails closed."""
    row = db.execute(
        text(
            "SELECT current_evidence_span_id, current_content_chunk_id"
            " FROM oracle_passage_anchors WHERE id = :id AND resolution_status = 'resolved'"
        ),
        {"id": anchor_id},
    ).first()
    if row is None or (row[0] is None and row[1] is None):
        return None
    if row[0] is not None:
        return ResourceRef("evidence_span", row[0])
    return ResourceRef("content_chunk", row[1])


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


def _media(
    db: Session, ids: list[UUID], viewer_id: UUID, document_summary: bool
) -> list[ResolvedResource]:
    rows = db.execute(
        text(f"""
        SELECT m.id, m.title, m.kind, {media_author_names_agg_sql()}
        FROM media m {media_author_credits_join_sql()}
        WHERE m.id = ANY(:ids) AND m.id IN {_VISIBLE_MEDIA}
        GROUP BY m.id, m.title, m.kind
        """),
        {"ids": ids, "viewer_id": viewer_id},
    )
    out = []
    for row in rows:
        uri = f"media:{row.id}"
        kind = row.kind
        parts = [kind]
        document = load_media_document_summary(db, viewer_id, row.id) if document_summary else None
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
        FROM libraries l
        WHERE l.id = ANY(:ids) AND EXISTS (
            SELECT 1 FROM memberships ms WHERE ms.library_id = l.id AND ms.user_id = :viewer_id
        )
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
            count = library_entry_listing.count_default_root_inventory(
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
        WHERE h.id = ANY(:ids) AND {highlight_readability_sql("h")}
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


def _dossiers(
    db: Session, scheme: ResourceScheme, ids: list[UUID], viewer_id: UUID
) -> list[ResolvedResource]:
    """An artifact and an artifact revision both read their head row; the subject title
    covers every persisted subject scheme, ``idea`` included."""
    from nexus.services.dossier.subjects import head_visible_sql  # dossier imports the graph

    key = "id" if scheme == "artifact" else "revision_id"
    rows = db.execute(
        text(f"""
        SELECT a.{key} AS id, a.subject_scheme, a.subject_id, a.content_text,
            COALESCE(
                m.title, c.title, CASE WHEN l.is_default THEN 'All' ELSE l.name END,
                p.title, co.display_name, pg.title,
                CASE WHEN nb.id IS NOT NULL THEN 'Note' END, idea.display_title
            ) AS subject_title
        FROM artifacts a
        LEFT JOIN media m ON a.subject_scheme = 'media' AND m.id = a.subject_id
        LEFT JOIN conversations c ON a.subject_scheme = 'conversation' AND c.id = a.subject_id
        LEFT JOIN libraries l ON a.subject_scheme = 'library' AND l.id = a.subject_id
        LEFT JOIN podcasts p ON a.subject_scheme = 'podcast' AND p.id = a.subject_id
        LEFT JOIN contributors co ON a.subject_scheme = 'contributor' AND co.id = a.subject_id
        LEFT JOIN pages pg ON a.subject_scheme = 'page' AND pg.id = a.subject_id
        LEFT JOIN note_blocks nb ON a.subject_scheme = 'note_block' AND nb.id = a.subject_id
        LEFT JOIN artifact_idea_subjects idea
            ON a.subject_scheme = 'idea' AND idea.id = a.subject_id
        WHERE a.{key} = ANY(:ids) AND {head_visible_sql("a")}
        """),
        {"ids": ids, "viewer_id": viewer_id},
    ).all()
    out = []
    for row in rows:
        uri = f"{scheme}:{row.id}"
        subject = str(row.subject_title or "Dossier")
        body = row.content_text
        search = (
            f'; nexus__search(scopes=["library:{row.subject_id}"], query=...) to search the library'
            if row.subject_scheme == "library"
            else ""
        )
        label = "Dossier" if scheme == "artifact" else "Dossier revision"
        out.append(
            ResolvedResource(
                uri,
                f"{label} — {subject}",
                _first_line(body or "") or f"Dossier for {subject}",
                inline_body=body if body and len(body) < INLINE_THRESHOLD_CHARS else None,
                fetch_hint=f'nexus__resource__read("{uri}") for the full synthesis{search}',
                body=body,
                title=subject,
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
        FROM {table} t {_OWNED_JOINS}
        WHERE t.id = ANY(:ids) AND {_OWNED_GATE}
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


# scheme -> (SQL over :ids and :viewer_id selecting only visible rows, build).
_LOADERS: dict[str, tuple[str, Callable[[ResourceRef, Any], ResolvedResource]]] = {
    "evidence_span": (
        _owned_text_sql("evidence_spans", "span_text", "t.citation_label"),
        _owned_text,
    ),
    "content_chunk": (_owned_text_sql("content_chunks", "chunk_text", "NULL"), _owned_text),
    "page": (
        "SELECT id, title FROM pages WHERE id = ANY(:ids) AND user_id = :viewer_id",
        _page,
    ),
    "note_block": (
        """SELECT id, body_text AS body FROM note_blocks
        WHERE id = ANY(:ids) AND user_id = :viewer_id""",
        lambda ref, row: _read(ref, _first_line(row.body)[:120] or "Note", row.body),
    ),
    "fragment": (
        f"""SELECT t.id, t.idx, t.canonical_text AS body, m.title
        FROM fragments t JOIN media m ON m.id = t.media_id
        WHERE t.id = ANY(:ids) AND {_FRAGMENT_GATE}""",
        lambda ref, row: _read(
            ref, f"{row.title} — fragment {row.idx + 1}", row.body, str(row.title)
        ),
    ),
    "conversation": (
        """SELECT c.id, c.title,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
        FROM conversations c WHERE c.id = ANY(:ids) AND c.owner_user_id = :viewer_id""",
        _conversation,
    ),
    "message": (
        """SELECT m.id, m.role, m.content AS body FROM messages m
        JOIN conversations c ON c.id = m.conversation_id AND c.owner_user_id = :viewer_id
        WHERE m.id = ANY(:ids) AND m.status != 'pending'""",
        lambda ref, row: _read(ref, f"{row.role}: {row.body[:40]}".strip(), row.body),
    ),
    "oracle_reading": (
        """SELECT id, question_text, folio_theme, folio_motto, folio_motto_gloss,
            argument_text, interpretation_text
        FROM oracle_readings WHERE id = ANY(:ids) AND user_id = :viewer_id""",
        _oracle_reading,
    ),
    "oracle_passage_anchor": (
        # Public-domain anchors are global; unresolved or stale ones fail closed.
        """SELECT a.id, a.display_label, s.title,
            COALESCE(es.span_text, cc.chunk_text) AS body
        FROM oracle_passage_anchors a
        JOIN oracle_corpus_sources s ON s.id = a.corpus_source_id
        JOIN content_chunks cc ON cc.id = a.current_content_chunk_id
            AND cc.owner_kind = 'media' AND cc.owner_id = s.media_id
        LEFT JOIN evidence_spans es ON es.id = a.current_evidence_span_id
            AND es.owner_kind = 'media' AND es.owner_id = s.media_id
        WHERE a.id = ANY(:ids) AND a.resolution_status = 'resolved'
            AND (a.current_evidence_span_id IS NULL OR es.id IS NOT NULL)""",
        lambda ref, row: ResolvedResource(
            ref.uri,
            f"{row.title} — {row.display_label}",
            _first_line(row.body),
            body=row.body,
            title=str(row.title),
        ),
    ),
    "external_snapshot": (
        """SELECT id, title, snippet AS body FROM resource_external_snapshots
        WHERE id = ANY(:ids) AND user_id = :viewer_id""",
        lambda ref, row: _plain(ref, str(row.title), _first_line(row.body), row.body),
    ),
    "contributor": (
        # Contributors are global identity rows; the display name is the whole label.
        "SELECT id, display_name FROM contributors WHERE id = ANY(:ids)",
        lambda ref, row: _plain(ref, str(row.display_name), ""),
    ),
    "podcast": (
        f"""SELECT id, title, description FROM podcasts
        WHERE id = ANY(:ids) AND id IN ({visible_podcast_ids_cte_sql()})""",
        lambda ref, row: _plain(
            ref, str(row.title), _first_line(row.description or ""), row.description
        ),
    ),
    "reader_apparatus_item": (
        f"""SELECT rai.id, rai.kind, rai.label, COALESCE(rai.body_text, '') AS body,
            m.title AS media_title
        FROM reader_apparatus_items rai
        JOIN reader_apparatus_states ras ON ras.id = rai.state_id
        JOIN media m ON m.id = rai.media_id
        WHERE rai.id = ANY(:ids) AND ras.status IN ('ready', 'partial')
            AND rai.locator IS NOT NULL AND rai.locator_status != 'missing'
            AND rai.media_id IN {_VISIBLE_MEDIA}""",
        _apparatus,
    ),
    "passage_anchor": (
        # The viewer's own anchor: it survives its owner resource's death.
        """SELECT id, COALESCE(selector #>> '{quote,exact}', '') AS exact
        FROM passage_anchors WHERE id = ANY(:ids) AND user_id = :viewer_id""",
        lambda ref, row: _read(ref, _first_line(row.exact)[:120] or "Passage", row.exact),
    ),
}
