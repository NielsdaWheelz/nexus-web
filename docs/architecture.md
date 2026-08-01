# Nexus Architecture & System Guide

This is the canonical orientation document for the Nexus codebase. It explains how
the whole system fits together — the runtime topology, the data model, the
cross-cutting mechanisms, and every product slice — so that a new engineer can
learn the system and an experienced one can find anything at a glance.

It is an **overview**, not a rulebook. The normative engineering rules live in
[`rules/`](rules/index.md); the reader behavior contract lives in
[`modules/reader-implementation.md`](modules/reader-implementation.md) and
[`modules/reader-design-rationale.md`](modules/reader-design-rationale.md). This
doc links to those rather than restating them. Consumption-history ownership is
defined in [`modules/consumption-activity.md`](modules/consumption-activity.md).

---

## Table of contents

1. [What Nexus is](#1-what-nexus-is)
2. [System at a glance](#2-system-at-a-glance)
3. [Runtime topology & deployment](#3-runtime-topology--deployment)
4. [Architectural principles (the constitution)](#4-architectural-principles-the-constitution)
5. [The request lifecycle](#5-the-request-lifecycle)
6. [The data model: schema domain map](#6-the-data-model-schema-domain-map)
7. [Cross-cutting backend mechanisms](#7-cross-cutting-backend-mechanisms)
8. [Feature slices](#8-feature-slices)
9. [Frontend architecture](#9-frontend-architecture)
10. [Non-web clients](#10-non-web-clients)
11. [Build, run, deploy, env, migrations](#11-build-run-deploy-env-migrations)
12. [Testing strategy](#12-testing-strategy)
13. [Invariants cheat-sheet](#13-invariants-cheat-sheet)
14. [Where to look (file index)](#14-where-to-look-file-index)

---

## 1. What Nexus is

Nexus is a **reading + notes + AI platform** for a single power user. You bring
content into a personal library — EPUBs, PDFs, web articles, YouTube videos,
podcast episodes — and Nexus ingests each into a uniform, searchable, readable
model. On top of that model it layers:

- a **reader** that renders every format with stable text addressing, so
  highlights, quotes, and AI citations all anchor to exact text;
- flat, graph-native **notes and pages** that link to anything;
- an **AI chat** that streams answers grounded in retrieval over your library,
  with branching conversations and clickable citations that jump into the
  reader;
- a **library-sharing** model and a canonical **contributors** (authorship)
  graph;
- a **podcast** subsystem with subscriptions, transcription, and a playback
  queue;
- the **Oracle**, an agentic "reading" feature over a curated public-domain
  literary corpus that is itself a real Nexus library of indexed media.

It ships on the web, as a first-party **Android shell**, and through a browser
**capture extension**.

The guiding ethos (see [`rules/cleanliness.md`](rules/cleanliness.md) and
[`rules/simplicity.md`](rules/simplicity.md)) is aggressive minimalism: one owner
per concern, deep typed services behind thin transport, make illegal states
unrepresentable, trust the AI model rather than building verifier/guard
scaffolding.

---

## 2. System at a glance

```
                         ┌──────────────────────────────────────────────┐
   Clients               │                  Browser                     │
   ┌─────────┐           │   React UI (Next.js App Router, apps/web)    │
   │ Android │──WebView──▶│                                              │
   │  shell  │           └───────┬──────────────────────────┬───────────┘
   └─────────┘                   │ /api/* product + assets   │ /stream/* (SSE only)
   ┌─────────┐  bearer token     │ same-origin BFF           │ stream token, direct
   │Extension│──────────┐        ▼                           │
   └─────────┘          │  ┌──────────────────────┐          │
                        └─▶│  Next.js BFF (/api)   │          │
                           │  proxy.ts: product    │          │
                           │  auth or public asset │          │
                           │  proxy, no logic      │          │
                           └──────────┬────────────┘          │
                                      │ Bearer + internal, or  │
                                      │ public internal only    │
                                      ▼                        ▼
                           ┌─────────────────────────────────────────────┐
                           │            FastAPI  (python/nexus)           │
                           │  middleware: request-id → CORS → db-session  │
                           │             → auth (JWT→Viewer)              │
                           │  routes (transport-only) → services (logic)  │
                           └───────┬───────────────────────────┬─────────┘
                                   │ sync ORM (threadpool)     │ LISTEN/NOTIFY
                                   ▼                           ▼
                           ┌──────────────┐            push events to /stream/*
                           │  PostgreSQL  │◀───────────────────────────┐
                           │  + pgvector  │   claims background_jobs    │
                           └──────┬───────┘          ┌───────────────────────┐
                                  │                  │ Workers (two lanes)   │
                                  │ object refs      │ interactive: ingest,  │
                                  ▼                  │ chat, oracle          │
                           ┌──────────────┐          │ background: index,    │
                           │ R2 / MinIO   │◀─────────│ repair, teardown      │
                           │ object store │          └───────────────────────┘
                           └──────────────┘

   Identity: Supabase Auth (JWT/JWKS) only — no Supabase DB or Storage.
   External: OpenAI / Anthropic / Gemini / Moonshot (LLM; OpenAI also
             embeddings + transcription); OpenRouter is a hidden, uncertified
             operator route only — no product profile targets it,
             Brave (Browse + agent research), Podcast Index, Deepgram, YouTube Data API
             plus YouTube transcript/caption egress,
             Stripe (billing), Cloudflare R2.
```

**The one rule that explains the shape:** the browser holds no tokens and never
calls FastAPI directly for product data. Product data calls same-origin Next.js
`/api/*` routes, which proxy to FastAPI with a server-attached bearer and the
internal secret. Public owned assets also use the BFF, but as a separate
cookie-free lane: `/api/oracle/plates/[id]` strips browser credentials and sends
only the internal secret to FastAPI `/oracle/plates/{id}`. The **only** direct
browser-to-FastAPI exception is Server-Sent Events: the browser streams from
FastAPI `/stream/*` using a short-lived, single-use stream token minted through
the BFF. See [`rules/layers.md`](rules/layers.md) and
[`rules/modules/transport.md`](rules/modules/transport.md).

---

## 3. Runtime topology & deployment

There are **five runtime processes** plus managed dependencies.

| Process                | Code                                                  | Hosted                           | Role                                      |
| ---------------------- | ----------------------------------------------------- | -------------------------------- | ----------------------------------------- |
| Next.js frontend + BFF | `apps/web`                                            | **Vercel** (Git-triggered)       | React UI + `/api/*` proxy to FastAPI      |
| FastAPI API            | `apps/api/main.py` → `python/nexus`                   | **Hetzner VPS** (Docker Compose) | product API, SSE streaming                |
| Interactive worker     | `apps/worker/main.py` → `python/nexus/jobs` + `tasks` | **same Hetzner VPS**             | user-waiting queue work                    |
| Background worker      | `apps/worker/main.py` → `python/nexus/jobs` + `tasks` | **same Hetzner VPS**             | indexing, repair, teardown, periodic work |
| PostgreSQL (pgvector)  | —                                                     | **same Hetzner VPS**             | the single source of truth                |

Managed/external: **Cloudflare R2** (object storage; MinIO locally), **Supabase**
(hosted Auth only — JWT issuance/JWKS/OAuth; _no_ Supabase Database or Storage),
and the LLM/search/podcast/billing providers above. **Caddy** terminates TLS in
front of the API; the frontend is served by Vercel.

Key topology facts (details: [`deployment.md`](../deployment.md),
`deploy/hetzner/`, `deploy/vercel/`):

- Default request path is **Browser → Next.js BFF → FastAPI → Postgres**.
  SSE is the documented exception (**Browser → FastAPI `/stream/*`**).
- Production is a **hard cutover**: there is no Supabase DB/Storage fallback. The
  env-sync scripts (`deploy/*/sync-env.sh`) actively reject legacy Supabase
  service-role keys, `STORAGE_*`, and a Supabase-pointed `DATABASE_URL`.
- Both worker lanes use a bounded 300-second database statement timeout. The
  API keeps its tighter role-scoped timeout.
- `NEXUS_INTERNAL_SECRET` must be **identical** on Vercel and the VPS — it is the
  shared secret the BFF attaches as `X-Nexus-Internal` so FastAPI knows a request
  came through the trusted proxy.
- Auth redirect origins are enforced in layers: Next.js admits Server Action
  POSTs before app code; `apps/web/src/lib/auth/callback-origin.ts` resolves one
  safe app origin from request metadata; `apps/web/src/lib/auth/redirects.ts`
  builds `/auth/callback` URLs; hosted Supabase Auth must have exact callback
  redirect URLs verified by `deploy/supabase/verify-auth-redirects.sh`.
- Direct Vercel custom-domain frontend deploys leave
  `SERVER_ACTION_ALLOWED_ORIGINS` empty. A host-rewriting frontend proxy must set
  a minimal Next.js domain-pattern list and matching trusted-proxy auth origins.
  Browser-extension redirect origins are frontend-only and stay out of the VPS
  runtime env.
- Local dev runs the same shape via Docker Compose (Postgres on `54320`, MinIO on
  `9000`) plus Supabase-local for Auth, started by `make dev`.

---

## 4. Architectural principles (the constitution)

These are the load-bearing rules that explain _why_ the code looks the way it
does. Full normative text lives in [`rules/`](rules/index.md); this is the
orientation summary.

**Layering & ownership** ([`rules/layers.md`](rules/layers.md),
[`rules/codebase.md`](rules/codebase.md), [`rules/cleanliness.md`](rules/cleanliness.md)).
Top to bottom: Next middleware (network-free session classification + CSP) →
Data Access Layer (`apps/web/src/lib/auth/dal.ts`, the _only_ verified-session
authorization boundary) → Next `/api/*` routes (dumb proxy, no business logic) →
FastAPI middleware (JWT verify, request-id, viewer injection) → FastAPI route
handlers (validate input, call one service, shape the response) → **services**
(`python/nexus/services/`, all business logic, no HTTP/framework types,
dependencies passed as explicit parameters never globals) → models
(`db/models.py`). One capability has one primary form; no barrels/re-exports;
side effects only in entrypoints.

**Error vs defect** ([`rules/errors.md`](rules/errors.md),
[`rules/correctness.md`](rules/correctness.md)). _Errors_ are expected, modelled
failures with typed codes. _Defects_ are broken invariants ("should never
happen") — they are **never** turned into UI states, retryable branches, or
persisted status fields; observing one in production triggers a code change. No
`T | null`/`Optional` in service APIs to represent classifiable absence — classify
immediately as a typed error or a defect. Parse at the boundary, trust inward.
Branch exhaustively on finite value sets (`assert_never`); no bare
`except Exception` swallowing.

**Transport is a dumb pipe** ([`rules/modules/transport.md`](rules/modules/transport.md)).
Application work that must survive a disconnect is decoupled from the transport —
which is exactly why a chat answer is a durable `ChatRun` executed by the worker
and merely _tailed_ over SSE, not driven by the HTTP connection.

**Database** ([`rules/database.md`](rules/database.md)). UUID `id` PKs (never
exposed to users), `timestamptz` with `now()` defaults, right-open `[start, end)`
intervals. **No `ON DELETE CASCADE`** — cleanup is explicit in application code.
**No `INSERT ... ON CONFLICT` upserts** and **no `rowcount`-driven control flow**:
do an explicit `SELECT` then `INSERT/UPDATE/DELETE`, safe under SERIALIZABLE.
The database clock (`now()` in SQL) is authoritative, not the app clock.

**Concurrency** ([`rules/concurrency.md`](rules/concurrency.md)). All backend code
may run concurrently on multiple servers. SERIALIZABLE handles DB-only races —
**don't** layer `SELECT FOR UPDATE`/advisory locks on top of it. Multi-system
mutation ordering is the reverse of observation order: **create** external system
first then local DB; **delete** local DB first then external system.

**Identities** ([`rules/keys-and-identities.md`](rules/keys-and-identities.md)).
`*Id` = private meaningless UUID identity (never exposed outward); `*Key` =
meaningful identity; `*Handle` = outward opaque sealed identity; `*Token`/`*ApiKey`
= outward bearer authority; `*Ref` = lower-layer/provider pointers.

**Retries, polling, timing** ([`rules/retries.md`](rules/retries.md),
[`rules/polling.md`](rules/polling.md), [`rules/timing.md`](rules/timing.md)).
Server-side retries are bounded (infra ≈30s, external services ≈5min); retry
exhaustion is a defect unless explicitly handled. Prefer push/event-driven over
polling; unavoidable polling carries a `justify-polling` tag. Schedules are
self-bounding (cadence + termination in one definition).

The universal escape hatch is the inline `justify-*` tag (`justify-defect`,
`justify-concurrency`, `justify-polling`, `justify-ignore-error`, etc.) — any
deviation from a rule is explicit, see [`rules/overrides.md`](rules/overrides.md).

---

## 5. The request lifecycle

### 5.1 A normal product request (browser → data)

1. A client component calls `apiFetch<T>("/api/...")` (`lib/api/client.ts`). All
   product reads/writes go to **same-origin** `/api/*`; GETs are de-duplicated
   in-flight; a `401 E_UNAUTHENTICATED` hard-redirects to `/login`.
2. **Next middleware** (`middleware.ts` → `lib/supabase/middleware.ts`) attaches a
   per-request CSP nonce and classifies the Supabase session cookie _without any
   network I/O_ into `active | refreshable | ended | anonymous`. `/api/*` is
   passed straight through — the proxy owns its own auth.
3. The `/api/*` **route handler** is a one-liner: `return proxyToFastAPI(req, "<path>")`.
4. **`proxyToFastAPI`** (`lib/api/proxy.ts`) does the real work: enforces a CSRF
   Origin check on mutations; reads the session cookie and turns it into a bearer
   (inline-refreshing a `refreshable` cookie); forwards an allow-listed set of
   headers plus `Authorization: Bearer <supabase access token>`,
   `X-Nexus-Internal: <secret>`, and `X-Request-ID`; applies a 30s timeout;
   strips internal/`set-cookie`/auth headers off the response. The browser never
   sees the bearer or the internal secret.
5. **FastAPI** receives the request through its middleware stack — executed in this
   order (`python/nexus/app.py`): RequestID → StreamCORS → RequestDbSession →
   **Auth** → route. `AuthMiddleware` (`auth/middleware.py`) verifies the JWT via
   JWKS (`auth/verifier.py`), runs first-login **bootstrap** off the event loop in
   a threadpool, and attaches a `Viewer{user_id, default_library_id, email, roles}`
   to `request.state`.
6. The **route handler** (`api/routes/*`) is transport-only: pull the `Viewer` and
   a DB `Session` via `Depends`, call exactly one **service** function, return
   `success_response(...)` or raise an `ApiError`. Handlers are plain `def`, so
   FastAPI runs the blocking ORM work in a threadpool (never blocking the loop).
7. The **service** holds the business logic, returns plain data.
8. On the way out, `RequestDbSessionMiddleware` **releases the pooled DB
   connection at `http.response.start`** — before the body streams to a possibly
   slow client — then RequestID stamps `X-Request-ID` and emits the access log.

Errors become HTTP via three exception handlers (`responses.py`): `ApiError`
carries an `ApiErrorCode` enum mapped to a status; unhandled exceptions become a
detail-free `500 E_INTERNAL` (with special logging for DB pool exhaustion).

### 5.2 A public owned asset request

Oracle plate images are public owned assets, not product data:

1. The UI renders backend-provided Oracle plate URLs through the typed
   `OraclePlateImageSrc` contract and `MediaImage kind="owned"`.
2. Next Image may optimize `/api/oracle/plates/**`; `/api/media/image` is not in
   `images.localPatterns`.
3. The route handler calls `proxyPublicToFastAPI(req, "/oracle/plates/{id}")`.
   It strips browser cookies and authorization headers, forwards cache validators
   and `X-Request-ID`, and attaches `X-Nexus-Internal`.
4. FastAPI admits `/oracle/plates/{id}` only after internal-header verification;
   there is no viewer context and no bearer auth.
5. `services/oracle_plates.py` resolves current DB-owned plate metadata,
   validates the stable storage-key contract, returns `304` from route metadata
   when the ETag matches, and reads storage with byte-size verification for
   `200`.

### 5.3 The SSE exception (streaming)

Streaming bypasses the BFF for data delivery:

1. The client mints a token: `apiFetch("/api/stream-token", {method:"POST"})` →
   BFF → FastAPI `/internal/stream-tokens`. The token is an HS256 JWT, ~60s TTL,
   **single-use** (a `jti` is claimed in the DB; replays return
   `E_STREAM_TOKEN_REPLAYED`).
2. The client opens a raw `fetch` SSE stream **directly to FastAPI**
   `{stream_base_url}/...` with `Authorization: Bearer <stream token>` and
   `Last-Event-ID` (`lib/api/sse-client.ts`). Because tokens are single-use, a
   **fresh token is minted on every (re)connect**.
3. FastAPI `/stream/*` (`api/routes/stream.py`) authenticates the stream token,
   asserts ownership, and **tails persisted events** pushed via Postgres
   `LISTEN/NOTIFY` — re-reading new rows in a threadpool, never blocking the loop.
4. The client parses the SSE wire format (`lib/api/sse-stream.ts`), validates each
   event exhaustively (`lib/api/sse/events.ts`), and folds it into UI state.

This is used by chat runs, oracle readings, and media processing status.

---

## 6. The data model: schema domain map

PostgreSQL is the single source of truth. The schema lives in
`python/nexus/db/models.py` (~100 tables, ~6,400 lines) plus the
**`background_jobs`** table which is defined only in raw SQL in
`python/nexus/jobs/`. Migrations are **hand-written** Alembic files
(`migrations/alembic/versions/NNNN_*.py`, ~125 of them, linear chain, no
autogenerate).

Conventions throughout: UUID `id` PKs (`gen_random_uuid()`), `timestamptz` with
`now()` defaults, heavy `CHECK`/`UNIQUE`/partial indexes encoding business rules,
JSONB columns (with `jsonb_typeof` checks), and `pgvector` columns fixed at
**256 dimensions**. Readable content artifacts are current-only: reprocessing
replaces the current evidence rows instead of preserving app-level versions,
hashes, fingerprints, or supersession chains.

The tables group into these domains:

**Identity / auth / sessions** — `users` (PK = Supabase `sub`),
`billing_accounts`, `billing_entitlement_overrides` (+events),
`stripe_webhook_events`, `extension_sessions`, `auth_handoff_codes`,
`reader_profiles`, `workspace_sessions`, `nexus_usages`. LLM access
runs on platform credentials only — there is no per-user key table.

**Media / ingestion** — `media` (the central readable entity; PDF `plain_text`
has a same-row STORED `plain_text_word_count` derivative), `media_file` (private
original-file object metadata), `project_gutenberg_catalog`,
`user_media_deletions`.

**Reader content / fragments** — `fragments` (current render units carrying
`canonical_text` + `html_sanitized` and a same-row STORED
`canonical_text_word_count` derivative), `fragment_blocks`, EPUB structure
(`epub_toc_nodes`, `epub_nav_locations`, `epub_fragment_sources`,
`epub_resources` for private extracted asset object metadata),
`pdf_page_text_spans`.

**Retrieval index** — `content_blocks`, `evidence_spans`, `content_chunks`,
`content_chunk_parts`, `content_embeddings` (PGVector 256),
`content_index_states(owner_kind, owner_id)`, `media_transcript_states`.
The index is owner-polymorphic: media-owned content and note-owned bodies share
the same chunk/span/embedding pipeline; notes no longer have a parallel
`object_search` substrate.

**Media Intelligence** — `media_summaries` is one current summary head per
Media content fingerprint; `media_claims` holds ordered grounded claims whose
targets are exact `evidence_span` rows. `services/media_intelligence.py` is the
sole storage owner and publishes audience-gated single/batch projections.
Media Intelligence is current-only reusable interpretation, not Dossier
revision history.

**Highlights & passage anchors** — `highlights` (base row + the
exact/prefix/suffix triple), `highlight_fragment_anchors` (codepoint ranges;
`fragment_id` is a disposable locator cache, not an FK — a missing fragment is
detected by LEFT JOIN and re-resolved by quote, never cascade-deleted),
`highlight_pdf_anchors` + `highlight_pdf_quads` (page-space geometry), and
`passage_anchors` (durable user-owned identity for a derived/passage
endpoint — owner `media`/`note_block`, an immutable normalized-quote
`anchor_key`, and a replaceable `locator_hint`; it is the sole durable form a
passage candidate takes once linked, never a persisted `evidence_span`/
`content_chunk`/`fragment`/`reader_apparatus_item`/`oracle_passage_anchor`
row). None of the highlight-family FKs cascade; ordinary deletion is explicit
child-first cleanup, and reindex/refresh never delete Highlights or passage
anchors — unresolved locators stay visible rather than disappearing.

**Libraries / sharing** — `libraries`, `memberships`, `library_entries`, and
`library_invitations`. There is no separate provenance, closure, or backfill-job
table: the default library's read surface is a live query over
`library_entries` + `memberships`, computed at read time (§8.5).

**Contributors** — `contributors` (canonical identity; every row is active,
there is no self-FK, no merge/split/tombstone, and no status column),
`contributor_aliases`, `contributor_external_ids`, `contributor_credits`.

**Notes** — `pages` (title only), `daily_page_bindings` (one sparse
user/date role assignment to an ordinary Page), `note_blocks` (ProseMirror JSON
plus generated text only), `resource_versions`, `resource_mutations`, and
`resource_view_states`. `users.calendar_time_zone` is the sole account-local
Today clock.
Page/note ordering, inline note-to-object refs, highlight-note attachments, and
backlinks are `resource_edges`, below — notes own no link table.

**Resource graph** — `resource_edges` (the single directed connection table:
`kind` (`context`, `supports`, `contradicts`), writer `origin` (`user`,
`citation`, `system`, `note_body`, `highlight_note`, `synapse`,
`document_embed`, `assistant`, `link_note`), polymorphic `scheme`+`id`
endpoints with no endpoint FKs, optional ordered-adjacency keys, citation
`ordinal`+`snapshot`, and synapse rationale snapshots),
`resource_external_snapshots` (stable targets for public web-search citations),
and `oracle_reading_folios` (oracle-owned generated folio content referencing its
citation edge). This subgraph is the single durable positive connection
contract. **Link** is the one durable relationship-authoring primitive:
exactly one neutral `origin='user', kind='context'` edge exists per user and
canonical unordered endpoint pair (`min(A,B) → max(A,B)`, ordered by
`(scheme, id)`); repeated or reverse creation returns the existing Link rather
than raising or duplicating. A directional user **stance**
(`supports`/`contradicts`) may coexist on the same pair — at most one per
user/unordered pair, its stored direction carrying meaning — and ordered
adjacency (page/note occurrence order) is a third, never-canonicalized shape;
all three may coexist on the same endpoints. An optional **Link note** is one
ordinary note attached through two structural `link_note` edges (one per
endpoint), folded by `connections.py` into a single `ConnectionOut.link_note`
field — the attachment edges themselves never render as separate rows.

**Universal Dossiers** — `artifacts` is the stable head keyed by subject plus
derived audience; `artifact_builds` records each manual generation attempt;
`artifact_revisions`, `artifact_build_failures`, and
`artifact_build_cancellations` are mutually exclusive terminal children; and
`artifact_build_events` is the strict replayable build stream. A successful
revision stores one accepted semantic `content_html` article, its derived
`content_text`, a typed input manifest, and at least one citation edge. Eight
subject policies/bindings cover Media, Conversation, Library, Podcast,
Contributor, Page, Note, and the internal user-owned Idea subject. One generic
engine, API, history contract, and `dossier_build` job own the lifecycle.

**Conversations / chat** — `conversations`, `messages` (the message tree with
branch pointers), `conversation_branches`, `conversation_active_paths`
(per-viewer), `conversation_shares`; plus the **chat-run** machinery: `chat_runs`
(carries product selection snapshots `profile_id`/`reasoning_option_id` and
resolved trust-trail snapshots `provider`/`model_name`/`reasoning_effort`,
`error_origin`, `support_id` — no `models`/`user_api_keys` FK, both tables are
gone),
`chat_run_events` (append-only SSE log), `chat_prompt_assemblies`; and the
**retrieval/citation** ledger: `message_tool_calls`, `message_retrievals` — the
sole durable per-result record (telemetry; carries `cited_edge_id` pointing
back at the citation edge). Candidate generation and rerank/selection are
transient, in-memory passes over a tool call's results; only the
selected/included outcome is ever written. Conversation
context refs are `resource_edges` with `source_scheme='conversation'`. Assistant
message API responses include a
`trust_trail` read model assembled from these durable rows; persisted
`message_document` blocks are text-only.

**Podcasts / playback** — `podcasts`, active-only `podcast_subscriptions`
(`id` PK, unique viewer/Podcast relationship, live `sync_status`, and
`auto_queue_watermark_at`), `podcast_subscription_backfills` (the separate
durable history-traversal fence), `podcast_episodes` (PK = `media_id`),
`podcast_episode_identities` (stable PodcastIndex/RSS aliases),
`podcast_episode_chapters`,
`podcast_listening_states` (position/duration/nullable established episode rate +
`write_revision`/`reset_epoch` heartbeat fencing plus heartbeat-only
`last_engaged_at`; operational `updated_at` is not engagement),
`podcast_transcription_jobs`,
`podcast_transcription_usage_daily`, `podcast_transcript_segments`. Named
Podcast placement is only `library_entries(podcast_id)`; Default/All is virtual
and stores no Podcast entry.

**Reader cursor / Lectern / consumption** — `reader_media_state` (the canonical
revision-fenced resume cursor, including persisted `Empty` reset tombstones;
consumption state does not derive directly from it),
`consumption_queue_items` (the Lectern: one ordered, mixed-media list per
viewer, membership/order only — completion is never stored on the row),
`consumption_overrides` (explicit `Unread`/
`Finished` state), `reader_engagement_states` (one current-state row per
viewer/media: `last_engaged_at` recency and, for non-PDF locators, a
monotonic `max_total_progression`), `consumption_activity_spans` (bounded
observed Reading/Listening/Viewing intervals), `consumption_completion_facts`
(the first observed post-cutover canonical completion per viewer/media), and
`media_teardown_intents` (media-deletion claim; see §8.8 and
[`modules/storage.md`](modules/storage.md)). Current state and historical facts
are separate. Explicit status and current progress are also independent:
`SetUnread` changes only the override, while `ResetProgress` clears the
override and atomically resets Nexus-owned cursor, engagement, and listening
state without deleting history or Lectern membership. See
[`modules/consumption-activity.md`](modules/consumption-activity.md) and
[`cutovers/media-progress-reset-hard-cutover.md`](cutovers/media-progress-reset-hard-cutover.md).

**Jobs** — `background_jobs` (raw-SQL-only durable queue), plus rate-limiter
tables (`rate_limit_request_log`, `rate_limit_inflight`, `token_budget_*`) and
stream-token replay claims.

**Oracle** — the public-domain corpus is a real `libraries` row
(`system_key = 'oracle_corpus'`) of ordinary `media`; its text and embeddings live
in the shared content index (`content_chunks`/`content_embeddings`), not an
Oracle-owned vector store. `oracle_corpus_sources` maps each curated `work_key` to
its current `media_id`; manifest source changes are hard cut over by accepting new
system media and removing the old media from the Oracle Corpus library.
`oracle_passage_anchors` is stable curation identity (selector + tags + phase
hints, plus cache pointers to current `evidence_span`/`content_chunk`) that
doubles as the `oracle_passage_anchor:<id>` citation target; resolution normalizes
quote text against active ready chunks, then applies a bounded token-window match
for small same-passage source-edition spelling/punctuation variants. It still
fails closed when the mapped media is the wrong source or lacks the target text.
`oracle_plates`
(public owned plate object metadata; **no embeddings** — selection is
deterministic over tags/phase hints), `oracle_readings`, `oracle_reading_folios`
(the per-phase generated folio, referencing its citation `resource_edge`),
`oracle_reading_events`.

> Two things to know when reasoning about the schema: (1) `background_jobs` is
> invisible if you only read `models.py` — it's raw SQL. (2) Because migrations
> are hand-written with `target_metadata = None`, `models.py` and the live DB can
> drift silently; there is no autogenerate diff to catch a forgotten migration.

---

## 7. Cross-cutting backend mechanisms

These mechanisms are shared by every feature slice. Understanding them is the
fastest path to understanding the whole backend.

### 7.1 The database layer

Synchronous **SQLAlchemy 2.0 + psycopg v3** over an async FastAPI. The reconciling
discipline (this is the single most important backend invariant):

- **Never call blocking DB on the event loop.** Route handlers are plain `def` so
  Starlette runs them in a threadpool; async code that must touch the DB wraps it
  in `run_in_threadpool`. Calling the DB inline on the loop self-induces a pool
  deadlock under contention.
- **Early connection release** (`middleware/db_session.py` + `db/session.py`): the
  pooled connection is returned at `http.response.start`, before the body is sent.
  So any ORM access must complete before the response starts streaming — don't
  lazy-load relationships while streaming.
- **Server-side prepared statements are disabled** (`prepare_threshold=None`) for
  pooler safety.
- **SERIALIZABLE** isolation is opt-in via `use_serializable_if_available()` for
  transactions needing sequential equivalence; serialization failures (SQLSTATE
  `40001`) are detected and retried by callers. No `SELECT FOR UPDATE` is layered
  on top except where genuinely required (e.g. PDF advisory locks).
- **Role-scoped PG timeouts** are injected at connect time from env
  (`statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`).
  The API is tight (30s/10s/60s); both worker lanes bound statements at 300s.

### 7.2 LISTEN/NOTIFY → SSE streaming

Push-based streaming without polling. Migration-owned Postgres `AFTER` triggers
call `pg_notify` on insert/update of append-only event tables; a shared listener
(`db/listen.py`) holds a raw
autocommit `psycopg.AsyncConnection` per stream (capped at 64, exempt from pool
timeouts) and wakes the SSE tail. The committed row — not the notification — is
the source of truth; a missed/coalesced NOTIFY only delays an update by the idle
keepalive, never drops it.

| Channel                 | Producer                          | Consumer         |
| ----------------------- | --------------------------------- | ---------------- |
| `chat_run_events`       | insert on `chat_run_events`       | chat SSE tail    |
| `oracle_reading_events` | insert on `oracle_reading_events` | oracle SSE tail  |
| `artifact_build_events` | insert on `artifact_build_events` | Dossier SSE tail |
| `media_events`          | update on `media`                 | media-status SSE |
| `podcast_refresh_events` | insert/update on `podcast_refresh_runs` | Podcast refresh SSE |
| `nexus_background_jobs` | enqueue in `jobs/queue.py`        | worker wake-up   |

### 7.3 Background jobs & the worker

A durable Postgres-backed queue (`python/nexus/jobs/`). Jobs are enqueued by
inserting a `background_jobs` row + `pg_notify` **in the caller's transaction**
(atomic with domain writes). Two single-process, single-replica workers run the
same entrypoint with fixed `interactive` and `background` lanes:

- **Job loop**: `claim_next_job` atomically picks one due row with
  `FOR UPDATE SKIP LOCKED` (new work _or_ a crashed job whose lease expired),
  flips it to `running` with a lease, dispatches to the registered handler under a
  heartbeat thread, then commits a terminal/retry transition. Retries are bounded
  per-kind (`max_attempts`, `retry_delays_seconds`, `lease_seconds`); exhaustion
  dead-letters the row. Domain finalizers close or suspend current Chat, Note,
  Dossier, Media teardown, Podcast live-sync, and Podcast-backfill state without
  overwriting newer lifecycle facts.
- **Scheduler loop**: the background lane enqueues production periodic jobs
  into fixed time slots with deterministic dedupe keys. The interactive lane
  has no periodic kinds.

The **registry** (`jobs/registry.py`) is the source of truth mapping job kind →
handler + policy. `config.py` owns the disjoint/exhaustive 20-kind production
topology and separate three-kind maintenance declaration. The entrypoint rejects
missing/unknown lanes, registry drift, and raw allowlists on normal lanes.
`get_task_contract_version()` fingerprints the registry's per-kind
attempt/lease policy for `/health` deploy checks. See
[modules/jobs.md](modules/jobs.md).

Task catalog (each is a thin handler in `tasks/` that wraps a service):
`ingest_media_source`, `enrich_metadata`, `chat_run`,
`oracle_reading_generate`, `dossier_build`,
`media_content_reindex_job`, `media_unit_build`, `note_reindex_job`,
`podcast_sync_subscription_job`,
`podcast_backfill_subscription`,
`podcast_reindex_semantic_job`, `podcast_refresh_due_job` (periodic),
`podcast_refresh_run_prune_job` (periodic),
`reconcile_stale_ingest_media_job` (periodic),
`sync_gutenberg_catalog_job` (periodic), `prune_background_jobs_job`
(periodic), `purge_expired_auth_handoff_codes` (periodic), `synapse_scan`,
`dawn_write_job` (periodic), `atlas_project_job` (periodic), `media_teardown`,
`storage_object_cleanup`, and `storage_orphan_sweep` (periodic).

Author identity is resolved inline, synchronously, inside each ingest/enrichment
lane — there is no separate contributor-dedupe job, proposal table, or merge
contract. `services/contributors.py` is the sole author-mutation facade: a
resolver keyed on exact stable key → confirmed alias → new contributor
(§8.6) runs in the same fresh SERIALIZABLE-retried transaction that replaces a
lane's observed role slice, so duplicate identity is prevented at write time
rather than proposed and reconciled after the fact.

> Gotcha: only `enrich_metadata` and `media_unit_build` declare
> `failed_result_statuses`. Other ingest tasks that _return_ `{"status":"failed"}`
> still mark the **queue** row succeeded — the failure is recorded on the domain
> row, and recovery relies on the stale reconciler + manual API retry, not
> queue-level retries.

**Generation boundary in the worker.** Seven LLM generation kinds (`chat_run`,
`oracle_reading_generate`, `synapse_scan`, `dawn_write`,
`dossier_build`, `media_unit_build`, `enrich_metadata`) run their bodies inside
one shared worker envelope,
`tasks/llm_task.py:run_llm_task` — the sole owner of the event loop, `httpx`
client, production `ExecutionRuntime` construction, and worker-exception
boundary. Deterministic tests exercise a loopback provider protocol server
through the same configured HTTP boundary; product code has no fixture mode.
Every provider call inside a job goes through
`services/llm_execution.py:execute_generation`/`execute_generation_stream` —
the sole caller of the ledger — leaving one `llm_calls` row on every terminal
path (success, defect, or entitlement/budget denial), with the failure
attributed to the layer that detected it. See [modules/llms.md](modules/llms.md).
The worker installs the process-global rate limiter at startup so the first job
of any kind has a working limiter. SERIALIZABLE retries everywhere (including
the scheduler loop) go through the one helper `db/retries.py:retry_serializable`.

### 7.4 Auth, identity & bootstrap

Supabase issues JWTs; FastAPI verifies them via JWKS (`auth/verifier.py`) and
derives a `Viewer`. On a user's first request per process, `AuthMiddleware` runs
**bootstrap** (`services/bootstrap.py`: `ensure_user_and_default_library`) once —
idempotent under SERIALIZABLE, creating the `users` row, a default library, and an
admin membership; the resulting `default_library_id` rides on the `Viewer`.
Visibility is enforced by boolean predicates (`auth/permissions.py`) that take an
explicit session and never leak existence (not-found == not-visible).

Other identity surfaces:

- **Stream tokens** (`services/stream_tokens.py`, route `api/routes/stream_tokens.py`):
  HS256, ~60s, single-use, for SSE.
- **Extension sessions** (`services/extension_sessions.py`): opaque
  `nx_ext_<...>` bearer; only its sha256 is stored; revocable.
- **Android handoff codes** (`services/auth_handoff_codes.py`): single-use,
  PKCE-bound (`challenge = sha256(verifier)`), 90s TTL, consumed with an atomic
  `DELETE ... RETURNING`.

### 7.5 Platform LLM credentials, billing & entitlements

- **Platform credentials** (`services/llm_credentials.py`): the sole platform-key
  reader for every generation, embedding, and transcription call — no BYOK, no
  per-user key, no DB lookup, no encryption. It reads `OPENAI_API_KEY` /
  `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `MOONSHOT_API_KEY` straight off
  `Settings`; a missing key at call time is a `RuntimeDefect` (broken deployment
  invariant), never a product-facing failure, because presence is enforced at
  startup by `config.validate_required_settings` for staging/prod (which also
  requires an RFC 3339 `NEXUS_FABLE_RETENTION_ACCEPTED_AT` deployment
  assertion — Fable requires 30-day retention and is not ZDR-eligible).
  `OPENROUTER_API_KEY` is not part of the deployed app's required settings; it
  belongs only to the separate paid provider-runtime certification command.
  See [modules/llms.md](modules/llms.md).
- **Billing** (`services/billing.py`): Stripe is the system of record;
  `billing_accounts` is a per-user snapshot synced by idempotent webhooks (deduped
  via `stripe_webhook_events`). Tiers: `free | plus | ai_plus | ai_pro`.
- **Entitlements** (`services/billing_entitlements.py`): derived from the effective
  plan — `can_share` (≥ plus), `can_use_platform_llm` / `can_transcribe`
  (≥ ai_plus), plus monthly token/transcription quotas. **Internal overrides**
  (`billing_entitlement_overrides`, CLI-managed via
  `ops/entitlement_overrides.py`) can raise a plan upward and grant unlimited
  quotas, with a full audit trail.
- **Rate limiting** (`services/rate_limit.py`): a Postgres-backed limiter using
  per-scope advisory locks; limits RPM (20), concurrency (3 inflight slots), and a
  monthly platform-token budget via a reserve→commit pattern with TTL'd
  reservations and polymorphic reservation-id charges for chat and background
  generation. It **fails closed** on acquire/check, open on release.

### 7.6 Search, retrieval & the embedding pipeline

One core `search(db, viewer, SearchQuery)` (the `services/search/` package) serves
the in-app search page, mobile Nexus, desktop Nexus, and chat
`app_search` agent tool (RAG). The request is a single typed `SearchQuery` value
object parsed at the
edge; the user-facing taxonomy is **six kinds** (Documents, Notes, Highlights,
Conversations, People, Web) folding the internal result types, with
operator-backed filter chips (`format:`/`author:`/`role:`/`in:`) — not the raw
result-type grid. The package owns one concern per module (`kinds`, `query`, `scope`,
`embedding`, `ranking`, `projection`, `cursor`, `batch`, `retrievers/*`, `service`).
Ranking/retrieval is extracted below that public projection into one internal
pre-projection candidate seam (`search/candidates.py`); **resource target
search** (`services/resource_items/targets.py`, `POST
/resource-items/targets/search`) and route-only **openable-resource search**
(`services/resource_items/openables.py`, `POST
/resource-items/openables/search`) are projections over the same candidate
engine, not second search engines, and never introduce new public `SearchKind`
or `GET /search` result types. The target service's `purpose=link` profile
is the full hybrid retrieval and may surface passage candidates (`kind:
"passage"`, transient `candidate_ref`); its `purpose=reference` profile is a
one-character-capable lexical fast path (exact/prefix/substring/FTS,
including note-body substrings) restricted to direct targets, and never calls
`build_query_embedding`. Both profiles apply target capability, visibility,
canonical dedupe, and exclusions before per-source caps, and refill a sparse
filtered page rather than under-filling it. Openable search performs one
bounded lexical candidate pass, admits only visible direct resources with
internal route activation, applies scheme filtering and canonical dedupe before
its top-20 limit, and has no cursor, refill, mutation, or history write.

Canonical `/search` results expose both the occurrence `resource_ref` and the
owning `owner_resource_ref`. The Highlights profile retrieves saved highlights
plus only note blocks classified by a visible `resource_edges.origin =
"highlight_note"` edge before ranking and limiting. Clients never infer owner
identity or highlight-note origin from result type or URL.

- **Indexing** (`services/content_indexing.py`, `semantic_chunks.py`): text-bearing
  media flows `fragment → content_blocks → chunks → embeddings`; note bodies
  flow `note_block → content_blocks → chunks → embeddings` through
  `services/note_indexing.py`. The current index state is tracked in
  `content_index_states(owner_kind, owner_id)` with the active embedding
  provider/model; rebuilds replace current blocks, chunks, spans, and embeddings
  for the owner.
- **Retrieval** is hybrid — and hybrid is an _invariant_, not a per-request toggle:
  a vector ANN arm (cosine over pgvector, joined on the _active_ embedding config)
  **UNION** a lexical FTS arm, reranked by a weighted score (lexical hit + semantic
  similarity + recency), filtered by a similarity floor, then resolved through the
  locator resolver. There is no `semantic` flag; the query embedding is built once
  for any semantic-capable kind regardless of structured filters. For chat, candidates are
  selected under a context-char budget; candidate/rerank/selection is a transient in-memory
  pass and `message_retrievals` is the sole durable per-result record. Selected rows become
  `message_retrievals` telemetry rows via the single validated writer
  `retrieval_citation.insert_retrieval_row` (the cited ones link back to their
  citation edge through `cited_edge_id`, §7.7).
- **The `ResourceRef` grammar** (`services/resource_graph/refs.py`): a
  `<scheme>:<uuid>` ref over a closed scheme set (`media`, `library`,
  `evidence_span`, `content_chunk`, `highlight`, `page`, `note_block`, `fragment`,
  `conversation`, `message`, `oracle_reading`, `oracle_passage_anchor`,
  `artifact`, `artifact_revision`, `reader_apparatus_item`, `external_snapshot`,
  `contributor`, `podcast`, `passage_anchor`)
  is the one persisted resource-identity vocabulary. The same ref identifies a
  resource everywhere: an edge endpoint, a citation target, an attached
  conversation context ref, a chat subject, and a read/inspect agent-tool
  argument. Parsing is
  strict (canonical lowercase uuid) and returns a typed failure, never `None`.
  Hydration + permission checks live in `services/resource_graph/resolve.py` —
  `load_resource_batch` is the one place each scheme's read SQL + visibility gate
  exists, including a viewer-scoped `passage_anchor` branch under the same
  masked-404 convention as every other scheme.
- **User-Link/mention capability** (`services/resource_items/capabilities.py`):
  one explicit `ResourceUserRelationPolicy(user_link_source: bool,
user_link_target: UserLinkTargetMode)` row per `ResourceScheme` replaces the
  former scalar `linkable` flag — `UserLinkTargetMode` is `"none" | "direct" |
"materialize_passage"`, so a scheme can admit a durable Link while
  distinguishing a direct endpoint from one that must first materialize a
  `passage_anchor`; a derived `note_reference_target` property is `True` only
  for `"direct"`. `evidence_span`, `content_chunk`, `fragment`,
  `reader_apparatus_item`, and `oracle_passage_anchor` are passage-candidate-only
  (`materialize_passage`); `external_snapshot` is `"none"`; every other scheme
  above is a direct source/target/reference. Backend policy and the
  hand-maintained frontend projection are exhaustive and parity-tested.

### 7.7 Citations & the agent tool contract

The chat/oracle LLM can call four tools (`services/agent_tools/`):

- **`app_search`** — RAG retrieval over the user's library (scoped to
  `media:`/`library:` refs); produces numbered, citable results.
- **`web_search`** — Brave public web search; numbered, citable.
- **`read_resource`** — reads exact text for a `ResourceRef`; evidence reads are
  citable, oversized docs redirect to inspect.
- **`inspect_resource`** — returns a navigable document map of a `media:` ref;
  navigation only, never cited.

Citation `[N]` is a **dense, turn-global ordinal** assigned across the whole turn
(attached context refs first, then each tool's selected results). A citation **is an
edge**: `[N]` is the `ordinal` on an `origin='citation'` `resource_edge` whose
source is the assistant message and whose target is the cited resource. The
backend builds the `CitationOut` read-model from those edges via
`resource_graph.citations.build_citation_outs` (uniformly for chat, Oracle, and
Universal Dossiers), reconstructing the in-reader jump from the target's own
anchoring. `message_retrievals` stays chat-owned **telemetry**, pointing back at
the edge through `cited_edge_id`; the frontend maps `[N]` → a `CitationOut` →
resource activation plus an optional reader-internal focus target.

### 7.8 Resource Inspector, Universal Dossiers & Media Intelligence

`RESOURCE_ITEM_CAPABILITIES` is the backend authority for Inspector eligibility,
linked-items policy, Forks, and default surface order; the committed TypeScript
projection is parity-tested. Every eligible resource implies Dossier.
`useResourceInspector` composes one stable publication and Companion action per
pane from route-owned Contents/Evidence/Context/Forks/Connections bodies plus
the shared Dossier body.

The backend separates three owners:

- subject policy derives the subject, audience, authorization, deletion, and
  canonical activation;
- one of eight bindings collects inputs and owns prompt, operation/profile,
  manifest, coverage, and freshness;
- the generic engine owns idempotent build creation, durable execution,
  terminal children, revision history, Make current, cancellation, and events.

Resource bootstrap/Companion lookup uses
`GET /artifacts/dossiers/{subject_scheme}/{subject_handle}`,
`POST /artifacts/dossiers/{subject_scheme}/{subject_handle}/builds`; an
existing head regenerates only through
`POST /artifacts/{artifact_ref}/builds`. `GET /artifacts/{artifact_ref}` is the
canonical authorized head read. Selection Learn uses
`POST /artifacts/dossiers/learn`, resolves an internal Idea, records the
Highlight as a seed, and adopts the standalone Artifact pane. The remaining
API is
`GET /artifacts/{artifact_ref}/revisions`,
`GET /artifact-revisions/{artifact_revision_ref}`,
`POST /artifact-revisions/{artifact_revision_ref}/make-current`, and
`POST /artifact-builds/{sealed_handle}/cancel`. Build streaming is
`GET /stream/artifact-builds/{sealed_handle}/events`; persisted
`Started | Progress | Succeeded | Failed | Cancelled` events are build-keyed
and replayable. The browser renders a revision in a sandboxed, Nexus-styled
document frame; rejected or partial HTML is never emitted as an event. Media
Intelligence is separately read through
`GET /media/{media_handle}/intelligence`; the Media Dossier renders that
current projection as a compact Abstract and consumes the same fingerprinted
projection as generation input.

---

## 8. Feature slices

Each slice below is a vertical: data model → backend service(s) → frontend
surface → key flows.

### 8.1 Media ingestion

The pipeline turns heterogeneous sources into one `media` row plus per-format
artifacts. `services/media.py` is the catalog/hydration service: visible-media
queries, response shaping, and fragment listing. `media_source_ingest.py` is the
source lifecycle owner for accepted URL/upload/browser-capture source attempts;
it creates `media_source_attempts`, persists durable source artifacts where
needed, and enqueues `ingest_media_source`. Source creation and asset reads are
capability-owned:

- `media_ingest.py`: URL transport adapter into `media_source_ingest.py`.
- `media_source_ingest.py`: accepted source-attempt state machine for generic
  web URLs, X/Twitter URLs, YouTube URLs, remote PDF/EPUB URLs, uploaded
  PDF/EPUB files, and browser article/file captures.
- `x_identity.py`, `x_client.py`, `x_rendering.py`, `x_ingest.py`: official-API
  X/Twitter same-author thread capture. Identity comes from provider author ID
  plus conversation ID; quote posts are separate `post:<post_id>` media; provider
  billing/auth/rate-limit/timeout failures are typed and recorded in
  `external_provider_events`. There is no scraping, oEmbed, or generic article
  fallback for X URLs.
- `youtube_video_ingest.py`: playable YouTube metadata materialization for
  queued source attempts using the YouTube Data API. Add never initializes or
  fetches a transcript. The explicit canonical Transcribe command separately
  composes `youtube_transcripts.py`; caption acquisition may require
  `YOUTUBE_TRANSCRIPT_PROXY_URL` from datacenter hosts.
- `remote_file_client.py`: PDF/EPUB URL outbound policy, SSRF-safe streaming to
  storage, byte-size accounting, and signature validation for queued source
  attempts.
- `epub_assets.py`: private EPUB resource asset authorization and byte-size
  checked reads.
- `api/routes/listening_state.py`: the singular listening-heartbeat route
  (GET/PUT, no batch endpoint); position/duration/nullable episode-rate DML is owned by
  `services/consumption/_listening_store.py` (§8.8).
- `media_file_access.py`: signed original-file download URLs.
- `media_processing_state.py`: every processing-state transition, including
  reingest reset and ready-for-reading completion.

**Entity & state machine:** `media.processing_status` runs
`pending → extracting → ready_for_reading` or `failed`. Search/embedding
readiness lives on the separate `content_index_states` machine.
`failure_stage ∈ {upload, extract, transcribe, embed, metadata, other}`. Source
retryability is derived from the latest `media_source_attempts` row and
capability projection; `source` is not a `failure_stage`. `failure_stage='metadata'`
and `'embed'` are soft warnings that coexist with readable media.

**Capture entry points** (`api/routes/media_ingest.py`): `POST /media/from_url`,
`POST /media/upload/init` + `POST /media/{id}/ingest`, and
`POST /media/capture/{article,file,url}`. Routes are transport adapters; they
call exactly one service owner. (The media routers are split per capability:
`media.py` catalog, `media_ingest.py` ingest, `media_assets.py` image/EPUB-asset
serving, `reader.py` reader read-model, `listening_state.py`, and
`podcast_transcripts.py` — each importing only the services it delegates to.)
Ingest `library_ids` are writable non-default destinations; media services
validate them through library governance and assign default plus selected
destinations through `library_entries`.

Every accepted source returns `media_id`, `source_attempt_id`, `source_type`,
`source_attempt_status`, `idempotency_outcome`, `processing_status`, and `ingest_enqueued`. Provider,
network, sanitization, extraction, and post-acceptance storage failures update
the existing media row and latest source attempt; the user retries by creating a
new source attempt through `POST /media/{id}/retry`.

**Recovery/deletion:** `reconcile_stale_ingest_media` requeues/fails stale
`extracting` rows, GCs abandoned uploads, and repairs content/semantic indexes.
`media_events` streams live status. `services/media_deletion.py` is explicit and
reference-counted; storage deletion happens only after the DB commit.

### 8.2 Reader

The reader renders EPUB/PDF/web-article/transcript content with **stable,
reflow-independent locators** so highlights, quotes, and citations anchor to exact
text. This is a linchpin area with its own design contract — read
[`modules/reader-implementation.md`](modules/reader-implementation.md) and
[`modules/reader-design-rationale.md`](modules/reader-design-rationale.md).

The core idea is two coordinate systems, both **codepoint-based**:

- **Reflowable formats** (web/transcript/EPUB): a position is
  `(fragment_id, offset)` where `offset` is a Unicode codepoint index into that
  fragment's `canonical_text`. `canonical_text` is produced by a browser-equivalent
  HTML5 parse (`services/canonicalize.py`) and is **stable for the current
  artifact after `ready_for_reading`**, so the frontend DOM-text walk
  (`lib/highlights/canonicalCursor.ts`) yields identical offsets regardless of
  typography. The frontend canonicalizer must byte-match the Python one;
  `validateCanonicalText` is a hard gate.
- **PDF**: a locator is `(page_number, geometry quads)` plus a match into
  `media.plain_text` via `pdf_page_text_spans`. Highlight geometry is canonical
  page-space quads; duplicate detection uses the current anchor rows and PDF writes
  serialize on advisory locks (`services/pdf_highlight_geometry.py`).

EPUB ingestion (`services/epub_ingest.py`) produces fragments + a `EpubNavLocation`
per section, where the `section_id` is the path-encodable `href_path[#fragment]`
used in reader URLs. Navigation, sections, and resume state are served from
`api/routes/reader.py`; resume stores reflow-safe canonical offsets (web/transcript)
or page/zoom (PDF), never pixels.

EPUB resource assets use a private media asset lane:
`/api/media/[id]/assets/[...assetKey]` → FastAPI `/media/{id}/assets/{assetKey}`.
`services/epub_assets.py` authorizes the viewer, resolves current
`epub_resources` storage metadata, releases the DB session, then reads the object
through byte-size-checked storage helpers. EPUB assets are not in Next Image
`images.localPatterns`.

**Highlights** (`services/highlights.py`, `services/pdf_highlights.py`): a
selection becomes a stored highlight with a precomputed
`exact`/`prefix`/`suffix` triple (a 64-codepoint context window) that doubles as
the canonical quote shown to chat. PDF highlights may have empty `exact` (no
text-layer match) — a first-class geometry-only state Evidence renders with an
explicit placeholder. The current highlight
contract lives in [`modules/highlight.md`](modules/highlight.md).

**Source-authored apparatus** (`services/reader_apparatus.py`): web article,
EPUB, and PDF ingest paths persist document-authored notes, endnotes,
bibliography entries, in-document markers, and marker-to-target edges into
`reader_apparatus_*` tables. This model is separate from generated chat
citations, `message_retrievals`, and conversation context refs; materialized
rows are addressed as `reader_apparatus_item:<uuid>` resources and can be
searched, opened, linked, read, and cited through the same resource activation
and graph-citation spine as other explicit resource targets. Web/EPUB
apparatus is extracted before sanitization removes semantic attributes. PDF
apparatus is capability-gated: native `cite.*` links can be `ready` when
deterministic reference targets are materialized, marker-only native-link rows
remain `partial`, synthetic legal-footnote support is narrow, and unsupported
scholarly/literary PDFs deliberately emit empty apparatus rather than inferring
from raw layout text. Replacement reconciles rows by `(media_id, stable_key)` so
surviving resource refs and their graph edges remain stable across refresh.
Fixture counts and 20-source support status live in
`python/tests/fixtures/reader_apparatus/corpus_manifest.json`.

**Frontend** (`components/reader/*`, `PdfReader.tsx`, `HtmlRenderer.tsx`,
`lib/reader/*`, `lib/highlights/*`): `HtmlRenderer` is the only
`dangerouslySetInnerHTML` site. It renders already-sanitized HTML, permits
annotation transforms, and applies the bounded media `h1`-to-`h2` projection
beneath the resource heading. Inline
highlight rendering remains separate for text selection. Media publishes one
shared **Resource Inspector** companion whose tabs are `Contents` when
available, `Evidence`, and `Dossier`. Contents and Evidence retain their
internal **Document Map** semantics:
Evidence is a target-centered aggregate of highlights, source references,
generated citations, links, and Synapses, separated into passage and
whole-document scopes with typed one-hop associations. `MarginRail` is the
wide-reader spatial presenter for the same filtered passage facts. The desktop
overview rail is positioned from aggregate owner locators and metadata, never
DOM geometry, and has no generic opener. The shared Companion action opens the
same `resource-inspector` publication on desktop and in the workspace mobile
sheet.
The contract is
[`reader-evidence-scope-associations-hard-cutover.md`](cutovers/reader-evidence-scope-associations-hard-cutover.md).

### 8.3 Chat & conversations

The AI chat: durable, branchable, streamed, RAG-grounded. Backend:
`services/chat_runs.py` + the `chat_run_*` modules + `context_assembler.py`.

- **Conversation = message tree.** Each "send" creates a user message plus a
  _pending assistant_ message; replying under an existing assistant forks a
  **branch**. `conversation_active_paths` stores a **per-viewer** selected leaf;
  history assembly only includes messages on the current path, so sibling branches
  never leak into context.
- **One send = one durable `ChatRun`.** HTTP never calls the provider. `POST
/chat-runs` validates + (idempotently, keyed on `Idempotency-Key` + a payload
  hash) creates the run and enqueues a `chat_run` job, then returns. The **worker**
  executes: assemble context → stream provider tokens + run tools (up to 8 tool
  iterations) → append events → finalize. The client merely tails `chat_run_events`
  over SSE and reconciles via `GET /chat-runs/{id}` on each stream boundary.
- **Context assembly** (`context_assembler.py`, `prompt_budget.py`): a
  token-budgeted, lane-ordered plan (system → scope → attached context → retrieved
  evidence → web evidence → history → current user). The prompt plan stores
  token counts, lane metadata, and text-free block manifests, but no prompt hashes
  and no provider cache key. Attached references render as numbered `<resources>`;
  the transient `<reader_selection>` (a highlight the user is asking about) is
  bind-only and never numbered.
- **Durable recovery**: the claimed job stores a strict step journal in its
  payload. Preparation, model turns, tools, and publication have stable
  identities and fingerprints. Retries replay `Completed` results and never
  blindly repeat an ambiguous paid call or write. Code defects escape to queue
  retry; exhaustion retains the same nonterminal run/job as `Suspended`.
  Cancellation or operator reconciliation requeues that same job. Terminal
  publication and journal clearing commit atomically.
- **Connection is not execution**: SSE only tails committed events. Unsequenced
  execution advisories (`Queued | Running | Recovering | Suspended`) report queue
  liveness without advancing the event cursor or starting work.
- **Profiles, not a catalog** (`services/llm_profiles.py`): chat sends
  `profile_id` + `reasoning_option_id` from seven code-defined, startup-validated
  product profiles (`fast`/`balanced`/`deep`/`claude`/`fable`/`gemini`/`kimi`),
  each mapped to one certified `provider_runtime.CATALOG` target. There is no
  provider/model/key picker and no availability intersection to compute — every
  listed profile is always usable on the platform key. See
  [modules/llms.md](modules/llms.md).

Frontend: `components/chat/*` (`useChatRunTail` is the SSE engine,
`useChatMessageUpdates` folds events with RAF-batched deltas, `ForkTreeView`/
`ForkStrip` drive branching). Citations render `[N]` → `ReaderCitation` chips that
push a reader target (`lib/conversations/*`).

### 8.4 Oracle

An agentic "reading" feature over one current curated **public-domain literary
corpus**, which is a real Nexus library (`system_key = 'oracle_corpus'`) of
ordinary indexed media — not an Oracle-owned text/vector store.
`services/oracle.py` owns reading generation: question validation, corpus/personal
retrieval, plate selection, LLM prompt/call, parse, persistence, and SSE event
emission. A short question → retrieve candidates and pick a plate image → one LLM
call produces a structured three-phase interpretation → stream + persist as
`oracle_reading_events` + citation "folios". It has its **own**
prompt/persistence and does **not** use the four chat agent tools, but it
**reuses the SSE transport**. Retrieval consumes the shared search substrate:
`services/search/embedding.build_query_embedding` (one active-model embedding for
both lanes) feeds `search/content_chunk_candidates.retrieve_content_chunk_candidates`,
scoped to the Oracle Corpus library for public-domain candidates (mapped to
resolved `oracle_passage_anchors`, cited as `oracle_passage_anchor:<id>`) and to
the viewer's visible media/notes — excluding the corpus — for personal candidates
(cited `evidence_span`/`content_chunk`). Corpus readiness derives from
`media.processing_status` + `content_index_states` + anchor resolution
(`services/oracle_corpus.py`); the generation worker fails typed
`E_ORACLE_CORPUS_NOT_READY` rather than falling back. Anchor identity is stable
across reindex; opening an anchor citation routes to its current evidence/media
target.

Oracle plate bytes and URLs are separate owned assets. `services/oracle_plates.py`
owns `oracle_plate_url`, DB metadata lookup, stable DB-owned plate storage-key
validation, image-id ETag metadata, and byte-size-checked storage reads. The
public image route is `/api/oracle/plates/[id]` in Next.js →
`/oracle/plates/{id}` in FastAPI. It is cookie-free, internal-header-protected,
and safe for Next Image optimization. The LLM emits only integer candidate
indices + prose; all citation text comes from the retrieved candidates (output
that leaks source text fails the parse). Frontend lives in the separate
`app/(oracle)/` route group (outside the pane system).

### 8.5 Libraries, sharing & the default library's virtual read surface

Content organization + access control, split into three owned modules:
`services/library_governance.py` (the `libraries`/`memberships` tables: CRUD,
roles, ownership transfer, membership guards, ingest access checks),
`services/library_entries.py` (the **sole writer** of `library_entries` — the
`EntryTarget` media|podcast union, the locked append, canonical position
ordering, and all item-in-library commands; it also composes the URL-only
factual view lenses, the fixed `Unfiled`/`In Progress` entry projections, and
the hide-finished completion filter for reads — no DML on
alternate views, positions unchanged), and `services/library_invitations.py` (the
`library_invitations` table). Visibility itself is enforced by the boolean
predicates in `auth/permissions.py`; the search/object readers read
`library_entries` under an explicit Tier-R allowlist.

- Every user has one **default library** (special: can't be renamed/deleted/shared
  or receive physical Podcast entries) plus shareable libraries with `memberships`
  (`admin`/`member` roles; owner is a distinct concept layered on admin).
  `library_entries` point at exactly one media or podcast and carry an integer
  `position` (a per-library `UNIQUE (library_id, position) DEFERRABLE` DB
  invariant since migration `0131`, with cleanup explicit in app code).
- **Sharing**: invites (`library_invitations`) and ownership transfer, both
  admin/owner-gated, with masked-404 for non-members. Accepting an invite is a
  single transaction — membership upsert, then invite status update — and the
  accept response returns `{invite, membership, idempotent}`. The membership
  commit alone is what changes the default library's list and count; there is
  no follow-up backfill worker, projection job, or provenance row to catch up
  (see [`modules/library.md`](modules/library.md)).
- **Resource access sharing**: `resource_grants` stores only direct user or
  anonymous-link grants for canonical media/highlight `ResourceRef` subjects.
  `services/resource_grants.py` owns lifecycle/token/locking; authenticated
  projection lives in `services/resource_sharing.py`; the anonymous read-only
  allowlist lives in `services/public_resource_sharing.py`. Libraries remain
  membership-only, media grants expose no annotations, and owned-highlight
  grants expose exactly the parent media plus the named highlight. Public links
  use a fragment bearer at `/s#share=…`, a token-header BFF, strict format
  DTOs, masked 404s, private-storage mediation, source-revision-bound handles,
  and route-specific no-store/no-referrer/noindex/CSP policy. See
  [`modules/resource-sharing.md`](modules/resource-sharing.md).
- **Writable destinations**: destination pickers use
  `GET /libraries/writable-destinations`; default libraries, member-only
  libraries, duplicate IDs, and inaccessible IDs are not valid write
  destinations.
- **The default library's read surface is a live, deduplicated personal
  "All" query**, not a materialized or backfilled set. It is the union of the
  distinct Media reachable through the viewer's _current_ non-system
  memberships and the viewer's active Podcast subscriptions. Media is
  deduplicated by `media_id` — a direct default entry wins the tie, else the
  earliest entry. Losing a membership removes that Library's Media contribution
  on the next read; deleting a subscription removes its virtual Podcast row.
  Default Podcast rows expose absent placement rather than a fabricated entry
  ID or position. Filing media into the default library directly — the one
  actor-authorized filing command in `library_entries.ensure_media_in_library`
  — always inserts (or idempotently keeps) a physical `library_entries` row
  there; a work already visible virtually through another membership can
  still be explicitly filed, and that direct entry is what a later
  membership loss cannot take away. The browser presents the Default library
  as **All** ("Across your libraries") on the closed alias boundary — library
  row, pane title/label, resource-target results, Dossier and Atlas labels —
  while the domain object, storage row, and API fields keep their internal
  Default identity; `All` is a reserved library name (`400 E_NAME_INVALID` on
  any non-default create/rename). Pagination over any library — default or
  not — is stateless keyset pagination with the unversioned authenticated
  `LibraryEntries` cursor family. Its query digest binds viewer, Library, view,
  order, completion, and a named keyset plan; any wrong family, digest, plan,
  or scalar kind is a clean
  `400 E_INVALID_CURSOR`, never a silent reinterpretation. Canonical order is
  the durable authored order for named Libraries and
  `(addedAt DESC, targetKind ASC, targetId DESC)` for Default. A `view` is the
  order plus a fixed entry projection: `All items (all)` includes Podcast
  shows, while `All items (unfinished)`, `Unfiled` (Default only — direct
  Default media with no other current, non-system placement), or
  `In Progress` (canonical consumption `read_state = 'InProgress'`; podcast
  show rows never match, and the completion filter is unrepresentable with
  it). Factual view lenses (Title/Creator/Published/Added, each ascending or
  descending), projections, and the hide-finished completion filter are
  URL-only: they are never persisted and never write
  `library_entries.position`. In the browser, two process-local monotonic
  revision seams — `lib/libraries/placementRevision.ts` and
  `lib/consumption/projectionRevision.ts` — are published by every definitive
  placement/consumption writer after each acknowledged write, and the Library
  pane refetches its exact requested view when a captured revision advances.
- **Library reading-time is a list projection, not shared media state.**
  `services/media_document_metrics.py` batch-aggregates only the STORED integer
  source counts for ready, quotable web/EPUB/PDF media; `library_entries.py`
  owns the 240-WPM and coarse-rounding policy. Each `LibraryEntryOut` carries a
  required `Presence<ReadingTimeEstimateOut>`. Total is available for positive
  counts; remaining is derived only for in-progress web/EPUB media from the
  canonical consumption projection's monotonic whole-document progression.
  PDF remains total-only, and shared PDF quote readiness uses the stored
  positive word count rather than reading `plain_text`. Nested `media` owns read
  state/progress; the entry does not duplicate them, and no Library list path
  scans source text.
- **Resonance is the one relevance owner.** `services/resonance/` composes
  policy-neutral read ports from consumption, libraries, the resource graph,
  contributors, and the semantic index. It owns Related ordering and the
  on-demand Reading Slate projection; fact owners retain their tables and
  mutations. Library entry ordering is not Resonance's — see
  [`cutovers/library-sorting-hard-cutover.md`](cutovers/library-sorting-hard-cutover.md). `GET /libraries/{id}/slate`
  returns at most ten deterministic, destination-addable suggestions outside
  complete membership. A successful Add preserves visible Slate survivors and
  appends at most one novel result from a canonical refetch.
- **Library Dossier** is the Library binding of Universal Dossiers, not a
  Library-owned subsystem. The Library pane publishes Entries in primary
  content and capability-gated `Members | Connections | Dossier` in the shared
  Resource Inspector; Members is present only for mutable Libraries the viewer
  can administer, and Dossier remains default. Its audience is the Library
  membership scope; direct entries and expanded Podcast episodes are
  intersected with audience-visible Media, and freshness follows the binding's
  typed manifest.

### 8.6 Contributors

A canonical authorship graph split across single owners: `contributor_taxonomy.py`
(leaf — role vocabulary, name normalizers/handle generation, no DB import),
`contributors.py` (the public author-operations facade: search, contributor
detail, distinct works, ref resolve/hydrate for panes, observed role-slice
replacement, media-author PUT/reset, rename, and the transaction-scoped
target-cleanup/orphan-prune helpers — no second identity/write path exists),
two private collaborators it alone calls (`_contributor_identity.py` for
identity-row resolution/creation/alias attachment, `_contributor_credit_writes.py`
for all credit-row DML and the media manual/automatic pin), `_contributor_replay.py`
(forced-new-edit replay memos), and `contributor_credits.py` (the read-side
credit junction: canonical credit relation + visible-work queries). Every final
`contributors` row is active — there is no self-FK, status, merge, split, or
tombstone; duplicates were collapsed once by migration 0179 and never merge at
runtime. `contributor_aliases` (searchable names, `resolves_identity` marks
which ones bind a future observation) and `contributor_external_ids` (orcid/
isni/viaf/…, globally unique per authority) support identity; `contributor_credits`
attaches a contributor to exactly one media/podcast/Gutenberg-ebook role slice.
Credit resolution prefers explicit id → exact stable key → confirmed alias →
new contributor, and runs inline inside the same fresh SERIALIZABLE-retried
transaction (`retry_serializable`, D-11 constraint allowlist) that replaces a
lane's declared observed role slice — there is no separate dedupe job, proposal
table, or merge contract (§ job registry, below). Visibility predicates
(`visible_podcast_ids_cte_sql`, `visible_content_credit_rows_sql`,
`visible_contributor_ids_cte_sql`) live solely in `auth/permissions.py`;
persisted-chat-ref checks live in `chat_context_refs.py`. There is no `/authors`
directory or root Authors pane; author search lives in desktop Nexus
at `/search?kinds=people`, and author chips link to the `/authors/{handle}`
detail-only pane (works list, curator-gated rename).

### 8.7 Notes and pages

Pages and notes are resource surfaces, not documents or trees. A `page` owns
only its title; a `note_block` owns only its ProseMirror body. Their pane bodies
are the same flat, one-hop projection of explicit outgoing `resource_edges`
where `kind='context'`, `origin='user'`, `source_order_key IS NOT NULL`,
`ordinal IS NULL`, and `snapshot IS NULL`. The edge id is the stable occurrence
id and the dense order key is its rank. A move changes rank without replacing
the edge; unlink removes only the edge, never its target.

`services/resource_items/surfaces.py` owns the batched read projection and the
atomic `insert_note`, `split_note`, `insert_resource`, `move`, and `remove`
commands. Commands use resource versions, durable mutation replay, and one
SERIALIZABLE transaction. Surface activation uses the bounded batch router, so
heterogeneous rows add no per-occurrence query loop. Intrinsic page-title and
note-body edits use the resource-item mutation owner. `services/notes.py`
remains the notes collection, daily-page, dated-capture, and Dawn Write facade.
A daily date is a latent non-mutating locator until its first meaningful Note.
That first capture creates the ordinary Page, binding, Note, ordered
occurrence, required versions, and replay receipt in one serializable
transaction. Later edits use the ordinary resource-surface mutation owners.
Amanuensis composes the surface owner's insert-note capability and does not own
a second surface-write protocol.

Inline `object_ref`/`object_embed` nodes remain part of note prose and sync
`origin='note_body'` edges. Highlight notes remain ordinary notes linked by an
`origin='highlight_note'` edge. Note bodies retain direct indexing through
`note_indexing.enqueue_note_reindex`. Backlinks, citations, and inferred
relations remain Companion concerns rather than editor rows.

Frontend composition is one `PagePaneBody`, one `ResourceSurfaceEditor`, and
one `useResourceSurfaceSession` for ordinary Page refs and dated daily
locators, with `NoteBodyEditor` as the sole prose primitive. Pane visit/session
identity remains stable while a latent date hydrates or adopts `page:{id}`.
Quick Note adds one provisional final Note immediately; persisted hydration
merges before it, and acknowledgement cannot erase later local keystrokes.
`ResourceSurfaceBodyEditor` is a React-owned flat occurrence list, not a second
serialized ProseMirror document; each inline note owns one independent editor
keyed by stable resource identity. Enter in a surface note splits to a new
note; Shift+Enter adds a line break. Page-title Enter focuses or inserts the
first note. The editor does not expose hierarchy, collapse, cross-note merge,
or full-list replacement semantics.

### 8.8 Lectern & podcast playback

`services/browse/*` owns Podcast Index discovery and read-only Preview.
`services/podcasts/*` owns Subscribe/unsubscribe, OPML, canonical Podcast and
episode identity, live feed sync, the independent historical backfill, and
explicit Transcribe after acquisition. A subscription exists exactly while its
row exists. Named Podcast placement is only `library_entries(podcast_id)`;
Default/All projects active subscriptions virtually.

Subscribe enqueues one live sync and one `podcast_subscription_backfills` chain.
The live path keeps current episodes fresh while the backfill walks history in
fenced, retryable steps, and either path may continue when the other fails.
Both paths ingest metadata, stable aliases, chapters, playback URLs, and RSS
transcript references only. They never fetch or publish a transcript. Explicit
Episode Transcribe prefers a publisher sidecar, then the quota-gated Deepgram
path; explicit Video Transcribe uses the YouTube caption provider. Current
transcript origin is exactly `Publisher | Imported | Generated`.

The **Lectern** is the one ordered, mixed-media list of outstanding intentions
(podcast, video, reader, agent, and Nexus actions all address it); **Now
Playing** is one device-local audio session, not a second durable list.
`services/consumption/` is the sole backend consumption owner, split by table:
`_lectern_store.py` (`consumption_queue_items` membership/order + the
canonical `LecternSnapshot`), `_state_store.py` (`consumption_overrides`
explicit `Unread`/`Finished` plus the natural-end override revision),
`_listening_store.py` (`podcast_listening_states`
position/duration/nullable established episode rate + heartbeat fencing tokens
`write_revision`/`reset_epoch`), `_reader_cursor_store.py`
(`reader_media_state` revisioned
`Empty`/`Positioned` cursor CAS), `_reader_engagement_store.py`
(`reader_engagement_states`, the sole DML owner of current-state reader
recency — `last_engaged_at` plus, for non-PDF locators, a monotonic
`max_total_progression`), `_activity_store.py`
(`consumption_activity_spans` and `consumption_completion_facts` DML),
`_activity_stats.py` (read-time aggregation/sessionization), and `_projection.py`
(the combined explicit-override + reader-engagement read model, plus batched
`PlayerDescriptor`s reusing `derive_playback_source`). Consumption exposes
policy-neutral engagement and complete queue-membership reads to Resonance; it
does not own a second public Recent product. `GET /lectern/slate` builds the
on-demand **At hand** projection from Continuity, Arrival, and factual graph,
author, and calibrated semantic evidence. It returns at most ten placeable
media outside the complete queue and excludes `Finished` targets. Two bounded
aggregate command ports — `POST /lectern/commands`
(`PlaceItems`/`RemoveItem`/`SetOrder`) and `POST /consumption/commands`
(`EnsureMediaFinished`/`FinishLecternItem`/`SetUnread`/`UndoCompletion`/
`SetBatchState`/`ResetProgress`/`SettleNaturalEnd`) — each
share one `retry_serializable` transaction, one canonical response, and
`clientMutationId` replay through `services/resource_mutation_replay.py`;
`GET /lectern` and the retained `GET`/`PUT /media/{id}/listening-state`
heartbeat sit outside that replay ledger. Owned-absence fields on every wire
shape use `Presence<T>` ([`rules/boundaries.md`](rules/boundaries.md)), never
`null` or omission.

Media teardown (see [`modules/storage.md`](modules/storage.md)) composes one
consumption call, `consumption_service.delete_media_consumption_state_in_txn`
(all users' Lectern/override/listening/reader-cursor/reader-engagement/
activity/completion rows), inside the
deletion transaction — `media_deletion.py` never writes those tables
directly.

Frontend: `AuthenticatedShell` mounts `LecternProvider` (one `AsyncResource` +
one mutation FIFO, `lib/lectern/`) above `GlobalPlayerProvider` (one
`PlayerSession`, `lib/player/`), which wraps `WorkspaceHost` and
`GlobalPlayerSurfaces`. The latter projects one shell-owned **Media player**
landmark as the desktop Listening Shelf or mobile MiniPlayer/full-screen Now
Playing; it persists across pane navigation and is never an editor. Session
presence, playback phase, and mobile presentation mode are independent: Pause
retains the surface, Back/Collapse retains playback, and Close stops and
dismisses the device-local session. The provider selects exactly one runtime:
non-Android uses one browser-owned `<audio>` element, transparent output-effects
graph, browser Media Session, heartbeat, and listening recorder; the Android
shell uses the service-owned Media3 player through the exact `nexusPlayer`
WebKit protocol and mounts none of those browser owners. The provider exposes
stable Commands plus cadence-separated Session, Settings, and Timeline
capabilities. Canonical natural end is one receipt-backed
`SettleNaturalEnd` mutation; settlement does not require the ended session to
still exist. See
[`modules/player.md`](modules/player.md) and
[`modules/consumption-activity.md`](modules/consumption-activity.md) for the
full file map. The shared player also owns an exhaustive ephemeral
`PreviewAudio` session: it starts at `1x` and has no Media ID, queue/history
origin, heartbeat, podcast preference, activity/completion writes, or
previous/next behavior. After Episode Add, the
consumption owner may install the observed Preview position once, only when
owned progress is still empty. The shared
`ReadingSlateSection` consumes an optional Lectern first-paint seed and
otherwise queries only while its pane is active. It delegates Add to the
existing Lectern or library mutation owner and owns deterministic stable
refill, not destination state.

### 8.9 Consumption Activity & Stats

`services/consumption/` stores two historical fact families only: bounded
observed spans and first post-cutover completion facts. The browser's one
tab-local recorder is fed by the reader, the owned global audio element, and
the visible embedded-video pane; it never exposes the raw `nx_device` value.
`/stats` renders URL-owned factual time buckets, current visibility-scoped
breakdowns, derived sessions, and a deterministic Year in Reading view. The
full contract is [`modules/consumption-activity.md`](modules/consumption-activity.md).

### 8.10 Search, Browse, desktop Nexus, and mobile Nexus

The same `search()` backs the `/search` results page, mobile Nexus deep
results, desktop Nexus results, and the chat `app_search` tool. All consume
the canonical frontend `SearchQuery` model. Desktop **Nexus**
(`components/nexus/`, `lib/nexus/`) is a controlled switchboard presentation
over explicit result projections, not a second search model: its zero state is
existing opens plus New Chat, New Note, New Page, and Import; Find consumes
the canonical search projection. “Search the web…” commits to
`/browse?kind=WebArticle&q=…`; Podcast discovery commits to
`/browse?kind=Podcast`. Enter/click follows the selected identity and
Shift+Enter/Shift+click forks it. There is no standalone Web Search product
surface or Add-before-Preview path.

Mobile uses one opaque **Nexus full-screen task** (`components/switchboard/`,
`lib/switchboard/`) instead of an app-navigation drawer or bottom sheet.
Its Root paints synchronously from workspace state and fixed Place/Quick
projections. Find merges local pane/destination matches, one-character
route-only openable resources, and two-character canonical search results while
preserving pane, destination, occurrence-resource, owner-resource, and
activation-route identities. All owned-resource opens use workspace `Adopt`;
external discovery remains in explicit acquisition workflows.

The task changes presentation only: the existing controller and pages remain
one replacement hierarchy with one page-owned header and content scroll owner.
The viewport-fixed dialog owns an opaque safe-area- and keyboard-aware canvas;
it has no scrim, grabber, outside-click target, drag dismissal, or
primitive-owned toolbar. Guarded Back pops one Nexus level before dismissing
Root, nonnavigation close restores control focus, and accepted workspace
activation leaves focus with the destination.

**Browse** is a fixed desktop/mobile destination and a read-only discovery
boundary. `/browse` owns exact `q`, `kind`, `source`, and `sort` URL state; the
browser fans All out into concrete requests for PDF (Nexus), EPUB
(Nexus/Project Gutenberg), Web Article (Nexus/Brave), Video (Nexus/YouTube), and
Podcast (Podcast Index). `/browse/preview` re-resolves a sealed
`DiscoveryTarget` against provider truth and writes nothing. Owned results open
their canonical pane; external results open Preview before explicit Add or
Subscribe. Preview proxies remote images, never frames arbitrary web, loads the
official YouTube iframe only after action, and starts remote Podcast audio only
after action. `BrowseSearch` and `BrowsePreviewEpisodes` are signed, unversioned,
query/plan-bound cursor families.

Acquisition reuses canonical owners: URL Add calls `/media/from_url`, episode
Add calls `/podcast-episodes/from-discovery`, and Subscribe calls
`/podcasts/subscriptions`. Replayable commands use the required
`Idempotency-Key`, stage Default/All plus named destinations, and replace Preview
with the canonical owned pane only after success. Browse and Preview deliberately
publish no Pane Search/Find capability.

---

## 9. Frontend architecture

The web app (`apps/web`, Next.js 15 App Router) has one structural idea you must
internalize first:

**Routing is a client-side pane system, not Next.js `children`.** The
`(authenticated)` layout renders a fixed `AuthenticatedShell` and _ignores_
`children`. Each route's `page.tsx` exists only so Next resolves the URL; the
actual body is a `*PaneBody` component that the **pane route registry**
(`lib/panes/paneRouteModel.ts`, `lib/panes/paneRouteTable.ts`, and
`lib/panes/paneRenderRegistry.tsx`) resolves and renders inside a pane. The URL
is a _projection_ of the active pane (mirrored via `history.replaceState`), not
the driver. New devs frequently look in `page.tsx` for behavior that lives in
`*PaneBody.tsx`.

Authenticated entry is classified once by `loadWorkspaceBootstrap`: pathname
`/` is Resume and preserves the selected saved workspace exactly; every other
protected href is Navigate and uses the existing deep-link merge. With no usable
saved session, Resume creates the existing one-pane Lectern empty state.
`/lectern` remains explicit Home. Shell global-access query intents are consumed
in a layout effect before the workspace's passive state-to-URL projection, so
they open over Resume and never become panes.

- **Workspace shell** (`lib/workspace/*`, `components/workspace/*`): a tabbed,
  multi-pane canvas. Durable state (`WorkspaceState`: primary panes with
  visit-identified Back/Forward history, attached secondary tool panes, widths)
  lives in a React reducer+context store and is persisted
  **per-user-per-device** to `workspace_sessions`. Current-tab return
  presentation is separate: `PaneReturnMementoProvider` keys semantic
  scroll/focus mementos and bounded route-owned loaded extent by the exact
  `PaneVisit` UUID. `PaneShell` is the sole primary vertical scroll owner for
  ordinary routes; Reader, Chat transcripts, and Atlas retain distinct owners.
  A pane is identified by a stable pane id; its resolved `routeKey` gates
  route-scoped labels, layout, secondary/fixed chrome, primary-chrome
  publication, and return data so stale cleanup cannot mutate a newer route
  instance. `WorkspaceStoreProvider` separately owns a bounded ephemeral
  recently-closed stack and atomic normalized restoration; it is intentionally
  absent from persistence codecs.
  Routes resolve via a pure model (`paneRouteModel.ts`) plus metadata table
  (`paneRouteTable.ts`) bound to React bodies (`paneRenderRegistry.tsx`). Bodies talk
  to the shell only through `paneRuntime.tsx` hooks (`usePaneRouter`, `usePaneParam`,
  `useSetPaneLabel`, `usePaneSecondary`) and route-keyed
  `usePanePrimaryChrome`; `usePaneRuntime().isActive` exposes the
  host's pane-activity capability, which reader progress uses for
  adoption-versus-handoff arbitration. `MobileViewportProvider` composes safe
  area, the measured outer Nexus wrapper and MiniPlayer, root text-entry focus,
  and active mobile-overlay keyboard inset into one shared mobile content-clearance
  value. Text entry keeps playback alive while hiding and unregistering the
  MiniPlayer.
  `MobileChromeProvider` projects reader collapse to AppBar, the active
  PaneToolbar, and the inner NexusControl without moving that wrapper. Every
  eligible resource pane publishes one
  `resource-inspector` secondary group through `useResourceInspector`: Media
  (`Contents | Evidence | Dossier`), Conversation
  (`Context | Forks | Dossier`), Library
  (`Members | Connections | Dossier` when the viewer can administer it, else
  `Connections | Dossier`), and Podcast/Author/Page/Note
  (`Connections | Dossier`). One visible Companion action opens the same group
  on desktop and mobile; open state, active tab, width, and viewed Dossier
  revision are workspace-local.
  Every supported route declares a typed section/resource header contract.
  `PaneShell` combines that contract with one primary-chrome publication and
  projects it into a 44px desktop section header, 60px desktop resource header,
  or 60px mobile top bar (safe area additional). Resource identity is title plus
  structured credits; actions/options are typed descriptors shared by desktop
  `ActionBar` and mobile Options. A pane-scoped error boundary contains chrome and
  body failures without replacing sibling panes or the workspace.
- **App navigation is a curated projection, not a feature directory.**
  `lib/navigation/destinations.ts` owns destination identity;
  `components/appnav/navModel.ts` independently owns the flat desktop rail and
  mobile Places projections. Mobile global access is the bottom Nexus control
  plus its full-screen task, not a navigation drawer, bottom sheet, or second
  desktop palette. Section routes
  derive semantic navigation ownership from
  `header.destinationId`; resource routes (notably `/media/{id}`) declare one
  `sectionDestinationId`, with no duplicate field or prefix map. All cross-pane
  product targets dispatch through `activateWorkspaceTarget`: plain click and
  Enter follow an exact open pane or navigate the origin pane, Shift+click
  always forks a fresh pane, and named source-preserving workflows adopt an
  exact pane or create one. Meta/Ctrl/Alt/non-primary gestures remain native.
  The activation result assigns focus to the source only for
  unchanged/rejected activation and to the destination for a real handoff, so
  closing global/account surfaces does not strand or steal focus. Lectern is
  the brand and authenticated-home target.
  Pinning is intentionally absent; personalized retrieval lives in the Lectern
  Reading Slate and Nexus ranking. See
  [`modules/app-navigation.md`](modules/app-navigation.md).
- **First paint: stream, don't gate.** The `(authenticated)` layout runs only
  **local** work (`verifySession`, header-derived `loadRenderEnvironment`) above a
  `<Suspense fallback={<AuthenticatedShellSkeleton/>}>`, itself wrapped in
  `AuthenticatedWorkspaceErrorBoundary` (a client class boundary — a same-segment
  `error.tsx` cannot catch its own layout); `WorkspaceBootstrapGate` awaits the data
  root inside the boundary and streams the shell in. The first HTTP flush is the
  chrome skeleton (nav-rail placeholder + pane region in `PaneLoadingState`)
  — **data never gates TTFB**. The data root (`loadWorkspaceBootstrap`) is parallel and
  restore-aware: two concurrent `Promise.all` waves — (1) the reader profile — a
  **required** read on the normal 30 s server-request deadline, since it seeds
  `ReaderProvider` and workspace width restoration, so a failed or malformed read
  rejects the whole bootstrap rather than fabricating a default — alongside the
  best-effort saved session and, only for Navigate, the explicit pane's
  speculative resource seed, then (2) the remaining restored visible panes —
  returning `{ readerProfile, initialState, resources }` (a hydration cache keyed
  exactly as each pane's `useResource` reads it). Resume never seeds root. Session
  and pane seeds stay best-effort under a deadline; a timed-out seed degrades to
  the normal client fetch.
  A rejected bootstrap surfaces as the error boundary's accessible Retry UI, which
  re-issues the Server Component request (`router.refresh()`) before resetting the
  boundary.
- **Server-side restore (no round-trip, no flash).** Device identity is a server-owned
  httpOnly `nx_device` cookie minted in middleware (`lib/auth/deviceCookie.ts`) —
  request-forwarded so this SSR sees it, response-set for future requests. The data root
  reads it, fetches the saved workspace-session, and classifies `/` as Resume or every
  other protected href as Navigate. Resume uses `selectRestoredState` unchanged or the
  Lectern empty state; Navigate applies `mergeRestoredWorkspaceWithDeepLink`. The store
  **seeds its reducer** with that `initialState`, so the first render already shows the
  right panes (no `hydrate` dispatch on load). `useWorkspaceSession` keeps only **capture**
  (debounced PUT) + **flush** (keepalive on page hide); the BFF `PUT /api/me/workspace-session`
  injects the device id from the cookie — the client never reads or sends it. Identity
  (which panes) is owned by the server; column **widths** reconcile on the client at render
  via `resolveEffectivePaneSizing` — server width metrics derive from the reader profile
  (shared `estimatePrimaryWidthPx`) so widths match first paint and need no settle. The
  URL-hash fold navigates the active pane (preserving the restored layout) rather than
  resetting state. The restore algebra lives in one isomorphic resolver
  (`workspaceRestore.ts`, server-safe, shared by the bootstrap and the store reducer;
  `schema.ts`/`paneWidth.ts` are likewise isomorphic, not `"use client"`). The
  canonical `/lectern` request is explicit home intent: restore preserves the saved
  layout, then reuses or appends and activates Lectern; it is not a neutral alias for
  the previously active pane.
- **Measurement loop.** `nexus:web-vitals` → `WebVitalsReporter` subscriber →
  `sendBeacon` → BFF `/api/telemetry/web-vitals` → FastAPI `/telemetry/web-vitals` →
  structlog `rum.web_vital` (request-id-correlated). A CI **First Load JS budget**
  (typed `bundle` capability, ≤ 115 kB gz vs ~104 kB measured) runs in the
  strict-CSP standalone build. Kept
  constraints: nonce-CSP + **streaming only** — no PPR, no `next/dynamic`, no
  server-emitted `modulepreload` (chunk URLs are unknown server-side); `React.lazy` +
  runtime `preloadPane` (warming all restored visible panes) stays the splitting mechanism.
- **BFF / proxy / auth / SSE** (`lib/api/*`, `lib/auth/*`, `lib/supabase/*`): covered
  in §5. The browser holds **no** Supabase client and no tokens; `lib/auth/dal.ts`
  `verifySession()` is the one verified-session boundary for protected pages/
  actions; the SSE client mints fresh single-use tokens per connect.
- **Surfaces** (`components/*`, `app/(authenticated)/**/*PaneBody.tsx`): reader,
  chat, player, notes editor, Nexus, search, contributors, libraries/
  items, billing/settings — all rendered as pane bodies. UI primitives live in
  `components/ui/*`; cross-cutting hooks in `lib/ui/*`; theming via a `nx-theme`
  cookie; keybindings in `lib/keybindings.ts`; Android-shell adaptation in
  `lib/androidShell.ts`.

---

## 10. Non-web clients

**Android shell** (`apps/android`): a Kotlin app with `MainActivity` for the
hardened WebView and `ShareActivity` for system-share capture. The WebView has
no `addJavascriptInterface`, file/content access, third-party cookies, or
off-origin in-WebView navigation. Two strict AndroidX WebKit listeners are
confined to the exact owned origin and main frame: `nexusOfflineMedia` carries
download commands/snapshots, and `nexusPlayer` carries service-player
commands/snapshots. `NexusOriginClient` calls only fixed listening-state and
Consumption-activity BFF paths with WebView cookies; arbitrary native product
HTTP is forbidden. `OfflineMediaStore` is the sole device owner of Media3
downloads, index, non-evicting app-private cache, public-media data source,
network policy, account purge, recovery, and native playback source
resolution. Ready canonical audio is read directly from that cache; the
superseded WebView GET/range route does not exist. Work resumes only after a
verified account handshake while Nexus is foregrounded; there is no
boot/background scheduler or cold-launch-offline shell. Native Google sign-in
(Credential Manager) and Custom-Tab OAuth both converge on a server-minted,
single-use, PKCE-bound
`nexus://auth/handoff` code that injects a first-party session cookie into the
WebView. App Links are backed by
`apps/web/public/.well-known/assetlinks.json` (validated against the release
signing cert at build time). The web app detects the shell via a `NexusAndroidShell`
UA token for presentation adaptation only. Each exact capability handshake,
never the UA, is capability truth and the UA never authorizes browser-player
fallback.

**Browser extension** (`apps/extension`): a Manifest V3 capture tool. It connects
via `launchWebAuthFlow` against `/extension/connect/start`, obtains a revocable
`nx_ext_` bearer token, and POSTs captured content to `/api/media/capture/{article,
url,file}` (articles via Mozilla Readability in a content script; PDFs/EPUBs
downloaded in-browser and re-uploaded; YouTube as a URL). These go through a
**separate** BFF proxy path (`proxyExtensionToFastAPI`) that forwards the extension
bearer rather than the Supabase cookie. Captured items enter the normal ingest
pipeline.

---

## 11. Build, run, deploy, env, migrations

The `Makefile` owns product setup, development, build, migration, smoke, and
deployment helpers; `make help` is canonical for those operations. Testing has
one separate typed entrypoint, `./scripts/test`.

- **Setup / dev loop**: `make setup`, `make dev` (Docker Compose Postgres + MinIO +
  Supabase-local Auth), then `make api`, `make web`,
  `make worker-interactive`, and `make worker-background` in separate
  terminals. Ports are written to `.dev-ports`.
- **Formatting**: `make format`, `make format-back`, `make fix-front`.
- **Tests and verification**: see §12; no Make aliases.
- **Build**: `make build` (Next.js), `make build-android[-release]`.
- **Smoke**: `make smoke`, `make smoke-auth-redirects`.

**Deploy** (`deployment.md`, `deploy/`): the frontend deploys to **Vercel on push
to `main`** (Git integration). The backend deploys via `deploy/hetzner/deploy.sh`:
sync env → rsync repo to the VPS → `compose build` → stop both workers + API → **run
`alembic upgrade head`** via API-image one-off `compose run` commands → run
Oracle preconditions via the background worker image:
`python /app/scripts/ensure_oracle_seed_objects.py` →
`python /app/scripts/oracle/seed_corpus_library.py --owner-user $NEXUS_ORACLE_CORPUS_OWNER_USER_ID --drain` →
`python /app/scripts/oracle/check_corpus_readiness.py` → `compose up -d
--force-recreate`. Env contracts live in `deploy/env/*` (real values untracked,
`.example` tracked); the sync scripts strongly validate them and reject legacy
Supabase/`STORAGE_*` keys. R2 CORS/lifecycle are applied as code via
`deploy/cloudflare/*`. Supabase hosted Auth redirect config is verified as
provider state with `deploy/supabase/verify-auth-redirects.sh`, not trusted as a
manual dashboard checklist.

**Migrations** are hand-written Alembic files (`migrations/alembic/versions/`,
linear `NNNN_*` numbering, no autogenerate). Dev: `make migrate`. Test: the
controller creates a disposable `nexus_migration_<run-id>` database when that
capability is selected. Prod: run on every deploy before services start.

**Environment**: `.env.example` is the source of truth for every variable
([`rules/codebase.md`](rules/codebase.md)); `make setup` generates local
`.env` + `apps/web/.env.local`. Major groups: app/env, database + pool, Supabase
Auth (issuer/JWKS/audiences), internal secret, encryption key, LLM providers +
flags + rate limits, Brave Browse/chat search, streaming (token signing key + base URL +
CORS), podcasts, browse providers, worker schedules, Stripe. Worker lanes are
Compose-owned rather than stored in the merged production env.
The test controller owns a persistent workspace-local PostgreSQL/MinIO and
Supabase Auth stack, per-run database/bucket state, and per-scenario users. It
passes the Supabase admin key only to controller-owned user lifecycle code;
Next.js, FastAPI, worker, and migration processes receive only their explicit
test allowlists.

**CI**: `.github/workflows/ci.yml` invokes only `./scripts/test pr` and retains
the same-run summary even on failure. Protected manual/scheduled workflows own
`nightly` and `release`; paid providers and signed release proof never run in
ordinary PR CI.

---

## 12. Testing strategy

[`local-rules/testing-standards.md`](local-rules/testing-standards.md) is the
authoritative contract. `./scripts/test` owns selection, static policy, local
runtime, runners, cleanup, memory/cost bounds, and versioned evidence.

The portfolio is outcome-heavy: comprehensive preventive/static proof; a small
semantic kernel; a dominant middle of real-PostgreSQL service and real-Chromium
component proof; ten thin product journeys; and separately scheduled
provider/device/release proof. Owned Nexus behavior is not mocked. Only an
external boundary may use a small fake or protocol fixture.

The persistent local services are reused, but every workflow receives a
template-cloned database, MinIO bucket, run ledger, and scenario-local users.
All ordinary proof is external-network denied. Playwright has one config under
`apps/web/e2e/`, one worker, zero retries, strict CSP, fresh contexts, and no
shared seed/auth state. Priority risks and the canonical cross-language corpus
are machine-owned by `testdata/proofs.json` and `testdata/manifest.json`.

---

## 13. Invariants cheat-sheet

The things most likely to bite you, distilled:

1. **Never call blocking DB on the event loop** — plain `def` handlers or
   `run_in_threadpool`. The DB connection is released at `http.response.start`, so
   don't touch the ORM while streaming a body.
2. **The browser holds no tokens.** Product data goes through `/api/*`; only SSE
   talks to FastAPI directly, with a single-use stream token minted per connect.
3. **Private and public asset lanes are different.** `/api/media/image` and EPUB
   assets are viewer-authenticated and unoptimized; `/api/oracle/plates/[id]` is
   cookie-free, internal-header-protected, DB-owned by stable storage key, and
   optimizable.
4. **`services/media.py` is catalog/hydration, not an ingest catch-all.** URL
   ingest, X, YouTube, remote files, EPUB assets, listening state, file access,
   and processing transitions have named owners.
5. **`ready_for_reading` is the document success terminal**; search/embedding
   readiness is a _separate_ state machine. Source-attempt retry and metadata
   retry are user-visible retry capabilities; `source` is not a `failure_stage`.
6. **Reader offsets are Unicode codepoints into current `canonical_text`.** The
   frontend canonicalizer must byte-match the Python one; a mismatch disables
   highlighting for that fragment.
7. **One send = one durable `ChatRun`**; HTTP never calls the provider; the worker
   does; the client only tails SSE and reconciles.
8. **Active conversation path is per-viewer**; only path messages enter context.
9. **Citation `[N]` is a dense, turn-global ordinal carried on an
   `origin='citation'` `resource_edge`**, not a per-tool index and not a column on
   `message_retrievals` (which is telemetry pointing back via `cited_edge_id`); the
   attached-reference citation regression came from breaking this density.
10. **Assistant trust trails are read models, not new truth.** They are assembled
    when assistant messages are read from chat runs, prompt assemblies, tool calls,
    retrieval ledgers, citation edges, and context-ref-added events. Message
    documents remain text-only.
11. **`background_jobs` is raw SQL**, invisible in `models.py`. Most ingest tasks'
    `{"status":"failed"}` returns mark the _queue_ row succeeded; recovery is the
    reconciler + manual retry.
12. **No DB cascades.** Deletion is explicit, reference-counted, and orders external
    (storage) effects after the DB commit.
13. **pgvector is fixed at 256 dims**; chunk ANN uses the current embedding
    provider/model rows. A model change requires rebuilding current embeddings
    before semantic search should depend on them.
14. **Frontend routing is the pane system, not `children`.** Behavior lives in
    `*PaneBody.tsx`; the URL is a projection of the active pane.
15. **Migrations are hand-written**; `models.py` and the live DB can drift —
    there's no autogenerate safety net.

---

## 14. Where to look (file index)

| You want…                                                         | Start at                                                                                                                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repository rules / boundaries                                     | [`rules/index.md`](rules/index.md)                                                                                                                                                                     |
| Reader behavior contract                                          | [`modules/reader-implementation.md`](modules/reader-implementation.md), [`modules/reader-design-rationale.md`](modules/reader-design-rationale.md)                                                     |
| FastAPI bootstrap / middleware / lifecycle                        | `python/nexus/app.py`, `python/nexus/middleware/`, `python/nexus/auth/`                                                                                                                                |
| DB layer / sessions / LISTEN-NOTIFY                               | `python/nexus/db/` (`engine.py`, `session.py`, `listen.py`)                                                                                                                                            |
| The schema                                                        | `python/nexus/db/models.py` (+ `migrations/alembic/versions/`)                                                                                                                                         |
| Background jobs / worker                                          | `python/nexus/jobs/`, `python/nexus/tasks/`, `apps/worker/`                                                                                                                                            |
| Media catalog and ingest owners                                   | `python/nexus/services/media.py`, `media_ingest.py`, `media_source_ingest.py`, `x_ingest.py`, `youtube_video_ingest.py`, `remote_file_ingest.py`, `remote_file_client.py`, `media_processing_state.py` |
| Reader/highlights backend                                         | `python/nexus/services/{reader,epub_*,pdf_*,fragment_blocks,highlights,passage_anchors,locator_resolver,text_quote,pdf_quote_match}.py`                                                                |
| Chat / conversations                                              | `python/nexus/services/chat_runs.py` + `chat_run_*`, `context_assembler.py`, `conversations.py`                                                                                                        |
| Oracle                                                            | `python/nexus/services/oracle.py`, `python/nexus/services/oracle_corpus.py`, `python/nexus/services/oracle_plates.py`                                                                                  |
| Search / retrieval / indexing / resource target/openable search   | `python/nexus/services/{search,content_indexing,semantic_chunks,retrieval_citation}.py`, `python/nexus/services/search/candidates.py`, `python/nexus/services/resource_items/{targets,openables}.py`   |
| Resource graph (edges, refs, citations, connections, Link/stance) | `python/nexus/services/resource_graph/` (`refs`, `resolve`, `edges`, `connections`, `context`, `citations`, `cleanup`, `user_relations`, `policy`)                                                     |
| Universal Dossiers / Media Intelligence                           | `python/nexus/services/artifacts/`, `python/nexus/services/media_intelligence.py`, `python/nexus/api/routes/dossiers.py`                                                                               |
| Agent tools                                                       | `python/nexus/services/agent_tools/`                                                                                                                                                                   |
| Libraries / contributors / notes                                  | `python/nexus/services/{library_governance,library_entries,library_invitations,contributors,notes}.py`                                                                                                 |
| Resource grants / public sharing                                  | [`modules/resource-sharing.md`](modules/resource-sharing.md), `python/nexus/services/{resource_grants,resource_sharing,public_resource_sharing}.py`, `apps/web/src/{components,lib}/sharing/`, `apps/web/src/app/s/` |
| Podcasts / playback                                               | `python/nexus/services/podcasts/`, `python/nexus/services/consumption/`, `python/nexus/api/routes/{lectern,listening_state}.py`                                                                        |
| Auth / billing / keys / rate limit                                | `python/nexus/services/{user_keys,billing,billing_entitlements,rate_limit}.py`, `python/nexus/auth/`                                                                                                   |
| Frontend BFF / auth / SSE                                         | `apps/web/src/lib/{api,auth,supabase}/`                                                                                                                                                                |
| Workspace / panes / mobile viewport                               | `apps/web/src/lib/{workspace,panes,mobileViewport}/`, `apps/web/src/components/workspace/`                                                                                                             |
| Desktop Nexus / mobile Nexus task                                 | `apps/web/src/components/{nexus,switchboard}/`, `apps/web/src/lib/{nexus,switchboard}/`                                                                                                                |
| Reader / chat / player UI                                         | `apps/web/src/components/{reader,chat}/`, `apps/web/src/lib/{reader,highlights,conversations,player,lectern}/`                                                                                         |
| Android shell                                                     | `apps/android/app/src/main/`                                                                                                                                                                           |
| Browser extension                                                 | `apps/extension/`                                                                                                                                                                                      |
| Build / run / deploy                                              | `Makefile`, `deployment.md`, `deploy/`                                                                                                                                                                 |
| Tests                                                             | `docs/local-rules/testing-standards.md`, `python/nexus_test_control/`, `python/tests/`, `apps/web/e2e/`, `apps/web/vitest.config.ts`, `testdata/`                                                        |

---

_This document is an overview maintained alongside the code. When a slice's
behavior changes materially, update the relevant section here and the canonical
rule/module doc it links to._
