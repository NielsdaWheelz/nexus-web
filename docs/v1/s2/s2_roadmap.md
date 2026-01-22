# Slice 2 — PR Roadmap (L3 Plan)

This PR roadmap implements Slice 2 (Web Articles + Highlights) per the L2 spec.

**Constraints:**
- ship **sync ingestion first** (no worker required)
- **no updated_at triggers** in S2 (service-layer updates)
- add **vitest to CI** in S2
- create **api/routes/highlights.py** (separate from media routes)
- routes are transport-only: each calls exactly one service function

---

## PR-00: centralize Next.js API proxy + internal header + vitest in CI

### goal
Ensure all Next.js proxy routes use a consistent helper that attaches bearer token + internal header. Also add vitest to CI so subsequent frontend PRs can rely on it.

### deliverables
- refactor `proxyToFastAPI()` in `apps/web/src/lib/api/proxy.ts`:
  - always attach `Authorization: Bearer {token}` from Supabase session
  - always attach `x-nexus-internal: {NEXUS_INTERNAL_SECRET}` if env var set
  - export as single source of truth for all `/app/api/` route handlers
- audit existing route handlers to use this helper
- add `NEXUS_INTERNAL_SECRET` to `.env.example`
- **add vitest to CI pipeline** (`.github/workflows/ci.yml`):
  - run `npm test` in frontend job
  - subsequent frontend PRs can rely on CI running tests

### tests
- vitest test: proxy helper attaches both headers when env set
- integration: existing API routes continue to work

### non-goals
- no enforcement on FastAPI side yet (already exists per constitution)

---

## PR-01: db schema — highlights + annotations

### goal
Add persistent storage for highlights and annotations.

### deliverables
- alembic migration:
  - create `highlights` table
  - create `annotations` table
  - add constraints:
    - `chk_offsets_valid` — `CHECK (start_offset >= 0 AND end_offset > start_offset)`
    - `chk_color_valid` — `CHECK (color IN ('yellow','green','blue','pink','purple'))`
    - `uix_highlights_user_fragment_offsets`
    - `uix_annotations_one_per_highlight`
- sqlalchemy models in `python/nexus/db/models.py`:
  - `Highlight`
  - `Annotation`
- pydantic schemas:
  - `HighlightOut`, `AnnotationOut`
  - `HighlightCreateIn`, `HighlightUpdateIn`
  - `AnnotationUpsertIn`

### tests
- `make test-migrations` passes
- pytest DB constraint tests:
  - duplicate highlight span forbidden
  - annotation uniqueness per highlight enforced
  - highlight delete cascades annotation (FK ON DELETE CASCADE)

### non-goals
- no endpoints
- no business logic

---

## PR-02: error codes + routing scaffolds (backend)

### goal
Introduce S2 error codes and route modules without implementing handlers yet.

### deliverables
- extend `python/nexus/errors.py`:
  - add:
    - `E_INGEST_FAILED` (502)
    - `E_INGEST_TIMEOUT` (504)
    - `E_SANITIZATION_FAILED` (500)
    - `E_HIGHLIGHT_INVALID_RANGE` (400)
    - `E_HIGHLIGHT_CONFLICT` (409)
- create route file: `python/nexus/api/routes/highlights.py`
  - create empty `router = APIRouter(prefix="/highlights", tags=["highlights"])`
  - register in app (mount router, no endpoints yet — endpoints added in PR-06)
- add internal service helper to `python/nexus/services/media.py`:
  - `get_media_for_viewer_or_404(db, viewer_id, media_id)` — returns `Media` row or raises `NotFoundError`
  - used internally by other service functions (routes still call exactly one service function)

### tests
- minimal route import/regression test (server starts, router mounted)
- error code enum values present

### non-goals
- no stub endpoints (avoid 501 noise)
- no ingestion implementation
- no highlight logic yet

---

## PR-03: `/media/from_url` create provisional row + default library attach

### goal
Create a provisional `web_article` media row for URL-based ingestion. Actual dedup happens in PR-04 after redirect resolution.

### deliverables
- endpoint: `POST /media/from_url` in `python/nexus/api/routes/media.py`
- request/response schemas in `python/nexus/schemas/`
- service: `python/nexus/services/media.py`
  - `create_provisional_web_article(viewer, url) -> {media_id, duplicate, processing_status, ingest_enqueued}`
  - URL normalization util (new module): `python/nexus/services/url_normalize.py`
- behavior:
  - set `requested_url` = exactly what user submitted
  - set `canonical_url` = **NULL** (not yet known; set during ingestion after redirect resolution)
  - ensure `(default_library_id, media_id)` exists
  - create media row with placeholder title
  - return `ingest_enqueued=false` for now (ingestion not implemented yet)

