"""Imports wire contracts (`docs/modules/imports.md`).

One import is an unpublished unbound browser capture or local upload session
(`upload:<session id>`), or a visible media with source or metadata work (`media:<id>`).
Published browser captures and pending bound captures share the media import; local
uploads keep their session import after publication.
Its source, search and metadata obligations are independent; the
server classifies the import over them and names the one that speaks for it (`primary`).
`ImportListQuery.normalized()` is the only filter identity a list cursor is bound to.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal, Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

from nexus.db.models import MediaKind
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.import_history import HistoryEntry, SafeFailureCode, Stage
from nexus.schemas.media_sources import EmailProvenance, SourceProgress
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.metadata_enrichment import MetadataEnrichmentView
from nexus.schemas.source_issues import SourceIssue

ImportView = Literal["Register", "Recent"]
Classification = Literal["Active", "NeedsAttention", "Complete"]
WaitingReason = Literal["Queue", "Capacity", "RetryBackoff", "AwaitingUploadConfirmation"]
SourceRecoveryInput = Literal["StoredSource", "RefetchSource"]
RecoveryRestriction = Literal[
    "NotOwner", "SameSourceTerminal", "SourceNotReacquirable", "UploadRejected"
]


class _Wire(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RetryUploadOffer(_Wire):
    kind: Literal["RetryUpload"] = "RetryUpload"
    input: Literal["ChooseOriginalFile"] = "ChooseOriginalFile"


class RetrySourceOffer(_Wire):
    kind: Literal["RetrySource"] = "RetrySource"
    expected_attempt_id: UUID
    input: SourceRecoveryInput


class RepairSourceOffer(_Wire):
    kind: Literal["RepairSource"] = "RepairSource"
    expected_attempt_id: UUID
    expected_job_id: UUID
    input: SourceRecoveryInput


class RepairSearchOffer(_Wire):
    kind: Literal["RepairSearch"] = "RepairSearch"
    expected_revision: int = Field(ge=0)
    expected_job_id: UUID
    input: Literal["PublishedContent"] = "PublishedContent"


class ImportObligation(_Wire):
    """One source or search obligation as it stands. `status`, `waiting_reason`, `progress`
    and `next_retry_at` describe Active work, `failure_code` NeedsAttention work; the
    owner's answer is an offer, a restriction, or neither."""

    classification: Classification
    stage: Stage
    status: Literal["Queued", "Processing"] | None
    waiting_reason: WaitingReason | None
    progress: SourceProgress | None
    next_retry_at: datetime | None
    failure_code: SafeFailureCode | None
    recovery: RetryUploadOffer | RetrySourceOffer | RepairSourceOffer | RepairSearchOffer | None
    unavailable_reason: RecoveryRestriction | None


class ImportObligations(_Wire):
    source: ImportObligation | None
    search: ImportObligation | None
    metadata: MetadataEnrichmentView | None


class ImportDismissal(_Wire):
    through: datetime


class ImportItem(_Wire):
    ref: str
    media_id: UUID | None
    title: str
    original_filename: str | None
    media_kind: MediaKind
    summary: MediaSummaryOut | None
    pointer: str | None
    arrived_at: datetime | None
    dismissal: ImportDismissal | None
    dismissed: list[Literal["source", "search", "metadata"]]
    can_read: bool
    can_play: bool
    text_search_ready: bool
    classification: Classification
    primary: Literal["source", "search", "metadata"] | None
    """The raised, else active obligation that speaks; null exactly when Complete."""
    accepted_at: datetime
    updated_at: datetime
    obligations: ImportObligations
    source_issue_count: int


class ImportPage(_Wire):
    items: list[ImportItem]
    next_cursor: str | None


class ImportSummary(_Wire):
    observed_at: datetime
    needs_attention_count: int
    active_count: int
    work_in_flight: bool
    digest: str


class RelatedImport(_Wire):
    relation: Literal["article", "thread"]
    item: ImportItem


class PendingCapture(_Wire):
    session_id: UUID
    state: Literal["AwaitingBytes", "VerificationFailed", "CapabilityExpired"]
    accepted_at: datetime
    expires_at: datetime
    failure_code: SafeFailureCode | None


class OriginalSource(_Wire):
    source_url: str
    source_label: str


class ImportDetail(_Wire):
    item: ImportItem
    source_issues: list[SourceIssue]
    related_imports: list[RelatedImport]
    pending_captures: list[PendingCapture]
    original_source: OriginalSource | None
    email_source: EmailProvenance | None


class HistoryPage(_Wire):
    entries: list[HistoryEntry]
    next_cursor: str | None


def _instant(value: object, name: str) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, str):
        value = datetime.fromisoformat(value)
    if not isinstance(value, datetime):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, f"{name} must carry an offset")
    if value.utcoffset() is None:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, f"{name} must carry an offset")
    return value.astimezone(UTC)


class ImportListQuery(_Wire):
    """One register window or the viewer's own recent acquisitions."""

    view: ImportView
    arrived_from: datetime | None = Field(default=None, alias="from")
    cursor: str | None = None
    limit: int = Field(default=50, ge=1, le=100)

    @field_validator("arrived_from", mode="before")
    @classmethod
    def _parse_from(cls, value: object) -> datetime | None:
        return _instant(value, "from")

    @model_validator(mode="after")
    def _normalize(self) -> Self:
        if (self.view == "Register") != (self.arrived_from is not None):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Register requires from; Recent refuses it",
            )
        return self

    def normalized(self) -> dict[str, object]:
        """The window identity a list cursor is bound to."""
        return self.model_dump(mode="json", exclude={"cursor", "limit"})


class ImportDismissalInput(_Wire):
    ref: str
    through: AwareDatetime

    @field_validator("through", mode="before")
    @classmethod
    def _parse_through(cls, value: object) -> datetime | None:
        return _instant(value, "through")


class DismissImportsRequest(_Wire):
    dismissals: list[ImportDismissalInput] = Field(min_length=1, max_length=100)
