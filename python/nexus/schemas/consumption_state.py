"""Canonical current consumption facts, independent of player contracts."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.presence import Presence

ConsumptionStateValue = Literal["Unread", "InProgress", "Finished"]


class ConsumptionOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    state: ConsumptionStateValue
    progress: Presence[Annotated[float, Field(ge=0, le=1)]]
