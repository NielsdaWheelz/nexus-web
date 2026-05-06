# Real Media Cutover Completion Plan

## Role

This document is the completion plan for the remaining gaps in
[`docs/real-media-test-hard-cutover.md`](real-media-test-hard-cutover.md).

The goal is a hard cutover from partial real-media coverage to complete
real-media acceptance coverage. The final state keeps no synthetic acceptance
fixtures, no internal mocks, no direct transcript/index insertion shortcuts, no
raw-fragment or `media.plain_text` retrieval fallback, no legacy search result
types, and no hidden compatibility path.

This plan does not replace the evidence contract in
[`docs/evidence-layer-hard-cutover.md`](evidence-layer-hard-cutover.md). It
defines the remaining implementation and test work needed to make the current
branch satisfy that contract.

## Source Survey

- `docs/rules/testing_standards.md`: tests verify behavior, not internals.
  E2E uses the real stack. DB inspection is allowed only for documented
  schema-level exceptions. Internal mocks and BFF mocks are disallowed.
- `docs/rules/simplicity.md`: do not add speculative API surface, options, or
  code paths.
- `docs/rules/layers.md`: BFF routes proxy only; FastAPI routes validate and
  call services; services own business logic.
- `docs/rules/control-flow.md`: finite branches must be explicit and fail
  closed.
- `docs/real-media-test-hard-cutover.md`: deterministic and live-provider
  gates are both required. Deterministic tests use stored real artifacts and
  real embeddings. Live-provider tests prove current external contracts.
- `python/tests/real_media/conftest.py`: PDFs, EPUBs, and captured articles
  mostly use product paths. Video and podcast deterministic setup still
  persists transcript/index artifacts through private helpers and SQL.
- `python/scripts/seed_real_media_e2e.py`: E2E real-media seed has the same
  video/podcast shortcut problem.
- `python/tests/real_media/test_reingest_delete_permissions.py`: reingest
  currently mutates fragments and rebuilds the index directly instead of using
  product reingest behavior.
- `e2e/tests/real-media/search-evidence.spec.ts`: the cross-media search test
  now drives visible `/search`; several per-media specs still use direct
  `/api/search` plus `page.goto(result.deep_link)`.
- `apps/web/src/app/(authenticated)/settings/local-vault/SettingsLocalVaultPaneBody.tsx`
  and `apps/web/src/app/api/vault/download/route.ts`: the visible vault
  download UX/API exists locally but is not committed yet.
- `python/nexus/api/routes/media.py`: product entrypoints already exist for
  upload, capture, URL ingestion, retry, podcast transcript request, and batch
  transcript request.
- `python/nexus/services/youtube_transcripts.py`,
  `python/nexus/services/node_ingest.py`,
  `python/nexus/services/podcasts/provider.py`,
  `python/nexus/services/podcasts/sync.py`,
  `python/nexus/services/rss_transcript_fetch.py`, and
  `python/nexus/services/podcasts/transcripts.py`: these are the existing
  provider boundaries. Deterministic provider fixtures belong here, not in
  tests and not in a public transcript-upload API.

## Goals

- Remove every remaining real-media acceptance shortcut that inserts ready
  transcripts, fragments, highlights, index rows, or embeddings directly.
- Keep deterministic tests provider-network-free while still using real
  captured provider artifacts.
- Keep live-provider tests as the only gate that hits external source
  providers.
- Drive browser assertions through visible UI wherever the product has UI:
  upload, reader navigation, search, citation links, saved highlights, chat
  context, delete, refresh, and vault export download.
- Keep DB trace inspection isolated to `python/tests/real_media/assertions.py`.
- Add a real product refresh/reingest path for source-backed media because the
  test contract requires source-change reingest behavior.
- Make fixture hashes, provider payloads, source versions, durable ids, index
  runs, chunks, spans, embeddings, resolver payloads, citations, highlights,
  and exports visible in trace artifacts.
- Keep implementation direct and local. Do not introduce manifests, DSLs,
  generic fixture orchestration, reusable test frameworks, or broad adapters.

