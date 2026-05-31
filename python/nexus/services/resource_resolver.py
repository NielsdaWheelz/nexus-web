"""URI-based resource resolver for conversation references.

Resolves opaque `<scheme>:<uuid>` URIs to label/summary/inline-body blocks
used by prompt assembly. Permission checks delegate to existing helpers in
``nexus.auth.permissions``. Unknown, missing, or forbidden URIs return a
``missing=True`` block rather than raising.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_conversation,
    can_read_highlight,
    can_read_media,
    is_library_member,
)

INLINE_THRESHOLD_CHARS = 1500
ResourceUriScheme = Literal[
    "media",
    "library",
    "span",
    "chunk",
    "highlight",
    "page",
    "note_block",
    "fragment",
    "conversation",
    "message",
]
RESOURCE_URI_SCHEMES: tuple[ResourceUriScheme, ...] = (
    "media",
    "library",
    "span",
    "chunk",
    "highlight",
    "page",
    "note_block",
    "fragment",
    "conversation",
    "message",
)
SEARCH_SCOPE_RESOURCE_URI_SCHEMES: tuple[ResourceUriScheme, ...] = ("media", "library")
READABLE_RESOURCE_URI_SCHEMES: tuple[ResourceUriScheme, ...] = tuple(
    scheme for scheme in RESOURCE_URI_SCHEMES if scheme not in SEARCH_SCOPE_RESOURCE_URI_SCHEMES
)


@dataclass(frozen=True)
class ParsedResourceUri:
    raw: str
    scheme: ResourceUriScheme
    resource_id: UUID


@dataclass(frozen=True)
class ResourceUriParseFailure:
    raw: str
    reason: Literal["invalid_format", "unsupported_scheme"]


@dataclass(frozen=True)
class ResolvedResource:
    uri: str
    label: str
    summary: str
    inline_body: str | None
    fetch_hint: str
    missing: bool = False


def parse_resource_uri(raw: str) -> ParsedResourceUri | ResourceUriParseFailure:
    scheme, sep, ident = raw.partition(":")
    if not sep:
        return ResourceUriParseFailure(raw=raw, reason="invalid_format")
    if scheme not in RESOURCE_URI_SCHEMES:
        return ResourceUriParseFailure(raw=raw, reason="unsupported_scheme")
    try:
        resource_id = UUID(ident)
    except ValueError:
        return ResourceUriParseFailure(raw=raw, reason="invalid_format")
    if str(resource_id) != ident:
        return ResourceUriParseFailure(raw=raw, reason="invalid_format")
    return ParsedResourceUri(
        raw=raw,
        scheme=cast(ResourceUriScheme, scheme),
        resource_id=resource_id,
    )


def format_resource_uri(scheme: ResourceUriScheme, resource_id: UUID) -> str:
    return f"{scheme}:{resource_id}"


def resolve(db: Session, uri: str, *, viewer_id: UUID) -> ResolvedResource:
    return resolve_batch(db, [uri], viewer_id=viewer_id)[0]


def resolve_batch(
    db: Session,
    uris: Sequence[str],
    *,
    viewer_id: UUID,
) -> list[ResolvedResource]:
    by_scheme: dict[str, list[tuple[str, UUID]]] = defaultdict(list)
    results: dict[str, ResolvedResource] = {}
    for uri in uris:
        if uri in results:
            continue
        parsed = parse_resource_uri(uri)
        if isinstance(parsed, ResourceUriParseFailure):
            results[uri] = _missing(uri)
            continue
        by_scheme[parsed.scheme].append((uri, parsed.resource_id))

    for scheme, items in by_scheme.items():
        if scheme == "media":
            resolved = _resolve_media_batch(db, items, viewer_id=viewer_id)
        elif scheme == "library":
            resolved = _resolve_library_batch(db, items, viewer_id=viewer_id)
        elif scheme == "span":
            resolved = _resolve_span_batch(db, items, viewer_id=viewer_id)
        elif scheme == "chunk":
            resolved = _resolve_chunk_batch(db, items, viewer_id=viewer_id)
        elif scheme == "highlight":
            resolved = _resolve_highlight_batch(db, items, viewer_id=viewer_id)
        elif scheme == "page":
            resolved = _resolve_page_batch(db, items, viewer_id=viewer_id)
        elif scheme == "note_block":
            resolved = _resolve_note_block_batch(db, items, viewer_id=viewer_id)
        elif scheme == "fragment":
            resolved = _resolve_fragment_batch(db, items, viewer_id=viewer_id)
        elif scheme == "conversation":
            resolved = _resolve_conversation_batch(db, items, viewer_id=viewer_id)
        elif scheme == "message":
            resolved = _resolve_message_batch(db, items, viewer_id=viewer_id)
        else:
            resolved = [_missing(uri) for uri, _ in items]
        for entry in resolved:
            results[entry.uri] = entry

    return [results[uri] for uri in uris]


def _missing(uri: str) -> ResolvedResource:
    return ResolvedResource(
        uri=uri,
        label="(resource unavailable)",
        summary="",
        inline_body=None,
        fetch_hint="",
        missing=True,
    )


def _first_line(body: str) -> str:
    for line in body.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped[:200]
    return ""


def _resolve_media_batch(
    db: Session,
    items: list[tuple[str, UUID]],
    *,
    viewer_id: UUID,
) -> list[ResolvedResource]:
    ids = [item[1] for item in items]
    rows = db.execute(
        text(
            """
            SELECT
                m.id,
                m.title,
                COALESCE(
                    NULLIF(string_agg(DISTINCT cc.credited_name, ', ' ORDER BY cc.credited_name), ''),
                    ''
                ) AS authors
            FROM media m
            LEFT JOIN contributor_credits cc
              ON cc.media_id = m.id
             AND cc.role = 'author'
            WHERE m.id = ANY(:ids)
            GROUP BY m.id, m.title
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[ResolvedResource] = []
    for uri, media_id in items:
        row = by_id.get(media_id)
        if row is None or not can_read_media(db, viewer_id, media_id):
            out.append(_missing(uri))
            continue
        title = str(row[1])
        authors = str(row[2])
        label = f"{title} by {authors}" if authors else title
        out.append(
            ResolvedResource(
                uri=uri,
                label=label,
                summary="Searchable.",
                inline_body=None,
                fetch_hint=f'app_search(scopes=["{uri}"], query=...)',
            )
        )
    return out


