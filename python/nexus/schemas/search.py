"""Search Pydantic schemas.

Contains request and response models for the search endpoint.
These schemas are introduced in Slice 3 (PR-06: Keyword Search).

Search returns mixed typed results from different content types:
- media (titles)
- fragments (canonical_text)
- annotations (body)
- messages (content)
"""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

# Valid search result types
SEARCH_RESULT_TYPES = Literal["media", "fragment", "annotation", "message"]

# Valid search scopes
SEARCH_SCOPE_PREFIXES = ("all", "media:", "library:", "conversation:")


# =============================================================================
# Response Schemas
# =============================================================================


class SearchResultOut(BaseModel):
    """Response schema for a single search result.

    Results are typed and include navigation fields based on type:
    - media: id, title (snippet source)
    - fragment: id, media_id, idx
    - annotation: id, highlight_id, media_id
    - message: id, conversation_id, seq
    """

    type: str  # "media" | "fragment" | "annotation" | "message"
    id: UUID
    score: float
    snippet: str

    # Navigation fields (presence depends on type)
    title: str | None = None  # media only
    media_id: UUID | None = None  # fragment, annotation
    idx: int | None = None  # fragment only
    highlight_id: UUID | None = None  # annotation only
    conversation_id: UUID | None = None  # message only
    seq: int | None = None  # message only

    model_config = ConfigDict(from_attributes=True)


class SearchPageInfo(BaseModel):
    """Pagination information for search results.

    Uses offset-based cursor encoded as base64url JSON.
    """

    has_more: bool = False
    next_cursor: str | None = None


class SearchResponse(BaseModel):
    """Response for search endpoint.

    Results are a mixed, ordered list of typed search results.
    """

    results: list[SearchResultOut] = Field(default_factory=list)
    page: SearchPageInfo = Field(default_factory=SearchPageInfo)
