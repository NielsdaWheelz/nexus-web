# Black Forest Oracle Hard Cutover

## Role

This document is the target-state plan for the **Black Forest Oracle**, a
single-question divination experience that answers a user's question with a
hybrid composition of passages from the user's own library, passages from a
curated public-domain corpus, a public-domain plate, and an LLM-synthesized
reading rendered as an illuminated marginalia page.

The implementation is a hard cutover. The final state keeps no feature flag,
no compatibility shim, no fallback path that bypasses the citation-integrity
contract, no parallel "v1 keyword / v2 semantic" retrieval mode, and no
partial corpus state. The oracle ships with a complete, frozen corpus and a
complete, frozen image index, or it does not ship.

Citation contracts continue to follow the evidence model established by
`MessageClaim` and `MessageClaimEvidence` in `python/nexus/schemas/conversation.py`
and the citation rules in `docs/rules/`. Prompt construction continues to
follow the `PromptPlan` + `PromptBlock.cache_policy` contract in
`python/nexus/services/chat_prompt.py`. SSE replay continues to follow the
pattern in `python/nexus/api/routes/stream.py`.

## Goals

- One divination capability with one public entry point: an authenticated
  `/oracle` route with a single ask box and a single reading page per
  generated reading.
- Hybrid retrieval that draws passages from both the user's library and a
  curated public-domain corpus in the same ranked candidate set.
- Citations whose quoted text is verbatim from a retrieved passage and whose
  locator (canto, line, chapter, verse, page) is computed from the corpus
  index, never produced by the model.
- One image plate per reading drawn from a curated, license-attributed
  public-domain image index.
- A scoped, distinctive visual treatment for the oracle route only:
  illuminated typography, sepia/gold/cream/maroon palette, full-bleed plate,
  marginalia gutter, slow reveal driven by SSE.
- Reuse of the existing LLM router, prompt cache control, SSE replay
  transport, image proxy, and worker job queue patterns.
- Deterministic, replayable readings via versioned prompt and corpus
  identities, mirroring the `prompt_version` + `source_set_version_id`
  contract used by `LibraryIntelligenceVersion`.

## Non-Goals

- Do not introduce multi-turn dialogue with the oracle. One reading per
  question. No follow-ups, no "draw another card" within a reading.
- Do not add user-uploaded corpus extension, user-curated decks, or any
  user-editable oracle configuration.
- Do not add full-text search, browse, or general retrieval surfaces over the
  public-domain corpus. The corpus is reachable only by oracle generation.
- Do not introduce a third-party search service, vector DB, or external LLM
  provider beyond what `LLMRouter` already exposes.
- Do not extend `LibraryIntelligenceArtifact`/`LibraryIntelligenceVersion`/
  `LibraryIntelligenceSection` with an `oracle_reading` artifact kind. The
  artifact pointer model is built around one current synthesis per library;
  oracle readings are per-question events with their own lifecycle.
- Do not reuse `Conversation`/`Message`/`MessageClaim` tables. The oracle is
  not a chat skin. Schema reuse is at the level of fields and shapes, not
  tables.
- Do not store readings indefinitely with sharing, public links, or
  cross-user discoverability in this cutover.
- Do not accept translations of public-domain works whose translation is
  itself under copyright. Editions are pinned per work.
- Do not preserve any "fall back to plain chat if oracle fails" behavior.
  Failed readings render a feedback notice through the existing feedback
  layer (`docs/feedback-layer-hard-cutover.md`) and offer a single retry.
- Do not display `ApiError.message` directly. Errors route through the
  feedback layer.

## Final State

A new authenticated route exists at `/oracle`. Its single client-rendered
form takes one question (max 280 characters) and submits it. The submission
creates one `oracle_reading` row, enqueues one `oracle_reading_generate`
background job, and navigates to `/oracle/{readingId}`.

The reading page consumes an SSE stream, replaying events that:

1. Echo the question.
2. Reveal one image plate.
3. Reveal three to five quoted passages, interleaved with streamed
   interpretation text.
