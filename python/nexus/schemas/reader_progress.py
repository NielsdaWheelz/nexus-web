"""Account-bound progress for hosted publications and transcript timelines."""

from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from nexus.schemas.reader import ReaderCursorSnapshot, ReaderResumeState


class ReaderProgressState(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )
    account_id: UUID
    reader_generation: int | None = Field(ge=1)
    cursor: ReaderCursorSnapshot


class ReaderProgressWrite(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=False,
        extra="forbid",
    )
    expected_reader_generation: int | None = Field(ge=1)
    base_revision: int = Field(ge=0)
    locator: ReaderResumeState
