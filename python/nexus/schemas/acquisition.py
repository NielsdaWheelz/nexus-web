"""The frozen admission guard shared by source, upload and capture acquisition.

An admission compares the viewer's removal fence and checks authority over every
named destination before publishing or retaining anything. Appends commute, so no
destination's order revision is compared.
"""

from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel, ConfigDict, model_validator

from nexus.schemas.collection_order import OrderRevision


class SourceTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media_id: UUID
    expected_source_attempt_id: UUID | None


class ExtensionSourceAdmission(BaseModel):
    """The immutable intent answered by an extension source-attempt receipt."""

    model_config = ConfigDict(extra="forbid")

    expected_target: SourceTarget | None
    expected_removal_revision: OrderRevision


class AcquisitionGuard(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_removal_revision: OrderRevision
    destinations: list[UUID]

    @model_validator(mode="after")
    def unique_destinations(self) -> AcquisitionGuard:
        if len(self.destinations) != len(set(self.destinations)):
            raise ValueError("Duplicate acquisition destination")
        return self
