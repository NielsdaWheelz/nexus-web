"""Owned schemas for the reader-highlight quote-to-chat contract.

`ReaderSelectionKey` is the one meaningful identity type across transport,
service, snapshot, and wire projection. `ReaderSelectionSnapshot` is the
immutable per-user-message quote captured at send; `ReaderSelectionOut` /
`ReaderSelectionPreview` are its read projections. `chat_reader_selection.py`
(the service) is the sole owner of snapshot creation, JSON encode/decode,
revision digest, and prompt rendering; these schemas are the shared shapes it
speaks. No JSON fallback, version metadata, or alternate spelling exists.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, TypeAdapter

from nexus.schemas.resource_items import ResourceActivationOut
from nexus.schemas.retrieval import MediaRetrievalLocator

# Exact/prefix/suffix reuse existing selection bounds; source_label is a new
# cutover-specific defensive bound for mandatory API/transcript/prompt data.
MAX_READER_SELECTION_EXACT = 20_000
MAX_READER_SELECTION_AFFIX = 1_000
MAX_READER_SELECTION_SOURCE_LABEL = 1_000

# A revision is a lowercase SHA-256 hex digest of the snapshot's canonical
# answer/display fields — a live compare-on-send precondition, never part of the
# idempotency identity.
ReaderSelectionRevision = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]

_REVISION_ADAPTER: TypeAdapter[str] = TypeAdapter(ReaderSelectionRevision)


def parse_reader_selection_revision(value: str) -> str:
    """Validate a wire/trusted revision digest; raises on a noncanonical value."""
    return _REVISION_ADAPTER.validate_python(value)


class ReaderSelectionKey(BaseModel):
    """The durable identity of a reader quote: (media, highlight)."""

    media_id: UUID
    highlight_id: UUID

    model_config = ConfigDict(frozen=True, extra="forbid")


class ReaderSelectionSnapshot(BaseModel):
    """The immutable server-canonical quote stored on a user message.

    Snapshot fields never change after commit. Activation is NOT stored — it is
    recomputed from ``locator`` + current source visibility at projection time.
    """

    key: ReaderSelectionKey
    source_label: str = Field(min_length=1, max_length=MAX_READER_SELECTION_SOURCE_LABEL)
    exact: str = Field(min_length=1, max_length=MAX_READER_SELECTION_EXACT)
    prefix: str = Field(default="", max_length=MAX_READER_SELECTION_AFFIX)
    suffix: str = Field(default="", max_length=MAX_READER_SELECTION_AFFIX)
    locator: MediaRetrievalLocator

    model_config = ConfigDict(extra="forbid")


class ReaderSelectionOut(BaseModel):
    """Message-wire projection of a quoted user turn.

    Present only on a quoted user message. Snapshot fields are immutable;
    ``activation`` is recomputed from the immutable locator and current source
    visibility and may be ``kind="none"``.
    """

    key: ReaderSelectionKey
    source_label: str = Field(min_length=1, max_length=MAX_READER_SELECTION_SOURCE_LABEL)
    exact: str = Field(min_length=1, max_length=MAX_READER_SELECTION_EXACT)
    prefix: str = Field(default="", max_length=MAX_READER_SELECTION_AFFIX)
    suffix: str = Field(default="", max_length=MAX_READER_SELECTION_AFFIX)
    locator: MediaRetrievalLocator
    activation: ResourceActivationOut

    model_config = ConfigDict(extra="forbid")


class ReaderSelectionPreview(BaseModel):
    """Pending-card projection returned by the reader-selection preview endpoint.

    Identical to ``ReaderSelectionOut`` plus the ``revision`` precondition digest
    the composer replays on send.
    """

    key: ReaderSelectionKey
    source_label: str = Field(min_length=1, max_length=MAX_READER_SELECTION_SOURCE_LABEL)
    exact: str = Field(min_length=1, max_length=MAX_READER_SELECTION_EXACT)
    prefix: str = Field(default="", max_length=MAX_READER_SELECTION_AFFIX)
    suffix: str = Field(default="", max_length=MAX_READER_SELECTION_AFFIX)
    locator: MediaRetrievalLocator
    activation: ResourceActivationOut
    revision: ReaderSelectionRevision

    model_config = ConfigDict(extra="forbid")


class ReaderSelectionInput(BaseModel):
    """The reader-selection piece of a ``POST /chat-runs`` request.

    Carries only the durable key and the compare-on-send revision precondition;
    the server derives exact/prefix/suffix/source/locator from the locked
    Highlight. Client quote text is never accepted.
    """

    key: ReaderSelectionKey
    revision: ReaderSelectionRevision

    model_config = ConfigDict(extra="forbid")
