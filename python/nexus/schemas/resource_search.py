"""Wire for ``POST /resource-items/targets/search`` and ``/openables/search``.

A passage target's ``candidate_ref`` is transient (derived from the index row, reloaded at
Link confirmation, never persisted); its ``excerpt`` keeps the snippet's ``<b>`` markup.
"""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.resource_items import ResourceItemOut
from nexus.services.resource_graph.refs import ResourceScheme


class ResourceTargetSearchRequest(BaseModel):
    q: str
    source_ref: str | None = None
    exclude_refs: list[str] = Field(default_factory=list)
    cursor: str | None = None

    model_config = ConfigDict(extra="forbid")


class ResourceTargetResourceOut(BaseModel):
    kind: Literal["resource"] = "resource"
    item: ResourceItemOut
    existing_link_id: UUID | None


class ResourceTargetPassageOut(BaseModel):
    kind: Literal["passage"] = "passage"
    candidate_ref: str
    item: ResourceItemOut
    existing_link_id: UUID | None


ResourceTargetOut = Annotated[
    ResourceTargetResourceOut | ResourceTargetPassageOut, Field(discriminator="kind")
]


class ResourceTargetSearchResponse(BaseModel):
    targets: list[ResourceTargetOut]
    next_cursor: str | None


class ResourceOpenableSearchRequest(BaseModel):
    q: str = Field(min_length=1, max_length=500)
    schemes: Annotated[list[ResourceScheme], Field(min_length=1)] | None

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    @model_validator(mode="after")
    def validate_unique_schemes(self) -> ResourceOpenableSearchRequest:
        if self.schemes is not None and len(set(self.schemes)) != len(self.schemes):
            raise ValueError("schemes must not contain duplicates")
        return self


class ResourceOpenableSearchResponse(BaseModel):
    items: list[ResourceItemOut]

    model_config = ConfigDict(extra="forbid")
