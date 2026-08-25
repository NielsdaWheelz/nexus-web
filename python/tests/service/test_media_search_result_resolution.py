"""Priority proof for durable Media-domain search-result resolution."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaKind, Podcast, PodcastSubscription, ProcessingStatus
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.search import (
    SearchResultEpisodeOut,
    SearchResultMediaOut,
    SearchResultPodcastOut,
    SearchResultVideoOut,
)
from nexus.services import bootstrap, library_entries
from nexus.services.search.service import get_search_result


def test_media_and_podcast_results_reresolve_with_exact_type_and_visibility(
    engine: Engine,
) -> None:
    owner_id = uuid4()
    foreign_id = uuid4()
    with Session(engine, expire_on_commit=False) as db:
        bootstrap.ensure_user_and_default_library(
            db,
            owner_id,
            f"media-search-owner-{owner_id}@example.invalid",
        )
        bootstrap.ensure_user_and_default_library(
            db,
            foreign_id,
            f"media-search-foreign-{foreign_id}@example.invalid",
        )
        article = Media(
            kind=MediaKind.web_article,
            title="Durable media result",
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=owner_id,
        )
        episode = Media(
            kind=MediaKind.podcast_episode,
            title="Durable episode result",
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=owner_id,
        )
        video = Media(
            kind=MediaKind.video,
            title="Durable video result",
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=owner_id,
        )
        foreign_article = Media(
            kind=MediaKind.web_article,
            title="Foreign media result",
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=foreign_id,
        )
        podcast = Podcast(
            provider="test",
            provider_podcast_id=f"owner-{uuid4()}",
            title="Durable podcast result",
            feed_url=f"https://example.invalid/{uuid4()}.xml",
        )
        foreign_podcast = Podcast(
            provider="test",
            provider_podcast_id=f"foreign-{uuid4()}",
            title="Foreign podcast result",
            feed_url=f"https://example.invalid/{uuid4()}.xml",
        )
        db.add_all([article, episode, video, foreign_article, podcast, foreign_podcast])
        db.flush()
        for media_id, viewer_id in (
            (article.id, owner_id),
            (episode.id, owner_id),
            (video.id, owner_id),
            (foreign_article.id, foreign_id),
        ):
            assert library_entries.ensure_media_in_default_library(db, viewer_id, media_id)
        db.add_all(
            [
                PodcastSubscription(
                    id=uuid4(),
                    user_id=owner_id,
                    podcast_id=podcast.id,
                    next_sync_at=datetime.now(UTC),
                ),
                PodcastSubscription(
                    id=uuid4(),
                    user_id=foreign_id,
                    podcast_id=foreign_podcast.id,
                    next_sync_at=datetime.now(UTC),
                ),
            ]
        )
        db.commit()

        article_result = get_search_result(db, owner_id, "media", str(article.id))
        episode_result = get_search_result(db, owner_id, "episode", str(episode.id))
        video_result = get_search_result(db, owner_id, "video", str(video.id))
        podcast_result = get_search_result(db, owner_id, "podcast", str(podcast.id))

        assert isinstance(article_result, SearchResultMediaOut)
        assert article_result.id == article.id
        assert article_result.source.media_kind == MediaKind.web_article.value
        assert article_result.title == article.title
        assert isinstance(episode_result, SearchResultEpisodeOut)
        assert episode_result.id == episode.id
        assert episode_result.source.media_kind == MediaKind.podcast_episode.value
        assert isinstance(video_result, SearchResultVideoOut)
        assert video_result.id == video.id
        assert video_result.source.media_kind == MediaKind.video.value
        assert isinstance(podcast_result, SearchResultPodcastOut)
        assert podcast_result.id == podcast.id
        assert podcast_result.title == podcast.title
        assert podcast_result.contributors == []

        hidden_or_mistyped_refs = (
            (owner_id, "media", foreign_article.id),
            (owner_id, "podcast", foreign_podcast.id),
            (owner_id, "media", episode.id),
            (owner_id, "media", video.id),
            (owner_id, "episode", article.id),
            (owner_id, "video", article.id),
        )
        for viewer_id, result_type, result_id in hidden_or_mistyped_refs:
            with pytest.raises(NotFoundError) as denied:
                get_search_result(db, viewer_id, result_type, str(result_id))
            assert denied.value.code is ApiErrorCode.E_NOT_FOUND
