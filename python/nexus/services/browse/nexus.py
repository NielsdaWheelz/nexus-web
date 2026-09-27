"""Viewer-relative Nexus Browse adapter."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.schemas.browse import BrowseCandidate, InNexusMediaResolution, OwnedMediaCandidate
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.presence import absent, present
from nexus.services.browse.cursor import decode_search_cursor, encode_search_cursor
from nexus.services.browse.models import BrowseKind, BrowseQuery
from nexus.services.keyset_cursor import KeysetValueKind
from nexus.services.media import list_collection_media_for_viewer_by_ids

_PROVIDER_CONTRACT = "NexusVisibleMediaWebsearch"
_MEDIA_KIND = {
    BrowseKind.Pdf: "pdf",
    BrowseKind.Epub: "epub",
    BrowseKind.WebArticle: "web_article",
    BrowseKind.Video: "video",
}


def search(
    db: Session,
    *,
    viewer_id: UUID,
    query: BrowseQuery,
) -> tuple[list[BrowseCandidate], str | None]:
    media_kind = _MEDIA_KIND.get(query.kind)
    if media_kind is None:
        raise ValueError("Nexus adapter does not support this Browse kind")
    offset = 0
    if query.cursor is not None:
        offset = int(
            decode_search_cursor(
                query.cursor,
                query,
                viewer_id=viewer_id,
                provider_contract=_PROVIDER_CONTRACT,
                kind=KeysetValueKind.Int,
            )
        )
    rows = (
        db.execute(
            text(
                f"""
                WITH visible_media AS ({visible_media_ids_cte_sql()}),
                title_hits AS (
                    SELECT
                        m.id,
                        m.description,
                        ts_rank_cd(
                            m.title_tsv,
                            websearch_to_tsquery('english', :query)
                        ) AS score
                    FROM media m
                    JOIN visible_media vm ON vm.media_id = m.id
                    WHERE m.kind = :media_kind
                      AND m.title_tsv @@ websearch_to_tsquery('english', :query)
                )
                SELECT *
                FROM title_hits
                ORDER BY score DESC, id DESC
                OFFSET :offset
                LIMIT :limit
                """
            ),
            {
                "viewer_id": viewer_id,
                "query": query.query,
                "media_kind": media_kind,
                "offset": offset,
                "limit": query.limit + 1,
            },
        )
        .mappings()
        .all()
    )
    page_rows = rows[: query.limit]
    media_ids = [UUID(str(row["id"])) for row in page_rows]
    summaries = {
        item.id: item.summary
        for item in list_collection_media_for_viewer_by_ids(
            db, viewer_id=viewer_id, media_ids=media_ids
        )
    }
    items: list[BrowseCandidate] = [
        _candidate(
            row,
            summary=summaries[UUID(str(row["id"]))],
        )
        for row in page_rows
    ]
    next_cursor = None
    if len(rows) > query.limit:
        next_cursor = encode_search_cursor(
            query,
            viewer_id=viewer_id,
            provider_contract=_PROVIDER_CONTRACT,
            after=offset + query.limit,
        )
    return items, next_cursor


def _candidate(row, *, summary: MediaSummaryOut) -> OwnedMediaCandidate:
    media_id = UUID(str(row["id"]))
    return OwnedMediaCandidate(
        resolution=InNexusMediaResolution(
            href=f"/media/{media_id}",
            action_subject_ref=f"media:{media_id}",
            media_summary=summary,
        ),
        description=absent() if row["description"] is None else present(str(row["description"])),
        image=absent(),
    )
