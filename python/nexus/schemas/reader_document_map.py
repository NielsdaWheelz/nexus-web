"""Reader Document Map aggregate response schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from nexus.schemas.conversation import ConversationOut
from nexus.schemas.highlights import HIGHLIGHT_COLORS, TypedHighlightOut
from nexus.schemas.media import MediaNavigationOut
from nexus.schemas.reader import ReaderConnectionAnchorOut, ReaderConnectionPageOut
from nexus.schemas.reader_apparatus import (
    ReaderApparatusConfidence,
    ReaderApparatusItemKind,
    ReaderApparatusLocatorStatus,
    ReaderApparatusResponse,
)
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.schemas.resource_graph import EdgeKind, EdgeOrigin
from nexus.services.resource_graph.schemas import ConnectionDirection

ReaderDocumentMapLensId = Literal["contents", "highlights", "citations", "connections", "chat"]
ReaderDocumentMapStatus = Literal["ready", "empty", "partial", "unsupported", "failed"]
ReaderDocumentMapTargetStatus = Literal[
    "exact",
    "container",
    "missing",
    "forbidden",
    "unanchorable",
    "stale",
    "unsupported",
    "partial",
]
ReaderDocumentMapAnchorPrecision = Literal["exact", "container"]
ReaderDocumentMapMarkerTone = Literal[
    "neutral",
    "highlight",
    "citation",
    "connection",
    "chat",
    "warning",
]


class ReaderDocumentMapLensOut(BaseModel):
    id: ReaderDocumentMapLensId
    label: str
    status: ReaderDocumentMapStatus
    item_count: int = Field(ge=0)
    anchored_count: int = Field(ge=0)
    unanchored_count: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


class ReaderDocumentMapAnchorOut(ReaderConnectionAnchorOut):
    precision: ReaderDocumentMapAnchorPrecision


class ReaderDocumentMapItemBaseOut(BaseModel):
    id: str
    lens_ids: list[ReaderDocumentMapLensId]
    title: str
    subtitle: str | None = None
    excerpt: str | None = None
    activation: ResourceActivationOut | None = None
    href: str | None = None
    anchor: ReaderDocumentMapAnchorOut | None = None
    document_order_key: str | None = None
    document_fraction: float | None = Field(default=None, ge=0.0, le=1.0)
    target_status: ReaderDocumentMapTargetStatus
    provenance: dict[str, JsonValue] = Field(default_factory=dict)
    actions: list[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class ReaderDocumentMapSectionItemOut(ReaderDocumentMapItemBaseOut):
    kind: Literal["section"]
    source_domain: Literal["navigation"]
    section_id: str | None = None
    level: int | None = None
    parent_id: str | None = None


class ReaderDocumentMapHighlightItemOut(ReaderDocumentMapItemBaseOut):
    kind: Literal["highlight"]
    source_domain: Literal["highlight"]
    highlight_id: UUID
    color: HIGHLIGHT_COLORS
    exact: str
    note_block_count: int = Field(ge=0)
    linked_conversation_count: int = Field(ge=0)


class ReaderDocumentMapApparatusItemOut(ReaderDocumentMapItemBaseOut):
    kind: Literal["apparatus"]
    source_domain: Literal["reader_apparatus"]
    resource_ref: str
    stable_key: str
    apparatus_kind: ReaderApparatusItemKind
    confidence: ReaderApparatusConfidence
    locator_status: ReaderApparatusLocatorStatus
    target_stable_keys: list[str] = Field(default_factory=list)


class ReaderDocumentMapConnectionItemOut(ReaderDocumentMapItemBaseOut):
    kind: Literal["connection"]
    source_domain: Literal["resource_graph", "generated_citation"]
    edge_id: UUID
    direction: ConnectionDirection
    origin: EdgeOrigin
    edge_kind: EdgeKind
    source_category: str
    other_ref: str


class ReaderDocumentMapChatThreadItemOut(ReaderDocumentMapItemBaseOut):
    kind: Literal["chat_thread"]
    source_domain: Literal["chat"]
    conversation_id: UUID
    latest_message_at: datetime | None = None
    attached_ref: str | None = None


ReaderDocumentMapItemOut = Annotated[
    ReaderDocumentMapSectionItemOut
    | ReaderDocumentMapHighlightItemOut
    | ReaderDocumentMapApparatusItemOut
    | ReaderDocumentMapConnectionItemOut
    | ReaderDocumentMapChatThreadItemOut,
    Field(discriminator="kind"),
]


class ReaderDocumentMapMarkerOut(BaseModel):
    id: str
    item_id: str
    lens_id: ReaderDocumentMapLensId
    lane: ReaderDocumentMapLensId
    position: float = Field(ge=0.0, le=1.0)
    status: ReaderDocumentMapTargetStatus
    tone: ReaderDocumentMapMarkerTone
    label: str
    preview: str | None = None

    model_config = ConfigDict(extra="forbid")


class ReaderDocumentMapSourceVersionOut(BaseModel):
    media_updated_at: datetime | None = None
    content_fingerprint: str | None = None
    apparatus_source_fingerprint: str | None = None
    graph_max_updated_at: datetime | None = None
    highlights_max_updated_at: datetime | None = None

    model_config = ConfigDict(extra="forbid")


class ReaderDocumentMapDiagnosticsOut(BaseModel):
    omitted_item_counts: dict[str, int] = Field(default_factory=dict)
    partial_lenses: list[str] = Field(default_factory=list)
    owner_warnings: list[dict[str, JsonValue]] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class ReaderDocumentMapOut(BaseModel):
    media_id: UUID
    media_kind: str
    title: str
    status: ReaderDocumentMapStatus
    source_version: ReaderDocumentMapSourceVersionOut
    lenses: list[ReaderDocumentMapLensOut]
    items: list[ReaderDocumentMapItemOut]
    markers: list[ReaderDocumentMapMarkerOut]
    navigation: MediaNavigationOut | None = None
    highlights: list[TypedHighlightOut] = Field(default_factory=list)
    apparatus: ReaderApparatusResponse
    connections: ReaderConnectionPageOut
    chat_threads: list[ConversationOut] = Field(default_factory=list)
    diagnostics: ReaderDocumentMapDiagnosticsOut = Field(
        default_factory=ReaderDocumentMapDiagnosticsOut
    )

    model_config = ConfigDict(extra="forbid")
