"""Scope parsing, authorization, conversation-visibility SQL, and the single owner of
the scope×entity filter matrix (search cutover §4.6)."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation, can_read_media, is_library_member
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
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
# UNSUPPORTED sentinel (the cell yields no results — the retriever returns []). Every
# cell is the verbatim current retriever SQL; this module only centralizes and tests
# what was previously inlined across 11 retrievers. No cell changes behavior.
# =============================================================================


class ScopeUnsupported:
    """Sentinel: a (scope, entity) combination that yields no results."""

    __slots__ = ()

    def __repr__(self) -> str:
        return "UNSUPPORTED"


UNSUPPORTED = ScopeUnsupported()

ScopeFilter = tuple[str, dict[str, Any]] | ScopeUnsupported

# entity → {scope_kind → SQL fragment | UNSUPPORTED}. `all` is handled before lookup.
# Entities media/episode/video share the media cell (the shared `_search_media`).
_SCOPE_MATRIX: dict[str, dict[str, str | ScopeUnsupported]] = {
    "media": {
        "media": "AND m.id = :scope_id",
        "library": """
            AND m.id IN (
                SELECT media_id
                FROM library_entries
                WHERE library_id = :scope_id
                  AND media_id IS NOT NULL
            )
        """,
        "conversation": """
            AND m.id IN (
                SELECT media_id
                FROM conversation_media
                WHERE conversation_id = :scope_id
            )
        """,
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
        "conversation": """
            AND EXISTS (
                SELECT 1
                FROM conversation_media cm
                JOIN podcast_episodes pe ON pe.media_id = cm.media_id
                WHERE cm.conversation_id = :scope_id
                  AND pe.podcast_id = p.id
            )
        """,
    },
    "content_chunk": {
        "media": "AND cc.media_id = :scope_id",
        "library": """
            AND cc.media_id IN (
                SELECT media_id
                FROM library_entries
                WHERE library_id = :scope_id
                  AND media_id IS NOT NULL
            )
        """,
        "conversation": """
            AND cc.media_id IN (
                SELECT media_id
                FROM conversation_media
                WHERE conversation_id = :scope_id
            )
        """,
    },
    "fragment": {
        "media": "AND f.media_id = :scope_id",
        "library": """
            AND f.media_id IN (
                SELECT media_id
                FROM library_entries
                WHERE library_id = :scope_id
                  AND media_id IS NOT NULL
            )
        """,
        "conversation": UNSUPPORTED,
    },
    "evidence_span": {
        "media": "AND es.media_id = :scope_id",
        "library": """
            AND es.media_id IN (
                SELECT media_id FROM library_entries WHERE library_id = :scope_id
            )
        """,
        "conversation": """
            AND es.media_id IN (
                SELECT media_id FROM conversation_media WHERE conversation_id = :scope_id
            )
        """,
    },
    "highlight": {
        "media": "AND h.anchor_media_id = :scope_id",
        "library": """
            AND h.anchor_media_id IN (
                SELECT media_id
                FROM library_entries
                WHERE library_id = :scope_id
                  AND media_id IS NOT NULL
            )
        """,
        "conversation": """
            AND ('highlight:' || h.id::text) IN (
                SELECT cr.resource_uri
                FROM conversation_references cr
                WHERE cr.conversation_id = :scope_id
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
        "library": """
            AND (
                cc.media_id IN (
                    SELECT media_id
                    FROM library_entries
                    WHERE library_id = :scope_id
                      AND media_id IS NOT NULL
                )
                OR cc.podcast_id IN (
                    SELECT podcast_id
                    FROM library_entries
                    WHERE library_id = :scope_id
                      AND podcast_id IS NOT NULL
                )
            )
        """,
        "conversation": """
            AND (
                cc.media_id IN (
                    SELECT media_id
                    FROM conversation_media
                    WHERE conversation_id = :scope_id
                )
                OR cc.podcast_id IN (
                    SELECT pe.podcast_id
                    FROM conversation_media cm
                    JOIN podcast_episodes pe ON pe.media_id = cm.media_id
                    WHERE cm.conversation_id = :scope_id
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
