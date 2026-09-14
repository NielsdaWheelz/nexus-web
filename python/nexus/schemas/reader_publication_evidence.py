"""Bounded reader evidence facts; authored bodies remain explicit detail reads."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.highlights import HIGHLIGHT_COLORS
from nexus.schemas.reader_apparatus import ReaderApparatusConfidence, ReaderApparatusItemKind
from nexus.schemas.reader_document_map import (
    ReaderDocumentMapMarkerTone,
    ReaderEvidenceCountsOut,
    ReaderEvidenceUnavailableReason,
)
from nexus.schemas.reader_publication import ReaderPublicationSourceRange
from nexus.schemas.resource_graph import EdgeKind, EdgeOrigin
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.schemas.retrieval import PdfGeometryQuad

ReaderEvidenceFactKind = Literal[
    "Highlight", "SourceReference", "GeneratedCitation", "Link", "Synapse"
]


class _EvidenceModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class _EvidenceObject(_EvidenceModel):
    ref: str
    label_excerpt: str
    label_codepoints: int = Field(ge=0)
    excerpt: str | None
    excerpt_codepoints: int | None = Field(ge=0)
    activation: ResourceActivationOut


class ReaderEvidenceObjectSummary(_EvidenceObject):
    kind: Literal["Dossier", "Oracle", "Media", "Other"]


class ReaderEvidenceChatSummary(_EvidenceObject):
    kind: Literal["Chat"] = "Chat"
    conversation_id: UUID
    message_ref: str | None


class ReaderEvidenceNoteSummary(_EvidenceObject):
    kind: Literal["Note"] = "Note"
    note_block_id: UUID


ReaderEvidenceRelatedSummary = Annotated[
    ReaderEvidenceObjectSummary | ReaderEvidenceChatSummary | ReaderEvidenceNoteSummary,
    Field(discriminator="kind"),
]


class ReaderEvidenceTextPosition(_EvidenceModel):
    kind: Literal["Text"] = "Text"
    range: ReaderPublicationSourceRange


class ReaderEvidencePdfPosition(_EvidenceModel):
    kind: Literal["Pdf"] = "Pdf"
    page: int = Field(ge=1)


class ReaderEvidenceUnavailablePosition(_EvidenceModel):
    kind: Literal["Unavailable"] = "Unavailable"
    reason: ReaderEvidenceUnavailableReason | Literal["SourceUnverified"]


class ReaderEvidenceDocumentPosition(_EvidenceModel):
    kind: Literal["Document"] = "Document"


ReaderEvidencePosition = Annotated[
    ReaderEvidenceTextPosition
    | ReaderEvidencePdfPosition
    | ReaderEvidenceUnavailablePosition
    | ReaderEvidenceDocumentPosition,
    Field(discriminator="kind"),
]


class _EvidenceFact(_EvidenceModel):
    id: str
    locus_ref: str
    label_excerpt: str
    label_codepoints: int = Field(ge=0)
    excerpt: str | None
    excerpt_codepoints: int | None = Field(ge=0)
    position: ReaderEvidencePosition
    association_count: int = Field(ge=0)
    also_reference_count: int = Field(ge=0)


class ReaderEvidenceHighlightSummary(_EvidenceFact):
    kind: Literal["Highlight"] = "Highlight"
    highlight_id: UUID
    color: HIGHLIGHT_COLORS
    created_at: datetime
    updated_at: datetime
    author_user_id: UUID
    is_owner: bool


class ReaderEvidenceSourceSummary(_EvidenceFact):
    kind: Literal["SourceReference"] = "SourceReference"
    item_id: UUID
    stable_key: str
    apparatus_kind: ReaderApparatusItemKind
    confidence: ReaderApparatusConfidence
    target_count: int = Field(ge=0)


class ReaderEvidenceCitationSummary(_EvidenceFact):
    kind: Literal["GeneratedCitation"] = "GeneratedCitation"
    edge_id: UUID
    role: EdgeKind


class ReaderEvidenceLinkSummary(_EvidenceFact):
    kind: Literal["Link"] = "Link"
    edge_id: UUID
    role: EdgeKind
    origin: EdgeOrigin
    object: ReaderEvidenceRelatedSummary


class ReaderEvidenceSynapseSummary(_EvidenceFact):
    kind: Literal["Synapse"] = "Synapse"
    edge_id: UUID
    role: EdgeKind
    object: ReaderEvidenceRelatedSummary


ReaderEvidenceFactSummary = Annotated[
    ReaderEvidenceHighlightSummary
    | ReaderEvidenceSourceSummary
    | ReaderEvidenceCitationSummary
    | ReaderEvidenceLinkSummary
    | ReaderEvidenceSynapseSummary,
    Field(discriminator="kind"),
]


class ReaderEvidenceFactsPage(_EvidenceModel):
    items: tuple[ReaderEvidenceFactSummary, ...]
    counts: ReaderEvidenceCountsOut
    next_cursor: str | None


class ReaderEvidenceAuthoredAssociation(_EvidenceModel):
    relationship: Literal["AuthoredIn"] = "AuthoredIn"
    object: ReaderEvidenceRelatedSummary


class ReaderEvidenceDirectAssociation(_EvidenceModel):
    relationship: Literal["DirectlyAttached"] = "DirectlyAttached"
    edge_id: UUID
    role: EdgeKind
    origin: EdgeOrigin
    direction: Literal["Outgoing", "Incoming"]
    object: ReaderEvidenceRelatedSummary


class ReaderEvidenceAlsoReference(_EvidenceModel):
    relationship: Literal["AlsoReferences"] = "AlsoReferences"
    object: ReaderEvidenceRelatedSummary


ReaderEvidenceAssociationSummary = Annotated[
    ReaderEvidenceAuthoredAssociation
    | ReaderEvidenceDirectAssociation
    | ReaderEvidenceAlsoReference,
    Field(discriminator="relationship"),
]


class ReaderEvidenceAssociationsPage(_EvidenceModel):
    items: tuple[ReaderEvidenceAssociationSummary, ...]
    next_cursor: str | None


class ReaderEvidenceUnitWindow(_EvidenceModel):
    kind: Literal["Unit"] = "Unit"
    unit_key: str = Field(min_length=1)


class ReaderEvidencePdfWindow(_EvidenceModel):
    kind: Literal["PdfPage"] = "PdfPage"
    page: int = Field(ge=1)


class ReaderEvidenceBucketWindow(_EvidenceModel):
    kind: Literal["Bucket"] = "Bucket"
    index: int = Field(ge=0)
    bucket_count: int = Field(ge=1)


ReaderEvidenceWindow = Annotated[
    ReaderEvidenceUnitWindow | ReaderEvidencePdfWindow | ReaderEvidenceBucketWindow,
    Field(discriminator="kind"),
]


class ReaderEvidenceFactsRequest(_EvidenceModel):
    scope: Literal["Passages", "Document"]
    kinds: tuple[ReaderEvidenceFactKind, ...]
    window: ReaderEvidenceWindow | None
    after: str | None
    limit: int = Field(ge=1, le=100)


class ReaderEvidenceFactTarget(_EvidenceModel):
    kind: Literal["Fact"] = "Fact"
    fact_id: str = Field(min_length=1)


class ReaderEvidenceSourceTarget(_EvidenceModel):
    kind: Literal["SourceReference"] = "SourceReference"
    stable_key: str = Field(min_length=1)


class ReaderEvidenceSeekRequest(_EvidenceModel):
    target: Annotated[
        ReaderEvidenceFactTarget | ReaderEvidenceSourceTarget, Field(discriminator="kind")
    ]
    scope: Literal["Passages", "Document"]
    kinds: tuple[ReaderEvidenceFactKind, ...]
    limit: int = Field(ge=1, le=100)


class ReaderEvidenceFactAssociations(_EvidenceModel):
    kind: Literal["Fact"] = "Fact"
    fact_id: str = Field(min_length=1)


class ReaderEvidenceLocusAssociations(_EvidenceModel):
    kind: Literal["Locus"] = "Locus"
    locus_ref: str = Field(min_length=1)


class ReaderEvidenceAssociationsRequest(_EvidenceModel):
    target: Annotated[
        ReaderEvidenceFactAssociations | ReaderEvidenceLocusAssociations,
        Field(discriminator="kind"),
    ]
    after: str | None
    limit: int = Field(ge=1, le=100)


class ReaderEvidenceLocationRequest(_EvidenceModel):
    fact_id: str = Field(min_length=1)


class ReaderEvidencePdfPageLocation(_EvidenceModel):
    kind: Literal["PdfPage"] = "PdfPage"
    page: int = Field(ge=1)
    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class ReaderEvidencePdfGeometryLocation(_EvidenceModel):
    kind: Literal["PdfGeometry"] = "PdfGeometry"
    page: int = Field(ge=1)
    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    quads: tuple[PdfGeometryQuad, ...] = Field(min_length=1, max_length=512)


class ReaderEvidenceLocationResponse(_EvidenceModel):
    fact_id: str
    location: Annotated[
        ReaderEvidenceTextPosition
        | ReaderEvidencePdfPageLocation
        | ReaderEvidencePdfGeometryLocation
        | ReaderEvidenceDocumentPosition
        | ReaderEvidenceUnavailablePosition,
        Field(discriminator="kind"),
    ]


class ReaderEvidenceVisibleUnit(_EvidenceModel):
    unit_key: str = Field(min_length=1)
    ranges: tuple[tuple[int, int], ...]

    @model_validator(mode="after")
    def valid_ranges(self) -> "ReaderEvidenceVisibleUnit":
        if any(start < 0 or end < start for start, end in self.ranges):
            raise ValueError("Invalid visible canonical range")
        return self


class ReaderEvidenceVisibleText(_EvidenceModel):
    kind: Literal["Text"] = "Text"
    units: tuple[ReaderEvidenceVisibleUnit, ...]


class ReaderEvidenceVisibleRect(_EvidenceModel):
    left: float = Field(allow_inf_nan=False)
    top: float = Field(allow_inf_nan=False)
    right: float = Field(allow_inf_nan=False)
    bottom: float = Field(allow_inf_nan=False)

    @model_validator(mode="after")
    def valid_extent(self) -> "ReaderEvidenceVisibleRect":
        if self.left >= self.right or self.top >= self.bottom:
            raise ValueError("Visible PDF rectangle must have positive area")
        return self


class ReaderEvidenceVisiblePage(_EvidenceModel):
    page: int = Field(ge=1)
    rect: ReaderEvidenceVisibleRect


class ReaderEvidenceVisiblePdf(_EvidenceModel):
    kind: Literal["Pdf"] = "Pdf"
    pages: tuple[ReaderEvidenceVisiblePage, ...]


class ReaderEvidenceGutterRequest(_EvidenceModel):
    window: Annotated[
        ReaderEvidenceVisibleText | ReaderEvidenceVisiblePdf, Field(discriminator="kind")
    ]
    kinds: tuple[ReaderEvidenceFactKind, ...]
    include_stances: bool
    after: str | None
    limit: int = Field(ge=1, le=24)


class ReaderEvidenceGutterItem(_EvidenceModel):
    id: str
    fact_id: str
    kind: ReaderEvidenceFactKind | Literal["Stance"]
    label_excerpt: str
    label_codepoints: int = Field(ge=0)
    excerpt: str | None
    excerpt_codepoints: int | None = Field(ge=0)
    location: Annotated[
        ReaderEvidenceTextPosition
        | ReaderEvidencePdfPageLocation
        | ReaderEvidencePdfGeometryLocation,
        Field(discriminator="kind"),
    ]
    edge_id: UUID | None
    stance: Literal["supports", "contradicts"] | None


class ReaderEvidenceGutterPage(_EvidenceModel):
    items: tuple[ReaderEvidenceGutterItem, ...]
    total_count: int = Field(ge=0)
    next_cursor: str | None


ReaderEvidenceMarkerKind = Literal[
    "Contents", "Embed", "Highlight", "SourceReference", "GeneratedCitation", "Link", "Synapse"
]


class ReaderEvidenceMarkerPreviewRequest(_EvidenceModel):
    marker_id: str = Field(min_length=1)


class ReaderEvidenceMarkerPreview(_EvidenceModel):
    marker_id: str
    kind: ReaderEvidenceMarkerKind
    tone: ReaderDocumentMapMarkerTone
    label_excerpt: str
    label_codepoints: int = Field(ge=0)
    excerpt: str | None
    excerpt_codepoints: int | None = Field(ge=0)


class ReaderEvidenceMarkerCounts(_EvidenceModel):
    contents: int = Field(ge=0)
    embeds: int = Field(ge=0)
    highlights: int = Field(ge=0)
    source_references: int = Field(ge=0)
    generated_citations: int = Field(ge=0)
    links: int = Field(ge=0)
    synapses: int = Field(ge=0)


class ReaderEvidenceOverviewRequest(_EvidenceModel):
    bucket_count: int = Field(ge=1, le=512)
    kinds: tuple[ReaderEvidenceMarkerKind, ...]


class ReaderEvidenceOverviewBucket(_EvidenceModel):
    index: int = Field(ge=0)
    counts: ReaderEvidenceMarkerCounts


class ReaderEvidenceOverview(_EvidenceModel):
    bucket_count: int = Field(ge=1, le=512)
    buckets: tuple[ReaderEvidenceOverviewBucket, ...]
    unavailable_counts: ReaderEvidenceMarkerCounts


class ReaderEvidenceBucketRequest(ReaderEvidenceOverviewRequest):
    index: int = Field(ge=0)
    after: str | None
    limit: int = Field(ge=1, le=100)


class ReaderEvidenceFactMarker(_EvidenceModel):
    kind: Literal["Fact"] = "Fact"
    fact_id: str


class ReaderEvidenceContentsMarker(_EvidenceModel):
    kind: Literal["Contents"] = "Contents"
    section_id: str
    unit_key: str


class ReaderEvidenceEmbedMarker(_EvidenceModel):
    kind: Literal["Embed"] = "Embed"
    unit_key: str
    id: UUID
    occurrence_key: str
    ordinal: int = Field(ge=0)


class ReaderEvidenceMarker(_EvidenceModel):
    id: str
    kind: ReaderEvidenceMarkerKind
    item_id: str
    position: float = Field(ge=0, le=1, allow_inf_nan=False)
    target: Annotated[
        ReaderEvidenceFactMarker | ReaderEvidenceContentsMarker | ReaderEvidenceEmbedMarker,
        Field(discriminator="kind"),
    ]


class ReaderEvidenceBucketPage(_EvidenceModel):
    items: tuple[ReaderEvidenceMarker, ...]
    next_cursor: str | None
