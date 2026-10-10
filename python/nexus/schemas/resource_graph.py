"""The resource graph's vocabulary and wire: edge kinds and origins, the stored edge
snapshot, connection reads and the link commands. Refs travel as ``<scheme>:<uuid>``."""

from datetime import datetime
from typing import Annotated, Any, Literal, get_args
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from nexus.schemas.highlights import HIGHLIGHT_COLORS, LinkedNoteBlockRef, PdfQuadIn
from nexus.schemas.machine_authorship import MachineAuthorshipOut
from nexus.schemas.resource_items import (
    ExpectedNoteBody,
    ResourceActivationOut,
    validate_note_body_pm_json,
)
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
    """The stored edge ``snapshot``: display text captured when the fact was written.
    Written with ``model_dump(exclude_none=True)``, read with ``model_validate``."""

    model_config = ConfigDict(
        extra="ignore", frozen=True, json_schema_serialization_defaults_required=True
    )

    title: str | None = None
    excerpt: str | None = None
    section_label: str | None = None
    result_type: str | None = None
    deep_link: str | None = None


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


class ConnectionEndpointOut(Model):
    ref: str
    label: str
    description: str | None
    activation: ResourceActivationOut
    missing: bool


class ConnectionLinkNoteOut(Model):
    note_block_id: UUID
    preview: str | None


class ChatCreationRecord(Model):
    conversation_id: UUID
    message_id: UUID
    tool_call_id: UUID
    kind: Literal["chat"] = "chat"


class GenerationCreationRecord(Model):
    generation_id: UUID
    position_id: UUID
    kind: Literal["generation"] = "generation"


class ConnectionCreationOut(Model):
    authorship: MachineAuthorshipOut
    record: Annotated[ChatCreationRecord | GenerationCreationRecord, Field(discriminator="kind")]


class UnlinkMutation(Model):
    kind: Literal["unlink"] = "unlink"


class DismissDiscoveryMutation(Model):
    kind: Literal["dismiss_discovery"] = "dismiss_discovery"


class DetachContextMutation(Model):
    conversation_id: UUID
    kind: Literal["detach_context"] = "detach_context"


class UndoAssistantChatMutation(Model):
    conversation_id: UUID
    tool_call_id: UUID
    kind: Literal["undo_assistant_chat"] = "undo_assistant_chat"


class UndoAssistantGenerationMutation(Model):
    position_id: UUID
    kind: Literal["undo_assistant_generation"] = "undo_assistant_generation"


ConnectionMutation = Annotated[
    UnlinkMutation
    | DismissDiscoveryMutation
    | DetachContextMutation
    | UndoAssistantChatMutation
    | UndoAssistantGenerationMutation,
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
    source: ConnectionEndpointOut
    target: ConnectionEndpointOut
    other: ConnectionEndpointOut
    link_note: ConnectionLinkNoteOut | None
    creation: ConnectionCreationOut | None
    mutation: ConnectionMutation | None
    created_at: datetime


class ConnectionPageOut(Model):
    items: list[ConnectionOut]
    next_cursor: str | None


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


class LinkPdfSelectionSource(Model):
    """A PDF page-space selection, materialized as a highlight with the link."""

    kind: Literal["pdf_selection"] = "pdf_selection"
    highlight_id: UUID
    media_id: UUID
    page_number: int = Field(..., ge=1)
    quads: list[PdfQuadIn] = Field(..., min_length=1, max_length=512)
    exact: str = ""
    color: HIGHLIGHT_COLORS


class LinkPassageEndpoint(Model):
    """A transient passage candidate, materialized into a ``passage_anchor`` on confirm."""

    kind: Literal["passage"] = "passage"
    candidate_ref: str


LinkEndpoint = Annotated[LinkResourceEndpoint | LinkPassageEndpoint, Field(discriminator="kind")]


class CreateLinkRequest(Model):
    client_mutation_id: str = Field(..., min_length=1, max_length=120)
    source: Annotated[
        LinkResourceEndpoint
        | LinkPassageEndpoint
        | LinkFragmentSelectionSource
        | LinkPdfSelectionSource,
        Field(discriminator="kind"),
    ]
    target: LinkEndpoint


class CreateLinkOut(Model):
    created: bool
    created_source_ref: str | None
    connection: ConnectionOut


class PutLinkNoteRequest(Model):
    client_mutation_id: str = Field(..., min_length=1, max_length=120)
    note_block_id: UUID
    expected_body: ExpectedNoteBody
    body_pm_json: dict[str, Any]

    @field_validator("body_pm_json")
    @classmethod
    def _body(cls, value: dict[str, Any]) -> dict[str, Any]:
        validated = validate_note_body_pm_json(value)
        if validated is None:
            raise ValueError("body_pm_json is required")
        return validated


class LinkNoteOut(LinkedNoteBlockRef):
    model_config = ConfigDict(extra="forbid")

    connection: ConnectionOut
