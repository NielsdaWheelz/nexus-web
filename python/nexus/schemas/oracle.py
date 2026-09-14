"""Pydantic models for Black Forest Oracle endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.citation import CitationOut


class OracleReadingCreateRequest(BaseModel):
    """User-submitted divination question."""

    question: str = Field(min_length=1, max_length=280)
    model_config = ConfigDict(str_strip_whitespace=True)


class OracleReadingCreateResponse(BaseModel):
    """POST /oracle/readings response contract (clients stream via /stream-tokens)."""

    reading_id: UUID
    folio_number: int
    status: str


class OracleDoneEventPayload(BaseModel):
    """Strict payload of the one terminal ``done`` event (normalized grammar)."""

    status: Literal["complete", "failed"]
    error_code: str | None = None

    model_config = ConfigDict(extra="forbid")


def oracle_done_payload(
    *, status: Literal["complete", "failed"], error_code: str | None
) -> dict[str, Any]:
    """Build the validated ``done`` payload for ``run_kit.mark_terminal``."""
    return OracleDoneEventPayload(status=status, error_code=error_code).model_dump(mode="json")


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
    """One persisted citation in a reading.

    ``citation`` is the read-model CitationOut when the persisted citation edge
    resolves to a live shared reader/note locator. Resolved public-domain anchors
    render the same chip path as user content; unresolved or span-less targets
    carry ``None`` and remain typographic only.
    """

    phase: str
    source_kind: str
    exact_snippet: str
    locator_label: str
    attribution_text: str
    marginalia_text: str
    deep_link: str | None = None
    citation: CitationOut | None = None


def oracle_passage_payload(
    *,
    phase: str,
    source_kind: str,
    exact_snippet: str,
    locator_label: str,
    attribution_text: str,
    marginalia_text: str,
    deep_link: str | None,
    citation: CitationOut | None,
) -> dict[str, Any]:
    """Build the ``passage`` event payload for ``run_kit.append_event``.

    The streamed payload is byte-identical to the REST ``OracleReadingPassageOut``;
    that out model is its sole shape owner.
    """
    return OracleReadingPassageOut(
        phase=phase,
        source_kind=source_kind,
        exact_snippet=exact_snippet,
        locator_label=locator_label,
        attribution_text=attribution_text,
        marginalia_text=marginalia_text,
        deep_link=deep_link,
        citation=citation,
    ).model_dump(mode="json")


class OracleReadingImageOut(BaseModel):
    """Plate displayed atop a reading."""

    url: str
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


class ConcordanceEntryOut(BaseModel):
    """One prior folio that echoes the current reading."""

    id: UUID
    folio_number: int
    folio_motto: str
    folio_theme: str | None
    shared_plate: bool
    shared_theme: bool
    shared_passage_count: int


class OracleCorpusStatusOut(BaseModel):
    """Read-only Oracle Corpus library readiness for discovery/inspection surfaces."""

    library_ref: str | None
    library_id: UUID | None
    status: str
    work_count: int
    ready_media_count: int
    anchor_count: int
    resolved_anchor_count: int
    plate_count: int
    ready_plate_count: int
