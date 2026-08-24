"""Generation-fenced offline reader progress boundary."""

from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from nexus.schemas.reader import ReaderCursorSnapshot, ReaderResumeState


class OfflineReaderState(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )
    account_id: UUID
    reader_generation: int = Field(ge=1)
    cursor: ReaderCursorSnapshot


class OfflineReaderWrite(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=False,
        extra="forbid",
    )
    expected_reader_generation: int = Field(ge=1)
    base_revision: int = Field(ge=0)
    locator: ReaderResumeState
