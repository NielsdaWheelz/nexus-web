"""Shared display estimates for readable documents."""

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from nexus.schemas.presence import Presence

_INT32_MAX = 2_147_483_647


class ReadingTimeEstimateOut(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

    total_minutes: Annotated[int, Field(strict=True, ge=1, le=_INT32_MAX)]
    remaining_minutes: Presence[Annotated[int, Field(strict=True, ge=0, le=_INT32_MAX)]]
