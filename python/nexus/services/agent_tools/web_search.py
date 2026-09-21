"""Nexus identity projection for one canonical public Web search hit."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from nexus.schemas.retrieval import (
    ExternalSnapshotId,
    ExternalUrlLocator,
    ProviderResultRef,
    RetrievalContextRef,
    WebRetrievalResultRef,
    retrieval_locator_json,
)


def web_result_locator_json(hit: Mapping[str, Any]) -> dict[str, Any]:
    locator = retrieval_locator_json(
        {
            "type": "external_url",
            "url": str(hit["url"]),
            "title": str(hit["title"]),
            "display_url": str(hit["display_url"]),
        }
    )
    if locator is None:
        raise AssertionError("Web citation is missing its external_url locator")
    return locator


def web_result_ref_json(
    hit: Mapping[str, Any],
    *,
    snapshot_id: ExternalSnapshotId,
    selected: bool,
) -> dict[str, Any]:
    """Build the sole identity-bearing wire and ledger representation."""

    rank = int(hit["rank"])
    return WebRetrievalResultRef(
        type="web_result",
        id=snapshot_id,
        result_type="web_result",
        result_ref=ProviderResultRef(str(hit["result_ref"])),
        source_id=snapshot_id,
        title=str(hit["title"]),
        url=str(hit["url"]),
        display_url=str(hit["display_url"]),
        deep_link=str(hit["url"]),
        citation_target=f"external_snapshot:{snapshot_id}",
        locator=ExternalUrlLocator.model_validate(web_result_locator_json(hit)),
        snippet=str(hit["snippet"]),
        extra_snippets=[str(item) for item in hit["extra_snippets"]],
        published_at=hit["published_at"],
        source_name=hit["source_name"],
        rank=rank,
        provider=str(hit["provider"]),
        provider_request_id=hit["provider_request_id"],
        context_ref=RetrievalContextRef(type="web_result", id=snapshot_id),
        media_id=None,
        media_kind=None,
        score=1.0 / max(rank, 1),
        selected=selected,
    ).model_dump(mode="json", exclude_none=True, exclude_defaults=True)


__all__ = ["web_result_locator_json", "web_result_ref_json"]
