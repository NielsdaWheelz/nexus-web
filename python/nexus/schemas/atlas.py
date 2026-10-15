"""The atlas read model: the viewer's stars, constellations and edges in the one frame."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel


class StarOut(BaseModel):
    media_id: UUID
    x: float | None  # both null: unpositioned (the nebula)
    y: float | None
    title: str
    kind: str
    magnitude: int  # the viewer's highlight count on the work


class ConstellationOut(BaseModel):
    library_id: UUID
    name: str
    member_media_ids: list[UUID]


class AtlasEdgeOut(BaseModel):
    source_media_id: UUID
    target_media_id: UUID
    kind: Literal["context", "contradicts"]


class AtlasOut(BaseModel):
    stars: list[StarOut]
    constellations: list[ConstellationOut]
    edges: list[AtlasEdgeOut]