4. Render marginalia footnotes in the gutter for every passage.
5. Conclude with an "omens" coda containing optional cross-source
   resonances.

The reading is durable. Reloading the page replays the same SSE stream from
the persisted event log. The user can return to any prior reading from a
`/oracle` recent-readings list scoped to that user.

The oracle scope is its own theme on its own route. The rest of the app is
visually unchanged.

The corpus and image index are versioned, code-shipped, and immutable for a
release. New corpus releases land as new migrations and new
`oracle_corpus_set_version` rows.

## Target Behavior

### Ask flow

- The user lands on `/oracle`.
- The page renders an ask box, a brief epigraph, and a list of the user's
  recent readings (most recent five, link-only).
- Submitting the form posts to `/api/oracle/readings`.
- The BFF proxies to `POST /oracle/readings` on FastAPI.
- The backend validates the question, enqueues a job, persists an
  `oracle_reading` row in `pending` state, and returns the reading id and a
  stream token URL.
- The frontend navigates to `/oracle/{readingId}`.

### Reading flow

- The reading page mints a stream token, opens
  `GET /stream/oracle-readings/{id}/events?after=0`, and renders events as
  they arrive.
- The page is server-rendered with the question and pending state on first
  paint, then hydrates the SSE consumer.
- If the SSE socket disconnects, the consumer reconnects with `Last-Event-ID`
  using the standard SSE replay contract.
- When the worker emits a `done` event, the consumer stops. Reloading at
  that point still works because the event log is durable.
- A failed reading emits a single `error` event. The reading page renders a
  feedback notice and offers one retry button that posts a fresh
  `oracle_readings` request with the same question.

### Visual reveal

- Events arrive in this order, gated on backend progress:
  `meta` → `plate` → repeated (`passage` → `delta`) pairs → `marginalia`
  events tied to passage ids → `omens` → `done`.
- Each new event triggers an entrance animation in the page; the page never
  reflows after an event lands. Vertical space is reserved by skeleton slots
  before content arrives.
- The plate occupies a full-bleed slot with caption block beneath; the
  caption renders attribution.
- Each passage is a serif blockquote with a drop cap on the first letter of
  the first word and a small superscript marker pointing at its marginalia
  footnote in the right gutter at desktop width or below the passage at
  narrow widths.
- Streaming interpretation text appears between passages as a serif body
  paragraph. Tokens arrive via `delta` events.
- The omens coda is a closing list of named correspondences (motifs that
  recur across the chosen passages or between corpus and library).

### Acceptable reading shape

- Three to five passages.
- At least one passage from the user's library when the user has any
  ingested media; the rest from the public-domain corpus.
- One plate.
- One coda with one to three omen lines.
- Total visible reading length under 1,200 words excluding quoted passages.

## Severity and Feedback

The oracle uses the unified feedback layer documented in
`docs/feedback-layer-hard-cutover.md`. The oracle has no internal toast,
error string, or status pill of its own.

- Validation of the ask box is a `field` feedback event.
- Backend rejection (rate limit, ineligible corpus, no library passages and
  no public-domain match) is `inline` feedback in the reading pane.
- Stream disconnects exceeding the standard reconnection budget surface as
  `inline` feedback with a retry action.
- Successful completion is implicit; no toast.

## Citation Integrity Rules

These rules are the central correctness contract.

- Every quoted text fragment shown to the user must be a verbatim substring
  of an indexed passage in the corpus or the user's `Fragment.canonical_text`.
  The backend rejects any LLM output that fails substring verification.
- Every locator string shown to the user (canto and line, chapter, verse,
  page, paragraph) is composed by the backend from the indexed passage, not
  by the model. The model receives passage ids and short labels, never the
  raw locator template, and never the freedom to mint locator text.
- Every public-domain image carries a stored attribution string sourced from
  the image manifest at index time. The model never produces image
  attribution.
- Every public-domain text passage carries a stored edition record (work
  title, author, year, source repository, edition identifier). The model
  receives a short edition label and the index id; it cannot mint edition
  details.
