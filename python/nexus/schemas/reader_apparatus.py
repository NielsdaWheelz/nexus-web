"""Reader apparatus response schemas."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from nexus.schemas.retrieval import RetrievalLocator

ReaderApparatusStatus = Literal["ready", "empty", "partial", "unsupported", "failed"]
ReaderApparatusItemKind = Literal[
    "footnote_ref",
    "endnote_ref",
    "bibliography_ref",
    "sidenote_ref",
    "margin_note_ref",
    "footnote",
    "endnote",
    "bibliography_entry",
    "sidenote",
    "margin_note",
    "reference_section",
]
ReaderApparatusRelation = Literal[
    "points_to_note",
    "points_to_endnote",
    "points_to_sidenote",
    "points_to_margin_note",
    "cites_bibliography_entry",
    "backlink_to_marker",
    "contains_reference",
]
ReaderApparatusConfidence = Literal["exact", "strong", "probable"]
ReaderApparatusLocatorStatus = Literal["exact", "container", "missing"]


class ReaderApparatusCapabilities(BaseModel):
    has_inline_markers: bool
    has_sidecar_items: bool
    supports_hover_preview: bool
    supports_jump_to_marker: bool
    supports_jump_to_target: bool
    has_probable_items: bool

    model_config = ConfigDict(extra="forbid")


class ReaderApparatusItemOut(BaseModel):
    id: UUID
    resource_ref: str
    stable_key: str
    kind: ReaderApparatusItemKind
    label: str | None
    body_text: str | None
    body_html_sanitized: str | None
    locator: RetrievalLocator | None
    locator_status: ReaderApparatusLocatorStatus
    confidence: ReaderApparatusConfidence
    extraction_method: str
    source_ref: dict[str, JsonValue]
    sort_key: str

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_locator_status(self) -> "ReaderApparatusItemOut":
        if self.locator is None and self.locator_status != "missing":
            raise ValueError("locator_status must be missing when locator is null")
        if self.locator is not None and self.locator_status == "missing":
            raise ValueError("locator_status cannot be missing when locator is present")
        return self


class ReaderApparatusEdgeOut(BaseModel):
    stable_key: str
    from_stable_key: str
    to_stable_key: str
    relation: ReaderApparatusRelation
    confidence: ReaderApparatusConfidence
    extraction_method: str
    source_ref: dict[str, JsonValue]
    sort_key: str

    model_config = ConfigDict(extra="forbid")


class ReaderApparatusResponse(BaseModel):
    media_id: UUID
    media_kind: str
    status: ReaderApparatusStatus
    extractor_version: str
    source_fingerprint: str
    capabilities: ReaderApparatusCapabilities
    items: list[ReaderApparatusItemOut] = Field(default_factory=list)
    edges: list[ReaderApparatusEdgeOut] = Field(default_factory=list)
    diagnostics: dict[str, JsonValue] = Field(default_factory=dict)

    model_config = ConfigDict(extra="forbid")
