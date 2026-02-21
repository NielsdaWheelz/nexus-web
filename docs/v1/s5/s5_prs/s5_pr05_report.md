# S5 PR-05 Implementation Report: EPUB Reader Baseline Adoption

## 1. Summary of Changes

### New files
- **`apps/web/src/lib/media/epubReader.ts`** — EPUB reader orchestration module with typed client contracts (`EpubChapterSummary`, `EpubChapter`, `EpubTocNode`, `NormalizedTocNode`), cursor-paginated manifest fetcher, initial chapter resolver, TOC normalizer, and centralized readable-status predicate.
- **`apps/web/src/lib/media/epubReader.test.ts`** — 6 unit tests covering all three helpers plus edge cases (non-advancing cursor, empty manifest, partial TOC).
- **`apps/web/src/app/(authenticated)/media/[id]/page.test.tsx`** — 16 integration tests verifying EPUB reader adoption and non-EPUB regression.

### Modified files
- **`apps/web/src/app/(authenticated)/media/[id]/page.tsx`** — Branched content-loading logic: EPUB uses chapter manifest + chapter detail + TOC; non-EPUB preserved. Added `ActiveContent` abstraction, request-version guards (`chapterVersionRef`, `highlightVersionRef`), `AbortController` for stale chapter responses, deterministic error recovery matrix, URL-addressable chapter state, and sub-components (`MediaHeader`, `EpubContentPane`, `TocNodeList`).
- **`apps/web/src/app/(authenticated)/media/[id]/page.module.css`** — Added chapter navigation controls (prev/next buttons, chapter selector dropdown), collapsible TOC tree with navigable/non-clickable states, responsive styles for narrow screens.
- **`README.md`** — Added EPUB Reader feature bullet.

## 2. Problems Encountered

1. **React 19 `use()` with Promise params in tests**: The `use(params)` hook suspends until the Promise resolves. Initial test renders showed "suspense" fallback because `Promise.resolve()` microtasks weren't flushed. Fixed by wrapping `render()` in `await act(async () => { ... })`.

2. **ESLint `react/no-danger` in test mocks**: The test mock for `HtmlRenderer` initially used `dangerouslySetInnerHTML` to simulate the real component. Replaced with a ref-based innerHTML approach to satisfy the lint rule without losing test coverage.

3. **Unused import**: `ApiError` was initially imported in `page.tsx` but only needed in the test file. Removed from production code.

## 3. Solutions Implemented

| Problem | Solution |
|---------|----------|
| React 19 `use()` test rendering | Wrapped all `renderPage()` calls in `await act(async () => { ... })` via the async `renderPage()` helper |
| Stale chapter response races | `AbortController` for chapter fetches + monotonic `chapterVersionRef` counter — stale responses are discarded |
| Stale highlight response races | Monotonic `highlightVersionRef` counter — only the version matching current active content is committed |
| Chapter error recovery | Deterministic matrix: `E_CHAPTER_NOT_FOUND` → one manifest re-sync + re-resolve; `E_MEDIA_NOT_READY` → processing gate; `E_MEDIA_NOT_FOUND` → masked not-found |
| EPUB vs non-EPUB divergence | `ActiveContent` abstraction unifies both paths — all highlight, cursor, rendering, and editing logic works against this single interface |

## 4. Decisions Made (and Why)

| Decision | Rationale |
|----------|-----------|
| `chapter` query param as canonical URL state | Enables durable deep links, deterministic reload, and browser history navigation. Per PR-05 spec. |
| `router.replace` for auto-canonicalization, `router.push` for user navigation | Prevents noisy history entries from automatic normalization. Per PR-05 spec decision ledger. |
| TOC is auxiliary, not source of truth | TOC may be empty/partial; manifest `idx` is canonical. Per PR-05 spec. |
| `embedding` treated as readable | Backend read endpoints allow access during embedding. Per L2/L3 decision. |
| TOC fetch failure is non-blocking | Reading path remains resilient when optional nav metadata is unavailable. Per PR-05 spec. |
| One active chapter rendered at a time | Prevents legacy whole-book DOM/memory regression on large EPUBs. Per PR-05 spec. |
| No client-side sanitization/style rewrite | Maintains slice ownership boundaries; defers iframe/shadow-DOM isolation. Per PR-05 spec. |

## 5. Deviations from L4/L3/L2

None. All deliverables, tests, and behavior match the PR-05 spec precisely.

## 6. Commands to Run New/Changed Behavior

```bash
# Run EPUB reader unit tests
cd apps/web && npx vitest run src/lib/media/epubReader.test.ts

# Run EPUB reader integration tests
cd apps/web && npx vitest run src/app/\(authenticated\)/media/\[id\]/page.test.tsx

# Run all frontend tests
cd apps/web && npm test

# Lint
cd apps/web && npm run lint

# Typecheck
cd apps/web && npm run typecheck

# Build
cd apps/web && npm run build
```

## 7. Commands Used to Verify Correctness

