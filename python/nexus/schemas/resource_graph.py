"""Wire schemas for the resource-graph API, serialized snake_case.

Refs travel as ``<scheme>:<uuid>`` strings; routes parse them at the boundary.
``ConnectionOut`` carries live endpoint display so a connections list renders without a
second round trip. Generated wire types own the client contract.
"""

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from nexus.schemas.highlights import HIGHLIGHT_COLORS, PdfQuadIn
from nexus.schemas.machine_authorship import MachineAuthorshipOut
from nexus.schemas.resource_items import (
    ExpectedNoteBody,
    ResourceActivationOut,
    validate_note_body_pm_json,
)
from nexus.services.resource_graph.refs import ResourceScheme
from nexus.services.resource_graph.schemas import Connection as Connection
from nexus.services.resource_graph.schemas import (
    ConnectionCreationRecord,
    ConnectionMutation,
    snapshot_to_jsonb,
)
from nexus.services.resource_graph.schemas import ConnectionEndpoint as ConnectionEndpoint
from nexus.services.resource_graph.schemas import EdgeKind as EdgeKind
from nexus.services.resource_graph.schemas import EdgeOrigin as EdgeOrigin


class ResourceGraphModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ConnectionFiltersRequest(ResourceGraphModel):
    origins: list[EdgeOrigin] | None = None
    kinds: list[EdgeKind] | None = None
    source_schemes: list[ResourceScheme] | None = None
    target_schemes: list[ResourceScheme] | None = None


class ConnectionQueryRequest(ResourceGraphModel):
    refs: list[str] = Field(min_length=1, max_length=200)
    direction: Literal["incoming", "outgoing", "both"]
    rollup: Literal["exact", "owner"] = "exact"
    filters: ConnectionFiltersRequest = Field(default_factory=ConnectionFiltersRequest)
    limit: int = Field(default=100, ge=1, le=100)
    cursor: str | None = None


class ConnectionActivationOut(ResourceGraphModel):
    """The graph's existing snake-case activation bytes, explicitly typed."""

    resource_ref: str
    kind: Literal["route", "external", "none"]
    href: str | None
    unresolved_reason: str | None


class ConnectionEndpointOut(ResourceGraphModel):
    ref: str
    scheme: ResourceScheme
    id: UUID
    label: str | None
    description: str | None
    activation: ConnectionActivationOut
    href: str | None
    missing: bool


class ConnectionReaderTargetOut(ResourceGraphModel):
    media_id: UUID | None
    locator: dict[str, Any] | None


class ConnectionCitationOut(ResourceGraphModel):
    ordinal: int
    role: EdgeKind
    snapshot: dict[str, Any]
    activation: ConnectionActivationOut
    target_reader: ConnectionReaderTargetOut | None
    target_status: Literal["current", "missing", "forbidden", "unanchorable"]


class ConnectionLinkNoteOut(ResourceGraphModel):
    ref: str
    note_block_id: UUID
    preview: str | None


class ConnectionCreationOut(ResourceGraphModel):
    authorship: MachineAuthorshipOut
    record: Annotated[ConnectionCreationRecord, Field(discriminator="kind")]


class ConnectionOut(ResourceGraphModel):
    edge_id: UUID
    direction: Literal["incoming", "outgoing", "undirected"]
    kind: EdgeKind
    origin: EdgeOrigin
    snapshot: dict[str, Any] | None
    source_order_key: str | None
    ordinal: int | None
    source_ref: str
    target_ref: str
    source: ConnectionEndpointOut
    target: ConnectionEndpointOut
    other: ConnectionEndpointOut
    citation: ConnectionCitationOut | None
    link_note: ConnectionLinkNoteOut | None
    creation: ConnectionCreationOut | None
    mutation: Annotated[ConnectionMutation, Field(discriminator="kind")] | None
    created_at: datetime


class ConnectionPageOut(ResourceGraphModel):
    items: list[ConnectionOut]
    next_cursor: str | None


class ContextRefOut(ResourceGraphModel):
    id: UUID
    conversation_id: UUID
    resource_ref: str
    activation: ResourceActivationOut
    label: str
    summary: str
    missing: bool
    created_at: datetime


class LinkResourceEndpoint(ResourceGraphModel):
    kind: Literal["resource"] = "resource"
    ref: str


class LinkFragmentSelectionSource(ResourceGraphModel):
    """A reflowable selection materialized as a Highlight on confirmation."""

    kind: Literal["fragment_selection"] = "fragment_selection"
    highlight_id: UUID
    fragment_id: UUID
    start_offset: int = Field(..., ge=0)
    end_offset: int = Field(..., gt=0)
    color: HIGHLIGHT_COLORS


