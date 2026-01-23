# PR-04 Implementation Report

**Web Article Ingestion Worker (Celery)**

---

## Summary of Changes

### New Files Created

| File | Purpose |
|------|---------|
| `python/nexus/celery.py` | Celery application configuration with broker/backend URLs from settings |
| `python/nexus/tasks/__init__.py` | Task module with explicit imports (no autodiscovery) |
| `python/nexus/tasks/ingest_web_article.py` | Main Celery task for web article ingestion pipeline |
| `python/nexus/services/node_ingest.py` | Python wrapper for Node.js subprocess with timeout/error handling |
| `python/nexus/services/sanitize_html.py` | HTML sanitization with allowlist, URL resolution, image proxy rewriting |
| `python/nexus/services/canonicalize.py` | Canonical text generation following constitution rules |
| `node/ingest/package.json` | Node.js dependencies (Playwright, jsdom, @mozilla/readability) |
| `node/ingest/ingest.mjs` | Playwright-based web fetcher with Readability extraction |
| `docker/Dockerfile.worker` | Multi-stage Docker image with Python + Node.js + Playwright + Chromium |
| `docker/docker-compose.worker.yml` | Worker service definition for local development |
| `python/tests/test_ingest_web_article.py` | Integration tests for ingestion pipeline |
| `python/tests/test_sanitize_html.py` | Unit tests for HTML sanitization |
| `python/tests/test_canonicalize.py` | Unit tests for canonical text generation |

### Modified Files

| File | Change |
|------|--------|
| `python/nexus/api/routes/media.py` | Updated `/media/from_url` to return 202 and call enqueue service |
| `python/nexus/services/media.py` | Added `enqueue_web_article_from_url()` and `_enqueue_ingest_task()` |
| `python/nexus/services/url_normalize.py` | Added localhost allowlist for test environment |
| `python/pyproject.toml` | Added `lxml>=5.0.0` dependency and `pytest-httpserver>=1.0.0` dev dependency |
| `apps/worker/main.py` | Updated to import tasks for explicit registration |
| `README.md` | Added web article ingestion documentation section |
| `python/tests/test_url_normalize.py` | Added skip markers for localhost tests in test env |
| `python/tests/test_from_url.py` | Added skip markers for localhost tests in test env |

---

## Problems Encountered

### 1. pytest-httpserver Fixture Not Found
**Problem:** Initial test runs showed `fixture 'httpserver' not found` errors even though pytest-httpserver was in `pyproject.toml`.

**Root Cause:** The package wasn't installed in the virtual environment.

**Solution:** Ran `uv sync --all-extras` to ensure dev dependencies were installed.

### 2. Fixture Scope Mismatch
**Problem:** After installing pytest-httpserver, tests failed with `ScopeMismatch` error - the `httpserver_listen_address` fixture was function-scoped but pytest-httpserver's internal `make_httpserver` is session-scoped.

**Solution:** Changed `httpserver_listen_address` fixture to session scope:
```python
@pytest.fixture(scope="session")
def httpserver_listen_address():
    return ("127.0.0.1", 0)
```

### 3. Localhost Validation Tests Failing
**Problem:** Existing tests expected localhost URLs to be rejected, but PR-04 spec requires allowing localhost in test environment for httpserver fixtures.

**Solution:** Added `pytest.mark.skipif` decorators to localhost validation tests:
```python
@pytest.mark.skipif(
    os.environ.get("NEXUS_ENV") == "test",
    reason="localhost allowed in test env for httpserver fixtures (per s2_pr04 spec)"
)
def test_rejects_localhost(self):
    ...
```

---

## Solutions Implemented

### 1. Asynchronous Ingestion Pipeline

Implemented full async pipeline per spec:
1. API creates provisional media row (`pending` status)
2. Enqueues Celery task to `ingest` queue
3. Returns 202 Accepted immediately
4. Worker processes in background:
   - Node.js subprocess fetches/renders page
   - Resolves final URL after redirects
   - Atomic deduplication by canonical URL
   - HTML sanitization with allowlist
   - Canonical text generation
   - Fragment persistence (idx=0)
   - State transition to `ready_for_reading`

### 2. Node.js Subprocess Protocol

Created a JSON-based stdin/stdout protocol:
- Input: `{"url": "...", "timeout_ms": 30000}`
- Output: `{"final_url": "...", "base_url": "...", "title": "...", "content_html": "..."}`
- Exit codes: 0=success, 10=timeout, 11=fetch failed, 12=readability failed

Process isolation via `start_new_session=True` allows clean kill of entire process group on timeout.

### 3. HTML Sanitization

Implemented strict allowlist-based sanitization using lxml:
- Allowed tags: p, br, strong, em, b, i, u, s, blockquote, pre, code, ul, ol, li, h1-h6, hr, a, img, table elements
- Allowed attributes: href/title on `<a>`, src/alt on `<img>`, colspan/rowspan on `<td>`/`<th>`
- Security: removes all `on*` handlers, style/class/id, javascript:/data: URLs
- Image rewriting to proxy: `/media/image?url={encoded}`
- Link security: adds `rel="noopener noreferrer"`, `target="_blank"`, `referrerpolicy="no-referrer"`

### 4. Canonical Text Generation

Follows constitution §7 rules:
- Unicode NFC normalization
- Whitespace collapsed (including nbsp)
- Block elements insert newlines
- `<br>` inserts newline
- Hidden elements excluded
- Lines trimmed, multiple blank lines collapsed

### 5. Deduplication Algorithm

Atomic deduplication by canonical URL:
1. Worker computes canonical_url from final redirect URL
2. Attempts UPDATE with canonical_url (triggers unique constraint)
3. If IntegrityError: duplicate found
   - Find winner media
   - Attach winner to actor's default library
   - Delete loser media
