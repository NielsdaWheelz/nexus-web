"""One complete account catalog: immutable display facts and canonical order ordinals.

Nested command capabilities and revisions are historical metadata, never authority.
The export validates identity, reference closure, total orders and episode counts
before publication. No body, downloaded asset or offline write is represented.
"""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.db.models import TranscriptState
from nexus.schemas.collection_order import OrderRevision
from nexus.schemas.consumption import EpisodeConsumptionState, LecternOut
from nexus.schemas.conversation import ConversationListItemOut
from nexus.schemas.library import LibraryOut
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.notes import NotePageSummaryOut
from nexus.schemas.podcast import LibraryPodcastsOut, PodcastDetailOut

Rank = Annotated[int, Field(strict=True, ge=1, le=9_007_199_254_740_991)]


class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LibraryIndexOrder(_Closed):
    default: Rank
    created_desc: Rank
    name_asc: Rank
    name_desc: Rank


class MediaOrder(_Closed):
    title_asc: Rank
    title_desc: Rank
    creator_asc: Rank
    creator_desc: Rank
    published_asc: Rank
    published_desc: Rank
    remaining_asc: Rank
    remaining_desc: Rank


class LibraryEntryOrder(_Closed):
    default: Rank
    added_asc: Rank
    added_desc: Rank


class PodcastIndexOrder(_Closed):
    recent_episode: Rank
    unplayed_count: Rank
    alpha: Rank


class EpisodeOrder(_Closed):
    newest: Rank
    oldest: Rank
    duration_asc: Rank
    duration_desc: Rank


class UpdatedTitleOrder(_Closed):
    updated_newest: Rank
    updated_oldest: Rank
    title_asc: Rank
    title_desc: Rank


class CatalogLibraryOut(_Closed):
    value: LibraryOut
    order: LibraryIndexOrder


class CatalogMediaOut(_Closed):
    summary: MediaSummaryOut
    is_unfiled: bool
    remaining_seconds: float | None
    order: MediaOrder


class CatalogLibraryMediaOut(_Closed):
    library_id: UUID
    media_id: UUID
    entry_id: UUID | None
    added_at: datetime
    order: LibraryEntryOrder


class CatalogPodcastIndexOut(_Closed):
    has_new: bool
    not_in_library: bool
    order: PodcastIndexOrder


class CatalogShowOut(_Closed):
    detail: PodcastDetailOut
    index: CatalogPodcastIndexOut | None


class CatalogLibraryShowsOut(_Closed):
    library_id: UUID
    value: LibraryPodcastsOut


class CatalogEpisodeOut(_Closed):
    media_id: UUID
    podcast_id: UUID
    transcript_state: TranscriptState
    episode_state: Literal["unplayed", "in_progress", "played"]
    consumption: EpisodeConsumptionState
    source_duration_ms: int | None
    order: EpisodeOrder


class CatalogNoteOut(_Closed):
    value: NotePageSummaryOut
    order: UpdatedTitleOrder


class CatalogChatOut(_Closed):
    value: ConversationListItemOut
    order: UpdatedTitleOrder


def _unique(values: list[object]) -> None:
    if len(set(values)) != len(values):
        raise ValueError("duplicate catalog identity")


def _orders(values: list[BaseModel]) -> None:
    if not values:
        return
    expected = set(range(1, len(values) + 1))
    for name in type(values[0]).model_fields:
        if {getattr(value, name) for value in values} != expected:
            raise ValueError(f"incomplete catalog order: {name}")


class OfflineCatalogOut(_Closed):
    format_version: Literal[2]
    wire_revision: int
    account_id: UUID
    snapshot_id: UUID
    captured_at: datetime
    consumption_revision: OrderRevision
    libraries: list[CatalogLibraryOut]
    media: list[CatalogMediaOut]
    library_media: list[CatalogLibraryMediaOut]
    shows: list[CatalogShowOut]
    library_shows: list[CatalogLibraryShowsOut]
    episodes: list[CatalogEpisodeOut]
    lectern: LecternOut
    notes: list[CatalogNoteOut]
    chats: list[CatalogChatOut]

    @model_validator(mode="after")
    def complete(self) -> "OfflineCatalogOut":
        libraries = {row.value.id for row in self.libraries}
        media = {row.summary.media_id: row.summary for row in self.media}
        shows = {row.detail.podcast.id: row.detail for row in self.shows}
        _unique([row.value.id for row in self.libraries])
        _unique([row.summary.media_id for row in self.media])
        _unique([row.detail.podcast.id for row in self.shows])
        _unique([(row.library_id, row.media_id) for row in self.library_media])
        _unique([row.library_id for row in self.library_shows])
        _unique([row.media_id for row in self.episodes])
        _unique([row.media_summary.media_id for row in self.lectern.items])
        _unique([row.value.id for row in self.notes])
        _unique([row.value.id for row in self.chats])
        _orders([row.order for row in self.libraries])
        _orders([row.order for row in self.media])
        _orders([row.index.order for row in self.shows if row.index is not None])
        _orders([row.order for row in self.episodes])
        _orders([row.order for row in self.notes])
        _orders([row.order for row in self.chats])
        if {row.library_id for row in self.library_shows} != libraries:
            raise ValueError("catalog library sections are incomplete")
        for library_id in libraries:
            _orders([row.order for row in self.library_media if row.library_id == library_id])
        for row in self.library_media:
            if row.library_id not in libraries or row.media_id not in media:
                raise ValueError("catalog library entry reference is missing")
        for row in self.episodes:
            if row.media_id not in media or row.podcast_id not in shows:
                raise ValueError("catalog episode reference is missing")
        for row in self.lectern.items:
            if media.get(row.media_summary.media_id) != row.media_summary:
                raise ValueError("catalog lectern summary differs")
        for show_id, detail in shows.items():
            episodes = [row for row in self.episodes if row.podcast_id == show_id]
            if detail.episode_counts.available_count != len(episodes) or (
                detail.episode_counts.unfinished_count
                != sum(row.episode_state != "played" for row in episodes)
            ):
                raise ValueError("catalog episode counts differ")
            if any(row.library_id not in libraries for row in detail.destinations):
                raise ValueError("catalog show destination is missing")
            if any(row.library_id not in libraries for row in detail.imports):
                raise ValueError("catalog show import destination is missing")
        for section in self.library_shows:
            for row in section.value.subscriptions:
                if row.podcast.id not in shows or row.podcast != shows[row.podcast.id].podcast:
                    raise ValueError("catalog library show differs")
                if any(destination.library_id not in libraries for destination in row.destinations):
                    raise ValueError("catalog library show destination is missing")
                if any(operation.podcast_id not in shows for operation in row.imports):
                    raise ValueError("catalog library show import is missing")
            if any(row.podcast_id not in shows for row in section.value.imports):
                raise ValueError("catalog library import show is missing")
        return self
