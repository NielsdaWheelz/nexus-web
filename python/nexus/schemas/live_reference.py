"""Source identity and coordinates; saved references carry their quoted words."""

from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from nexus.schemas.reader import (
    EpubTextOffsetsTargetOut,
    PdfPageGeometryTargetOut,
    ReaderTargetModel,
    ReaderTextOffsets,
    ReaderTimeRange,
    TranscriptTextOffsetsTargetOut,
    WebTextOffsetsTargetOut,
)
from nexus.schemas.reader_excerpts import FrozenExcerpt
from nexus.schemas.resource_evidence import ResourceField, validate_resource_field
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref


class TextOffsetsTarget(ReaderTextOffsets):
    kind: Literal["TextOffsets"] = "TextOffsets"


class TimeRangeTarget(ReaderTimeRange):
    kind: Literal["TimeRange"] = "TimeRange"


class PdfPageTarget(ReaderTargetModel):
    kind: Literal["PdfPage"] = "PdfPage"
    page_number: int = Field(ge=1, le=2**31 - 1)


LiveLocator = Annotated[
    WebTextOffsetsTargetOut
    | EpubTextOffsetsTargetOut
    | TranscriptTextOffsetsTargetOut
    | PdfPageGeometryTargetOut
    | PdfPageTarget
    | TextOffsetsTarget
    | TimeRangeTarget,
    Field(discriminator="kind"),
]


class LiveReference(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    resource_ref: str
    field: ResourceField
    locator: LiveLocator | None

    @model_validator(mode="after")
    def validate_reference(self) -> "LiveReference":
        ref = parse_resource_ref(self.resource_ref)
        if isinstance(ref, ResourceRefParseFailure):
            raise ValueError("a canonical resource reference is required")
        validate_resource_field(self.resource_ref, self.field)
        if isinstance(self.locator, TextOffsetsTarget):
            if ref.scheme not in ("note_block", "message") and self.field != "annotation":
                raise ValueError("text offsets require a note, message or highlight annotation")
        elif self.locator is not None and (
            self.field is not None or ref.scheme not in ("media", "fragment")
        ):
            raise ValueError("reader coordinates require media or a fragment")
        return self


class ResourceRetrievalTarget(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["resource"] = "resource"
    reference: LiveReference


class ReferenceQuote(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    exact: str = Field(min_length=1, pattern=r"\S")
    prefix: str | None
    suffix: str | None
    excerpt: FrozenExcerpt


class SavedReference(LiveReference):
    quote: ReferenceQuote | None

    @model_validator(mode="after")
    def validate_quote(self) -> "SavedReference":
        if self.quote is not None and self.locator is None:
            raise ValueError("a quote requires a locator")
        return self


class SavedResourceTarget(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["resource"] = "resource"
    reference: SavedReference


class UrlRetrievalTarget(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["url"] = "url"
    url: str = Field(max_length=8192)

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or any(ord(c) <= 32 for c in value)
        ):
            raise ValueError("a valid http(s) url is required")
        return value


RetrievalTarget = Annotated[
    ResourceRetrievalTarget | UrlRetrievalTarget, Field(discriminator="kind")
]

SavedRetrievalTarget = Annotated[
    SavedResourceTarget | UrlRetrievalTarget, Field(discriminator="kind")
]
