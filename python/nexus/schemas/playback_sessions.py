"""Device queue wire contracts. Occurrences are identities, never media identities.

A null cursor is empty or exhausted. Provenance freezes the source view, not
playback authority; progress and descriptors remain consumption-owned.
"""

from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.collection_order import OrderRevision
from nexus.schemas.consumption import ListeningIn
from nexus.schemas.podcast import EpisodeSort, EpisodeState

LibrarySort = Literal[
    "title_asc",
    "title_desc",
    "creator_asc",
    "creator_desc",
    "published_asc",
    "published_desc",
    "remaining_asc",
    "remaining_desc",
    "added_asc",
    "added_desc",
]
LecternSort = Literal["added_asc", "added_desc", "title_asc", "title_desc"]
EntryType = Literal["web_article", "epub", "pdf", "video", "podcast_episode"]


class Closed(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class QueueEntry(Closed):
    id: UUID = Field(strict=False)
    media_id: UUID = Field(strict=False)


class LecternQueueSource(Closed):
    kind: Literal["Lectern"]
    label: str
    query: str
    sort: LecternSort | None


class LibraryQueueCapture(Closed):
    kind: Literal["Library"]
    library_id: UUID = Field(strict=False)
    query: str
    sort: LibrarySort | None
    entry_type: EntryType | None
    projection: Literal["unfiled", "in_progress"] | None
    completion: Literal["unfinished"] | None


class LibraryQueueSource(LibraryQueueCapture):
    label: str


class PodcastQueueCapture(Closed):
    kind: Literal["Podcast"]
    podcast_id: UUID = Field(strict=False)
    query: str
    state: EpisodeState
    sort: EpisodeSort


class PodcastQueueSource(PodcastQueueCapture):
    label: str


QueueSource = Annotated[
    LecternQueueSource | LibraryQueueSource | PodcastQueueSource, Field(discriminator="kind")
]


class QueueState(Closed):
    queue_id: UUID = Field(strict=False)
    entries: list[QueueEntry]
    current_entry_id: UUID | None = Field(strict=False)
    source: QueueSource | None

    @model_validator(mode="after")
    def valid_occurrences(self) -> Self:
        ids = {entry.id for entry in self.entries}
        if len(ids) != len(self.entries):
            raise ValueError("Queue occurrence ids must be unique")
        if self.current_entry_id is not None and self.current_entry_id not in ids:
            raise ValueError("Current occurrence must belong to queue")
        return self


class BrowserSessionOut(Closed):
    id: UUID = Field(strict=False)
    revision: OrderRevision
    state: QueueState


class TerminalEnd(Closed):
    ended_entry_id: UUID = Field(strict=False)
    terminal_listening: ListeningIn
    expected_override_revision: int | None = Field(ge=0, le=2_147_483_647)


class PutPlaybackSessionRequest(Closed):
    id: UUID = Field(strict=False)
    expected_revision: OrderRevision | None
    state: QueueState
    terminal: TerminalEnd | None


class PlaybackSnapshotRequest(Closed):
    source: Annotated[LibraryQueueCapture | PodcastQueueCapture, Field(discriminator="kind")]
    selected_media_id: UUID = Field(strict=False)


class PlaybackSnapshotOut(Closed):
    source: Annotated[LibraryQueueSource | PodcastQueueSource, Field(discriminator="kind")]
    media_ids: list[UUID]