- The oracle prompt forbids the model from producing inline citation
  markers, footnote numbers, or URLs. The model produces interpretation
  prose and a final structured selection of which passage ids and which
  marginalia notes to render. The backend composes the final visible
  citation envelope from indexed records.
- Translations are pinned per work. The corpus seed records the chosen
  edition per work and never serves any other edition.
- A reading whose passage selection cannot pass substring verification fails
  the job and emits an `error` event. No partial reading is rendered.

## Corpus Curation Rules

The public-domain corpus is curated, finite, and code-shipped.

- Source of record for prose and verse is **Standard Ebooks** wherever a
  Standard Ebooks edition exists for a work on the canonical list.
  Standard Ebooks source files are CC0; their quality and semantic markup
  make canonical line and section references stable.
- Where Standard Ebooks does not yet have a work, the source of record is
  **Project Gutenberg** with the standard PG header and footer stripped.
  Gutenberg files are pre-fetched once per release from
  `gutenberg.pglaf.org` or `aleph.gutenberg.org`. The oracle never fetches
  from `gutenberg.org` at request time.
- The canonical work list for the first release is fixed in
  `python/nexus/services/oracle_corpus.py` as a constant. The list contains
  Dante (Longfellow translation), Milton, Blake, Poe, Mary Shelley, Percy
  Shelley, Byron, Coleridge, Keats, Melville, Hawthorne, Dickinson,
  Whitman, Christina Rossetti, and the King James Bible. Additions land in
  later releases as new migrations.
- Every work has one and only one edition recorded. Translations whose
  copyright is uncertain are excluded.
- Every passage row carries: `work_id`, `passage_id`, `canonical_text`,
  `locator_canto`, `locator_line_start`, `locator_line_end`, `locator_book`,
  `locator_chapter`, `locator_verse`, `locator_section`, `locator_paragraph`,
  `tags` (mood, motif, season, element), `embedding`, `embedding_model`,
  `corpus_set_version_id`. Unused locator columns are nullable.
- Embeddings are produced by the same OpenAI embedding model already used
  in `python/nexus/services/semantic_chunks.py`. Test mode embeddings remain
  deterministic hash-based and the corpus seed accepts a test-mode flag.

## Image Index Curation Rules

The public-domain image index is curated, finite, and code-shipped.

- Sources of record are **Wikimedia Commons** and **Internet Archive**.
  The Met Open Access API is permitted for occasional Old Master plates
  but is not the primary source for engravings.
- Every image row carries: `image_id`, `source_repository`, `source_url`,
  `cdn_url`, `iiif_manifest_url` (nullable), `artist`, `work_title`, `year`,
  `license`, `attribution_text`, `width`, `height`, `tags` (mood, motif,
  element), `embedding` (over title and tags), `corpus_set_version_id`.
- Every image is hot-served at render time through the existing image
  proxy in `python/nexus/api/routes/media.py`. The oracle never embeds
  third-party CDN URLs in user-facing HTML.
- Plates derived from copyrighted scans of public-domain works (rare, e.g.,
  recent reproductions) are excluded. Wikimedia "PD-Art" tagged plates are
  permitted; their `extmetadata.LicenseShortName` is captured at index time.
- Attribution renders in the plate caption: artist, work title, year, source
  repository.

## Caching and Replayability Rules

- The oracle prompt is assembled with explicit `cache_policy` directives
  matching the `CACHE_POLICY_5M` pattern in `python/nexus/services/chat_prompt.py`.
  The static voice block, the corpus instructions, and the curated passage
  candidates are cached; the dynamic question is uncached.
- Each generated reading stores a `prompt_version`, a
  `corpus_set_version_id`, and a `provider_request_hash` derived by the same
  hashing helpers used by `PromptPlan`. Two identical inputs produce the
  same hash.
- Re-running the same question deliberately produces a fresh reading; the
  oracle is not a cache hit and never reuses a prior reading. Cache control
  is for prompt prefix economy, not output reuse.

