"""Contributor DTOs: snake-case embedded credits, strict camelCase author surfaces."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from nexus.services.contributor_taxonomy import (
    MAX_CONTRIBUTOR_NAME_CODE_POINTS,
    MAX_CREDITS_PER_MANAGED_ROLE,
    MAX_RAW_ROLE_LENGTH,
    ContributorRole,
    clean_contributor_display,
)


def _require_nonblank_name(value: str) -> str:
    # Whitespace-only names pass min_length but clean to empty downstream.
    if not clean_contributor_display(value):
        raise ValueError("must not be blank")
    return value


_Name = Annotated[
    str,
    Field(min_length=1, max_length=MAX_CONTRIBUTOR_NAME_CODE_POINTS),
    AfterValidator(_require_nonblank_name),
]
# 120 is the resource_mutations idempotency key length.
_ClientMutationId = Annotated[str, Field(min_length=1, max_length=120)]


class _CamelRequest(BaseModel):
    """Camel keys only: a snake payload or an unknown key is a 422."""

    model_config = ConfigDict(populate_by_name=False, extra="forbid")


class _CamelResponse(BaseModel):
    """Serialised camel by ``ok(by_alias=True)``; constructed and replayed by either name."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ContributorCreditIn(BaseModel):
    """Typed provider credit: snake-only, strict; ordinal/source/confidence are server-owned."""

    credited_name: str = Field(min_length=1, max_length=MAX_CONTRIBUTOR_NAME_CODE_POINTS)
    role: ContributorRole
    raw_role: str | None = Field(default=None, max_length=MAX_RAW_ROLE_LENGTH)

    model_config = ConfigDict(str_strip_whitespace=True, populate_by_name=False, extra="forbid")


class ContributorCreditOut(BaseModel):
    """One credit fact, embedded snake-case in the media/search/podcast/library DTOs.

    Handle-less text-fact credits (browse/discovery previews) leave handle/href absent.
    """

    contributor_handle: str | None = None
    contributor_display_name: str | None = None
    href: str | None = None
    credited_name: str
    role: ContributorRole
    raw_role: str | None = None
    ordinal: int | None = None

    model_config = ConfigDict(from_attributes=True, extra="forbid")


class ExistingAuthorBinding(_CamelRequest):
    kind: Literal["existing"]
    contributor_handle: str = Field(alias="contributorHandle", min_length=1)


class NewAuthorBinding(_CamelRequest):
    kind: Literal["new"]
    display_name: _Name = Field(alias="displayName")


AuthorBindingIn = Annotated[ExistingAuthorBinding | NewAuthorBinding, Field(discriminator="kind")]


class ManualAuthorRowIn(_CamelRequest):
    """One ordered manual author row. Every row is role ``author``."""

    credited_name: _Name = Field(alias="creditedName")
    binding: AuthorBindingIn


class ManualMediaAuthorsRequest(_CamelRequest):
    client_mutation_id: _ClientMutationId = Field(alias="clientMutationId")
    mode: Literal["manual"]
    authors: list[ManualAuthorRowIn] = Field(max_length=MAX_CREDITS_PER_MANAGED_ROLE)


class AutomaticMediaAuthorsRequest(_CamelRequest):
    client_mutation_id: _ClientMutationId = Field(alias="clientMutationId")
    mode: Literal["automatic"]


MediaAuthorsPutRequest = Annotated[
    ManualMediaAuthorsRequest | AutomaticMediaAuthorsRequest,
    Field(discriminator="mode"),
]


class ContributorRenameRequest(_CamelRequest):
    client_mutation_id: _ClientMutationId = Field(alias="clientMutationId")
    display_name: _Name = Field(alias="displayName")


class MediaAuthorCreditOut(_CamelResponse):
    contributor_handle: str = Field(alias="contributorHandle")
    href: str
    display_name: str = Field(alias="displayName")
    credited_name: str = Field(alias="creditedName")


class MediaAuthorsOut(_CamelResponse):
    author_mode: Literal["automatic", "manual"] = Field(alias="authorMode")
    authors: list[MediaAuthorCreditOut]
    can_edit_authors: bool = Field(alias="canEditAuthors")


class ContributorWorkExampleOut(_CamelResponse):
    title: str
    href: str


class ContributorSearchItemOut(_CamelResponse):
    handle: str
    href: str
    display_name: str = Field(alias="displayName")
    work_count: int = Field(alias="workCount")
    work_examples: list[ContributorWorkExampleOut] = Field(alias="workExamples", max_length=2)
    matched_alias: str | None = Field(default=None, alias="matchedAlias")


class ContributorSearchPageOut(_CamelResponse):
    contributors: list[ContributorSearchItemOut]
    next_cursor: str | None = Field(default=None, alias="nextCursor")


class ContributorRoleFactOut(_CamelResponse):
    credited_name: str = Field(alias="creditedName")
    role: ContributorRole
    raw_role: str | None = Field(default=None, alias="rawRole")


class ResourceActionSubjectOut(_CamelResponse):
    ref: str


class ContributorDetailOut(_CamelResponse):
    handle: str
    href: str
    display_name: str = Field(alias="displayName")
    other_names: list[str] = Field(alias="otherNames")
    can_rename: bool = Field(alias="canRename")
    action_subject: ResourceActionSubjectOut = Field(alias="actionSubject")


class ContributorWorkItemOut(_CamelResponse):
    title: str
    href: str
    content_kind: str = Field(alias="contentKind")
    date: str | None = None
    role_facts: list[ContributorRoleFactOut] = Field(alias="roleFacts")
    action_subject: ResourceActionSubjectOut | None = Field(alias="actionSubject")
