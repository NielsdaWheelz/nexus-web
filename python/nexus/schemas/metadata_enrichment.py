"""The research model's output contract, job payloads, a run's outcomes, and the operation wire."""

from __future__ import annotations

from typing import Annotated, Literal, get_args
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints, model_validator

from nexus.schemas.isbn import Isbn13
from nexus.schemas.publication_dates import PublicationDate
from nexus.services.contributor_taxonomy import (
    CONTRIBUTOR_ROLES_ORDERED,
    MAX_CONTRIBUTOR_HANDLE_LENGTH,
    MAX_CONTRIBUTOR_NAME_CODE_POINTS,
    MAX_CREDITS_PER_MANAGED_ROLE,
    MAX_RAW_ROLE_LENGTH,
    ContributorRole,
)

type MetadataField = Literal[
    "title",
    "contributors",
    "original_published_date",
    "edition_published_date",
    "edition_isbn",
    "publisher",
    "language",
    "description",
]
METADATA_FIELDS: tuple[MetadataField, ...] = get_args(MetadataField.__value__)
# A media's purpose is fixed by what it is (metadata_purpose); every job freezes its own.
type MetadataPurpose = Literal["bibliography", "title"]

type MetadataFailureCode = Literal[
    "model_unavailable",
    "authentication_failed",
    "quota_unavailable",
    "research_timeout",
    "invalid_output",
    "input_too_large",
    "output_limit",
    "stale_input",
    "source_context_missing",
    "no_longer_eligible",
    "access_revoked",
    "cancelled",
    "policy_violation",
    "worker_interrupted",
    "execution_failed",
]

_ShortText = Annotated[str, StringConstraints(min_length=1, max_length=255, pattern=r"\S")]
_Name = Annotated[
    str, StringConstraints(min_length=1, max_length=MAX_CONTRIBUTOR_NAME_CODE_POINTS, pattern=r"\S")
]
_RawRole = Annotated[
    str, StringConstraints(min_length=1, max_length=MAX_RAW_ROLE_LENGTH, pattern=r"\S")
]
_Handle = Annotated[
    str,
    StringConstraints(
        min_length=3,
        max_length=MAX_CONTRIBUTOR_HANDLE_LENGTH,
        pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
    ),
]
_Description = Annotated[str, StringConstraints(min_length=1, max_length=2000, pattern=r"\S")]
_Language = Annotated[str, StringConstraints(min_length=2, max_length=2, pattern=r"^[a-z]{2}$")]


