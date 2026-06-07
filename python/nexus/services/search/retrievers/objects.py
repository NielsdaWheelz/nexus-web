"""Note page and note-block retrievers."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services import object_search
from nexus.services.search.projection import _truncate_snippet
from nexus.services.search.results import (
    InternalSearchResult,
    _build_search_score,
    _RankedNoteBlockResult,
    _RankedPageResult,
)


def _search_pages(
    db: Session,
    viewer_id: UUID,
    q: str,
    semantic_query_embedding: tuple[str, list[float]] | None,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    rows = object_search.search_objects(
        db,
        viewer_id=viewer_id,
        object_type="page",
        query_text=q,
        semantic_query_embedding=semantic_query_embedding,
        scope_type=scope_type,
        scope_id=scope_id,
        limit=limit,
    )
    results: list[InternalSearchResult] = []
    for row in rows:
        results.append(
            _RankedPageResult(
                id=row["object_id"],
                title=row["title_text"],
                description=row["body_text"] or None,
                snippet=_truncate_snippet(str(row["snippet"] or row["title_text"])),
                score=_build_search_score(row["score"]),
            )
        )
    return results


def _search_note_blocks(
    db: Session,
    viewer_id: UUID,
    q: str,
    semantic_query_embedding: tuple[str, list[float]] | None,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    rows = object_search.search_objects(
        db,
        viewer_id=viewer_id,
        object_type="note_block",
        query_text=q,
        semantic_query_embedding=semantic_query_embedding,
        scope_type=scope_type,
        scope_id=scope_id,
        limit=limit,
    )
    note_ids = [row["object_id"] for row in rows]
    highlight_excerpts: dict[UUID, str] = {}
    if note_ids:
        for row in db.execute(
            text(
                """
                SELECT
                    CASE
                        WHEN ol.a_type = 'note_block' THEN ol.a_id
                        ELSE ol.b_id
                    END AS note_block_id,
                    h.exact
                FROM object_links ol
                JOIN highlights h
                  ON (
                        (ol.a_type = 'highlight' AND h.id = ol.a_id)
                     OR (ol.b_type = 'highlight' AND h.id = ol.b_id)
                  )
                WHERE ol.user_id = :viewer_id
                  AND ol.relation_type = 'note_about'
                  AND (
                        (ol.a_type = 'note_block' AND ol.a_id = ANY(:note_ids))
                     OR (ol.b_type = 'note_block' AND ol.b_id = ANY(:note_ids))
                  )
                ORDER BY ol.created_at ASC, ol.id ASC
                """
            ),
            {"viewer_id": viewer_id, "note_ids": note_ids},
        ).mappings():
            highlight_excerpts.setdefault(
                row["note_block_id"],
                _truncate_snippet(str(row["exact"] or "")),
            )
    results: list[InternalSearchResult] = []
    for row in rows:
        body_text = str(row["body_text"] or "")
        if not body_text:
            continue
        locator = retrieval_locator_json(
            {
                "type": "note_block_offsets",
                "page_id": str(row["parent_object_id"]),
                "block_id": str(row["object_id"]),
                "start_offset": 0,
                "end_offset": len(body_text),
            }
        )
        results.append(
            _RankedNoteBlockResult(
                id=row["object_id"],
                snippet=_truncate_snippet(str(row["snippet"] or "")),
                page_id=row["parent_object_id"],
                page_title=row["title_text"],
                body_text=body_text,
                score=_build_search_score(row["score"]),
                highlight_excerpt=highlight_excerpts.get(row["object_id"]),
                locator=locator,
            )
        )
    return results
