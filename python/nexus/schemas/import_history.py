"""Import history vocabulary (`docs/modules/imports.md`).

Two append-only tables record what happened to one import: `media_upload_events` for an
upload session, `media_processing_events` for a media's source and content-index work. A
row's envelope is (owner, `occurred_at`, `stage`, `failure_code`); its `payload` is one
variant below, `kind` included, holding only the facts a reader is told. This module owns
the stage, the failure catalog and every variant; `services/import_history.py` is the
tables' only writer and reader.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Annotated, Literal, cast, get_args
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from nexus.schemas.metadata_enrichment import MetadataFailureCode, MetadataOperationOut

Stage = Literal[
    "Upload", "Validate", "Extract", "Finalize", "SourceProcessing", "Index", "Metadata"
]
STAGES: tuple[Stage, ...] = get_args(Stage)
"""Pipeline order: an import's speaking obligation is its earliest stage."""

FailureOrigin = Literal["Execution", "Domain"]

UploadVerificationFailureCode = Literal[
    "E_SOURCE_INTEGRITY", "E_INVALID_FILE_TYPE", "E_FILE_TOO_LARGE", "E_CAPTURE_TOO_LARGE"
]
"""The deterministic upload rejections a session records (``Rejected.code``)."""

_OWNER_FAILURE_CODES = Literal[
    "E_ARCHIVE_UNSAFE",
    "E_CAPTURE_TOO_LARGE",
    "E_EMBEDDING_PROVIDER_UNAVAILABLE",
    "E_FORBIDDEN",
    "E_INGEST_FAILED",
    "E_INGEST_TIMEOUT",
    "E_INTERNAL",
    "E_INVALID_CONTENT_TYPE",
    "E_INVALID_KIND",
    "E_INVALID_REQUEST",
    "E_MEDIA_NOT_FOUND",
    "E_MEDIA_NOT_READY",
    "E_OWNER_REQUIRED",
    "E_PDF_PASSWORD_REQUIRED",
    "E_PDF_TEXT_UNAVAILABLE",
    "E_PODCAST_PROVIDER_UNAVAILABLE",
    "E_REPAIR_NOT_ALLOWED",
    "E_RESOURCE_CONFLICT",
    "E_RESOURCE_LIMIT",
    "E_RETRY_INVALID_STATE",
    "E_RETRY_NOT_ALLOWED",
    "E_SANITIZATION_FAILED",
    "E_SELECTION_CHANGED",
    "E_SIGN_UPLOAD_FAILED",
    "E_SOURCE_ACCESS_DENIED",
    "E_SOURCE_FETCH_FAILED",
    "E_SOURCE_GONE",
    "E_SOURCE_NOT_READABLE",
    "E_SOURCE_POSITION_UNMAPPABLE",
    "E_SOURCE_TOO_LARGE",
    "E_SSRF_BLOCKED",
    "E_STORAGE_ERROR",
    "E_STORAGE_MISSING",
    "E_TRANSCRIPTION_FAILED",
    "E_TRANSCRIPTION_TIMEOUT",
    "E_TRANSCRIPT_UNAVAILABLE",
    "E_UPLOAD_CAPABILITY_EXPIRED",
    "E_WORKER_HANDLER_FAILED",
    "E_WORKER_INTERRUPTED",
    "E_X_POST_UNAVAILABLE",
    "E_X_ARTICLE_BODY_UNAVAILABLE",
    "E_X_ARTICLE_IDENTITY_CHANGED",
    "E_X_IDENTITY_CONFLICT",
    "E_X_SOURCE_CONFLICT",
    "E_X_PROVIDER_AUTH_REJECTED",
    "E_X_PROVIDER_CREDITS_DEPLETED",
    "E_X_PROVIDER_RATE_LIMITED",
    "E_X_PROVIDER_TIMEOUT",
    "E_X_PROVIDER_UNAVAILABLE",
]

SafeFailureCode = UploadVerificationFailureCode | _OWNER_FAILURE_CODES
"""Every source or search failure code an import may show: each value of
`media_source_attempts.error_code`, `media_upload_sessions.verification_error_code`, a
failed media's `last_error_code`, and the queue's codes after `queue_failure_code`.
Metadata failures have their own vocabulary and are never stored here."""

type ImportFailureCode = SafeFailureCode | MetadataFailureCode

SAFE_FAILURE_CODES: frozenset[str] = frozenset(
    (*get_args(UploadVerificationFailureCode), *get_args(_OWNER_FAILURE_CODES))
)


def assume_safe_failure_code(raw: str) -> SafeFailureCode:
    """A trusted failure column's value; anything uncatalogued is a writer defect."""
    if raw not in SAFE_FAILURE_CODES:
        # justify-defect: owned failure columns carry a catalogued code (0288 refuses others).
        raise AssertionError(f"uncatalogued import failure code {raw!r}")
    return cast(SafeFailureCode, raw)


def queue_failure_code(raw: str) -> SafeFailureCode:
    """Total: a queue transition must never abort for history, so an execution code
    outside the catalog reads as the generic handler failure (the raw code stays on
    `background_jobs.error_code`)."""
    return cast(SafeFailureCode, raw) if raw in SAFE_FAILURE_CODES else "E_WORKER_HANDLER_FAILED"


