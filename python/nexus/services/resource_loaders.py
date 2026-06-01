"""Single per-scheme data-access layer for conversation-reference resources.

``load_resource_batch`` is the one place that issues SQL and runs a permission
check for each URI scheme. ``resource_resolver`` (prompt-assembly presentation)
and ``agent_tools.read_resource`` (the model's read tool) both consume it, so a
scheme's read path exists exactly once — the divergence that let a highlight
reach the model as its bare ``exact`` word lived in two copies before this.

Missing or forbidden URIs return ``LoadedResource(missing=True)``; this layer
never raises (errors.md).
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_conversation,
    can_read_highlight,
    can_read_media,
    is_library_member,
)
from nexus.services.media_document_map import load_media_document_summary
from nexus.services.notes import linked_note_blocks_for_highlights

if TYPE_CHECKING:
    from nexus.services.resource_resolver import ParsedResourceUri, ResourceUriScheme

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
    scheme: ResourceUriScheme
    missing: bool = False
    body: str | None = None  # span/chunk/page/note_block/fragment/message text
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


def load_resource_batch(
    db: Session,
    parsed: list[ParsedResourceUri],
    *,
    viewer_id: UUID,
) -> dict[str, LoadedResource]:
    by_scheme: dict[str, list[ParsedResourceUri]] = defaultdict(list)
    for p in parsed:
        by_scheme[p.scheme].append(p)

    out: dict[str, LoadedResource] = {}
    for scheme, items in by_scheme.items():
        if scheme == "media":
            loaded = _load_media(db, items, viewer_id=viewer_id)
        elif scheme == "library":
            loaded = _load_library(db, items, viewer_id=viewer_id)
        elif scheme == "span":
            loaded = _load_span(db, items, viewer_id=viewer_id)
        elif scheme == "chunk":
            loaded = _load_chunk(db, items, viewer_id=viewer_id)
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
        else:
            raise AssertionError(f"Unhandled resource URI scheme: {scheme}")
        for entry in loaded:
            out[entry.uri] = entry
    return out


def _missing(uri: str, scheme: ResourceUriScheme) -> LoadedResource:
    return LoadedResource(uri=uri, scheme=scheme, missing=True)


def parent_media_id_for_read_pointer(db: Session, *, scheme: str, resource_id: UUID) -> UUID | None:
    """Return the parent media id for media-derived read pointers."""
    table = {"fragment": "fragments", "span": "evidence_spans", "chunk": "content_chunks"}.get(
        scheme
    )
    if table is None:
        return None
    return db.scalar(text(f"SELECT media_id FROM {table} WHERE id = :id"), {"id": resource_id})


def _load_media(
    db: Session, items: list[ParsedResourceUri], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [p.resource_id for p in items]
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
    for p in items:
        row = by_id.get(p.resource_id)
        if row is None or not can_read_media(db, viewer_id, p.resource_id):
            out.append(_missing(p.raw, "media"))
            continue
        kind = str(row[2])
        summary = load_media_document_summary(db, viewer_id, p.resource_id)
        out.append(
            LoadedResource(
                uri=p.raw,
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
    db: Session, items: list[ParsedResourceUri], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [p.resource_id for p in items]
    rows = db.execute(
        text(
            """
            SELECT l.id, l.name,
                   (SELECT COUNT(*) FROM library_entries le WHERE le.library_id = l.id) AS item_count
            FROM libraries l
            WHERE l.id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for p in items:
        row = by_id.get(p.resource_id)
        if row is None or not is_library_member(db, viewer_id, p.resource_id):
            out.append(_missing(p.raw, "library"))
            continue
        out.append(
            LoadedResource(
                uri=p.raw, scheme="library", title=str(row[1]), item_count=int(row[2] or 0)
            )
        )
    return out