## Non-Goals

- Do not create a public transcript-upload UX or API.
- Do not add a BFF route for transcript uploads.
- Do not let users import arbitrary transcript files in this cutover.
- Do not add compatibility for `fragment`, `transcript_chunk`, old citation
  URLs, old message retrieval rows, or PDF `media.plain_text` retrieval.
- Do not mock `nexus.services.*`, worker tasks, search, chunking, locator
  resolution, embeddings, transcript fetchers, storage, or BFF behavior.
- Do not count parser microfixtures, generated PDFs, generated EPUBs,
  generated transcripts, lorem ipsum, or old E2E seed media as acceptance
  coverage.
- Do not introduce a large manifest layer. Keep fixture declarations and
  expected values beside the tests or in the fixture README.
- Do not support refresh for media kinds that do not have a real source to
  refresh. Uploaded files are replaced by upload. Captured articles are
  recaptured through capture behavior, not transcript upload behavior.

## Target Behavior

### Deterministic provider fixtures

Deterministic real-media tests use captured provider artifacts at existing
external provider boundaries.

The provider fixture profile is explicit:

- It is enabled only by real-media commands.
- It is rejected in staging and production.
- It never falls back to live network.
- It fails when the expected fixture file is absent, hash-mismatched, or does
  not match the requested source id or URL.
- It returns the same normalized shape that the live provider path returns.
- It records the fixture path, byte length, SHA-256, provider name, provider
  source id, and source URL in test traces.

Provider fixture profile ownership:

- `python/nexus/services/node_ingest.py` may read captured Node ingest output
  for deterministic URL article ingestion and refresh.
- `python/nexus/services/youtube_transcripts.py` may read captured YouTube
  transcript output for deterministic video ingestion.
- `python/nexus/services/podcasts/provider.py` may read captured Podcast Index
  discovery and episode output for deterministic podcast discovery/sync.
- `python/nexus/services/podcasts/sync.py` and
  `python/nexus/services/rss_transcript_fetch.py` may read captured RSS feed,
  transcript, and chapter payloads for deterministic podcast episode metadata.
- `python/nexus/services/podcasts/transcripts.py` may read captured Deepgram
  output only at the Deepgram provider boundary.

No fixture provider path is a mock. It is a local external-provider profile
over real captured payloads. It is not public product surface.

### Product source acquisition

Each deterministic media item enters through a supported product path:

- Digital PDF: `/media/upload/init`, object storage upload, `/media/{id}/ingest`,
  then `ingest_pdf` worker entrypoint.
- Scanned or OCR-required PDF: same upload path, then `ingest_pdf` worker
  entrypoint.
- EPUB: `/media/upload/init`, object storage upload, `/media/{id}/ingest`,
  then `ingest_epub` worker entrypoint.
- Browser-captured article: extension session plus `/media/capture/article`.
- URL-ingested web article: `/media/from_url`, then `ingest_web_article`
  worker entrypoint with deterministic provider fixture profile.
- Video transcript: `/media/from_url`, then `ingest_youtube_video` worker
  entrypoint with deterministic provider fixture profile.
- Podcast episode transcript: `/podcasts/discover`,
  `/podcasts/subscriptions`, `/podcasts/subscriptions/{id}/sync`,
  `/media/{id}/transcript/request`, then podcast sync and transcription worker
  entrypoints with deterministic provider fixture profile.

Tests may drain jobs by invoking the same task entrypoint workers execute. They
must not insert ready media, transcripts, fragments, highlights, index rows, or
embeddings directly.

### Refresh and reingest

Source refresh is a real product operation, not a test-only mutation.

Add one product refresh path for source-backed media:

- FastAPI: `POST /media/{media_id}/refresh`.
- BFF: `POST /api/media/[id]/refresh`.
- UI: visible `Refresh source` action on readable source-backed media.

Refresh behavior:

- It is available only to the creator or an explicitly allowed owner role.
- It is available for URL-backed web articles, videos, and podcast episodes
  where the current product can reacquire source content.
