"""Generated metadata ingress, accepted research, and the one operation wire."""

from __future__ import annotations

from typing import Annotated, Literal, get_args
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

from nexus.schemas.client_mutation import ClientMutationUuidText
from nexus.schemas.isbn import Isbn13
from nexus.schemas.presence import Presence, Present, absent
from nexus.schemas.publication_dates import PublicationDate
from nexus.services.contributor_taxonomy import (
    CONTRIBUTOR_ROLES_ORDERED,
    MAX_CONTRIBUTOR_HANDLE_LENGTH,
    MAX_CONTRIBUTOR_NAME_CODE_POINTS,
    MAX_CREDITS_PER_MANAGED_ROLE,
    MAX_RAW_ROLE_LENGTH,
    NOT_OBSERVED,
    ContributorHandle,
    ContributorObservation,
    ContributorObservationBatch,
    ContributorRole,
    ObservedRoleSlices,
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

type MetadataFailureCode = Literal[
    "catalog_unavailable",
    "configuration_error",
    "model_unavailable",
    "authentication_failed",
    "quota_unavailable",
    "research_timeout",
    "invalid_output",
    "input_too_large",
    "output_limit",
    "stale_input",
    "no_longer_eligible",
    "access_revoked",
    "cancelled",
    "policy_violation",
    "worker_interrupted",
    "execution_failed",
]

_ShortText = Annotated[str, StringConstraints(min_length=1, max_length=255, pattern=r"\S")]
_Name = Annotated[
    str,
    StringConstraints(
        min_length=1,
        max_length=MAX_CONTRIBUTOR_NAME_CODE_POINTS,
        pattern=r"\S",
    ),
]
_RawRole = Annotated[
    str,
    StringConstraints(min_length=1, max_length=MAX_RAW_ROLE_LENGTH, pattern=r"\S"),
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


class _MetadataModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class MetadataContributorCreditOutput(_MetadataModel):
    """Generated nulls belong only to this external output contract."""

    contributor_handle: _Handle | None
    credited_name: _Name
    raw_role: _RawRole | None


class MetadataContributorRoleSliceOutput(_MetadataModel):
    role: ContributorRole
    credits: Annotated[
        list[MetadataContributorCreditOutput], Field(max_length=MAX_CREDITS_PER_MANAGED_ROLE)
    ]

    @model_validator(mode="after")
    def unique_existing_people(self) -> MetadataContributorRoleSliceOutput:
        handles = [
            row.contributor_handle for row in self.credits if row.contributor_handle is not None
        ]
        if len(handles) != len(set(handles)):
            raise ValueError("one person cannot occur twice within a contributor role")
        return self


class MetadataEnrichmentOutput(_MetadataModel):
    """The sole external eight-field, required-nullable research result."""

    title: _ShortText | None
    contributors: (
        Annotated[
            list[MetadataContributorRoleSliceOutput],
            Field(min_length=1, max_length=len(CONTRIBUTOR_ROLES_ORDERED)),
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
    def unique_roles(self) -> MetadataEnrichmentOutput:
        if self.contributors is not None:
            roles = [item.role for item in self.contributors]
            if len(roles) != len(set(roles)):
                raise ValueError("each contributor role must occur at most once")
        return self


class AcceptedMetadataContributorCredit(_MetadataModel):
    contributor_handle: Presence[ContributorHandle]
    credited_name: _Name
    raw_role: Presence[_RawRole]


class AcceptedMetadataContributorRoleSlice(_MetadataModel):
    role: ContributorRole
    credits: list[AcceptedMetadataContributorCredit]


class AcceptedMetadataEnrichment(_MetadataModel):
    """Validated findings. Presence is owned absence; no raw null reaches publication."""

    title: Presence[_ShortText]
    contributors: Presence[list[AcceptedMetadataContributorRoleSlice]]
    original_published_date: Presence[PublicationDate]
    edition_published_date: Presence[PublicationDate]
    edition_isbn: Presence[Isbn13]
    publisher: Presence[_ShortText]
    language: Presence[_Language]
    description: Presence[_Description]

    @property
    def has_findings(self) -> bool:
        return any(isinstance(getattr(self, name), Present) for name in METADATA_FIELDS)

    @property
    def unresolved_fields(self) -> list[MetadataField]:
        return [name for name in METADATA_FIELDS if not isinstance(getattr(self, name), Present)]

    def contributor_observation(self) -> ContributorObservationBatch:
        """Adapt accepted credits to the contributor owner's existing observation API."""
        if not isinstance(self.contributors, Present):
            return NOT_OBSERVED
        return ObservedRoleSlices(
            managed_roles=frozenset(item.role for item in self.contributors.value),
            credits=tuple(
                ContributorObservation(
                    credited_name=credit.credited_name,
                    role=item.role,
                    raw_role=credit.raw_role.value
                    if isinstance(credit.raw_role, Present)
                    else None,
                    identity_key=None,
                    contributor_handle=credit.contributor_handle,
                )
                for item in self.contributors.value
                for credit in item.credits
            ),
        )


class MetadataCompletedOutcome(_MetadataModel):
    status: Literal["completed"] = "completed"
    completed_at: AwareDatetime
    changed_fields: list[MetadataField]
    unresolved_fields: list[MetadataField]
    retained_manual_authors: bool


class MetadataNoFindingsOutcome(_MetadataModel):
    status: Literal["no_findings"] = "no_findings"
    completed_at: AwareDatetime


class MetadataFailedOutcome(_MetadataModel):
    status: Literal["failed"] = "failed"
    completed_at: AwareDatetime
    reason: MetadataFailureCode


type MetadataOutcome = Annotated[
    MetadataCompletedOutcome | MetadataNoFindingsOutcome | MetadataFailedOutcome,
    Field(discriminator="status"),
]


class MetadataAcceptedMemo(_MetadataModel):
    status: Literal["accepted"] = "accepted"
    enrichment: AcceptedMetadataEnrichment
    published: Presence[MetadataOutcome] = Field(default_factory=absent)


class MetadataFailedMemo(_MetadataModel):
    status: Literal["failed"] = "failed"
    reason: MetadataFailureCode
    published: Presence[MetadataOutcome] = Field(default_factory=absent)


type MetadataMemo = Annotated[
    MetadataAcceptedMemo | MetadataFailedMemo, Field(discriminator="status")
]


class MetadataEnrichmentRequest(_MetadataModel):
    client_mutation_id: ClientMutationUuidText
    expected_job_id: Presence[UUID]


class MetadataEnrichmentAccepted(_MetadataModel):
    media_id: UUID
    job_id: UUID


class MetadataRetryAllowed(_MetadataModel):
    status: Literal["allowed"] = "allowed"
    expected_job_id: Presence[UUID]


class MetadataRetryBlocked(_MetadataModel):
    status: Literal["blocked"] = "blocked"
    reason: Literal["not_creator", "not_eligible", "active", "uncertain"]


type MetadataRetry = Annotated[
    MetadataRetryAllowed | MetadataRetryBlocked, Field(discriminator="status")
]


class MetadataSelection(_MetadataModel):
    provider: str
    model: str
    reasoning: str


class _MetadataOperationBase(_MetadataModel):
    job_id: UUID
    created_at: AwareDatetime
    started_at: Presence[AwareDatetime]
    generation_id: Presence[UUID]
    selection: Presence[MetadataSelection]


class MetadataQueuedOperation(_MetadataOperationBase):
    status: Literal["queued"] = "queued"


class MetadataRunningOperation(_MetadataOperationBase):
    status: Literal["running"] = "running"


class MetadataRecoveringOperation(_MetadataOperationBase):
    status: Literal["recovering"] = "recovering"


class MetadataUncertainOperation(_MetadataOperationBase):
    status: Literal["uncertain"] = "uncertain"


class MetadataWaitingOperation(_MetadataOperationBase):
    status: Literal["waiting"] = "waiting"
    reason: Literal["capacity", "provider_limit", "retry"]
    until: Presence[AwareDatetime]


class MetadataCompletedOperation(_MetadataOperationBase):
    status: Literal["completed"] = "completed"
    outcome: MetadataCompletedOutcome


class MetadataNoFindingsOperation(_MetadataOperationBase):
    status: Literal["no_findings"] = "no_findings"
    completed_at: AwareDatetime


class MetadataFailedOperation(_MetadataOperationBase):
    status: Literal["failed"] = "failed"
    completed_at: AwareDatetime
    code: MetadataFailureCode


type MetadataOperationOut = Annotated[
    MetadataQueuedOperation
    | MetadataRunningOperation
    | MetadataRecoveringOperation
    | MetadataUncertainOperation
    | MetadataWaitingOperation
    | MetadataCompletedOperation
    | MetadataNoFindingsOperation
    | MetadataFailedOperation,
    Field(discriminator="status"),
]


class MetadataEnrichmentView(_MetadataModel):
    operation: Presence[MetadataOperationOut]
    retry: MetadataRetry
    last_enriched_at: Presence[AwareDatetime]
