"""A codepoint position in a reader's canonical unit."""

from pydantic import BaseModel, ConfigDict, Field


class ReaderPointOut(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)

    unit_id: str
    offset: int = Field(ge=0)