- It is not available for uploaded PDFs or EPUBs; those use upload.
- It is not a transcript upload path.
- It writes a new complete index run and atomically activates it.
- It deactivates the previous run and prevents stale chunks, embeddings, and
  evidence spans from new search/chat retrieval.
- It preserves durable old citations only where the evidence model says they
  remain resolvable.
- It fails closed when reacquisition fails and does not activate partial
  artifacts.

Deterministic reingest coverage uses this refresh path with captured provider
artifact versions. Live-provider coverage uses the same path against a stable
allowlisted live source.

### Search

Search acceptance is visible-UI first.

- `/search` must visibly expose the `Evidence` result type and content-kind
  filters.
- Cross-media Playwright search uses the visible query input, visible filters,
  visible result row, and visible result click.
- Per-media Playwright specs must not use `/api/search` as a substitute for
  visible search when the assertion is search/navigation behavior.
- API calls may still inspect the `/api/search` response caused by visible UI
  submission to collect trace ids.
- Legacy filters `fragment`, `transcript_chunk`, and direct PDF text filters
  are rejected by API validation.
- Snippets, context refs, citation labels, and deep links come from
  `content_chunk` evidence and resolver output.

### Reader and highlights

- Search result links and chat citation links open the reader through resolver
  output.
- Temporary evidence highlights render for web, EPUB, PDF, video transcript,
  and podcast transcript.
- Temporary evidence highlights do not create saved highlight rows.
- Saved highlights are created through visible reader selection where the
  media kind supports it.
- Saved highlights are tested separately from evidence spans.
- Saved highlights can be attached to chat context without mutating evidence
  spans.
- PDF assertions include page navigation, page labels where available, zoom,
  and missing-geometry behavior.
- EPUB assertions include section navigation, anchors where available, delayed
  hydration, and resume state.
- Transcript assertions include seeking to the expected segment or time range.

### Context, chat, and citations

- Browser chat tests attach evidence through visible UI and send through the
  visible composer.
- Backend real-media tests assert persisted `message_tool_calls`,
  `message_retrievals`, `message_context_items`, prompt assemblies, selected
  evidence span ids, exact snippets, retrieval status, prompt inclusion, and
  citation rows.
- No-indexed-evidence, no-result, deleted-media, removed-library, and stale
  evidence cases persist explicit statuses.
- Chat citations render from persisted retrieval/evidence rows and open the
  same resolver path as search results.
- Stale evidence spans from inactive runs are rejected before prompt assembly.

### Vault export

- Users have a visible `Download export` control in local vault settings.
- The BFF route proxies to FastAPI without business logic.
- FastAPI returns a deterministic ZIP download with `application/zip`,
  `Content-Disposition: attachment; filename="nexus-vault.zip"`, private
  no-store cache headers, and no secret-bearing content.
- Browser E2E clicks the visible download control and inspects the downloaded
  ZIP artifact.
- Backend trace tests prove exported source text is block-derived and exported
  highlights/citations are selector/evidence-derived.

## Structure

### Backend deterministic tests

Keep the suite under `python/tests/real_media/`.

Required updates:

- `conftest.py`: remove direct transcript/index persistence helpers. Keep
  product setup helpers, fixture hash checks, job-draining helpers, and cleanup.
- `assertions.py`: keep all schema inspection here. Extend traces for fixture
  provider artifacts, refresh runs, no-index statuses, library removal, and
  cross-kind saved highlights.
- `test_ingest_index_trace.py`: cover each media kind through product
  entrypoints and worker task entrypoints.
- `test_search_resolver_trace.py`: keep API search/resolver contract coverage
  over all media kinds and all relevant result modes.
- `test_context_chat_trace.py`: add no-indexed-evidence, no-results, stale
  evidence, and highlight-to-chat status coverage.
- `test_reingest_delete_permissions.py`: replace direct fragment mutation with
  product refresh; add library removal.
