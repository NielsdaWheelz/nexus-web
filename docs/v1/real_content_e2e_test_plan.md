# Real Content E2E Test Plan

## Goal

Add backend integration tests that exercise every ingestion pipeline against real content — real PDFs, real URLs, real transcripts, real podcast feeds. No mocks, no synthetic data, no generated fixtures. These tests prove the extraction layer works against the kind of content users actually submit.

## Why

The existing test suite is solid but synthetic. PDFs are built with PyMuPDF. Web articles come from a local HTTP server. YouTube transcripts are monkeypatched dicts. Podcast feeds are mocked httpx responses. This means:

- A parser regression against real-world HTML (malformed tags, paywalls, cookie banners) goes undetected.
- A PyMuPDF update that breaks multi-column PDF extraction goes undetected.
- A youtube_transcript_api breaking change goes undetected.
- A Podcast Index API contract change goes undetected.

Real content tests are the cheapest way to catch these. They run against the actual extraction boundary with zero mocking.

## Scope

Four new test files, one per content type:

| File | Content Type | Network? | DB? | What It Tests |
|------|-------------|----------|-----|---------------|
| `test_real_pdf_ingest.py` | PDF | No | Yes | `extract_pdf_artifacts` with real academic papers |
| `test_real_web_article_ingest.py` | Web Article | Yes | No | `run_node_ingest` with real URLs |
| `test_real_youtube_ingest.py` | YouTube | Yes | No | `fetch_youtube_transcript` with real video IDs |
| `test_real_podcast_discovery.py` | Podcast | Yes | No | `search_podcasts` with real queries |

Plus: one new pytest marker (`network`), three real PDF fixtures, and a Makefile target.

## Non-Goals

