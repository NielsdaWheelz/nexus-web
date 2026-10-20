"""The resource graph's vocabulary and wire: edge kinds and origins, the stored edge
snapshot, connection reads and the link commands. Refs travel as ``<scheme>:<uuid>``."""

from datetime import date, datetime
from typing import Annotated, Literal, get_args
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.assistant_writes import MachineAuthorshipOut
from nexus.schemas.highlights import HIGHLIGHT_COLORS, LinkedNoteBlockRef, PdfQuadIn
from nexus.schemas.resource_evidence import CapturedEvidence
from nexus.schemas.resource_items import ResourceItemOut
from nexus.services.resource_graph.refs import ResourceScheme

EdgeKind = Literal["context", "supports", "contradicts"]
EdgeOrigin = Literal[
    "user",
    "citation",
    "system",
    "note_body",
    "highlight_note",
    "discovery",
    "document_embed",
    "assistant",
    "link_note",
]
EDGE_KINDS: tuple[EdgeKind, ...] = get_args(EdgeKind)
ConnectionDirection = Literal["incoming", "outgoing", "both"]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CitationSnapshot(BaseModel):
    """Exactly one captured citation evidence or machine relationship rationale."""

    model_config = ConfigDict(
        extra="forbid", frozen=True, json_schema_serialization_defaults_required=True
    )
    evidence: CapturedEvidence | None = None
    rationale: str | None = None


class ConnectionFiltersRequest(Model):
    origins: list[EdgeOrigin] | None = None
    kinds: list[EdgeKind] | None = None
    source_schemes: list[ResourceScheme] | None = None
    target_schemes: list[ResourceScheme] | None = None


class ConnectionQueryRequest(Model):
    refs: list[str] = Field(min_length=1, max_length=200)
    direction: ConnectionDirection
    rollup: Literal["exact", "owner"] = "exact"
    filters: ConnectionFiltersRequest = Field(default_factory=ConnectionFiltersRequest)
    limit: int = Field(default=100, ge=1, le=100)
    cursor: str | None = None


class ConnectionLinkNoteOut(Model):
    note_block_id: UUID
    item: ResourceItemOut


class ConnectionCreationOut(Model):
    """Who created an assistant link: its tool call, and the answer while the chat exists."""

    authorship: MachineAuthorshipOut
    tool_call_id: UUID
    generation_id: UUID
    conversation_id: UUID | None
    message_id: UUID | None


class UnlinkMutation(Model):
    kind: Literal["unlink"] = "unlink"


class DismissDiscoveryMutation(Model):
    kind: Literal["dismiss_discovery"] = "dismiss_discovery"


class DetachContextMutation(Model):
    conversation_id: UUID
    target_ref: str
    expected_context_version: int
    kind: Literal["detach_context"] = "detach_context"


class UndoAssistantWriteMutation(Model):
    tool_call_id: UUID
    kind: Literal["undo_assistant_write"] = "undo_assistant_write"


ConnectionMutation = Annotated[
    UnlinkMutation | DismissDiscoveryMutation | DetachContextMutation | UndoAssistantWriteMutation,
    Field(discriminator="kind"),
]


class ConnectionOut(Model):
    """One fact seen from a queried ref: ``other`` is the far endpoint, a user link is
    ``undirected``, and ``mutation`` names the one command that may remove it."""

    edge_id: UUID
    direction: Literal["incoming", "outgoing", "undirected"]
    kind: EdgeKind
    origin: EdgeOrigin
    snapshot: CitationSnapshot | None
    source_order_key: str | None
    ordinal: int | None
    source: ResourceItemOut
    target: ResourceItemOut
    other: ResourceItemOut
    link_note: ConnectionLinkNoteOut | None
    creation: ConnectionCreationOut | None
    mutation: ConnectionMutation | None
    created_at: datetime


class ConnectionPageOut(Model):
    items: list[ConnectionOut]
    next_cursor: str | None


class ContextItemOut(Model):
    item: ResourceItemOut
    admission_edge_ids: list[UUID]
    mutation: DetachContextMutation


class ContextOut(Model):
    context_version: int
    items: list[ContextItemOut]


class LinkResourceEndpoint(Model):
    kind: Literal["resource"] = "resource"
    ref: str


class LinkFragmentSelectionSource(Model):
    """A reflowable selection, materialized as a highlight with the link."""

    kind: Literal["fragment_selection"] = "fragment_selection"
    highlight_id: UUID
    fragment_id: UUID
    start_offset: int = Field(..., ge=0)
    end_offset: int = Field(..., gt=0)
    color: HIGHLIGHT_COLORS
    expected_reader_generation: int | None = Field(default=None, ge=1)


class LinkPdfSelectionSource(Model):
    """A PDF page-space selection, materialized as a highlight with the link."""

    kind: Literal["pdf_selection"] = "pdf_selection"
    highlight_id: UUID
    media_id: UUID
    page_number: int = Field(..., ge=1)
    quads: list[PdfQuadIn] = Field(..., min_length=1, max_length=512)
    exact: str = ""
    color: HIGHLIGHT_COLORS
    expected_reader_generation: int | None = Field(..., ge=1)


class LinkPassageEndpoint(Model):
    """A transient passage candidate, materialized into a ``passage_anchor`` on confirm."""

    kind: Literal["passage"] = "passage"
    candidate_ref: str


LinkEndpoint = Annotated[LinkResourceEndpoint | LinkPassageEndpoint, Field(discriminator="kind")]


class LinkDailyPageSource(Model):
    kind: Literal["daily_page"] = "daily_page"
    local_date: date
    page_id: UUID


InsertionSource = Annotated[
    LinkResourceEndpoint
    | LinkPassageEndpoint
    | LinkFragmentSelectionSource
    | LinkPdfSelectionSource
    | LinkDailyPageSource,
    Field(discriminator="kind"),
]


class LinkNoteOut(LinkedNoteBlockRef):
    model_config = ConfigDict(extra="forbid")

    connection: ConnectionOut
