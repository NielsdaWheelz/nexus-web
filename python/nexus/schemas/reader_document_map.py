"""Reader map output: exact resource roots, own locations and native content."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.document_embeds import DocumentEmbedOut
from nexus.schemas.highlight_color import HighlightColor
from nexus.schemas.reader_apparatus import (
    ReaderApparatusConfidence,
    ReaderApparatusItemKind,
)
from nexus.schemas.resource_graph import EdgeOrigin
from nexus.schemas.resource_items import (
    ExcerptOut,
    ResourceActivationOut,
    ResourceItemOut,
    SourceAttributionOut,
)
from nexus.schemas.retrieval import MediaRetrievalLocator

ReaderDocumentMapStatus = Literal["ready", "empty", "partial"]
ReaderEvidenceUnavailableReason = Literal["Missing", "Unanchorable", "Stale"]
ReaderDocumentMapMarkerKind = Literal[
    "Embed",
    "Highlight",
    "SourceReference",
    "GeneratedCitation",
    "Link",
    "MachineLink",
]
ReaderDocumentMapMarkerTone = Literal[
    "Neutral", "Highlight", "Citation", "Link", "MachineLink", "Warning"
]


class _ReaderMapOut(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)


class ReaderPdfPageLocatorOut(_ReaderMapOut):
    type: Literal["pdf_page"] = "pdf_page"
    media_id: UUID
    page_number: int = Field(ge=1)


class ReaderEvidenceAnchorOut(_ReaderMapOut):
    locator: MediaRetrievalLocator | ReaderPdfPageLocatorOut
    passage_anchor_id: UUID | None = None


class ReaderEvidenceResolvedOut(_ReaderMapOut):
    kind: Literal["Resolved"] = "Resolved"
    anchor: ReaderEvidenceAnchorOut
    order_key: str


class ReaderEvidenceUnavailableOut(_ReaderMapOut):
    kind: Literal["Unavailable"] = "Unavailable"
    reason: ReaderEvidenceUnavailableReason
    sort_order_key: str | None = Field(default=None, exclude=True)


ReaderEvidenceResolutionOut = Annotated[
    ReaderEvidenceResolvedOut | ReaderEvidenceUnavailableOut,
    Field(discriminator="kind"),
]


class ReaderEvidenceHighlightOut(_ReaderMapOut):
    kind: Literal["Highlight"] = "Highlight"
    item: ResourceItemOut
    highlight_id: UUID
    # Full current fields and version are command inputs; item owns bounded display.
    version: str
    quote: str
    prefix: str
    suffix: str
    color: HighlightColor
    created_at: datetime
    updated_at: datetime
    author_user_id: UUID
    is_owner: bool


class ReaderSourceHtmlOut(_ReaderMapOut):
    kind: Literal["Html"] = "Html"
    html_sanitized: str
    text: str


class ReaderSourceTextOut(_ReaderMapOut):
    kind: Literal["Text"] = "Text"
    text: str


class ReaderSourceUnavailableOut(_ReaderMapOut):
    kind: Literal["Unavailable"] = "Unavailable"


SourceContent = Annotated[
    ReaderSourceHtmlOut | ReaderSourceTextOut | ReaderSourceUnavailableOut,
    Field(discriminator="kind"),
]


class ReaderEvidenceSourceTargetOut(_ReaderMapOut):
    item: ResourceItemOut
    stable_key: str
    apparatus_kind: ReaderApparatusItemKind
    content: SourceContent
    resolution: ReaderEvidenceResolutionOut


class ReaderApparatusDetailOut(_ReaderMapOut):
    """Complete ordered targets for one owner in the named reader publication."""

    media_id: UUID
    identity: str
    reference_ref: str
    targets: list[ReaderEvidenceSourceTargetOut]

    @model_validator(mode="after")
    def validate_target_refs(self) -> ReaderApparatusDetailOut:
        if len({target.item.ref for target in self.targets}) != len(self.targets):
            raise ValueError("apparatus detail targets must have unique refs")
        return self


class ReaderEvidenceSourceReferenceOut(_ReaderMapOut):
    """A visible owner preview; its publication attribution is shared by Evidence."""

    kind: Literal["SourceReference"] = "SourceReference"
    resource_ref: str
    action_ref: str
    label: str
    excerpt: ExcerptOut
    activation: ResourceActivationOut
    location_label: str | None
    stable_key: str
    apparatus_kind: ReaderApparatusItemKind
    confidence: ReaderApparatusConfidence
    marker_anchor_id: str | None


class ReaderEvidenceResourceOut(_ReaderMapOut):
    kind: Literal["Resource"] = "Resource"
    item: ResourceItemOut


ReaderEvidenceContentOut = Annotated[
    ReaderEvidenceHighlightOut | ReaderEvidenceSourceReferenceOut | ReaderEvidenceResourceOut,
    Field(discriminator="kind"),
]


class ReaderDirectFactOut(_ReaderMapOut):
    """Membership and facet metadata, never relationship command authority."""

    edge_id: UUID
    origin: EdgeOrigin
    ordinal: int | None


class ReaderEvidenceRootOut(_ReaderMapOut):
    """One exact resource; native content owns its placement when present."""

    ref: str
    content: ReaderEvidenceContentOut
    resolution: ReaderEvidenceResolutionOut | None
    direct_facts: list[ReaderDirectFactOut] = Field(default_factory=list)


class ReaderEvidenceCountsOut(_ReaderMapOut):
    highlights: int = Field(ge=0)
    citations: int = Field(ge=0)
    links: int = Field(ge=0)
    machine_links: int = Field(ge=0)


class ReaderEvidenceOut(_ReaderMapOut):
    apparatus_source: SourceAttributionOut | None
    roots: list[ReaderEvidenceRootOut] = Field(default_factory=list)
    counts: ReaderEvidenceCountsOut


class ReaderDocumentMapMarkerOut(_ReaderMapOut):
    id: str
    kind: ReaderDocumentMapMarkerKind
    item_id: str
    position: float = Field(ge=0.0, le=1.0)
    end_position: Annotated[float, Field(ge=0.0, le=1.0)] | None
    tone: ReaderDocumentMapMarkerTone
    label: str
    preview: str | None

    @model_validator(mode="after")
    def validate_end_position(self) -> ReaderDocumentMapMarkerOut:
        if self.end_position is not None and self.end_position < self.position:
            raise ValueError("end_position must not precede position")
        return self


class ReaderDocumentMapDiagnosticsOut(_ReaderMapOut):
    omitted_item_counts: dict[str, Annotated[int, Field(ge=0)]] = Field(default_factory=dict)


class ReaderDocumentMapOut(_ReaderMapOut):
    """Annotations over one publication: ``identity`` is the reader document's identity."""

    media_id: UUID
    identity: str
    status: ReaderDocumentMapStatus
    embeds: list[DocumentEmbedOut] = Field(default_factory=list)
    evidence: ReaderEvidenceOut
    markers: list[ReaderDocumentMapMarkerOut] = Field(default_factory=list)
    diagnostics: ReaderDocumentMapDiagnosticsOut = Field(
        default_factory=ReaderDocumentMapDiagnosticsOut
    )