- Do not rewrite or refactor existing ingest tests.
- Do not add Playwright/browser e2e tests in this PR (that's a follow-up).
- Do not test the full pipeline (API → queue → worker → extraction). These tests call extraction functions directly.
- Do not test error/retry paths with real content. Existing synthetic tests already cover those.
- Do not add mocks or VCR cassettes. These tests hit real services every run.

## Architecture

### Test Layer Placement

Per `docs/sdlc/testing_standards.md`, these are **Tier 3 (Integration)** tests for PDF (DB-backed extraction) and a new informal sub-tier for the network tests (extraction boundary tests that hit real external services).

```
Tier 3: Integration (existing)
├── DB-backed service tests (existing)
├── API endpoint tests (existing)
└── Real content extraction tests (NEW)  ← this PR
    ├── PDF: DB + local files, no network
    ├── Web article: no DB, hits network
    ├── YouTube: no DB, hits network
    └── Podcast: no DB, hits network
```

### Marker Strategy

Current markers: `unit`, `integration`, `slow`, `supabase`.

Add: `network` — tests that require internet access.

Default exclusion in `pyproject.toml`:

```toml
addopts = "-v --tb=short -m \"not supabase and not network\""
```

This means `make test-back` skips network tests by default, same as supabase tests. To run them:

```bash
cd python && uv run pytest -m network -v          # network tests only
cd python && uv run pytest -m "slow" -v            # all slow tests (includes network)
```

A new Makefile target should also be added:

```makefile
test-back-network:    ## Run real-content network tests
	cd python && uv run pytest -m network -v
```

### Marker Assignment Per File

| File | Markers |
|------|---------|
| `test_real_pdf_ingest.py` | `integration`, `slow` |
| `test_real_web_article_ingest.py` | `integration`, `slow`, `network` |
| `test_real_youtube_ingest.py` | `integration`, `slow`, `network` |
| `test_real_podcast_discovery.py` | `integration`, `slow`, `network` |

Note: web article / YouTube / podcast tests use `integration` even though they don't touch DB, because they test an external boundary with real I/O — they are not pure logic (`unit`).

### Extraction Functions Under Test

Each test calls the lowest-level extraction function directly. No task wrappers, no lifecycle orchestration, no queue. This isolates extraction from infrastructure.

| Content Type | Function | Module | Signature |
|---|---|---|---|
| PDF | `extract_pdf_artifacts` | `nexus.services.pdf_ingest` | `(db: Session, media_id: UUID, storage_client) → PdfExtractionResult \| PdfExtractionError` |
| Web Article | `run_node_ingest` | `nexus.services.node_ingest` | `(url: str, timeout_ms?, subprocess_timeout_s?) → IngestResult \| IngestError` |
| YouTube | `fetch_youtube_transcript` | `nexus.services.youtube_transcripts` | `(provider_video_id: str) → dict` |
| Podcast | `PodcastIndexClient.search_podcasts` | `nexus.services.podcasts` | `(query: str, limit: int) → list[dict]` |

## Content Inventory

### PDFs (local fixtures, checked into repo)

Source: `content/` directory → copy to `python/tests/fixtures/pdf/`.

| File | Paper | Expected Properties |
|------|-------|-------------------|
| `attention.pdf` | "Attention Is All You Need" (Vaswani et al., 2017) | ~15 pages, has text, multi-author, has title in metadata |
| `diffusion.pdf` | Diffusion models paper | Has text, multiple pages, academic format |
| `svms.pdf` | Support vector machines paper | Has text, multiple pages, academic format |

These are small (<5MB each), public academic papers. Safe to commit.

### Web Articles (URLs, hit at test time)

| URL | Why This URL |
|-----|-------------|
| `https://www.paulgraham.com/avg.html` | Stable, long-lived, clean HTML, well-known. Tests basic article extraction. |
| `https://poets.org/poem/memoriam-h-h` | Long public-domain poem page with stable static markup. Tests non-article extraction quality. |
| `https://theshadowedarchive.substack.com/p/an-existential-guide-to-making-friends` | Substack. Tests extraction from a common blogging platform. |
| `https://www.infinityplus.co.uk/stories/colderwar.htm` | Old-school HTML, long-form fiction. Tests extraction from minimal markup. |

### YouTube Videos (IDs, hit at test time)

| URL | Video ID |
|-----|----------|
| `https://www.youtube.com/watch?v=VMj-3S1tku0` | `VMj-3S1tku0` |
| `https://www.youtube.com/watch?v=pdN-BjDx1_0` | `pdN-BjDx1_0` |
| `https://www.youtube.com/watch?v=_b9tKsBau9U` | `_b9tKsBau9U` |

All should have auto-generated or manual captions/subtitles. If transcript retrieval is blocked by provider/network policy, tests should assert `E_TRANSCRIPT_UNAVAILABLE` and skip transcript-shape assertions for that video.

### Podcasts (names, searched via Podcast Index API)

| Query | Expected Match |
|-------|---------------|
| `Hardcore History` | Dan Carlin's Hardcore History |
| `Entitled Opinions` | Entitled Opinions (Robert Harrison) |
| `The Bookening` | The Bookening |

Podcast tests require real `PODCAST_INDEX_API_KEY` and `PODCAST_INDEX_API_SECRET`. If not configured (or set to the test placeholder `test-podcast-index-key`), tests must `pytest.skip()` with a clear message.

## File-by-File Specification

### 1. `python/tests/test_real_pdf_ingest.py`

**Purpose:** Prove `extract_pdf_artifacts` works on real academic PDFs.

**Pattern:** Follows `test_epub_ingest_real_fixtures.py` exactly.

**Setup per test:**
1. Read PDF bytes from `python/tests/fixtures/pdf/{filename}`.
2. Create `media` row (kind=pdf, status=extracting) + `media_file` row via SQL.
3. Put bytes in `FakeStorageClient`.
4. Call `extract_pdf_artifacts(db_session, media_id, storage)`.

**Assertions (per paper):**
- Result is `PdfExtractionResult` (not `PdfExtractionError`). Include the error in the assertion message on failure.
- `result.page_count >= min_pages` (set a conservative floor per paper).
- `result.has_text is True`.
- `len(result.plain_text) > min_text_length` (e.g., 5000 chars for a real paper).
- `result.plain_text` contains no normalization violations: no `\r`, no `\f`, no `\u00a0`, no double spaces.
- DB: `pdf_page_text_spans` rows exist, one per page, ordered, contiguous.
- DB: `media.page_count` and `media.plain_text` are populated.

**Structure:**

```python
"""Real PDF extraction smoke tests.

Exercises extract_pdf_artifacts on checked-in academic papers with no
mocks. Complements synthetic builders in test_pdf_ingest.py with
parser-fidelity coverage on real-world documents.
"""

from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Media
from nexus.services.pdf_ingest import PdfExtractionResult, extract_pdf_artifacts
from nexus.storage.client import FakeStorageClient

pytestmark = [pytest.mark.integration, pytest.mark.slow]

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "pdf"

CORPUS = [
    {
        "file": "attention.pdf",
        "label": "Attention Is All You Need",
        "min_pages": 10,
        "min_text_length": 5000,
    },
    {
        "file": "diffusion.pdf",
        "label": "Diffusion models paper",
        "min_pages": 5,
        "min_text_length": 3000,
    },
    {
        "file": "svms.pdf",
        "label": "SVMs paper",
        "min_pages": 5,
        "min_text_length": 3000,
    },
]


def _create_pdf_media(db, storage, pdf_bytes):
    """Insert media + media_file rows and stage bytes in fake storage."""
    media_id = uuid4()
    user_id = uuid4()
    db.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    db.execute(
        text("""
            INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
            VALUES (:id, 'pdf', 'Test PDF', 'extracting', :uid)
        """),
        {"id": media_id, "uid": user_id},
    )
    storage_path = f"media/{media_id}/original.pdf"
    db.execute(
        text("""
            INSERT INTO media_file (media_id, storage_path, content_type, size_bytes)
            VALUES (:mid, :sp, 'application/pdf', :sz)
        """),
        {"mid": media_id, "sp": storage_path, "sz": len(pdf_bytes)},
    )
    db.flush()
    storage.put_object(storage_path, pdf_bytes)
    return media_id


class TestRealPdfExtraction:

    @pytest.mark.parametrize(
        "fixture_meta",
        CORPUS,
        ids=[c["file"] for c in CORPUS],
    )
    def test_extraction(self, db_session: Session, fixture_meta: dict):
        path = FIXTURES_DIR / fixture_meta["file"]
        assert path.exists(), f"Missing fixture: {path}"

        storage = FakeStorageClient()
        media_id = _create_pdf_media(db_session, storage, path.read_bytes())

        result = extract_pdf_artifacts(db_session, media_id, storage)

        assert isinstance(result, PdfExtractionResult), (
            f"{fixture_meta['label']}: expected success, got {result}"
        )
        assert result.page_count >= fixture_meta["min_pages"], (
            f"{fixture_meta['label']}: expected >= {fixture_meta['min_pages']} pages, "
            f"got {result.page_count}"
        )
        assert result.has_text is True, (
            f"{fixture_meta['label']}: expected text-bearing PDF"
        )
        assert len(result.plain_text) >= fixture_meta["min_text_length"], (
            f"{fixture_meta['label']}: expected >= {fixture_meta['min_text_length']} chars, "
            f"got {len(result.plain_text)}"
        )

    @pytest.mark.parametrize(
        "fixture_meta",
        CORPUS,
        ids=[c["file"] for c in CORPUS],
    )
    def test_text_normalization(self, db_session: Session, fixture_meta: dict):
        path = FIXTURES_DIR / fixture_meta["file"]
        storage = FakeStorageClient()
        media_id = _create_pdf_media(db_session, storage, path.read_bytes())

        result = extract_pdf_artifacts(db_session, media_id, storage)
        assert isinstance(result, PdfExtractionResult)

        assert "\r" not in result.plain_text, "CR not normalized"
        assert "\f" not in result.plain_text, "Form feed not normalized"
        assert "\u00a0" not in result.plain_text, "NBSP not normalized"

    @pytest.mark.parametrize(
        "fixture_meta",
        CORPUS,
        ids=[c["file"] for c in CORPUS],
    )
    def test_page_spans_contiguous(self, db_session: Session, fixture_meta: dict):
        path = FIXTURES_DIR / fixture_meta["file"]
        storage = FakeStorageClient()
        media_id = _create_pdf_media(db_session, storage, path.read_bytes())

        result = extract_pdf_artifacts(db_session, media_id, storage)
        assert isinstance(result, PdfExtractionResult)

        spans = db_session.execute(
            text("""
                SELECT page_number, start_offset, end_offset
                FROM pdf_page_text_spans
                WHERE media_id = :mid ORDER BY page_number
            """),
            {"mid": media_id},
        ).fetchall()

        assert len(spans) == result.page_count, (
            f"Expected {result.page_count} spans, got {len(spans)}"
        )
        for i, (page_num, start, end) in enumerate(spans):
            assert page_num == i + 1, f"Gap at position {i}: page_number={page_num}"
            assert end >= start, f"Inverted span at page {page_num}"
            if i > 0:
                prev_end = spans[i - 1][2]
                assert start >= prev_end, (
                    f"Overlapping spans: page {page_num} starts at {start}, "
                    f"previous ends at {prev_end}"
                )
```

### 2. `python/tests/test_real_web_article_ingest.py`

**Purpose:** Prove `run_node_ingest` extracts content from real websites.

**Prerequisites:** Node.js ingest script must be available (`make ensure-node-ingest`). Tests should skip if Node is not installed.

**Setup per test:** None. `run_node_ingest(url)` is a pure function — takes a URL, returns a result. No DB session needed.

**Assertions (per URL):**
- Result is `IngestResult` (not `IngestError`). Include the error in the assertion message.
- `result.title` is non-empty and stripped.
- `len(result.content_html) >= min_content_length`.
- `result.final_url` is non-empty (may differ from input due to redirects).

**Structure:**

```python
"""Real web article extraction smoke tests.

Exercises run_node_ingest against live URLs with no mocks.
Requires Node.js and the ingest script (make ensure-node-ingest).
"""

import shutil

import pytest

from nexus.services.node_ingest import IngestResult, run_node_ingest

pytestmark = [pytest.mark.integration, pytest.mark.slow, pytest.mark.network]

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
def _require_node():
    if not shutil.which("node"):
        pytest.skip("Node.js not available")


class TestRealWebArticleExtraction:

    @pytest.mark.parametrize(
        "article",
        ARTICLES,
        ids=[a["label"] for a in ARTICLES],
    )
    def test_extraction(self, article: dict):
        result = run_node_ingest(article["url"])

        assert isinstance(result, IngestResult), (
            f"{article['label']}: extraction failed: {result}"
        )
        assert result.title and result.title.strip(), (
            f"{article['label']}: title is empty"
        )
        assert len(result.content_html) >= article["min_content_length"], (
            f"{article['label']}: expected >= {article['min_content_length']} chars, "
            f"got {len(result.content_html)}"
        )
        assert result.final_url, (
            f"{article['label']}: final_url is empty"
        )
```

### 3. `python/tests/test_real_youtube_ingest.py`

**Purpose:** Prove `fetch_youtube_transcript` retrieves transcripts from real videos.

**Setup per test:** None. Pure function call with a video ID.

**Assertions (per video):**
- `result["status"] == "completed"`.
- `len(result["segments"]) >= min_segments`.
- Every segment has `t_start_ms >= 0`, `t_end_ms > t_start_ms`, and non-empty `text`.
- Segments are sorted by `t_start_ms`.

**Structure:**

```python
"""Real YouTube transcript extraction smoke tests.

Exercises fetch_youtube_transcript against live YouTube videos with no mocks.
"""

import pytest

from nexus.services.youtube_transcripts import fetch_youtube_transcript

pytestmark = [pytest.mark.integration, pytest.mark.slow, pytest.mark.network]

VIDEOS = [
    {
        "video_id": "VMj-3S1tku0",
        "label": "Andrej Karpathy - Micrograd Intro",
        "min_segments": 10,
    },
    {
        "video_id": "pdN-BjDx1_0",
        "label": "The Other Stuff Podcast - Aidan Gomez",
        "min_segments": 10,
    },
    {
        "video_id": "_b9tKsBau9U",
        "label": "Deep Learning with Yacine - AI Research",
        "min_segments": 10,
    },
]


class TestRealYouTubeTranscriptExtraction:

    @pytest.mark.parametrize(
        "video",
        VIDEOS,
        ids=[v["label"] for v in VIDEOS],
    )
    def test_extraction(self, video: dict):
        result = fetch_youtube_transcript(video["video_id"])

        if result["status"] != "completed":
            assert result["status"] == "failed", (
                f"{video['label']}: expected status in ['completed', 'failed'], got {result}"
            )
            assert result.get("error_code") == "E_TRANSCRIPT_UNAVAILABLE", (
                f"{video['label']}: expected E_TRANSCRIPT_UNAVAILABLE when transcript "
                f"is blocked/unavailable, got {result}"
            )
            pytest.skip(f"{video['label']}: transcript unavailable from current network/IP")

        segments = result["segments"]
        assert len(segments) >= video["min_segments"], (
            f"{video['label']}: expected >= {video['min_segments']} segments, "
            f"got {len(segments)}"
        )

        for i, seg in enumerate(segments):
            assert seg["t_start_ms"] >= 0, (
                f"Segment {i}: negative t_start_ms={seg['t_start_ms']}"
            )
            assert seg["t_end_ms"] > seg["t_start_ms"], (
                f"Segment {i}: t_end_ms={seg['t_end_ms']} <= t_start_ms={seg['t_start_ms']}"
            )
            assert seg["text"] and seg["text"].strip(), (
                f"Segment {i}: empty text"
            )

    @pytest.mark.parametrize(
        "video",
        VIDEOS,
        ids=[v["label"] for v in VIDEOS],
    )
    def test_segments_sorted_by_start_time(self, video: dict):
        result = fetch_youtube_transcript(video["video_id"])
        if result["status"] != "completed":
            assert result["status"] == "failed", (
                f"{video['label']}: expected status in ['completed', 'failed'], got {result}"
            )
            assert result.get("error_code") == "E_TRANSCRIPT_UNAVAILABLE", (
                f"{video['label']}: expected E_TRANSCRIPT_UNAVAILABLE when transcript "
                f"is blocked/unavailable, got {result}"
            )
            pytest.skip(f"{video['label']}: transcript unavailable from current network/IP")

        starts = [s["t_start_ms"] for s in result["segments"]]
        assert starts == sorted(starts), (
            f"{video['label']}: segments not sorted by t_start_ms"
        )
```

### 4. `python/tests/test_real_podcast_discovery.py`

**Purpose:** Prove `PodcastIndexClient.search_podcasts` finds real podcasts.

**Setup per test:** Instantiate a `PodcastIndexClient` with real credentials from env. Skip if credentials are the test placeholder or missing.

**Assertions (per query):**
- Results list is non-empty.
- At least one result title contains the expected substring (case-insensitive).
- Every result has required fields: `provider_podcast_id`, `title`, `feed_url`.

**Structure:**

```python
"""Real podcast discovery smoke tests.

Exercises PodcastIndexClient.search_podcasts against the live Podcast
Index API. Requires real API credentials; skips if not configured.
"""

import os

import pytest

from nexus.services.podcasts import PodcastIndexClient

pytestmark = [pytest.mark.integration, pytest.mark.slow, pytest.mark.network]

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
def podcast_client():
    key = os.environ.get("PODCAST_INDEX_API_KEY", "")
    secret = os.environ.get("PODCAST_INDEX_API_SECRET", "")
    if not key or not secret or key == _PLACEHOLDER_KEY:
        pytest.skip(
            "Real Podcast Index credentials not configured. "
            "Set PODCAST_INDEX_API_KEY and PODCAST_INDEX_API_SECRET."
        )
    return PodcastIndexClient(
        api_key=key,
        api_secret=secret,
        base_url="https://api.podcastindex.org/api/1.0",
    )


class TestRealPodcastDiscovery:

    @pytest.mark.parametrize(
        "podcast",
        PODCASTS,
        ids=[p["label"] for p in PODCASTS],
    )
    def test_search(self, podcast_client, podcast: dict):
        results = podcast_client.search_podcasts(podcast["query"], limit=10)

        assert len(results) > 0, (
            f"{podcast['label']}: no results for query '{podcast['query']}'"
        )

        titles = [r["title"] for r in results]
        assert any(
            podcast["expected_title_contains"] in t.lower() for t in titles
        ), (
            f"{podcast['label']}: expected '{podcast['expected_title_contains']}' "
            f"in results, got: {titles}"
        )

        for r in results:
            assert r.get("provider_podcast_id"), (
                f"Missing provider_podcast_id in result: {r}"
            )
            assert r.get("title"), f"Missing title in result: {r}"
            assert r.get("feed_url"), f"Missing feed_url in result: {r}"
```

## Changes Required

### 1. `python/pyproject.toml`

Add `network` marker and update default exclusion:

```diff
-addopts = "-v --tb=short -m \"not supabase\""
+addopts = "-v --tb=short -m \"not supabase and not network\""
 markers = [
     "unit: pure logic tests, no DB/network",
     "integration: DB/API-backed tests",
     "slow: tests that are materially slower than normal local feedback loops",
     "supabase: requires Supabase local auth/storage services",
+    "network: requires internet access (hits real external services)",
 ]
```

### 2. `Makefile`

Add a target for running network tests:

```makefile
test-back-network:    ## Run real-content network tests
	cd python && uv run pytest -m network -v

test-back-real:       ## Run all real-content tests (network + slow local fixtures)
	cd python && uv run pytest -m "slow" -v
```

### 3. PDF fixtures

Copy from `content/` to `python/tests/fixtures/pdf/`:

```bash
mkdir -p python/tests/fixtures/pdf
cp content/attention.pdf python/tests/fixtures/pdf/
cp content/diffusion.pdf python/tests/fixtures/pdf/
cp content/svms.pdf python/tests/fixtures/pdf/
```

Verify `.gitignore` does not exclude `*.pdf` under `python/tests/`.

### 4. Test files

Create the four files specified above:

- `python/tests/test_real_pdf_ingest.py`
- `python/tests/test_real_web_article_ingest.py`
- `python/tests/test_real_youtube_ingest.py`
- `python/tests/test_real_podcast_discovery.py`

## Acceptance Criteria

### All tests

- [ ] Every test file has a module-level `pytestmark` with appropriate markers.
- [ ] Every assertion includes a rich failure message with context (per testing standards).
- [ ] No mocks, no monkeypatches, no respx, no httpserver.
- [ ] `make test-back` (default) skips all network tests.
- [ ] `make test-back-network` runs only network tests.
- [ ] All tests pass when run with appropriate markers and prerequisites.

### PDF tests

- [ ] Each of the 3 real PDFs extracts successfully.
- [ ] Page count, text length, and text normalization assertions pass.
- [ ] Page text spans are contiguous and complete.
- [ ] Uses `db_session` fixture (savepoint isolation, auto-rollback).

### Web article tests

- [ ] Each of the 4 real URLs extracts successfully.
- [ ] Title is non-empty, content meets minimum length.
- [ ] Skips gracefully if Node.js is not installed.

### YouTube tests

- [ ] Each video returns either a completed transcript or deterministic `E_TRANSCRIPT_UNAVAILABLE`.
- [ ] At least one configured video yields a completed transcript, otherwise the suite skips with a clear network/IP-block message.
- [ ] Completed transcripts have valid timing and non-empty text.
- [ ] Completed transcripts are sorted by start time.

### Podcast tests

- [ ] Each of the 3 real queries returns matching results.
- [ ] Skips gracefully if API credentials are not configured.
- [ ] Results have required fields (provider_podcast_id, title, feed_url).

## Best Practices (from testing_standards.md)

These rules apply to every line of code in this PR:

1. **Tests verify behavior, not implementation.** Assert extraction *outputs* (page count, text content, segment count). Never assert how the extraction function is internally structured.

2. **Rich assertion messages.** Every `assert` must have a message string that includes what was expected, what was received, and enough context to diagnose without re-running.

   ```python
   # BAD
   assert result.page_count >= 10

   # GOOD
   assert result.page_count >= 10, (
       f"attention.pdf: expected >= 10 pages, got {result.page_count}"
   )
   ```

3. **No disallowed mocks.** No `patch("nexus.services.*")`. No monkeypatching internal boundaries. These tests hit real services and real files.

4. **Markers describe execution requirements.** `network` means "needs internet." `slow` means "takes meaningfully longer." `integration` means "uses real I/O." Every test must be marked.

5. **Parametrize over a corpus, not copy-paste.** Use `@pytest.mark.parametrize` with a corpus list and `ids=` for readable test names. One test function per assertion family, not one function per fixture.

6. **Conservative floors, not exact values.** Assert `page_count >= 10`, not `page_count == 15`. Real content can change (YouTube re-transcribes, articles get edited). Floors catch regressions without breaking on benign changes.

7. **Skip, don't fail, on missing prerequisites.** If Node.js isn't installed or podcast API keys aren't set, `pytest.skip()` with a clear message. Never let infrastructure absence look like a test failure.

8. **Follow existing patterns exactly.** The helpers (`_create_pdf_media`), imports, class structure, and parametrize style should match `test_epub_ingest_real_fixtures.py` and `test_pdf_ingest.py`. Don't invent new patterns.

## Verification

After implementation, run:

```bash
# PDF tests (no network, needs DB)
cd python && uv run pytest tests/test_real_pdf_ingest.py -v

# Web article tests (needs network + Node.js)
cd python && uv run pytest tests/test_real_web_article_ingest.py -v

# YouTube tests (needs network)
cd python && uv run pytest tests/test_real_youtube_ingest.py -v

# Podcast tests (needs network + API keys)
PODCAST_INDEX_API_KEY=real-key PODCAST_INDEX_API_SECRET=real-secret \
  uv run pytest tests/test_real_podcast_discovery.py -v

# All network tests at once
cd python && uv run pytest -m network -v

# Confirm default test run still excludes network tests
cd python && uv run pytest --collect-only 2>&1 | grep -c "network"  # should be 0
```
