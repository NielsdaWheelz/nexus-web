"""Owned value types for import history (`imports-workspace-hard-cutover.md`).

Two append-only tables record what happened to one import: `media_upload_events`
for an upload session and `media_processing_events` for a media's source and
content-index work. Each row carries an indexed envelope (owner, `occurred_at`,
`event_type`, nullable `stage`/`failure_code`) plus a closed typed `payload`
holding only that variant's own facts.

This module owns that vocabulary end to end: the pipeline `Stage`, the closed
`EventType`, the `SafeFailureCode` catalog, every facts variant, and the storage
codec both directions. `services/import_history.py` is the only writer and the
only reader; nothing else decodes a payload dictionary.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Annotated, Final, Literal, cast, get_args
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from nexus.schemas.media import UploadTransportFailure, UploadVerificationFailureCode
from nexus.schemas.presence import Presence

Stage = Literal["Upload", "Validate", "Extract", "Finalize", "Index", "SourceProcessing"]

STAGE_RANK: dict[Stage, int] = {
    "Upload": 0,
    "Validate": 1,
    "Extract": 2,
    "Finalize": 3,
    "SourceProcessing": 4,
    "Index": 5,
}
"""Pipeline order, used to group and rank attention rows."""

EventType = Literal[
    "Accepted",
    "ExecutionStarted",
    "StageChanged",
    "RetryScheduled",
    "Failed",
    "RecoveryAccepted",
    "Published",
    "Succeeded",
    "Superseded",
    "HistoryBaseline",
]

FailureOrigin = Literal["Execution", "Domain"]

_OWNER_FAILURE_CODES = Literal[
    "E_ARCHIVE_UNSAFE",
    "E_BILLING_REQUIRED",
    "E_CAPTURE_TOO_LARGE",
    "E_FORBIDDEN",
    "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH",
    "E_INGEST_FAILED",
    "E_INGEST_TIMEOUT",
    "E_INTERNAL",
    "E_INVALID_CONTENT_TYPE",
    "E_INVALID_KIND",
    "E_INVALID_REQUEST",
    "E_MEDIA_NOT_FOUND",
    "E_MEDIA_NOT_READY",
    "E_PDF_PASSWORD_REQUIRED",
    "E_PDF_TEXT_UNAVAILABLE",
    "E_PODCAST_PROVIDER_UNAVAILABLE",
    "E_PODCAST_QUOTA_EXCEEDED",
    "E_RESOURCE_LIMIT",
    "E_RETRY_INVALID_STATE",
    "E_RETRY_NOT_ALLOWED",
    "E_SANITIZATION_FAILED",
    "E_SELECTION_CHANGED",
    "E_SIGN_UPLOAD_FAILED",
    "E_SOURCE_ACCESS_DENIED",
    "E_SOURCE_FETCH_FAILED",
    "E_SOURCE_NOT_READABLE",
    "E_SOURCE_TOO_LARGE",
    "E_SSRF_BLOCKED",
    "E_STORAGE_ERROR",
    "E_STORAGE_MISSING",
    "E_TRANSCRIPTION_FAILED",
    "E_TRANSCRIPTION_TIMEOUT",
    "E_TRANSCRIPT_UNAVAILABLE",
    "E_UPLOAD_CAPABILITY_EXPIRED",
    "E_UPLOAD_TRANSPORT_FAILED",
    "E_WORKER_HANDLER_FAILED",
    "E_WORKER_INTERRUPTED",
    "E_X_POST_UNAVAILABLE",
    "E_X_PROVIDER_AUTH_REJECTED",
    "E_X_PROVIDER_CREDITS_DEPLETED",
    "E_X_PROVIDER_RATE_LIMITED",
    "E_X_PROVIDER_TIMEOUT",
    "E_X_PROVIDER_UNAVAILABLE",
]

SafeFailureCode = UploadVerificationFailureCode | _OWNER_FAILURE_CODES
"""Every failure code an import may show a reader.