## Streaming Rules

- The transport is the existing SSE replay pattern. A new endpoint
  `GET /stream/oracle-readings/{reading_id}/events` mirrors
  `GET /stream/chat-runs/{run_id}/events` in idle TTL, keepalive cadence,
  cursor handling, and `Last-Event-ID` semantics.
- The stream-token contract in `python/nexus/auth/stream_token.py` is
  reused. A new viewer assertion verifies that the requesting user owns the
  reading.
- The event log is persisted in `oracle_reading_events` with the same
  `seq` + `event_type` + `payload` shape used by chat run events.
- Event types are exactly: `meta`, `plate`, `passage`, `delta`,
  `marginalia`, `omens`, `error`, `done`. No other types are emitted.
- A reading's terminal state is one of `done` or `error`. After terminal
  state, the SSE handler closes the response.

## Visual Design Rules

The oracle theme is scoped to the `/oracle` subtree.

- The oracle root applies `data-theme="oracle"`. CSS variables under the
  selector `[data-theme="oracle"]` are added to `apps/web/src/app/globals.css`.
  Variables include `--oracle-bg`, `--oracle-bg-elevated`, `--oracle-fg`,
  `--oracle-fg-muted`, `--oracle-rule`, `--oracle-gold`, `--oracle-cream`,
  `--oracle-maroon`, `--oracle-marginalia-fg`.
- The oracle uses three new typefaces, loaded via `next/font/google`:
  - **EB Garamond** for body and quoted passages.
  - **IM Fell English** for headers and the omens coda.
  - **UnifrakturMaguntia** for the title-screen epigraph and the section
    initials only. Never used in body copy.
- Drop caps render as a styled span on the first character of each
  passage. No SVG, no images.
- The marginalia component renders in a right gutter at viewport widths
  greater than or equal to the desktop breakpoint, and inline beneath the
  passage at narrower widths.
- Reveal animations are CSS keyframes added to the oracle module CSS only.
  No global animation tokens are added.
- The oracle uses `prefers-reduced-motion` to disable reveal animations.
- The oracle never renders a navbar variant, badge, or callout outside the
  `/oracle` subtree.

## Architecture

### Backend new files

```text
python/nexus/schemas/oracle.py
python/nexus/services/oracle.py
python/nexus/services/oracle_corpus.py
python/nexus/services/oracle_prompt.py
python/nexus/services/oracle_retrieval.py
python/nexus/services/oracle_citation.py
python/nexus/api/routes/oracle.py
python/nexus/tasks/oracle_reading.py
```

### Backend extended files

```text
python/nexus/db/models.py            # new ORM rows
python/nexus/api/routes/stream.py    # add /stream/oracle-readings/{id}/events
python/nexus/api/routes/__init__.py  # register oracle router
python/nexus/jobs/queue.py           # register oracle_reading_generate
python/nexus/app.py                  # wire oracle service into app.state if needed
python/nexus/auth/stream_token.py    # extend viewer assertion to oracle scope
```

### Migrations

```text
migrations/0NNN_oracle_corpus.py
migrations/0NNN_oracle_readings.py
```

### Corpus seed scripts

```text
scripts/oracle/build_corpus.py
scripts/oracle/build_image_index.py
scripts/oracle/manifests/works.json
scripts/oracle/manifests/plates.json
```

The seed scripts are the only entry points that write to the corpus and
image index. They are idempotent on `corpus_set_version_id`. They run as
part of release seeding, not in production runtime.

### Frontend new files

```text
apps/web/src/app/(authenticated)/oracle/page.tsx
apps/web/src/app/(authenticated)/oracle/page.module.css
apps/web/src/app/(authenticated)/oracle/[readingId]/page.tsx
apps/web/src/app/(authenticated)/oracle/[readingId]/OracleReadingClient.tsx
apps/web/src/app/api/oracle/readings/route.ts
apps/web/src/app/api/oracle/readings/[id]/route.ts
apps/web/src/components/oracle/OracleAskBox.tsx
apps/web/src/components/oracle/OracleReading.tsx
apps/web/src/components/oracle/OraclePassage.tsx
apps/web/src/components/oracle/OraclePlate.tsx
apps/web/src/components/oracle/OracleMarginalia.tsx
apps/web/src/components/oracle/OracleDropCap.tsx
apps/web/src/components/oracle/oracle.module.css
apps/web/src/lib/oracle/streamReading.ts
apps/web/src/lib/oracle/types.ts
```

