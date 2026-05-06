# Real Media Test Hard Cutover

## Role

This document is the target-state plan for replacing synthetic, mocked, and
partial media/evidence tests with a real-media acceptance suite that proves the
product works from source acquisition through reader, search, retrieval,
context, citation, and highlight behavior.

The implementation is a hard cutover. The final state keeps no synthetic media
acceptance fixtures, no generated PDF or EPUB standing in for a real document,
no fake article body standing in for a real article, no mocked transcript or
podcast provider standing in for a real episode, no hash-vector embedding
standing in for a real embedding model, no skipped provider test that reports
success, no hidden fallback to raw fragments or `media.plain_text`, and no
legacy test path that proves only the old behavior.

This plan owns test coverage for real media and evidence behavior. It does not
redefine the evidence data model; that contract lives in
[`docs/evidence-layer-hard-cutover.md`](evidence-layer-hard-cutover.md). It does
not redefine repository-wide testing rules; those live in
[`docs/rules/testing_standards.md`](rules/testing_standards.md).

## Goals

- Prove that each supported text-bearing source kind works end to end with
  real media: web article, browser-captured article, EPUB, digital PDF, scanned
  or OCR-required PDF, video transcript, and podcast episode transcript.
- Prove every evidence artifact touched by the pipeline is present, active,
  internally consistent, and externally usable.
- Prove reader navigation, search, scoped chat, persisted retrieval metadata,
  citations, temporary answer highlights, saved highlights, and exports all
  resolve through the evidence layer.
- Replace generated and mocked media acceptance tests with legally usable,
  versioned real-media fixtures and live provider gates.
- Make failures actionable by emitting trace artifacts for every tested media
  item, from original artifact hash through final resolver output.
- Assert acceptance behavior at product boundaries: upload, capture, ingest,
  API, BFF, browser, and exported artifacts.
- Keep schema-level audit helpers separate from user-flow assertions. Use DB
  inspection to prove evidence invariants, not to replace product behavior
  assertions.
- Make the suite deterministic enough for CI while still preserving live
  provider coverage as a required release gate.

## Non-Goals

- Do not use generated PDFs, generated EPUBs, generated transcript text, lorem
  ipsum articles, or hand-authored fake media in media/evidence acceptance
  tests.
- Do not count parser microfixtures as real-media coverage. Small synthetic
  files may remain only for pure parser edge cases outside the acceptance
  gates.
- Do not mock internal services, database sessions, search, chunking, locator
  resolution, BFF routes, storage, embedding calls, transcript fetchers, or
  media ingest tasks in real-media tests.
- Do not preserve tests that assert legacy `fragment`, `transcript_chunk`, or
  PDF `media.plain_text` retrieval paths.
- Do not silently skip live provider tests because credentials, network, or
  provider data are missing. A missing provider prerequisite is an explicit
  infrastructure failure for the provider gate.
- Do not test semantic retrieval with deterministic hash vectors and call it
  real embedding coverage.
- Do not let E2E tests seed ready media by direct SQL when a supported product
  path exists.
- Do not add a compatibility mode for old evidence rows, old retrieval rows,
  old search filters, or old citation URLs.

## Final State

The repository has one canonical real-media corpus and two acceptance gates.

The deterministic real-media gate runs from stored, legally redistributable
artifacts. It uses real app services and a real embedding model. It does not
hit source providers during normal CI; it may hit the configured embedding
provider until a real local embedding profile exists.

The live-provider gate hits external services for the source kinds that depend
on external providers: web URL extraction, supported video transcripts, podcast
RSS/discovery/audio, and external embedding provider if configured for release.
It is not a substitute for the deterministic gate. It proves that the current
provider contracts still work.

Every media item in the deterministic corpus has:

1. A fixture artifact or captured provider artifact with license, source URL,
   content hash, byte length, and expected needles.
2. A source acquisition path that matches product behavior: upload, browser
   capture, URL ingestion, transcript ingestion, or podcast episode ingestion.
3. A complete active evidence index: `source_snapshots`, `content_blocks`,
   `evidence_spans`, `content_chunks`, `content_chunk_parts`, and
   `content_embeddings`.
