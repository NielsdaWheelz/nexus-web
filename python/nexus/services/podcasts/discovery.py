"""Podcast discovery: provider search mapped to discovery results."""

from __future__ import annotations

from sqlalchemy.orm import Session

from nexus.errors import (
    ApiErrorCode,
    InvalidRequestError,
)
from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.podcast import PodcastDiscoveryOut

from .identity import (
    select_podcast_id_by_feed_url,
    select_podcast_id_by_provider_id,
    validate_and_normalize_feed_url,
)
from .provider import get_podcast_index_client


def discover_podcasts(
    db: Session,
    query: str,
    *,
    limit: int = 10,
) -> list[PodcastDiscoveryOut]:
    query = query.strip()
    if not query:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Query must not be empty")
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")

    client = get_podcast_index_client()
    rows = client.search_podcasts(query, limit)
    results: list[PodcastDiscoveryOut] = []
    for row in rows:
        feed_url = row["feed_url"]
        try:
            feed_url = validate_and_normalize_feed_url(feed_url)
        except InvalidRequestError:  # justify-ignore-error: surface upstream provider results even when their feed_url fails canonicalization
            pass

        podcast_id = select_podcast_id_by_provider_id(db, row["provider_podcast_id"])
        if podcast_id is None:
            podcast_id = select_podcast_id_by_feed_url(db, feed_url)

        # Provider author text becomes a handle-less credit-shaped text fact (D-9):
        # discovery persists nothing, so there is no contributor to link to. The
        # frontend renders these as plain text; a fabricated handle/href would point
        # at an author page that does not exist.
        contributors: list[ContributorCreditOut] = []
        raw_author = str(row.get("author") or "").strip()
        if raw_author:
            contributors = [
                ContributorCreditOut(
                    credited_name=raw_author,
                    contributor_display_name=raw_author,
                    role="author",
                )
            ]

        results.append(
            PodcastDiscoveryOut(
                podcast_id=podcast_id,
                provider_podcast_id=row["provider_podcast_id"],
                title=row["title"],
                contributors=contributors,
                feed_url=feed_url,
                website_url=row["website_url"],
                image_url=row["image_url"],
                description=row["description"],
            )
        )
    return results