### Frontend extended files

```text
apps/web/src/app/layout.tsx          # load EB Garamond, IM Fell English, UnifrakturMaguntia
apps/web/src/app/globals.css         # [data-theme="oracle"] tokens
apps/web/src/components/Navbar.tsx   # add Oracle entry to authenticated nav
```

## Data Model

### Public-domain corpus tables

```text
oracle_corpus_set_versions
  id, version, label, embedding_model, created_at

oracle_corpus_works
  id, corpus_set_version_id, slug, title, author, year, edition_label,
  source_repository, source_identifier, edition_url, copyright_status

oracle_corpus_passages
  id, corpus_set_version_id, work_id, passage_index,
  canonical_text, length_chars,
  locator_canto, locator_line_start, locator_line_end,
  locator_book, locator_chapter, locator_verse,
  locator_section, locator_paragraph,
  tags, mood, motifs, season, element,
  embedding, embedding_model

oracle_corpus_images
  id, corpus_set_version_id, source_repository, source_url, cdn_url,
  iiif_manifest_url, artist, work_title, year,
  license, attribution_text, width, height,
  tags, mood, motifs, embedding, embedding_model
```

Passages are immutable per `corpus_set_version_id`. A new release adds a new
version row and inserts a new passage set; old versions remain queryable for
replay of historic readings.

### Reading tables

```text
oracle_readings
  id, user_id, library_id, status, question_text, question_hash,
  corpus_set_version_id, prompt_version, provider_request_hash,
  generator_model_id, started_at, completed_at, failed_at, error_code

oracle_reading_passages
  id, reading_id, ordinal, source_kind ('user_media' | 'public_domain'),
  source_ref (jsonb), exact_snippet, snippet_prefix, snippet_suffix,
  locator (jsonb), deep_link, score, attribution_text

oracle_reading_images
  id, reading_id, ordinal, oracle_corpus_image_id, attribution_text,
  source_url, cdn_url

oracle_reading_marginalia
  id, reading_id, passage_ordinal, text, motif

oracle_reading_events
  id, reading_id, seq, event_type, payload (jsonb), created_at
```

`source_ref`, `locator`, `exact_snippet`, `snippet_prefix`,
`snippet_suffix`, `deep_link`, `score`, and `attribution_text` mirror the
field names already used by `MessageClaimEvidenceOut` so frontend rendering
can share helpers.

`oracle_reading_events` mirrors the chat run event log shape and
`assert_chat_run_owner`-style ownership checks. The new SSE handler reads
this table.

`status` values: `pending`, `streaming`, `complete`, `failed`. Constraints:
`(status = 'complete' AND completed_at IS NOT NULL)` and
`(status = 'failed' AND failed_at IS NOT NULL)`.

### Schema constraints

- `oracle_readings.question_text` length is `BETWEEN 1 AND 280`.
- `oracle_readings.prompt_version` length is `BETWEEN 1 AND 128`.
- `oracle_reading_passages.ordinal` is unique per `reading_id`.
- `oracle_reading_events.seq` is unique per `reading_id`, monotonic.
- `oracle_corpus_passages.embedding` length matches the embedding model
  recorded on `oracle_corpus_set_versions`.

## Backend Service Layer

`oracle_corpus.py` exposes the canonical work list, edition pinning, and
read-only queries against `oracle_corpus_works`/`oracle_corpus_passages`.

`oracle_retrieval.py` produces a unified candidate set from:

- The user's `content_chunks` filtered by their accessible libraries.
- The active `oracle_corpus_passages`.

