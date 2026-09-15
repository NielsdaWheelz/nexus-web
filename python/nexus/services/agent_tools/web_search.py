"""Nexus identity projection for canonical public Web search results.

The portable provider request and result contract lives in :mod:`llm_tools`;
durable dispatch and selection live in :mod:`nexus.services.tool_runtime`.
This module retains only the Nexus-owned conversion from provider telemetry to
an application-owned external-snapshot citation identity.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from nexus.schemas.retrieval import (
    ExternalSnapshotId,
    ExternalUrlLocator,
    ProviderResultRef,
    RetrievalContextRef,
    WebRetrievalResultRef,
    retrieval_locator_json,
)


@dataclass(frozen=True, slots=True)
class PersistedWebSearchCitation:
    """Canonical Web citation after Nexus has minted its resource identity."""

    external_snapshot_id: ExternalSnapshotId
    provider_result_ref: ProviderResultRef
    title: str
    url: str
    display_url: str
    snippet: str
    extra_snippets: tuple[str, ...]
    published_at: str | None
    source_name: str | None
    rank: int
    provider: str
    provider_request_id: str | None
    selected: bool

    def locator_json(self) -> dict[str, Any]:
        locator = retrieval_locator_json(
            {
                "type": "external_url",
                "url": self.url,
                "title": self.title,
                "display_url": self.display_url,
            }
        )
        if locator is None:
            raise AssertionError("persisted Web citation is missing external_url locator")
        return locator

    def retrieval_result_ref(self) -> WebRetrievalResultRef:
        """Build the sole identity-bearing wire and ledger representation."""

        snapshot_id = self.external_snapshot_id
        return WebRetrievalResultRef(
            type="web_result",
            id=snapshot_id,
            result_type="web_result",
            result_ref=self.provider_result_ref,
            source_id=snapshot_id,
            title=self.title,
            url=self.url,
            display_url=self.display_url,
            deep_link=self.url,
            citation_target=f"external_snapshot:{snapshot_id}",
            locator=ExternalUrlLocator.model_validate(self.locator_json()),
            snippet=self.snippet,
            extra_snippets=list(self.extra_snippets),
            published_at=self.published_at,
            source_name=self.source_name,
            rank=self.rank,
            provider=self.provider,
            provider_request_id=self.provider_request_id,
            context_ref=RetrievalContextRef(type="web_result", id=snapshot_id),
            media_id=None,
            media_kind=None,
            score=1.0 / max(self.rank, 1),
            selected=self.selected,
        )

    def retrieval_result_ref_json(self) -> dict[str, Any]:
        return self.retrieval_result_ref().model_dump(
            mode="json",
            exclude_none=True,
            exclude_defaults=True,
        )
