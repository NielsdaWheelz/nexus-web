"""Closed wire projection for assistant-created domain targets."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

_POSTGRES_INTEGER_MAX = (1 << 31) - 1
_MAX_POSITION_PATH = f"generation/{_POSTGRES_INTEGER_MAX}/tool/{_POSTGRES_INTEGER_MAX}"

MachineAuthorshipTargetKind = Literal[
    "library_entry",
    "note_block",
    "highlight",
    "resource_edge",
    "queue_item",
]

MachineAuthorshipPositionPath = Annotated[
    str,
    StringConstraints(
        pattern=r"^generation/[1-9][0-9]*/tool/[1-9][0-9]*$",
        max_length=len(_MAX_POSITION_PATH),
    ),
    Field(examples=[_MAX_POSITION_PATH]),
]


class MachineAuthorshipOut(BaseModel):
    """One immutable target-to-generation provenance fact."""

    target_kind: MachineAuthorshipTargetKind
    target_id: UUID
    generation_id: UUID
    generation_seq: int = Field(strict=True, ge=1, le=_POSTGRES_INTEGER_MAX)
    tool_position: int = Field(strict=True, ge=1, le=_POSTGRES_INTEGER_MAX)
    position_path: MachineAuthorshipPositionPath
    effect_id: UUID

    model_config = ConfigDict(extra="forbid", frozen=True)


__all__ = [
    "MachineAuthorshipOut",
    "MachineAuthorshipPositionPath",
    "MachineAuthorshipTargetKind",
]