Ranking uses cosine similarity against the question embedding plus a
curation prior on tags. Top-N candidates per source kind are returned.
Diversification ensures no two candidates come from the same work or chunk
chain. The retrieval interface returns immutable candidate records carrying
all locator and attribution fields.

`oracle_prompt.py` builds a `PromptPlan` whose stable blocks are:

1. The oracle voice instructions.
2. The corpus instructions and rendering schema.
3. The retrieved candidate set, formatted with passage ids only.

The dynamic block is the user's question. `cache_policy` is set per
`CACHE_POLICY_5M` for stable blocks. `prompt_version` is a string constant
in this module; bumping it requires a new release.

`oracle_citation.py` performs:

- Verbatim substring verification of every quoted span in the model output
  against the candidate it cites.
- Locator composition from the candidate's stored locator fields.
- Attribution text composition from the candidate's stored edition or
  image attribution fields.
- Marginalia note assembly tied to candidate ids.

`oracle.py` orchestrates the reading lifecycle: enqueue, claim, retrieve,
prompt, stream, verify, persist, emit events, terminal status transition.

`tasks/oracle_reading.py` is the worker entrypoint. It calls into
`oracle.py` and writes `oracle_reading_events` rows in the same shape the
SSE handler reads.

## API Surface

```text
POST   /oracle/readings                 -> { id, stream_token_url }
GET    /oracle/readings                 -> recent readings for the viewer
GET    /oracle/readings/{id}            -> reading record + persisted events for hydration
GET    /stream/oracle-readings/{id}/events  -> SSE replay
```

BFF routes proxy each REST endpoint into FastAPI through the existing
`proxyToFastAPI` helper. The SSE endpoint is reached directly with a stream
token, not through the BFF, mirroring chat run streaming.

`POST /oracle/readings` accepts:

```json
{
  "question": "what am i afraid of?"
}
```

It returns:

```json
{
  "reading_id": "uuid",
  "stream_token_url": "https://...",
  "status": "pending"
}
```

`GET /oracle/readings/{id}` returns the persisted record plus the full
event payload list for first-paint hydration. The response uses the
existing API envelope.

## Worker Job

A new `background_jobs.kind` value `oracle_reading_generate` is registered.
The handler in `python/nexus/tasks/oracle_reading.py` follows the structure
of `python/nexus/tasks/chat_run.py`:

- Claim the job.
- Load the reading.
- Run retrieval.
- Build the prompt.
- Open an LLM stream via `LLMRouter`.
- Emit `meta`, `plate`, `passage`, `delta`, `marginalia`, `omens` events as
  generation proceeds.
- Run citation integrity checks before emitting any `passage` or
  `marginalia` event.
- Persist final passages, image, and marginalia rows.
- Emit `done` and transition status to `complete`.

A failure at any stage emits a single `error` event with a stable error code
and transitions status to `failed`. The handler does not retry. A retry is a
new reading initiated by the user.

## Frontend Layer

`OracleAskBox` renders the form and submits via `apiFetch`. The component
is a client component. It uses field feedback for validation.

`OracleReadingClient` mounts on `/oracle/{readingId}` and:

- Receives the persisted reading and existing events as server props for
  first paint.
- Continues the SSE stream from the last persisted `seq` using
  `streamReading.ts`, which mirrors `useChatRunTail.ts` patterns.
- Renders events into structured slots (`OraclePassage`, `OraclePlate`,
  `OracleMarginalia`).

`oracle.module.css` owns the scoped theme application, including the
`[data-theme="oracle"]` block, drop cap styling, and reveal keyframes.

The Navbar adds a single new entry, gated only by authentication. No
permission flag, no tier gating in this cutover.

## Tests

### Backend tests

```text
python/tests/services/test_oracle_corpus.py
python/tests/services/test_oracle_retrieval.py
python/tests/services/test_oracle_prompt.py
python/tests/services/test_oracle_citation.py
python/tests/api/test_oracle_routes.py
python/tests/api/test_oracle_stream.py
python/tests/tasks/test_oracle_reading_task.py
python/tests/migrations/test_oracle_migrations.py
```

