"""Pydantic models for Black Forest Oracle endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

from nexus.schemas.citation import CitationOut

type OracleReadingStatus = Literal["pending", "streaming", "complete", "failed"]
type OracleReadingPhase = Literal["descent", "ordeal", "ascent"]
type OracleReadingSourceKind = Literal["user_media", "public_domain"]
type OracleFolioTheme = Literal[
    "Of Time",
    "Of Death",
    "Of the Threshold",
    "Of Vanity",
    "Of Solitude",
    "Of Love",
    "Of Fortune",
    "Of Memory",
    "Of the Self",
    "Of the Other",
    "Of Fear",
    "Of Courage",
    "Of Faith",
    "Of Doubt",
    "Of Power",
    "Of Wisdom",
    "Of the Body",
    "Of the Soul",
    "Of Origins",
    "Of Endings",
    "Of Silence",
    "Of the Word",
    "Of Justice",
    "Of Mercy",
]
type OracleReadingFailureCode = Literal[
    "auth",
    "quota",
    "timeout",
    "output_limit",
    "invalid_output",
    "policy_violation",
    "runtime_unavailable",
    "capacity_unavailable",
    "context_too_large",
    "cancelled",
    "E_ORACLE_CORPUS_NOT_READY",
    "E_APP_SEARCH_FAILED",
    "E_GENERATION_SOURCE_CHANGED",
    "E_RATE_LIMITED",
]
type HistoricalOracleReadingFailureCode = Literal[
    "defect",
    "E_INTERNAL",
    "E_BILLING_REQUIRED",
    "E_TOKEN_BUDGET_EXCEEDED",
    "budget_exceeded",
    "invalid_structured_output",
    "refused",
    "incomplete",
    "rate_limited",
    "provider_unavailable",
    "stream_interrupted",
]
type ReadOracleReadingFailureCode = OracleReadingFailureCode | HistoricalOracleReadingFailureCode
type OracleWritableEventType = Literal[
    "meta",
    "bind",
    "argument",
    "plate",
    "passage",
    "delta",
    "omens",
    "done",
]
type OracleReadingEventType = Literal[
    "meta",
    "bind",
    "argument",
    "plate",
    "passage",
    "delta",
    "omens",
    "done",
    "historical_done",
]

_ORACLE_FAILURE_CODE_ADAPTER: TypeAdapter[OracleReadingFailureCode] = TypeAdapter(
    OracleReadingFailureCode
)
_ORACLE_READ_FAILURE_CODE_ADAPTER: TypeAdapter[ReadOracleReadingFailureCode] = TypeAdapter(
    ReadOracleReadingFailureCode
)
_HISTORICAL_ORACLE_FAILURE_CODES = frozenset(
    {
        "defect",
        "E_INTERNAL",
        "E_BILLING_REQUIRED",
        "E_TOKEN_BUDGET_EXCEEDED",
        "budget_exceeded",
        "invalid_structured_output",
        "refused",
        "incomplete",
        "rate_limited",
        "provider_unavailable",
        "stream_interrupted",
    }
)
_ORACLE_STATUS_ADAPTER: TypeAdapter[OracleReadingStatus] = TypeAdapter(OracleReadingStatus)
_ORACLE_PHASE_ADAPTER: TypeAdapter[OracleReadingPhase] = TypeAdapter(OracleReadingPhase)
_ORACLE_SOURCE_KIND_ADAPTER: TypeAdapter[OracleReadingSourceKind] = TypeAdapter(
    OracleReadingSourceKind
)
_ORACLE_THEME_ADAPTER: TypeAdapter[OracleFolioTheme] = TypeAdapter(OracleFolioTheme)
_ORACLE_EVENT_TYPE_ADAPTER: TypeAdapter[OracleReadingEventType] = TypeAdapter(
    OracleReadingEventType
)


def oracle_reading_failure_code(value: str) -> OracleReadingFailureCode:
    """Narrow one persisted/product Oracle failure code at its owner boundary."""

    return _ORACLE_FAILURE_CODE_ADAPTER.validate_python(value)


def oracle_read_failure_code(value: str) -> ReadOracleReadingFailureCode:
    """Narrow a preserved or current Oracle failure at the database read edge."""

    return _ORACLE_READ_FAILURE_CODE_ADAPTER.validate_python(value)


def oracle_reading_status(value: str) -> OracleReadingStatus:
    return _ORACLE_STATUS_ADAPTER.validate_python(value)


def oracle_reading_phase(value: str) -> OracleReadingPhase:
    return _ORACLE_PHASE_ADAPTER.validate_python(value)


def oracle_reading_source_kind(value: str) -> OracleReadingSourceKind:
    return _ORACLE_SOURCE_KIND_ADAPTER.validate_python(value)


def oracle_folio_theme(value: str) -> OracleFolioTheme:
    return _ORACLE_THEME_ADAPTER.validate_python(value)


def oracle_reading_event_type(value: str) -> OracleReadingEventType:
    return _ORACLE_EVENT_TYPE_ADAPTER.validate_python(value)


class OracleReadingCreateRequest(BaseModel):
    """User-submitted divination question."""

    question: str = Field(min_length=1, max_length=280)
    model_config = ConfigDict(str_strip_whitespace=True)


class OracleReadingCreateResponse(BaseModel):
    """POST /oracle/readings response contract (clients stream via /stream-tokens)."""

    reading_id: UUID
    folio_number: int
    status: Literal["pending"]

    model_config = ConfigDict(extra="forbid")


class OracleCompleteDoneEventPayload(BaseModel):
    """Successful terminal payload; success never carries an error code."""

    status: Literal["complete"]
    error_code: None

    model_config = ConfigDict(extra="forbid", frozen=True)


class OracleFailedDoneEventPayload(BaseModel):
    """Expected product terminal payload; defects have no variant."""

    status: Literal["failed"]
    error_code: OracleReadingFailureCode

    model_config = ConfigDict(extra="forbid", frozen=True)


type OracleDoneEventPayload = OracleCompleteDoneEventPayload | OracleFailedDoneEventPayload
_ORACLE_DONE_ADAPTER: TypeAdapter[OracleDoneEventPayload] = TypeAdapter(OracleDoneEventPayload)


class HistoricalOracleFailedDoneEventPayload(BaseModel):
    """Migration-tagged replay of a pre-cutover failed reading."""

    status: Literal["failed"]
    error_code: HistoricalOracleReadingFailureCode

    model_config = ConfigDict(extra="forbid", frozen=True)


_HISTORICAL_ORACLE_DONE_ADAPTER: TypeAdapter[HistoricalOracleFailedDoneEventPayload] = TypeAdapter(
    HistoricalOracleFailedDoneEventPayload
)


def oracle_done_payload(
    *,
    status: Literal["complete", "failed"],
    error_code: OracleReadingFailureCode | None,
) -> dict[str, Any]:
    """Build the validated ``done`` payload for ``run_kit.mark_terminal``."""

    return _ORACLE_DONE_ADAPTER.validate_python(
        {"status": status, "error_code": error_code}
    ).model_dump(mode="json")


class OracleReadingSummaryOut(BaseModel):
    """All-readings list row (the Aleph)."""

    id: UUID
    folio_number: int
    folio_motto: str | None = None
    folio_motto_gloss: str | None = None
    folio_theme: OracleFolioTheme | None = None
    plate_thumbnail_url: str | None = None
    plate_alt_text: str | None = None
    question_text: str
    status: OracleReadingStatus
    created_at: datetime
    completed_at: datetime | None = None
    failed_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True, extra="forbid")


class OracleReadingPassageOut(BaseModel):
    """One persisted citation in a reading.

    ``citation`` is the read-model CitationOut when the persisted citation edge
    resolves to a live shared reader/note locator. Resolved public-domain anchors
    render the same chip path as user content; unresolved or span-less targets
    carry ``None`` and remain typographic only.
    """

    phase: OracleReadingPhase
    source_kind: OracleReadingSourceKind
    exact_snippet: str = Field(min_length=1)
    locator_label: str = Field(min_length=1)
    attribution_text: str = Field(min_length=1)
    marginalia_text: str = Field(min_length=1)
    deep_link: str | None = None
    citation: CitationOut | None = None

    model_config = ConfigDict(extra="forbid")


def oracle_passage_payload(
    *,
    phase: OracleReadingPhase,
    source_kind: OracleReadingSourceKind,
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
    width: int = Field(gt=0)
    height: int = Field(gt=0)

    model_config = ConfigDict(extra="forbid")


class OracleMetaEventPayload(BaseModel):
    question: str = Field(min_length=1, max_length=280)
    folio_number: int = Field(gt=0)

    model_config = ConfigDict(extra="forbid")


class OracleBindEventPayload(BaseModel):
    folio_motto: str = Field(min_length=1, max_length=80)
    folio_motto_gloss: str | None = Field(default=None, min_length=1, max_length=120)
    folio_theme: OracleFolioTheme

    model_config = ConfigDict(extra="forbid")


class OracleTextEventPayload(BaseModel):
    text: str = Field(min_length=1)

    model_config = ConfigDict(extra="forbid")


class OracleOmensEventPayload(BaseModel):
    lines: tuple[str, str, str]

    model_config = ConfigDict(extra="forbid")


_ORACLE_CURRENT_EVENT_PAYLOAD_ADAPTERS: dict[OracleWritableEventType, TypeAdapter[Any]] = {
    "meta": TypeAdapter(OracleMetaEventPayload),
    "bind": TypeAdapter(OracleBindEventPayload),
    "argument": TypeAdapter(OracleTextEventPayload),
    "plate": TypeAdapter(OracleReadingImageOut),
    "passage": TypeAdapter(OracleReadingPassageOut),
    "delta": TypeAdapter(OracleTextEventPayload),
    "omens": TypeAdapter(OracleOmensEventPayload),
    "done": _ORACLE_DONE_ADAPTER,
}

_ORACLE_READ_EVENT_PAYLOAD_ADAPTERS: dict[OracleReadingEventType, TypeAdapter[Any]] = {
    **_ORACLE_CURRENT_EVENT_PAYLOAD_ADAPTERS,
    "historical_done": _HISTORICAL_ORACLE_DONE_ADAPTER,
}


def oracle_event_payload(
    event_type: OracleWritableEventType,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Validate one current event before persistence."""

    return (
        _ORACLE_CURRENT_EVENT_PAYLOAD_ADAPTERS[event_type]
        .validate_python(payload)
        .model_dump(mode="json")
    )


