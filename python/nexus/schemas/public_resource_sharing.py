"""The anonymous reader's share summary (snake_case): an allowlist, never a private model trimmed
down. Its document is the reader document (``nexus.schemas.reader_document``) addressed by
unit ordinal."""

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


class PublicShareOut(BaseModel):
    title: str
    bylines: list[str]
    source_url: Presence[str]
    highlight: Presence[PublicHighlightOut]