Composed from the upload-verification alias plus the codes the source-ingest
adapters, the object store, and the queue actually record, so widening either
owner is a type error here. It names every value the trusted columns hold,
including `E_PDF_TEXT_UNAVAILABLE`, which a ready PDF carries on
`media.last_error_code` without having failed. Raw provider text, signed URLs
and source content never reach history.
"""

SAFE_FAILURE_CODES: frozenset[str] = frozenset(
    (*get_args(UploadVerificationFailureCode), *get_args(_OWNER_FAILURE_CODES))
)


def assume_safe_failure_code(raw: str) -> SafeFailureCode:
    """Narrow a trusted failure column (`media_source_attempts.error_code`,
    `media_upload_sessions.verification_error_code`, `media.last_error_code`)."""
    if raw not in SAFE_FAILURE_CODES:
        # justify-defect: a kernel proof scans every module that writes those columns
        # for the codes it writes, and migration 0225 rejects a database holding one
        # this catalog does not name.
        raise AssertionError(f"uncatalogued import failure code {raw!r}")
    return cast(SafeFailureCode, raw)


def queue_failure_code(raw: str) -> SafeFailureCode:
    """Total mapping for the queue seam: recording history must never abort a
    queue transition, so an execution code outside the catalog becomes the
    generic handler failure. The raw code stays on `background_jobs.error_code`."""
    if raw not in SAFE_FAILURE_CODES:
        return "E_WORKER_HANDLER_FAILED"
    return cast(SafeFailureCode, raw)


class _HistoryModel(BaseModel):
    """Every persisted or exposed history value is closed in both directions."""

    model_config = ConfigDict(extra="forbid")


class UploadAccepted(_HistoryModel):
    kind: Literal["UploadAccepted"] = "UploadAccepted"
    generation: int


class UploadExecutionStarted(_HistoryModel):
    kind: Literal["UploadExecutionStarted"] = "UploadExecutionStarted"
    generation: int


class UploadFailed(_HistoryModel):
    """Transport Present is a client-reported upload failure; Absent is a
    server-side verification rejection whose code is on the envelope."""

    kind: Literal["UploadFailed"] = "UploadFailed"
    generation: int
    transport: Presence[UploadTransportFailure]


class UploadRecoveryAccepted(_HistoryModel):
    kind: Literal["UploadRecoveryAccepted"] = "UploadRecoveryAccepted"
    generation: int


class UploadPublished(_HistoryModel):
    kind: Literal["UploadPublished"] = "UploadPublished"
    generation: int
    media_id: UUID
    source_attempt_id: UUID


class UploadHistoryBaseline(_HistoryModel):
    kind: Literal["UploadHistoryBaseline"] = "UploadHistoryBaseline"
    generation: int


UploadFacts = Annotated[
    UploadAccepted
    | UploadExecutionStarted
    | UploadFailed
    | UploadRecoveryAccepted
    | UploadPublished
    | UploadHistoryBaseline,
    Field(discriminator="kind"),
]


class SourceFailureProgress(_HistoryModel):
    completed: int
    total: Presence[int]
    unit: Presence[str]


class RetrySourceRecovery(_HistoryModel):
    kind: Literal["RetrySource"] = "RetrySource"
    new_source_attempt_id: UUID


class RepairSourceRecovery(_HistoryModel):
    kind: Literal["RepairSource"] = "RepairSource"
    job_id: UUID


SourceRecovery = Annotated[RetrySourceRecovery | RepairSourceRecovery, Field(discriminator="kind")]


class SucceededSourceBaselineOutcome(_HistoryModel):
    kind: Literal["Succeeded"] = "Succeeded"


class FailedSourceBaselineOutcome(_HistoryModel):
    kind: Literal["Failed"] = "Failed"
    failure_code: SafeFailureCode


class InFlightSourceBaselineOutcome(_HistoryModel):
    kind: Literal["InFlight"] = "InFlight"


SourceBaselineOutcome = Annotated[
    SucceededSourceBaselineOutcome | FailedSourceBaselineOutcome | InFlightSourceBaselineOutcome,
    Field(discriminator="kind"),
]


class SourceAccepted(_HistoryModel):
    kind: Literal["SourceAccepted"] = "SourceAccepted"
    source_attempt_id: UUID
    attempt_no: int


class SourceExecutionStarted(_HistoryModel):
    kind: Literal["SourceExecutionStarted"] = "SourceExecutionStarted"
    source_attempt_id: UUID
    execution_id: UUID


class SourceStageChanged(_HistoryModel):
    kind: Literal["SourceStageChanged"] = "SourceStageChanged"
    source_attempt_id: UUID
    execution_id: UUID


class SourceRetryScheduled(_HistoryModel):
    kind: Literal["SourceRetryScheduled"] = "SourceRetryScheduled"
    source_attempt_id: UUID
    execution_id: Presence[UUID]
    next_attempt_at: datetime


class SourceFailed(_HistoryModel):
    kind: Literal["SourceFailed"] = "SourceFailed"
    source_attempt_id: UUID
    execution_id: Presence[UUID]
    origin: FailureOrigin
    terminal: bool
    progress: Presence[SourceFailureProgress]


class SourceRecoveryAccepted(_HistoryModel):
    kind: Literal["SourceRecoveryAccepted"] = "SourceRecoveryAccepted"
    source_attempt_id: UUID
    recovery: SourceRecovery


class SourceSucceeded(_HistoryModel):
    """`execution_id` is Absent for an attempt born succeeded and for an
    execution that predates the execution-identity cut."""

    kind: Literal["SourceSucceeded"] = "SourceSucceeded"
    source_attempt_id: UUID
    execution_id: Presence[UUID]


class SourceSuperseded(_HistoryModel):
    kind: Literal["SourceSuperseded"] = "SourceSuperseded"
    source_attempt_id: UUID
    winner_media_id: UUID


class SourceHistoryBaseline(_HistoryModel):
    kind: Literal["SourceHistoryBaseline"] = "SourceHistoryBaseline"
    source_attempt_id: UUID
    attempt_no: int
    outcome: SourceBaselineOutcome


SourceFacts = Annotated[
    SourceAccepted
    | SourceExecutionStarted
    | SourceStageChanged
    | SourceRetryScheduled
    | SourceFailed
    | SourceRecoveryAccepted
    | SourceSucceeded
    | SourceSuperseded
    | SourceHistoryBaseline,
    Field(discriminator="kind"),
]


class IndexAccepted(_HistoryModel):
    kind: Literal["IndexAccepted"] = "IndexAccepted"
    revision: int
    job_id: UUID


class IndexExecutionStarted(_HistoryModel):
    kind: Literal["IndexExecutionStarted"] = "IndexExecutionStarted"
    revision: int
    job_id: UUID
    execution_id: UUID


class IndexRetryScheduled(_HistoryModel):
    kind: Literal["IndexRetryScheduled"] = "IndexRetryScheduled"
    revision: int
    job_id: UUID
    execution_id: Presence[UUID]
    next_attempt_at: datetime


class IndexFailed(_HistoryModel):
    kind: Literal["IndexFailed"] = "IndexFailed"
    revision: int
    job_id: UUID
    execution_id: Presence[UUID]
    origin: Literal["Execution"]
    terminal: bool


class IndexRecoveryAccepted(_HistoryModel):
    kind: Literal["IndexRecoveryAccepted"] = "IndexRecoveryAccepted"
    revision: int
    job_id: UUID


class IndexSucceeded(_HistoryModel):
    kind: Literal["IndexSucceeded"] = "IndexSucceeded"
    revision: int
    job_id: UUID
    execution_id: UUID


class IndexSuperseded(_HistoryModel):
    """A claimed execution observed a newer revision and stopped."""

    kind: Literal["IndexSuperseded"] = "IndexSuperseded"
    revision: int
    job_id: UUID
    execution_id: UUID


IndexFacts = Annotated[
    IndexAccepted
    | IndexExecutionStarted
    | IndexRetryScheduled
    | IndexFailed
    | IndexRecoveryAccepted
    | IndexSucceeded
    | IndexSuperseded,
    Field(discriminator="kind"),
]

HistoryFacts = Annotated[
    UploadAccepted
    | UploadExecutionStarted
    | UploadFailed
    | UploadRecoveryAccepted
    | UploadPublished
    | UploadHistoryBaseline
    | SourceAccepted
    | SourceExecutionStarted
    | SourceStageChanged
    | SourceRetryScheduled
    | SourceFailed
    | SourceRecoveryAccepted
    | SourceSucceeded
    | SourceSuperseded
    | SourceHistoryBaseline
    | IndexAccepted
    | IndexExecutionStarted
    | IndexRetryScheduled
    | IndexFailed
    | IndexRecoveryAccepted
    | IndexSucceeded
    | IndexSuperseded,
    Field(discriminator="kind"),
]


class HistoryEntry(_HistoryModel):
    """One recorded event as every reader sees it."""

    id: UUID
    occurred_at: datetime
    stage: Presence[Stage]
    failure_code: Presence[SafeFailureCode]
    facts: HistoryFacts


class MediaHistoryOwner(_HistoryModel):
    kind: Literal["MediaHistoryOwner"] = "MediaHistoryOwner"
    media_id: UUID


class UploadHistoryOwner(_HistoryModel):
    """An upload-origin import: its session history, plus the published media's
    processing history once publication has linked one."""

    kind: Literal["UploadHistoryOwner"] = "UploadHistoryOwner"
    session_id: UUID
    media_id: Presence[UUID]


HistoryOwner = Annotated[MediaHistoryOwner | UploadHistoryOwner, Field(discriminator="kind")]


class FullHistoryCoverage(_HistoryModel):
    kind: Literal["Full"] = "Full"


class PartialHistoryCoverage(_HistoryModel):
    """Detailed execution history was not recorded before `recorded_since`."""

    kind: Literal["Partial"] = "Partial"
    recorded_since: datetime


HistoryCoverage = Annotated[
    FullHistoryCoverage | PartialHistoryCoverage, Field(discriminator="kind")
]

UPLOAD_EVENTS_TABLE: Final = "media_upload_events"
PROCESSING_EVENTS_TABLE: Final = "media_processing_events"
HistoryTable = Literal["media_upload_events", "media_processing_events"]

_UPLOAD_EVENT_TYPES: dict[str, EventType] = {
    "UploadAccepted": "Accepted",
    "UploadExecutionStarted": "ExecutionStarted",
    "UploadFailed": "Failed",
    "UploadRecoveryAccepted": "RecoveryAccepted",
    "UploadPublished": "Published",
    "UploadHistoryBaseline": "HistoryBaseline",
}
_SOURCE_EVENT_TYPES: dict[str, EventType] = {
    "SourceAccepted": "Accepted",
    "SourceExecutionStarted": "ExecutionStarted",
    "SourceStageChanged": "StageChanged",
    "SourceRetryScheduled": "RetryScheduled",
    "SourceFailed": "Failed",
    "SourceRecoveryAccepted": "RecoveryAccepted",
    "SourceSucceeded": "Succeeded",
    "SourceSuperseded": "Superseded",
    "SourceHistoryBaseline": "HistoryBaseline",
}
_INDEX_EVENT_TYPES: dict[str, EventType] = {
    "IndexAccepted": "Accepted",
    "IndexExecutionStarted": "ExecutionStarted",
    "IndexRetryScheduled": "RetryScheduled",
    "IndexFailed": "Failed",
    "IndexRecoveryAccepted": "RecoveryAccepted",
    "IndexSucceeded": "Succeeded",
    "IndexSuperseded": "Superseded",
}

_EVENT_TYPE_BY_KIND: dict[str, EventType] = {
    **_UPLOAD_EVENT_TYPES,
    **_SOURCE_EVENT_TYPES,
    **_INDEX_EVENT_TYPES,
}
_UPLOAD_KIND_BY_EVENT_TYPE: dict[str, str] = {
    event_type: kind for kind, event_type in _UPLOAD_EVENT_TYPES.items()
}
_SOURCE_KIND_BY_EVENT_TYPE: dict[str, str] = {
    event_type: kind for kind, event_type in _SOURCE_EVENT_TYPES.items()
}
_INDEX_KIND_BY_EVENT_TYPE: dict[str, str] = {
    event_type: kind for kind, event_type in _INDEX_EVENT_TYPES.items()
}

_UPLOAD_FACTS = TypeAdapter(UploadFacts)
_SOURCE_FACTS = TypeAdapter(SourceFacts)
_INDEX_FACTS = TypeAdapter(IndexFacts)


def history_event_type(facts: HistoryFacts) -> EventType:
    """The indexed envelope column for one variant."""
    return _EVENT_TYPE_BY_KIND[facts.kind]


def history_payload(facts: HistoryFacts) -> dict[str, object]:
    """The stored `payload`: the variant's own facts and nothing else. The
    discriminator is carried by `event_type` and the owning table."""
    return facts.model_dump(mode="json", exclude={"kind"})


def history_facts(
    *, table: HistoryTable, event_type: str, payload: Mapping[str, object]
) -> HistoryFacts:
    """Recover the exact variant a stored row holds.

    The branch is the owning table plus, inside `media_processing_events`, the
    presence of `revision` — content-index facts name a revision, source facts
    never do. Validation is strict both ways, so a payload this module did not
    write cannot decode.
    """
    if table == UPLOAD_EVENTS_TABLE:
        kind = _UPLOAD_KIND_BY_EVENT_TYPE.get(event_type, event_type)
        return _UPLOAD_FACTS.validate_python({"kind": kind, **payload})
    if "revision" in payload:
        kind = _INDEX_KIND_BY_EVENT_TYPE.get(event_type, event_type)
        return _INDEX_FACTS.validate_python({"kind": kind, **payload})
    kind = _SOURCE_KIND_BY_EVENT_TYPE.get(event_type, event_type)
    return _SOURCE_FACTS.validate_python({"kind": kind, **payload})
