"""Shared citation read-model.

The wire contract for the `[N]` citation jump is pinned here, and the backend
is the sole producer of the shape. ``retrieval_citation.build_citation_outs_for_revision``
builds these from ``library_intelligence_citations``;
``retrieval_citation.build_citation_outs_for_message`` builds the identical shape
from a chat assistant message's ``message_retrievals``. The frontend renders
``CitationOut`` directly and no longer constructs it.
"""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from nexus.schemas.retrieval import RetrievalLocator

CitationRole = Literal["supports", "contradicts", "context"]
CitationTargetType = Literal["evidence_span", "content_chunk", "media", "web_result"]


class CitationTargetRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: CitationTargetType
    # ``web_result`` targets key on the durable retrieval-row id (a string), every
    # other target on a UUID.
    id: UUID | str


class CitationSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    excerpt: str | None = None
    section_label: str | None = None
    result_type: str | None = None
    summary_md: str | None = None


class CitationOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ordinal: int
    role: CitationRole
    target_ref: CitationTargetRef
    # Hoisted out of the locator for the render href (not every locator variant
    # carries one; evidence-span citations always do).
    media_id: UUID | None = None
    locator: RetrievalLocator | None = None
    deep_link: str | None = None
    snapshot: CitationSnapshot | None = None
