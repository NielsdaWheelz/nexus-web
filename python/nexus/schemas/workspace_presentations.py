"""Canonical, lightweight identity for the workspace's current destinations."""

from datetime import date
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    model_validator,
)

from nexus.db.models import MediaKind
from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.services.contributor_taxonomy import parse_contributor_handle
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref


def _workspace_ref(value: str) -> str:
    ref = parse_resource_ref(value)
    if isinstance(ref, ResourceRefParseFailure) or ref.scheme not in (
        "media",
        "library",
        "conversation",
        "podcast",
        "page",
        "note_block",
        "artifact",
        "oracle_reading",
    ):
        raise ValueError("expected a canonical workspace resource ref")
    return value


def _local_date(value: object) -> date:
    if type(value) is date:
        return value
    if isinstance(value, str):
        parsed = date.fromisoformat(value)
        if parsed.isoformat() == value:
            return parsed
    raise ValueError("expected a calendar date in YYYY-MM-DD form")


class _Locator(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class WorkspaceResourceLocator(_Locator):
    kind: Literal["resource_ref"]
    ref: Annotated[str, AfterValidator(_workspace_ref)]


class WorkspaceContributorLocator(_Locator):
    kind: Literal["contributor_handle"]
    handle: Annotated[str, AfterValidator(parse_contributor_handle)]


class WorkspaceDailyLocator(_Locator):
    kind: Literal["daily_date"]
    local_date: Annotated[date, BeforeValidator(_local_date)]


WorkspacePresentationLocator = Annotated[
    WorkspaceResourceLocator | WorkspaceContributorLocator | WorkspaceDailyLocator,
    Field(discriminator="kind"),
]


class WorkspacePresentationsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    locators: list[WorkspacePresentationLocator] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique(self) -> "WorkspacePresentationsRequest":
        if len(set(self.locators)) != len(self.locators):
            raise ValueError("workspace locators repeat")
        return self


class WorkspacePresentationOut(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)

    resource_ref: str
    title: str
    media_kind: MediaKind | None = None
    contributors: list[ContributorCreditOut] = Field(default_factory=list)
    source_label: str | None = None
    text_version: int | None = Field(default=None, ge=1)


class WorkspacePresentationItemOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    locator: WorkspacePresentationLocator
    presentation: WorkspacePresentationOut | None


class WorkspacePresentationsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[WorkspacePresentationItemOut]
