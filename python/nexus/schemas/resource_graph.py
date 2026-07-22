"""Wire schemas for the resource provenance graph API (spec §10).

Refs travel as ``<scheme>:<uuid>`` URI strings on the wire; routes parse them
into typed ``ResourceRef`` values at the boundary. ``ConnectionOut`` carries live
endpoint display (label + missing) so connections lists render without a
second round trip; ``POST /resource-graph/resolve`` covers every other UI
hydration need.
"""

from datetime import datetime
from typing import Annotated, Any, Literal, get_args
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from nexus.schemas.highlights import HIGHLIGHT_COLORS, PdfQuadIn
from nexus.schemas.resource_items import ResourceActivationOut, validate_note_body_pm_json
from nexus.services.resource_graph.refs import ResourceScheme

# The edge vocabularies are single-sourced in the graph-schema module (LOW #20);
# this wire layer re-exports them and derives the route-boundary value-tuples.
from nexus.services.resource_graph.schemas import Connection as Connection
from nexus.services.resource_graph.schemas import ConnectionEndpoint as ConnectionEndpoint
from nexus.services.resource_graph.schemas import EdgeKind as EdgeKind
from nexus.services.resource_graph.schemas import EdgeOrigin as EdgeOrigin
from nexus.services.resource_graph.schemas import snapshot_to_jsonb

# Route-boundary vocabulary for query params (Literal values, importable as data).
EDGE_KIND_VALUES: tuple[str, ...] = get_args(EdgeKind)
EDGE_ORIGIN_VALUES: tuple[str, ...] = get_args(EdgeOrigin)


class ResourceGraphModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


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


class ConnectionSummaryRequest(ResourceGraphModel):
    """Body for POST /resource-graph/connections/summary.

    ``origins`` defaults (when omitted) to ``LIST_CONNECTION_ORIGINS`` in the
    service: the AI-free collection-surface allowlist. The Literal element type
    rejects unknown origin values at the boundary with 400.
    """

    refs: list[str] = Field(min_length=1, max_length=200)
    origins: list[EdgeOrigin] | None = None


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


class ConnectionLinkNoteOut(ResourceGraphModel):
    """The one ordinary note folded onto a user/context Link (§ Graph Shapes).

    Resolved from the two structural ``link_note`` attachment edges; the
    structural rows never appear as their own connections (Invariant 12).
    """

    ref: str
    note_block_id: UUID
    preview: str | None


class ConnectionOut(ResourceGraphModel):
    edge_id: UUID
    direction: Literal["incoming", "outgoing", "undirected"]
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
    link_note: ConnectionLinkNoteOut | None = None
    created_at: datetime


class ConnectionPageOut(ResourceGraphModel):
    items: list[ConnectionOut]
    next_cursor: str | None


class ConnectionSummaryOut(ResourceGraphModel):
    """Per-ref connection aggregate for the collection surface (spec S4).

    ``by_kind`` is keyed by edge kind; ``dominant_kind`` is the highest-count kind
    (ties broken deterministically). ``top_peers`` carry live label + href, and a
    deleted/forbidden peer comes back ``missing`` (never leaked).
    """

    ref: str
    total: int
    by_kind: dict[str, int]
    last_connected_at: datetime | None
    dominant_kind: str | None
    top_peers: list[ConnectionEndpointOut]


class ConnectionSummaryPageOut(ResourceGraphModel):
    summaries: list[ConnectionSummaryOut]


class RelatedMediaOut(ResourceGraphModel):
    """Deterministic related peers for one media (spec S5).

    ``peers`` reuses ``ConnectionEndpointOut`` so each carries live label + href
    and a deleted/forbidden peer comes back ``missing`` (never leaked). The peers
    are computed from precomputed embeddings + shared-author credits — no
    request-time LLM.
    """

    peers: list[ConnectionEndpointOut]


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


# =============================================================================
# Link / stance / link-note mutation payloads (§ Mutation APIs)
# =============================================================================


class LinkResourceSource(ResourceGraphModel):
    """A durable Resource as the Link source (no fresh Highlight)."""

    kind: Literal["resource"] = "resource"
    ref: str


class LinkFragmentSelectionSource(ResourceGraphModel):
    """A fresh reflowable selection materialized as a Highlight on confirmation."""

    kind: Literal["fragment_selection"] = "fragment_selection"
    highlight_id: UUID
    fragment_id: UUID
    start_offset: int = Field(..., ge=0)
    end_offset: int = Field(..., gt=0)
    color: HIGHLIGHT_COLORS


