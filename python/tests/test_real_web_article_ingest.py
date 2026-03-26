"""Real web article extraction smoke tests.

Exercises run_node_ingest against live URLs with no mocks.
Requires Node.js and node/ingest dependencies.
"""

import shutil

import pytest

from nexus.services.node_ingest import NODE_INGEST_SCRIPT, IngestResult, run_node_ingest

pytestmark = [
    pytest.mark.integration,
    pytest.mark.slow,
    pytest.mark.network,
]

ARTICLES = [
    {
        "url": "https://www.paulgraham.com/avg.html",
        "label": "Paul Graham - Beating the Averages",
        "min_content_length": 5000,
    },
    {
        "url": "https://poets.org/poem/memoriam-h-h",
        "label": "Poets.org - In Memoriam A. H. H.",
        "min_content_length": 5000,
    },
    {
        "url": "https://theshadowedarchive.substack.com/p/an-existential-guide-to-making-friends",
        "label": "Substack - Existential Guide",
        "min_content_length": 2000,
    },
    {
        "url": "https://www.infinityplus.co.uk/stories/colderwar.htm",
        "label": "Infinity Plus - A Colder War",
        "min_content_length": 5000,
    },
]


@pytest.fixture(autouse=True)
def _require_node_runtime():
    if not shutil.which("node"):
        pytest.skip("Node.js is not installed; install Node.js to run web extraction network tests.")
    if not NODE_INGEST_SCRIPT.exists():
        pytest.skip(
            f"Node ingest script not found at {NODE_INGEST_SCRIPT}; run from repo root checkout."
        )


class TestRealWebArticleExtraction:
    @pytest.mark.parametrize("article", ARTICLES, ids=[item["label"] for item in ARTICLES])
    def test_extraction(self, article: dict):
        result = run_node_ingest(article["url"])
        assert isinstance(result, IngestResult), (
            f"{article['label']}: expected IngestResult for {article['url']}, got {result}"
        )
        assert result.title and result.title.strip(), (
            f"{article['label']}: extracted title was empty for URL {article['url']}"
        )
        assert len(result.content_html) >= article["min_content_length"], (
            f"{article['label']}: expected content_html length >= {article['min_content_length']}, "
            f"got {len(result.content_html)}"
        )
        assert result.final_url and result.final_url.strip(), (
            f"{article['label']}: expected non-empty final_url, got '{result.final_url}'"
        )
