"""Compact canonical facts and causal lane proofs for durable authored requests."""

from datetime import date, datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.highlight_color import HighlightColor
from nexus.schemas.highlights import FragmentAnchorOut, PdfAnchorOut

IdentityKind = Literal["page", "note_block", "highlight", "link"]
WritingLane = Literal["body", "title", "links", "annotations", "context"]


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)


class WritingIdentity(_Out):
    kind: IdentityKind
    requested_id: UUID
    canonical_id: UUID
    state: Literal["live", "deleted"]


class WritingNote(_Out):
    id: UUID
    body_pm_json: dict[str, Any]
    body_text: str
    body_version: int


class WritingPage(_Out):
    id: UUID
    title: str
    title_version: int
    daily_date: date | None


class WritingHighlight(_Out):
    id: UUID
    version: str
    anchor: FragmentAnchorOut | PdfAnchorOut
    color: HighlightColor
    exact: str
    prefix: str
    suffix: str
    created_at: datetime
    updated_at: datetime
    author_user_id: UUID


class WritingLink(_Out):
    link_id: UUID
    source_ref: str
    target_ref: str
    origin: str


class WritingInsertion(_Out):
    requested_link_id: UUID
    source_ref: str
    canonical_link_id: UUID
    created: bool


class WritingPlacement(_Out):
    endpoint: str
    link_id: UUID
    after_link_id: UUID | None


class WritingLaneVersion(_Out):
    ref: str
    lane: WritingLane
    before_version: int | None
    version: int
    checked_from_version: int | None


class WritingAck(_Out):
    identities: list[WritingIdentity] = Field(default_factory=list)
    notes: list[WritingNote] = Field(default_factory=list)
    pages: list[WritingPage] = Field(default_factory=list)
    highlights: list[WritingHighlight] = Field(default_factory=list)
    links: list[WritingLink] = Field(default_factory=list)
    insertions: list[WritingInsertion] = Field(default_factory=list)
    placements: list[WritingPlacement] = Field(default_factory=list)
    removed_link_ids: list[UUID] = Field(default_factory=list)
    deleted_refs: list[str] = Field(default_factory=list)
    lanes: list[WritingLaneVersion] = Field(default_factory=list)


class ResourceVersionsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    refs: list[str] = Field(min_length=1, max_length=256)

    @model_validator(mode="after")
    def unique_refs(self) -> "ResourceVersionsRequest":
        if len(self.refs) != len(set(self.refs)):
            raise ValueError("refs must be unique")
        return self


class ResourceVersionState(_Out):
    ref: str
    state: Literal["live", "unavailable"]
    body_version: int | None
    title_version: int | None
    links_version: int | None
    annotations_version: int | None
    highlight_version: str | None


class ResourceVersionsOut(_Out):
    items: list[ResourceVersionState]


class WritingState(_Out):
    revision: int
