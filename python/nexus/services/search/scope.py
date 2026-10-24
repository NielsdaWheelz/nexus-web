"""Which rows a scope admits: authorization, plus one SQL predicate per (family, scope kind).

A predicate binds ``:{s}`` (the scope id, renamed per scope) and ``:viewer_id``. Media-anchored
families alias their media ``m``; the other aliases are their family's (see ``sources``).
Shared composition owns materialized library relations, bindings and family predicates;
standalone predicates inline the same scope rules.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_conversation,
    can_read_media,
    is_library_member,
    media_containment_edges_sql,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.services.library_entries import library_media_ids_cte_sql
from nexus.services.resource_graph.context import context_facts_sql
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search.query import SearchScope


def authorize_scope(db: Session, viewer_id: UUID, scope: SearchScope) -> None:
    """404 (never 403, so existence does not leak) for a scope the viewer cannot read."""
    if scope.id is None:
        return
    if scope.kind == "media" and not can_read_media(db, viewer_id, scope.id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
    if scope.kind == "library" and not is_library_member(db, viewer_id, scope.id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Library not found")
    if scope.kind == "conversation" and not can_read_conversation(db, viewer_id, scope.id):
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")


def _context(scheme: str, column: str) -> str:
    """The row is a direct fact of the scoped conversation's context."""
    return f"""EXISTS (SELECT 1 FROM ({context_facts_sql(":{s}")}) facts
        WHERE facts.target_scheme = '{scheme}' AND facts.target_id = {column})"""


def reading_media_ids_sql(roots_sql: str) -> str:
    """Structural candidates: each root, its primary posts and one contextual level.

    This relation proves neither current visibility nor reader projection membership.
    Derived read admission must verify the viewer's actual reader projection.
    Opening a contextual post's own pane does not put its further context inside
    the original scoped document.
    """
    return f"""
        WITH roots AS ({roots_sql}),
        primary_sources AS (
            SELECT media_id FROM roots
            UNION
            SELECT tp.post_media_id FROM x_thread_posts tp
            JOIN roots ON roots.media_id = tp.thread_media_id
        )
        SELECT media_id FROM primary_sources
        UNION
        SELECT edge.child_media_id FROM ({media_containment_edges_sql()}) edge
        JOIN primary_sources source ON source.media_id = edge.parent_media_id
    """


_MEDIA = reading_media_ids_sql("SELECT CAST(:{s} AS uuid) AS media_id")
_LIBRARY_MEDIA = reading_media_ids_sql(library_media_ids_cte_sql(library_param=":{s}"))
_LIBRARY_PODCASTS = (
    "SELECT podcast_id FROM library_entries WHERE library_id = :{s} AND podcast_id IS NOT NULL"
)
_CONTEXT_PODCASTS = (
    f"SELECT pe.podcast_id FROM podcast_episodes pe WHERE {_context('media', 'pe.media_id')}"
)


def _media_cells(conversation: str, library_media: str) -> dict[str, str]:
    return {
        "media": f"m.id IN ({_MEDIA})",
        "library": f"m.id IN ({library_media})",
        "conversation": conversation,
    }


def _note_cells(scheme: str, column: str, library_media: str) -> dict[str, str]:
    """A note joins a media or library scope only through its user or highlight-note edges."""
    edge = f"""EXISTS (SELECT 1 FROM resource_edges e
        LEFT JOIN highlights h ON (e.source_scheme = 'highlight' AND h.id = e.source_id)
            OR (e.target_scheme = 'highlight' AND h.id = e.target_id)
        WHERE ((e.source_scheme = '{scheme}' AND e.source_id = {column})
            OR (e.target_scheme = '{scheme}' AND e.target_id = {column}))
          AND e.kind = 'context' AND e.origin IN ('user', 'highlight_note')
          AND e.user_id = :viewer_id AND e.ordinal IS NULL
          AND EXISTS (SELECT 1 FROM (MEDIA_SET) reading
              WHERE reading.media_id IN (
                  CASE WHEN e.source_scheme = 'media' THEN e.source_id END,
                  CASE WHEN e.target_scheme = 'media' THEN e.target_id END, h.anchor_media_id)))"""
    return {
        "media": edge.replace("MEDIA_SET", _MEDIA),
        "library": edge.replace("MEDIA_SET", library_media),
        "conversation": _context(scheme, column),
    }


# family -> scope kind -> predicate; a missing cell means the family contributes nothing.
def _cells(library_media: str) -> dict[str, dict[str, str]]:
    return {
        "media": _media_cells(_context("media", "m.id"), library_media),
        "content_chunk": _media_cells(_context("media", "m.id"), library_media),
        "fragment": _media_cells(_context("media", "m.id"), library_media),
        "reader_apparatus_item": _media_cells(_context("media", "m.id"), library_media),
        "highlight": _media_cells(_context("highlight", "h.id"), library_media),
        "podcast": {
            "library": f"p.id IN ({_LIBRARY_PODCASTS})",
            "conversation": f"p.id IN ({_CONTEXT_PODCASTS})",
        },
        "contributor": {
            "media": f"vc.media_id IN ({_MEDIA})",
            "library": f"(vc.media_id IN ({library_media}) OR vc.podcast_id IN ({_LIBRARY_PODCASTS}))",
            "conversation": f"""((vc.media_id IS NOT NULL AND {_context("media", "vc.media_id")})
            OR vc.podcast_id IN ({_CONTEXT_PODCASTS}))""",
        },
        "page": _note_cells("page", "p.id", library_media),
        "note_block": _note_cells("note_block", "nb.id", library_media),
        "message": {
            "conversation": f"""(ms.conversation_id = :{{s}} OR {_context("message", "ms.id")}
            OR {_context("conversation", "ms.conversation_id")})"""
        },
        "conversation": {"conversation": f"(c.id = :{{s}} OR {_context('conversation', 'c.id')})"},
        "artifact": {
            "conversation": f"(a.subject_id = :{{s}} OR {_context('conversation', 'a.subject_id')})"
        },
        "web_result": {"conversation": "msg.conversation_id = :{s}"},
        "passage_anchor": {
            kind: f"""((pa.owner_scheme = 'media' AND pa.owner_id IN ({media}))
            OR (pa.owner_scheme = 'note_block'
                AND {_note_cells("note_block", "pa.owner_id", library_media)[kind]}))"""
            for kind, media in (("media", _MEDIA), ("library", library_media))
        }
        | {"conversation": _context("passage_anchor", "pa.id")},
    }


