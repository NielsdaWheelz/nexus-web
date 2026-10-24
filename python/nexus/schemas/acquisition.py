"""Frozen admission guards shared by source, upload and podcast acquisition.

An admission compares the viewer's removal fence and every named destination's
exact structural revision before publishing or retaining anything.
"""

from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel, ConfigDict, model_validator

from nexus.schemas.collection_order import OrderRevision


class DestinationGuard(BaseModel):
    model_config = ConfigDict(extra="forbid")

    library_id: UUID
    expected_order_revision: OrderRevision


class AcquisitionGuard(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_removal_revision: OrderRevision
    destinations: list[DestinationGuard]

    @model_validator(mode="after")
    def unique_destinations(self) -> AcquisitionGuard:
        ids = [destination.library_id for destination in self.destinations]
        if len(ids) != len(set(ids)):
            raise ValueError("Duplicate acquisition destination")
        return self