Required cases:

- Citation integrity: a synthetic LLM response that tries to mint a fake
  locator must be rejected; a response that paraphrases instead of quoting
  must be rejected; a response that quotes verbatim with a valid passage id
  must pass.
- Retrieval: queries return a mixed candidate set when the user has library
  content; queries return only public-domain candidates for users with no
  ingested media.
- Prompt: stable blocks share `stable_prefix_hash` across two readings with
  the same question and user library state; the dynamic block changes the
  `provider_request_hash`.
- Stream: replay from `seq=0` returns the full event log; replay from a
  late cursor returns only later events; ownership check rejects another
  user.
- Migration: seeding twice with the same `corpus_set_version` is a no-op;
  seeding a new version retains old version rows.
- Job: a failure emits exactly one `error` event and one terminal status
  transition; a success emits exactly one `done` event.

### Frontend tests

```text
apps/web/src/__tests__/components/oracle/OracleAskBox.test.tsx
apps/web/src/__tests__/components/oracle/OracleReading.test.tsx
apps/web/src/__tests__/lib/oracle/streamReading.test.ts
```

Required cases:

- Validation rejects empty and over-length questions through field feedback.
- Reading hydrates from server props, then continues SSE from the next
  cursor.
- Reveal animations honor `prefers-reduced-motion`.
- Marginalia render in the gutter at desktop widths and inline at narrow
  widths.

### E2E

```text
e2e/specs/oracle-reading.spec.ts
```

Required flow:

- Authenticated user submits a question, navigates to the reading page,
  observes events arriving via SSE, observes the plate, three passages,
  marginalia, omens, and `done`. Reload mid-stream and confirm replay
  resumes from the last cursor.

## Required Zero-Result Checks

```sh
rg "oracle_reading.*kind.*=" apps/web/src   # no client-side hardcoded kinds
rg "metmuseum\.org|wikimedia\.org" apps/web/src   # no third-party CDN strings in client
rg "fetch\(\"https://www\.gutenberg\.org" python/nexus   # never fetch live PG
rg "NEW_TAB|window.open" apps/web/src/components/oracle   # no nav escapes from oracle theme
rg "ApiError.*\.message" apps/web/src/components/oracle   # no raw error display
rg "danger" apps/web/src/components/oracle apps/web/src/app/\(authenticated\)/oracle
```

## Observability

- Each reading logs: `reading_id`, `user_id`, `corpus_set_version_id`,
  `prompt_version`, `provider_request_hash`, `cacheable_input_tokens_estimate`,
  retrieval latency, LLM latency, citation verification outcome, terminal
  status.
- The job handler logs a structured event per state transition.
- Citation verification failures log the offending passage id and the
  failing snippet length, never the full LLM output.

## Cutover Plan

The branch is unmerged until every step passes.

### 1. Land schema and migrations

- Add ORM rows to `python/nexus/db/models.py`.
- Add `migrations/0NNN_oracle_corpus.py` and `migrations/0NNN_oracle_readings.py`.
- Add `python/tests/migrations/test_oracle_migrations.py`.
- `make test-migrations` passes.

### 2. Land corpus and image seed

- Add `scripts/oracle/manifests/works.json` and `plates.json`.
- Add `scripts/oracle/build_corpus.py` and `build_image_index.py`.
- Run the seed scripts in dev. The corpus and image index are populated.
- Add unit coverage for the seed pipelines.

### 3. Land backend service layer

- Add `oracle_corpus.py`, `oracle_retrieval.py`, `oracle_prompt.py`,
  `oracle_citation.py`, `oracle.py`.
- Add tests for retrieval, prompt assembly, and citation integrity.
- `make test-back-unit` passes.

### 4. Land worker job

- Add `tasks/oracle_reading.py`.
- Register the job kind in `jobs/queue.py`.
- Add task tests.

### 5. Land API and SSE

