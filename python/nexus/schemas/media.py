"""Media and Fragment Pydantic schemas.

Contains response models for media and fragments endpoints.
All schemas must match s0_spec.md exactly.
"""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class MediaOut(BaseModel):
    """Response schema for media.

    Note: `author` is NOT included. The media schema does not have an
    `author` column in S0. Authors are added in S2 with metadata extraction.
    """

    id: UUID
    kind: str  # "web_article", "epub", "pdf", "podcast_episode", "video"
    title: str
    canonical_source_url: str | None
    processing_status: str  # "pending", "extracting", "ready_for_reading", etc.
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class FragmentOut(BaseModel):
    """Response schema for fragment.

    Contains the sanitized HTML and canonical text for a media fragment.
    """

    id: UUID
    media_id: UUID
    idx: int
    html_sanitized: str
    canonical_text: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