_CELLS = _cells(_LIBRARY_MEDIA)

# family -> the (scheme, column) pairs a frozen chat context admits by exact ref; a frozen
# conversation admits its completed messages.
_FROZEN: dict[str, tuple[tuple[str, str], ...]] = {
    "media": (("media", "m.id"),),
    "content_chunk": (("content_chunk", "cc.id"), ("evidence_span", "cc.primary_evidence_span_id")),
    "fragment": (("fragment", "f.id"),),
    "reader_apparatus_item": (("reader_apparatus_item", "rai.id"),),
    "highlight": (("highlight", "h.id"),),
    "podcast": (("podcast", "p.id"),),
    "contributor": (("contributor", "vc.contributor_id"),),
    "page": (("page", "p.id"),),
    "note_block": (("note_block", "nb.id"),),
    "message": (
        ("message", "ms.id"),
        ("conversation", "ms.conversation_id"),
    ),
    "conversation": (("conversation", "c.id"),),
    "artifact": (("artifact", "a.id"), ("conversation", "a.subject_id")),
    "web_result": (("conversation", "msg.conversation_id"),),
}


def _scope_predicate(
    family: str,
    scopes: Sequence[SearchScope],
    frozen: tuple[ResourceRef, ...] | None,
    cells: Sequence[Mapping[str, Mapping[str, str]]],
) -> tuple[str, dict[str, Any]] | None:
    """``AND (...)`` admitting the union of ``scopes`` for ``family``, or None for nothing.

    An unfrozen "all" admits everything visible; under a frozen chat context "all" admits
    exactly the frozen refs. Media and library scopes keep their displayed sources. Families
    without cells (picker and browse families) are admitted only by an unfrozen "all".
    """
    clauses: list[str] = []
    params: dict[str, Any] = {}
    for n, scope in enumerate(scopes):
        if scope.kind == "all" and frozen is None:
            return "", {}
        if scope.kind == "all" and frozen is not None:
            for scheme, column in _FROZEN.get(family, ()):
                params[f"frozen_{scheme}"] = [ref.id for ref in frozen if ref.scheme == scheme]
                clauses.append(f"{column} = ANY(:frozen_{scheme})")
        elif (cell := cells[n].get(family, {}).get(scope.kind)) is not None:
            params[f"scope_{n}"] = scope.id
            clauses.append(cell.replace("{s}", f"scope_{n}"))
    return (f" AND ({' OR '.join(clauses)})", params) if clauses else None


@dataclass(frozen=True)
class ScopeSQL:
    """Attach ctes once; cells and their bindings belong to this composition only."""

    ctes: tuple[str, ...]
    bindings: Mapping[str, Any]
    predicates: Mapping[str, str]

    def cell(self, family: str) -> tuple[str, dict[str, Any]] | None:
        predicate = self.predicates.get(family)
        if predicate is None:
            return None
        return predicate, dict(self.bindings)


def compose_scopes(
    families: Sequence[str], scopes: Sequence[SearchScope], frozen: tuple[ResourceRef, ...] | None
) -> ScopeSQL:
    """One exact materialized reading-media set per bound library scope.

    The consumer attaches ctes once and uses cells from this value; authorization
    remains the caller's responsibility. Standalone predicates own their inline sets.
    """
    if any(scope.kind == "all" for scope in scopes) and frozen is None:
        return ScopeSQL((), {}, dict.fromkeys(families, ""))
    ctes: list[str] = []
    bindings: dict[str, Any] = {}
    cells = []
    for n, scope in enumerate(scopes):
        library_media = _LIBRARY_MEDIA
        if scope.kind == "library":
            name = f"search_scope_library_{n}"
            relation = reading_media_ids_sql(library_media_ids_cte_sql(library_param=f":scope_{n}"))
            ctes.append(f"{name} AS MATERIALIZED ({relation})")
            assert scope.id is not None
            bindings[f"scope_{n}"] = scope.id
            library_media = f"SELECT media_id FROM {name}"
        cells.append(_cells(library_media))
    predicates: dict[str, str] = {}
    for family in families:
        cell = _scope_predicate(family, scopes, frozen, cells)
        if cell is not None:
            predicates[family] = cell[0]
            bindings.update(cell[1])
    return ScopeSQL(tuple(ctes), bindings, predicates)


def scope_predicate(
    family: str, scopes: Sequence[SearchScope], frozen: tuple[ResourceRef, ...] | None
) -> tuple[str, dict[str, Any]] | None:
    """Self-contained family predicate, including its inline scope relations."""
    return _scope_predicate(family, scopes, frozen, [_CELLS] * len(scopes))
