"""Target-only resource-metadata retrievers: libraries, generated outputs, passage anchors.

These exist for resource-target search (universal-link-authoring-hard-cutover.md,
Resource Target Search rule 3): they return internal candidates for the
``services/search/candidates.py`` seam only. Nothing here enters the public
search taxonomy — ``SEARCH_RESULT_TYPES``/``SearchKind``/``schemas/search.py``
are spec-frozen and these candidate types never reach ``SearchResultOut``.

Matching is lexical-only (exact/prefix/substring ILIKE + FTS) and one-character
capable; no retriever here touches ``build_query_embedding``. Query caller-gating
(per-purpose minimum length) is owned by ``resource_items/targets.py``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.db.sql_patterns import escape_ilike_pattern
from nexus.services.search.projection import _snippet_around_query, _truncate_snippet
from nexus.services.search.results import _build_search_score, _SearchScore


@dataclass(slots=True)
class LibraryCandidate:
    id: UUID
    name: str
    snippet: str
    score: _SearchScore
    result_type: Literal["library"] = "library"


@dataclass(slots=True)
class OracleReadingCandidate:
    id: UUID
    question_text: str
    snippet: str
    score: _SearchScore
    result_type: Literal["oracle_reading"] = "oracle_reading"


@dataclass(slots=True)
class LibraryDossierCandidate:
    """A library-dossier artifact head (``artifacts`` row, scheme ``artifact``).

    Shares the ``artifact`` weight/normalization pool with the conversation
    distillate results of ordinary search; identity is the artifact head id.
    """

    id: UUID
    library_id: UUID
    library_name: str
    snippet: str
    score: _SearchScore
    result_type: Literal["artifact"] = "artifact"


@dataclass(slots=True)
class PassageAnchorCandidate:
    id: UUID
    owner_scheme: str  # "media" | "note_block"
    owner_id: UUID
    exact: str
    snippet: str
    score: _SearchScore
    result_type: Literal["passage_anchor"] = "passage_anchor"


ResourceMetadataCandidate = (
    LibraryCandidate | OracleReadingCandidate | LibraryDossierCandidate | PassageAnchorCandidate
)


def _lexical_params(viewer_id: UUID, q: str, limit: int) -> dict[str, Any]:
    escaped = escape_ilike_pattern(q)
    return {
        "viewer_id": viewer_id,
        "query": q,
        "prefix_pattern": f"{escaped}%",
        "contains_pattern": f"%{escaped}%",
        "limit": limit,
    }


def _tier_score_sql(title_sql: str, blob_sql: str) -> str:
    """Exact/prefix/substring tiers on the title plus an FTS bonus over the blob."""
    return f"""(
        CASE
            WHEN lower({title_sql}) = lower(:query) THEN 4.0
            WHEN {title_sql} ILIKE :prefix_pattern THEN 3.0
            WHEN {blob_sql} ILIKE :contains_pattern THEN 2.0
            ELSE 0.0
        END
        + ts_rank_cd(
            to_tsvector('english', {blob_sql}),
            websearch_to_tsquery('english', :query)
        ) * 2.0
    )"""


def _lexical_match_sql(blob_sql: str) -> str:
    return f"""(
        {blob_sql} ILIKE :contains_pattern
        OR to_tsvector('english', {blob_sql}) @@ websearch_to_tsquery('english', :query)
    )"""


def retrieve_library_candidates(
    db: Session, *, viewer_id: UUID, q: str, limit: int
) -> list[LibraryCandidate]:
    """Membership-visible libraries matched on name."""
    rows = db.execute(
        text(
            f"""
            SELECT l.id, l.name, {_tier_score_sql("l.name", "l.name")} AS score
            FROM libraries l
            JOIN memberships mem ON mem.library_id = l.id AND mem.user_id = :viewer_id
            WHERE {_lexical_match_sql("l.name")}
            ORDER BY score DESC, l.name ASC, l.id ASC
            LIMIT :limit
            """
        ),
        _lexical_params(viewer_id, q, limit),
    ).fetchall()
    return [
        LibraryCandidate(
            id=row[0],
            name=str(row[1]),
            snippet=_truncate_snippet(str(row[1])),
            score=_build_search_score(row[2]),
        )
        for row in rows
    ]


_ORACLE_READING_BLOB_SQL = """concat_ws(
    ' ',
    r.question_text,
    COALESCE(r.folio_motto, ''),
    COALESCE(r.interpretation_text, '')
)"""


def retrieve_oracle_reading_candidates(
    db: Session, *, viewer_id: UUID, q: str, limit: int
) -> list[OracleReadingCandidate]:
    """Viewer-owned oracle readings matched on question, motto, and interpretation."""
    rows = db.execute(
        text(
            f"""
            SELECT
                r.id,
                r.question_text,
                {_ORACLE_READING_BLOB_SQL} AS blob,
                {_tier_score_sql("r.question_text", _ORACLE_READING_BLOB_SQL)} AS score
            FROM oracle_readings r
            WHERE r.user_id = :viewer_id
              AND {_lexical_match_sql(_ORACLE_READING_BLOB_SQL)}
            ORDER BY score DESC, r.created_at DESC, r.id ASC
            LIMIT :limit
            """
        ),
        _lexical_params(viewer_id, q, limit),
    ).fetchall()
    return [
        OracleReadingCandidate(
            id=row[0],
            question_text=str(row[1]),
            snippet=_snippet_around_query(str(row[2] or ""), q) or _truncate_snippet(str(row[1])),
            score=_build_search_score(row[3]),
        )
        for row in rows
    ]


def retrieve_library_dossier_candidates(
    db: Session, *, viewer_id: UUID, q: str, limit: int
) -> list[LibraryDossierCandidate]:
    """Membership-visible library-dossier artifact heads matched on current ready content.

    ``artifact``/``artifact_revision`` resource schemes are library-dossier-only
    (``resource_graph/resolve.py`` masks other subjects), so only those heads are
    retrieved; the head is the canonical target and individual revisions stay
    reachable through exact-ResourceRef input.
    """
    rows = db.execute(
        text(
            f"""
            SELECT
                a.id,
                a.subject_id AS library_id,
                l.name,
                r.content_md,
                {_tier_score_sql("l.name", "r.content_md")} AS score
            FROM artifacts a
            JOIN libraries l ON l.id = a.subject_id
            JOIN memberships mem ON mem.library_id = l.id AND mem.user_id = :viewer_id
            JOIN artifact_revisions r ON r.id = a.current_revision_id AND r.status = 'ready'
            WHERE a.subject_scheme = 'library'
              AND a.kind = 'library_dossier'
              AND {_lexical_match_sql("r.content_md")}
            ORDER BY score DESC, a.id ASC
            LIMIT :limit
            """
        ),
        _lexical_params(viewer_id, q, limit),
    ).fetchall()
    return [
        LibraryDossierCandidate(
            id=row[0],
            library_id=row[1],
            library_name=str(row[2]),
            snippet=_snippet_around_query(str(row[3] or ""), q)
            or _truncate_snippet(str(row[3] or row[2])),
            score=_build_search_score(row[4]),
        )
        for row in rows
    ]


_PASSAGE_ANCHOR_EXACT_SQL = "(pa.selector #>> '{quote,exact}')"


def retrieve_passage_anchor_candidates(
    db: Session, *, viewer_id: UUID, q: str, limit: int
) -> list[PassageAnchorCandidate]:
    """Viewer-owned passage anchors matched on their normalized quote text.

    Owner visibility gates the anchor: media owners must be visible media, note
    owners must be viewer-owned note blocks.
    """
    rows = db.execute(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT
                pa.id,
                pa.owner_scheme,
                pa.owner_id,
                {_PASSAGE_ANCHOR_EXACT_SQL} AS exact,
                {_tier_score_sql(_PASSAGE_ANCHOR_EXACT_SQL, _PASSAGE_ANCHOR_EXACT_SQL)} AS score
            FROM passage_anchors pa
            WHERE pa.user_id = :viewer_id
              AND (
                    (pa.owner_scheme = 'media'
                     AND pa.owner_id IN (SELECT media_id FROM visible_media))
                    OR (pa.owner_scheme = 'note_block'
                        AND pa.owner_id IN
                            (SELECT id FROM note_blocks WHERE user_id = :viewer_id))
              )
              AND {_lexical_match_sql(_PASSAGE_ANCHOR_EXACT_SQL)}
            ORDER BY score DESC, pa.created_at DESC, pa.id ASC
            LIMIT :limit
            """
        ),
        _lexical_params(viewer_id, q, limit),
    ).fetchall()
    return [
        PassageAnchorCandidate(
            id=row[0],
            owner_scheme=str(row[1]),
            owner_id=row[2],
            exact=str(row[3] or ""),
            snippet=_snippet_around_query(str(row[3] or ""), q)
            or _truncate_snippet(str(row[3] or "")),
            score=_build_search_score(row[4]),
        )
        for row in rows
    ]
