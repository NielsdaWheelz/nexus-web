"""Wire for link target search. Candidate refs are reloaded at link confirmation."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.resource_items import ResourceItemOut


class ResourceTargetSearchRequest(BaseModel):
    q: str
    source_ref: str | None = None
    exclude_refs: list[str] = Field(default_factory=list, max_length=200)
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
