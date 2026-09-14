"""Immutable reader members; canonical fragment coordinates survive partitioning."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    TypeAdapter,
    model_validator,
)

from nexus.schemas.epub_find import (
    EpubFindEntireResourceScopeIn,
    EpubFindSectionScopeIn,
    ReaderLiteralFindOccurrenceFields,
    ReaderLiteralFindQueryFields,
)
from nexus.schemas.highlights import HIGHLIGHT_COLORS
from nexus.schemas.media import (
    DocumentEmbedOut,
    DocumentEmbedSource,
    ReaderNavigationLocationOut,
    ReaderNavigationSectionFields,
)
from nexus.schemas.reader import (
    EpubReaderResumeState,
    ReaderEpubTarget,
    ReaderResumeState,
    WebReaderResumeState,
)
from nexus.schemas.reader_apparatus import (
    ReaderApparatusConfidence,
    ReaderApparatusItemKind,
    ReaderApparatusRelation,
)
from nexus.schemas.retrieval import (
    EpubFragmentOffsetsLocator,
    PdfGeometryQuad,
    WebTextOffsetsLocator,
)

READER_PUBLICATION_CONTRACT_VERSION = 1
# The shared renderer owns a prepared root and its HtmlRenderer host.
READER_PUBLICATION_MOUNT_NODES = 2
ReaderPublicationMemberRole = Literal["descriptor", "index", "unit", "asset", "archive"]


def _nonblank_fragment_id(value: str) -> str:
    if not value.strip():
        raise ValueError("Reader fragment identity must not be blank")
    return value


ReaderPublicationFragmentId = Annotated[
    str, Field(min_length=1, max_length=256), AfterValidator(_nonblank_fragment_id)
]


class _PublicationModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ReaderPublicationMemberRef(_PublicationModel):
    key: str = Field(min_length=1)
    bytes: int = Field(ge=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class ReaderPublicationCapturedAsset(_PublicationModel):
    kind: Literal["Captured"] = "Captured"
    member: ReaderPublicationMemberRef
    media_type: str = Field(min_length=1)
    package_href: str | None


class ReaderPublicationUnavailableAsset(_PublicationModel):
    kind: Literal["Unavailable"] = "Unavailable"
    source_url: str = Field(min_length=1)
    reason: Literal["NotFound", "InvalidImage"]


ReaderPublicationAssetRef = Annotated[
    ReaderPublicationCapturedAsset | ReaderPublicationUnavailableAsset,
    Field(discriminator="kind"),
]


class ReaderPublicationTextDescriptor(_PublicationModel):
    media_id: UUID
    reader_generation: int = Field(ge=1)
    kind: Literal["epub", "web_article"]
    title: str
    reader_contract_version: Literal[1] = READER_PUBLICATION_CONTRACT_VERSION
    first_unit_ref: ReaderPublicationMemberRef
    index_ref: ReaderPublicationMemberRef
    contents_ref: ReaderPublicationMemberRef | None
    table_metadata_ref: ReaderPublicationMemberRef | None
    unit_count: int = Field(ge=1)
    canonical_length: int = Field(ge=0)


class ReaderPublicationPdfDescriptor(_PublicationModel):
    media_id: UUID
    reader_generation: int = Field(ge=1)
    kind: Literal["pdf"] = "pdf"
    title: str
    reader_contract_version: Literal[1] = READER_PUBLICATION_CONTRACT_VERSION
    document_asset_ref: ReaderPublicationMemberRef
    page_count: int = Field(ge=1)


ReaderPublicationDescriptor = Annotated[
    ReaderPublicationTextDescriptor | ReaderPublicationPdfDescriptor,
    Field(discriminator="kind"),
]
PUBLICATION_DESCRIPTOR = TypeAdapter(ReaderPublicationDescriptor)


class ReaderPublicationSourceRange(_PublicationModel):
    unit_key: str = Field(min_length=1)
    fragment_id: ReaderPublicationFragmentId
    start_cp: int = Field(ge=0)
    end_cp: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_extent(self) -> "ReaderPublicationSourceRange":
        if self.end_cp < self.start_cp:
            raise ValueError("source range end precedes its start")
        return self


class ReaderPublicationTableCell(_PublicationModel):
    row: int = Field(ge=0)
    column: int = Field(ge=0)
    row_span: int = Field(ge=1)
    column_span: int = Field(ge=1)
    continued_before: bool
    continued_after: bool


class ReaderPublicationTableContext(_PublicationModel):
    table_ordinal: int = Field(ge=0)
    row_count: int = Field(ge=0)
    column_count: int = Field(ge=0)
    caption: ReaderPublicationSourceRange | None
    cells: tuple[ReaderPublicationTableCell, ...]

    @model_validator(mode="after")
    def validate_cells(self) -> "ReaderPublicationTableContext":
        if len({(cell.row, cell.column) for cell in self.cells}) != len(self.cells):
            raise ValueError("table excerpt repeats a source cell")
        if any(
            cell.row + cell.row_span > self.row_count
            or cell.column + cell.column_span > self.column_count
            for cell in self.cells
        ):
            raise ValueError("source cell extent exceeds its original table grid")
        return self


# Existing source envelopes imply coordinates below 2**43: even one cell per
# byte of a 64 MiB legacy reader times the HTML maximum rowspan is smaller.
# Safe JSON integers preserve that source contract and SQLite int64 geometry.
ReaderTableCoordinate = Annotated[int, Field(ge=0, le=2**53 - 1)]


class _ReaderTableIdentity(_PublicationModel):
    fragment_id: ReaderPublicationFragmentId
    table_ordinal: ReaderTableCoordinate


class ReaderPublicationTableMetadata(_ReaderTableIdentity):
    kind: Literal["Table"] = "Table"
    row_count: ReaderTableCoordinate
    column_count: ReaderTableCoordinate
    caption: ReaderPublicationSourceRange | None


class ReaderPublicationTableColumnGroup(_ReaderTableIdentity):
    kind: Literal["ColumnGroup"] = "ColumnGroup"
    start: ReaderTableCoordinate
    end: ReaderTableCoordinate


class ReaderPublicationTableCellMetadata(_ReaderTableIdentity):
    kind: Literal["Cell"] = "Cell"
    row: ReaderTableCoordinate
    column: ReaderTableCoordinate
    row_span: Annotated[int, Field(ge=1, le=2**53 - 1)]
    column_span: int = Field(ge=1, le=1000)
    row_group: ReaderTableCoordinate | None
    header_kind: Literal["data", "none", "row", "column", "rowgroup", "colgroup"]
    empty: bool
    explicit_headers: bool
    range: ReaderPublicationSourceRange


class ReaderPublicationTableExplicitHeader(_ReaderTableIdentity):
    kind: Literal["ExplicitHeader"] = "ExplicitHeader"
    row: ReaderTableCoordinate
    column: ReaderTableCoordinate
    target_row: ReaderTableCoordinate
    target_column: ReaderTableCoordinate


ReaderPublicationTableMetadataRecord = Annotated[
    ReaderPublicationTableMetadata
    | ReaderPublicationTableColumnGroup
    | ReaderPublicationTableCellMetadata
    | ReaderPublicationTableExplicitHeader,
    Field(discriminator="kind"),
]


ReaderPublicationElementNamespace = Literal["html", "svg", "mathml"]
ReaderPublicationAttributeNamespace = Literal["xlink", "xml", "xmlns"]


class ReaderPublicationLocalFragment(_PublicationModel):
    kind: Literal["LocalFragment"] = "LocalFragment"
    # DOM ID after CSS decoding and exactly one URL percent-decoding pass.
    fragment_id: str = Field(min_length=1)
    fallback: str | None


class ReaderPublicationRenderAttribute(_PublicationModel):
    namespace: ReaderPublicationAttributeNamespace | None
    name: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_.:-]*$")
    value: str | ReaderPublicationLocalFragment

    @model_validator(mode="after")
    def validate_local_name(self) -> "ReaderPublicationRenderAttribute":
        if self.namespace is not None and ":" in self.name:
            raise ValueError("namespaced attributes carry a local name")
        if isinstance(self.value, ReaderPublicationLocalFragment) and (
            self.namespace is not None or self.name not in {"fill", "stroke", "clip-path"}
        ):
            raise ValueError("local paint references require a supported SVG paint attribute")
        return self


class ReaderPublicationRenderElement(_PublicationModel):
    kind: Literal["Element"] = "Element"
    parent: Annotated[StrictInt, Field(ge=0)] | None
    namespace: ReaderPublicationElementNamespace
    name: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_.-]*$")
    attributes: tuple[ReaderPublicationRenderAttribute, ...]

    @model_validator(mode="after")
    def validate_attributes(self) -> "ReaderPublicationRenderElement":
        if len({(attr.namespace, attr.name) for attr in self.attributes}) != len(self.attributes):
            raise ValueError("render element repeats an attribute")
        if self.namespace != "svg" and any(
            isinstance(attr.value, ReaderPublicationLocalFragment) for attr in self.attributes
        ):
            raise ValueError("local paint references require an SVG element")
        return self


class ReaderPublicationRenderText(_PublicationModel):
    kind: Literal["Text"] = "Text"
    parent: Annotated[StrictInt, Field(ge=0)] | None
    text: str = Field(min_length=1)


class ReaderPublicationRenderComment(_PublicationModel):
    kind: Literal["Comment"] = "Comment"
    parent: Annotated[StrictInt, Field(ge=0)] | None
    text: str


ReaderPublicationRenderNode = Annotated[
    ReaderPublicationRenderElement | ReaderPublicationRenderText | ReaderPublicationRenderComment,
    Field(discriminator="kind"),
]


class ReaderPublicationUnitBody(_PublicationModel):
    fragment_id: ReaderPublicationFragmentId
    epub_target: ReaderEpubTarget | None
    fragment_idx: int = Field(ge=0)
    fragment_document_start_cp: int = Field(ge=0)
    fragment_length_cp: int = Field(ge=0)
    document_word_start: int = Field(ge=0)
    starts_in_word: bool
    start_cp: int = Field(ge=0)
    end_cp: int = Field(ge=0)
    # Absolute fragment offsets; only separator gaps may lie outside this interval.
    render_start_cp: int = Field(ge=0)
    render_end_cp: int = Field(ge=0)
    render_nodes: tuple[ReaderPublicationRenderNode, ...]
    canonical_text: str
    # null: a local schema-1 conversion has no Find capability; [] is computed.
    word_boundaries: tuple[int, ...] | None
    assets: tuple[ReaderPublicationAssetRef, ...]
    table_contexts: tuple[ReaderPublicationTableContext, ...]
    document_embeds: tuple[DocumentEmbedSource, ...]

    @model_validator(mode="after")
    def validate_extents(self) -> "ReaderPublicationUnitBody":
        ancestors: list[int] = []
        for index, node in enumerate(self.render_nodes):
            while ancestors and ancestors[-1] != node.parent:
                ancestors.pop()
            if node.parent is not None and not ancestors:
                raise ValueError("render nodes must form contiguous preorder subtrees")
            if isinstance(node, ReaderPublicationRenderElement):
                ancestors.append(index)
        if not self.start_cp <= self.render_start_cp <= self.render_end_cp <= self.end_cp:
            raise ValueError("render extent must lie inside the canonical extent")
        if self.end_cp > self.fragment_length_cp:
            raise ValueError("unit extent exceeds original fragment length")
        if len(self.canonical_text) != self.end_cp - self.start_cp:
            raise ValueError("unit text must exactly cover its canonical extent")
        leading = self.canonical_text[: self.render_start_cp - self.start_cp]
        trailing = self.canonical_text[self.render_end_cp - self.start_cp :]
        if leading.strip() or trailing.strip():
            raise ValueError("unrendered unit boundaries may contain only separators")
        if self.word_boundaries is not None and (
            tuple(sorted(set(self.word_boundaries))) != self.word_boundaries
            or any(point < self.start_cp or point > self.end_cp for point in self.word_boundaries)
        ):
            raise ValueError("word boundaries must be unique ordered original fragment offsets")
        if len({item.id for item in self.document_embeds}) != len(self.document_embeds) or len(
            {item.occurrence_key for item in self.document_embeds}
        ) != len(self.document_embeds):
            raise ValueError("unit repeats an embed source occurrence")
        if tuple(sorted({item.ordinal for item in self.document_embeds})) != tuple(
            item.ordinal for item in self.document_embeds
        ):
            raise ValueError("unit embed sources must preserve authored order")
        anchors = [
            attribute.value
            for node in self.render_nodes
            if isinstance(node, ReaderPublicationRenderElement)
            for attribute in node.attributes
            if attribute.namespace is None and attribute.name == "data-nexus-document-embed-id"
        ]
        if set(anchors) != {item.occurrence_key for item in self.document_embeds} or len(
            anchors
        ) != len(self.document_embeds):
            raise ValueError("unit embed sources must exactly match its retained anchors")
        for source in self.document_embeds:
            start, end = source.canonical_start_offset, source.canonical_end_offset
            if (start is None) != (end is None) or (
                start is not None
                and end is not None
                and not 0 <= start <= end <= self.fragment_length_cp
            ):
                raise ValueError("unit embed source range exceeds original fragment")
        return self


class ReaderPublicationEmbedsRequest(_PublicationModel):
    unit_key: str = Field(min_length=1)
    after_ordinal: int | None = Field(ge=0)


class ReaderPublicationEmbedsPage(_PublicationModel):
    items: tuple[DocumentEmbedOut, ...]
    next_ordinal: int | None


class ReaderPublicationPreparationRequest(_PublicationModel):
    media_id: UUID
    expected_generation: int = Field(ge=1, strict=True)


class ReaderPublicationHighlightsRequest(_PublicationModel):
    unit_key: str = Field(min_length=1)
    mine_only: bool
    after: str | None = Field(min_length=1, max_length=16_384)
    # Same user-selected page range as the existing reader connection owner.
    limit: int = Field(ge=1, le=100)


class ReaderPublicationHighlightPaint(_PublicationModel):
    id: UUID
    color: HIGHLIGHT_COLORS
    start_offset: int = Field(ge=0)
    end_offset: int = Field(gt=0)
    created_at: datetime
    author_user_id: UUID
    is_owner: bool


class ReaderPublicationHighlightsPage(_PublicationModel):
    items: tuple[ReaderPublicationHighlightPaint, ...]
    next_cursor: str | None


class ReaderPublicationHighlightSummariesRequest(_PublicationModel):
    mine_only: bool
    after: str | None = Field(min_length=1, max_length=16_384)
    limit: int = Field(ge=1, le=100)


class ReaderPublicationHighlightSummary(_PublicationModel):
    id: UUID
    color: HIGHLIGHT_COLORS
    quote_excerpt: str
    quote_codepoints: int = Field(ge=0)
    created_at: datetime
    updated_at: datetime
    author_user_id: UUID
    is_owner: bool
    range: ReaderPublicationSourceRange | None


class ReaderPublicationHighlightSummariesPage(_PublicationModel):
    items: tuple[ReaderPublicationHighlightSummary, ...]
    next_cursor: str | None


class ReaderPublicationApparatusRequest(_PublicationModel):
    after: str | None = Field(min_length=1, max_length=16_384)
    limit: int = Field(ge=1, le=100)


class ReaderPublicationApparatusLookupRequest(_PublicationModel):
    stable_key: str = Field(min_length=1)


class ReaderPublicationApparatusSummary(_PublicationModel):
    id: UUID
    stable_key: str = Field(min_length=1)
    kind: ReaderApparatusItemKind
    confidence: ReaderApparatusConfidence
    label_excerpt: str | None
    label_codepoints: int | None = Field(ge=0)
    label_source_id: UUID | None
    body_excerpt: str | None
    body_codepoints: int | None = Field(ge=0)
    body_source_id: UUID | None
    has_targets: bool
    source_range: ReaderPublicationSourceRange | None
    pdf_page: int | None = Field(ge=1)


class ReaderPublicationApparatusPage(_PublicationModel):
    items: tuple[ReaderPublicationApparatusSummary, ...]
    next_cursor: str | None


class ReaderPublicationApparatusTarget(_PublicationModel):
    edge_id: UUID
    relation: ReaderApparatusRelation
    confidence: ReaderApparatusConfidence
    target: ReaderPublicationApparatusSummary


class ReaderPublicationApparatusTargetsPage(_PublicationModel):
    items: tuple[ReaderPublicationApparatusTarget, ...]
    next_cursor: str | None


class ReaderPublicationApparatusTextRequest(_PublicationModel):
    field: Literal["Body", "Label"]
    offset_cp: int = Field(ge=0)


class ReaderPublicationApparatusTextPage(_PublicationModel):
    field: Literal["Body", "Label"]
    offset_cp: int = Field(ge=0)
    text: str
    total_codepoints: int = Field(ge=0)
    next_offset_cp: int | None = Field(ge=0)


class ReaderPublicationApparatusTextLocation(_PublicationModel):
    kind: Literal["Text"] = "Text"
    range: ReaderPublicationSourceRange


class ReaderPublicationApparatusPdfLocation(_PublicationModel):
    kind: Literal["Pdf"] = "Pdf"
    page: int = Field(ge=1)
    quads: tuple[PdfGeometryQuad, ...] = Field(min_length=1, max_length=512)


class ReaderPublicationApparatusUnavailableLocation(_PublicationModel):
    kind: Literal["Unavailable"] = "Unavailable"


ReaderPublicationApparatusLocation = Annotated[
    ReaderPublicationApparatusTextLocation
    | ReaderPublicationApparatusPdfLocation
    | ReaderPublicationApparatusUnavailableLocation,
    Field(discriminator="kind"),
]


class ReaderPublicationUnitIndex(_PublicationModel):
    member: ReaderPublicationMemberRef
    ordinal: int = Field(ge=0)
    fragment_id: ReaderPublicationFragmentId
    fragment_idx: int = Field(ge=0)
    start_cp: int = Field(ge=0)
    end_cp: int = Field(ge=0)


class ReaderPublicationTocEntry(_PublicationModel):
    """Flat form of the existing TOC node; parent links preserve full hierarchy."""

    id: str
    parent_id: str | None
    label: str
    ordinal: int
    href: str | None
    fragment_idx: int | None
    level: int | None
    depth: int | None
    section_id: str | None


class ReaderPublicationSection(ReaderNavigationSectionFields):
    section_id: str = Field(min_length=1, max_length=256)
    unit_key: str = Field(min_length=1)
    model_config = ConfigDict(extra="forbid", frozen=True)
    fragment_id: ReaderPublicationFragmentId

    @model_validator(mode="after")
    def validate_extent(self) -> "ReaderPublicationSection":
        if self.end_offset is not None and self.end_offset < self.start_offset:
            raise ValueError("Publication navigation extent is reversed")
        return self


class ReaderPublicationAnchor(_PublicationModel):
    href_path: str = Field(min_length=1)
    anchor_id: str = Field(min_length=1)
    unit_key: str = Field(min_length=1)
    offset_cp: int = Field(ge=0)


class ReaderPublicationIndexPage(_PublicationModel):
    units: tuple[ReaderPublicationUnitIndex, ...]
    sections: tuple[ReaderPublicationSection, ...]
    toc: tuple[ReaderPublicationTocEntry, ...]
    landmarks: tuple[ReaderNavigationLocationOut, ...]
    page_list: tuple[ReaderNavigationLocationOut, ...]
    table_metadata: tuple[ReaderPublicationTableMetadataRecord, ...]
    anchors: tuple[ReaderPublicationAnchor, ...]
    next_ref: ReaderPublicationMemberRef | None

    @model_validator(mode="after")
    def validate_context_chain(self) -> "ReaderPublicationIndexPage":
        if self.table_metadata and any(
            (self.units, self.sections, self.toc, self.landmarks, self.page_list, self.anchors)
        ):
            raise ValueError("table metadata cannot share the navigation index chain")
        return self

    @model_validator(mode="after")
    def validate_unit_refs(self) -> "ReaderPublicationIndexPage":
        # The index chain partitions the document: a repeated ref would deliver one
        # canonical extent twice and a descending ordinal would break the document
        # arithmetic that reads ordinals as a total order.
        keys = [unit.member.key for unit in self.units]
        if len(set(keys)) != len(keys):
            raise ValueError("index page repeats a unit ref")
        ordinals = [unit.ordinal for unit in self.units]
        if sorted(set(ordinals)) != ordinals:
            raise ValueError("index page units must ascend by ordinal")
        return self


class ReaderPublicationSectionScope(EpubFindSectionScopeIn):
    section_id: str = Field(min_length=1, max_length=256)


class ReaderPublicationFindRequest(ReaderLiteralFindQueryFields):
    """Publication Find request: the shared literal query over a publication scope.

    The scope is declared here rather than inherited, because publication scopes
    carry publication section ids — a different type from the EPUB scope, which an
    inherited field could not be narrowed to.
    """

    scope: Annotated[
        EpubFindEntireResourceScopeIn | ReaderPublicationSectionScope, Field(discriminator="kind")
    ]
    after: str | None = Field(default=None, min_length=1, max_length=16_384)


class ReaderPublicationSectionContextRequest(_PublicationModel):
    locator: Annotated[WebReaderResumeState | EpubReaderResumeState, Field(discriminator="kind")]

    @model_validator(mode="after")
    def require_captured_offset(self) -> "ReaderPublicationSectionContextRequest":
        if self.locator.locations.text_offset is None:
            raise ValueError("section context requires an explicit captured text offset")
        return self


class ReaderPublicationSectionSummary(_PublicationModel):
    section_id: str
    label: str
    ordinal: int = Field(ge=0)
    unit_key: str
    fragment_id: ReaderPublicationFragmentId
    start_offset: int = Field(ge=0)
    end_offset: int | None = Field(ge=0)
    href_path: str | None
    anchor_id: str | None


class ReaderPublicationSectionContext(_PublicationModel):
    current: ReaderPublicationSectionSummary | None
    previous: ReaderPublicationSectionSummary | None
    next: ReaderPublicationSectionSummary | None
    section_position: int | None = Field(ge=1)
    section_count: int = Field(ge=0)


class ReaderPublicationFindOccurrence(ReaderLiteralFindOccurrenceFields):
    locator: ReaderResumeState
    fragment_id: ReaderPublicationFragmentId
    section_id: str | None = Field(min_length=1, max_length=256)
    section_label: str | None = Field(min_length=1, max_length=512)


class ReaderPublicationFindPage(_PublicationModel):
    occurrences: tuple[ReaderPublicationFindOccurrence, ...]
    next_cursor: str | None


class ReaderPublicationLocatorTarget(_PublicationModel):
    kind: Literal["Locator"] = "Locator"
    locator: ReaderResumeState


class ReaderPublicationUnitTarget(_PublicationModel):
    kind: Literal["Unit"] = "Unit"
    unit_key: str = Field(min_length=1)


class ReaderPublicationNavigationTarget(_PublicationModel):
    kind: Literal["Navigation"] = "Navigation"
    target_id: str = Field(min_length=1, max_length=256)


class ReaderPublicationEpubHrefTarget(_PublicationModel):
    kind: Literal["EpubHref"] = "EpubHref"
    pathname: str = Field(min_length=1)
    anchor_id: str | None = Field(min_length=1)


class ReaderPublicationSourceRangeTarget(_PublicationModel):
    kind: Literal["SourceRange"] = "SourceRange"
    locator: Annotated[
        WebTextOffsetsLocator | EpubFragmentOffsetsLocator, Field(discriminator="type")
    ]


class ReaderPublicationResolveRequest(_PublicationModel):
    target: Annotated[
        ReaderPublicationLocatorTarget
        | ReaderPublicationUnitTarget
        | ReaderPublicationNavigationTarget
        | ReaderPublicationEpubHrefTarget
        | ReaderPublicationSourceRangeTarget,
        Field(discriminator="kind"),
    ]


class _ReaderPublicationAddressedUnit(_PublicationModel):
    unit_ref: ReaderPublicationMemberRef
    ordinal: int = Field(ge=0)
    previous_ref: ReaderPublicationMemberRef | None
    next_ref: ReaderPublicationMemberRef | None
    fragment_id: ReaderPublicationFragmentId


class ReaderPublicationUnitResolution(_ReaderPublicationAddressedUnit):
    kind: Literal["Unit"] = "Unit"
    start_cp: int = Field(ge=0)
    end_cp: int = Field(ge=0)


class ReaderPublicationTextResolution(_ReaderPublicationAddressedUnit):
    kind: Literal["Text"] = "Text"
    locator: ReaderResumeState
    offset_cp: int = Field(ge=0)
    local_offset_cp: int = Field(ge=0)


class ReaderPublicationSourceRangeResolution(_ReaderPublicationAddressedUnit):
    kind: Literal["SourceRange"] = "SourceRange"
    locator: ReaderResumeState
    range: ReaderPublicationSourceRange


class ReaderPublicationPdfResolution(_PublicationModel):
    kind: Literal["Pdf"] = "Pdf"
    locator: ReaderResumeState
    document_asset_ref: ReaderPublicationMemberRef
    page: int = Field(ge=1)


class ReaderPublicationUnresolved(_PublicationModel):
    kind: Literal["Unresolved"] = "Unresolved"
    locator: ReaderResumeState | None
    reason: Literal["TargetMissing", "OffsetOutOfRange", "QuoteMissing", "QuoteAmbiguous"]

    # Raw source targets and navigation targets have no resume locator until
    # resolution succeeds. The caller retains its original authored target.


class ReaderPublicationIncomplete(_PublicationModel):
    kind: Literal["Incomplete"] = "Incomplete"
    locator: ReaderResumeState
    next_cursor: str


ReaderPublicationResolution = Annotated[
    ReaderPublicationTextResolution
    | ReaderPublicationUnitResolution
    | ReaderPublicationSourceRangeResolution
    | ReaderPublicationPdfResolution
    | ReaderPublicationUnresolved
    | ReaderPublicationIncomplete,
    Field(discriminator="kind"),
]