4. At least one search query that returns a `content_chunk` result scoped to
   the media item.
5. At least one resolver assertion that opens the correct reader location and
   projects the expected answer highlight.
6. At least one scoped chat or app-search assertion that persists retrieval
   metadata, selected evidence spans, prompt inclusion, and rendered citation
   output.
7. At least one saved-highlight assertion where the media kind supports user
   highlights.
8. A trace artifact entry that records every durable id, hash, locator,
   selector, index run, embedding config, search result, context ref, and
   citation/evidence id touched by the test.

No synthetic media fixture is used by Playwright, backend real-media tests, or
release gates. No acceptance test patches an internal repo boundary.

## Target Behavior

### Corpus and source acquisition

- The canonical corpus is declared directly in the real-media tests and fixture
  README files. Do not add a separate manifest layer unless the corpus becomes
  too large to read locally.
- Each fixture declares `media_kind`, source URL, license, local artifact path,
  byte length, SHA-256, expected language, expected title, expected structural
  counts, expected search needles, expected citation needles, and expected
  highlight targets.
- Artifacts are real media or captured real-provider outputs. They are not
  generated for the test suite.
- Fixture ingestion uses the same product entrypoints as users:
  - PDFs and EPUBs use upload and upload-confirm flows.
  - Browser-captured articles use capture APIs with captured HTML from a real
    article.
  - URL-ingested web articles use URL ingestion in the live-provider gate.
  - Supported videos use provider transcript ingestion in the live-provider
    gate and captured real transcript artifacts in the deterministic gate.
  - Podcasts use real RSS episode metadata and real audio or transcript
    artifacts in the deterministic gate, plus live discovery/RSS/audio in the
    provider gate.
- A fixture is invalid if its artifact hash changes without updating the local
  fixture declaration and expected trace assertions.
- The corpus covers common, boundary, and failure cases:
  - Multi-page digital PDF with headings and page labels.
  - PDF with multi-column or layout-sensitive text.
  - PDF with no extractable text that must become `ocr_required` or `no_text`.
  - EPUB 2 and EPUB 3 books with TOC, assets, CSS, anchors, and Unicode.
  - Long web article with headings, links, block quotes, and boilerplate.
  - Browser-captured article with reader-visible canonical text.
  - Video transcript with stable timing and seek targets.
  - Podcast episode with RSS metadata, transcript timing, and highlightable
    text.
  - Reingest case where source content changes and stale index rows must not
    be retrieved.

### Ingest and indexing

- Every successful real-media ingest ends with a ready active index run.
- The active run contains at least one reconstructible source snapshot.
- Every content block belongs to a source snapshot for the same index run and
  has ordered, non-overlapping source offsets within its snapshot.
- Every chunk belongs to the active run and has at least one chunk part.
- Chunk text is exactly reconstructible from ordered chunk parts, including
  inserted separators.
- Every chunk has a primary evidence span and at least one embedding row for
  the active embedding provider, model, dimension, and config hash.
- Every evidence span text is exactly reconstructible from content blocks and
  selectors.
- Resolver metadata is present and kind-specific:
  - Web: source URL, fragment id, canonical text offsets, quote selector.
  - EPUB: section id, href, anchor where available, fragment id, offsets.
  - PDF: physical page, page label where available, quote selector, geometry
    status, source fingerprint.
  - Transcript: version id, segment ids, start/end times, quote selector.
- Failed indexing creates an explicit failed state and does not activate a
  partial index.
- Reingest activates the replacement run atomically and prevents stale chunks,
  stale embeddings, and stale evidence spans from appearing in new search or
  chat retrieval.

### Search

- Real-media search returns only `content_chunk` for text evidence.
- Search validation rejects `fragment`, `transcript_chunk`, direct PDF text,
  and any legacy text evidence result type.
- Keyword, semantic, and hybrid search all use the active evidence index.
- Each result carries evidence span ids, resolver output, citation label,
  context ref, score, snippet, media id, and media kind.
- Snippets are derived from selected evidence spans or chunk text, not from
  raw fragments, direct transcript rows, or `media.plain_text`.
