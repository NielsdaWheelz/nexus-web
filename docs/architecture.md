# Nexus Architecture & System Guide

This is the canonical orientation document for the Nexus codebase. It explains how
the whole system fits together — the runtime topology, the data model, the
cross-cutting mechanisms, and every product slice — so that a new engineer can
learn the system and an experienced one can find anything at a glance.

It is an **overview**, not a rulebook. The normative engineering rules live in
[`rules/`](rules/index.md); the reader behavior contract lives in
[`modules/reader-implementation.md`](modules/reader-implementation.md) and
[`modules/reader-design-rationale.md`](modules/reader-design-rationale.md). This
doc links to those rather than restating them.

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
- a block-based **notes** outliner that links to anything;
- an **AI chat** that streams answers grounded in retrieval over your library,
  with branching conversations and clickable citations that jump into the
  reader;
- a **library-sharing** model and a canonical **contributors** (authorship)
  graph;
- a **podcast** subsystem with subscriptions, transcription, and a playback
  queue;
- the **Oracle**, an agentic "reading" feature over a curated public-domain
  literary corpus.

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
                           └──────┬───────┘            ┌────────────────┴───┐
                                  │                    │  Worker (apps/worker)│
                                  │ object refs        │  ingest, transcribe, │
                                  ▼                    │  chat runs, oracle,  │
                           ┌──────────────┐            │  podcast sync, ...   │
                           │ R2 / MinIO   │◀───────────└──────────────────────┘
                           │ object store │
                           └──────────────┘

   Identity: Supabase Auth (JWT/JWKS) only — no Supabase DB or Storage.
   External: OpenAI / Anthropic / Gemini / OpenRouter / Cloudflare (LLM + embeddings),
             Brave (web search), Podcast Index, Deepgram, YouTube Data API
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
[`rules/transport.md`](rules/transport.md).

---

## 3. Runtime topology & deployment

There are **four runtime processes** plus managed dependencies.

| Process | Code | Hosted | Role |
|---|---|---|---|
| Next.js frontend + BFF | `apps/web` | **Vercel** (Git-triggered) | React UI + `/api/*` proxy to FastAPI |
| FastAPI API | `apps/api/main.py` → `python/nexus` | **Hetzner VPS** (Docker Compose) | product API, SSE streaming |
| Worker | `apps/worker/main.py` → `python/nexus/jobs` + `tasks` | **same Hetzner VPS** | background jobs from `background_jobs` |
| PostgreSQL (pgvector) | — | **same Hetzner VPS** | the single source of truth |

Managed/external: **Cloudflare R2** (object storage; MinIO locally), **Supabase**
(hosted Auth only — JWT issuance/JWKS/OAuth; *no* Supabase Database or Storage),
and the LLM/search/podcast/billing providers above. **Caddy** terminates TLS in
front of the API; the frontend is served by Vercel.

Key topology facts (details: [`deployment.md`](../deployment.md),
`deploy/hetzner/`, `deploy/vercel/`):

- Default request path is **Browser → Next.js BFF → FastAPI → Postgres**.
  SSE is the documented exception (**Browser → FastAPI `/stream/*`**).
- Production is a **hard cutover**: there is no Supabase DB/Storage fallback. The
  env-sync scripts (`deploy/*/sync-env.sh`) actively reject legacy Supabase
  service-role keys, `STORAGE_*`, and a Supabase-pointed `DATABASE_URL`.
- The **worker container relaxes DB timeouts to `0`** (env-only) so long
  ingest/transcription/LLM jobs aren't killed; the API keeps tight role-scoped
  timeouts.
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

These are the load-bearing rules that explain *why* the code looks the way it
does. Full normative text lives in [`rules/`](rules/index.md); this is the
orientation summary.

**Layering & ownership** ([`rules/layers.md`](rules/layers.md),
[`rules/codebase.md`](rules/codebase.md), [`rules/cleanliness.md`](rules/cleanliness.md)).
Top to bottom: Next middleware (network-free session classification + CSP) →
Data Access Layer (`apps/web/src/lib/auth/dal.ts`, the *only* verified-session
authorization boundary) → Next `/api/*` routes (dumb proxy, no business logic) →
FastAPI middleware (JWT verify, request-id, viewer injection) → FastAPI route
handlers (validate input, call one service, shape the response) → **services**
(`python/nexus/services/`, all business logic, no HTTP/framework types,
dependencies passed as explicit parameters never globals) → models
(`db/models.py`). One capability has one primary form; no barrels/re-exports;
side effects only in entrypoints.

