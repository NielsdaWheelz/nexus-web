"""Wire schemas for ``POST /resource-items/targets/search``, camelCase on the wire.

One request shape covers the ``link`` hybrid profile and the ``reference`` lexical
profile. A passage target's ``candidate_ref`` is transient — derived from the index row,
reloaded at Link confirmation, never persisted — and ``excerpt`` keeps the search
snippet's ``<b>…</b>`` match markup.
"""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import ConfigDict, Field

from nexus.schemas.resource_items import CamelModel, ResourceActivationOut, ResourceItemOut
from nexus.services.resource_graph.refs import ResourceScheme


class ResourceTargetSearchRequest(CamelModel):
    q: str
    purpose: Literal["link", "reference"]
    source_ref: str | None = None
    schemes: list[ResourceScheme] | None = None
    exclude_refs: list[str] = Field(default_factory=list)
    cursor: str | None = None
    limit: int = Field(10, ge=1, le=20)

    model_config = ConfigDict(extra="forbid")


class ResourceTargetResourceOut(CamelModel):
    kind: Literal["resource"] = "resource"
    item: ResourceItemOut
    existing_link_id: UUID | None = None


class ResourceTargetPassageOut(CamelModel):
    kind: Literal["passage"] = "passage"
    candidate_ref: str
    source: ResourceItemOut
    label: str
    excerpt: str
    activation: ResourceActivationOut
    existing_link_id: UUID | None = None


ResourceTargetOut = Annotated[
    ResourceTargetResourceOut | ResourceTargetPassageOut,
    Field(discriminator="kind"),
]


class ResourceTargetSearchResponse(CamelModel):
    targets: list[ResourceTargetOut]
    next_cursor: str | None = None
