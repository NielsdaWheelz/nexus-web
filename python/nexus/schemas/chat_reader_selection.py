"""Reader-quote shapes: the durable key, the persisted snapshot, its projections."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from nexus.schemas.resource_items import ResourceActivationOut
from nexus.schemas.retrieval import MediaRetrievalLocator

MAX_READER_SELECTION_EXACT = 20_000
MAX_READER_SELECTION_AFFIX = 1_000
MAX_READER_SELECTION_SOURCE_LABEL = 1_000

ReaderSelectionRevision = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


class ReaderSelectionKey(BaseModel):
    media_id: UUID
    highlight_id: UUID

    model_config = ConfigDict(frozen=True, extra="forbid")


class ReaderSelectionSnapshot(BaseModel):
    """The immutable quote persisted on a user message. Activation is derived."""

    key: ReaderSelectionKey
    source_label: str = Field(min_length=1, max_length=MAX_READER_SELECTION_SOURCE_LABEL)
    exact: str = Field(min_length=1, max_length=MAX_READER_SELECTION_EXACT)
    prefix: str = Field(default="", max_length=MAX_READER_SELECTION_AFFIX)
    suffix: str = Field(default="", max_length=MAX_READER_SELECTION_AFFIX)
    locator: MediaRetrievalLocator

    model_config = ConfigDict(extra="forbid")


class ReaderSelectionOut(ReaderSelectionSnapshot):
    activation: ResourceActivationOut


class ReaderSelectionPreview(ReaderSelectionOut):
    revision: ReaderSelectionRevision


class ReaderSelectionInput(BaseModel):
    """The reader-selection piece of a chat-run request: key plus precondition."""

    key: ReaderSelectionKey
    revision: ReaderSelectionRevision

    model_config = ConfigDict(extra="forbid")
