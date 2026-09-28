"""Recorded limitations of one reader publication generation."""

from __future__ import annotations

from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator


class MissingImage(BaseModel):
    kind: Literal["MissingImage"] = "MissingImage"
    fragment_id: UUID
    marker_ordinal: int = Field(ge=0, strict=True)
    resource_path: str = Field(min_length=1)

    model_config = ConfigDict(extra="forbid")

    @field_validator("resource_path")
    @classmethod
    def _package_path(cls, value: str) -> str:
        if (
            value.startswith("/")
            or "\\" in value
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
            or any(part in ("", ".", "..") for part in value.split("/"))
        ):
            raise ValueError("resource_path must be a normalized package-relative path")
        return value


class UnresolvedNavigationTarget(BaseModel):
    kind: Literal["UnresolvedNavigationTarget"] = "UnresolvedNavigationTarget"
    node_id: str = Field(min_length=1, max_length=255)
    href: str = Field(min_length=1)

    model_config = ConfigDict(extra="forbid")

    @field_validator("href")
    @classmethod
    def _local_href(cls, value: str) -> str:
        parsed = urlsplit(value)
        if (
            parsed.scheme
            or parsed.netloc
            or value.startswith("/")
            or "\\" in value
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
        ):
            raise ValueError("href must be a resolved local navigation target")
        return value


SourceIssue = Annotated[MissingImage | UnresolvedNavigationTarget, Field(discriminator="kind")]
SOURCE_ISSUES = TypeAdapter(list[SourceIssue])
MAX_SOURCE_ISSUES = 10_000


def source_issues_payload(issues: tuple[SourceIssue, ...]) -> list[dict[str, object]]:
    if len(issues) > MAX_SOURCE_ISSUES:
        raise ValueError("too many source issues")
    return [issue.model_dump(mode="json") for issue in issues]
