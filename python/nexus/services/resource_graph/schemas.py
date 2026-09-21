"""Edge vocabularies and the plain records the graph modules exchange.

``EdgeKind``/``EdgeOrigin`` mirror the ``resource_edges`` CHECKs exactly; widening one
needs a migration and a change to the sole writer, ``resource_graph.edges``.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Literal, get_args
from uuid import UUID

from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme

EdgeKind = Literal["context", "supports", "contradicts"]
EdgeOrigin = Literal[
    "user",
    "citation",
    "system",
    "note_body",
    "highlight_note",
    "synapse",
    "document_embed",
    "assistant",
    "link_note",
]
EDGE_KINDS: tuple[EdgeKind, ...] = get_args(EdgeKind)
EDGE_ORIGINS: tuple[EdgeOrigin, ...] = get_args(EdgeOrigin)
ConnectionDirection = Literal["incoming", "outgoing", "both"]

SEARCH_SCOPE_EDGE_KIND: EdgeKind = "context"
SYNAPSE_SOURCE_SCHEMES: tuple[ResourceScheme, ...] = ("media", "page", "note_block", "highlight")
SYNAPSE_TARGET_SCHEMES: tuple[ResourceScheme, ...] = ("media", "note_block", "evidence_span")
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
    target_order_key: str | None = None
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
    target_order_key: str | None
    ordinal: int | None
    snapshot: CitationSnapshot | None
    created_at: datetime


def is_neutral_link_shape(
    *,
    origin: str,
    kind: str,
    ordinal: int | None,
    snapshot: object | None,
    source_order_key: str | None,
    target_order_key: str | None,
) -> bool:
    """The canonical neutral-Link predicate: ``uq_resource_edges_user_context_link_pair``.

    The writer, the delete gate and the "is this undirected?" read all share it, so the
    neutral-Link shape cannot drift between them. Stance and ordered adjacency are out.
    """
    return (
        origin == "user"
        and kind == "context"
        and ordinal is None
        and snapshot is None
        and source_order_key is None
        and target_order_key is None
    )


@dataclass(frozen=True, slots=True)
class CitationInput:
    target: ResourceRef
    ordinal: int
    kind: EdgeKind
    snapshot: CitationSnapshot


@dataclass(frozen=True, slots=True)
class ConcordantSource:
    source: ResourceRef
    shared_target_count: int


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
class Connection:
    edge_id: UUID
    direction: Literal["incoming", "outgoing", "undirected"]
    kind: EdgeKind
    origin: EdgeOrigin
    snapshot: CitationSnapshot | None
    source_order_key: str | None
    target_order_key: str | None
    ordinal: int | None
    source_ref: ResourceRef
    target_ref: ResourceRef
    source: ConnectionEndpoint
    target: ConnectionEndpoint
    other: ConnectionEndpoint
    citation: ConnectionCitation | None
    link_note: ConnectionLinkNote | None
    created_at: datetime


@dataclass(frozen=True, slots=True)
class ConnectionPage:
    items: tuple[Connection, ...]
    next_cursor: str | None