### canonical_url strategy (important)
- `canonical_url` = final URL after redirects, normalized (set in PR-04)
- at creation time, `canonical_url` is NULL — row is "provisional"
- dedup happens in PR-04 when ingestion resolves the final URL

### tests
- pytest integration:
  - new URL creates media + library_media for default library
  - media row has `canonical_url = NULL`, `requested_url` set
  - media is readable (membership exists)
  - non-member access still 404 (visibility suite stays green)
- url normalization unit tests:
  - scheme/host lowercase
  - fragment stripped
  - query params preserved

### non-goals
- no web fetching yet
- no fragment creation
- no dedup yet (dedup requires knowing final URL)

---

## PR-04: web ingestion service (sync) — fetch + sanitize + canonicalize + persist + dedup

### goal
Complete ingestion pipeline: fetch, extract, sanitize, canonicalize, persist fragment, and transition to `ready_for_reading`. Also perform real dedup after redirect resolution.

### deliverables

**Ingestion service:** `python/nexus/services/ingest_web_article.py`
- `ingest_web_article(media_id, request_id=None) -> None`
- executes synchronously in `NEXUS_ENV=dev/test`
- state transitions: `pending` → `extracting` → `ready_for_reading` (or `failed`)

**Extraction pipeline:**
1. Playwright chromium fetch (JS enabled)
2. Follow redirects; compute `canonical_url` = normalize(final_url)
3. Run Mozilla Readability on final DOM
4. Output extracted HTML

**Dedup after redirect resolution (critical):**
After learning `canonical_url`:
1. Check if `(kind=web_article, canonical_url)` already exists with different `media_id`
2. If exists:
   - delete this provisional media row (and its library_media entries)
   - attach existing media to user's default library (if not already)
   - return early (existing media is already ingested or will be)
3. If not exists:
   - set `canonical_url` on this row (claim uniqueness)
   - proceed with sanitization and fragment creation

**Sanitizer module:** `python/nexus/services/sanitize_html.py`
- bleach allowlist per spec
- link rewriting (rel/target/referrerpolicy merge)
- strip style/class/id and all `on*`
- disallow javascript:/data: URLs
- rewrite `<img src>` to image proxy URL

**Canonicalizer module:** `python/nexus/services/canonicalize.py`
- generate `fragment.canonical_text` from sanitized HTML per spec rules

**Fragment persistence:**
- write `fragments` row with `idx=0`, `html_sanitized`, `canonical_text`
- set `processing_status=ready_for_reading` on success

**Capabilities update:**
- update `derive_capabilities()` for `kind=web_article` + `ready_for_reading`:
  - `can_read=True`, `can_highlight=True`, `can_quote=True`

**Playwright concurrency guard:**
- semaphore limit for concurrent ingests (e.g., max 3)
- per-request hard timeout (30s fetch + 10s parse = 40s max)
- fail fast with `E_INGEST_TIMEOUT` if limit exceeded
- ops guidance: don't run more than N concurrent ingests on single server

**Failure mapping:**
| Scenario | `failure_stage` | `last_error_code` |
|----------|-----------------|-------------------|
| Fetch fails | `extract` | `E_INGEST_FAILED` |
| Fetch timeout | `extract` | `E_INGEST_TIMEOUT` |
| Sanitizer throws | `extract` | `E_SANITIZATION_FAILED` |
| Canonicalizer throws | `extract` | `E_SANITIZATION_FAILED` |

### tests

**Security fixtures suite (pytest):**
- scripts removed
- on* removed
- javascript: stripped
- style/class/id stripped
- data: blocked
- svg removed
- img src rewritten to proxy
- link attrs forced (rel includes noopener noreferrer)

**Canonicalization tests:**
- block boundary newlines
- whitespace collapsing
- hidden/aria-hidden excluded

**Dedup tests:**
- two different requested_urls that redirect to same final_url → single media row
- provisional row deleted when duplicate discovered
- library_media attached to existing media

**Ingestion integration tests:**
- uses deterministic local HTTP fixture server (not live internet)
- from_url → ready_for_reading
- fragment idx=0 exists with html_sanitized + canonical_text
- canonical_url set to normalized final redirect URL
- capabilities updated correctly

### known limitation
- **Image proxy URLs will 404 until PR-05 merges.** Sanitizer rewrites `<img src>` to proxy URLs, but endpoint doesn't exist yet. Accept briefly broken images.

---

## PR-05: image proxy endpoint + SSRF protections + caching

### goal
Serve external images safely and reliably via backend proxy.

