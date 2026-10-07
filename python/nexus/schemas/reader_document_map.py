"""Canonical Reader Document Map aggregate schemas.

Evidence is projected as typed facts grouped by exact reader locus.  Domain
owner payloads never leak through this boundary.  Every field name here is
decoded key-for-key by ``apps/web/src/lib/reader/documentMapContract.ts``.
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
from nexus.schemas.resource_graph import (
    ConnectionActivationOut,
    ConnectionCreationOut,
    ConnectionLinkNoteOut,
    EdgeKind,
    EdgeOrigin,
)
from nexus.schemas.retrieval import MediaRetrievalLocator
from nexus.services.resource_graph.schemas import ConnectionMutation

ReaderDocumentMapStatus = Literal["ready", "empty", "partial"]
ReaderEvidenceUnavailableReason = Literal["Missing", "Unanchorable", "Stale"]
ReaderDocumentMapMarkerKind = Literal[
    "Contents",
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


class ReaderPdfPageLocatorOut(BaseModel):
    type: Literal["pdf_page"] = "pdf_page"
    media_id: UUID
    page_number: int = Field(ge=1)

    model_config = ConfigDict(extra="forbid")


class ReaderEvidenceAnchorOut(BaseModel):
    locator: MediaRetrievalLocator | ReaderPdfPageLocatorOut
    passage_anchor_id: UUID | None

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
    activation: ConnectionActivationOut

    model_config = ConfigDict(extra="forbid")


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


class ReaderEvidenceAuthoredInOut(BaseModel):
    relationship: Literal["AuthoredIn"] = "AuthoredIn"
    object: ReaderEvidenceObjectOut

    model_config = ConfigDict(extra="forbid")


class ReaderEvidenceDirectlyAttachedOut(BaseModel):
    relationship: Literal["DirectlyAttached"] = "DirectlyAttached"
    object: ReaderEvidenceObjectOut
    edge_id: UUID
    creation: ConnectionCreationOut | None
    mutation: Annotated[ConnectionMutation, Field(discriminator="kind")] | None
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
    associations: list[ReaderEvidenceAssociationOut]

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


class ReaderSourceHtmlOut(BaseModel):
    kind: Literal["Html"] = "Html"
    html_sanitized: str
    text: str
    model_config = ConfigDict(extra="forbid")


class ReaderSourceTextOut(BaseModel):
    kind: Literal["Text"] = "Text"
    text: str
    model_config = ConfigDict(extra="forbid")


class ReaderSourceUnavailableOut(BaseModel):
    kind: Literal["Unavailable"] = "Unavailable"
    model_config = ConfigDict(extra="forbid")


SourceContent = Annotated[
    ReaderSourceHtmlOut | ReaderSourceTextOut | ReaderSourceUnavailableOut,
    Field(discriminator="kind"),
]


class ReaderEvidenceSourceTargetOut(BaseModel):
    ref: str
    stable_key: str
    apparatus_kind: ReaderApparatusItemKind
    label: Presence[str]
    content: SourceContent
    activation: ConnectionActivationOut
    resolution: ReaderEvidenceResolutionOut

    model_config = ConfigDict(extra="forbid")


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
    creation: ConnectionCreationOut | None
    mutation: Annotated[ConnectionMutation, Field(discriminator="kind")] | None
    role: EdgeKind


class ReaderEvidenceLinkOut(ReaderEvidenceItemBaseOut):
    kind: Literal["Link"] = "Link"
    edge_id: UUID
    creation: ConnectionCreationOut | None
    mutation: Annotated[ConnectionMutation, Field(discriminator="kind")] | None
    role: EdgeKind
    origin: EdgeOrigin
    object: ReaderEvidenceObjectOut
    link_note: ConnectionLinkNoteOut | None


class ReaderEvidenceMachineLinkOut(ReaderEvidenceItemBaseOut):
    kind: Literal["MachineLink"] = "MachineLink"
    edge_id: UUID
    creation: ConnectionCreationOut | None
    mutation: Annotated[ConnectionMutation, Field(discriminator="kind")] | None
    role: EdgeKind
    rationale: str | None
    origin: Literal["discovery", "assistant"]
    object: ReaderEvidenceObjectOut


ReaderEvidenceItemOut = Annotated[
    ReaderEvidenceHighlightOut
    | ReaderEvidenceSourceReferenceOut
    | ReaderEvidenceGeneratedCitationOut
    | ReaderEvidenceLinkOut
    | ReaderEvidenceMachineLinkOut,
    Field(discriminator="kind"),
]


class ReaderEvidencePassageGroupOut(BaseModel):
    locus_ref: str
    resolution: ReaderEvidenceResolutionOut
    target_excerpt: Presence[str]
    items: list[ReaderEvidenceItemOut]
    also_references: list[ReaderEvidenceAlsoReferenceOut]

    model_config = ConfigDict(extra="forbid")


class ReaderEvidenceCountsOut(BaseModel):
    highlights: int = Field(ge=0)
    citations: int = Field(ge=0)
    links: int = Field(ge=0)
    machine_links: int = Field(ge=0)
    passages: int = Field(ge=0)
    document: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


class ReaderEvidenceOut(BaseModel):
    counts: ReaderEvidenceCountsOut
    source_targets: list[ReaderEvidenceSourceTargetOut]
    passage_groups: list[ReaderEvidencePassageGroupOut]
    document_items: list[ReaderEvidenceItemOut]

    model_config = ConfigDict(extra="forbid")


class ReaderDocumentMapMarkerOut(BaseModel):
    id: str
    kind: ReaderDocumentMapMarkerKind
    item_id: str
    position: float = Field(ge=0.0, le=1.0)
    end_position: Presence[Annotated[float, Field(ge=0.0, le=1.0)]]
    tone: ReaderDocumentMapMarkerTone
    label: str
    preview: Presence[str]

    model_config = ConfigDict(extra="forbid")


class ReaderDocumentMapDiagnosticsOut(BaseModel):
    omitted_item_counts: dict[str, int]

    model_config = ConfigDict(extra="forbid")


class ReaderDocumentMapOut(BaseModel):
    media_id: UUID
    generation: Presence[Annotated[int, Field(ge=1, strict=True)]]
    media_kind: str
    title: str
    status: ReaderDocumentMapStatus
    navigation: Presence[MediaNavigationOut]
    embeds: list[DocumentEmbedOut]
    evidence: ReaderEvidenceOut
    markers: list[ReaderDocumentMapMarkerOut]
    diagnostics: ReaderDocumentMapDiagnosticsOut

    model_config = ConfigDict(extra="forbid")
