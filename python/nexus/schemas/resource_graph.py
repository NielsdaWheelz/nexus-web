"""Wire schemas for the resource provenance graph API (spec §10).

Refs travel as ``<scheme>:<uuid>`` URI strings on the wire; routes parse them
into typed ``ResourceRef`` values at the boundary. ``EdgeOut`` carries live
endpoint display (label + missing) so connections lists render without a
second round trip; ``POST /resource-graph/resolve`` covers every other UI
hydration need.
"""

from datetime import datetime
from typing import Any, Literal, get_args
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services.resource_graph.refs import ResourceScheme

# The edge vocabularies are single-sourced in the graph-schema module (LOW #20);
# this wire layer re-exports them and derives the route-boundary value-tuples.
from nexus.services.resource_graph.schemas import EdgeKind as EdgeKind
from nexus.services.resource_graph.schemas import EdgeOrigin as EdgeOrigin

# Route-boundary vocabulary for query params (Literal values, importable as data).
EDGE_KIND_VALUES: tuple[str, ...] = get_args(EdgeKind)
EDGE_ORIGIN_VALUES: tuple[str, ...] = get_args(EdgeOrigin)


class ResourceGraphModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateEdgeRequest(ResourceGraphModel):
    """Body for POST /resource-graph/edges (user links + user stance edges)."""

    source_ref: str
    target_ref: str
    kind: EdgeKind = "context"


class AddContextRefRequest(ResourceGraphModel):
    """Body for POST /conversations/{id}/context-refs."""

    resource_ref: str


class ResolveRefsRequest(ResourceGraphModel):
    """Body for POST /resource-graph/resolve."""

    refs: list[str] = Field(min_length=1, max_length=100)


class ConnectionFiltersRequest(ResourceGraphModel):
    origins: list[EdgeOrigin] | None = None
    kinds: list[EdgeKind] | None = None
    source_schemes: list[ResourceScheme] | None = None
    target_schemes: list[ResourceScheme] | None = None


class ConnectionQueryRequest(ResourceGraphModel):
    """Body for POST /resource-graph/connections/query."""

    refs: list[str] = Field(min_length=1, max_length=200)
    direction: Literal["incoming", "outgoing", "both"]
    rollup: Literal["exact", "owner"] = "exact"
    filters: ConnectionFiltersRequest = Field(default_factory=ConnectionFiltersRequest)
    limit: int = Field(default=100, ge=1, le=100)
    cursor: str | None = None


class EdgeOut(ResourceGraphModel):
    """One ``resource_edges`` row plus live endpoint display.

    ``snapshot`` is the stored citation display payload
    (title/excerpt/section_label/deep_link/result_type); ``*_label``/
    ``*_missing`` are live resolver hydration for connections rendering.
    """

    id: UUID
    kind: EdgeKind
    origin: EdgeOrigin
    source_ref: str
    target_ref: str
    source_order_key: str | None = None
    target_order_key: str | None = None
    ordinal: int | None = None
    snapshot: dict[str, Any] | None = None
    source_label: str
    source_missing: bool
    target_label: str
    target_missing: bool
    created_at: datetime


class ConnectionEndpointOut(ResourceGraphModel):
    ref: str
    scheme: ResourceScheme
    id: UUID
    label: str | None
    description: str | None
    activation: ResourceActivationOut
    href: str | None
    missing: bool


class ConnectionReaderTargetOut(ResourceGraphModel):
    media_id: UUID | None
    locator: dict[str, Any] | None


class ConnectionCitationOut(ResourceGraphModel):
    ordinal: int
    role: EdgeKind
    snapshot: dict[str, Any]
    activation: ResourceActivationOut
    target_reader: ConnectionReaderTargetOut | None
    target_status: Literal["current", "missing", "forbidden", "unanchorable"]


class ConnectionOut(ResourceGraphModel):
    edge_id: UUID
    direction: Literal["incoming", "outgoing"]
    kind: EdgeKind
    origin: EdgeOrigin
    snapshot: dict[str, Any] | None
    source_order_key: str | None
    target_order_key: str | None
    ordinal: int | None
    source_ref: str
    target_ref: str
    source: ConnectionEndpointOut
    target: ConnectionEndpointOut
    other: ConnectionEndpointOut
    citation: ConnectionCitationOut | None
    created_at: datetime


class ConnectionPageOut(ResourceGraphModel):
    items: list[ConnectionOut]
    next_cursor: str | None


class ContextRefOut(ResourceGraphModel):
    """One conversation context edge, hydrated for display."""

    id: UUID
    conversation_id: UUID
    resource_ref: str
    activation: ResourceActivationOut
    label: str
    summary: str
    missing: bool
    created_at: datetime


class ResolvedResourceOut(ResourceGraphModel):
    """Batch-resolve item for UI hydration."""

    ref: str
    label: str
    summary: str
    missing: bool