def _resolve_library_batch(
    db: Session,
    items: list[tuple[str, UUID]],
    *,
    viewer_id: UUID,
) -> list[ResolvedResource]:
    ids = [item[1] for item in items]
    rows = db.execute(
        text(
            """
            SELECT
                l.id,
                l.name,
                (
                    SELECT COUNT(*) FROM library_entries le
                    WHERE le.library_id = l.id
                ) AS item_count
            FROM libraries l
            WHERE l.id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[ResolvedResource] = []
    for uri, library_id in items:
        row = by_id.get(library_id)
        if row is None or not is_library_member(db, viewer_id, library_id):
            out.append(_missing(uri))
            continue
        name = str(row[1])
        count = int(row[2] or 0)
        summary = f"{name} ({count} items)" if count else name
        out.append(
            ResolvedResource(
                uri=uri,
                label=name,
                summary=summary,
                inline_body=None,
                fetch_hint=f'app_search(scopes=["{uri}"], query=...)',
            )
        )
    return out


def _resolve_span_batch(
    db: Session,
    items: list[tuple[str, UUID]],
    *,
    viewer_id: UUID,
) -> list[ResolvedResource]:
    ids = [item[1] for item in items]
    rows = db.execute(
        text(
            """
            SELECT
                es.id,
                es.media_id,
                es.span_text,
                es.citation_label,
                m.title
            FROM evidence_spans es
            JOIN media m ON m.id = es.media_id
            WHERE es.id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[ResolvedResource] = []
    for uri, span_id in items:
        row = by_id.get(span_id)
        if row is None or not can_read_media(db, viewer_id, row[1]):
            out.append(_missing(uri))
            continue
        body = str(row[2] or "")
        label = f"{row[4]} - {row[3]}"
        inline = body if len(body) < INLINE_THRESHOLD_CHARS else None
        out.append(
            ResolvedResource(
                uri=uri,
                label=label,
                summary=_first_line(body),
                inline_body=inline,
                fetch_hint=f'read_resource("{uri}")',
            )
        )
    return out


def _resolve_chunk_batch(
    db: Session,
    items: list[tuple[str, UUID]],
    *,
    viewer_id: UUID,
) -> list[ResolvedResource]:
    ids = [item[1] for item in items]
    rows = db.execute(
        text(
            """
            SELECT
                cc.id,
                cc.media_id,
                cc.chunk_text,
                m.title
            FROM content_chunks cc
            JOIN media m ON m.id = cc.media_id
            WHERE cc.id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[ResolvedResource] = []
    for uri, chunk_id in items:
        row = by_id.get(chunk_id)
        if row is None or not can_read_media(db, viewer_id, row[1]):
            out.append(_missing(uri))
            continue
        body = str(row[2] or "")
        inline = body if len(body) < INLINE_THRESHOLD_CHARS else None
        out.append(
            ResolvedResource(
                uri=uri,
                label=f"{row[3]} - chunk: {_first_line(body)[:80]}",
                summary=_first_line(body),
                inline_body=inline,
                fetch_hint=f'read_resource("{uri}")',
            )
        )
    return out


def _resolve_highlight_batch(
    db: Session,
    items: list[tuple[str, UUID]],
    *,
    viewer_id: UUID,
) -> list[ResolvedResource]:
    ids = [item[1] for item in items]
    rows = db.execute(
        text(
            """
            SELECT id, exact
            FROM highlights
            WHERE id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[ResolvedResource] = []
    for uri, highlight_id in items:
        row = by_id.get(highlight_id)
        if row is None or not can_read_highlight(db, viewer_id, highlight_id):
            out.append(_missing(uri))
            continue
        body = str(row[1] or "")
        label = body[:120] or "Highlight"
        inline = body if len(body) < INLINE_THRESHOLD_CHARS else None
        out.append(
            ResolvedResource(
                uri=uri,
                label=label,
                summary=_first_line(body),
                inline_body=inline,
                fetch_hint=f'read_resource("{uri}")',
            )
        )
    return out


def _resolve_page_batch(
    db: Session,
    items: list[tuple[str, UUID]],
    *,
    viewer_id: UUID,
) -> list[ResolvedResource]:
    ids = [item[1] for item in items]
    rows = db.execute(
        text(
            """
            SELECT id, user_id, title, description
            FROM pages
            WHERE id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[ResolvedResource] = []
    for uri, page_id in items:
        row = by_id.get(page_id)
        if row is None or row[1] != viewer_id:
            out.append(_missing(uri))
            continue
        title = str(row[2])
        description = str(row[3] or "")
        inline = description if len(description) < INLINE_THRESHOLD_CHARS else None
        out.append(
            ResolvedResource(
                uri=uri,
                label=title,
                summary=_first_line(description),
                inline_body=inline,
                fetch_hint=f'read_resource("{uri}")',
            )
        )
    return out


def _resolve_note_block_batch(
    db: Session,
    items: list[tuple[str, UUID]],
    *,
    viewer_id: UUID,
) -> list[ResolvedResource]:
    ids = [item[1] for item in items]
    rows = db.execute(
        text(
            """
            SELECT id, user_id, body_text
            FROM note_blocks
            WHERE id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[ResolvedResource] = []
    for uri, block_id in items:
        row = by_id.get(block_id)
        if row is None or row[1] != viewer_id:
            out.append(_missing(uri))
            continue
        body = str(row[2] or "")
        label = _first_line(body)[:120] or "Note"
        inline = body if len(body) < INLINE_THRESHOLD_CHARS else None
        out.append(
            ResolvedResource(
                uri=uri,
                label=label,
                summary=_first_line(body),
                inline_body=inline,
                fetch_hint=f'read_resource("{uri}")',
            )
        )
    return out


def _resolve_fragment_batch(
    db: Session,
    items: list[tuple[str, UUID]],
    *,
    viewer_id: UUID,
) -> list[ResolvedResource]:
    ids = [item[1] for item in items]
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
    out: list[ResolvedResource] = []
    for uri, fragment_id in items:
        row = by_id.get(fragment_id)
        if row is None or not can_read_media(db, viewer_id, row[1]):
            out.append(_missing(uri))
            continue
        body = str(row[3] or "")
        label = f"{row[4]} — fragment {int(row[2]) + 1}"
        inline = body if len(body) < INLINE_THRESHOLD_CHARS else None
        out.append(
            ResolvedResource(
                uri=uri,
                label=label,
                summary=_first_line(body),
                inline_body=inline,
                fetch_hint=f'read_resource("{uri}")',
            )
        )
    return out


def _resolve_conversation_batch(
    db: Session,
    items: list[tuple[str, UUID]],
    *,
    viewer_id: UUID,
) -> list[ResolvedResource]:
    ids = [item[1] for item in items]
    rows = db.execute(
        text(
            """
            SELECT
                c.id,
                c.title,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
            FROM conversations c
            WHERE c.id = ANY(:ids)
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[ResolvedResource] = []
    for uri, conversation_id in items:
        row = by_id.get(conversation_id)
        if row is None or not can_read_conversation(db, viewer_id, conversation_id):
            out.append(_missing(uri))
            continue
        title = str(row[1] or "").strip() or "Untitled conversation"
        message_count = int(row[2] or 0)
        out.append(
            ResolvedResource(
                uri=uri,
                label=title,
                summary=f"Chat history with {message_count} messages.",
                inline_body=None,
                fetch_hint=f'read_resource("{uri}")',
            )
        )
    return out


def _resolve_message_batch(
    db: Session,
    items: list[tuple[str, UUID]],
    *,
    viewer_id: UUID,
) -> list[ResolvedResource]:
    ids = [item[1] for item in items]
    rows = db.execute(
        text(
            """
            SELECT id, conversation_id, role, content
            FROM messages
            WHERE id = ANY(:ids)
              AND status != 'pending'
            """
        ),
        {"ids": ids},
    ).fetchall()
    by_id = {row[0]: row for row in rows}
    out: list[ResolvedResource] = []
    for uri, message_id in items:
        row = by_id.get(message_id)
        if row is None or not can_read_conversation(db, viewer_id, row[1]):
            out.append(_missing(uri))
            continue
        role = str(row[2])
        body = str(row[3] or "")
        label = f"{role}: {body[:40]}".strip()
        inline = body if len(body) < INLINE_THRESHOLD_CHARS else None
        out.append(
            ResolvedResource(
                uri=uri,
                label=label,
                summary=_first_line(body),
                inline_body=inline,
                fetch_hint=f'read_resource("{uri}")',
            )
        )
    return out
