"""Production-shaped provider adapter proof over exact external fixtures."""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest
import respx
from web_search_tool.types import (
    WebSearchRequest,
    WebSearchResponse,
    WebSearchResultItem,
)

from nexus.config import clear_settings_cache, get_settings
from nexus.schemas.browse import PreviewResolution
from nexus.services.browse import brave, podcast_index, youtube
from nexus.services.browse.models import (
    BraveWebArticleTarget,
    BrowseKind,
    BrowseProviderFailure,
    BrowseQuery,
    BrowseSectionFailureKind,
    BrowseSource,
    BrowseTargetNotFound,
    PodcastIndexPodcastTarget,
    YouTubeVideoTarget,
    unseal_target,
)

pytestmark = pytest.mark.integration


def _query(kind: BrowseKind, source: BrowseSource) -> BrowseQuery:
    return BrowseQuery(
        query="systems",
        kind=kind,
        source=source,
        sort=None,
        limit=10,
        cursor=None,
    )


class _BraveFixture:
    def __init__(self) -> None:
        self.requests: list[WebSearchRequest] = []

    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        self.requests.append(request)
        return WebSearchResponse(
            results=(
                WebSearchResultItem(
                    result_ref="brave:fixture:1",
                    title="Systems Article",
                    url="https://example.com/systems",
                    display_url="example.com/systems",
                    snippet="Exact fixture",
                    extra_snippets=(),
                    published_at=None,
                    source_name="Example",
                    rank=1,
                    provider="brave",
                    provider_request_id="fixture-request",
                ),
            ),
            provider="brave",
            provider_request_id="fixture-request",
        )


@pytest.mark.asyncio
async def test_brave_search_projects_one_exact_stable_target() -> None:
    items, next_cursor = await brave.search(
        _BraveFixture(),
        query=_query(BrowseKind.WebArticle, BrowseSource.Brave),
    )
    assert next_cursor is None
    assert len(items) == 1
    item = items[0]
    assert item.title == "Systems Article"
    assert isinstance(item.resolution, PreviewResolution)
    target = unseal_target(item.resolution.target)
    assert isinstance(target, BraveWebArticleTarget)
    assert target.canonical_url == "https://example.com/systems"


@pytest.mark.asyncio
async def test_brave_search_preserves_the_one_code_point_browse_query() -> None:
    provider = _BraveFixture()
    query = BrowseQuery(
        query="x",
        kind=BrowseKind.WebArticle,
        source=BrowseSource.Brave,
        sort=None,
        limit=10,
        cursor=None,
    )

    await brave.search(provider, query=query)

    assert provider.requests[0].query == "x"


@respx.mock
def test_youtube_search_and_preview_parse_exact_data_api_fixtures() -> None:
    base = get_settings().youtube_data_base_url.rstrip("/")
    video_ref = "dQw4w9WgXcQ"
    respx.get(f"{base}/search").respond(
        200,
        json={
            "kind": "youtube#searchListResponse",
            "etag": "search-etag",
            "nextPageToken": "page-two",
            "regionCode": "US",
            "pageInfo": {"totalResults": 1, "resultsPerPage": 1},
            "items": [
                {
                    "kind": "youtube#searchResult",
                    "etag": "item-etag",
                    "id": {
                        "kind": "youtube#video",
                        "videoId": video_ref,
                    },
                    "snippet": {
                        "publishedAt": "2026-07-01T12:00:00Z",
                        "channelId": "channel-1",
                        "title": "Systems Video",
                        "description": "Fixture video",
                        "thumbnails": {
                            "high": {
                                "url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
                                "width": 480,
                                "height": 360,
                            }
                        },
                        "channelTitle": "Systems Channel",
                        "liveBroadcastContent": "none",
                        "publishTime": "2026-07-01T12:00:00Z",
                    },
                }
            ],
        },
    )
    respx.get(f"{base}/videos").respond(
        200,
        json={
            "kind": "youtube#videoListResponse",
            "etag": "video-etag",
            "pageInfo": {"totalResults": 1, "resultsPerPage": 1},
            "items": [
                {
                    "kind": "youtube#video",
                    "etag": "item-etag",
                    "id": video_ref,
                    "snippet": {
                        "publishedAt": "2026-07-01T12:00:00Z",
                        "channelId": "channel-1",
                        "title": "Systems Video",
                        "description": "Fixture video",
                        "thumbnails": {
                            "high": {
                                "url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
                                "width": 480,
                                "height": 360,
                            }
                        },
                        "channelTitle": "Systems Channel",
                        "liveBroadcastContent": "none",
                    },
                    "contentDetails": {
                        "duration": "PT1H2M3S",
                        "dimension": "2d",
                        "definition": "hd",
                        "caption": "true",
                        "licensedContent": True,
                        "contentRating": {},
                        "projection": "rectangular",
                    },
                }
            ],
        },
    )

    items, cursor = youtube.search(
        viewer_id=uuid4(),
        query=_query(BrowseKind.Video, BrowseSource.YouTube),
    )
    assert cursor is not None
    assert len(items) == 1
    item = items[0]
    assert item.image.kind == "Present"
    assert item.image.value.startswith("/api/media/image?url=")
    assert isinstance(item.resolution, PreviewResolution)
    target = unseal_target(item.resolution.target)
    assert isinstance(target, YouTubeVideoTarget)
    assert target.video_ref == video_ref

    video = youtube.preview(video_ref)
    assert video.title == "Systems Video"
    assert video.duration_seconds == 3_723
    assert video.embed_href == f"https://www.youtube.com/embed/{video_ref}"
    assert video.image_href is not None
    assert video.image_href.startswith("/api/media/image?url=")