**Error vs defect** ([`rules/errors.md`](rules/errors.md),
[`rules/correctness.md`](rules/correctness.md)). *Errors* are expected, modelled
failures with typed codes. *Defects* are broken invariants ("should never
happen") — they are **never** turned into UI states, retryable branches, or
persisted status fields; observing one in production triggers a code change. No
`T | null`/`Optional` in service APIs to represent classifiable absence — classify
immediately as a typed error or a defect. Parse at the boundary, trust inward.
Branch exhaustively on finite value sets (`assert_never`); no bare
`except Exception` swallowing.

**Transport is a dumb pipe** ([`rules/transport.md`](rules/transport.md)).
Application work that must survive a disconnect is decoupled from the transport —
which is exactly why a chat answer is a durable `ChatRun` executed by the worker
and merely *tailed* over SSE, not driven by the HTTP connection.

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
   per-request CSP nonce and classifies the Supabase session cookie *without any
   network I/O* into `active | refreshable | ended | anonymous`. `/api/*` is
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

**Identity / auth / sessions** — `users` (PK = Supabase `sub`), `user_api_keys`
(encrypted BYOK), `billing_accounts`, `billing_entitlement_overrides` (+events),
`stripe_webhook_events`, `extension_sessions`, `auth_handoff_codes`,
`reader_profiles`, `workspace_sessions`, `command_palette_usages`.

**Media / ingestion** — `media` (the central readable entity), `media_file`
(private original-file object metadata), `project_gutenberg_catalog`,
`user_media_deletions`.

**Reader content / fragments** — `fragments` (current render units carrying
`canonical_text` + `html_sanitized`), `fragment_blocks`, EPUB structure
(`epub_toc_nodes`, `epub_nav_locations`, `epub_fragment_sources`,
`epub_resources` for private extracted asset object metadata),
`pdf_page_text_spans`, `reader_media_state`.

**Retrieval index** — `content_blocks`, `evidence_spans`, `content_chunks`,
`content_chunk_parts`, `content_embeddings` (PGVector 256),
`content_index_states(owner_kind, owner_id)`, `media_transcript_states`.
The index is owner-polymorphic: media-owned content and page-owned notes share
the same chunk/span/embedding pipeline; notes no longer have a parallel
`object_search` substrate.

**Highlights** — `highlights` (base row + the exact/prefix/suffix triple),
`highlight_fragment_anchors` (codepoint ranges), `highlight_pdf_anchors` +
`highlight_pdf_quads` (page-space geometry).

**Libraries / sharing** — `libraries`, `memberships`, `library_entries`,
`library_invitations`, `default_library_intrinsics`,
`default_library_closure_edges`, `default_library_backfill_jobs`, and the
current **library-intelligence** subgraph (`library_intelligence_artifacts`,
`library_intelligence_sections`, `library_intelligence_nodes`,
`library_intelligence_claims`, `library_intelligence_evidence`).

**Contributors** — `contributors` (canonical identity, self-FK for merges),
`contributor_aliases`, `contributor_external_ids`, `contributor_credits`,
`contributor_identity_events` (audit trail).

**Notes** — `pages`, `daily_note_pages`, `note_blocks` (block kind +
ProseMirror JSON + markdown + text only), `note_view_states`, and
`user_pinned_objects`. Page/block containment, order, inline note→object refs,
highlight-note attachments, and backlinks are `resource_edges`, below — notes
own no link table.

**Resource graph** — `resource_edges` (the single directed connection table:
stance `kind`, writer `origin`, polymorphic `scheme`+`id` endpoints with no
endpoint FKs, optional ordered-adjacency keys, and one optional citation pair
`ordinal`+`snapshot`), `tags` (user-owned tag resources),
`resource_external_snapshots` (stable targets for public web-search citations),
and `oracle_reading_folios` (oracle-owned generated folio content referencing its
citation edge). This subgraph replaced four superseded link/reference/citation
stores — `object_links`, `conversation_references`, `oracle_reading_passages`,
`library_intelligence_citations` — see §7.6.

**Conversations / chat** — `conversations`, `messages` (the message tree with
branch pointers), `conversation_branches`, `conversation_active_paths`
(per-viewer), `conversation_shares`, `conversation_media`, `message_llm`,
`models` (LLM registry); plus the **chat-run** machinery: `chat_runs`,
`chat_run_events` (append-only SSE log), `chat_prompt_assemblies`; and the
**retrieval/citation** ledgers: `message_tool_calls`, `message_retrievals`
(telemetry; carries `cited_edge_id` pointing back at the citation edge),
`message_retrieval_candidate_ledgers`, `message_rerank_ledgers`. (Conversation
context refs are now `resource_edges` with `source_scheme='conversation'`, not a
`conversation_references` table.) Assistant message API responses include a
`trust_trail` read model assembled from these durable rows; persisted
`message_document` blocks are text-only.

**Podcasts / playback** — `podcasts`, `podcast_subscriptions`,
`podcast_subscription_libraries`, `podcast_episodes` (PK = `media_id`),
`podcast_episode_chapters`, `podcast_listening_states`, `playback_queue_items`,
`podcast_transcription_jobs`, `podcast_transcription_usage_daily`,
`podcast_transcript_segments`.

**Jobs** — `background_jobs` (raw-SQL-only durable queue), plus rate-limiter
tables (`rate_limit_request_log`, `rate_limit_inflight`, `token_budget_*`) and
stream-token replay claims.

**Oracle** — `oracle_corpus_works`, `oracle_corpus_passages` (PGVector 256; their
uuid `id` doubles as the stable `oracle_corpus_passage:<id>` citation target),
`oracle_corpus_images` (PGVector 256 + public owned plate object metadata),
`oracle_readings`, `oracle_reading_folios` (the per-phase generated folio,
referencing its citation `resource_edge`), `oracle_reading_events`.

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
  The API is tight (30s/10s/60s); the worker sets them to `0`.

### 7.2 LISTEN/NOTIFY → SSE streaming

Push-based streaming without polling. Postgres `AFTER` triggers
(`migrations/.../0122_notify_triggers.py`) call `pg_notify` on insert/update of
append-only event tables; a shared listener (`db/listen.py`) holds a raw
autocommit `psycopg.AsyncConnection` per stream (capped at 64, exempt from pool
timeouts) and wakes the SSE tail. The committed row — not the notification — is
the source of truth; a missed/coalesced NOTIFY only delays an update by the idle
keepalive, never drops it.

| Channel | Producer | Consumer |
|---|---|---|
| `chat_run_events` | insert on `chat_run_events` | chat SSE tail |
| `oracle_reading_events` | insert on `oracle_reading_events` | oracle SSE tail |
| `media_events` | update on `media` | media-status SSE |
| `nexus_background_jobs` | enqueue in `jobs/queue.py` | worker wake-up |

### 7.3 Background jobs & the worker

A durable Postgres-backed queue (`python/nexus/jobs/`). Jobs are enqueued by
inserting a `background_jobs` row + `pg_notify` **in the caller's transaction**
(atomic with domain writes). The single-process worker (`apps/worker/main.py`)
runs two loops:

- **Job loop**: `claim_next_job` atomically picks one due row with
  `FOR UPDATE SKIP LOCKED` (new work *or* a crashed job whose lease expired),
  flips it to `running` with a lease, dispatches to the registered handler under a
  heartbeat thread, then commits a terminal/retry transition. Retries are bounded
  per-kind (`max_attempts`, `retry_delays_seconds`, `lease_seconds`); exhaustion
  dead-letters the row. Two kinds register a dead-letter finalizer: `chat_run`
  writes an errored assistant message, and `page_reindex_job` marks the page's
  content index `failed`.
- **Scheduler loop**: enqueues periodic jobs into fixed time slots with
  deterministic dedupe keys, so exactly one job per slot survives across workers.

The **registry** (`jobs/registry.py`) is the source of truth mapping job kind →
handler + policy. Claim is atomic, so the worker scales horizontally even though a
single instance is single-concurrency. `get_task_contract_version()` fingerprints
the registry's per-kind attempt/lease policy for `/health` deploy checks. The
`WORKER_ALLOWED_JOB_KINDS` allowlist gates which kinds the production worker
claims; `USER_FACING_JOB_KINDS ⊆ DEFAULT_WORKER_ALLOWED_JOB_KINDS` is asserted in
`test_config.py` so a user-facing kind can never be stranded unallowlisted (the
`page_reindex_job` incident class). See [modules/jobs.md](modules/jobs.md).

Task catalog (each is a thin handler in `tasks/` that wraps a service):
`ingest_media_source`, `enrich_metadata`, `chat_run`,
`oracle_reading_generate`, `library_intelligence_artifact_generate`,
`media_unit_build`, `page_reindex_job`, `podcast_sync_subscription_job`,
`podcast_reindex_semantic_job`, `podcast_active_subscription_poll_job`
(periodic), `reconcile_stale_ingest_media_job` (periodic),
`sync_gutenberg_catalog_job` (periodic), `prune_background_jobs_job`
(periodic), `purge_expired_auth_handoff_codes` (periodic),
`backfill_default_library_closure_job`.

> Gotcha: only `enrich_metadata` and `media_unit_build` declare
> `failed_result_statuses`. Other ingest tasks that *return* `{"status":"failed"}`
> still mark the **queue** row succeeded — the failure is recorded on the domain
> row, and recovery relies on the stale reconciler + manual API retry, not
> queue-level retries.

**Generation-run harness.** The five LLM generation kinds (`chat_run`,
`oracle_reading_generate`, `library_intelligence_artifact_generate`,
`media_unit_build`, `enrich_metadata`) run their bodies inside one shared worker
envelope, `tasks/llm_task.py:run_llm_task` — the sole owner of the event loop,
`httpx` client, and `ModelRuntime` construction (including the fixture swap and
the worker-exception boundary). Ledgered generation calls inside those jobs leave
one `llm_calls` row via `llm_ledger.observed_generate` /
`observed_generate_stream`, on success and on failure, and
`run_kit.mark_terminal` stamps `error_code`/`error_detail` on the run parent —
so a failed run is diagnosable. Saved-key probes and transcript embeddings are
explicit exceptions described in [modules/llms.md](modules/llms.md). The worker
installs the process-global rate limiter at startup so the first job of any kind
has a working limiter. SERIALIZABLE retries everywhere (including the scheduler
loop) go through the one helper `db/retries.py:retry_serializable`. See
[modules/llms.md](modules/llms.md).

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

### 7.5 BYOK keys, billing & entitlements

- **BYOK** (`services/user_keys.py`, `crypto.py`, `api_key_resolver.py`): user
  provider keys (openai/anthropic/gemini/openrouter; Cloudflare is platform-only
  in the current credential contract) are encrypted with XChaCha20-Poly1305
  (PyNaCl `SecretBox`) under `NEXUS_KEY_ENCRYPTION_KEY`; only a 4-char fingerprint
  is exposed. Status lifecycle `untested → valid → invalid → revoked` (revoke
  wipes ciphertext, keeps fingerprint for audit). `key_mode ∈ {auto, byok_only,
  platform_only}` chooses BYOK-first vs platform; platform use is gated by
  entitlements.
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
three surfaces: the in-app search page, the chat `app_search` agent tool (RAG), and
object-ref resolution for notes. The request is a single typed `SearchQuery` value
object parsed at the edge; the user-facing taxonomy is **six kinds** (Documents,
Notes, Highlights, Conversations, People, Web) folding the internal result types,
with operator-backed filter chips (`format:`/`author:`/`role:`/`in:`) — not the raw
result-type grid. The package owns one concern per module (`kinds`, `query`, `scope`,
`embedding`, `ranking`, `projection`, `cursor`, `batch`, `retrievers/*`, `service`).

- **Indexing** (`services/content_indexing.py`, `semantic_chunks.py`): text-bearing
  media flows `fragment → content_blocks → chunks → embeddings`; page-owned
  notes flow `note_block → content_blocks → chunks → embeddings` through
  `services/note_indexing.py`. The current index state is tracked in
  `content_index_states(owner_kind, owner_id)` with the active embedding
  provider/model; rebuilds replace current blocks, chunks, spans, and embeddings
  for the owner.
- **Retrieval** is hybrid — and hybrid is an *invariant*, not a per-request toggle:
  a vector ANN arm (cosine over pgvector, joined on the *active* embedding config)
  **UNION** a lexical FTS arm, reranked by a weighted score (lexical hit + semantic
  similarity + recency), filtered by a similarity floor, then resolved through the
  locator resolver. There is no `semantic` flag; the query embedding is built once
  for any semantic-capable kind regardless of structured filters. For chat, candidates are
  selected under a context-char budget and every candidate/rerank/selection
  decision is written to ledger tables; selected rows become `message_retrievals`
  telemetry rows via the single validated writer
  `retrieval_citation.insert_retrieval_row` (the cited ones link back to their
  citation edge through `cited_edge_id`, §7.7).
- **The `ResourceRef` grammar** (`services/resource_graph/refs.py`): a
  `<scheme>:<uuid>` ref over a closed scheme set (`media`, `library`,
  `evidence_span`, `content_chunk`, `highlight`, `page`, `note_block`, `fragment`,
  `conversation`, `message`, `oracle_reading`, `oracle_corpus_passage`,
  `library_intelligence_artifact`, `external_snapshot`, `contributor`, `podcast`)
  is the one persisted resource-identity vocabulary. The same ref identifies a
  resource everywhere: an edge endpoint, a citation target, an attached
  conversation context ref, and a read/inspect agent-tool argument. Parsing is
  strict (canonical lowercase uuid) and returns a typed failure, never `None`.
  Hydration + permission checks live in `services/resource_graph/resolve.py` —
  `load_resource_batch` is the one place each scheme's read SQL + visibility gate
  exists.

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
(attached references first, then each tool's selected results). A citation **is an
edge**: `[N]` is the `ordinal` on an `origin='citation'` `resource_edge` whose
source is the assistant message and whose target is the cited resource. The
backend builds the `CitationOut` read-model from those edges via
`resource_graph.citations.build_citation_outs` (uniformly for chat, Oracle, and
Library Intelligence), reconstructing the in-reader jump from the target's own
anchoring. `message_retrievals` stays chat-owned **telemetry**, pointing back at
the edge through `cited_edge_id`; the frontend maps `[N]` → a `CitationOut` → a
clickable reader target.

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
- `youtube_video_ingest.py`: YouTube metadata/transcript materialization for
  queued source attempts. Metadata uses the YouTube Data API; transcript/caption
  acquisition is a separate egress boundary that may require
  `YOUTUBE_TRANSCRIPT_PROXY_URL` from datacenter hosts. It is called by
  `media_source_ingest.py`, not registered as a separate source-acquisition job
  lane.
- `remote_file_client.py`: PDF/EPUB URL outbound policy, SSRF-safe streaming to
  storage, byte-size accounting, and signature validation for queued source
  attempts.
- `epub_assets.py`: private EPUB resource asset authorization and byte-size
  checked reads.
- `listening_state.py`: podcast listening-state CRUD and batch updates.
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

**Highlights** (`services/highlights.py`): a selection becomes a stored highlight
with a precomputed `exact`/`prefix`/`suffix` triple (a 64-codepoint context
window) that doubles as the canonical quote shown to chat. PDF highlights may have
empty `exact` (no text-layer match) — a first-class state the sidecar renders as a
placeholder. The reader's highlights sidecar renders `exact` only (the recent
exact-only cutover, [`modules/reader-highlight-sidecar-exact-only`](cutovers/reader-highlight-sidecar-exact-only.md)).

**Source-authored apparatus** (`services/reader_apparatus.py`): web article,
EPUB, and PDF ingest paths persist document-authored notes, endnotes,
bibliography entries, in-document markers, and marker-to-target edges into
`reader_apparatus_*` tables. This model is separate from generated chat
citations, `message_retrievals`, and conversation references. Web/EPUB
apparatus is extracted before sanitization removes semantic attributes. PDF
apparatus is capability-gated: native `cite.*` links can be `ready` when
deterministic reference targets are materialized, marker-only native-link rows
remain `partial`, synthetic legal-footnote support is narrow, and unsupported
scholarly/literary PDFs deliberately emit empty apparatus rather than inferring
from raw layout text. Fixture counts and 20-source support status live in
`python/tests/fixtures/reader_apparatus/corpus_manifest.json`.

**Frontend** (`components/reader/*`, `PdfReader.tsx`, `HtmlRenderer.tsx`,
`lib/reader/*`, `lib/highlights/*`): `HtmlRenderer` is the only
`dangerouslySetInnerHTML` site (annotating already-sanitized HTML). Highlights are
rendered two independent ways — inline `<span>` segments + a visible-only sidecar
projected from rendered geometry, and an **overview ruler** positioned purely from
stored anchors + metadata (never DOM geometry).

### 8.3 Chat & conversations

The AI chat: durable, branchable, streamed, RAG-grounded. Backend:
`services/chat_runs.py` + the `chat_run_*` modules + `context_assembler.py`.

- **Conversation = message tree.** Each "send" creates a user message plus a
  *pending assistant* message; replying under an existing assistant forks a
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
- **Cancellation/crash**: cancel sets a flag the worker polls; a `delta` without a
  `done` (crashed mid-stream) is detected and finalized as interrupted/retryable.
- **Models** (`llm_catalog.py`, `services/models.py`): a curated catalog gates
  which provider/model/reasoning combos are usable; availability is the
  intersection of enabled providers and usable keys (BYOK or platform).

Frontend: `components/chat/*` (`useChatRunTail` is the SSE engine,
`useChatMessageUpdates` folds events with RAF-batched deltas, `ForkTreeView`/
`ForkStrip` drive branching). Citations render `[N]` → `ReaderCitation` chips that
push a reader target (`lib/conversations/*`).

### 8.4 Oracle

An agentic "reading" feature over one current curated **public-domain literary
corpus**. `services/oracle.py` owns reading generation: question validation,
current corpus/library retrieval, plate selection, LLM prompt/call, parse,
persistence, and SSE event emission. A short question → retrieve corpus passages
(+ the user's library) and pick a plate image → one LLM call produces a
structured three-phase interpretation → stream + persist as
`oracle_reading_events` + citation "folios". It has its **own**
retrieval/prompt/persistence and does **not** use the four chat agent tools, but
it **reuses the SSE transport**.

Oracle plate bytes and URLs are separate owned assets. `services/oracle_plates.py`
owns `oracle_plate_url`, DB metadata lookup, stable DB-owned plate storage-key
validation, image-id ETag metadata, and byte-size-checked storage reads. The
public image route is `/api/oracle/plates/[id]` in Next.js →
`/oracle/plates/{id}` in FastAPI. It is cookie-free, internal-header-protected,
and safe for Next Image optimization. The LLM emits only integer candidate
indices + prose; all citation text comes from the retrieved candidates (output
that leaks source text fails the parse). Frontend lives in the separate
`app/(oracle)/` route group (outside the pane system).

### 8.5 Libraries, sharing & the default-library closure

Content organization + access control, split into three owned modules:
`services/library_governance.py` (the `libraries`/`memberships` tables: CRUD,
roles, ownership transfer, membership guards, ingest access checks),
`services/library_entries.py` (the **sole writer** of `library_entries` — the
`EntryTarget` media|podcast union, the locked append, position ordering, and all
item-in-library commands), and `services/library_invitations.py` (the
`library_invitations` table). Visibility itself is enforced by the boolean
predicates in `auth/permissions.py`; the search/object readers read
`library_entries` under an explicit Tier-R allowlist.

- Every user has one **default library** (special: can't be renamed/deleted/shared
  or receive podcasts) plus shareable libraries with `memberships`
  (`admin`/`member` roles; owner is a distinct concept layered on admin).
  `library_entries` point at exactly one media or podcast and carry an integer
  `position` (a per-library `UNIQUE (library_id, position) DEFERRABLE` DB
  invariant since migration `0131`, with cleanup explicit in app code).
- **Sharing**: invites (`library_invitations`) and ownership transfer, both
  admin/owner-gated, with masked-404 for non-members.
- **Writable destinations**: destination pickers use
  `GET /libraries/writable-destinations`; default libraries, member-only
  libraries, duplicate IDs, and inaccessible IDs are not valid write
  destinations.
- **The default-library closure** (`services/default_library_closure.py`) makes a
  user's default library reflect everything visible across their shared libraries
  without duplication. Two provenance tables: `default_library_intrinsics` (direct
  intent) and `default_library_closure_edges` (visible-because-of-membership). A
  media row survives in the default library if it has *either*. On invite-accept, a
  durable `default_library_backfill_jobs` row catches up historical content (the
  worker honors live revocation by locking the membership row).
- **Library Intelligence** (`services/library_intelligence.py`) is one current,
  source-grounded synthesis artifact per library/kind (claims/evidence/sections
  graph). The build is currently a **deterministic compiler**, not yet
  LLM-backed; source or membership drift marks the current artifact `stale` and
  queues a replacement build when no build is already inflight.

### 8.6 Contributors

A canonical authorship graph split across single owners: `contributor_taxonomy.py`
(leaf — role/status/authority vocabularies + name normalizers), `contributors.py`
(identity: resolve/create, merge, split, tombstone, aliases, external IDs, handle gen,
the Authors directory), and `contributor_credits.py` (the credit junction only).
`contributors` (person/org/group) carry searchable `contributor_aliases`, authority
`contributor_external_ids` (orcid/isni/viaf/…, globally unique per authority), and
`contributor_credits` attaching a contributor to exactly one media/podcast/Gutenberg-ebook.
Credit resolution prefers explicit id → **strong** external-id (only true authority files
— orcid/isni/viaf/wikidata/openalex/lcnaf — assert identity; provider IDs and `source_ref`
are provenance, never identity) → confirmed alias → new unverified contributor. `split`,
`tombstone`, and `merge` are all implemented with an audit trail
(`contributor_identity_events`) and run under `run_identity_write` (SERIALIZABLE + bounded
retry). `merge` redirects a duplicate into a survivor — repointing credits/aliases/external-ids,
writing a confirmed `source="merge"` alias so name-only reingest resolves to the survivor, and
repointing every `contributor:<id>` graph endpoint onto the survivor via
`resource_graph.edges.repoint_edges` (which drops rows that would collapse into a self-edge or
duplicate an existing pair). Visibility predicates (`visible_podcast_ids_cte_sql`,
`visible_content_credit_rows_sql`, `visible_contributor_ids_cte_sql`) live solely in
`auth/permissions.py`; persisted-chat-ref checks live in `chat_context_refs.py`.
Surfaced in the UI as the `/authors` faceted **directory** (peer of Libraries — work counts,
role/kind/content-kind/status facets, works|name sort, cursor paging) and author chips linking
to `/authors/{handle}`; the detail pane offers curator-gated alias/external-id/split/tombstone
edits and merge.

### 8.7 Notes

A block-based outliner (`services/notes.py`). `pages` (ordinary + daily) own
document identity; `note_blocks` own only block content and kind. Page/block
containment and sibling order live in `resource_edges` with
`origin='note_containment'`; `source_order_key` is a dense recomputed `%010d`
rank per parent. Collapsed state lives in `note_view_states`. Full outliner ops
(create/update/split/merge/move, batched document patches, quick-capture into
daily notes) project through `resource_graph.documents`. Inline
`object_ref`/`object_embed` nodes sync into `resource_edges` with
`origin='note_body'` (`replace_edges_for_origin` keeps the block's edge set in
step with its body); a note attached to a highlight is itself a `note_block`
linked by an `origin='highlight_note'` edge. Every page/block is reindexed into
the polymorphic content index via `note_indexing.enqueue_page_reindex`.
Frontend: `components/notes/ProseMirrorOutlineEditor.tsx` +
`lib/notes/prosemirror/*`.

### 8.8 Podcasts & playback

`services/podcasts/*`: discover via Podcast Index, subscribe (optionally scoped to
libraries + auto-queue), sync episodes into `media` rows of kind
`podcast_episode`, and transcribe. Transcripts come from **RSS sidecar files**
(eager, during sync) or **Deepgram** (on-demand per viewer, gated by
`can_transcribe` + a daily quota; diarized with non-diarized fallback). New
episodes stay `pending` until a viewer requests transcription. The **playback
queue** (`playback_queue_items`, dense positions, unique per media) and
**listening state** (`podcast_listening_states`, resume position, ≥95%
auto-completion, `services/listening_state.py`) are per-user. Frontend: a single
app-wide `<audio>` element in
`lib/player/globalPlayer.tsx` with a Web Audio effects graph, OS media-session
integration, and 15s listening-state persistence.

### 8.9 Search surfaces & command palette

The same `search()` backs the `/search` results page (`SearchPaneBody`), inline
palette results, and the chat `app_search` tool — the page and the palette `@` lane
share one frontend query model (`lib/search`: `parseSearchInput` → `SearchQuery` →
`fetchSearchResultPage`), so an identical input yields identical results and "See
all" round-trips through the URL. The **command palette**
(`components/CommandPalette.tsx`) aggregates open tabs, frecency-ranked recents
(`command_palette` service), static nav/create commands, and live search results,
ranked by `commandRanking.ts` and executed via `requestOpenInAppPane`. The
**browse** surface (`services/browse.py`) is a global acquisition search across
documents (incl. Gutenberg), videos (YouTube Data API), and podcasts.

---

## 9. Frontend architecture

The web app (`apps/web`, Next.js 15 App Router) has one structural idea you must
internalize first:

**Routing is a client-side pane system, not Next.js `children`.** The
`(authenticated)` layout renders a fixed `AuthenticatedShell` and *ignores*
`children`. Each route's `page.tsx` exists only so Next resolves the URL; the
actual body is a `*PaneBody` component that the **pane route registry**
(`lib/panes/paneRouteModel.ts`, `lib/panes/paneRouteTable.ts`, and
`lib/panes/paneRenderRegistry.tsx`) resolves and renders inside a pane. The URL
is a *projection* of the active pane (mirrored via `history.replaceState`), not
the driver. New devs frequently look in `page.tsx` for behavior that lives in
`*PaneBody.tsx`.

- **Workspace shell** (`lib/workspace/*`, `components/workspace/*`): a tabbed,
  multi-pane canvas. State (`WorkspaceState`: primary panes with per-pane history,
  attached secondary tool panes, widths) lives in a React reducer+context store and
  is persisted **per-user-per-device** to `workspace_sessions`. A pane is identified
  by a `resourceKey` (`media:<id>` etc.) — the de-dup, title-cache, and remount key.
  Routes resolve via a pure model (`paneRouteModel.ts`) plus metadata table
  (`paneRouteTable.ts`) bound to React bodies (`paneRenderRegistry.tsx`). Bodies talk
  to the shell only through `paneRuntime.tsx` hooks (`usePaneRouter`, `usePaneParam`,
  `useSetPaneTitle`, `usePaneSecondary`). Secondary panes (reader tools, conversation
  context, library tools) are runtime-published sidebars.
- **First paint: stream, don't gate.** The `(authenticated)` layout runs only
  **local** work (`verifySession`, header-derived `loadRenderEnvironment`) above a
  `<Suspense fallback={<AuthenticatedShellSkeleton/>}>`; `WorkspaceBootstrapGate`
  awaits the data root inside the boundary and streams the shell in. The first HTTP
  flush is the chrome skeleton (nav-rail placeholder + pane region in `PaneLoadingState`)
  — **data never gates TTFB**. The data root (`loadWorkspaceBootstrap`) is parallel and
  restore-aware: two concurrent `Promise.all` waves — (1) reader profile + saved session
  + the URL pane's speculative resource seed, then (2) the remaining restored visible
  panes — returning `{ initialHref, readerProfile, initialState, resources }` (a
  hydration cache keyed exactly as each pane's `useResource` reads it). Every fetch is
  best-effort under a deadline; a timed-out seed degrades to the normal client fetch.
- **Server-side restore (no round-trip, no flash).** Device identity is a server-owned
  httpOnly `nx_device` cookie minted in middleware (`lib/auth/deviceCookie.ts`) —
  request-forwarded so this SSR sees it, response-set for future requests. The data root
  reads it, fetches the saved workspace-session, and `selectRestoredState` /
  `mergeRestoredWorkspaceWithDeepLink` merge it with the deep-link intent; the store
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
  `schema.ts`/`paneWidth.ts` are likewise isomorphic, not `"use client"`).
- **Measurement loop.** `nexus:web-vitals` → `WebVitalsReporter` subscriber →
  `sendBeacon` → BFF `/api/telemetry/web-vitals` → FastAPI `/telemetry/web-vitals` →
  structlog `rum.web_vital` (request-id-correlated). A CI **First Load JS budget**
  (`make check-bundle`, ≤ 115 kB gz vs ~104 kB measured) runs in `build-front`. Kept
  constraints: nonce-CSP + **streaming only** — no PPR, no `next/dynamic`, no
  server-emitted `modulepreload` (chunk URLs are unknown server-side); `React.lazy` +
  runtime `preloadPane` (warming all restored visible panes) stays the splitting mechanism.
- **BFF / proxy / auth / SSE** (`lib/api/*`, `lib/auth/*`, `lib/supabase/*`): covered
  in §5. The browser holds **no** Supabase client and no tokens; `lib/auth/dal.ts`
  `verifySession()` is the one verified-session boundary for protected pages/
  actions; the SSE client mints fresh single-use tokens per connect.
- **Surfaces** (`components/*`, `app/(authenticated)/**/*PaneBody.tsx`): reader,
  chat, player, notes editor, command palette, search, contributors, libraries/
  items, billing/settings — all rendered as pane bodies. UI primitives live in
  `components/ui/*`; cross-cutting hooks in `lib/ui/*`; theming via a `nx-theme`
  cookie; keybindings in `lib/keybindings.ts`; Android-shell adaptation in
  `lib/androidShell.ts`.

---

## 10. Non-web clients

**Android shell** (`apps/android`): a single-Activity Kotlin app wrapping the web
app in a hardened `WebView` (no JS bridge, no file/content access, third-party
cookies blocked, off-origin links open in Custom Tabs). It is **sandboxed** by
rule ([`rules/layers.md`](rules/layers.md)): the only native HTTP call it makes is
`POST /auth/native/google`; PKCE/code exchange stays server-side. Native Google
sign-in (Credential Manager) and Custom-Tab OAuth both converge on a server-minted,
single-use, PKCE-bound `nexus://auth/handoff` code that injects a first-party
session cookie into the WebView. App Links are backed by
`apps/web/public/.well-known/assetlinks.json` (validated against the release
signing cert at build time). The web app detects the shell via a `NexusAndroidShell`
UA token and hides incompatible surfaces (e.g. local vault).

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

The `Makefile` is the single entrypoint; `make help` is canonical. Targets group as:

- **Setup / dev loop**: `make setup`, `make dev` (Docker Compose Postgres + MinIO +
  Supabase-local Auth), then `make api`, `make web`, `make worker` in separate
  terminals. Ports are written to `.dev-ports`.
- **Quality gates**: `make check` (ruff + pyright + eslint/tsc + workflow lint),
  `make audit`, `make format`.
- **Tests**: see §12.
- **Build**: `make build` (Next.js), `make build-android[-release]`.
- **Composite**: `make verify` (check + build + test), `make verify-full` (+
  real-media + live-providers + e2e), `make smoke`.

**Deploy** (`deployment.md`, `deploy/`): the frontend deploys to **Vercel on push
to `main`** (Git integration). The backend deploys via `deploy/hetzner/deploy.sh`:
sync env → rsync repo to the VPS → `compose build` → stop worker+api → **run
`python /app/scripts/ensure_oracle_seed_objects.py`** → **run
`alembic upgrade head`** via one-off `compose run` commands → `compose up -d
--force-recreate`. Env contracts live in `deploy/env/*` (real values untracked,
`.example` tracked); the sync scripts strongly validate them and reject legacy
Supabase/`STORAGE_*` keys. R2 CORS/lifecycle are applied as code via
`deploy/cloudflare/*`. Supabase hosted Auth redirect config is verified as
provider state with `deploy/supabase/verify-auth-redirects.sh`, not trusted as a
manual dashboard checklist.

**Migrations** are hand-written Alembic files (`migrations/alembic/versions/`,
linear `NNNN_*` numbering, no autogenerate). Dev: `make migrate`. Test: a dedicated
`nexus_test_migrations` DB. Prod: run on every deploy before services start.

**Environment**: `.env.example` is the source of truth for every variable
([`rules/environment.md`](rules/environment.md)); `make setup` generates local
`.env` + `apps/web/.env.local`. Major groups: app/env, database + pool, Supabase
Auth (issuer/JWKS/audiences), internal secret, encryption key, LLM providers +
flags + rate limits, Brave web search, streaming (token signing key + base URL +
CORS), podcasts, browse providers, worker job allowlist + schedules, Stripe.
E2E local Supabase public/admin resolution is owned by `e2e/supabase-env.cjs`:
`SUPABASE_AUTH_ADMIN_KEY` is trusted bootstrap-only for Playwright user/session
seeding, and Next.js/FastAPI/worker/migration runtimes scrub Supabase admin,
database, and service-role env before startup.

**CI** (`.github/workflows/ci.yml`): static checks, audit, backend unit, backend
DB integration + migrations, frontend unit + browser, build, Android, sharded E2E,
real-media, and (secrets-gated) live-providers.

---

## 12. Testing strategy

The doctrine is in [`rules/testing_standards.md`](rules/testing_standards.md):
**test behavior not implementation**, a testing trophy weighted to **E2E** (real
stack, real DB/MinIO/Supabase-local), with backend integration as a separate tier.
**Mock only external boundaries** — never `nexus.services.*`, DB sessions, the BFF
proxy, internal components, or `next/navigation`; no MSW. ORM-backed factories, not
raw SQL. Every backend test is marked (`unit`/`integration`/`slow`/`supabase`).

Tiers:

| Tier | Scope | Real vs mocked | Command |
|---|---|---|---|
| Static | ruff/pyright/eslint/tsc/actionlint | — | `make check` |
| Backend unit | pure logic | no I/O, no mocks | `make test-back-unit` |
| Frontend unit | pure TS | Node env | `make test-front-unit` |
| Component | React in real Chromium | only `next/image` shim | `make test-front-browser` |
| Backend integration | FastAPI + real Postgres | external boundaries mockable | `make test-back-integration` |
| Migrations | Alembic up/down | dedicated DB | `make test-migrations` |
| E2E (default) | user journeys, prod-built web, no-reload API | full real stack, fixture providers | `make test-e2e` |
| Real-media | ingest/search/chat acceptance | real code, deterministic fixture LLM + `fixture_hash` embeddings | `make test-real-media` |
| Live-providers | real OpenAI/Anthropic/Gemini/OpenRouter/Cloudflare, OpenAI embeddings/transcription, Podcast Index/Deepgram/YouTube/X | live external | `make test-live-providers` |

The **real-media vs live-providers** split is the determinism boundary:
real-media runs real product code but swaps the *external provider edge* for
deterministic fixtures (`services/real_media_fixture_llm.py`); an AST scan
(`tests/real_media/test_no_internal_mocks.py`) mechanically forbids internal mocks
in that tier. Backend harness: `python/tests/conftest.py` (two DB-isolation models),
`factories.py`, `support/`. E2E harness: `e2e/playwright.config.ts` (`workers: 1`,
sharded in CI, `storageState` login reuse, app-API seeding).

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
   readiness is a *separate* state machine. Source-attempt retry and metadata
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
   retrieval ledgers, citation edges, and reference-added events. Message
   documents remain text-only.
11. **`background_jobs` is raw SQL**, invisible in `models.py`. Most ingest tasks'
   `{"status":"failed"}` returns mark the *queue* row succeeded; recovery is the
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

| You want… | Start at |
|---|---|
| Repository rules / boundaries | [`rules/index.md`](rules/index.md) |
| Reader behavior contract | [`modules/reader-implementation.md`](modules/reader-implementation.md), [`modules/reader-design-rationale.md`](modules/reader-design-rationale.md) |
| FastAPI bootstrap / middleware / lifecycle | `python/nexus/app.py`, `python/nexus/middleware/`, `python/nexus/auth/` |
| DB layer / sessions / LISTEN-NOTIFY | `python/nexus/db/` (`engine.py`, `session.py`, `listen.py`) |
| The schema | `python/nexus/db/models.py` (+ `migrations/alembic/versions/`) |
| Background jobs / worker | `python/nexus/jobs/`, `python/nexus/tasks/`, `apps/worker/` |
| Media catalog and ingest owners | `python/nexus/services/media.py`, `media_ingest.py`, `media_source_ingest.py`, `x_ingest.py`, `youtube_video_ingest.py`, `remote_file_ingest.py`, `remote_file_client.py`, `media_processing_state.py` |
| Reader/highlights backend | `python/nexus/services/{reader,epub_*,pdf_*,fragment_blocks,highlights}.py` |
| Chat / conversations | `python/nexus/services/chat_runs.py` + `chat_run_*`, `context_assembler.py`, `conversations.py` |
| Oracle | `python/nexus/services/oracle.py`, `python/nexus/services/oracle_plates.py` |
| Search / retrieval / indexing | `python/nexus/services/{search,content_indexing,semantic_chunks,retrieval_citation}.py` |
| Resource graph (edges, refs, citations, connections) | `python/nexus/services/resource_graph/` (`refs`, `resolve`, `edges`, `connections`, `context`, `citations`, `cleanup`) |
| Agent tools | `python/nexus/services/agent_tools/` |
| Libraries / contributors / notes | `python/nexus/services/{library_governance,library_entries,library_invitations,default_library_closure,contributors,notes}.py` |
| Podcasts / playback | `python/nexus/services/podcasts/`, `playback_queue.py` |
| Auth / billing / keys / rate limit | `python/nexus/services/{user_keys,billing,billing_entitlements,rate_limit}.py`, `python/nexus/auth/` |
| Frontend BFF / auth / SSE | `apps/web/src/lib/{api,auth,supabase}/` |
| Workspace / panes | `apps/web/src/lib/{workspace,panes}/`, `apps/web/src/components/workspace/` |
| Reader / chat / player UI | `apps/web/src/components/{reader,chat}/`, `apps/web/src/lib/{reader,highlights,conversations,player}/` |
| Android shell | `apps/android/app/src/main/` |
| Browser extension | `apps/extension/` |
| Build / run / deploy | `Makefile`, `deployment.md`, `deploy/` |
| Tests | `docs/rules/testing_standards.md`, `python/tests/`, `e2e/`, `apps/web/vitest.config.ts` |

---

*This document is an overview maintained alongside the code. When a slice's
behavior changes materially, update the relevant section here and the canonical
rule/module doc it links to.*