- `test_exports_trace.py`: cover downloaded ZIP plus selector-derived
  highlights/citations where supported.
- `test_no_internal_mocks.py`: expand from "no mocks" to "no internal
  shortcuts" by scanning real-media tests, live-provider tests, and the
  real-media E2E seed for forbidden direct transcript/index/media insertion.

### Live-provider tests

Keep the suite under `python/tests/live_providers/`.

Required updates:

- Prove live web URL ingest, live supported-video transcript ingest, live
  podcast discovery/RSS/audio/transcription ingest, and live embedding provider
  vectors.
- Add live refresh where a stable source supports it.
- Keep missing credentials and provider prerequisites as failures, not skips.
- Keep data volume small.

### Playwright tests

Keep the suite under `e2e/tests/real-media/`.

Required updates:

- Use visible `/search` for all search-result navigation assertions.
- Use visible upload flows for PDF and EPUB.
- Use visible reader flows for web, EPUB, PDF, video transcript, and podcast
  transcript.
- Use visible saved-highlight creation for supported media kinds.
- Use visible chat composer, context attachment, and citation clicks.
- Use visible delete and refresh actions.
- Use visible `Download export` and downloaded ZIP inspection.
- Keep trace artifacts for every spec.
- API reads may collect trace ids or verify backend status after a visible
  product action; they may not replace the visible action itself.

### Seed command

`python/scripts/seed_real_media_e2e.py` remains the single deterministic E2E
seed command.

Rules:

- It uses product APIs and worker task entrypoints.
- It may create/bootstrap the E2E user and entitlements.
- It may not insert ready media, fragments, transcript versions, transcript
  segments, highlights, content indexes, or embeddings directly.
- It writes `.seed/real-media.json` with ids, hashes, expected needles, and
  trace metadata only.
- It fails when fixture provider artifacts are missing or hash-mismatched.

## Architecture

### Provider fixture profile

Use the existing provider modules. Do not introduce a new generic provider
framework.

The implementation shape is deliberately small:

1. Add explicit real-media fixture settings in `python/nexus/config.py`.
2. In each existing provider boundary, branch explicitly on the selected
   profile.
3. In fixture profile, read the exact local captured artifact for the requested
   source id or URL.
4. Validate hash and source identity before returning provider-shaped data.
5. Raise or return the same failure shape the live provider boundary already
   uses when validation fails.

No fixture provider path may silently call the live provider. Live-provider
tests select the live profile.

### Refresh service

Add the smallest product refresh implementation that covers real source-backed
media.

- Route: `python/nexus/api/routes/media.py`.
- Service logic: use existing lifecycle modules where possible:
  `web_article_lifecycle`, `podcasts/transcripts`, and video ingest retry
  logic.
- BFF route: `apps/web/src/app/api/media/[id]/refresh/route.ts`, proxy only.
- UI action: add to the existing media actions surface, visible only when the
  media kind/source state supports refresh.

Refresh must use existing enqueue/job kinds and task entrypoints. It must not
add a transcript upload path or duplicate transcript persistence logic.

### Trace layer

DB trace inspection remains in `python/tests/real_media/assertions.py`.

Trace assertions must return serializable dicts and fail on:

- missing source snapshots, blocks, spans, chunks, parts, embeddings, or
  resolver metadata;
- inactive or stale active-run rows;
- hash mismatches;
- unsupported resolver kinds;
- raw-fragment, raw-transcript, or PDF plain-text fallback retrieval;
- fixture provider source mismatch;
- fixture hash mismatch;
- partial refresh activation;
- deleted or removed-library evidence still appearing in search/chat.

## Files

### Docs

- `docs/real-media-cutover-completion-plan.md`
- `docs/real-media-test-hard-cutover.md`
- `python/tests/fixtures/real_media/README.md`
- `README.md`

### Backend app