- Permission and library scope filters are applied before ranking.
- Search tests include positive, no-result, no-indexed-evidence,
  failed-index, deleted-media, library-removed, and stale-index cases.

### Reader navigation and highlights

- Search result links open the reader through backend resolver output.
- Chat citations open the same resolver path as search results.
- Temporary evidence highlights render at the expected text or page location
  without creating saved user highlight rows.
- Saved highlights remain product data and are tested separately from evidence
  spans.
- Saved highlights can be created from reader selection for web, EPUB,
  transcript, and PDF where supported.
- Saved highlights can be attached to chat context and source focus without
  mutating evidence spans.
- PDF evidence highlights handle page navigation, zoom, page labels, and
  missing geometry.
- EPUB evidence highlights handle section navigation, anchors, delayed section
  hydration, and reader resume state.
- Transcript evidence highlights seek media playback to the expected segment
  or time range.

### Context, retrieval, and chat

- App search over real indexed media persists `message_tool_calls`,
  `message_retrievals`, selected context refs, evidence span ids, exact
  snippets, retrieval status, and prompt inclusion status.
- Scoped chat over real indexed media persists `message_context_items` for
  selected `content_chunk` refs and evidence span ids.
- Prompt assembly includes chunk text plus selected evidence spans and rejects
  stale evidence spans from a non-active index run.
- Assistant citations render from persisted retrieval/evidence rows, not from
  model-authored location text.
- No-indexed-evidence and no-results cases create explicit persisted statuses.
- Highlight-to-chat and citation-to-chat flows are tested through the browser,
  BFF, backend API, persisted context, prompt assembly, and citation rendering.

### Exports and audit traces

- Full-text export uses ordered `content_blocks`.
- Citation and highlight exports use `evidence_spans`, selectors, and resolver
  labels.
- Every real-media acceptance test writes a trace artifact under the test
  output directory.
- Trace artifacts include fixture id, media id, source snapshot ids, index run
  id, content block ids/hashes, chunk ids/hashes, chunk part ranges, embedding
  provider/model/dimension/config, evidence span ids/selectors, search result
  ids, resolver payloads, highlight ids, message context item ids,
  retrieval ids, citation ids, and export ids where applicable.
- Trace artifacts never contain provider secrets, auth tokens, or full
  copyrighted text beyond allowed short expected needles.

## Test Structure

### Deterministic backend real-media suite

Path: `python/tests/real_media/`

Purpose: API and DB-backed acceptance tests for real artifacts without live
network dependency.

Required files:

- `python/tests/real_media/assertions.py`
- `python/tests/real_media/conftest.py`
- `python/tests/real_media/test_ingest_index_trace.py`
- `python/tests/real_media/test_search_resolver_trace.py`
- `python/tests/real_media/test_context_chat_trace.py`
- `python/tests/real_media/test_reingest_delete_permissions.py`
- `python/tests/real_media/test_exports_trace.py`

Rules:

- Mark with `integration`, `slow`, and a new `real_media` marker.
- Use real PostgreSQL, real FastAPI app, real storage service, real background
  job path or the same task entrypoint workers execute.
- Use a real embedding model. A local deterministic model is acceptable only
  if it is a real embedding model and exercises vector storage/ranking. Hash
  vectors are not acceptable.
- No `monkeypatch` of `nexus.services.*`, ingest tasks, search, embeddings,
  transcript fetchers, BFF behavior, or database sessions.
- DB reads are allowed only through shared trace assertions that prove evidence
  invariants unavailable through product APIs.

### Deterministic Playwright real-media suite

Path: `e2e/tests/real-media/`

Purpose: browser-level user journeys over the same real corpus.

Required files:

- `e2e/tests/real-media/upload-pdf.spec.ts`
- `e2e/tests/real-media/upload-epub.spec.ts`
- `e2e/tests/real-media/captured-web-article.spec.ts`
- `e2e/tests/real-media/video-transcript.spec.ts`
- `e2e/tests/real-media/podcast-episode.spec.ts`
- `e2e/tests/real-media/search-evidence.spec.ts`
- `e2e/tests/real-media/context-chat-citations.spec.ts`
- `e2e/tests/real-media/reingest-delete-permissions.spec.ts`
- `e2e/tests/real-media/exports.spec.ts`

