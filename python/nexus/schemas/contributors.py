"""contributor dto contracts: provider credit input and contributor reads."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.services.contributor_taxonomy import (
    MAX_CONTRIBUTOR_NAME_CODE_POINTS,
    MAX_RAW_ROLE_LENGTH,
    ContributorRole,
)
from nexus.services.sealed_handles import DiscoveryTargetHandle


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ContributorCreditIn(BaseModel):
    """A typed provider credit: snake keys, strict; ordinal and source are server-owned."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    credited_name: str = Field(min_length=1, max_length=MAX_CONTRIBUTOR_NAME_CODE_POINTS)
    role: ContributorRole
    raw_role: str | None = Field(default=None, max_length=MAX_RAW_ROLE_LENGTH)


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
