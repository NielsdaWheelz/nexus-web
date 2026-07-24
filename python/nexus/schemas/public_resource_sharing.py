"""Closed anonymous resource-sharing response contracts.

These models are deliberately separate from authenticated resource models. A
public projection is an allowlist of reader facts, not a private DTO with fields
removed after serialization.
"""

from __future__ import annotations

import math
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from nexus.schemas.presence import Presence

SafeUint = Annotated[int, Field(strict=True, ge=0, le=2**53 - 1)]
NonNegativeInt32 = Annotated[int, Field(strict=True, ge=0, le=2**31 - 1)]
PositiveInt32 = Annotated[int, Field(strict=True, ge=1, le=2**31 - 1)]
PublicSectionHandle = Annotated[
    str,
    Field(pattern=r"^nxps1_[A-Za-z0-9_-]{48}$"),
]
PublicPageCursor = Annotated[
    str,
    Field(pattern=r"^nxpc1_[A-Za-z0-9_-]{48}$"),
]


class PublicSchemaModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class PublicTimeRangeOut(PublicSchemaModel):
    start_ms: SafeUint
    end_ms: SafeUint

    @model_validator(mode="after")
    def validate_order(self) -> PublicTimeRangeOut:
        if self.start_ms >= self.end_ms:
            raise ValueError("start_ms must be less than end_ms")
        return self


class PublicMediaSubjectOut(PublicSchemaModel):
    kind: Literal["Media"] = "Media"


class PublicPdfQuad(PublicSchemaModel):
    x1: float
    y1: float
    x2: float
    y2: float
    x3: float
    y3: float
    x4: float
    y4: float

    @model_validator(mode="after")
    def validate_finite(self) -> PublicPdfQuad:
        if not all(
            math.isfinite(value)
            for value in (
                self.x1,
                self.y1,
                self.x2,
                self.y2,
                self.x3,
                self.y3,
                self.x4,
                self.y4,
            )
        ):
            raise ValueError("PDF quad coordinates must be finite")
        return self


class PublicArticleTextAnchorOut(PublicSchemaModel):
    kind: Literal["ArticleText"] = "ArticleText"
    fragment_ordinal: NonNegativeInt32
    start_offset: NonNegativeInt32
    end_offset: NonNegativeInt32

    @model_validator(mode="after")
    def validate_offsets(self) -> PublicArticleTextAnchorOut:
        if self.start_offset >= self.end_offset:
            raise ValueError("start_offset must be less than end_offset")
        return self


class PublicEpubTextAnchorOut(PublicSchemaModel):
    kind: Literal["EpubText"] = "EpubText"
    section_handle: PublicSectionHandle
    start_offset: NonNegativeInt32
    end_offset: NonNegativeInt32

    @model_validator(mode="after")
    def validate_offsets(self) -> PublicEpubTextAnchorOut:
        if self.start_offset >= self.end_offset:
            raise ValueError("start_offset must be less than end_offset")
        return self


class PublicTranscriptTextAnchorOut(PublicSchemaModel):
    kind: Literal["TranscriptText"] = "TranscriptText"
    segment_ordinal: NonNegativeInt32
    start_offset: NonNegativeInt32
    end_offset: NonNegativeInt32
    time_range: Presence[PublicTimeRangeOut]

    @model_validator(mode="after")
    def validate_offsets(self) -> PublicTranscriptTextAnchorOut:
        if self.start_offset >= self.end_offset:
            raise ValueError("start_offset must be less than end_offset")
        return self


class PublicPdfGeometryAnchorOut(PublicSchemaModel):
    kind: Literal["PdfGeometry"] = "PdfGeometry"
    page_number: PositiveInt32
    quads: Annotated[list[PublicPdfQuad], Field(min_length=1, max_length=512)]


PublicHighlightAnchorOut = Annotated[
    PublicArticleTextAnchorOut
    | PublicEpubTextAnchorOut
    | PublicTranscriptTextAnchorOut
    | PublicPdfGeometryAnchorOut,
    Field(discriminator="kind"),
]


class PublicHighlightOut(PublicSchemaModel):
    quote: Presence[Annotated[str, Field(max_length=65_536)]]
    color: Literal["Yellow", "Green", "Blue", "Pink", "Purple"]
    anchor: PublicHighlightAnchorOut

    @field_validator("quote")
    @classmethod
    def validate_quote_utf8_bound(cls, value):
        if value.kind == "Present" and len(value.value.encode("utf-8")) > 65_536:
            raise ValueError("highlight quote exceeds 64 KiB UTF-8")
        return value


class PublicHighlightSubjectOut(PublicSchemaModel):
    kind: Literal["Highlight"] = "Highlight"
    highlight: PublicHighlightOut


