"""Viewer-relative Nexus Browse adapter."""

from __future__ import annotations

from urllib.parse import urlsplit
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.schemas.browse import (
    BrowseCandidate,
    BrowseSource,
    EpubCandidate,
    EpubFacts,
    InNexusResolution,
    PdfCandidate,
    PdfFacts,
    VideoCandidate,
    VideoFacts,
    WebArticleCandidate,
    WebArticleFacts,
)
from nexus.schemas.presence import absent, present
from nexus.services.browse.cursor import (
    BrowseSearchPlan,
    decode_search_cursor,
    encode_search_cursor,
)
from nexus.services.browse.models import BrowseKind, BrowseQuery
from nexus.services.contributor_credits import load_contributor_credits_for_media

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
                plan=BrowseSearchPlan.NexusMediaRankOffset,
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
                        m.kind,
                        m.title,
                        m.description,
                        m.requested_url,
                        m.canonical_source_url,
                        m.provider,
                        m.provider_id,
                        m.page_count,
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
    credits = load_contributor_credits_for_media(db, media_ids)
    items = [
        _candidate(
            row,
            contributors=credits.get(UUID(str(row["id"])), []),
        )
        for row in page_rows
    ]
    next_cursor = None
    if len(rows) > query.limit:
        next_cursor = encode_search_cursor(
            query,
            viewer_id=viewer_id,
            provider_contract=_PROVIDER_CONTRACT,
            plan=BrowseSearchPlan.NexusMediaRankOffset,
            after=offset + query.limit,
        )
    return items, next_cursor


def _candidate(row, *, contributors) -> BrowseCandidate:
    media_id = UUID(str(row["id"]))
    resolution = InNexusResolution(
        href=f"/media/{media_id}",
        action_subject_ref=f"media:{media_id}",
    )
    description = absent() if row["description"] is None else present(str(row["description"]))
    common = {
        "source": BrowseSource.Nexus,
        "resolution": resolution,
        "title": str(row["title"]),
        "contributors": contributors,
        "description": description,
        "published_at": absent(),
        "image": absent(),
    }
    kind = str(row["kind"])
    if kind == "pdf":
        page_count = row["page_count"]
        return PdfCandidate(
            **common,
            kind_facts=PdfFacts(
                page_count=absent() if page_count is None else present(int(page_count))
            ),
        )
    if kind == "epub":
        return EpubCandidate(
            **common,
            kind_facts=EpubFacts(ebook_ref=absent()),
        )
    if kind == "web_article":
        source_url = row["canonical_source_url"] or row["requested_url"]
        site_name = None
        if source_url:
            site_name = urlsplit(str(source_url)).hostname
        return WebArticleCandidate(
            **common,
            kind_facts=WebArticleFacts(
                site_name=absent() if site_name is None else present(site_name)
            ),
        )
    if kind == "video":
        video_ref = (
            str(row["provider_id"])
            if row["provider"] == "youtube" and row["provider_id"] is not None
            else None
        )
        return VideoCandidate(
            **common,
            kind_facts=VideoFacts(
                video_ref=absent() if video_ref is None else present(video_ref),
                channel_title=absent(),
            ),
        )
    raise RuntimeError(f"Unexpected Nexus Browse media kind: {kind}")