def oracle_read_event_payload(
    event_type: OracleReadingEventType,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Validate one current or migration-tagged event at replay ingress."""

    return (
        _ORACLE_READ_EVENT_PAYLOAD_ADAPTERS[event_type]
        .validate_python(payload)
        .model_dump(mode="json")
    )


class OracleReadingEventOut(BaseModel):
    """One persisted SSE replay event."""

    seq: int = Field(ge=1)
    event_type: OracleReadingEventType
    payload: dict[str, Any]

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_payload(self) -> OracleReadingEventOut:
        self.payload = oracle_read_event_payload(self.event_type, self.payload)
        return self


class OracleReadingDetailOut(BaseModel):
    """Full reading record returned from REST + first-paint hydration."""

    id: UUID
    folio_number: int
    folio_motto: str | None = None
    folio_motto_gloss: str | None = None
    folio_theme: OracleFolioTheme | None = None
    argument_text: str | None = None
    question_text: str
    status: OracleReadingStatus
    image: OracleReadingImageOut | None = None
    passages: list[OracleReadingPassageOut] = Field(default_factory=list)
    events: list[OracleReadingEventOut] = Field(default_factory=list)
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    failed_at: datetime | None = None
    error_code: ReadOracleReadingFailureCode | None = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_terminal_facts(self) -> OracleReadingDetailOut:
        if self.status == "failed" and (self.error_code is None or self.failed_at is None):
            raise ValueError("failed Oracle reading requires failure facts")
        if self.status != "failed" and self.error_code is not None:
            raise ValueError("non-failed Oracle reading carries a failure code")
        if self.status == "complete" and self.completed_at is None:
            raise ValueError("complete Oracle reading requires completed_at")
        for expected_seq, event in enumerate(self.events, start=1):
            if event.seq != expected_seq:
                raise ValueError("Oracle reading events must be contiguous from one")
        terminal = self.events[-1] if self.events else None
        if self.status == "complete":
            if (
                terminal is None
                or terminal.event_type != "done"
                or terminal.payload != oracle_done_payload(status="complete", error_code=None)
            ):
                raise ValueError("complete Oracle reading requires its terminal done event")
        elif self.status == "failed":
            error_code = self.error_code
            if error_code is None:
                raise ValueError("failed Oracle reading requires an error code")
            expected_type = (
                "historical_done" if error_code in _HISTORICAL_ORACLE_FAILURE_CODES else "done"
            )
            if (
                terminal is None
                or terminal.event_type != expected_type
                or terminal.payload.get("status") != "failed"
                or terminal.payload.get("error_code") != error_code
            ):
                raise ValueError("failed Oracle reading disagrees with its terminal event")
        elif any(event.event_type in {"done", "historical_done"} for event in self.events):
            raise ValueError("non-terminal Oracle reading carries a terminal event")
        return self


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