class LinkPdfSelectionSource(ResourceGraphModel):
    """A PDF page-space selection materialized as a Highlight on confirmation."""

    kind: Literal["pdf_selection"] = "pdf_selection"
    highlight_id: UUID
    media_id: UUID
    page_number: int = Field(..., ge=1)
    quads: list[PdfQuadIn] = Field(..., min_length=1, max_length=512)
    exact: str = ""
    color: HIGHLIGHT_COLORS


class LinkPassageEndpoint(ResourceGraphModel):
    """A transient passage candidate, materialized into a ``passage_anchor`` on confirm."""

    kind: Literal["passage"] = "passage"
    candidate_ref: str


LinkEndpoint = Annotated[LinkResourceEndpoint | LinkPassageEndpoint, Field(discriminator="kind")]
LinkSource = Annotated[
    LinkResourceEndpoint
    | LinkPassageEndpoint
    | LinkFragmentSelectionSource
    | LinkPdfSelectionSource,
    Field(discriminator="kind"),
]


class CreateLinkRequest(ResourceGraphModel):
    client_mutation_id: str = Field(..., min_length=1, max_length=120)
    source: LinkSource
    target: LinkEndpoint


class CreateLinkOut(ResourceGraphModel):
    created: bool
    created_source_ref: str | None
    connection: ConnectionOut


class PutLinkNoteRequest(ResourceGraphModel):
    client_mutation_id: str = Field(..., min_length=1, max_length=120)
    note_block_id: UUID
    expected_body: ExpectedNoteBody
    body_pm_json: dict[str, Any]

    @field_validator("body_pm_json")
    @classmethod
    def _validate_body_pm_json(cls, value: dict[str, Any]) -> dict[str, Any]:
        validated = validate_note_body_pm_json(value)
        if validated is None:
            raise ValueError("body_pm_json is required")
        return validated


class LinkNoteVersionsOut(ResourceGraphModel):
    body: int
    links: int


class LinkNoteOut(ResourceGraphModel):
    note_block_id: UUID
    body_pm_json: dict[str, Any]
    body_text: str
    version_by_lane: LinkNoteVersionsOut
    connection: ConnectionOut


def _activation_out(activation: ResourceActivationOut) -> ConnectionActivationOut:
    return ConnectionActivationOut(
        resource_ref=activation.resource_ref,
        kind=activation.kind,
        href=activation.href,
        unresolved_reason=activation.unresolved_reason,
    )


def endpoint_out(endpoint: ConnectionEndpoint) -> ConnectionEndpointOut:
    return ConnectionEndpointOut(
        ref=endpoint.ref.uri,
        scheme=endpoint.ref.scheme,
        id=endpoint.ref.id,
        label=endpoint.label,
        description=endpoint.description,
        activation=_activation_out(endpoint.activation),
        href=endpoint.href,
        missing=endpoint.missing,
    )


def connection_out(item: Connection) -> ConnectionOut:
    """The single projection of a hydrated connection onto the wire."""
    citation = None
    if item.citation is not None:
        target_reader = None
        if item.citation.target_media_id is not None or item.citation.target_locator is not None:
            target_reader = ConnectionReaderTargetOut(
                media_id=item.citation.target_media_id, locator=item.citation.target_locator
            )
        citation = ConnectionCitationOut(
            ordinal=item.citation.ordinal,
            role=item.citation.role,
            snapshot=snapshot_to_jsonb(item.citation.snapshot),
            activation=_activation_out(item.citation.activation),
            target_reader=target_reader,
            target_status=item.citation.target_status,
        )
    return ConnectionOut(
        edge_id=item.edge_id,
        direction=item.direction,
        kind=item.kind,
        origin=item.origin,
        snapshot=snapshot_to_jsonb(item.snapshot) if item.snapshot is not None else None,
        source_order_key=item.source_order_key,
        ordinal=item.ordinal,
        source_ref=item.source_ref.uri,
        target_ref=item.target_ref.uri,
        source=endpoint_out(item.source),
        target=endpoint_out(item.target),
        other=endpoint_out(item.other),
        citation=citation,
        link_note=(
            ConnectionLinkNoteOut(
                ref=item.link_note.ref.uri,
                note_block_id=item.link_note.ref.id,
                preview=item.link_note.preview,
            )
            if item.link_note is not None
            else None
        ),
        creation=(
            ConnectionCreationOut(authorship=item.creation.authorship, record=item.creation.record)
            if item.creation is not None
            else None
        ),
        mutation=item.mutation,
        created_at=item.created_at,
    )
