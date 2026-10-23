"""Contributor DTOs: the provider credit input and the author surfaces."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.services.contributor_taxonomy import (
    MAX_CONTRIBUTOR_NAME_CODE_POINTS,
    MAX_CREDITS_PER_MANAGED_ROLE,
    MAX_RAW_ROLE_LENGTH,
    ContributorRole,
    clean_contributor_display,
)
from nexus.services.sealed_handles import DiscoveryTargetHandle


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


class _In(BaseModel):
    """An unknown key is a 422."""

    model_config = ConfigDict(extra="forbid")


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ContributorCreditIn(BaseModel):
    """A typed provider credit: snake keys, strict; ordinal and source are server-owned."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    credited_name: str = Field(min_length=1, max_length=MAX_CONTRIBUTOR_NAME_CODE_POINTS)
    role: ContributorRole
    raw_role: str | None = Field(default=None, max_length=MAX_RAW_ROLE_LENGTH)


class ExistingAuthorBinding(_In):
    kind: Literal["existing"]
    contributor_handle: str = Field(min_length=1)


class NewAuthorBinding(_In):
    """A person the save creates under the client's ``id``; a resend binds that person."""

    kind: Literal["new"]
    id: UUID
    display_name: _Name


class ManualAuthorRowIn(_In):
    """One ordered manual author row. Every row is role ``author``."""

    credited_name: _Name
    binding: Annotated[ExistingAuthorBinding | NewAuthorBinding, Field(discriminator="kind")]


class ManualMediaAuthorsRequest(_In):
    mode: Literal["manual"]
    authors: list[ManualAuthorRowIn] = Field(max_length=MAX_CREDITS_PER_MANAGED_ROLE)


class AutomaticMediaAuthorsRequest(_In):
    mode: Literal["automatic"]


MediaAuthorsPutRequest = Annotated[
    ManualMediaAuthorsRequest | AutomaticMediaAuthorsRequest, Field(discriminator="mode")
]


class MediaAuthorsOut(_Out):
    author_mode: Literal["automatic", "manual"]


class ContributorWorkExampleOut(_Out):
    title: str
    href: str


class ContributorSearchItemOut(_Out):
    handle: str
    href: str
    display_name: str
    work_count: int
    work_examples: list[ContributorWorkExampleOut] = Field(max_length=2)
    matched_alias: str | None


class ContributorSearchPageOut(_Out):
    contributors: list[ContributorSearchItemOut]
    next_cursor: str | None


class ContributorDetailOut(_Out):
    handle: str
    href: str
    display_name: str
    other_names: list[str]
    resource_ref: str
    action_ref: str


class ContributorRoleFactOut(_Out):
    credited_name: str
    role: ContributorRole
    raw_role: str | None


class MediaContributorWorkItemOut(_Out):
    kind: Literal["Media"] = "Media"
    media_summary: MediaSummaryOut
    href: str
    role_facts: list[ContributorRoleFactOut]
    action_ref: str


class PodcastContributorWorkItemOut(_Out):
    kind: Literal["Podcast"] = "Podcast"
    title: str
    href: str
    content_kind: str
    role_facts: list[ContributorRoleFactOut]
    resource_ref: str
    action_ref: str


class ExternalContributorWorkItemOut(_Out):
    """External identity: the sealed target acquires it; href retains provenance only."""

    kind: Literal["ExternalWork"] = "ExternalWork"
    title: str
    href: str
    target: DiscoveryTargetHandle
    content_kind: Literal["project_gutenberg_ebook"]
    contributors: list[ContributorCreditOut]
    role_facts: list[ContributorRoleFactOut]


ContributorWorkItemOut = Annotated[
    MediaContributorWorkItemOut | PodcastContributorWorkItemOut | ExternalContributorWorkItemOut,
    Field(discriminator="kind"),
]
