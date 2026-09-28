"""The anonymous reader's wire (snake_case): an allowlist, never a private model trimmed down."""

from typing import Annotated, Literal

from pydantic import BaseModel, Field

from nexus.schemas.highlights import HIGHLIGHT_COLORS
from nexus.schemas.presence import Presence
from nexus.schemas.reader import HighlightTargetPdfQuadOut


class PublicTextAnchorOut(BaseModel):
    kind: Literal["Text"] = "Text"
    ordinal: int  # the fragment, segment or section whose canonical text the offsets index
    start_offset: int
    end_offset: int


class PublicPdfAnchorOut(BaseModel):
    kind: Literal["Pdf"] = "Pdf"
    page_number: int
    quads: list[HighlightTargetPdfQuadOut]


class PublicHighlightOut(BaseModel):
    quote: Presence[str]
    color: HIGHLIGHT_COLORS
    anchor: Annotated[PublicTextAnchorOut | PublicPdfAnchorOut, Field(discriminator="kind")]


class PublicFragmentOut(BaseModel):
    ordinal: int
    html_sanitized: str
    canonical_text: str


class PublicSegmentOut(BaseModel):
    ordinal: int
    canonical_text: str
    start_ms: Presence[int]
    speaker: Presence[str]


class PublicSectionEntryOut(BaseModel):
    ordinal: int
    label: str
    depth: int
    section_handle: str


class PublicArticleReaderOut(BaseModel):
    kind: Literal["Article"] = "Article"
    fragments: list[PublicFragmentOut]


class PublicTranscriptReaderOut(BaseModel):
    kind: Literal["Transcript"] = "Transcript"
    segments: list[PublicSegmentOut]


class PublicEpubReaderOut(BaseModel):
    kind: Literal["Epub"] = "Epub"
    sections: list[PublicSectionEntryOut]


class PublicPdfReaderOut(BaseModel):
    kind: Literal["Pdf"] = "Pdf"


class PublicShareOut(BaseModel):
    title: str
    bylines: list[str]
    source_url: Presence[str]
    highlight: Presence[PublicHighlightOut]
    reader: Annotated[
        PublicArticleReaderOut
        | PublicTranscriptReaderOut
        | PublicEpubReaderOut
        | PublicPdfReaderOut,
        Field(discriminator="kind"),
    ]


class PublicSectionOut(BaseModel):
    html_sanitized: str
    canonical_text: str