```bash
# All frontend tests (320 total, 22 new)
cd apps/web && npm test -- --run
# Result: 15 test files, 320 tests passed

# Targeted new tests (verbose)
cd apps/web && npx vitest run --reporter=verbose \
  src/lib/media/epubReader.test.ts \
  src/app/\(authenticated\)/media/\[id\]/page.test.tsx
# Result: 22 tests passed (6 unit + 16 integration)

# Lint
cd apps/web && npm run lint
# Result: exit 0, only pre-existing layout.tsx warning

# Typecheck
cd apps/web && npm run typecheck
# Result: exit 0, clean

# Build
cd apps/web && npm run build
# Result: exit 0, /media/[id] 13.9 kB

# Backend (no changes, sanity check)
cd python && uv run ruff check . && uv run ruff format --check .
# Result: all checks passed, 145 files already formatted
```

## 8. Traceability Table

| Acceptance Item | Files | Tests | Status |
|---|---|---|---|
| EPUB reader flow uses chapter manifest + chapter fetch contracts instead of single-fragment assumptions | `epubReader.ts`, `page.tsx` | `fetch_all_epub_chapters_walks_cursor_pages_until_exhausted`, `epub_reader_loads_manifest_then_selected_chapter_not_fragments`, `epub_reader_invalid_query_chapter_falls_back_and_canonicalizes_url`, `epub_reader_initial_load_fetches_only_active_chapter_payload`, `epub_reader_ignores_stale_chapter_responses_on_rapid_navigation`, `epub_reader_chapter_fetch_failure_reconciles_manifest_and_recovers`, `epub_reader_chapter_fetch_not_ready_shows_processing_gate`, `epub_reader_chapter_fetch_not_found_shows_masked_not_found`, `epub_reader_user_navigation_pushes_history_and_auto_canonicalization_replaces`, `epub_reader_embedding_status_is_readable`, `epub_reader_chapter_switch_refetches_highlights_for_new_fragment`, `epub_reader_ignores_stale_highlight_responses_on_rapid_navigation`, `non_epub_reader_preserves_fragments_flow` | PASS |
| Empty/partial TOC behavior is handled safely without regressing basic reading and navigation | `epubReader.ts`, `page.tsx`, `page.module.css` | `normalize_epub_toc_marks_only_mapped_nodes_as_navigable`, `epub_reader_handles_empty_toc_without_blocking_read`, `epub_reader_toc_fetch_failure_is_non_blocking`, `epub_reader_handles_partial_toc_nodes_as_non_clickable`, `epub_reader_uses_server_sanitized_chapter_html_without_extra_client_rewrite` | PASS |

All 22 tests pass. Both acceptance bullets are covered.

## 9. Commit Message

```
feat(s5-pr05): adopt chapter-based EPUB reader in media view page

Implement EPUB reader baseline adoption (S5 PR-05) that branches the
media view page content-loading flow based on media.kind:

EPUB path (new):
- Load full chapter manifest via cursor-paginated /chapters endpoint
- Resolve initial active chapter from URL ?chapter= query param
- Fetch single active chapter detail from /chapters/{idx}
- Load and normalize TOC from /toc endpoint (non-blocking)
- Chapter navigation: prev/next buttons, chapter selector dropdown
- Collapsible TOC tree with navigable/non-clickable node states
- URL-addressable chapter state (?chapter=N) with:
  - router.replace for automatic invalid-param canonicalization
  - router.push for explicit user navigation (preserves history)
- Request-version guards + AbortController for stale chapter responses
- Highlight version guards for stale highlight responses on rapid nav
- Deterministic error recovery matrix:
  - E_CHAPTER_NOT_FOUND: one manifest re-sync + re-resolve + retry
  - E_MEDIA_NOT_READY: processing gate
  - E_MEDIA_NOT_FOUND: masked not-found state
- embedding status treated as readable (ready_for_reading|embedding|ready)

Non-EPUB path (preserved):
- Existing /fragments flow unchanged for web_article and other kinds

New module: apps/web/src/lib/media/epubReader.ts
- Typed client contracts aligned to PR-04 response surfaces
- fetchAllEpubChapterSummaries: cursor-paginated manifest fetcher
- resolveInitialEpubChapterIdx: deterministic chapter resolution
- normalizeEpubToc: TOC normalization with navigability flags
- isReadableStatus: centralized readable-status predicate

Tests: 22 new (6 unit + 16 integration), 320 total passing
- Unit: cursor pagination, non-advancing cursor guard, chapter
  resolution, empty manifest, TOC normalization
- Integration: manifest-first loading, fragments regression guard,
  URL canonicalization, single-chapter fetch, stale response
  protection, error recovery, processing gate, masked not-found,
  empty TOC, TOC failure resilience, partial TOC nodes,
  embedding readability, server HTML passthrough, highlight
  rebinding on chapter switch, stale highlight protection

Closes: S5 PR-05 acceptance
```