### deliverables
- endpoint: `GET /media/image?url=...` in `python/nexus/api/routes/media.py`
- service: `python/nexus/services/image_proxy.py`
  - SSRF protections (hardened for v1):
    - protocol: only `http://` and `https://`
    - ports: only 80 and 443
    - disallow userinfo in URL (`user:pass@host`)
    - disallow credentials in URL
    - block private IP ranges after DNS resolution
    - **max 1 redirect** (simplifies validation; 0 is even safer)
    - re-validate each redirect hop
    - resolve DNS once, connect to resolved IP (prevent rebinding)
    - hard timeout: 10s
  - content-type validation + svg rejection
  - size cap: 10 MB
  - dimension cap: 4096x4096
  - cache-by-content-hash (in-memory LRU acceptable for v1)
- sanitizer integration (from PR-04):
  - `<img src>` already rewritten to this endpoint

### tests
- SSRF unit tests:
  - blocks localhost/127.0.0.1
  - blocks private ranges (10.x, 172.16.x, 192.168.x)
  - blocks non-http(s)
  - blocks non-80/443 ports
  - blocks userinfo URLs
  - handles redirect (validates target)
- content validation tests:
  - rejects svg (content-type + magic bytes)
  - rejects non-image
  - enforces max bytes
- happy-path test with mocked upstream response

### non-goals
- no persistent cache store (redis/storage) in v1

---

## PR-06: highlight service + endpoints (backend)

### goal
Implement highlight + annotation CRUD per spec, owner-only visibility, and strict validation.

### deliverables
- routes: `python/nexus/api/routes/highlights.py` (router mounted in PR-02, endpoints added here)
  - `POST /fragments/{fragment_id}/highlights`
  - `GET /fragments/{fragment_id}/highlights`
  - `GET /highlights/{highlight_id}`
  - `PATCH /highlights/{highlight_id}`
  - `DELETE /highlights/{highlight_id}`
  - `PUT /highlights/{highlight_id}/annotation`
  - `DELETE /highlights/{highlight_id}/annotation`
- services:
  - `python/nexus/services/highlights.py` with one function per route
  - server-derives `exact/prefix/suffix` from fragment.canonical_text (client sends offsets+color only)
  - validates:
    - media is readable by viewer
    - media status >= ready_for_reading
    - offset bounds within canonical_text
    - color in palette (DB constraint enforces too)
  - update semantics:
    - offset updates require recalculating exact/prefix/suffix
    - preserve created_at; bump updated_at
- error handling:
  - invalid range → `E_HIGHLIGHT_INVALID_RANGE`
  - uniqueness collision → `E_HIGHLIGHT_CONFLICT` (409)
  - unauthorized → masked 404

### tests
- pytest integration:
  - create highlight, list, get
  - overlapping highlights allowed
  - duplicate exact span rejected (409)
  - update preserves id + created_at
  - delete cascades annotation
  - cannot highlight if not in library (404)
  - cannot highlight before ready_for_reading
- **codepoint test:** fixture with emoji in canonical_text; verify server slices exact/prefix/suffix correctly using codepoint indices (not UTF-16)
- **bounds validation test:** verify `end_offset > len(canonical_text)` returns `E_HIGHLIGHT_INVALID_RANGE` (DB cannot enforce this; service-level only)

### non-goals
- no sharing logic (owner-only)

---

## PR-07: frontend overlap segmenter (pure)

### goal
Create deterministic overlap segmentation primitive. Vitest already in CI from PR-00.

### deliverables
- implement pure segmenter: `apps/web/src/lib/highlights/segmenter.ts`
  - input: text length (integer) + list of highlight ranges (start, end, id, color, created_at)
  - output: list of segments with active highlight ids + topmost highlight id
  - **operates on integer indices only** — no Unicode awareness needed here
- unit tests (vitest):
  - simple non-overlap
  - nested overlap
  - partial overlap
  - deterministic topmost by created_at
- add frontend constants:
  - `HIGHLIGHT_COLORS = ['yellow','green','blue','pink','purple']` — must match backend

### non-goals
- no DOM mapping yet (PR-08)
- no selection UI yet (PR-09)
- no emoji tests here (segmenter is integer-only; Unicode correctness tested in offsetMapper)

---

## PR-08: frontend render highlights (read-only)

### goal
Display highlights on a web article using sanitized HTML + canonical mapping.

### deliverables

**API calls:**
- `GET /media/{id}` — media metadata
- `GET /media/{id}/fragments` — returns fragment list; for web_article, idx=0 includes `html_sanitized` + `canonical_text`
- `GET /fragments/{fragment_id}/highlights` — returns highlights for rendering

**Fragment response contract:**
- list endpoint returns full fragment objects (acceptable for web_article with 1 fragment)
- each fragment includes `id`, `idx`, `html_sanitized`, `canonical_text`
- **forward-compatibility note:** will split into list (metadata) vs detail (content) endpoints for epub/transcripts in later slice

