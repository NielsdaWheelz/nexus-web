"""Scope parsing, authorization, conversation-visibility SQL, and the single owner of
the scope×entity filter matrix (search cutover §4.6)."""

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

# =============================================================================
# Scope Parsing and Authorization
# =============================================================================


def parse_scope(scope: str) -> tuple[ScopeKind, UUID | None]:
    """Parse scope string into (scope_kind, scope_id).

    Valid scopes:
    - "all" -> ("all", None)
    - "media:<uuid>" -> ("media", UUID)
    - "library:<uuid>" -> ("library", UUID)
    - "conversation:<uuid>" -> ("conversation", UUID)

    Raises:
        InvalidRequestError: If scope format is invalid.
    """
    if scope == "all":
        return ("all", None)

    prefixes: tuple[tuple[str, ScopeKind], ...] = (
        ("media:", "media"),
        ("library:", "library"),
        ("conversation:", "conversation"),
    )
    for prefix, kind in prefixes:
        if scope.startswith(prefix):
            try:
                return (kind, UUID(scope[len(prefix) :]))
            except ValueError:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST, f"Invalid {kind} ID in scope"
                ) from None

    # Unknown scope format - treat as invalid
    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")


def scope_from_uri(scope: str) -> SearchScope:
    """Parse a scope URI (``all`` / ``media:<id>`` / ``library:<id>`` / ``conversation:<id>``)
    into a typed :class:`SearchScope`. The single edge parser shared by the HTTP route and
    the chat ``app_search`` tool so both construct scopes identically."""
    scope_type, scope_id = parse_scope(scope)
    return SearchScope(kind=scope_type, id=scope_id)


def authorize_scope(
    db: Session,
    viewer_id: UUID,
    scope_type: str,
    scope_id: UUID | None,
) -> None:
    """Authorize viewer for the given scope.

    Raises:
        NotFoundError: If scope object is not visible to viewer.
    """
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


# =============================================================================
# Scope × entity filter matrix (§4.6) — the single owner of scope→SQL.
#
# `scope_filter_sql(scope, entity)` returns an AND-clause fragment + params to splice
# into the entity's retriever WHERE, ("", {}) for the unscoped `all`, or the
# UNSUPPORTED sentinel (the cell yields no results — the retriever returns []).
# Connection-derived cells read `resource_edges` with explicit origin/kind
# allowlists. Containment, citations, and other graph-owned rows must not make
# a note searchable inside an unrelated media/library/conversation scope.
# =============================================================================


class ScopeUnsupported:
    """Sentinel: a (scope, entity) combination that yields no results."""

    __slots__ = ()

    def __repr__(self) -> str:
        return "UNSUPPORTED"


UNSUPPORTED = ScopeUnsupported()

ScopeFilter = tuple[str, dict[str, Any]] | ScopeUnsupported


def _sql_values(values: tuple[str, ...]) -> str:
    return "(" + ", ".join(f"'{value}'" for value in values) + ")"


NOTE_MEDIA_SEARCH_EDGE_ORIGINS_SQL = _sql_values(NOTE_MEDIA_SEARCH_EDGE_ORIGINS)
CONVERSATION_CONTEXT_EDGE_ORIGINS_SQL = _sql_values(CONVERSATION_CONTEXT_EDGE_ORIGINS)