def _load_span(
    db: Session, items: list[ParsedResourceUri], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [p.resource_id for p in items]
    rows = db.execute(
        text(
            """
            SELECT es.id, es.media_id, es.span_text, es.citation_label, m.title
            FROM evidence_spans es
            JOIN media m ON m.id = es.media_id
            WHERE es.id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for p in items:
        row = by_id.get(p.resource_id)
        if row is None or not can_read_media(db, viewer_id, row[1]):
            out.append(_missing(p.raw, "span"))
            continue
        out.append(
            LoadedResource(
                uri=p.raw,
                scheme="span",
                body=str(row[2] or ""),
                title=str(row[4]),
                citation_label=str(row[3] or ""),
            )
        )
    return out


def _load_chunk(
    db: Session, items: list[ParsedResourceUri], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [p.resource_id for p in items]
    rows = db.execute(
        text(
            """
            SELECT cc.id, cc.media_id, cc.chunk_text, m.title
            FROM content_chunks cc
            JOIN media m ON m.id = cc.media_id
            WHERE cc.id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for p in items:
        row = by_id.get(p.resource_id)
        if row is None or not can_read_media(db, viewer_id, row[1]):
            out.append(_missing(p.raw, "chunk"))
            continue
        out.append(
            LoadedResource(uri=p.raw, scheme="chunk", body=str(row[2] or ""), title=str(row[3]))
        )
    return out


def _load_highlight(
    db: Session, items: list[ParsedResourceUri], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [p.resource_id for p in items]
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
        p.resource_id
        for p in items
        if p.resource_id in by_id and can_read_highlight(db, viewer_id, p.resource_id)
    }
    notes = linked_note_blocks_for_highlights(db, viewer_id, list(visible))
    out: list[LoadedResource] = []
    for p in items:
        if p.resource_id not in visible:
            out.append(_missing(p.raw, "highlight"))
            continue
        row = by_id[p.resource_id]
        title = str(row[4])
        authors = str(row[5])
        source_label = f"“{title}” by {authors}" if authors else f"“{title}”"
        blocks = notes.get(p.resource_id, [])
        note = "\n\n".join(b.body_text for b in blocks if b.body_text) or None
        out.append(
            LoadedResource(
                uri=p.raw,
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


def _load_page(
    db: Session, items: list[ParsedResourceUri], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [p.resource_id for p in items]
    rows = db.execute(
        text("SELECT id, user_id, title, description FROM pages WHERE id = ANY(:ids)"),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for p in items:
        row = by_id.get(p.resource_id)
        if row is None or row[1] != viewer_id:
            out.append(_missing(p.raw, "page"))
            continue
        out.append(
            LoadedResource(uri=p.raw, scheme="page", body=str(row[3] or ""), title=str(row[2]))
        )
    return out


def _load_note_block(
    db: Session, items: list[ParsedResourceUri], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [p.resource_id for p in items]
    rows = db.execute(
        text("SELECT id, user_id, body_text FROM note_blocks WHERE id = ANY(:ids)"),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[LoadedResource] = []
    for p in items:
        row = by_id.get(p.resource_id)
        if row is None or row[1] != viewer_id:
            out.append(_missing(p.raw, "note_block"))
            continue
        out.append(LoadedResource(uri=p.raw, scheme="note_block", body=str(row[2] or "")))
    return out


def _load_fragment(
    db: Session, items: list[ParsedResourceUri], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [p.resource_id for p in items]
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
    for p in items:
        row = by_id.get(p.resource_id)
        if row is None or not can_read_media(db, viewer_id, row[1]):
            out.append(_missing(p.raw, "fragment"))
            continue
        out.append(
            LoadedResource(
                uri=p.raw,
                scheme="fragment",
                body=str(row[3] or ""),
                title=str(row[4]),
                fragment_idx=int(row[2]),
            )
        )
    return out


def _load_conversation(
    db: Session, items: list[ParsedResourceUri], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [p.resource_id for p in items]
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
    for p in items:
        row = by_id.get(p.resource_id)
        if row is None or not can_read_conversation(db, viewer_id, p.resource_id):
            out.append(_missing(p.raw, "conversation"))
            continue
        title = str(row[1] or "").strip() or "Untitled conversation"
        out.append(
            LoadedResource(
                uri=p.raw, scheme="conversation", title=title, message_count=int(row[2] or 0)
            )
        )
    return out


def _load_message(
    db: Session, items: list[ParsedResourceUri], *, viewer_id: UUID
) -> list[LoadedResource]:
    ids = [p.resource_id for p in items]
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
    for p in items:
        row = by_id.get(p.resource_id)
        if row is None or not can_read_conversation(db, viewer_id, row[1]):
            out.append(_missing(p.raw, "message"))
            continue
        out.append(
            LoadedResource(
                uri=p.raw, scheme="message", body=str(row[3] or ""), message_role=str(row[2])
            )
        )
    return out