def test_youtube_real_media_fixture_supports_browse_preview(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("REAL_MEDIA_PROVIDER_FIXTURES", "true")
    monkeypatch.setenv(
        "REAL_MEDIA_FIXTURE_DIR",
        str(Path(__file__).parent / "fixtures" / "real_media"),
    )
    clear_settings_cache()
    try:
        items, next_cursor = youtube.search(
            viewer_id=uuid4(),
            query=BrowseQuery(
                query="Picturing Earth",
                kind=BrowseKind.Video,
                source=BrowseSource.YouTube,
                sort=None,
                limit=10,
                cursor=None,
            ),
        )
        assert next_cursor is None
        assert [item.title for item in items] == ["Picturing Earth: Behind the Scenes"]
        target = unseal_target(items[0].resolution.target)
        assert isinstance(target, YouTubeVideoTarget)

        preview = youtube.preview(target.video_ref)
        assert preview.embed_href == "https://www.youtube.com/embed/drrP_Iss0gA"
    finally:
        clear_settings_cache()


@respx.mock
def test_youtube_rate_limit_is_soft_but_schema_drift_is_a_defect() -> None:
    base = get_settings().youtube_data_base_url.rstrip("/")
    route = respx.get(f"{base}/search").respond(
        429,
        json={"error": {"code": 429}},
        headers={"Retry-After": "0"},
    )

    with pytest.raises(BrowseProviderFailure) as soft:
        youtube.search(
            viewer_id=uuid4(),
            query=_query(BrowseKind.Video, BrowseSource.YouTube),
        )
    assert soft.value.kind is BrowseSectionFailureKind.RateLimited
    assert route.call_count == 3

    route.respond(
        200,
        json={
            "kind": "youtube#searchListResponse",
            "etag": "schema-drift",
            "items": [],
        },
    )
    with pytest.raises(RuntimeError, match="schema drift"):
        youtube.search(
            viewer_id=uuid4(),
            query=_query(BrowseKind.Video, BrowseSource.YouTube),
        )


@respx.mock
def test_podcast_index_search_and_resolution_parse_exact_provider_fixtures() -> None:
    base = get_settings().podcast_index_base_url.rstrip("/")
    feed = {
        "id": 75075,
        "title": "Systems Podcast",
        "url": "https://example.com/feed.xml",
        "author": "Ada Host",
        "link": "https://example.com/podcast",
        "image": "https://example.com/podcast.jpg",
        "description": "Fixture podcast",
    }
    respx.get(f"{base}/search/byterm").respond(
        200,
        json={"status": "true", "feeds": [feed], "count": 1},
    )
    respx.get(f"{base}/podcasts/byfeedid").respond(
        200,
        json={"status": "true", "feed": feed},
    )
    respx.get(f"{base}/episodes/byid").respond(
        200,
        json={
            "status": "true",
            "episode": {
                "id": 99001,
                "feedId": 75075,
                "title": "Systems Episode",
                "description": "Fixture episode",
                "enclosureUrl": "https://cdn.example.com/episode.mp3",
                "guid": "episode-guid",
                "datePublished": 1_720_000_000,
                "duration": 1800,
            },
        },
    )
    respx.get(f"{base}/episodes/byfeedid").respond(
        200,
        json={
            "status": "true",
            "items": [
                {
                    "id": 99002,
                    "feedId": 75075,
                    "title": "HTTPS Episode",
                    "enclosureUrl": "https://cdn.example.com/secure.mp3",
                    "datePublished": 1_720_000_001,
                },
                {
                    "id": 99003,
                    "feedId": 75075,
                    "title": "HTTP Episode",
                    "enclosureUrl": "http://cdn.example.com/insecure.mp3",
                    "datePublished": 1_720_000_002,
                },
            ],
        },
    )

    items, next_cursor = podcast_index.search(
        viewer_id=uuid4(),
        query=_query(BrowseKind.Podcast, BrowseSource.PodcastIndex),
    )
    assert next_cursor is None
    assert len(items) == 1
    item = items[0]
    assert item.image.kind == "Present"
    assert item.image.value.startswith("/api/media/image?url=")
    assert isinstance(item.resolution, PreviewResolution)
    target = unseal_target(item.resolution.target)
    assert isinstance(target, PodcastIndexPodcastTarget)
    assert target.podcast_ref == "75075"

    episode = podcast_index.resolve_episode(
        podcast_ref="75075",
        episode_ref="99001",
    )
    assert episode.episode_ref == "99001"
    assert episode.guid == "episode-guid"
    assert episode.audio_url == "https://cdn.example.com/episode.mp3"
    assert episode.podcast.feed_url == "https://example.com/feed.xml"
    episode_items, _ = podcast_index.episode_page(
        viewer_id=uuid4(),
        target=item.resolution.target,
        podcast=episode.podcast,
        limit=10,
        cursor=None,
    )
    assert [candidate.title for candidate in episode_items] == ["HTTPS Episode"]


@respx.mock
def test_podcast_index_explicit_missing_stable_ref_is_terminal() -> None:
    base = get_settings().podcast_index_base_url.rstrip("/")
    respx.get(f"{base}/podcasts/byfeedid").respond(
        200,
        json={
            "status": "true",
            "feed": {
                "id": 75075,
                "title": "Systems Podcast",
                "url": "https://example.com/feed.xml",
            },
        },
    )
    respx.get(f"{base}/episodes/byid").respond(404, json={"status": "false"})

    with pytest.raises(BrowseTargetNotFound):
        podcast_index.resolve_episode(
            podcast_ref="75075",
            episode_ref="missing-episode",
        )
