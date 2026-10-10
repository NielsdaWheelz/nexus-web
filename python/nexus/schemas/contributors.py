"""Contributor DTOs: the snake-case provider credit input and the camelCase author surfaces."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.services.contributor_taxonomy import (
    MAX_CONTRIBUTOR_NAME_CODE_POINTS,
    MAX_CREDITS_PER_MANAGED_ROLE,
    MAX_RAW_ROLE_LENGTH,
    ContributorRole,
    clean_contributor_display,
)


def _nonblank(value: str) -> str:
    # Whitespace-only names pass min_length but clean to empty downstream.
    if not clean_contributor_display(value):
        raise ValueError("must not be blank")
    return value


_Name = Annotated[
    str,
    Field(min_length=1, max_length=MAX_CONTRIBUTOR_NAME_CODE_POINTS),
    AfterValidator(_nonblank),
]


class _CamelIn(BaseModel):
    """Camel keys only: a snake key or an unknown key is a 422."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=False, extra="forbid")


class _CamelOut(BaseModel):
    """Serialised camel by ``ok(by_alias=True)``; constructed by field name."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class ContributorCreditIn(BaseModel):
    """A typed provider credit: snake keys, strict; ordinal and source are server-owned."""

    model_config = ConfigDict(str_strip_whitespace=True, populate_by_name=False, extra="forbid")

    credited_name: str = Field(min_length=1, max_length=MAX_CONTRIBUTOR_NAME_CODE_POINTS)
    role: ContributorRole
    raw_role: str | None = Field(default=None, max_length=MAX_RAW_ROLE_LENGTH)


class ExistingAuthorBinding(_CamelIn):
    kind: Literal["existing"]
    contributor_handle: str = Field(min_length=1)


class NewAuthorBinding(_CamelIn):
    kind: Literal["new"]
    display_name: _Name


class ManualAuthorRowIn(_CamelIn):
    """One ordered manual author row. Every row is role ``author``."""

    credited_name: _Name
    binding: Annotated[ExistingAuthorBinding | NewAuthorBinding, Field(discriminator="kind")]


class ManualMediaAuthorsRequest(_CamelIn):
    # 120 is the resource_mutations idempotency key length.
    client_mutation_id: str = Field(min_length=1, max_length=120)
    mode: Literal["manual"]
    authors: list[ManualAuthorRowIn] = Field(max_length=MAX_CREDITS_PER_MANAGED_ROLE)


class AutomaticMediaAuthorsRequest(_CamelIn):
    client_mutation_id: str = Field(min_length=1, max_length=120)
    mode: Literal["automatic"]


MediaAuthorsPutRequest = Annotated[
    ManualMediaAuthorsRequest | AutomaticMediaAuthorsRequest, Field(discriminator="mode")
]


class MediaAuthorsOut(_CamelOut):
    author_mode: Literal["automatic", "manual"]


class ContributorWorkExampleOut(_CamelOut):
    title: str
    href: str


class ContributorSearchItemOut(_CamelOut):
    handle: str
    href: str
    display_name: str
    work_count: int
    work_examples: list[ContributorWorkExampleOut] = Field(max_length=2)
    matched_alias: str | None


class ContributorSearchPageOut(_CamelOut):
    contributors: list[ContributorSearchItemOut]
    next_cursor: str | None


class ResourceActionSubjectOut(_CamelOut):
    ref: str


class ContributorDetailOut(_CamelOut):
    handle: str
    href: str
    display_name: str
    other_names: list[str]
    action_subject: ResourceActionSubjectOut


class ContributorRoleFactOut(_CamelOut):
    credited_name: str
    role: ContributorRole
    raw_role: str | None


class MediaContributorWorkItemOut(_CamelOut):
    kind: Literal["Media"] = "Media"
    media_summary: MediaSummaryOut
    href: str
    role_facts: list[ContributorRoleFactOut]
    action_subject: ResourceActionSubjectOut


class PodcastContributorWorkItemOut(_CamelOut):
    kind: Literal["Podcast"] = "Podcast"
    title: str
    href: str
    content_kind: str
    role_facts: list[ContributorRoleFactOut]
    action_subject: ResourceActionSubjectOut


class ExternalContributorWorkItemOut(_CamelOut):
    """A catalogue ebook: not a Nexus resource, so it has no action subject."""

    kind: Literal["ExternalWork"] = "ExternalWork"
    title: str
    href: str
    content_kind: str
    contributors: list[ContributorCreditOut]
    role_facts: list[ContributorRoleFactOut]


ContributorWorkItemOut = Annotated[
    MediaContributorWorkItemOut | PodcastContributorWorkItemOut | ExternalContributorWorkItemOut,
    Field(discriminator="kind"),
]
