"""Wire contract for bounded, route-only openable-resource search."""

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.presence import Presence, Present
from nexus.schemas.resource_items import ResourceItemOut
from nexus.services.resource_graph.refs import ResourceScheme

OpenableSchemes = Annotated[list[ResourceScheme], Field(min_length=1)]


class ResourceOpenableSearchRequest(BaseModel):
    q: str = Field(min_length=1, max_length=500)
    schemes: Presence[OpenableSchemes]

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    @model_validator(mode="after")
    def validate_unique_schemes(self) -> ResourceOpenableSearchRequest:
        if isinstance(self.schemes, Present) and len(set(self.schemes.value)) != len(
            self.schemes.value
        ):
            raise ValueError("schemes must not contain duplicates")
        return self


class ResourceOpenableSearchResponse(BaseModel):
    items: list[ResourceItemOut]

    model_config = ConfigDict(extra="forbid")