class _Frozen(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class _JobPayload(_Frozen):
    media_id: UUID
    requester_user_id: UUID
    request_id: str | None


class BibliographyMetadataJobPayload(_JobPayload):
    purpose: Literal["bibliography"]


class TitleMetadataJobPayload(_JobPayload):
    """An x article's title from the source attempt whose capture it names."""

    purpose: Literal["title"]
    source_attempt_id: UUID


type MetadataJobPayload = Annotated[
    BibliographyMetadataJobPayload | TitleMetadataJobPayload, Field(discriminator="purpose")
]


# The docstrings below are model-facing (schema descriptions, kept verbatim); notes are comments.
class MetadataCredit(_Frozen):
    """Generated nulls belong only to this external output contract."""

    # A contributor_handle must be one the input offered (accept_findings checks it).
    contributor_handle: _Handle | None
    credited_name: _Name
    raw_role: _RawRole | None


class MetadataRoleSlice(_Frozen):
    role: ContributorRole
    credits: Annotated[list[MetadataCredit], Field(max_length=MAX_CREDITS_PER_MANAGED_ROLE)]

    @model_validator(mode="after")
    def _one_person_once(self) -> MetadataRoleSlice:
        handles = [c.contributor_handle for c in self.credits if c.contributor_handle is not None]
        if len(handles) != len(set(handles)):
            raise ValueError("one person cannot occur twice within a contributor role")
        return self


class MetadataFindings(_Frozen):
    """The sole external eight-field, required-nullable research result."""

    # As generated and as accepted: null keeps the stored value; contributors=[] is
    # invalid; credits=[] clears that role.
    title: _ShortText | None
    contributors: (
        Annotated[
            list[MetadataRoleSlice], Field(min_length=1, max_length=len(CONTRIBUTOR_ROLES_ORDERED))
        ]
        | None
    )
    original_published_date: PublicationDate | None
    edition_published_date: PublicationDate | None
    edition_isbn: Isbn13 | None
    publisher: _ShortText | None
    language: _Language | None
    description: _Description | None

    @model_validator(mode="after")
    def _each_role_once(self) -> MetadataFindings:
        roles = [item.role for item in self.contributors or []]
        if len(roles) != len(set(roles)):
            raise ValueError("each contributor role must occur at most once")
        return self


class MetadataBibliographyCompletedOutcome(_Frozen):
    status: Literal["completed"] = "completed"
    purpose: Literal["bibliography"]
    completed_at: AwareDatetime
    changed_fields: list[MetadataField]
    unresolved_fields: list[MetadataField]


class MetadataTitleCompletedOutcome(_Frozen):
    status: Literal["completed"] = "completed"
    purpose: Literal["title"]
    completed_at: AwareDatetime
    changed_fields: Annotated[list[Literal["title"]], Field(max_length=1)]
    disposition: Literal["generated", "source_label"]


type MetadataCompletedOutcome = Annotated[
    MetadataBibliographyCompletedOutcome | MetadataTitleCompletedOutcome,
    Field(discriminator="purpose"),
]


class MetadataNoFindingsOutcome(_Frozen):
    status: Literal["no_findings"] = "no_findings"
    purpose: Literal["bibliography"]
    completed_at: AwareDatetime


class MetadataFailedOutcome(_Frozen):
    status: Literal["failed"] = "failed"
    purpose: MetadataPurpose
    completed_at: AwareDatetime
    reason: MetadataFailureCode


type MetadataOutcome = Annotated[
    MetadataCompletedOutcome | MetadataNoFindingsOutcome | MetadataFailedOutcome,
    Field(discriminator="status"),
]


class MetadataEnrichmentRequest(_Frozen):
    """The latest job the viewer saw; null when they saw none."""

    # FastAPI validates the decoded body in python mode, where strict refuses uuid text.
    expected_job_id: UUID | None = Field(strict=False)


class MetadataEnrichmentAccepted(_Frozen):
    media_id: UUID
    job_id: UUID
    last_enriched_at: AwareDatetime | None


class MetadataRetryAllowed(_Frozen):
    status: Literal["allowed"] = "allowed"
    purpose: MetadataPurpose
    expected_job_id: UUID | None


class MetadataRetryBlocked(_Frozen):
    status: Literal["blocked"] = "blocked"
    purpose: MetadataPurpose
    reason: Literal["not_creator", "not_eligible", "active", "source_context_missing"]


type MetadataRetry = Annotated[
    MetadataRetryAllowed | MetadataRetryBlocked, Field(discriminator="status")
]


class MetadataSelection(_Frozen):
    """The generation's route, model (a provider route's ``model_ref``) and reasoning."""

    route: str
    model: str
    reasoning: str


class _Operation(_Frozen):
    job_id: UUID
    created_at: AwareDatetime
    started_at: AwareDatetime | None
    generation_id: UUID | None
    selection: MetadataSelection | None


class MetadataQueuedOperation(_Operation):
    status: Literal["queued"] = "queued"
    purpose: MetadataPurpose


class MetadataRunningOperation(_Operation):
    status: Literal["running"] = "running"
    purpose: MetadataPurpose


class MetadataRecoveringOperation(_Operation):
    status: Literal["recovering"] = "recovering"
    purpose: MetadataPurpose


class MetadataWaitingOperation(_Operation):
    status: Literal["waiting"] = "waiting"
    purpose: MetadataPurpose
    reason: Literal["retry"]
    until: AwareDatetime | None


class MetadataCompletedOperation(_Operation):
    status: Literal["completed"] = "completed"
    purpose: MetadataPurpose
    outcome: MetadataCompletedOutcome


class MetadataNoFindingsOperation(_Operation):
    status: Literal["no_findings"] = "no_findings"
    purpose: Literal["bibliography"]
    completed_at: AwareDatetime
    reviewed_at: AwareDatetime | None


class MetadataFailedOperation(_Operation):
    status: Literal["failed"] = "failed"
    purpose: MetadataPurpose
    completed_at: AwareDatetime
    code: MetadataFailureCode


type MetadataUnfinishedOperation = Annotated[
    MetadataQueuedOperation
    | MetadataRunningOperation
    | MetadataRecoveringOperation
    | MetadataWaitingOperation,
    Field(discriminator="status"),
]

type MetadataOperationOut = Annotated[
    MetadataQueuedOperation
    | MetadataRunningOperation
    | MetadataRecoveringOperation
    | MetadataWaitingOperation
    | MetadataCompletedOperation
    | MetadataNoFindingsOperation
    | MetadataFailedOperation,
    Field(discriminator="status"),
]


class MetadataEnrichmentView(_Frozen):
    """The latest operation, the oldest unfinished one, and whether the viewer may start one;
    the metadata stream ends once ``unfinished_count`` is 0 (only a new run changes it)."""

    operation: MetadataOperationOut | None
    unfinished_count: Annotated[int, Field(ge=0)]
    unfinished_operation: MetadataUnfinishedOperation | None
    retry: MetadataRetry
    last_enriched_at: AwareDatetime | None
