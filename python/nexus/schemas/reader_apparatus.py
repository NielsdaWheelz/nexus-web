"""Reader apparatus item, edge and read-model shapes."""

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, JsonValue, model_validator

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


class ReaderApparatusItemOut(BaseModel):
    id: UUID
    resource_ref: str
    stable_key: str
    kind: ReaderApparatusItemKind
    label: str | None
    body_text: str | None
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


@dataclass(frozen=True, slots=True)
class ReaderApparatusResponse:
    """One media's apparatus as the Document Map reads it. Never serialised."""

    media_id: UUID
    status: ReaderApparatusStatus
    items: list[ReaderApparatusItemOut]
    edges: list[ReaderApparatusEdgeOut]
