"""Edge vocabularies and the plain records the graph modules exchange.

``resource_graph.edges`` owns the closed edge vocabulary and shape validation.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Literal, get_args
from uuid import UUID

from nexus.schemas.machine_authorship import MachineAuthorshipOut
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme

if TYPE_CHECKING:
    from nexus.db.models import ResourceEdge

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
EDGE_ORIGINS: tuple[EdgeOrigin, ...] = get_args(EdgeOrigin)
ConnectionDirection = Literal["incoming", "outgoing", "both"]

CONNECTION_DISCOVERY_SOURCE_SCHEMES: tuple[ResourceScheme, ...] = (
    "media",
    "page",
    "note_block",
    "highlight",
)
CONNECTION_DISCOVERY_TARGET_SCHEMES: tuple[ResourceScheme, ...] = (
    "media",
    "note_block",
    "evidence_span",
)
ASSISTANT_EDGE_SCHEMES: tuple[ResourceScheme, ...] = ("media", "page", "note_block", "highlight")


@dataclass(frozen=True, slots=True)
class CitationSnapshot:
    """The edge ``snapshot`` column: display fields only."""

    title: str | None = None
    excerpt: str | None = None
    section_label: str | None = None
    result_type: str | None = None
    deep_link: str | None = None


def snapshot_to_jsonb(snapshot: CitationSnapshot) -> dict[str, object]:
    return {key: value for key, value in asdict(snapshot).items() if value is not None}


def snapshot_from_jsonb(raw: dict[str, object]) -> CitationSnapshot:
    strings = {key: value for key, value in raw.items() if isinstance(value, str)}
    return CitationSnapshot(
        title=strings.get("title"),
        excerpt=strings.get("excerpt"),
        section_label=strings.get("section_label"),
        result_type=strings.get("result_type"),
        deep_link=strings.get("deep_link"),
    )


@dataclass(frozen=True, slots=True)
class EdgeCreate:
    source: ResourceRef
    target: ResourceRef
    kind: EdgeKind
    origin: EdgeOrigin
    source_order_key: str | None = None
    ordinal: int | None = None
    snapshot: CitationSnapshot | None = None


@dataclass(frozen=True, slots=True)
class EdgeOut:
    id: UUID
    source: ResourceRef
    target: ResourceRef
    kind: EdgeKind
    origin: EdgeOrigin
    source_order_key: str | None
    ordinal: int | None
    snapshot: CitationSnapshot | None
    created_at: datetime


def is_neutral_link(edge: EdgeCreate | EdgeOut | ResourceEdge) -> bool:
    """The canonical neutral user-Link shape, independent of storage orientation.

    The writer, the delete gate and the "is this undirected?" read all share it, so the
    neutral-Link shape cannot drift between them. Source-owned context facts are excluded.
    """
    return (
        edge.origin == "user"
        and edge.kind == "context"
        and edge.ordinal is None
        and edge.snapshot is None
        and edge.source_order_key is None
    )


@dataclass(frozen=True, slots=True)
class CitationInput:
    target: ResourceRef
    ordinal: int
    kind: EdgeKind
    snapshot: CitationSnapshot


@dataclass(frozen=True, slots=True)
class CitationTargetProjection:
    ordinal: int
    role: EdgeKind
    snapshot: CitationSnapshot
    media_id: UUID | None
    locator: dict[str, object] | None
    target_status: Literal["current", "missing", "forbidden", "unanchorable"]


@dataclass(frozen=True, slots=True)
class ConnectionFilters:
    origins: tuple[EdgeOrigin, ...] | None = None
    kinds: tuple[EdgeKind, ...] | None = None
    source_schemes: tuple[ResourceScheme, ...] | None = None
    target_schemes: tuple[ResourceScheme, ...] | None = None


@dataclass(frozen=True, slots=True)
class ConnectionQuery:
    refs: tuple[ResourceRef, ...]
    direction: ConnectionDirection
    rollup: Literal["exact", "owner"]
    filters: ConnectionFilters
    limit: int
    cursor: str | None = None


@dataclass(frozen=True, slots=True)
class ConnectionEndpoint:
    ref: ResourceRef
    label: str | None
    description: str | None
    activation: ResourceActivationOut
    href: str | None
    missing: bool


@dataclass(frozen=True, slots=True)
class ConnectionCitation:
    ordinal: int
    role: EdgeKind
    snapshot: CitationSnapshot
    activation: ResourceActivationOut
    target_media_id: UUID | None
    target_locator: dict[str, object] | None
    target_status: Literal["current", "missing", "forbidden", "unanchorable"]


@dataclass(frozen=True, slots=True)
class ConnectionLinkNote:
    """The one ordinary note folded onto a Link, resolved from its two attachment edges."""

    ref: ResourceRef
    preview: str | None


@dataclass(frozen=True, slots=True)
class UnlinkMutation:
    kind: Literal["unlink"] = "unlink"


@dataclass(frozen=True, slots=True)
class DismissDiscoveryMutation:
    kind: Literal["dismiss_discovery"] = "dismiss_discovery"


@dataclass(frozen=True, slots=True)
class DetachContextMutation:
    conversation_id: UUID
    kind: Literal["detach_context"] = "detach_context"


@dataclass(frozen=True, slots=True)
class UndoAssistantChatMutation:
    conversation_id: UUID
    tool_call_id: UUID
    kind: Literal["undo_assistant_chat"] = "undo_assistant_chat"


@dataclass(frozen=True, slots=True)
class UndoAssistantGenerationMutation:
    position_id: UUID
    kind: Literal["undo_assistant_generation"] = "undo_assistant_generation"


ConnectionMutation = (
    UnlinkMutation
    | DismissDiscoveryMutation
    | DetachContextMutation
    | UndoAssistantChatMutation
    | UndoAssistantGenerationMutation
)


@dataclass(frozen=True, slots=True)
class ChatCreationRecord:
    conversation_id: UUID
    message_id: UUID
    tool_call_id: UUID
    kind: Literal["chat"] = "chat"


@dataclass(frozen=True, slots=True)
class GenerationCreationRecord:
    generation_id: UUID
    position_id: UUID
    kind: Literal["generation"] = "generation"


ConnectionCreationRecord = ChatCreationRecord | GenerationCreationRecord


@dataclass(frozen=True, slots=True)
class ConnectionCreation:
    authorship: MachineAuthorshipOut
    record: ConnectionCreationRecord


@dataclass(frozen=True, slots=True)
class Connection:
    edge_id: UUID
    direction: Literal["incoming", "outgoing", "undirected"]
    kind: EdgeKind
    origin: EdgeOrigin
    snapshot: CitationSnapshot | None
    source_order_key: str | None
    ordinal: int | None
    source: ConnectionEndpoint
    target: ConnectionEndpoint
    other: ConnectionEndpoint
    citation: ConnectionCitation | None
    link_note: ConnectionLinkNote | None
    creation: ConnectionCreation | None
    mutation: ConnectionMutation | None
    created_at: datetime


@dataclass(frozen=True, slots=True)
class ConnectionPage:
    items: tuple[Connection, ...]
    next_cursor: str | None
