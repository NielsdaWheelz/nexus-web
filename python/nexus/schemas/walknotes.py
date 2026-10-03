"""walknote transcription output."""

from pydantic import BaseModel, Field


class WalknoteTranscriptionOut(BaseModel):
    transcript: str
    duration_ms: int | None = Field(ge=0)
