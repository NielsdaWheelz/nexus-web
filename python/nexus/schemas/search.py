"""Bounded public search hits. Retrieval facts stay at the search candidate owner."""

from uuid import UUID

from pydantic import BaseModel, ConfigDict

from nexus.schemas.resource_items import ExcerptOut, ResourceItemOut
from nexus.schemas.retrieval import RetrievalLocator
from nexus.schemas.search_types import (
    SEARCH_RESULT_TYPES,
    SearchPageInfo,
    SearchResultContextRefOut,
)


class SearchMatchRangeOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: int
    end: int


class SearchMatchOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    excerpt: ExcerptOut
    ranges: list[SearchMatchRangeOut]


class SearchResultOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: SEARCH_RESULT_TYPES
    id: UUID | str
    score: float
    item: ResourceItemOut
    match: SearchMatchOut | None
    context_ref: SearchResultContextRefOut
    locator: RetrievalLocator | None
    citation_target: str | None


class SearchResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    results: list[SearchResultOut]
    page: SearchPageInfo
