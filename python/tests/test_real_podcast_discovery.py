"""Real podcast discovery smoke tests.

Exercises PodcastIndexClient.search_podcasts against the live Podcast Index API.
Requires real Podcast Index credentials; skips when not configured.
"""

import os

import pytest

from nexus.services.podcasts import PodcastIndexClient

pytestmark = [
    pytest.mark.integration,
    pytest.mark.slow,
    pytest.mark.network,
]

PODCASTS = [
    {
        "query": "Dan Carlin Hardcore History",
        "label": "Hardcore History",
        "expected_title_contains": "hardcore history",
    },
    {
        "query": "Entitled Opinions Robert Harrison",
        "label": "Entitled Opinions",
        "expected_title_contains": "entitled opinions",
    },
    {
        "query": "The Bookening",
        "label": "The Bookening",
        "expected_title_contains": "bookening",
    },
]

_PLACEHOLDER_KEY = "test-podcast-index-key"


@pytest.fixture
def podcast_client() -> PodcastIndexClient:
    api_key = os.environ.get("PODCAST_INDEX_API_KEY", "")
    api_secret = os.environ.get("PODCAST_INDEX_API_SECRET", "")
    if not api_key or not api_secret or api_key == _PLACEHOLDER_KEY:
        pytest.skip(
            "Real Podcast Index credentials are not configured. "
            "Set PODCAST_INDEX_API_KEY and PODCAST_INDEX_API_SECRET."
        )
    return PodcastIndexClient(
        api_key=api_key,
        api_secret=api_secret,
        base_url="https://api.podcastindex.org/api/1.0",
    )


class TestRealPodcastDiscovery:
    @pytest.mark.parametrize("podcast", PODCASTS, ids=[item["label"] for item in PODCASTS])
    def test_search_returns_expected_podcasts(
        self, podcast_client: PodcastIndexClient, podcast: dict
    ):
        results = podcast_client.search_podcasts(podcast["query"], limit=10)

        assert len(results) > 0, (
            f"{podcast['label']}: expected at least one search result for "
            f"query '{podcast['query']}', got 0"
        )

        titles = [str(result.get("title") or "") for result in results]
        assert any(podcast["expected_title_contains"] in title.lower() for title in titles), (
            f"{podcast['label']}: expected at least one title containing "
            f"'{podcast['expected_title_contains']}', got titles={titles}"
        )

        for index, result in enumerate(results):
            assert result.get("provider_podcast_id"), (
                f"{podcast['label']}: result {index} missing provider_podcast_id: {result}"
            )
            assert result.get("title"), (
                f"{podcast['label']}: result {index} missing title: {result}"
            )
            assert result.get("feed_url"), (
                f"{podcast['label']}: result {index} missing feed_url: {result}"
            )