Rules:

- Use the real Next.js BFF, FastAPI, Supabase Auth, Supabase Storage, and
  PostgreSQL stack.
- Seed only by supported product paths or a dedicated backend seed command
  that itself uses product entrypoints.
- Do not insert ready media, fragments, transcripts, highlights, or index rows
  by ad hoc SQL.
- Do not reuse generated `.seed/upload-source.pdf`, generated EPUBs, generated
  article text, generated transcript rows, or generated highlight anchors.
- Browser assertions must prove visible behavior: reader content, evidence
  highlight, saved highlight, search result, chat context, citation, and export
  download.
- API assertions may inspect supported BFF/API responses. DB inspection is
  limited to global readiness probes and trace artifact collection outside the
  browser test body.

### Live-provider suite

Path: `python/tests/live_providers/`

Purpose: prove external contracts for providers used by real ingestion.

Required files:

- `python/tests/live_providers/test_web_url_ingest_live.py`
- `python/tests/live_providers/test_video_transcript_live.py`
- `python/tests/live_providers/test_podcast_episode_live.py`
- `python/tests/live_providers/test_embedding_provider_live.py`

Rules:

- Mark with `network`, `slow`, and `live_provider`.
- Do not skip on missing credentials or unavailable network in the provider
  gate. Fail with a clear prerequisite error.
- Use stable allowlisted sources declared directly in the live-provider tests.
- Persist and index at least one live result per provider category.
- Assert the same evidence trace invariants as the deterministic suite after
  live ingest completes.
- Keep live provider data volume small enough for routine release verification.

### Shared trace assertions

Path: `python/tests/real_media/assertions.py`

The trace assertion layer is the only accepted place for schema-level DB
inspection in real-media acceptance tests.

It must expose:

```python
assert_complete_evidence_trace(media_id, expected_fixture_id) -> EvidenceTrace
assert_search_trace(query, media_id, expected_needle) -> SearchTrace
assert_resolver_trace(media_id, evidence_span_id, expected_target) -> ResolverTrace
assert_context_trace(message_id, expected_context_refs) -> ContextTrace
assert_chat_citation_trace(message_id, expected_evidence_span_ids) -> CitationTrace
assert_saved_highlight_trace(media_id, expected_anchor) -> HighlightTrace
assert_export_trace(export_id, expected_evidence_span_ids) -> ExportTrace
assert_no_legacy_retrieval_trace(scope) -> None
```

Rules:

- Each assertion returns a serializable trace object.
- Trace objects are written as JSON test artifacts.
- Trace assertions fail on missing rows, inactive rows, mismatched hashes,
  stale index runs, partial chunks, missing embeddings, unsupported resolver
  kinds, raw-fragment fallback, raw-transcript fallback, or PDF plain-text
  fallback.
- Trace assertions do not replace user-visible API or browser assertions.

## Architecture

### Corpus declarations

Fixture declarations live next to the tests that use them. Keep them as simple
literal values until real duplication forces extraction.

Required fixture fields when a test declares a reusable fixture:

- `id`
- `media_kind`
- `source_kind`
- `source_url`
- `license`
- `artifact_path`
- `artifact_sha256`
- `artifact_bytes`
- `expected_title`
- `expected_language`
- `expected_min_blocks`
- `expected_min_chunks`
- `expected_min_evidence_spans`
- `expected_min_embeddings`
- `needles`
- `resolver_targets`
- `highlight_targets`
- `export_targets`
- `negative_assertions`

The local test owns expected values. Do not add a new data file only to move
one-use constants out of sight.

### Real artifact storage

Small legally redistributable artifacts live in the repo under
`python/tests/fixtures/real_media/`.

Large artifacts live in configured test object storage and are fetched by hash
through a setup command. A local cache is valid only when the SHA-256 matches
the local fixture declaration.

The repo must not include copyrighted full text, audio, video, or transcript
data without a redistribution license. For copyrighted web/video/podcast
sources, use short expected needles and live-provider tests; do not check in
full captured content unless licensing permits it.

### Embeddings

The real-media deterministic gate uses the real embedding model profile selected
by environment.

