"""Reader apparatus item, edge and read-model shapes."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from nexus.schemas.reader import NavigationTextPointOut, NavigationTextRangeOut
from nexus.schemas.retrieval import RetrievalLocator

ReaderApparatusStatus = Literal["ready", "empty", "partial", "unsupported", "failed"]
# The eleven persisted kinds. Extraction produces the footnote/endnote/bibliography
# and margin-note kinds; the rest are read back from rows older extractors wrote.
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
]
ReaderApparatusConfidence = Literal["exact", "strong", "probable"]
ReaderApparatusLocatorStatus = Literal["exact", "container", "missing"]


class NotesGroup(BaseModel):
    range: NavigationTextRangeOut
    heading: NavigationTextPointOut | None
    provenance: Literal["Declared", "Inferred"]

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_range(self) -> "NotesGroup":
        start, end = self.range.start, self.range.end
        if start.fragment_id == end.fragment_id and start.offset >= end.offset:
            raise ValueError("note group requires a nonempty range")
        if self.heading is not None and (
            (self.heading.fragment_id == start.fragment_id and self.heading.offset < start.offset)
            or (self.heading.fragment_id == end.fragment_id and self.heading.offset >= end.offset)
        ):
            raise ValueError("note group heading must lie within its range")
        return self


class NoteBodyRegion(BaseModel):
    kind: Literal["Body"] = "Body"
    range: NavigationTextRangeOut

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_range(self) -> "NoteBodyRegion":
        if (
            self.range.start.fragment_id != self.range.end.fragment_id
            or self.range.start.offset >= self.range.end.offset
        ):
            raise ValueError("note body requires a nonempty range within one fragment")
        return self


class NoteGroupRegion(BaseModel):
    kind: Literal["Group"] = "Group"
    range: NavigationTextRangeOut
    heading: NavigationTextPointOut | None
    provenance: Literal["Declared", "Inferred"]

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_range(self) -> "NoteGroupRegion":
        NotesGroup(range=self.range, heading=self.heading, provenance=self.provenance)
        return self


type NoteRegion = Annotated[NoteBodyRegion | NoteGroupRegion, Field(discriminator="kind")]


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
        if (self.locator is None) != (self.locator_status == "missing"):
            raise ValueError("locator_status is missing exactly when locator is null")
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