- Add `api/routes/oracle.py`.
- Extend `api/routes/stream.py` with the oracle stream endpoint.
- Wire the oracle router in `api/routes/__init__.py`.
- Add API tests for routes and stream.
- `make test-back-integration` passes.

### 6. Land frontend ask and reading

- Add `apps/web/src/app/(authenticated)/oracle/*`.
- Add `apps/web/src/components/oracle/*` and CSS module.
- Add `lib/oracle/streamReading.ts`.
- Add fonts and `[data-theme="oracle"]` tokens.
- Add navbar entry.
- Add component and stream tests.
- `make test-front-unit` and `make test-front-browser` pass.

### 7. Land E2E

- Add `e2e/specs/oracle-reading.spec.ts`.
- `./scripts/with_supabase_services.sh make test-e2e` passes.

### 8. Verify

- `make verify-full` passes.
- `make audit` passes.
- `make test-real` passes.
- All zero-result checks pass.

### 9. Document

- After implementation, distill durable rules into a narrow rule owner doc
  at `docs/rules/oracle.md` and link from `docs/rules/index.md`.
- Delete this hard-cutover spec when the rule doc lands.

## Acceptance Criteria

- The `/oracle` route exists and renders the ask box.
- A submitted question creates an `oracle_reading` row, enqueues a job,
  navigates to the reading page, and streams a complete reading via SSE.
- The reading contains exactly one plate, three to five passages, one
  marginalia note per passage, and one omens coda.
- At least one passage in a hybrid reading comes from the user's library
  when the user has any ingested media.
- Every quoted text fragment is a verbatim substring of an indexed passage.
- Every locator string is composed by the backend from indexed records.
- Every plate carries an attribution string sourced from the image index.
- Reloading the reading page mid-stream resumes from the last persisted
  cursor.
- A failed reading renders a feedback notice and offers exactly one retry
  affordance.
- The oracle theme is scoped: no global font, color, or animation token
  added by this cutover affects routes outside `/oracle`.
- The oracle never fetches from `gutenberg.org` at request time.
- The oracle never embeds third-party image CDN URLs in user-facing HTML.
- No call site displays `ApiError.message` directly.
- `LibraryIntelligenceArtifact`, `LibraryIntelligenceVersion`,
  `LibraryIntelligenceSection`, `Conversation`, `Message`, `MessageClaim`,
  and `MessageClaimEvidence` schemas are not modified.
- `make verify-full`, `make audit`, `make test-real`, and the E2E pass.

## Key Decisions

- Build the oracle as a new domain with its own tables. Do not extend the
  library intelligence artifact pointer model. The lifecycles are
  incompatible: artifact pointers carry one current synthesis per library;
  oracle readings are per-question events.
- Reuse field names from `MessageClaimEvidenceOut` rather than reuse its
  table. Frontend renderers can share helpers; backend ownership stays
  clear.
- Curate the corpus and image index as code-shipped, version-pinned data.
  Do not build a runtime ingest pipeline for public-domain content in this
  cutover.
- Pick Standard Ebooks as primary text source; fall back to Project
  Gutenberg only for works Standard Ebooks does not yet carry. Pre-fetch
  Gutenberg files at release time, never at request time.
- Pick Wikimedia Commons and Internet Archive as primary image sources for
  Doré, Blake, and Redon plates. Use the Met sparingly.
- Do not let the LLM produce locators or citation strings. The model picks
  passage ids; the backend composes citations.
- Use the existing SSE replay transport with a new endpoint mirror, not a
  parallel WebSocket or long-poll mechanism.
- Use the existing image proxy with SSRF guards for plate delivery.
- Scope the oracle theme to `[data-theme="oracle"]`. Do not add global
  serif fonts, sepia palette, or marginalia primitives.
- Treat the oracle as desktop-first for the marginalia gutter; degrade
  gracefully on narrow viewports rather than reflowing the gutter into the
  body.
- Honor `prefers-reduced-motion`. Reveal is theater, not gating.
- Promote durable rules to `docs/rules/oracle.md` only after the cutover
  lands, then delete this plan.