Accepted profiles:

- Local model profile: deterministic local model, fixed dimension, no network,
  real vector output.
- External model profile: configured provider, fixed model, fixed dimension,
  network required.

Rejected profiles:

- Hash-vector fake embedding.
- Constant vector embedding.
- Test-only provider that bypasses vector serialization.
- Mocked `build_text_embeddings`.

### Seeding

The existing generated E2E seed path is replaced for real-media acceptance.

New seed command:

```bash
make seed-real-media-e2e
```

Rules:

- It creates or reuses users/libraries through supported setup APIs.
- It uploads real PDFs and EPUBs through the upload service.
- It captures real article artifacts through the capture API.
- It ingests transcript/podcast fixtures through the same backend entrypoint
  used by provider ingestion.
- It waits for jobs or invokes the same worker task entrypoint workers claim.
- It writes `.seed/real-media.json` containing only ids, hashes,
  expected short needles, and trace file paths.
- It never creates ready media by direct SQL except for test user/bootstrap
  records that have no product API.

### Commands and gates

Final command surface:

```bash
make test-real-media
make test-live-providers
make verify-full
```

Rules:

- `make test-real-media` includes deterministic real-media backend and
  Playwright gates.
- `make test-live-providers` remains separate because it requires live
  third-party provider credentials.
- `make verify-full` includes deterministic real-media, live-provider, and
  default E2E gates.
- Release verification includes `make test-live-providers`.
- Provider prerequisite failures are visible failures, not skips.

## Files

### New docs

- `docs/real-media-test-hard-cutover.md`

### Backend test files to add

- `python/tests/real_media/assertions.py`
- `python/tests/real_media/conftest.py`
- `python/tests/real_media/test_ingest_index_trace.py`
- `python/tests/real_media/test_search_resolver_trace.py`
- `python/tests/real_media/test_context_chat_trace.py`
- `python/tests/real_media/test_reingest_delete_permissions.py`
- `python/tests/real_media/test_exports_trace.py`
- `python/tests/live_providers/test_web_url_ingest_live.py`
- `python/tests/live_providers/test_video_transcript_live.py`
- `python/tests/live_providers/test_podcast_episode_live.py`
- `python/tests/live_providers/test_embedding_provider_live.py`

### Backend test files to migrate or delete

- `python/tests/test_real_pdf_ingest.py`
- `python/tests/test_epub_ingest_real_fixtures.py`
- `python/tests/test_real_web_article_ingest.py`
- `python/tests/test_real_youtube_ingest.py`
- `python/tests/test_real_podcast_discovery.py`
- `python/tests/test_real_evidence_indexing_smoke.py`
- Synthetic media acceptance coverage in `python/tests/test_pdf_ingest*.py`
- Synthetic media acceptance coverage in `python/tests/test_epub_ingest*.py`
- Synthetic media acceptance coverage in
  `python/tests/test_ingest_web_article.py`
- Synthetic transcript acceptance coverage in
  `python/tests/test_ingest_youtube_video.py`
- Synthetic podcast/transcript acceptance coverage in
  `python/tests/test_podcasts.py`
- Synthetic retrieval/context acceptance coverage in
  `python/tests/test_context_lookup.py`,
  `python/tests/test_context_assembler.py`,
  `python/tests/test_agent_app_search.py`, and
  `python/tests/test_chat_runs.py`

These files may keep pure unit or schema tests where they do not claim
real-media acceptance. Any test that claims media/evidence acceptance moves to
the real-media suite or is deleted.

### Frontend and E2E files to add

- `e2e/tests/real-media/upload-pdf.spec.ts`
- `e2e/tests/real-media/upload-epub.spec.ts`
- `e2e/tests/real-media/captured-web-article.spec.ts`
- `e2e/tests/real-media/video-transcript.spec.ts`
- `e2e/tests/real-media/podcast-episode.spec.ts`
- `e2e/tests/real-media/search-evidence.spec.ts`
- `e2e/tests/real-media/context-chat-citations.spec.ts`
- `e2e/tests/real-media/reingest-delete-permissions.spec.ts`
- `e2e/tests/real-media/exports.spec.ts`
- `apps/web/src/test/real-media/` component/browser tests for resolver and
  temporary evidence highlight rendering where Playwright coverage needs
  tighter failure localization.