**Offset mapping utility:** `apps/web/src/lib/highlights/offsetMapper.ts`
- input: canonical_text (from fragment) + rendered DOM
- walk rendered DOM text nodes in document order
- build mapping table: DOM text node → (start_offset, end_offset) in canonical_text space
- **must match server canonicalization rules** (block boundaries, br newlines)
- **must use codepoint-safe iteration** (not naive string length)

**Highlight rendering (DOM-based approach):**
1. Parse `html_sanitized` into DOM (via DOMParser or render to hidden element)
2. Walk text nodes, build offset mapping
3. For each segment boundary (from segmenter output):
   - split text nodes at cut points
   - wrap resulting text node segments in `<mark>` elements
4. Each `<mark>` includes:
   - `data-highlight-ids="id1,id2,..."` — all active highlights in this segment
   - `class` for topmost highlight's color
5. **Highlight anchor:** for each highlight, insert a zero-width `<span data-highlight-anchor="{id}">` at start boundary (first mark)
6. Serialize DOM back to HTML string (or render directly)
7. Set via `dangerouslySetInnerHTML` (single render)

**Why DOM-based, not string splicing:**
- Offsets are in canonical_text space, not HTML string space
- String splicing would break tag structure, links, images
- DOM manipulation preserves structure and is predictable

**Linked-items pane:**
- lists highlights (not aligned yet — alignment in PR-10)

### tests
- vitest + happy-dom: offset mapping correctness on static HTML fixture
- **emoji test:** fixture with astral chars (🎉) verifies codepoint-safe mapping in offsetMapper
- test DOM transformation produces valid HTML with correct mark structure

### non-goals
- no selection/create yet
- no alignment yet

---

## PR-09: frontend create/update/delete highlights + annotation UI

### goal
Enable selection-driven highlight creation and annotation editing.

### deliverables
- selection handler:
  - compute offsets from selection range using offset mapping table
  - use codepoint-safe conversion (not naive string indices)
  - reject selections intersecting `<pre>` or `<code>`
- API calls:
  - create highlight (offsets+color only — server derives exact/prefix/suffix)
  - update highlight (offsets+color)
  - delete highlight
  - upsert/delete annotation
- UI:
  - color picker (fixed palette from constants)
  - hover/click chooses "focused" highlight in overlap
  - annotation editor for focused highlight

### tests
- vitest unit tests for offset conversion with astral characters (emoji)
- backend integration tests already cover correctness; frontend tests cover mapping/selection

---

## PR-10: linked-items vertical alignment

### goal
Align linked-items list rows to highlight targets in the scroll container.

### deliverables
- ref plumbing:
  - forwardRef on `Pane` content div
  - expose scroll container for content pane and linked-items pane
- alignment anchor:
  - each highlight has a stable anchor: `<span data-highlight-anchor="{id}">` (created in PR-08)
  - query: `[data-highlight-anchor="${highlightId}"]`
  - guaranteed exactly one anchor per highlight, at start boundary
- alignment logic:
  - measure highlight anchor rect relative to scroll container
  - position linked-item entries with CSS transforms/top offsets
  - update on scroll + resize (throttled, ~60fps target)
- constraints:
  - performant for hundreds of highlights
  - consider `IntersectionObserver` for visibility-based updates
  - consider virtual list if list itself is long

### tests
- minimal DOM measurement test (best-effort) + manual verification checklist

---

## PR-11: end-to-end integration + hardening

### goal
Prove the full S2 loop works and lock regressions.

### deliverables
- backend E2E integration test:
  - from_url ingest (fixture server) → ready_for_reading
  - create overlapping highlights + annotation
  - reload → highlights persist
- tighten processing-state tests for web_article
- documentation for local dev prerequisites (playwright deps)

### non-goals
- no celery worker tasks yet (next slice/PR set)

---

## Parallelization Opportunities

After PR-04 lands (sanitized fragment + canonical_text exists), you can parallelize:

| Track | PRs | Dependencies |
|-------|-----|--------------|
| Backend highlights | PR-06 | PR-04 |
| Frontend segmenter | PR-07 | None (pure logic) |
| Frontend render | PR-08 | PR-04 + PR-07 |
| Image proxy | PR-05 | PR-04 (sanitizer already rewrites img src) |

**Recommended parallelization:**
- PR-05 (image proxy) + PR-06 (highlight endpoints) can run in parallel after PR-04
- PR-07 (frontend segmenter) can start immediately (no backend dependency)
- PR-08 (frontend render) waits for PR-04 + PR-07

Avoid parallelizing anything that touches the same route files or migration files.
