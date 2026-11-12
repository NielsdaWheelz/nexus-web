"""One complete account catalog: immutable display facts and canonical order ordinals.

Nested command capabilities and revisions are historical metadata, never authority.
The export validates identity, reference closure, total orders and entry counts
before publication. No body, downloaded asset or offline write is represented.
"""

from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.db.models import TranscriptState
from nexus.schemas.collection_order import OrderRevision
from nexus.schemas.consumption import EpisodeConsumptionState, LecternOut
from nexus.schemas.feed import FeedDetailOut, LibraryFeedsOut
from nexus.schemas.library import LibraryOut
from nexus.schemas.media_summary import MediaSummaryOut

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


class FeedIndexOrder(_Closed):
    recent_entry: Rank
    unfinished_count: Rank
    alpha: Rank


class EpisodeOrder(_Closed):
    newest: Rank
    oldest: Rank
    duration_asc: Rank
    duration_desc: Rank


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


class CatalogFeedIndexOut(_Closed):
    has_new: bool
    not_in_library: bool
    order: FeedIndexOrder


class CatalogSourceOut(_Closed):
    detail: FeedDetailOut
    index: CatalogFeedIndexOut | None


class CatalogLibrarySourcesOut(_Closed):
    library_id: UUID
    value: LibraryFeedsOut


class CatalogEntryOut(_Closed):
    media_id: UUID
    feed_id: UUID
    entry_id: UUID
    published_at: datetime | None
    published_on: date | None
    entry_url: str | None
    entry_state: Literal["unread", "in_progress", "finished"]
    order: EpisodeOrder


class CatalogEpisodeOut(CatalogEntryOut):
    transcript_state: TranscriptState
    episode_state: Literal["unplayed", "in_progress", "played"]
    consumption: EpisodeConsumptionState
    source_duration_ms: int | None


class CatalogArticleOut(CatalogEntryOut):
    transcript_state: None


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
    format_version: Literal[5]
    wire_revision: int
    account_id: UUID
    snapshot_id: UUID
    captured_at: datetime
    consumption_revision: OrderRevision
    libraries: list[CatalogLibraryOut]
    media: list[CatalogMediaOut]
    library_media: list[CatalogLibraryMediaOut]
    sources: list[CatalogSourceOut]
    library_sources: list[CatalogLibrarySourcesOut]
    episodes: list[CatalogEpisodeOut]
    articles: list[CatalogArticleOut]
    lectern: LecternOut

    @model_validator(mode="after")
    def complete(self) -> "OfflineCatalogOut":
        libraries = {row.value.id for row in self.libraries}
        media = {row.summary.media_id: row.summary for row in self.media}
        shows = {row.detail.feed.id: row.detail for row in self.sources}
        _unique([row.value.id for row in self.libraries])
        _unique([row.summary.media_id for row in self.media])
        _unique([row.detail.feed.id for row in self.sources])
        _unique([(row.library_id, row.media_id) for row in self.library_media])
        _unique([row.library_id for row in self.library_sources])
        _unique([row.media_id for row in self.episodes])
        _unique([(row.feed_id, row.media_id) for row in self.articles])
        _unique([row.media_summary.media_id for row in self.lectern.items])
        _orders([row.order for row in self.libraries])
        _orders([row.order for row in self.media])
        _orders([row.index.order for row in self.sources if row.index is not None])
        entries = [*self.episodes, *self.articles]
        _orders([row.order for row in entries])
        if {row.library_id for row in self.library_sources} != libraries:
            raise ValueError("catalog library sections are incomplete")
        for library_id in libraries:
            _orders([row.order for row in self.library_media if row.library_id == library_id])
        for row in self.library_media:
            if row.library_id not in libraries or row.media_id not in media:
                raise ValueError("catalog library entry reference is missing")
        for row in entries:
            if row.media_id not in media or row.feed_id not in shows:
                raise ValueError("catalog episode reference is missing")
        if any(shows[row.feed_id].feed.kind != "podcast" for row in self.episodes) or any(
            shows[row.feed_id].feed.kind != "article" for row in self.articles
        ):
            raise ValueError("catalog source kind differs")
        for row in self.lectern.items:
            if media.get(row.media_summary.media_id) != row.media_summary:
                raise ValueError("catalog lectern summary differs")
        for show_id, detail in shows.items():
            episodes = [row for row in entries if row.feed_id == show_id]
            if detail.entry_counts.known_count != len(episodes) or (
                detail.entry_counts.unfinished_count
                != sum(row.entry_state != "finished" for row in episodes)
            ):
                raise ValueError("catalog episode counts differ")
            if any(row.library_id not in libraries for row in detail.destinations):
                raise ValueError("catalog show destination is missing")
            if any(row.library_id not in libraries for row in detail.imports):
                raise ValueError("catalog show import destination is missing")
        for section in self.library_sources:
            for row in section.value.subscriptions:
                if row.feed.id not in shows or row.feed != shows[row.feed.id].feed:
                    raise ValueError("catalog library show differs")
                if any(destination.library_id not in libraries for destination in row.destinations):
                    raise ValueError("catalog library show destination is missing")
                if any(operation.feed_id not in shows for operation in row.imports):
                    raise ValueError("catalog library show import is missing")
            if any(row.feed_id not in shows for row in section.value.imports):
                raise ValueError("catalog library import show is missing")
        return self
