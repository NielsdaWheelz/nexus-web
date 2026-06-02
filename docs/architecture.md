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
   └─────────┘                   │ /api/* (product data)     │ /stream/* (SSE only)
   ┌─────────┐  bearer token     │ same-origin, cookie auth  │ stream token, direct
   │Extension│──────────┐        ▼                           │
   └─────────┘          │  ┌──────────────────────┐          │
                        └─▶│  Next.js BFF (/api)   │          │
                           │  proxy.ts: attach     │          │
                           │  bearer + internal    │          │
                           │  secret, no logic     │          │
                           └──────────┬────────────┘          │
                                      │ Authorization: Bearer │
                                      │ X-Nexus-Internal       │
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
   External: OpenAI / Anthropic / Gemini / DeepSeek (LLM + embeddings),
             Brave (web search), Podcast Index, Deepgram, YouTube Data API,
             Stripe (billing), Cloudflare R2.
```

**The one rule that explains the shape:** the browser holds no tokens and never
calls FastAPI directly for product data. It calls same-origin Next.js `/api/*`
routes, which proxy to FastAPI with a server-attached bearer. The **only**
exception is Server-Sent Events: the browser streams directly from FastAPI
`/stream/*` using a short-lived, single-use stream token minted through the BFF.
See [`rules/layers.md`](rules/layers.md) and [`rules/transport.md`](rules/transport.md).

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

### 5.2 The SSE exception (streaming)

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
JSONB columns (with `jsonb_typeof` checks), `pgvector` columns fixed at **256
dimensions**, and a recurring **versioned-artifact** pattern (immutable versioned
rows with supersession) for content-index runs, transcript versions, library
intelligence, and the oracle corpus.

The tables group into these domains:

**Identity / auth / sessions** — `users` (PK = Supabase `sub`), `user_api_keys`
(encrypted BYOK), `billing_accounts`, `billing_entitlement_overrides` (+events),
`stripe_webhook_events`, `extension_sessions`, `auth_handoff_codes`,
`reader_profiles`, `workspace_sessions`, `command_palette_usages`.

**Media / ingestion** — `media` (the central readable entity), `media_file`
(object-storage metadata), `source_snapshots` + `content_index_runs` (versioned
extraction/index runs), `project_gutenberg_catalog`, `user_media_deletions`.

**Reader content / fragments** — `fragments` (immutable render units carrying
`canonical_text` + `html_sanitized`), `fragment_blocks`, EPUB structure
(`epub_toc_nodes`, `epub_nav_locations`, `epub_fragment_sources`,
`epub_resources`), `pdf_page_text_spans`, `reader_media_state`.

**Retrieval index** — `content_blocks`, `evidence_spans`, `content_chunks`,
`content_chunk_parts`, `content_embeddings` (PGVector 256),
`media_content_index_states`, `media_transcript_states`; plus
`object_search_documents` + `object_search_embeddings` for notes.

**Highlights** — `highlights` (base row + the exact/prefix/suffix triple),
`highlight_fragment_anchors` (codepoint ranges), `highlight_pdf_anchors` +
`highlight_pdf_quads` (page-space geometry).

**Libraries / sharing** — `libraries`, `memberships`, `library_entries`,
`library_invitations`, `default_library_intrinsics`,
`default_library_closure_edges`, `default_library_backfill_jobs`, and the
versioned **library-intelligence** subgraph (`library_source_set_versions`,
`library_intelligence_artifacts`/`_versions`/`_sections`/`_nodes`/`_claims`/`_evidence`).

**Contributors** — `contributors` (canonical identity, self-FK for merges),
`contributor_aliases`, `contributor_external_ids`, `contributor_credits`,
`contributor_identity_events` (audit trail).

**Notes** — `pages`, `daily_note_pages`, `note_blocks` (ProseMirror JSON +
markdown + text), `object_links` (typed graph edges between any two object refs),
`user_pinned_objects`.

**Conversations / chat** — `conversations`, `messages` (the message tree with
branch pointers), `conversation_branches`, `conversation_active_paths`
(per-viewer), `conversation_shares`, `conversation_references`,
`conversation_media`, `message_llm`, `models` (LLM registry); plus the **chat-run**
machinery: `chat_runs`, `chat_run_events` (append-only SSE log),
`chat_prompt_assemblies`; and the **retrieval/citation** ledgers:
`message_tool_calls`, `message_retrievals`, `message_retrieval_candidate_ledgers`,
`message_rerank_ledgers`.

**Podcasts / playback** — `podcasts`, `podcast_subscriptions`,
`podcast_subscription_libraries`, `podcast_episodes` (PK = `media_id`),
`podcast_episode_chapters`, `podcast_listening_states`, `playback_queue_items`,
`podcast_transcription_jobs`, `podcast_transcription_usage_daily`,
`podcast_transcript_versions` + `_segments`.

**Jobs** — `background_jobs` (raw-SQL-only durable queue), plus rate-limiter
tables (`rate_limit_request_log`, `rate_limit_inflight`, `token_budget_*`) and
stream-token replay claims.

**Oracle** — `oracle_corpus_set_versions`, `oracle_corpus_works`,
`oracle_corpus_passages` (PGVector 256), `oracle_corpus_images` (PGVector 256),
`oracle_readings`, `oracle_reading_passages`, `oracle_reading_events`.

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
  dead-letters the row (only `chat_run` has a dead-letter finalizer that writes an
  errored assistant message).
- **Scheduler loop**: enqueues periodic jobs into fixed time slots with
  deterministic dedupe keys, so exactly one job per slot survives across workers.

The **registry** (`jobs/registry.py`) is the source of truth mapping job kind →
handler + policy. Claim is atomic, so the worker scales horizontally even though a
single instance is single-concurrency.

Task catalog (each is a thin handler in `tasks/` that wraps a service):
`ingest_web_article`, `ingest_epub`, `ingest_pdf`, `ingest_youtube_video`,
`enrich_metadata`, `chat_run`, `oracle_reading_generate`,
`library_intelligence_build_job`, `podcast_sync_subscription_job`,
`podcast_transcribe_episode_job`, `podcast_reindex_semantic_job`,
`podcast_active_subscription_poll_job` (periodic), `reconcile_stale_ingest_media`
(periodic), `sync_gutenberg_catalog_job` (periodic), `prune_background_jobs_job`
(periodic), `purge_expired_auth_handoff_codes` (periodic),
`backfill_default_library_closure_job`.

> Gotcha: only `enrich_metadata` declares `failed_result_statuses`. Other ingest
> tasks that *return* `{"status":"failed"}` still mark the **queue** row succeeded
> — the failure is recorded on the `media` row, and recovery relies on the stale
> reconciler + manual API retry, not queue-level retries.

### 7.4 Auth, identity & bootstrap

Supabase issues JWTs; FastAPI verifies them via JWKS (`auth/verifier.py`) and
derives a `Viewer`. On a user's first request per process, `AuthMiddleware` runs
**bootstrap** (`services/bootstrap.py`: `ensure_user_and_default_library`) once —
idempotent under SERIALIZABLE, creating the `users` row, a default library, and an
admin membership; the resulting `default_library_id` rides on the `Viewer`.
Visibility is enforced by boolean predicates (`auth/permissions.py`) that take an
explicit session and never leak existence (not-found == not-visible).

Other identity surfaces:
- **Stream tokens** (`auth/stream_token.py`): HS256, ~60s, single-use, for SSE.
- **Extension sessions** (`services/extension_sessions.py`): opaque
  `nx_ext_<...>` bearer; only its sha256 is stored; revocable.
- **Android handoff codes** (`services/auth_handoff_codes.py`): single-use,
  PKCE-bound (`challenge = sha256(verifier)`), 90s TTL, consumed with an atomic
  `DELETE ... RETURNING`.

### 7.5 BYOK keys, billing & entitlements

- **BYOK** (`services/user_keys.py`, `crypto.py`, `api_key_resolver.py`): provider
  keys (openai/anthropic/gemini/deepseek) are encrypted with XChaCha20-Poly1305
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
  reservations. It **fails closed** on acquire/check, open on release.

### 7.6 Search, retrieval & the embedding pipeline

One core `search()` (`services/search.py`) serves three surfaces: the in-app
search page, the chat `app_search` agent tool (RAG), and object-ref resolution for
notes.

- **Indexing** (`services/content_indexing.py`, `semantic_chunks.py`): text-bearing
  media flows `fragment → content_blocks → chunks → embeddings`, recorded as a
  versioned **content index run** with an `embedding_config_hash`
  (`provider:model:dims:chunker`). The active run is tracked in
  `media_content_index_states`; superseding runs deactivate the prior one.
- **Retrieval** is hybrid: a vector ANN arm (cosine over pgvector, joined on the
  *active* embedding config) **UNION** a lexical FTS arm, reranked by a weighted
  score (lexical hit + semantic similarity + recency), filtered by a similarity
  floor, then resolved through the locator resolver. For chat, candidates are
  selected under a context-char budget and every candidate/rerank/selection
  decision is written to ledger tables; selected rows become `message_retrievals`
  citation rows via the single validated writer `retrieval_citation.insert_retrieval_row`.
- **The `resource_uri` grammar** (`services/resource_resolver.py`,
  `resource_loaders.py`): a `<scheme>:<uuid>` URI (schemes: media, library, span,
  chunk, highlight, page, note_block, fragment, conversation, message) is the
  single vocabulary bridging conversation references, citations, prompt rendering,
  and the read/inspect agent tools. `load_resource_batch` is the one place each
  scheme's read SQL + permission check exists.

### 7.7 Citations & the agent tool contract

The chat/oracle LLM can call four tools (`services/agent_tools/`):

- **`app_search`** — RAG retrieval over the user's library (scoped to
  `media:`/`library:` refs); produces numbered, citable results.
- **`web_search`** — Brave public web search; numbered, citable.
- **`read_resource`** — reads exact text for a `resource_uri`; evidence reads are
  citable, oversized docs redirect to inspect.
- **`inspect_resource`** — returns a navigable document map of a `media:` URI;
  navigation only, never cited.

Citation `[N]` is a **dense, turn-global ordinal** assigned across the whole turn
(attached references first, then each tool's selected results); the frontend maps
`[N]` → a `message_retrievals` row → a clickable reader target.

---

## 8. Feature slices

Each slice below is a vertical: data model → backend service(s) → frontend
surface → key flows.

### 8.1 Media ingestion

The pipeline that turns five heterogeneous sources into one `media` row plus
per-format artifacts. Central service: `services/media.py`; state owner:
`services/media_processing_state.py`.

- **The entity & state machine**: `media.processing_status` runs
  `pending → extracting → ready_for_reading`. (`embedding`/`ready` enum values
  exist but are unused on the document path — `ready_for_reading` is the effective
  success terminal; search/embedding readiness lives on the *separate*
  `media_content_index_states` machine.) `failure_stage ∈ {extract, transcribe,
  embed, metadata, other}`; **only `source` and `metadata` are user-retryable**
  (extract/chunk/embed are deterministic and recovered by the periodic
  reconciler). `failure_stage='metadata'` and `'embed'` are *soft* warnings that
  coexist with a readable status.
- **Capture entry points** (`api/routes/media.py`): `POST /media/from-url`
  (classifies YouTube / X / PDF-or-EPUB-URL / web article and routes to the right
  ingest task), `POST /media/upload/init` + `POST /media/{id}/ingest`
  (signed-URL-first upload of PDF/EPUB with magic-byte + SHA-256 validation and
  dedupe), and `POST /media/capture/{article,file,url}` (extension-authenticated
  browser capture — captured articles go straight to `ready_for_reading`).
- **Per-format adapters**: EPUB and PDF extraction (§8.2), web articles via a
  **Node subprocess** (`node/ingest/ingest.mjs`, jsdom + Mozilla Readability, no
  browser), YouTube captions, X/Twitter threads (synchronous, rendered as
  `web_article`-kind media), and the Project Gutenberg catalog mirror.
- **Recovery**: `reconcile_stale_ingest_media` (periodic) requeues/fails stale
  `extracting` rows, GCs abandoned uploads, and repairs content/semantic indexes.
  `media_events` SSE streams live status to the UI.
- **Deletion** (`services/media_deletion.py`) is explicit and reference-counted
  (no DB cascades): per-viewer hide vs hard-delete-when-unreferenced, with storage
  objects deleted only after the DB commit.

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
  HTML5 parse (`services/canonicalize.py`) and is **immutable after
  `ready_for_reading`**, so the frontend DOM-text walk
  (`lib/highlights/canonicalCursor.ts`) yields identical offsets regardless of
  typography. The frontend canonicalizer must byte-match the Python one;
  `validateCanonicalText` is a hard gate.
- **PDF**: a locator is `(page_number, geometry quads)` plus a match into
  `media.plain_text` via `pdf_page_text_spans`. Highlight geometry is canonical
  page-space quads, quantized and fingerprinted for duplicate detection
  (`services/pdf_highlight_geometry.py`); PDF writes serialize on advisory locks.

EPUB ingestion (`services/epub_ingest.py`) produces fragments + a `EpubNavLocation`
per section, where the `section_id` is the path-encodable `href_path[#fragment]`
used in reader URLs. Navigation, sections, and resume state are served from
`api/routes/media.py`; resume stores reflow-safe canonical offsets (web/transcript)
or page/zoom (PDF), never pixels.

**Highlights** (`services/highlights.py`): a selection becomes a stored highlight
with a precomputed `exact`/`prefix`/`suffix` triple (a 64-codepoint context
window) that doubles as the canonical quote shown to chat. PDF highlights may have
empty `exact` (no text-layer match) — a first-class state the sidecar renders as a
placeholder. The reader's highlights sidecar renders `exact` only (the recent
exact-only cutover, [`modules/reader-highlight-sidecar-exact-only`](cutovers/reader-highlight-sidecar-exact-only.md)).

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
  evidence → web evidence → history → current user). The system prompt is the only
  cache-stable prefix (drives OpenAI `prompt_cache_key`). Attached references
  render as numbered `<resources>`; the transient `<reader_selection>` (a highlight
  the user is asking about) is bind-only and never numbered.
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

An agentic "reading" feature over a curated, versioned **public-domain literary
corpus** (`services/oracle.py`). A short question → retrieve corpus passages
(+ the user's library) and pick a plate image → one LLM call produces a structured
three-phase interpretation → stream + persist as `oracle_reading_events` + citation
"folios". It has its **own** retrieval/prompt/persistence and does **not** use the
four chat agent tools, but it **reuses the SSE transport** (stream tokens +
`stream.py` tail). The LLM emits only integer candidate indices + prose; all
citation text comes from the retrieved candidates (output that leaks source text
fails the parse). Frontend lives in the separate `app/(oracle)/` route group
(outside the pane system).

### 8.5 Libraries, sharing & the default-library closure

Content organization + access control (`services/libraries.py`).

- Every user has one **default library** (special: can't be renamed/deleted/shared
  or receive podcasts) plus shareable libraries with `memberships`
  (`admin`/`member` roles; owner is a distinct concept layered on admin).
  `library_entries` point at exactly one media or podcast and carry an integer
  `position`.
- **Sharing**: invites (`library_invitations`) and ownership transfer, both
  admin/owner-gated, with masked-404 for non-members.
- **The default-library closure** (`services/default_library_closure.py`) makes a
  user's default library reflect everything visible across their shared libraries
  without duplication. Two provenance tables: `default_library_intrinsics` (direct
  intent) and `default_library_closure_edges` (visible-because-of-membership). A
  media row survives in the default library if it has *either*. On invite-accept, a
  durable `default_library_backfill_jobs` row catches up historical content (the
  worker honors live revocation by locking the membership row).
- **Library Intelligence** (`services/library_intelligence.py`) is a versioned,
  source-grounded synthesis artifact per library (claims/evidence/sections graph).
  The build is currently a **deterministic compiler**, not yet LLM-backed; source
  drift marks the active version `stale`.

### 8.6 Contributors

A canonical authorship graph (`services/contributors.py`,
`contributor_credits.py`): `contributors` (person/org/group) with searchable
`contributor_aliases`, authority `contributor_external_ids` (orcid/isni/viaf/…,
globally unique per authority), and `contributor_credits` attaching a contributor
to exactly one media/podcast/Gutenberg-ebook. Credit resolution prefers explicit
id → external-id → confirmed alias → new unverified contributor. `split` and
`tombstone` are implemented with an audit trail (`contributor_identity_events`);
`merge` is modeled but not yet implemented. Surfaced in the UI as author chips
linking to `/authors/{handle}`.

### 8.7 Notes

A block-based outliner (`services/notes.py`). `pages` (ordinary + daily) hold a
tree of `note_blocks`; each block's `body_pm_json` (ProseMirror) is the source of
truth, with derived `body_markdown`/`body_text`. Sibling order is a dense,
recomputed `%010d` rank in `order_key` (not fractional). Full outliner ops
(create/update/split/merge/move, batched document patches with per-block + per-page
revision concurrency tokens, quick-capture into daily notes). Inline `object_ref`
nodes sync into `object_links` edges; highlights get a `note_about` backlink. Every
page/block projects into the `object_search_documents` index. Frontend:
`components/notes/ProseMirrorOutlineEditor.tsx` + `lib/notes/prosemirror/*`.

### 8.8 Podcasts & playback

`services/podcasts/*`: discover via Podcast Index, subscribe (optionally scoped to
libraries + auto-queue), sync episodes into `media` rows of kind
`podcast_episode`, and transcribe. Transcripts come from **RSS sidecar files**
(eager, during sync) or **Deepgram** (on-demand per viewer, gated by
`can_transcribe` + a daily quota; diarized with non-diarized fallback). New
episodes stay `pending` until a viewer requests transcription. The **playback
queue** (`playback_queue_items`, dense positions, unique per media) and
**listening state** (`podcast_listening_states`, resume position, ≥95%
auto-completion) are per-user. Frontend: a single app-wide `<audio>` element in
`lib/player/globalPlayer.tsx` with a Web Audio effects graph, OS media-session
integration, and 15s listening-state persistence.

### 8.9 Search surfaces & command palette

The same `search()` backs the `/search` results page (`SearchPaneBody`), inline
palette results, and the chat `app_search` tool. The **command palette**
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
(`lib/panes/paneRouteRegistry.tsx`) imports and renders inside a pane. The URL is a
*projection* of the active pane (mirrored via `history.replaceState`), not the
driver. New devs frequently look in `page.tsx` for behavior that lives in
`*PaneBody.tsx`.

- **Workspace shell** (`lib/workspace/*`, `components/workspace/*`): a tabbed,
  multi-pane canvas. State (`WorkspaceState`: primary panes with per-pane history,
  attached secondary tool panes, widths) lives in a React reducer+context store and
  is persisted **per-user-per-device** to `workspace_sessions` (debounced PUT,
  keepalive flush). A pane is identified by a `resourceKey` (`media:<id>` etc.) —
  the de-dup, title-cache, and remount key. Routes resolve via a pure model
  (`paneRouteModel.ts`) bound to React bodies (`paneRouteRegistry.tsx`). Bodies talk
  to the shell only through `paneRuntime.tsx` hooks (`usePaneRouter`,
  `usePaneParam`, `useSetPaneTitle`, `usePaneSecondary`). Secondary panes (reader
  tools, conversation context, library tools) are runtime-published sidebars.
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
`alembic upgrade head`** via a one-off `compose run` → `compose up -d
--force-recreate`. Env contracts live in `deploy/env/*` (real values untracked,
`.example` tracked); the sync scripts strongly validate them and reject legacy
Supabase/`STORAGE_*` keys. R2 CORS/lifecycle are applied as code via
`deploy/cloudflare/*`.

**Migrations** are hand-written Alembic files (`migrations/alembic/versions/`,
linear `NNNN_*` numbering, no autogenerate). Dev: `make migrate`. Test: a dedicated
`nexus_test_migrations` DB. Prod: run on every deploy before services start.

**Environment**: `.env.example` is the source of truth for every variable
([`rules/environment.md`](rules/environment.md)); `make setup` generates local
`.env` + `apps/web/.env.local`. Major groups: app/env, database + pool, Supabase
Auth (issuer/JWKS/audiences), internal secret, encryption key, LLM providers +
flags + rate limits, Brave web search, streaming (token signing key + base URL +
CORS), podcasts, browse providers, worker job allowlist + schedules, Stripe.

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
| Live-providers | real OpenAI/Podcast Index/Deepgram | live external | `make test-live-providers` |

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
3. **`ready_for_reading` is the document success terminal**; search/embedding
   readiness is a *separate* state machine. Only `source` + `metadata` are
   user-retryable stages.
4. **Reader offsets are Unicode codepoints into immutable `canonical_text`.** The
   frontend canonicalizer must byte-match the Python one; a mismatch disables
   highlighting for that fragment.
5. **One send = one durable `ChatRun`**; HTTP never calls the provider; the worker
   does; the client only tails SSE and reconciles.
6. **Active conversation path is per-viewer**; only path messages enter context.
7. **Citation `[N]` is a dense, turn-global ordinal**, not a per-tool index; only
   `message_retrievals` rows with a materialized citation get a number (the
   attached-reference citation regression came from breaking this).
8. **`background_jobs` is raw SQL**, invisible in `models.py`. Most ingest tasks'
   `{"status":"failed"}` returns mark the *queue* row succeeded; recovery is the
   reconciler + manual retry.
9. **No DB cascades.** Deletion is explicit, reference-counted, and orders external
   (storage) effects after the DB commit.
10. **pgvector is fixed at 256 dims**; the chunk ANN only matches embeddings whose
    config-hash equals the media's *active* config — a model change silently drops
    a media from semantic search until re-indexed.
11. **Frontend routing is the pane system, not `children`.** Behavior lives in
    `*PaneBody.tsx`; the URL is a projection of the active pane.
12. **Migrations are hand-written**; `models.py` and the live DB can drift —
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
| Media ingestion | `python/nexus/services/media.py` (+ `*_ingest.py`, `*_lifecycle.py`) |
| Reader/highlights backend | `python/nexus/services/{reader,epub_*,pdf_*,fragment_blocks,highlights}.py` |
| Chat / conversations | `python/nexus/services/chat_runs.py` + `chat_run_*`, `context_assembler.py`, `conversations.py` |
| Oracle | `python/nexus/services/oracle.py` |
| Search / retrieval / indexing | `python/nexus/services/{search,content_indexing,semantic_chunks,retrieval_citation,resource_resolver}.py` |
| Agent tools | `python/nexus/services/agent_tools/` |
| Libraries / contributors / notes | `python/nexus/services/{libraries,default_library_closure,contributors,notes}.py` |
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