### Frontend and E2E files to migrate or delete

- Generated media behavior in `python/scripts/seed_e2e_data.py`
- `.seed/upload-source.pdf` generation and generated EPUB fixture generation
- Synthetic web article seeding in `python/scripts/seed_e2e_data.py`
- Synthetic YouTube transcript row seeding in
  `python/scripts/seed_e2e_data.py`
- Synthetic reader-resume media seeding in `python/scripts/seed_e2e_data.py`
- Synthetic acceptance tests in `e2e/tests/pdf-reader.spec.ts`
- Synthetic acceptance tests in `e2e/tests/epub.spec.ts`
- Synthetic acceptance tests in `e2e/tests/web-articles.spec.ts`
- Synthetic acceptance tests in `e2e/tests/youtube-transcript.spec.ts`
- Search/context tests that pass only because seeded synthetic content exists

Existing files may retain non-acceptance UI smoke tests only if they do not
claim media/evidence completeness.

### Tooling files to modify

- `Makefile`
- `python/pyproject.toml`
- `e2e/playwright.config.ts`
- `e2e/global-setup.mjs`
- `README.md`
- `.github/workflows/*`
- `scripts/with_test_services.sh`
- `scripts/with_supabase_services.sh`
- Any test artifact upload configuration in CI

## Key Decisions

- Real-media acceptance is a product contract, not parser smoke coverage.
- Stored deterministic artifacts and live provider tests are both required.
  Stored artifacts prove regressions deterministically; live providers prove
  current external contracts.
- Keep fixture-specific expected values in the local test until duplication
  forces extraction.
- A real local embedding model is acceptable for deterministic CI; fake hash
  vectors are not.
- DB trace inspection is allowed only in shared audit helpers, because the
  product API does not expose all evidence invariants.
- Playwright tests prove user-visible behavior and do not become schema tests.
- Provider tests fail on missing prerequisites in the provider gate. They do
  not turn unavailable credentials into a passing skip.
- Legacy result types are rejected in tests and runtime. There is no backward
  compatibility assertion for old search filters or old citation URLs.
- Synthetic tests are deleted or demoted when touched. They cannot remain as a
  parallel acceptance suite.
- Every real-media test produces a trace artifact so failure analysis can
  identify the broken artifact, index run, chunk, evidence span, resolver,
  retrieval, context, citation, or highlight.

## Acceptance Criteria

### Corpus

- [ ] Real-media fixture declarations validate all fixture hashes.
- [ ] Every fixture has a documented license and source URL.
- [ ] The corpus includes real PDF, EPUB, web article, browser-captured
      article, video transcript, podcast episode transcript, no-text/OCR PDF,
      and reingest fixtures.
- [ ] No generated PDF, generated EPUB, generated article, generated
      transcript, or generated podcast fixture is used by acceptance tests.
- [ ] Large artifact setup fails when an artifact is missing or hash-mismatched.

### Backend ingest and index

- [ ] Each real source kind ingests through the product entrypoint.
- [ ] Each successful ingest creates a ready active index run.
- [ ] Each active run has reconstructible source snapshots, ordered blocks,
      evidence spans, chunks, chunk parts, and embeddings.
- [ ] Chunk text reconstructs exactly from chunk parts.
- [ ] Evidence span text reconstructs exactly from blocks and selectors.
- [ ] Embeddings use a real model profile and correct dimension/config.
- [ ] No-text/OCR-required PDFs produce explicit terminal index state.
- [ ] Failed index attempts do not activate partial artifacts.
- [ ] Reingest prevents stale chunks/spans/embeddings from new retrieval.
- [ ] Media deletion removes retrievable evidence artifacts.
- [ ] Library removal hides evidence from removed scopes without deleting media
      evidence.

### Search and resolver

- [ ] Search returns `content_chunk` results for all text-bearing source kinds.
- [ ] Search rejects `fragment`, `transcript_chunk`, and direct PDF text result
      filters.
- [ ] Search snippets, citation labels, context refs, and deep links are
      resolver-backed.
