"""The resource graph's vocabulary and wire: edge kinds and origins, the stored edge
snapshot, connection reads, machine-fact removal and link endpoints. Refs travel as
``<scheme>:<uuid>``."""

from datetime import datetime
from typing import Annotated, Literal, get_args
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.assistant_writes import MachineAuthorshipOut
from nexus.schemas.resource_evidence import CapturedEvidence, CapturedPassageTarget
from nexus.schemas.resource_items import ResourceItemOut
from nexus.services.resource_graph.refs import ResourceScheme

EdgeKind = Literal["context", "supports", "contradicts"]
EdgeOrigin = Literal[
    "user",
    "citation",
    "note_body",
    "discovery",
    "document_embed",
    "assistant",
]
EDGE_KINDS: tuple[EdgeKind, ...] = get_args(EdgeKind)
ConnectionDirection = Literal["incoming", "outgoing", "both"]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CitationSnapshot(BaseModel):
    """Exactly one captured citation evidence or machine relationship rationale.

    Imported and oracle citations own captured evidence. A message citation is a live
    projection of its retrieval target and stores no snapshot at all."""

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


class RemoteChildrenOccurrenceRequest(Model):
    resource_ref: str
    excluded_edge_ids: list[UUID]


class RemoteChildrenRequest(Model):
    occurrences: list[RemoteChildrenOccurrenceRequest] = Field(min_length=1, max_length=100)


class RemoteChildrenItem(Model):
    has_children: bool | None
    local_ref: str | None


class RemoteChildrenOut(Model):
    items: list[RemoteChildrenItem]


class ConnectionCreationOut(Model):
    """Who created an assistant link: its tool call, and the answer while its turn exists."""

    authorship: MachineAuthorshipOut
    tool_call_id: UUID
    generation_id: UUID
    message_id: UUID | None


class RemoveFactMutation(Model):
    """Removal of one discovery or assistant fact by ``DELETE /resource-graph/facts/{id}``."""

    kind: Literal["remove_fact"] = "remove_fact"


class ConnectionOut(Model):
    """One fact seen from a queried ref: ``other`` is the far endpoint, an authored link is
    ``undirected``, and ``mutation`` names the one server command that may remove it; an
    authored link has none, because only the local authored store unlinks it. A citation
    has none either: it dies with its source. A message citation carries no snapshot."""

    edge_id: UUID
    direction: Literal["incoming", "outgoing", "undirected"]
    kind: EdgeKind
    origin: EdgeOrigin
    snapshot: CitationSnapshot | None
    ordinal: int | None
    source: ResourceItemOut
    target: ResourceItemOut
    other: ResourceItemOut
    creation: ConnectionCreationOut | None
    mutation: RemoveFactMutation | None
    created_at: datetime


class ConnectionPageOut(Model):
    items: list[ConnectionOut]
    next_cursor: str | None


class LinkResourceEndpoint(Model):
    kind: Literal["resource"] = "resource"
    ref: str


class LinkPassageEndpoint(Model):
    """A transient passage candidate, materialized into a ``passage_anchor`` on confirm."""

    kind: Literal["passage"] = "passage"
    candidate_ref: str
    passage_target: CapturedPassageTarget | None


LinkEndpoint = Annotated[LinkResourceEndpoint | LinkPassageEndpoint, Field(discriminator="kind")]
