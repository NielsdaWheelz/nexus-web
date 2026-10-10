"""The shared ``[N]`` citation read model, built only by the resource graph."""

from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel, ConfigDict

from nexus.schemas.resource_graph import EdgeKind
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.schemas.retrieval import RetrievalLocator
from nexus.services.resource_graph.refs import ResourceScheme

CitationRole = EdgeKind
# The writer admits any visible target, so the read model names every scheme.
CitationTargetType = ResourceScheme


class CitationTargetRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: CitationTargetType
    id: UUID


class CitationSnapshotOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None
    excerpt: str | None
    section_label: str | None
    result_type: str | None
    summary_md: str | None


class CitationOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ordinal: int
    role: CitationRole
    target_ref: CitationTargetRef
    activation: ResourceActivationOut
    # Hoisted out of the locator for the render href (not every locator variant
    # carries one; evidence-span citations always do).
    media_id: UUID | None
    locator: RetrievalLocator | None
    deep_link: str | None
    snapshot: CitationSnapshotOut | None
