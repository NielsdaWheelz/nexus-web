"""Attention-ledger schemas: dwell blocks piggybacked on reader/listening saves."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class TextSpan(BaseModel):
    """A touched character-offset range in a text/reflowable document."""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["text"]
    start: int
    end: int


class PageSpan(BaseModel):
    """A touched page in a PDF document."""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["page"]
    page: int


SpanItem = Annotated[TextSpan | PageSpan, Field(discriminator="kind")]


class AttentionBlock(BaseModel):
    """Dwell delta + touched spans that piggyback a reader/listening save."""

    model_config = ConfigDict(extra="forbid")
    dwell_ms_delta: int = Field(ge=0)
    device_id: str = Field(max_length=128)
    spans_touched: list[SpanItem] = Field(default_factory=list)
    progression: float | None = Field(default=None, ge=0.0, le=1.0)
