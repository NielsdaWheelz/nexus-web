"""Wire schemas for ``POST /resource-items/targets/search``.

Resource-target search (universal-link-authoring-hard-cutover.md, Resource
Target Search): one request shape for both the ``purpose=link`` hybrid profile
and the ``purpose=reference`` lexical profile, and a two-variant target union.
``candidate_ref`` on a passage target is transient — derived from the underlying
index row id, reloaded at Link confirmation, and never persisted. ``excerpt``
keeps the search snippet conventions (``<b>…</b>`` match markup).
"""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from nexus.schemas.resource_items import ResourceActivationOut, ResourceItemOut
from nexus.services.resource_graph.refs import ResourceScheme


class ResourceTargetSearchRequest(BaseModel):
    q: str
    purpose: Literal["link", "reference"]
    source_ref: str | None = Field(
        None,
        validation_alias=AliasChoices("source_ref", "sourceRef"),
        serialization_alias="sourceRef",
    )
    schemes: list[ResourceScheme] | None = None
    exclude_refs: list[str] = Field(
        default_factory=list,
        validation_alias=AliasChoices("exclude_refs", "excludeRefs"),
        serialization_alias="excludeRefs",
    )
    cursor: str | None = None
    limit: int = Field(10, ge=1, le=20)

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ResourceTargetResourceOut(BaseModel):
    kind: Literal["resource"] = "resource"
    item: ResourceItemOut
    existing_link_id: UUID | None = Field(
        None,
        validation_alias=AliasChoices("existing_link_id", "existingLinkId"),
        serialization_alias="existingLinkId",
    )

    model_config = ConfigDict(populate_by_name=True)


class ResourceTargetPassageOut(BaseModel):
    kind: Literal["passage"] = "passage"
    candidate_ref: str = Field(
        validation_alias=AliasChoices("candidate_ref", "candidateRef"),
        serialization_alias="candidateRef",
    )
    source: ResourceItemOut
    label: str
    excerpt: str
    activation: ResourceActivationOut
    existing_link_id: UUID | None = Field(
        None,
        validation_alias=AliasChoices("existing_link_id", "existingLinkId"),
        serialization_alias="existingLinkId",
    )

    model_config = ConfigDict(populate_by_name=True)


ResourceTargetOut = Annotated[
    ResourceTargetResourceOut | ResourceTargetPassageOut,
    Field(discriminator="kind"),
]


class ResourceTargetSearchResponse(BaseModel):
    targets: list[ResourceTargetOut]
    next_cursor: str | None = Field(
        None,
        validation_alias=AliasChoices("next_cursor", "nextCursor"),
        serialization_alias="nextCursor",
    )

    model_config = ConfigDict(populate_by_name=True)
