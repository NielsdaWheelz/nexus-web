"""Media and Fragment Pydantic schemas.

Contains response models for media and fragments endpoints.
All schemas must match s0_spec.md exactly.
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class CapabilitiesOut(BaseModel):
    """Derived capabilities for a media item.

    Determines what actions a viewer can perform on a media item.
    Derived from media.kind, processing_status, last_error_code, and related data.
    """

    can_read: bool
    can_highlight: bool
    can_quote: bool
    can_search: bool
    can_play: bool
    can_download_file: bool


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
    failure_stage: str | None = None
    last_error_code: str | None = None
    capabilities: CapabilitiesOut
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


# =============================================================================
# Upload / Ingest Schemas
# =============================================================================


class UploadInitRequest(BaseModel):
    """Request schema for POST /media/upload/init."""

    kind: Literal["pdf", "epub"]
    filename: str = Field(min_length=1, max_length=255)
    content_type: str
    size_bytes: int = Field(gt=0)


class UploadInitResponse(BaseModel):
    """Response schema for POST /media/upload/init."""

    media_id: str
    storage_path: str
    token: str
    expires_at: str


class IngestResponse(BaseModel):
    """Response schema for POST /media/{id}/ingest."""

    media_id: str
    duplicate: bool


class FileDownloadResponse(BaseModel):
    """Response schema for GET /media/{id}/file."""

    url: str
    expires_at: str
