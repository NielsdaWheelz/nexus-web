"""Read-model schemas for the grand atlas (grand-atlas §6)."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel


class StarOut(BaseModel):
    media_id: UUID
    x: float | None  # None = Nebula (no atlas position)
    y: float | None
    title: str
    kind: str
    magnitude: int  # highlight count (phase 1; soft upgrade: dwell)


class ConstellationOut(BaseModel):
    library_id: UUID
    name: str
    member_media_ids: list[UUID]


class AtlasEdgeOut(BaseModel):
    source_media_id: UUID
    target_media_id: UUID
    kind: Literal["context", "contradicts"]
    origin: str


class AtlasOut(BaseModel):
    stars: list[StarOut]
    constellations: list[ConstellationOut]
    edges: list[AtlasEdgeOut]


class AtlasStatusOut(BaseModel):
    projection_version: int | None
    positioned_count: int
    total_count: int
    stale_count: int
    last_run: str | None