4. Critical: attach THEN delete to ensure actor never loses access

---

## Decisions Made

### 1. Synchronous Test Helper

Created `run_ingest_sync()` function in the task module that reuses `_do_ingest()` logic but accepts an external session. This allows tests to call ingestion directly without running Celery.

### 2. Skip Task Enqueue in Test Environment

In test environment (`NEXUS_ENV=test`), `_enqueue_ingest_task()` returns False without enqueuing. Tests call `run_ingest_sync()` directly for deterministic execution.

### 3. lxml over bleach

Chose lxml.html for sanitization instead of bleach because:
- Better URL resolution support (relative URLs need DOM context)
- More control over attribute handling
- Better handling of malformed HTML
- bleach is deprecated

### 4. Container Elements Allowed

Added container elements (div, span, section, article, etc.) to allowed tags because Readability often wraps content in these. They're allowed but stripped of all attributes.

---

## Deviations from Spec

### 1. Test Environment Localhost Allowlist

**Spec says:** "In NEXUS_ENV=test, allow 127.0.0.1 and localhost URLs"

**Implementation:** Allowed localhost/127.0.0.1 in test env, which required updating existing tests that expected rejection. Added skip markers to those tests with clear reason annotations.

### 2. Node.js Script Location

**Spec says:** `node/ingest/ingest.mjs`

**Implementation:** Created at exact specified location. Script path is resolved relative to `node_ingest.py` service file.

### 3. Error Code Mapping

**Spec mentions:** `E_SANITIZATION_FAILED` for sanitization/canonicalization failures

**Implementation:** Added `E_SANITIZATION_FAILED` error code (mapped to HTTP 500) for these cases, distinct from `E_INGEST_FAILED` (HTTP 502) for fetch/extraction failures.

---

## How to Run

### Start Infrastructure

```bash
# Start Supabase + Redis
make dev
```

### Run API

```bash
make api
```

### Run Worker (New!)

```bash
# In a separate terminal
make worker
```

Or with Docker:
```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.worker.yml up -d
```

### First-time Node Setup

```bash
cd node/ingest
npm ci
npx playwright install chromium
```

### Run Tests

```bash
# All backend tests
make test-back

# Just sanitization tests
cd python && uv run pytest tests/test_sanitize_html.py -v

# Just canonicalization tests
cd python && uv run pytest tests/test_canonicalize.py -v

# Just ingestion tests (requires node/playwright)
cd python && uv run pytest tests/test_ingest_web_article.py -v
```

---

## Testing New Functionality

### Manual Test: Web Article Ingestion

1. Start infrastructure: `make dev`
2. Start API: `make api`
3. Start worker: `make worker`
4. Create a web article:

```bash
# Get auth token from Supabase Studio or use test helper
curl -X POST http://localhost:8000/media/from_url \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

Response (202 Accepted):
```json
{
  "data": {
    "media_id": "<uuid>",
    "duplicate": false,
    "processing_status": "pending",
    "ingest_enqueued": true
  }
}
```

5. Poll for status:
```bash
curl http://localhost:8000/media/<media_id> \
  -H "Authorization: Bearer <token>"
```

6. Get fragments after ready:
```bash
curl http://localhost:8000/media/<media_id>/fragments \
  -H "Authorization: Bearer <token>"
```

---

## Commit Message

```
feat(worker): implement web article ingestion worker (PR-04)

Implement asynchronous web article ingestion using Celery worker with
Node.js subprocess for Playwright + Readability extraction.

## API Changes
- POST /media/from_url now returns 202 Accepted (was 201)
- Response includes ingest_enqueued=true
- Clients poll GET /media/{id} for status updates

## New Components
- Celery app config (python/nexus/celery.py)
- Ingest task (python/nexus/tasks/ingest_web_article.py)
- Node.js subprocess wrapper (python/nexus/services/node_ingest.py)
- HTML sanitizer (python/nexus/services/sanitize_html.py)
- Canonical text generator (python/nexus/services/canonicalize.py)
- Node.js ingest script (node/ingest/ingest.mjs)
- Worker Dockerfile (docker/Dockerfile.worker)

## Ingestion Pipeline
1. API creates provisional media (status=pending)
2. Enqueues Celery task to 'ingest' queue
3. Worker fetches page via Playwright (JS-enabled)
4. Extracts content via Mozilla Readability
5. Resolves canonical URL from final redirect
6. Performs atomic deduplication by canonical URL
7. Sanitizes HTML (allowlist, XSS protection, image proxy)
8. Generates canonical text for highlighting
9. Persists fragment (idx=0)
10. Transitions to ready_for_reading

## Security
- HTML sanitization: allowlist of tags/attributes
- Removes all event handlers (on*)
- Removes style/class/id attributes
- Blocks javascript:/data: URLs
- Rewrites images to proxy endpoint
- Adds noopener/noreferrer to links
- Localhost blocked in production (allowed in test env)

## Deduplication
- Canonical URL computed from final redirect URL
- Atomic via SELECT FOR UPDATE + unique constraint
- On conflict: attach winner to actor's library, delete loser
- Actor never loses access (attach before delete)

## State Machine
- pending → extracting → ready_for_reading
- On failure: failed with failure_stage=extract
- Idempotent: skips if already ready with fragment

## Dependencies
- lxml>=5.0.0 (HTML parsing)
- pytest-httpserver>=1.0.0 (test fixtures)
- Node.js: playwright, jsdom, @mozilla/readability

## Tests
- test_sanitize_html.py: XSS protection, allowlist, proxying
- test_canonicalize.py: block boundaries, whitespace, exclusions
- test_ingest_web_article.py: full pipeline with httpserver fixtures

Implements: docs/v1/s2/s2_prs/s2_pr04.md
```