- `python/nexus/config.py`
- `python/nexus/api/routes/media.py`
- `python/nexus/api/routes/vault.py`
- `python/nexus/services/media.py`
- `python/nexus/services/web_article_lifecycle.py`
- `python/nexus/services/node_ingest.py`
- `python/nexus/services/youtube_transcripts.py`
- `python/nexus/services/podcasts/provider.py`
- `python/nexus/services/podcasts/sync.py`
- `python/nexus/services/rss_transcript_fetch.py`
- `python/nexus/services/podcasts/transcripts.py`
- `python/nexus/services/vault.py`

### Frontend app

- `apps/web/src/app/(authenticated)/media/[id]/...`
- `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/local-vault/SettingsLocalVaultPaneBody.tsx`
- `apps/web/src/app/api/media/[id]/refresh/route.ts`
- `apps/web/src/app/api/vault/download/route.ts`
- `apps/web/src/lib/search/resultRowAdapter.ts`
- `apps/web/src/components/search/SearchResultRow.tsx`

### Fixtures

- `python/tests/fixtures/real_media/`
- Existing real artifacts under `python/tests/fixtures/pdf/` and
  `python/tests/fixtures/epub/` that are documented in the real-media README.

Add only captured real provider artifacts with documented license/source/hash.
Do not add generated transcript text.

### Tests and tooling

- `python/tests/real_media/assertions.py`
- `python/tests/real_media/conftest.py`
- `python/tests/real_media/test_ingest_index_trace.py`
- `python/tests/real_media/test_search_resolver_trace.py`
- `python/tests/real_media/test_context_chat_trace.py`
- `python/tests/real_media/test_reingest_delete_permissions.py`
- `python/tests/real_media/test_exports_trace.py`
- `python/tests/real_media/test_no_internal_mocks.py`
- `python/tests/live_providers/*.py`
- `python/scripts/seed_real_media_e2e.py`
- `e2e/tests/real-media/*.spec.ts`
- `e2e/tests/real-media/real-media-seed.ts`
- `e2e/global-setup.mjs`
- `e2e/playwright.config.ts`
- `Makefile`
- `.github/workflows/ci.yml`

### Synthetic acceptance cleanup

Demote or delete acceptance claims in:

- `python/scripts/seed_e2e_data.py`
- generated `.seed/upload-source.pdf` paths
- `e2e/tests/pdf-reader.spec.ts`
- `e2e/tests/epub.spec.ts`
- `e2e/tests/web-articles.spec.ts`
- `e2e/tests/youtube-transcript.spec.ts`
- `e2e/tests/search.spec.ts`
- backend synthetic media/retrieval/context tests listed in
  `docs/real-media-test-hard-cutover.md`

Pure parser/unit tests may remain if they do not claim real-media acceptance.

## Key Decisions

- No transcript-upload API. Deterministic transcript media enters through URL,
  podcast, transcript-request, provider, and worker paths that already exist.
- Deterministic provider fixtures are external-boundary profiles over real
  captured provider artifacts. They are not internal mocks and they do not
  fallback to live network.
- A source refresh product path is required because reingest is a product
  behavior, not just a schema invariant.
- Visible browser behavior is the primary E2E proof. API inspection in
  Playwright is allowed only to collect trace ids or verify the backend result
  of a visible action.
- DB inspection belongs only in shared trace assertions.
- No new manifest layer. Use fixture README entries and local test literals
  until duplication proves otherwise.
- Keep code linear. Add branches at existing provider, lifecycle, route, and
  UI boundaries instead of introducing generic orchestration layers.
- Full completion requires committed code, passing deterministic gates, and
  passing live-provider gates in an environment with required credentials.

## Acceptance Criteria

### Corpus and fixtures

- [ ] Every real-media fixture has source URL, license, byte length, SHA-256,
      expected title/language where applicable, and expected needles.
- [ ] Provider fixture artifacts are captured real provider/source outputs, not
      generated stand-ins.
- [ ] Fixture-provider profile fails on missing, hash-mismatched, or
      source-mismatched artifacts.
- [ ] No generated PDF, generated EPUB, generated article, generated
      transcript, lorem ipsum, or synthetic podcast fixture is used by
      acceptance gates.

### Product entrypoints

