"""Canonical Reader Document Map aggregate schemas.

Evidence is projected as typed facts grouped by exact reader locus.  Domain
owner payloads never leak through this boundary.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.highlights import HIGHLIGHT_COLORS
from nexus.schemas.media import DocumentEmbedOut, MediaNavigationOut
from nexus.schemas.presence import Presence
from nexus.schemas.reader_apparatus import (
    ReaderApparatusConfidence,
    ReaderApparatusItemKind,
)
from nexus.schemas.resource_graph import EdgeKind, EdgeOrigin
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


class ReaderEvidenceAnchorOut(BaseModel):
    locator: MediaRetrievalLocator

    model_config = ConfigDict(extra="forbid")


class ReaderEvidenceResolvedOut(BaseModel):
    kind: Literal["Resolved"] = "Resolved"
    anchor: ReaderEvidenceAnchorOut
    order_key: str

    model_config = ConfigDict(extra="forbid")


class ReaderEvidenceUnavailableOut(BaseModel):
    kind: Literal["Unavailable"] = "Unavailable"
    reason: ReaderEvidenceUnavailableReason
    sort_order_key: str | None = Field(default=None, exclude=True)

    model_config = ConfigDict(extra="forbid")


ReaderEvidenceResolutionOut = Annotated[
    ReaderEvidenceResolvedOut | ReaderEvidenceUnavailableOut,
    Field(discriminator="kind"),
]


class ReaderEvidenceObjectBaseOut(BaseModel):
    ref: str
    label: str
    excerpt: Presence[str]
    activation: ResourceActivationOut

    model_config = ConfigDict(extra="forbid")


class ReaderEvidenceChatObjectOut(ReaderEvidenceObjectBaseOut):
    kind: Literal["Chat"] = "Chat"
    conversation_id: UUID
    message_ref: Presence[str]


class ReaderEvidenceNoteObjectOut(ReaderEvidenceObjectBaseOut):
    kind: Literal["Note"] = "Note"
    note_block_id: UUID
    body_pm_json: dict[str, object]


class ReaderEvidenceDossierObjectOut(ReaderEvidenceObjectBaseOut):
    kind: Literal["Dossier"] = "Dossier"


class ReaderEvidenceOracleObjectOut(ReaderEvidenceObjectBaseOut):
    kind: Literal["Oracle"] = "Oracle"


class ReaderEvidenceMediaObjectOut(ReaderEvidenceObjectBaseOut):
    kind: Literal["Media"] = "Media"


class ReaderEvidenceOtherObjectOut(ReaderEvidenceObjectBaseOut):
    kind: Literal["Other"] = "Other"


ReaderEvidenceObjectOut = Annotated[
    ReaderEvidenceChatObjectOut
    | ReaderEvidenceNoteObjectOut
    | ReaderEvidenceDossierObjectOut
    | ReaderEvidenceOracleObjectOut
    | ReaderEvidenceMediaObjectOut
    | ReaderEvidenceOtherObjectOut,
    Field(discriminator="kind"),
]


class ReaderEvidenceAuthoredInOut(BaseModel):
    relationship: Literal["AuthoredIn"] = "AuthoredIn"
    object: ReaderEvidenceObjectOut

    model_config = ConfigDict(extra="forbid")


class ReaderEvidenceDirectlyAttachedOut(BaseModel):
    relationship: Literal["DirectlyAttached"] = "DirectlyAttached"
    object: ReaderEvidenceObjectOut
    edge_id: UUID
    role: EdgeKind
    origin: EdgeOrigin
    direction: Literal["Outgoing", "Incoming"]

    model_config = ConfigDict(extra="forbid")


ReaderEvidenceAssociationOut = Annotated[
    ReaderEvidenceAuthoredInOut | ReaderEvidenceDirectlyAttachedOut,
    Field(discriminator="relationship"),
]


class ReaderEvidenceAlsoReferenceOut(BaseModel):
    relationship: Literal["AlsoReferences"] = "AlsoReferences"
    object: ReaderEvidenceObjectOut

    model_config = ConfigDict(extra="forbid")


class ReaderEvidenceItemBaseOut(BaseModel):
    id: str
    label: str
    excerpt: Presence[str]
    associations: list[ReaderEvidenceAssociationOut] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


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


class ReaderEvidenceSourceTargetOut(BaseModel):
    ref: str
    stable_key: str
    apparatus_kind: ReaderApparatusItemKind
    label: Presence[str]
    body: Presence[str]
    activation: ResourceActivationOut
    resolution: ReaderEvidenceResolutionOut

    model_config = ConfigDict(extra="forbid")


class ReaderEvidenceSourceReferenceOut(ReaderEvidenceItemBaseOut):
    kind: Literal["SourceReference"] = "SourceReference"
    stable_key: str
    apparatus_kind: ReaderApparatusItemKind
    confidence: ReaderApparatusConfidence
    targets: list[ReaderEvidenceSourceTargetOut] = Field(default_factory=list)


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


class ReaderEvidencePassageGroupOut(BaseModel):
    locus_ref: str
    resolution: ReaderEvidenceResolutionOut
    target_excerpt: Presence[str]
    items: list[ReaderEvidenceItemOut]
    also_references: list[ReaderEvidenceAlsoReferenceOut] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class ReaderEvidenceCountsOut(BaseModel):
    highlights: int = Field(ge=0)
    citations: int = Field(ge=0)
    links: int = Field(ge=0)
    synapses: int = Field(ge=0)
    passages: int = Field(ge=0)
    document: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


class ReaderEvidenceOut(BaseModel):
    counts: ReaderEvidenceCountsOut
    passage_groups: list[ReaderEvidencePassageGroupOut] = Field(default_factory=list)
    document_items: list[ReaderEvidenceItemOut] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class ReaderDocumentMapMarkerOut(BaseModel):
    id: str
    kind: ReaderDocumentMapMarkerKind
    item_id: str
    position: float = Field(ge=0.0, le=1.0)
    tone: ReaderDocumentMapMarkerTone
    label: str
    preview: Presence[str]

    model_config = ConfigDict(extra="forbid")


class ReaderDocumentMapSourceVersionOut(BaseModel):
    media_updated_at: Presence[datetime]
    apparatus_source_fingerprint: Presence[str]
    graph_max_updated_at: Presence[datetime]
    highlights_max_updated_at: Presence[datetime]

    model_config = ConfigDict(extra="forbid")


class ReaderDocumentMapDiagnosticsOut(BaseModel):
    omitted_item_counts: dict[str, int] = Field(default_factory=dict)

    model_config = ConfigDict(extra="forbid")


class ReaderDocumentMapOut(BaseModel):
    media_id: UUID
    media_kind: str
    title: str
    status: ReaderDocumentMapStatus
    source_version: ReaderDocumentMapSourceVersionOut
    navigation: Presence[MediaNavigationOut]
    embeds: list[DocumentEmbedOut] = Field(default_factory=list)
    evidence: ReaderEvidenceOut
    markers: list[ReaderDocumentMapMarkerOut] = Field(default_factory=list)
    diagnostics: ReaderDocumentMapDiagnosticsOut = Field(
        default_factory=ReaderDocumentMapDiagnosticsOut
    )

    model_config = ConfigDict(extra="forbid")