- [ ] Resolver payloads open the correct web, EPUB, PDF, transcript, and
      podcast locations.
- [ ] Resolver output projects expected temporary evidence highlights.
- [ ] No search path reads raw fragments, transcript rows, or `media.plain_text`
      as fallback evidence.

### Context and chat

- [ ] App search over real media persists retrieval rows with chunk ids,
      evidence span ids, exact snippets, and status.
- [ ] Scoped chat over real media persists message context items with selected
      `content_chunk` refs and evidence span ids.
- [ ] Prompt assembly includes chunk text and selected evidence spans.
- [ ] Stale evidence spans from inactive index runs are rejected.
- [ ] Assistant citations render from persisted evidence rows.
- [ ] No-indexed-evidence and no-results cases persist explicit statuses.
- [ ] Highlight-to-chat and citation-to-chat flows work through browser, BFF,
      backend, context persistence, prompt assembly, and rendered citations.

### Reader, highlights, and exports

- [ ] Search and chat citation links open the reader through resolver output.
- [ ] Temporary evidence highlights render for web, EPUB, PDF, transcript, and
      podcast transcript.
- [ ] Saved highlights can be created from reader selection where supported.
- [ ] Saved highlights can be attached to chat context without mutating
      evidence spans.
- [ ] PDF highlights remain page/zoom scoped and handle missing geometry.
- [ ] EPUB highlights survive section navigation and delayed hydration.
- [ ] Transcript highlights seek to the expected time range.
- [ ] Full-text exports are block-derived.
- [ ] Citation/highlight exports are evidence-span and selector derived.

### E2E

- [ ] Playwright uploads real PDF and EPUB artifacts through the UI.
- [ ] Playwright captures or opens real article artifacts without synthetic
      seeded bodies.
- [ ] Playwright covers real video transcript and podcast episode transcript
      reader flows.
- [ ] Playwright search opens resolver-backed evidence results for every media
      kind.
- [ ] Playwright chat context and citation flows persist backend evidence
      state.
- [ ] Playwright tests do not seed ready media, transcript rows, highlights, or
      indexes by direct SQL.
- [ ] Playwright trace-on-failure is supplemented by evidence trace artifacts.

### Live providers

- [ ] Live web URL ingestion persists and indexes at least one allowlisted
      article.
- [ ] Live supported-video ingestion persists and indexes at least one
      allowlisted transcript.
- [ ] Live podcast discovery/RSS/audio/transcript ingestion persists and
      indexes at least one allowlisted episode.
- [ ] Live embedding provider test stores vectors with the configured
      provider/model/dimension.
- [ ] Missing credentials, network, or provider prerequisites fail the
      provider gate with actionable messages.

### Cleanup

- [ ] Synthetic media acceptance tests are deleted or demoted out of the
      acceptance gates.
- [ ] Old generated E2E seed media is removed from real-media paths.
- [ ] `make verify-full` includes deterministic real-media backend and E2E
      gates through `make test-real-media`.
- [ ] Release verification includes the live-provider gate.
- [ ] CI uploads real-media trace artifacts on failure.
- [ ] Documentation and README command lists point to the new gates.

## Cutover Sequence

1. Land the corpus declarations, artifact storage setup, validation command, and
   real embedding profile.
2. Build shared trace assertions and make them fail against one existing
   synthetic path.
3. Add backend deterministic real-media ingest/index tests for PDF, EPUB, web
   capture, transcript, podcast transcript, no-text PDF, and reingest.
4. Add backend search/resolver/context/chat/export tests over the same corpus.
5. Replace generated E2E seeding with real-media seeding through product
   entrypoints.
6. Add Playwright real-media upload, reader, search, highlight, context, chat,
   citation, permission, deletion, and export flows.
7. Add live-provider tests and make provider prerequisites explicit.
8. Delete or demote synthetic media acceptance tests and generated E2E media.
9. Update Makefile, pytest markers, Playwright setup, CI, and README command
   references.
10. Run the full deterministic and live-provider gates.

The branch is not complete while any media/evidence acceptance claim still
depends on generated content, internal mocks, hash embeddings, legacy result
types, raw text fallbacks, or skipped provider coverage.