- [ ] PDFs and EPUBs ingest through upload, storage, ingest-confirm, and worker
      task entrypoints.
- [ ] Browser-captured articles ingest through extension capture.
- [ ] URL web articles ingest through `/media/from_url` and worker task
      entrypoints.
- [ ] Videos ingest through `/media/from_url`, provider transcript boundary,
      and worker task entrypoints.
- [ ] Podcasts ingest through visible/API product podcast discovery,
      subscription, sync, transcript request, and worker task entrypoints.
- [ ] No deterministic real-media test or seed command inserts ready media,
      fragments, transcript versions, transcript segments, highlights, content
      indexes, or embeddings directly.

### Refresh and stale evidence

- [ ] `POST /media/{id}/refresh` exists for source-backed media and has a BFF
      proxy route.
- [ ] Refresh is visible in the media action UI where supported.
- [ ] Refresh creates and activates a complete replacement index run.
- [ ] Refresh does not activate partial artifacts after failure.
- [ ] Search and chat reject stale chunks and evidence spans from inactive
      runs.
- [ ] Tests prove stale evidence cannot be retrieved after refresh.

### Search, resolver, reader

- [ ] Search returns only `content_chunk` for text evidence.
- [ ] Legacy text filters are rejected.
- [ ] `/search` visible UI covers resolver-backed results for PDF, EPUB, web,
      video transcript, and podcast transcript.
- [ ] Per-media E2E search/navigation assertions use visible search/result
      clicks where search is the behavior under test.
- [ ] Resolver-backed temporary highlights render in every supported reader.

### Highlights, chat, exports

- [ ] Saved highlights are created through visible reader selection for all
      supported media kinds.
- [ ] Saved highlights attach to chat context without mutating evidence spans.
- [ ] Browser chat tests prove visible context attachment, send, persisted
      evidence state, rendered citation, citation click, and reader highlight.
- [ ] Backend chat traces prove retrieval rows, context rows, prompt assembly,
      prompt inclusion, exact snippets, and citation/evidence ids.
- [ ] No-indexed-evidence and no-results cases persist explicit statuses.
- [ ] Visible vault download produces `nexus-vault.zip`.
- [ ] Export traces prove source text is block-derived and highlights/citations
      are selector/evidence-derived.

### Permissions and cleanup

- [ ] Deleted media is not readable or retrievable and leaves no retrievable
      evidence artifacts.
- [ ] Library removal hides evidence from removed scopes without deleting media
      evidence.
- [ ] Outsider users cannot retrieve scoped evidence.
- [ ] Synthetic media acceptance tests are deleted or demoted out of the
      acceptance gates.

### Commands and CI

- [ ] `make test-real-media` passes deterministic backend and Playwright gates
      with required real-media prerequisites.
- [ ] `make test-live-providers` passes in a credentialed provider
      environment.
- [ ] `make verify-full` includes deterministic real-media and live-provider
      gates.
- [ ] CI uploads real-media and live-provider trace artifacts on failure.
- [ ] All intended files are committed and pushed; unrelated local files such
      as `.claude/` stay out of the commit.

## Cutover Sequence

1. Land this completion plan.
2. Commit the current visible `/search` and vault download work after one more
   focused verification pass.
3. Add fixture provider profile settings and provider-boundary fixture reads.
4. Replace direct video/podcast transcript/index persistence in backend tests
   and E2E seeding with product entrypoints plus worker task entrypoints.
5. Add product refresh API/BFF/UI and replace direct reingest mutation tests.
6. Convert remaining real-media Playwright search/navigation assertions to
   visible `/search` flows.
7. Expand saved-highlight, chat-status, library-removal, refresh, and export
   coverage.
8. Expand no-internal-shortcut guard tests.
9. Delete or demote remaining synthetic acceptance paths.
10. Run and fix `make test-real-media`, `make test-live-providers`, and
    `make verify-full` in a credentialed environment.

The cutover is complete only when every acceptance criterion above is checked
and the credentialed gates pass.
