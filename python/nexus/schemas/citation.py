"""A saved citation occurrence: its edge identity and frozen resource presentation."""

from uuid import UUID

from pydantic import BaseModel, ConfigDict

from nexus.schemas.resource_graph import EdgeKind
from nexus.schemas.resource_items import ResourceItemOut

CitationRole = EdgeKind


class CitationOut(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)
    edge_id: UUID
    ordinal: int
    role: CitationRole
    item: ResourceItemOut
