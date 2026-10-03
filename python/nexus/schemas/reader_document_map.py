"""Reader map output: scoped facts, exact loci and native presentation data."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.highlights import HIGHLIGHT_COLORS
from nexus.schemas.media import DocumentEmbedOut, MediaNavigationOut
from nexus.schemas.presence import Presence
from nexus.schemas.reader_apparatus import (
    ReaderApparatusConfidence,
    ReaderApparatusItemKind,
)
from nexus.schemas.resource_graph import ConnectionLinkNoteOut, EdgeKind, EdgeOrigin
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.schemas.retrieval import MediaRetrievalLocator

ReaderDocumentMapStatus = Literal["ready", "empty", "partial"]
ReaderEvidenceUnavailableReason = Literal["Missing", "Unanchorable", "Stale"]
ReaderDocumentMapMarkerKind = Literal[
    "Contents",
    "Embed",
    "Highlight",
    "SourceReference",
    "GeneratedCitation",
    "Link",
    "Synapse",
]
ReaderDocumentMapMarkerTone = Literal[
    "Neutral", "Highlight", "Citation", "Link", "Synapse", "Warning"
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


class ReaderEvidenceObjectBaseOut(_ReaderMapOut):
    ref: str
    label: str
    excerpt: Presence[str]
    activation: ResourceActivationOut

    @model_validator(mode="after")
    def validate_activation_identity(self) -> ReaderEvidenceObjectBaseOut:
        if self.activation.resource_ref != self.ref:
            raise ValueError("activation.resource_ref must match ref")
        return self


class ReaderEvidenceChatObjectOut(ReaderEvidenceObjectBaseOut):
    kind: Literal["Chat"] = "Chat"
    conversation_id: UUID
    message_ref: Presence[str]


class ReaderEvidenceNoteObjectOut(ReaderEvidenceObjectBaseOut):
    kind: Literal["Note"] = "Note"
    note_block_id: UUID
    body_pm_json: dict[str, object]


class ReaderEvidencePlainObjectOut(ReaderEvidenceObjectBaseOut):
    """An object carrying no payload beyond the common four keys."""

    kind: Literal["Dossier", "Oracle", "Media", "Other"]


ReaderEvidenceObjectOut = Annotated[
    ReaderEvidenceChatObjectOut | ReaderEvidenceNoteObjectOut | ReaderEvidencePlainObjectOut,
    Field(discriminator="kind"),
]


class ReaderEvidenceAuthoredInOut(_ReaderMapOut):
    relationship: Literal["AuthoredIn"] = "AuthoredIn"
    object: ReaderEvidenceObjectOut


class ReaderEvidenceDirectlyAttachedOut(_ReaderMapOut):
    relationship: Literal["DirectlyAttached"] = "DirectlyAttached"
    object: ReaderEvidenceObjectOut
    edge_id: UUID
    role: EdgeKind
    origin: EdgeOrigin
    direction: Literal["Outgoing", "Incoming"]


ReaderEvidenceAssociationOut = Annotated[
    ReaderEvidenceAuthoredInOut | ReaderEvidenceDirectlyAttachedOut,
    Field(discriminator="relationship"),
]


class ReaderEvidenceAlsoReferenceOut(_ReaderMapOut):
    relationship: Literal["AlsoReferences"] = "AlsoReferences"
    object: ReaderEvidenceObjectOut


class ReaderEvidenceItemBaseOut(_ReaderMapOut):
    id: str
    label: str
    excerpt: Presence[str]
    associations: list[ReaderEvidenceAssociationOut] = Field(default_factory=list)


class ReaderEvidenceHighlightOut(ReaderEvidenceItemBaseOut):
    kind: Literal["Highlight"] = "Highlight"
    highlight_id: UUID
    quote: str
    prefix: str
    suffix: str
    color: HIGHLIGHT_COLORS
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
    ref: str
    stable_key: str
    apparatus_kind: ReaderApparatusItemKind
    label: Presence[str]
    content: SourceContent
    activation: ResourceActivationOut
    resolution: ReaderEvidenceResolutionOut

    @model_validator(mode="after")
    def validate_activation_identity(self) -> ReaderEvidenceSourceTargetOut:
        if self.activation.resource_ref != self.ref:
            raise ValueError("activation.resource_ref must match ref")
        return self


class ReaderEvidenceSourceReferenceOut(ReaderEvidenceItemBaseOut):
    kind: Literal["SourceReference"] = "SourceReference"
    stable_key: str
    apparatus_kind: ReaderApparatusItemKind
    confidence: ReaderApparatusConfidence
    target_refs: list[str]
    marker_anchor_id: Presence[str]


class ReaderEvidenceGeneratedCitationOut(ReaderEvidenceItemBaseOut):
    kind: Literal["GeneratedCitation"] = "GeneratedCitation"
    edge_id: UUID
    role: EdgeKind


class ReaderEvidenceLinkOut(ReaderEvidenceItemBaseOut):
    kind: Literal["Link"] = "Link"
    edge_id: UUID
    role: EdgeKind
    origin: EdgeOrigin
    object: ReaderEvidenceObjectOut
    link_note: ConnectionLinkNoteOut | None


class ReaderEvidenceSynapseOut(ReaderEvidenceItemBaseOut):
    kind: Literal["Synapse"] = "Synapse"
    edge_id: UUID
    role: EdgeKind
    rationale: str
    object: ReaderEvidenceObjectOut


ReaderEvidenceItemOut = Annotated[
    ReaderEvidenceHighlightOut
    | ReaderEvidenceSourceReferenceOut
    | ReaderEvidenceGeneratedCitationOut
    | ReaderEvidenceLinkOut
    | ReaderEvidenceSynapseOut,
    Field(discriminator="kind"),
]


class ReaderEvidencePassageGroupOut(_ReaderMapOut):
    locus_ref: str
    resolution: ReaderEvidenceResolutionOut
    target_excerpt: Presence[str]
    items: list[ReaderEvidenceItemOut]
    also_references: list[ReaderEvidenceAlsoReferenceOut] = Field(default_factory=list)


class ReaderEvidenceCountsOut(_ReaderMapOut):
    highlights: int = Field(ge=0)
    citations: int = Field(ge=0)
    links: int = Field(ge=0)
    synapses: int = Field(ge=0)
    passages: int = Field(ge=0)
    document: int = Field(ge=0)


class ReaderEvidenceOut(_ReaderMapOut):
    counts: ReaderEvidenceCountsOut
    source_targets: list[ReaderEvidenceSourceTargetOut]
    passage_groups: list[ReaderEvidencePassageGroupOut] = Field(default_factory=list)
    document_items: list[ReaderEvidenceItemOut] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_source_targets(self) -> ReaderEvidenceOut:
        refs = {target.ref for target in self.source_targets}
        if len(refs) != len(self.source_targets):
            raise ValueError("source_targets must have unique refs")
        items = [item for group in self.passage_groups for item in group.items]
        for item in [*items, *self.document_items]:
            if isinstance(item, ReaderEvidenceSourceReferenceOut) and not refs.issuperset(
                item.target_refs
            ):
                raise ValueError("source reference target_refs must belong to source_targets")
        return self


class ReaderDocumentMapMarkerOut(_ReaderMapOut):
    id: str
    kind: ReaderDocumentMapMarkerKind
    item_id: str
    position: float = Field(ge=0.0, le=1.0)
    end_position: Presence[Annotated[float, Field(ge=0.0, le=1.0)]]
    tone: ReaderDocumentMapMarkerTone
    label: str
    preview: Presence[str]

    @model_validator(mode="after")
    def validate_end_position(self) -> ReaderDocumentMapMarkerOut:
        if self.end_position.kind == "Present" and self.end_position.value < self.position:
            raise ValueError("end_position must not precede position")
        return self


class ReaderDocumentMapDiagnosticsOut(_ReaderMapOut):
    omitted_item_counts: dict[str, Annotated[int, Field(ge=0)]] = Field(default_factory=dict)


class ReaderDocumentMapOut(_ReaderMapOut):
    media_id: UUID
    generation: Presence[Annotated[int, Field(ge=1, strict=True)]]
    media_kind: str
    title: str
    status: ReaderDocumentMapStatus
    navigation: Presence[MediaNavigationOut]
    embeds: list[DocumentEmbedOut] = Field(default_factory=list)
    evidence: ReaderEvidenceOut
    markers: list[ReaderDocumentMapMarkerOut] = Field(default_factory=list)
    diagnostics: ReaderDocumentMapDiagnosticsOut = Field(
        default_factory=ReaderDocumentMapDiagnosticsOut
    )
