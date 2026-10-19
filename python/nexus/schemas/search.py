"""Browser discovery: resources with evidence, or individual passage occurrences."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.resource_items import ExcerptOut, ResourceItemOut
from nexus.schemas.search_types import SearchPageInfo

SemanticStatus = Literal["not_requested", "used", "unavailable"]
MatchMethod = Literal["lexical", "semantic"]
NameMatch = Literal["exact", "prefix", "substring"]
SearchView = Literal["resources", "passages"]
PreviewPhase = Literal["direct", "content"]


class SearchMatchRangeOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: int
    end: int


class SearchMatchOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    excerpt: ExcerptOut
    ranges: list[SearchMatchRangeOut]


class SearchOccurrenceOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    item: ResourceItemOut
    match: SearchMatchOut | None
    match_method: MatchMethod


class SearchResourceOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    section: Literal["primary", "saved", "inside"]
    item: ResourceItemOut
    name_match: NameMatch | None
    match: SearchMatchOut | None
    match_method: MatchMethod | None
    matching_passage: SearchOccurrenceOut | None


class SearchPreviewResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    resources: list[SearchResourceOut] = Field(max_length=4)
    saved: list[SearchResourceOut] = Field(max_length=2)
    passages: list[SearchOccurrenceOut] = Field(max_length=2)
    semantic_status: SemanticStatus


class SearchResourcesResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    view: Literal["resources"] = "resources"
    results: list[SearchResourceOut]
    page: SearchPageInfo
    semantic_status: SemanticStatus


class SearchPassagesResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    view: Literal["passages"] = "passages"
    results: list[SearchOccurrenceOut]
    page: SearchPageInfo
    semantic_status: SemanticStatus


SearchResponse = Annotated[
    SearchResourcesResponse | SearchPassagesResponse, Field(discriminator="view")
]