class LinkPdfSelectionSource(ResourceGraphModel):
    """A fresh PDF page-space selection materialized as a Highlight on confirmation."""

    kind: Literal["pdf_selection"] = "pdf_selection"
    highlight_id: UUID
    media_id: UUID
    page_number: int = Field(..., ge=1)
    quads: list[PdfQuadIn] = Field(..., min_length=1, max_length=512)
    exact: str = ""
    color: HIGHLIGHT_COLORS


LinkSource = Annotated[
    LinkResourceSource | LinkFragmentSelectionSource | LinkPdfSelectionSource,
    Field(discriminator="kind"),
]


class LinkResourceTarget(ResourceGraphModel):
    """A durable Resource as the Link target."""

    kind: Literal["resource"] = "resource"
    ref: str


class LinkPassageTarget(ResourceGraphModel):
    """A transient passage candidate; materialized into a ``passage_anchor`` on confirm."""

    kind: Literal["passage"] = "passage"
    candidate_ref: str


LinkTarget = Annotated[LinkResourceTarget | LinkPassageTarget, Field(discriminator="kind")]


class CreateLinkRequest(ResourceGraphModel):
    """Body for POST /resource-graph/links."""

    client_mutation_id: str = Field(..., min_length=1, max_length=120)
    source: LinkSource
    target: LinkTarget


class CreateLinkOut(ResourceGraphModel):
    """One confirmation's result: the neutral Link and any minted source Highlight."""

    created: bool
    created_source_ref: str | None = None
    connection: ConnectionOut


class PutLinkNoteRequest(ResourceGraphModel):
    """Body for PUT /resource-graph/links/{link_id}/note."""

    client_mutation_id: str = Field(..., min_length=1, max_length=120)
    note_block_id: UUID
    body_pm_json: dict[str, Any]

    @field_validator("body_pm_json")
    @classmethod
    def _validate_body_pm_json(cls, value: dict[str, Any]) -> dict[str, Any]:
        validated = validate_note_body_pm_json(value)
        if validated is None:
            raise ValueError("body_pm_json is required")
        return validated


class LinkNoteOut(ResourceGraphModel):
    """The Link's single ordinary note folded onto its refreshed connection."""

    note_block_id: UUID
    connection: ConnectionOut


class PutStanceRequest(ResourceGraphModel):
    """Body for PUT /resource-graph/stances (supports/contradicts, one per pair)."""

    source_ref: str
    target_ref: str
    kind: Literal["supports", "contradicts"]


class StanceOut(ResourceGraphModel):
    """The single directed stance edge for an unordered pair."""

    connection: ConnectionOut


def connection_out(item: Connection) -> ConnectionOut:
    """Map one hydrated ``Connection`` to its wire ``ConnectionOut``.

    Single source of the connection projection (routes, reader, and the Link
    service all serialize through this): neutral Links carry
    ``direction="undirected"`` and their folded ``link_note`` payload, while the
    structural attachment rows never surface on their own (Invariant 12).
    """
    citation = None
    if item.citation is not None:
        target_reader = None
        if item.citation.target_media_id is not None or item.citation.target_locator is not None:
            target_reader = ConnectionReaderTargetOut(
                media_id=item.citation.target_media_id,
                locator=item.citation.target_locator,
            )
        citation = ConnectionCitationOut(
            ordinal=item.citation.ordinal,
            role=item.citation.role,
            snapshot=snapshot_to_jsonb(item.citation.snapshot),
            activation=item.citation.activation,
            target_reader=target_reader,
            target_status=item.citation.target_status,
        )
    link_note = None
    if item.link_note is not None:
        link_note = ConnectionLinkNoteOut(
            ref=item.link_note.ref.uri,
            note_block_id=item.link_note.ref.id,
            preview=item.link_note.preview,
        )
    return ConnectionOut(
        edge_id=item.edge_id,
        direction=item.direction,
        kind=item.kind,
        origin=item.origin,
        snapshot=snapshot_to_jsonb(item.snapshot) if item.snapshot is not None else None,
        source_order_key=item.source_order_key,
        target_order_key=item.target_order_key,
        ordinal=item.ordinal,
        source_ref=item.source_ref.uri,
        target_ref=item.target_ref.uri,
        source=_endpoint_out(item.source),
        target=_endpoint_out(item.target),
        other=_endpoint_out(item.other),
        citation=citation,
        link_note=link_note,
        created_at=item.created_at,
    )


def _endpoint_out(endpoint: ConnectionEndpoint) -> ConnectionEndpointOut:
    return ConnectionEndpointOut(
        ref=endpoint.ref.uri,
        scheme=endpoint.ref.scheme,
        id=endpoint.ref.id,
        label=endpoint.label,
        description=endpoint.description,
        activation=endpoint.activation,
        href=endpoint.href,
        missing=endpoint.missing,
    )