# The library-set owner (spec §4.1): every matrix cell's own returned params dict
# only ever carries `scope_id` (see `scope_filter_sql`), and `:viewer_id` is already
# ambient in every retriever's own top-level params (the same convention
# `_media_context_ref_scope` below relies on), so the library-id bind is rebound to
# `:scope_id` via `library_media_ids_cte_sql`'s own `library_param` hook.
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
                  AND e.origin IN {CONVERSATION_CONTEXT_EDGE_ORIGINS_SQL}
                  AND e.user_id = :viewer_id
                  AND e.ordinal IS NULL
            )
    """


def _note_object_scope(scheme: str, object_id_sql: str) -> dict[str, str | ScopeUnsupported]:
    """resource_edges-based scope for a page/note_block keyed on (scheme, object_id_sql).

    Media/library cells accept only user and highlight-note relationships.
    Conversation cells accept only bare context refs from the conversation to
    the page/note block."""
    edge_match = (
        f"((e.source_scheme = '{scheme}' AND e.source_id = {object_id_sql}) "
        f"OR (e.target_scheme = '{scheme}' AND e.target_id = {object_id_sql}))"
    )
    note_media_edge = f"""
                  AND e.kind = '{SEARCH_SCOPE_EDGE_KIND}'
                  AND e.origin IN {NOTE_MEDIA_SEARCH_EDGE_ORIGINS_SQL}
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
                  AND e.origin IN {CONVERSATION_CONTEXT_EDGE_ORIGINS_SQL}
                  AND e.user_id = :viewer_id
                  AND e.ordinal IS NULL
            )
        """,
    }


# entity → {scope_kind → SQL fragment | UNSUPPORTED}. `all` is handled before lookup.
# Entities media/episode/video share the media cell (the shared `_search_media`).
_SCOPE_MATRIX: dict[str, dict[str, str | ScopeUnsupported]] = {
    "media": {
        "media": "AND m.id = :scope_id",
        "library": f"AND m.id IN ({_LIBRARY_MEDIA_IDS_SQL})",
        "conversation": f"AND {_media_context_ref_scope('m.id')}",
    },
    "podcast": {
        "media": UNSUPPORTED,
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
        "conversation": UNSUPPORTED,
    },
    "evidence_span": {
        "media": "AND es.owner_kind = 'media' AND es.owner_id = :scope_id",
        "library": f"""
            AND es.owner_kind = 'media' AND es.owner_id IN ({_LIBRARY_MEDIA_IDS_SQL})
        """,
        "conversation": f"""
            AND es.owner_kind = 'media'
            AND {_media_context_ref_scope("es.owner_id")}
        """,
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
                  AND e.origin IN {CONVERSATION_CONTEXT_EDGE_ORIGINS_SQL}
                  AND e.user_id = :viewer_id
                  AND e.ordinal IS NULL
            )
        """,
    },
    "message": {
        "media": UNSUPPORTED,
        "library": """
            AND m.conversation_id IN (
                SELECT cs.conversation_id
                FROM conversation_shares cs
                JOIN conversations conv ON conv.id = cs.conversation_id
                WHERE cs.library_id = :scope_id
                  AND conv.sharing = 'library'
            )
        """,
        "conversation": "AND m.conversation_id = :scope_id",
    },
    "conversation": {
        "media": UNSUPPORTED,
        "library": """
            AND c.id IN (
                SELECT cs.conversation_id
                FROM conversation_shares cs
                WHERE cs.library_id = :scope_id
            )
        """,
        "conversation": "AND c.id = :scope_id",
    },
    "web_result": {
        "media": UNSUPPORTED,
        "library": """
            AND mtc.conversation_id IN (
                SELECT cs.conversation_id
                FROM conversation_shares cs
                JOIN conversations conv ON conv.id = cs.conversation_id
                WHERE cs.library_id = :scope_id
                  AND conv.sharing = 'library'
            )
        """,
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


def scope_filter_sql(scope_type: str, scope_id: UUID | None, entity: str) -> ScopeFilter:
    """Scope→SQL for one (scope, entity) cell of the §4.6 matrix.

    Returns ``("", {})`` for the unscoped ``all``, ``(sql_fragment, params)`` for a
    supported scoped cell, or :data:`UNSUPPORTED` when the entity cannot honor the
    scope (the retriever yields no results). ``scope_type`` is assumed pre-validated
    by :func:`parse_scope`.
    """
    if scope_type == "all":
        return ("", {})
    cell = _SCOPE_MATRIX[entity][scope_type]
    if isinstance(cell, ScopeUnsupported):
        return UNSUPPORTED
    return (cell, {"scope_id": scope_id})