PublicSubjectOut = Annotated[
    PublicMediaSubjectOut | PublicHighlightSubjectOut,
    Field(discriminator="kind"),
]


class PublicMediaOut(PublicSchemaModel):
    title: Annotated[str, Field(min_length=1, max_length=1024)]
    media_kind: Literal["Article", "Epub", "Pdf", "Video", "PodcastEpisode"]
    source_url: Presence[str]
    bylines: Annotated[
        list[Annotated[str, Field(min_length=1, max_length=512)]],
        Field(max_length=32),
    ]

    @field_validator("source_url")
    @classmethod
    def validate_source_url_bound(cls, value):
        if value.kind == "Present" and len(value.value.encode("utf-8")) > 2048:
            raise ValueError("source URL exceeds 2048 UTF-8 bytes")
        return value


class PublicArticleReaderOut(PublicSchemaModel):
    kind: Literal["Article"] = "Article"


class PublicEpubReaderOut(PublicSchemaModel):
    kind: Literal["Epub"] = "Epub"


class PublicPdfReaderOut(PublicSchemaModel):
    kind: Literal["Pdf"] = "Pdf"
    byte_length: Annotated[SafeUint, Field(ge=1)]
    filename: Annotated[str, Field(min_length=1, max_length=255)]


class PublicTranscriptReaderOut(PublicSchemaModel):
    kind: Literal["Transcript"] = "Transcript"
    source_kind: Literal["Video", "PodcastEpisode"]
    duration_ms: Presence[SafeUint]


PublicReaderOut = Annotated[
    PublicArticleReaderOut | PublicEpubReaderOut | PublicPdfReaderOut | PublicTranscriptReaderOut,
    Field(discriminator="kind"),
]


class PublicShareBootstrapOut(PublicSchemaModel):
    version: Literal["V1"] = "V1"
    subject: PublicSubjectOut
    media: PublicMediaOut
    reader: PublicReaderOut


class PublicPageInfo(PublicSchemaModel):
    next_cursor: Presence[PublicPageCursor]


class PublicArticleFragmentOut(PublicSchemaModel):
    ordinal: NonNegativeInt32
    html_sanitized: str
    canonical_text: str

    @model_validator(mode="after")
    def validate_field_bounds(self) -> PublicArticleFragmentOut:
        if len(self.html_sanitized.encode("utf-8")) > 2 * 1024 * 1024:
            raise ValueError("article HTML exceeds 2 MiB UTF-8")
        if len(self.canonical_text.encode("utf-8")) > 2 * 1024 * 1024:
            raise ValueError("article text exceeds 2 MiB UTF-8")
        return self


class PublicTranscriptSegmentOut(PublicSchemaModel):
    ordinal: NonNegativeInt32
    canonical_text: str
    time_range: Presence[PublicTimeRangeOut]
    speaker: Presence[Annotated[str, Field(max_length=512)]]

    @field_validator("canonical_text")
    @classmethod
    def validate_text_bound(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 2 * 1024 * 1024:
            raise ValueError("transcript text exceeds 2 MiB UTF-8")
        return value


class PublicArticleFragmentPageOut(PublicSchemaModel):
    kind: Literal["ArticleFragments"] = "ArticleFragments"
    items: list[PublicArticleFragmentOut]
    page_info: PublicPageInfo


class PublicTranscriptSegmentPageOut(PublicSchemaModel):
    kind: Literal["TranscriptSegments"] = "TranscriptSegments"
    items: list[PublicTranscriptSegmentOut]
    page_info: PublicPageInfo


PublicFragmentPageOut = Annotated[
    PublicArticleFragmentPageOut | PublicTranscriptSegmentPageOut,
    Field(discriminator="kind"),
]


class PublicNavigationItemOut(PublicSchemaModel):
    ordinal: NonNegativeInt32
    label: Annotated[str, Field(max_length=512)]
    depth: NonNegativeInt32
    section_handle: PublicSectionHandle


class PublicNavigationPageOut(PublicSchemaModel):
    kind: Literal["EpubNavigation"] = "EpubNavigation"
    items: list[PublicNavigationItemOut]
    page_info: PublicPageInfo


class PublicSectionOut(PublicSchemaModel):
    kind: Literal["EpubSection"] = "EpubSection"
    ordinal: NonNegativeInt32
    section_handle: PublicSectionHandle
    html_sanitized: str
    canonical_text: str

    @model_validator(mode="after")
    def validate_field_bounds(self) -> PublicSectionOut:
        if len(self.html_sanitized.encode("utf-8")) > 4 * 1024 * 1024:
            raise ValueError("EPUB HTML exceeds 4 MiB UTF-8")
        if len(self.canonical_text.encode("utf-8")) > 4 * 1024 * 1024:
            raise ValueError("EPUB text exceeds 4 MiB UTF-8")
        return self
