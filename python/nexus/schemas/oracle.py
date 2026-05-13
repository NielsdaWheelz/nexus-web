"""Pydantic models for Black Forest Oracle endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class OracleReadingCreateRequest(BaseModel):
    """User-submitted divination question."""

    question: str = Field(min_length=1, max_length=280)
    model_config = ConfigDict(str_strip_whitespace=True)


class OracleStreamConnectionOut(BaseModel):
    """Direct SSE connection data returned with a newly created reading."""

    token: str
    stream_base_url: str
    event_url: str
    expires_at: str


class OracleReadingCreateResponse(BaseModel):
    """POST /oracle/readings response contract."""

    reading_id: UUID
    folio_number: int
    status: str
    stream: OracleStreamConnectionOut


class OracleReadingSummaryOut(BaseModel):
    """All-readings list row (the Aleph)."""

    id: UUID
    folio_number: int
    folio_motto: str | None = None
    folio_motto_gloss: str | None = None
    folio_theme: str | None = None
    plate_thumbnail_url: str | None = None
    plate_alt_text: str | None = None
    question_text: str
    status: str
    created_at: datetime
    completed_at: datetime | None = None
    failed_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class OracleReadingPassageOut(BaseModel):
    """One persisted citation in a reading."""

    phase: str
    source_kind: str
    source_ref: dict[str, Any]
    exact_snippet: str
    locator_label: str
    attribution_text: str
    marginalia_text: str
    deep_link: str | None = None


class OracleReadingImageOut(BaseModel):
    """Plate displayed atop a reading."""

    source_url: str
    attribution_text: str
    artist: str
    work_title: str
    year: str | None = None
    width: int
    height: int


class OracleReadingEventOut(BaseModel):
    """One persisted SSE replay event."""

    seq: int
    event_type: str
    payload: dict[str, Any]


class OracleReadingDetailOut(BaseModel):
    """Full reading record returned from REST + first-paint hydration."""

    id: UUID
    folio_number: int
    folio_motto: str | None = None
    folio_motto_gloss: str | None = None
    folio_theme: str | None = None
    argument_text: str | None = None
    question_text: str
    status: str
    image: OracleReadingImageOut | None = None
    passages: list[OracleReadingPassageOut] = Field(default_factory=list)
    events: list[OracleReadingEventOut] = Field(default_factory=list)
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    failed_at: datetime | None = None
    error_code: str | None = None
    error_message: str | None = None


class ConcordanceEntryOut(BaseModel):
    """One prior folio that echoes the current reading."""

    id: UUID
    folio_number: int
    folio_motto: str
    folio_theme: str | None
    shared_plate: bool
    shared_theme: bool
    shared_passage_count: int