class _Fact(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UploadAccepted(_Fact):
    kind: Literal["UploadAccepted"] = "UploadAccepted"
    generation: int


class UploadRecoveryAccepted(_Fact):
    kind: Literal["UploadRecoveryAccepted"] = "UploadRecoveryAccepted"
    generation: int


class UploadPublished(_Fact):
    kind: Literal["UploadPublished"] = "UploadPublished"
    generation: int


class UploadFailed(_Fact):
    """A verification rejection; the envelope's code says which."""

    kind: Literal["UploadFailed"] = "UploadFailed"
    generation: int


class UploadHistoryBaseline(_Fact):
    """Written once by the 2026-09-08 cut (0225) for every session that existed then."""

    kind: Literal["UploadHistoryBaseline"] = "UploadHistoryBaseline"
    generation: int


class SourceFailureProgress(_Fact):
    completed: int
    total: int | None
    unit: str | None


class SourceAccepted(_Fact):
    kind: Literal["SourceAccepted"] = "SourceAccepted"
    source_attempt_id: UUID
    attempt_no: int


class SourceExecutionStarted(_Fact):
    kind: Literal["SourceExecutionStarted"] = "SourceExecutionStarted"
    source_attempt_id: UUID


class SourceStageChanged(_Fact):
    kind: Literal["SourceStageChanged"] = "SourceStageChanged"
    source_attempt_id: UUID


class SourceRetryScheduled(_Fact):
    kind: Literal["SourceRetryScheduled"] = "SourceRetryScheduled"
    source_attempt_id: UUID


class SourceFailed(_Fact):
    kind: Literal["SourceFailed"] = "SourceFailed"
    source_attempt_id: UUID
    origin: FailureOrigin
    terminal: bool
    progress: SourceFailureProgress | None


class SourceRecoveryAccepted(_Fact):
    """A recovery admitted for this attempt; its successor is the next attempt in the chain.
    Repairs written by operators (reprocess, corrected source type) keep their own kind."""

    kind: Literal["SourceRecoveryAccepted"] = "SourceRecoveryAccepted"
    source_attempt_id: UUID
    recovery: Literal["RetrySource", "RepairSource", "ReprocessSource", "CorrectSourceType"]


class SourceSucceeded(_Fact):
    kind: Literal["SourceSucceeded"] = "SourceSucceeded"
    source_attempt_id: UUID


class SourceHistoryBaseline(_Fact):
    """Written once by the 2026-09-08 cut (0225): the outcome an earlier attempt had then."""

    kind: Literal["SourceHistoryBaseline"] = "SourceHistoryBaseline"
    source_attempt_id: UUID
    attempt_no: int
    outcome: Literal["Succeeded", "Failed", "InFlight"]
    outcome_code: SafeFailureCode | None


class IndexAccepted(_Fact):
    kind: Literal["IndexAccepted"] = "IndexAccepted"
    revision: int


class IndexExecutionStarted(_Fact):
    kind: Literal["IndexExecutionStarted"] = "IndexExecutionStarted"
    revision: int


class IndexRetryScheduled(_Fact):
    kind: Literal["IndexRetryScheduled"] = "IndexRetryScheduled"
    revision: int


class IndexFailed(_Fact):
    kind: Literal["IndexFailed"] = "IndexFailed"
    revision: int
    terminal: bool


class IndexRecoveryAccepted(_Fact):
    kind: Literal["IndexRecoveryAccepted"] = "IndexRecoveryAccepted"
    revision: int


class IndexSucceeded(_Fact):
    kind: Literal["IndexSucceeded"] = "IndexSucceeded"
    revision: int


class IndexSuperseded(_Fact):
    """A claimed execution observed a newer revision and stopped."""

    kind: Literal["IndexSuperseded"] = "IndexSuperseded"
    revision: int


UploadFacts = (
    UploadAccepted | UploadRecoveryAccepted | UploadPublished | UploadFailed | UploadHistoryBaseline
)
SourceFacts = (
    SourceAccepted
    | SourceExecutionStarted
    | SourceStageChanged
    | SourceRetryScheduled
    | SourceFailed
    | SourceRecoveryAccepted
    | SourceSucceeded
    | SourceHistoryBaseline
)
IndexFacts = (
    IndexAccepted
    | IndexExecutionStarted
    | IndexRetryScheduled
    | IndexFailed
    | IndexRecoveryAccepted
    | IndexSucceeded
    | IndexSuperseded
)
StoredFacts = Annotated[UploadFacts | SourceFacts | IndexFacts, Field(discriminator="kind")]
FAILURE_KINDS = ("UploadFailed", "SourceFailed", "IndexFailed")
_STORED: TypeAdapter[StoredFacts] = TypeAdapter(StoredFacts)


def decode_facts(payload: Mapping[str, object]) -> UploadFacts | SourceFacts | IndexFacts:
    """A stored payload; one this module did not write does not decode."""
    return _STORED.validate_python(payload)


class MetadataOperationFacts(_Fact):
    """A retained metadata operation projected into history; never stored."""

    kind: Literal["MetadataOperation"] = "MetadataOperation"
    operation: MetadataOperationOut


class HistoryEntry(_Fact):
    """One recorded event or metadata operation; `id` is `upload:`, `processing:` or
    `metadata:` and the row's uuid."""

    id: str
    occurred_at: datetime
    stage: Stage | None
    failure_code: ImportFailureCode | None
    facts: Annotated[
        UploadFacts | SourceFacts | IndexFacts | MetadataOperationFacts,
        Field(discriminator="kind"),
    ]
