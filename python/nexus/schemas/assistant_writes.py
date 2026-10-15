"""The wire of assistant writes: machine authorship, created targets, the account history."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

_INT32 = (1 << 31) - 1
TargetKind = Literal["library_entry", "note_block", "highlight", "resource_edge", "queue_item"]
_LONGEST_PATH = f"generation/{_INT32}/tool/{_INT32}"


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class MachineAuthorshipOut(_Out):
    """One immutable target-to-generation provenance fact."""

    target_kind: TargetKind
    target_id: UUID
    generation_id: UUID
    generation_seq: int = Field(strict=True, ge=1, le=_INT32)
    tool_position: int = Field(strict=True, ge=1, le=_INT32)
    position_path: Annotated[
        str,
        StringConstraints(
            pattern=r"^generation/[1-9][0-9]*/tool/[1-9][0-9]*$", max_length=len(_LONGEST_PATH)
        ),
        Field(examples=[_LONGEST_PATH]),
    ]
    effect_id: UUID


class CreatedRefOut(BaseModel):
    """A target one write inserted; its undo removes exactly these."""

    # a library entry's ref also carries what undo needs (library, target).
    model_config = ConfigDict(extra="ignore", frozen=True)

    kind: Literal["entry", "note_block", "highlight", "edge", "queue"]
    id: UUID
    label: str


class AssistantWriteOut(_Out):
    id: UUID
    generation_id: UUID
    tool_id: str
    created_at: datetime
    created_refs: list[CreatedRefOut]
    error_type: str | None  # None: the write succeeded
    reverted_at: datetime | None
    undo_allowed: bool


class AssistantWritePage(_Out):
    items: list[AssistantWriteOut]
    next_cursor: UUID | None
