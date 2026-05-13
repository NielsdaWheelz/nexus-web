"""Contributor DTOs."""

from datetime import datetime
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

ContributorKind = Literal["person", "organization", "group", "unknown"]
ContributorStatus = Literal["unverified", "verified", "tombstoned", "merged"]
ContributorAliasKind = Literal[
    "display",
    "credited",
    "legal",
    "pseudonym",
    "transliteration",
    "search",
]
ContributorRole = Literal[
    "author",
    "editor",
    "translator",
    "host",
    "guest",
    "narrator",
    "creator",
    "producer",
    "publisher",
    "channel",
    "organization",
    "unknown",
]
ContributorResolutionStatus = Literal[
    "external_id",
    "manual",
    "confirmed_alias",
    "unverified",
]


class ContributorAliasOut(BaseModel):
    id: UUID
    alias: str
    normalized_alias: str = Field(serialization_alias="normalizedAlias")
    sort_name: str | None = Field(None, serialization_alias="sortName")
    alias_kind: ContributorAliasKind = Field(serialization_alias="aliasKind")
    locale: str | None = None
    script: str | None = None
    source: str
    confidence: Decimal | None = None
    is_primary: bool = Field(serialization_alias="isPrimary")

    model_config = ConfigDict(from_attributes=True, populate_by_name=True, extra="forbid")


class ContributorExternalIdOut(BaseModel):
    id: UUID
    authority: str
    external_key: str = Field(serialization_alias="externalKey")
    external_url: str | None = Field(None, serialization_alias="externalUrl")
    source: str

    model_config = ConfigDict(from_attributes=True, populate_by_name=True, extra="forbid")


class ContributorAliasCreateRequest(BaseModel):
    alias: str = Field(..., min_length=1, max_length=200)
    sort_name: str | None = Field(
        None,
        validation_alias=AliasChoices("sort_name", "sortName"),
        serialization_alias="sortName",
        max_length=200,
    )
    alias_kind: ContributorAliasKind = Field(
        "search",
        validation_alias=AliasChoices("alias_kind", "aliasKind"),
        serialization_alias="aliasKind",
    )
    locale: str | None = Field(None, max_length=32)
    script: str | None = Field(None, max_length=32)
    source: str = Field("manual", min_length=1, max_length=80)
    confidence: Decimal | None = None
    is_primary: bool = Field(
        False,
        validation_alias=AliasChoices("is_primary", "isPrimary"),
        serialization_alias="isPrimary",
    )

    model_config = ConfigDict(str_strip_whitespace=True, populate_by_name=True, extra="forbid")


class ContributorExternalIdCreateRequest(BaseModel):
    authority: str = Field(..., min_length=1, max_length=40)
    external_key: str = Field(
        ...,
        validation_alias=AliasChoices("external_key", "externalKey"),
        serialization_alias="externalKey",
        min_length=1,
        max_length=200,
    )
    external_url: str | None = Field(
        None,
        validation_alias=AliasChoices("external_url", "externalUrl"),
        serialization_alias="externalUrl",
        max_length=1000,
    )
    source: str = Field("manual", min_length=1, max_length=80)

    model_config = ConfigDict(str_strip_whitespace=True, populate_by_name=True, extra="forbid")


class ContributorOut(BaseModel):
    handle: str
    href: str = ""
    display_name: str = Field(serialization_alias="displayName")
    sort_name: str | None = Field(None, serialization_alias="sortName")
    kind: ContributorKind
    status: ContributorStatus
    disambiguation: str | None = None
    aliases: list[ContributorAliasOut] = Field(default_factory=list)
    external_ids: list[ContributorExternalIdOut] = Field(
        default_factory=list,
        serialization_alias="externalIds",
    )
    created_at: datetime | None = Field(None, serialization_alias="createdAt")
    updated_at: datetime | None = Field(None, serialization_alias="updatedAt")

    model_config = ConfigDict(from_attributes=True, populate_by_name=True, extra="forbid")


class ContributorCreditIn(BaseModel):
    credited_name: str = Field(
        validation_alias=AliasChoices("credited_name", "creditedName"),
        serialization_alias="creditedName",
        min_length=1,
        max_length=255,
    )
    role: str = Field("author", min_length=1, max_length=80)
    raw_role: str | None = Field(
        None,
        validation_alias=AliasChoices("raw_role", "rawRole"),
        serialization_alias="rawRole",
        max_length=80,
    )
    ordinal: int | None = Field(None, ge=0)
    source: str = Field("local", min_length=1, max_length=80)
    source_ref: dict[str, Any] | None = Field(
        None,
        validation_alias=AliasChoices("source_ref", "sourceRef"),
        serialization_alias="sourceRef",
    )
    confidence: Decimal | None = None

    model_config = ConfigDict(str_strip_whitespace=True, populate_by_name=True, extra="forbid")


