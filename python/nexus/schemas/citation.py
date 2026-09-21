"""The shared `[N]` citation read-model, built only by the resource graph."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from nexus.schemas.resource_items import ResourceActivationOut
from nexus.schemas.retrieval import RetrievalLocator
from nexus.services.resource_graph.schemas import EdgeKind

CitationRole = EdgeKind
CitationTargetType = Literal[
    "evidence_span",
    "content_chunk",
    "media",
    "highlight",
    "fragment",
    "page",
    "note_block",
    "message",
    "external_snapshot",
    "oracle_passage_anchor",
    "reader_apparatus_item",
]


class CitationTargetRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: CitationTargetType
    id: UUID


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
    activation: ResourceActivationOut
    # Hoisted out of the locator for the render href (not every locator variant
    # carries one; evidence-span citations always do).
    media_id: UUID | None = None
    locator: RetrievalLocator | None = None
    deep_link: str | None = None
    snapshot: CitationSnapshot | None = None
