"""Shared display estimates for readable documents."""

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

_INT32_MAX = 2_147_483_647


class ReadingTimeEstimateOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    total_minutes: Annotated[int, Field(strict=True, ge=1, le=_INT32_MAX)]
    remaining_minutes: Annotated[int, Field(strict=True, ge=0, le=_INT32_MAX)] | None