class ContributorCreditOut(BaseModel):
    id: UUID | None = None
    contributor_handle: str = Field(
        validation_alias=AliasChoices("contributor_handle", "contributorHandle"),
        serialization_alias="contributorHandle",
        min_length=1,
    )
    contributor_display_name: str = Field(
        validation_alias=AliasChoices("contributor_display_name", "contributorDisplayName"),
        serialization_alias="contributorDisplayName",
        min_length=1,
    )
    href: str = Field(min_length=1)
    credited_name: str = Field(
        validation_alias=AliasChoices("credited_name", "creditedName"),
        serialization_alias="creditedName",
        min_length=1,
    )
    role: ContributorRole
    raw_role: str | None = Field(
        None,
        validation_alias=AliasChoices("raw_role", "rawRole"),
        serialization_alias="rawRole",
    )
    ordinal: int
    source: str = Field(min_length=1)
    resolution_status: ContributorResolutionStatus = Field(
        "unverified",
        validation_alias=AliasChoices("resolution_status", "resolutionStatus"),
        serialization_alias="resolutionStatus",
    )
    confidence: Decimal | None = None
    contributor: ContributorOut | None = None

    model_config = ConfigDict(
        str_strip_whitespace=True, from_attributes=True, populate_by_name=True, extra="forbid"
    )


class ContributorWorkOut(BaseModel):
    object_type: str = Field(serialization_alias="objectType")
    object_id: str | int = Field(serialization_alias="objectId")
    route: str
    title: str
    content_kind: str = Field(serialization_alias="contentKind")
    published_date: str | None = Field(None, serialization_alias="publishedDate")
    publisher: str | None = None
    description: str | None = None
    credited_name: str = Field(serialization_alias="creditedName")
    role: ContributorRole
    raw_role: str | None = Field(None, serialization_alias="rawRole")
    ordinal: int
    source: str

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ContributorSearchResultOut(BaseModel):
    handle: str
    href: str
    display_name: str = Field(serialization_alias="displayName")
    sort_name: str | None = Field(None, serialization_alias="sortName")
    kind: ContributorKind
    status: ContributorStatus
    disambiguation: str | None = None
    matched_name: str | None = Field(None, serialization_alias="matchedName")

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ContributorMergeRequest(BaseModel):
    source_handle: str = Field(
        validation_alias=AliasChoices("source_handle", "sourceHandle"),
        serialization_alias="sourceHandle",
        min_length=1,
        max_length=200,
    )
    target_handle: str = Field(
        validation_alias=AliasChoices("target_handle", "targetHandle"),
        serialization_alias="targetHandle",
        min_length=1,
        max_length=200,
    )

    model_config = ConfigDict(str_strip_whitespace=True, populate_by_name=True, extra="forbid")


class ContributorSplitRequest(BaseModel):
    display_name: str = Field(
        validation_alias=AliasChoices("display_name", "displayName"),
        serialization_alias="displayName",
        min_length=1,
        max_length=200,
    )
    credit_ids: list[UUID] = Field(
        default_factory=list,
        validation_alias=AliasChoices("credit_ids", "creditIds"),
        serialization_alias="creditIds",
    )
    alias_ids: list[UUID] = Field(
        default_factory=list,
        validation_alias=AliasChoices("alias_ids", "aliasIds"),
        serialization_alias="aliasIds",
    )
    external_id_ids: list[UUID] = Field(
        default_factory=list,
        validation_alias=AliasChoices("external_id_ids", "externalIdIds"),
        serialization_alias="externalIdIds",
    )
    object_link_ids: list[UUID] = Field(
        default_factory=list,
        validation_alias=AliasChoices("object_link_ids", "objectLinkIds"),
        serialization_alias="objectLinkIds",
    )
    message_context_item_ids: list[UUID] = Field(
        default_factory=list,
        validation_alias=AliasChoices("message_context_item_ids", "messageContextItemIds"),
        serialization_alias="messageContextItemIds",
    )

    model_config = ConfigDict(str_strip_whitespace=True, populate_by_name=True, extra="forbid")


class ContributorsListOut(BaseModel):
    contributors: list[ContributorOut] = Field(default_factory=list)

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ContributorWorksOut(BaseModel):
    works: list[ContributorWorkOut] = Field(default_factory=list)

    model_config = ConfigDict(populate_by_name=True, extra="forbid")
