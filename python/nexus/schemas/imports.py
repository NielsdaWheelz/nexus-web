"""Imports workspace wire contracts (spec `imports-workspace-hard-cutover.md`).

One import is either an upload obligation (`upload:<handle>`) or a media row
that has at least one source attempt (`media:<uuid>`). A published upload keeps
its upload identity, so exactly one wire row exists per import for its whole
life. Every model here is strict (`extra="forbid"`) and every union is
discriminated on `kind`, so a widened producer is a type error in each consumer.

`ImportListQuery` is the ingress half: it normalizes the filter set once, and
its `normalized()` projection is the only filter identity a cursor is bound to,
so the ORDER BY, the page predicate, and the cursor digest cannot disagree.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, TypeAdapter, model_validator
from pydantic_core import core_schema

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.import_history import HistoryCoverage, HistoryEntry, SafeFailureCode, Stage
from nexus.schemas.media import SourceProgress
from nexus.schemas.presence import Presence, Present
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref
from nexus.services.sealed_handles import UploadSessionHandle

NonemptyString = Annotated[str, Field(min_length=1)]


def _media_resource_ref(value: str) -> str:
    parsed = parse_resource_ref(value)
    if isinstance(parsed, ResourceRefParseFailure) or parsed.scheme != "media":
        raise ValueError("media_ref must be a canonical media resource ref")
    return value


# The linked media named in the resource-action grammar (`media:<uuid>`), the
# identity every media action speaks (contract D16).
MediaResourceRef = Annotated[str, AfterValidator(_media_resource_ref)]
MediaKind = Literal["web_article", "epub", "pdf", "podcast_episode", "video"]
WaitingReason = Literal["Queue", "Capacity", "RetryBackoff"]
ImportView = Literal["NeedsAttention", "InProgress", "History"]
ImportCurrentState = Literal["Active", "NeedsAttention", "Complete"]
SourceRecoveryInput = Literal["StoredSource", "RefetchSource"]
ModeledRecoveryRestriction = Literal[
    "NotOwner",
    "SameSourceTerminal",
    "SourceNotReacquirable",
    "UploadRejected",
]

_UPLOAD_REF_PREFIX = "upload:"
_MEDIA_REF_PREFIX = "media:"
_UPLOAD_SESSION_HANDLE = TypeAdapter(UploadSessionHandle)


class InvalidImportRef(InvalidRequestError):
    def __init__(self) -> None:
        super().__init__(ApiErrorCode.E_INVALID_REQUEST, "Invalid import ref")


@dataclass(frozen=True, slots=True)
class UploadImportRef:
    """One import whose identity is its upload session, published or not."""

    session_handle: UploadSessionHandle


@dataclass(frozen=True, slots=True)
class MediaImportRef:
    """One import whose identity is its media row; it has no upload session."""

    media_id: UUID


type ParsedImportRef = UploadImportRef | MediaImportRef


def _split_import_ref(raw: str) -> ParsedImportRef:
    if raw.startswith(_UPLOAD_REF_PREFIX):
        return UploadImportRef(
            session_handle=_UPLOAD_SESSION_HANDLE.validate_python(
                raw.removeprefix(_UPLOAD_REF_PREFIX)
            )
        )
    if raw.startswith(_MEDIA_REF_PREFIX):
        raw_id = raw.removeprefix(_MEDIA_REF_PREFIX)
        media_id = UUID(raw_id)
        if str(media_id) != raw_id:
            raise ValueError("media import ref must be canonical lowercase UUID text")
        return MediaImportRef(media_id=media_id)
    raise ValueError("import ref must name an upload session or a media row")


class ImportRef(str):
    """The wire identity of one import: validated text, never unsealed here."""

    @classmethod
    def _validate(cls, value: str) -> ImportRef:
        _split_import_ref(value)
        return cls(value)

    @classmethod
    def __get_pydantic_core_schema__(
        cls,
        _source_type: object,
        _handler: object,
    ) -> core_schema.CoreSchema:
        return core_schema.no_info_after_validator_function(
            cls._validate,
            core_schema.str_schema(),
        )


def parse_import_ref(raw: str) -> ParsedImportRef:
    """Untrusted ingress: narrow one URL-decoded ref into its owning identity."""
    try:
        return _split_import_ref(raw)
    except ValueError as exc:
        raise InvalidImportRef from exc


def format_import_ref(ref: ParsedImportRef) -> ImportRef:
    match ref:
        case UploadImportRef():
            return ImportRef(f"{_UPLOAD_REF_PREFIX}{ref.session_handle}")
        case MediaImportRef():
            return ImportRef(f"{_MEDIA_REF_PREFIX}{ref.media_id}")


class ImportStateActive(BaseModel):
    kind: Literal["Active"] = "Active"
    status: Literal["Queued", "Processing"]
    stage: Stage
    waiting_reason: Presence[WaitingReason]
    progress: Presence[SourceProgress]
    next_retry_at: Presence[datetime]

    model_config = ConfigDict(extra="forbid")


class ImportStateNeedsAttention(BaseModel):
    kind: Literal["NeedsAttention"] = "NeedsAttention"
    stage: Stage
    failure_code: Presence[SafeFailureCode]

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


RecoveryOffer = Annotated[
    RetryUploadOffer | RetrySourceOffer | RepairSourceOffer | RepairSearchOffer,
    Field(discriminator="kind"),
]


class Capabilities(BaseModel):
    can_open: bool
    can_remove: bool
    recovery: Presence[RecoveryOffer]
    unavailable_reason: Presence[ModeledRecoveryRestriction]

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _one_recovery_answer(self) -> Self:
        # justify-service-invariant-check: "the current obligation has exactly one
        # recovery answer" relates two independently typed fields, which the field
        # types cannot express; the owner policy decides which one is Present.
        if isinstance(self.recovery, Present) and isinstance(self.unavailable_reason, Present):
            raise ValueError("an import offers recovery or refuses it, never both")
        return self


class ImportItem(BaseModel):
    ref: ImportRef
    title: NonemptyString
    media_kind: MediaKind
    source_label: Presence[NonemptyString]
    media_ref: Presence[MediaResourceRef]
    state: ImportState
    accepted_at: datetime
    updated_at: datetime
    matched_event: Presence[HistoryEntry]
    capabilities: Capabilities

    model_config = ConfigDict(extra="forbid")


class ImportStageGroup(BaseModel):
    stage: Stage
    count: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


class ImportPage(BaseModel):
    observed_at: datetime
    matched_count: int = Field(ge=0)
    groups: list[ImportStageGroup]
    items: list[ImportItem]
    next_cursor: Presence[str]

    model_config = ConfigDict(extra="forbid")


class ImportSummary(BaseModel):
    observed_at: datetime
    needs_attention_count: int = Field(ge=0)
    active_count: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


class ImportReadiness(BaseModel):
    can_read: bool
    can_search: bool
    can_play: bool

    model_config = ConfigDict(extra="forbid")


class ImportDetail(BaseModel):
    item: ImportItem
    readiness: ImportReadiness
    history_coverage: HistoryCoverage

    model_config = ConfigDict(extra="forbid")


class HistoryPage(BaseModel):
    entries: list[HistoryEntry]
    next_cursor: Presence[str]

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
    failure_code: SafeFailureCode | None = None
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
