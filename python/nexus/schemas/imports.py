"""Imports workspace wire contracts (`docs/modules/imports.md`).

One import is either an upload obligation (`upload:<handle>`) or visible media
with a recorded source attempt or metadata job (`media:<uuid>`). A published upload keeps
its upload identity, so exactly one wire row exists per import for its whole
life. Every model here is strict (`extra="forbid"`) and every union is
discriminated on `kind`, so a widened producer is a type error in each consumer.

`ImportListQuery` is the ingress half: it normalizes the filter set once, and
its `normalized()` projection is the only filter identity a cursor is bound to,
so the ORDER BY, the page predicate, and the cursor digest cannot disagree.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from nexus.db.models import MediaKind
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.import_history import (
    HistoryCoverage,
    HistoryEntry,
    ImportFailureCode,
    SafeFailureCode,
    SourceStage,
    Stage,
)
from nexus.schemas.import_refs import ImportRef
from nexus.schemas.media import SourceProgress
from nexus.schemas.metadata_enrichment import MetadataEnrichmentView
from nexus.schemas.source_issues import SourceIssue
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref

NonemptyString = Annotated[str, Field(min_length=1)]


def _media_resource_ref(value: str) -> str:
    parsed = parse_resource_ref(value)
    if isinstance(parsed, ResourceRefParseFailure) or parsed.scheme != "media":
        raise ValueError("media_ref must be a canonical media resource ref")
    return value


# The linked media named in the resource-action grammar (`media:<uuid>`), the
# identity every media action speaks (contract D16).
MediaResourceRef = Annotated[str, AfterValidator(_media_resource_ref)]
WaitingReason = Literal["Queue", "Capacity", "RetryBackoff", "AwaitingUploadConfirmation"]
ImportView = Literal["NeedsAttention", "InProgress", "History"]
ImportCurrentState = Literal["Active", "NeedsAttention", "Complete"]
SourceRecoveryInput = Literal["StoredSource", "RefetchSource"]
ModeledRecoveryRestriction = Literal[
    "NotOwner",
    "SameSourceTerminal",
    "SourceNotReacquirable",
    "UploadRejected",
]


class _ImportStateActiveFields(BaseModel):
    kind: Literal["Active"] = "Active"
    status: Literal["Queued", "Processing"]
    waiting_reason: WaitingReason | None
    progress: SourceProgress | None
    next_retry_at: datetime | None

    model_config = ConfigDict(extra="forbid")


class ImportStateActive(_ImportStateActiveFields):
    stage: Stage


class ImportStateNeedsAttention(BaseModel):
    kind: Literal["NeedsAttention"] = "NeedsAttention"
    stage: Stage
    failure_code: ImportFailureCode | None

    model_config = ConfigDict(extra="forbid")


class ImportStateComplete(BaseModel):
    kind: Literal["Complete"] = "Complete"

    model_config = ConfigDict(extra="forbid")


ImportState = Annotated[
    ImportStateActive | ImportStateNeedsAttention | ImportStateComplete,
    Field(discriminator="kind"),
]


class RetryUploadOffer(BaseModel):
    kind: Literal["RetryUpload"] = "RetryUpload"
    expected_generation: int = Field(ge=1)
    input: Literal["ChooseOriginalFile"] = "ChooseOriginalFile"

    model_config = ConfigDict(extra="forbid")


class RetrySourceOffer(BaseModel):
    kind: Literal["RetrySource"] = "RetrySource"
    expected_attempt_id: UUID
    input: SourceRecoveryInput

    model_config = ConfigDict(extra="forbid")


class RepairSourceOffer(BaseModel):
    kind: Literal["RepairSource"] = "RepairSource"
    expected_attempt_id: UUID
    expected_job_id: UUID
    input: SourceRecoveryInput

    model_config = ConfigDict(extra="forbid")


class RepairSearchOffer(BaseModel):
    kind: Literal["RepairSearch"] = "RepairSearch"
    expected_revision: int = Field(ge=0)
    expected_job_id: UUID
    input: Literal["PublishedContent"] = "PublishedContent"

    model_config = ConfigDict(extra="forbid")


SourceRecoveryOffer = Annotated[
    RetryUploadOffer | RetrySourceOffer | RepairSourceOffer,
    Field(discriminator="kind"),
]


class SourceImportStateActive(_ImportStateActiveFields):
    stage: SourceStage


class SourceImportStateNeedsAttention(BaseModel):
    kind: Literal["NeedsAttention"] = "NeedsAttention"
    stage: SourceStage
    failure_code: SafeFailureCode | None

    model_config = ConfigDict(extra="forbid")


class SearchImportStateActive(_ImportStateActiveFields):
    stage: Literal["Index"] = "Index"


class SearchImportStateNeedsAttention(BaseModel):
    kind: Literal["NeedsAttention"] = "NeedsAttention"
    stage: Literal["Index"] = "Index"
    failure_code: SafeFailureCode | None

    model_config = ConfigDict(extra="forbid")


class SourceImportObligation(BaseModel):
    state: Annotated[
        SourceImportStateActive | SourceImportStateNeedsAttention | ImportStateComplete,
        Field(discriminator="kind"),
    ]
    recovery: SourceRecoveryOffer | None
    unavailable_reason: ModeledRecoveryRestriction | None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _one_recovery_answer(self) -> Self:
        # justify-service-invariant-check: "the current obligation has exactly one
        # recovery answer" relates two independently typed fields, which the field
        # types cannot express; the owner policy decides which one is set.
        if self.recovery is not None and self.unavailable_reason is not None:
            raise ValueError("an import offers recovery or refuses it, never both")
        return self


class SearchImportObligation(BaseModel):
    state: Annotated[
        SearchImportStateActive | SearchImportStateNeedsAttention | ImportStateComplete,
        Field(discriminator="kind"),
    ]
    recovery: RepairSearchOffer | None
    unavailable_reason: Literal["NotOwner"] | None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _one_recovery_answer(self) -> Self:
        # justify-service-invariant-check: the owner policy must not simultaneously
        # offer a repair and refuse it; nullable fields cannot express that relation.
        if self.recovery is not None and self.unavailable_reason is not None:
            raise ValueError("a search obligation offers recovery or refuses it, never both")
        return self


class ImportObligations(BaseModel):
    source: SourceImportObligation | None
    search: SearchImportObligation | None
    metadata: MetadataEnrichmentView | None

    model_config = ConfigDict(extra="forbid")


class Capabilities(BaseModel):
    can_remove: bool

    model_config = ConfigDict(extra="forbid")


class ImportReadiness(BaseModel):
    can_read: bool
    can_search: bool
    can_play: bool

    model_config = ConfigDict(extra="forbid")


class ImportItem(BaseModel):
    ref: ImportRef
    title: NonemptyString
    original_filename: NonemptyString | None
    media_kind: MediaKind
    source_label: NonemptyString | None
    media_ref: MediaResourceRef | None
    readiness: ImportReadiness
    state: ImportState
    accepted_at: datetime
    updated_at: datetime
    matched_event: HistoryEntry | None
    capabilities: Capabilities
    obligations: ImportObligations
    source_issue_count: int = Field(ge=0, strict=True)

    model_config = ConfigDict(extra="forbid")


class ImportPage(BaseModel):
    observed_at: datetime
    matched_count: int = Field(ge=0)
    items: list[ImportItem]
    next_cursor: str | None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _page_coherence(self) -> Self:
        if len(self.items) > self.matched_count:
            raise ValueError("import page returned more items than it matched")
        if len({item.ref for item in self.items}) != len(self.items):
            raise ValueError("import page returned the same import twice")
        if self.next_cursor is not None and not self.items:
            raise ValueError("import page continues a page that returned no items")
        return self


class ImportSummary(BaseModel):
    observed_at: datetime
    needs_attention_count: int = Field(ge=0)
    active_count: int = Field(ge=0)
    unfinished_work_count: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


class ImportSourceIssues(BaseModel):
    generation: int = Field(ge=1, strict=True)
    issues: list[SourceIssue]

    model_config = ConfigDict(extra="forbid")


class ImportDetail(BaseModel):
    item: ImportItem
    history_coverage: HistoryCoverage
    source_issues: ImportSourceIssues | None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _source_issue_count(self) -> Self:
        count = len(self.source_issues.issues) if self.source_issues is not None else 0
        if self.item.source_issue_count != count:
            raise ValueError("import source issues must match the current import count")
        return self


class HistoryPage(BaseModel):
    entries: list[HistoryEntry]
    next_cursor: str | None

    model_config = ConfigDict(extra="forbid")


def _utc_instant(value: datetime | None, name: str) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None or value.utcoffset() is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"{name} must be a UTC-offset instant",
        )
    return value.astimezone(UTC)


class ImportListQuery(BaseModel):
    """`GET /imports` parameters, normalized once at ingress.

    `view` selects which evidence a filter is correlated against, so a filter a
    view cannot correlate is rejected rather than silently widened: attention and
    progress filters read the row's current state, History reads one event.
    """

    view: ImportView
    q: str | None = None
    media_kind: MediaKind | None = None
    stage: Stage | None = None
    failure_code: ImportFailureCode | None = None
    state: ImportCurrentState | None = None
    had_failures: bool | None = None
    matched_from: datetime | None = Field(default=None, alias="from")
    before: datetime | None = None
    cursor: str | None = None
    limit: int = Field(default=50, ge=1, le=100)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _normalize_and_reject_uncorrelatable_filters(self) -> Self:
        self.q = None if self.q is None else (self.q.strip() or None)
        self.matched_from = _utc_instant(self.matched_from, "from")
        self.before = _utc_instant(self.before, "before")
        history_only = {
            "before": self.before,
            "from": self.matched_from,
            "had_failures": self.had_failures,
            "state": self.state,
        }
        unsupported = [name for name, value in history_only.items() if value is not None]
        if self.view == "InProgress" and self.failure_code is not None:
            unsupported.append("failure_code")
        if self.view != "History" and unsupported:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                f"{self.view} imports cannot be filtered by {', '.join(sorted(unsupported))}",
            )
        if self.view == "History" and self.failure_code is not None and self.had_failures is False:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "failure_code names a failure event and contradicts had_failures=false",
            )
        return self

    def normalized(self) -> dict[str, object]:
        """The filter identity a cursor is bound to: a cursor minted under one
        filter set is rejected under any other."""
        return {
            "view": self.view,
            "q": self.q,
            "media_kind": self.media_kind,
            "stage": self.stage,
            "failure_code": self.failure_code,
            "state": self.state,
            "had_failures": self.had_failures,
            "from": None if self.matched_from is None else self.matched_from.isoformat(),
            "before": None if self.before is None else self.before.isoformat(),
        }
