"""Scope parsing, authorization, and the scope × entity SQL matrix."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation, can_read_media, is_library_member
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.services.library_entries import library_media_ids_cte_sql
from nexus.services.resource_graph.policy import SEARCH_SCOPE_EDGE_KIND
from nexus.services.resource_items.capabilities import (
    CONVERSATION_CONTEXT_EDGE_ORIGINS,
    NOTE_MEDIA_SEARCH_EDGE_ORIGINS,
)
from nexus.services.search.query import ScopeKind, SearchScope

ScopeFilter = tuple[str, dict[str, Any]]


def scope_from_uri(scope: str) -> SearchScope:
    """Parse ``all`` / ``media:<id>`` / ``library:<id>`` / ``conversation:<id>``."""
    if scope == "all":
        return SearchScope(kind="all", id=None)

    prefixes: tuple[tuple[str, ScopeKind], ...] = (
        ("media:", "media"),
        ("library:", "library"),
        ("conversation:", "conversation"),
    )
    for prefix, kind in prefixes:
        if scope.startswith(prefix):
            try:
                return SearchScope(kind=kind, id=UUID(scope[len(prefix) :]))
            except ValueError:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST, f"Invalid {kind} ID in scope"
                ) from None

    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")


def authorize_scope(db: Session, viewer_id: UUID, scope_type: str, scope_id: UUID | None) -> None:
    """Raise 404 (never 403 — existence must not leak) for an unreadable scope."""
    if scope_type == "all":
        return
    if scope_id is None:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Scope ID is required")
    if scope_type == "media":
        if not can_read_media(db, viewer_id, scope_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
    elif scope_type == "library":
        if not is_library_member(db, viewer_id, scope_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Library not found")
    elif scope_type == "conversation":
        if not can_read_conversation(db, viewer_id, scope_id):
            raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    else:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")


def _sql_values(values: tuple[str, ...]) -> str:
    return "(" + ", ".join(f"'{value}'" for value in values) + ")"


_NOTE_MEDIA_ORIGINS = _sql_values(NOTE_MEDIA_SEARCH_EDGE_ORIGINS)
_CONVERSATION_ORIGINS = _sql_values(CONVERSATION_CONTEXT_EDGE_ORIGINS)
# Every matrix cell binds only `scope_id`; `viewer_id` is ambient in every
# retriever's own params, so the library id is rebound onto `:scope_id`.
_LIBRARY_MEDIA_IDS_SQL = library_media_ids_cte_sql(library_param=":scope_id")


def _media_context_ref_scope(media_id_sql: str) -> str:
    return f"""
            EXISTS (
                SELECT 1 FROM resource_edges e
                WHERE e.source_scheme = 'conversation'
                  AND e.source_id = :scope_id
                  AND e.target_scheme = 'media'
                  AND e.target_id = {media_id_sql}
                  AND e.kind = '{SEARCH_SCOPE_EDGE_KIND}'
                  AND e.origin IN {_CONVERSATION_ORIGINS}
                  AND e.user_id = :viewer_id
                  AND e.ordinal IS NULL
            )
    """


def _note_object_scope(scheme: str, object_id_sql: str) -> dict[str, str | None]:
    """Scope cells for a page/note_block, keyed on (scheme, object_id_sql).

    Media/library cells accept only user and highlight-note relationships;
    conversation cells accept only bare context refs. Containment and citation
    edges must never make a note searchable inside an unrelated scope.
    """
    edge_match = (
        f"((e.source_scheme = '{scheme}' AND e.source_id = {object_id_sql}) "
        f"OR (e.target_scheme = '{scheme}' AND e.target_id = {object_id_sql}))"
    )
    note_media_edge = f"""
                  AND e.kind = '{SEARCH_SCOPE_EDGE_KIND}'
                  AND e.origin IN {_NOTE_MEDIA_ORIGINS}
                  AND e.user_id = :viewer_id
                  AND e.ordinal IS NULL
    """
    return {
        "media": f"""
            AND EXISTS (
                SELECT 1 FROM resource_edges e
                LEFT JOIN highlights h
                  ON ((e.source_scheme = 'highlight' AND h.id = e.source_id)
                   OR (e.target_scheme = 'highlight' AND h.id = e.target_id))
                WHERE {edge_match}
                  {note_media_edge}
                  AND ((e.source_scheme = 'media' AND e.source_id = :scope_id)
                    OR (e.target_scheme = 'media' AND e.target_id = :scope_id)
                    OR h.anchor_media_id = :scope_id)
            )
        """,
        "library": f"""
            AND EXISTS (
                SELECT 1 FROM resource_edges e
                LEFT JOIN highlights h
                  ON ((e.source_scheme = 'highlight' AND h.id = e.source_id)
                   OR (e.target_scheme = 'highlight' AND h.id = e.target_id))
                JOIN ({_LIBRARY_MEDIA_IDS_SQL}) le
                  ON ((e.source_scheme = 'media' AND le.media_id = e.source_id)
                   OR (e.target_scheme = 'media' AND le.media_id = e.target_id)
                   OR le.media_id = h.anchor_media_id)
                WHERE {edge_match}
                  {note_media_edge}
            )
        """,
        "conversation": f"""
            AND EXISTS (
                SELECT 1 FROM resource_edges e
                WHERE e.source_scheme = 'conversation'
                  AND e.source_id = :scope_id
                  AND e.target_scheme = '{scheme}'
                  AND e.target_id = {object_id_sql}
                  AND e.kind = '{SEARCH_SCOPE_EDGE_KIND}'
                  AND e.origin IN {_CONVERSATION_ORIGINS}
                  AND e.user_id = :viewer_id
                  AND e.ordinal IS NULL
            )
        """,
    }


# entity → {scope kind → AND-clause, or None when the entity cannot honour the
# scope and must contribute nothing}. ``all`` is answered before the lookup.
_SCOPE_MATRIX: dict[str, dict[str, str | None]] = {
    "media": {
        "media": "AND m.id = :scope_id",
        "library": f"AND m.id IN ({_LIBRARY_MEDIA_IDS_SQL})",
        "conversation": f"AND {_media_context_ref_scope('m.id')}",
    },
    "podcast": {
        "media": None,
        "library": """
            AND p.id IN (
                SELECT podcast_id
                FROM library_entries
                WHERE library_id = :scope_id
                  AND podcast_id IS NOT NULL
            )
        """,
        "conversation": f"""
            AND EXISTS (
                SELECT 1
                FROM podcast_episodes pe
                WHERE pe.podcast_id = p.id
                  AND {_media_context_ref_scope("pe.media_id")}
            )
        """,
    },
    "content_chunk": {
        "media": "AND cc.owner_kind = 'media' AND cc.owner_id = :scope_id",
        "library": f"""
            AND cc.owner_kind = 'media' AND cc.owner_id IN ({_LIBRARY_MEDIA_IDS_SQL})
        """,
        "conversation": f"""
            AND cc.owner_kind = 'media'
            AND {_media_context_ref_scope("cc.owner_id")}
        """,
    },
    "fragment": {
        "media": "AND f.media_id = :scope_id",
        "library": f"AND f.media_id IN ({_LIBRARY_MEDIA_IDS_SQL})",
        "conversation": None,
    },
    "reader_apparatus_item": {
        "media": "AND rai.media_id = :scope_id",
        "library": f"AND rai.media_id IN ({_LIBRARY_MEDIA_IDS_SQL})",
        "conversation": f"AND {_media_context_ref_scope('rai.media_id')}",
    },
    "page": _note_object_scope("page", "p.id"),
    "note_block": _note_object_scope("note_block", "cc.owner_id"),
    "highlight": {
        "media": "AND h.anchor_media_id = :scope_id",
        "library": f"AND h.anchor_media_id IN ({_LIBRARY_MEDIA_IDS_SQL})",
        "conversation": f"""
            AND EXISTS (
                SELECT 1 FROM resource_edges e
                WHERE e.source_scheme = 'conversation'
                  AND e.source_id = :scope_id
                  AND e.target_scheme = 'highlight'
                  AND e.target_id = h.id
                  AND e.kind = '{SEARCH_SCOPE_EDGE_KIND}'
                  AND e.origin IN {_CONVERSATION_ORIGINS}
                  AND e.user_id = :viewer_id
                  AND e.ordinal IS NULL
            )
        """,
    },
    "message": {
        "media": None,
        "library": None,
        "conversation": "AND m.conversation_id = :scope_id",
    },
    "conversation": {
        "media": None,
        "library": None,
        "conversation": "AND c.id = :scope_id",
    },
    "web_result": {
        "media": None,
        "library": None,
        "conversation": "AND mtc.conversation_id = :scope_id",
    },
    "contributor": {
        "media": "AND cc.media_id = :scope_id",
        "library": f"""
            AND (
                cc.media_id IN ({_LIBRARY_MEDIA_IDS_SQL})
                OR cc.podcast_id IN (
                    SELECT podcast_id
                    FROM library_entries
                    WHERE library_id = :scope_id
                      AND podcast_id IS NOT NULL
                )
            )
        """,
        "conversation": f"""
            AND (
                (
                    cc.media_id IS NOT NULL
                    AND {_media_context_ref_scope("cc.media_id")}
                )
                OR cc.podcast_id IN (
                    SELECT pe.podcast_id
                    FROM podcast_episodes pe
                    WHERE {_media_context_ref_scope("pe.media_id")}
                )
            )
        """,
    },
}


def scope_filter_sql(scope_type: str, scope_id: UUID | None, entity: str) -> ScopeFilter | None:
    """One cell of the scope matrix: ``("", {})`` unscoped, ``(sql, params)``
    when supported, or None when the entity yields no results under the scope."""
    if scope_type == "all":
        return ("", {})
    cell = _SCOPE_MATRIX[entity][scope_type]
    if cell is None:
        return None
    return (cell, {"scope_id": scope_id})
