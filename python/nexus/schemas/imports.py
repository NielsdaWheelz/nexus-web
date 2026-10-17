"""Imports wire contracts (`docs/modules/imports.md`).

One import is an upload session (`upload:<session id>`, kept after publication) or a
visible media with a source attempt or metadata job that no session of the viewer
published (`media:<id>`). Its source, search and metadata obligations are independent; the
server classifies the import over them and names the one that speaks for it (`primary`).
`ImportListQuery.normalized()` is the only filter identity a list cursor is bound to.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.db.models import MediaKind
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.import_history import HistoryEntry, ImportFailureCode, SafeFailureCode, Stage
from nexus.schemas.media_sources import SourceProgress
from nexus.schemas.metadata_enrichment import MetadataEnrichmentView
from nexus.schemas.source_issues import SourceIssue

ImportView = Literal["NeedsAttention", "InProgress", "History"]
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


class ImportItem(_Wire):
    ref: str
    media_id: UUID | None
    title: str
    original_filename: str | None
    media_kind: MediaKind
    source_label: str | None
    can_read: bool
    can_play: bool
    classification: Classification
    primary: Literal["source", "search", "metadata"] | None
    """The obligation that speaks for the import (under a stage or reason filter, the one
    that matched); null exactly when the import is Complete."""
    accepted_at: datetime
    updated_at: datetime
    matched_event: HistoryEntry | None
    obligations: ImportObligations
    source_issue_count: int


class ImportPage(_Wire):
    matched_count: int
    items: list[ImportItem]
    next_cursor: str | None


class ImportSummary(_Wire):
    observed_at: datetime
    needs_attention_count: int
    active_count: int
    unfinished_work_count: int


class ImportDetail(_Wire):
    item: ImportItem
    source_issues: list[SourceIssue]


class HistoryPage(_Wire):
    entries: list[HistoryEntry]
    next_cursor: str | None


def _instant(value: datetime | None, name: str) -> datetime | None:
    if value is None:
        return None
    if value.utcoffset() is None:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, f"{name} must carry an offset")
    return value.astimezone(UTC)


class ImportListQuery(_Wire):
    """`GET /imports`, normalized once. A view refuses a filter it cannot correlate:
    attention and progress match a current obligation, History one recorded event."""

    view: ImportView
    q: str | None = None
    media_kind: MediaKind | None = None
    stage: Stage | None = None
    failure_code: ImportFailureCode | None = None
    state: Classification | None = None
    had_failures: bool | None = None
    matched_from: datetime | None = Field(default=None, alias="from")
    before: datetime | None = None
    cursor: str | None = None
    limit: int = Field(default=50, ge=1, le=100)

    @model_validator(mode="after")
    def _normalize(self) -> Self:
        self.q = (self.q or "").strip() or None
        self.matched_from = _instant(self.matched_from, "from")
        self.before = _instant(self.before, "before")
        if self.view == "History":
            contradicted = self.failure_code is not None and self.had_failures is False
            refused = ["failure_code with had_failures=false"] if contradicted else []
        else:
            history_only = {
                "before": self.before,
                "from": self.matched_from,
                "had_failures": self.had_failures,
                "state": self.state,
                "failure_code": self.failure_code if self.view == "InProgress" else None,
            }
            refused = [name for name, value in history_only.items() if value is not None]
        if refused:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                f"{self.view} imports cannot be filtered by {', '.join(refused)}",
            )
        return self

    def normalized(self) -> dict[str, object]:
        """The filter identity a list cursor is bound to."""
        return self.model_dump(mode="json", exclude={"cursor", "limit"})
