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
12. [verification](#12-verification)
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
   │  shell  │           └───────┬──────────────────────────────────────┘
   └─────────┘                   │ /api/* product, assets, /api/stream/* (SSE)
   ┌─────────┐  bearer token     │ same-origin BFF, X-Nexus-Wire on every call
   │Extension│──────────┐        ▼
   └─────────┘          │  ┌───────────────────────────┐
                        └─▶│  Next.js BFF (/api)        │
                           │  proxy.ts: session, asset, │
                           │  stream, copy, share and   │
                           │  extension lanes, no logic │
                           └──────────┬─────────────────┘
                                      │ Bearer + internal + request id + device,
                                      │ or the share token and internal only
                                      ▼
                           ┌─────────────────────────────────────────────┐
                           │            FastAPI  (python/nexus)           │
                           │  middleware: edge (request id, wire) → auth  │
                           │  dependency: db-session (function scope)     │
                           │  routes (transport-only) → services (logic)  │
                           └───────┬───────────────────────────┬─────────┘
                                   │ sync ORM (threadpool)     │ LISTEN/NOTIFY
                                   ▼                           ▼
                           ┌──────────────┐            push events to /stream/*
                           │  PostgreSQL  │◀───────────────────────────┐
                           │  + pgvector  │   claims background_jobs    │
                           └──────┬───────┘          ┌───────────────────────┐
                                  │                  │ Workers (two lanes)   │
                                  │ object refs      │ interactive: chat,    │
                                  ▼                  │ dossier, metadata,    │
                           ┌──────────────┐          │ podcast sync, oracle  │
                           │ r2/seaweedfs  │◀─────────│ background: ingest,   │
                           │ object store │          │ index, repair, delete │
                           │              │          └───────────────────────┘
                           └──────────────┘

   Identity: Supabase Auth (JWT/JWKS) only — no Supabase DB or Storage.
   External: ChatGPT via the isolated Codex personal host (all background and
             a Chat option); configured generation APIs (Chat options);
             OpenAI API (embeddings); Deepgram (transcription),
             Brave (Browse + agent research), Podcast Index, YouTube Data API
             plus YouTube transcript/caption egress,
             Cloudflare R2.
```

**The one rule that explains the shape:** the browser holds no tokens and never
calls FastAPI directly. Product data, private assets and live streams go to
same-origin Next.js `/api/*` routes, which proxy to FastAPI with a
server-attached bearer and the internal secret ([api edge](modules/api-edge.md)).
Public static assets (the Oracle plates under `/oracle-plates/`) are Next.js
files, not API data. Android's offline reading copy is built by
`POST /api/media/{media_id}/reading-copy` and downloaded from the signed storage
url it answers ([offline](modules/offline.md)). See
[`rules/layers.md`](rules/layers.md) and
[`rules/modules/transport.md`](rules/modules/transport.md).

---

## 3. Runtime topology & deployment

Production comprises these runtime processes plus managed external
dependencies.

| Process                | Code                                                  | Hosted                           | Role                                      |
| ---------------------- | ----------------------------------------------------- | -------------------------------- | ----------------------------------------- |
| Next.js frontend + BFF | `apps/web`                                            | **Vercel** (staged, then promoted) | React UI + `/api/*` proxy to FastAPI    |
| Caddy edge             | `deploy/hetzner/Caddyfile`                            | **Hetzner VPS** (Docker Compose) | TLS termination and exact route proxying  |
| FastAPI API            | `apps/api/main.py` → `python/nexus`                   | **Hetzner VPS** (Docker Compose) | product API, SSE streaming                |
| Interactive worker     | `apps/worker/main.py` → `python/nexus/jobs` + owners  | **same Hetzner VPS**             | user-waiting queue work                    |
| Background worker      | `apps/worker/main.py` → `python/nexus/jobs` + owners  | **same Hetzner VPS**             | indexing, repair, teardown, periodic work |
| Codex generation host  | `apps/codex_agent`                                    | **same Hetzner VPS**             | isolated subscription-backed generation  |
| Codex egress policy    | `deploy/hetzner/docker-compose.yml` (nginx stream)    | **same Hetzner VPS**             | TLS-SNI allowlist (chatgpt.com, auth.openai.com) |
| PostgreSQL (pgvector)  | —                                                     | **same Hetzner VPS**             | the single source of truth                |

managed/external: **cloudflare r2** (object storage; seaweedfs locally), **supabase**
(hosted Auth only — JWT issuance/JWKS/OAuth; _no_ Supabase Database or Storage),
and the generation/search/podcast services above. The frontend is
served by Vercel.

Key topology facts (details: [`deployment.md`](../deployment.md),
`deploy/hetzner/`, `deploy/vercel/`):

- Default request path is **Browser → Next.js BFF → FastAPI → Postgres**.
  SSE is the documented exception (**Browser → FastAPI `/stream/*`**).
- One full Git SHA identifies a release vector. Each `main` push publishes one
  strict manifest (schema 3) containing immutable API/worker image digests and
  the expected schema. The host pulls those digests; it never
  builds application images.
- `deploy/hetzner/deploy.sh <source-sha>` is the sole application release
  entrypoint. It runs `deploy/hetzner/release.py`, one linear idempotent pass
  (preflight, declared host inputs, images, verified R2 backup, migration,
  `up --wait`, Caddy reload, health, Codex isolation assertions, `current`
  pointer), then promotes the exact staged Vercel deployment. There is no
  attempt state and no resume mode: rerun the same command.
- VPS and Vercel config publication are explicit prepare-only operations, never
  implicit release steps. The Oracle corpus seed is a separate idempotent
  operator command, safe while the app runs; application release never runs it.
- Supabase owns Auth only. Hetzner Postgres and Cloudflare R2 own product data.
- Both worker lanes use a bounded 300-second database statement timeout. The
  API keeps its tighter role-scoped timeout.
- `NEXUS_INTERNAL_SECRET` must be **identical** on Vercel and the VPS — it is the
  shared secret the BFF attaches as `X-Nexus-Internal` so FastAPI knows a request
  came through the trusted proxy.
- The web app has one public origin, `APP_PUBLIC_URL`: every absolute auth
  redirect, every Origin check (auth forms, session resolve, the BFF) and the
  auth cookies' Secure flag come from it. Other hosts (the Vercel default
  domain, an alias) cannot sign in, so sessions exist only on it. Server
  Actions keep Next.js's own check, same-host only: the Origin host must equal
  the request host, whichever host that is. Hosted Supabase Auth must have
  `${APP_PUBLIC_URL}/auth/callback` as an exact redirect URL, reviewed in the
  Supabase dashboard when auth settings change. The firefox extension's one
  redirect origin (`NEXUS_EXTENSION_REDIRECT_ORIGINS`) is frontend-only and
  stays out of the VPS runtime env.
- local dev uses docker compose (postgres on `54320`, seaweedfs on `8333`)
  plus supabase-local auth, started by `make dev`.

---

## 4. Architectural principles (the constitution)

These are the load-bearing rules that explain _why_ the code looks the way it
does. Full normative text lives in [`rules/`](rules/index.md); this is the
orientation summary.

**Layering & ownership** ([`rules/layers.md`](rules/layers.md),
[`rules/codebase.md`](rules/codebase.md), [`rules/cleanliness.md`](rules/cleanliness.md)).
Top to bottom: node Next middleware (silent entry resolution + CSP) →
the session protocol (`apps/web/src/lib/auth/session.ts`, the _only_
verified-session authorization boundary, over the one Supabase boundary
`apps/web/src/lib/supabase/`) → Next `/api/*` routes (dumb proxy, no business logic) →
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
   product reads/writes go to **same-origin** `/api/*` with `X-Nexus-Wire`; a
   `401 E_UNAUTHENTICATED` hard-redirects to `/login`; a `426` reloads the tab
   once per build.
2. **Next middleware** (`middleware.ts`, node runtime) attaches a per-request
   csp nonce. protected GET/HEAD and login, including rsc/prefetch, resolve entry:
   verify an active bearer or refresh once when required, forward successor cookies
   and device identity, and publish the same effect on the response. success renders
   the requested url directly; ended/anonymous go to login and dependency failures
   go to the manual unavailable surface. it never runs on `/api/*`, whose route
   handlers own the request and its body (`next.config.ts` adds static headers);
   `/auth/*`, extension start and other methods keep their own response owners.
   protected/auth responses are private and uncacheable; middleware never
   resolves a non-GET/HEAD request.
3. The `/api/*` catch-all **route handler** calls
   `proxySession(request, path, "Json")`; assets, streams, the reading copy,
   shares and the extension have their own route files and lanes.
4. **`proxySession`** (`lib/api/proxy.ts`) does the real work: enforces a CSRF
   Origin check on mutations; resolves a refreshable session before consuming a
   request body and turns it into a bearer; forwards an allow-listed set of
   headers plus `Authorization: Bearer <supabase access token>`,
   `X-Nexus-Internal: <secret>`, `X-Request-ID` and `X-Nexus-Device`; applies a
   30s timeout;
   strips internal/`set-cookie`/auth headers off the response; and streams an
   authenticated upstream body without first materializing it in the BFF. The
   browser never sees the bearer or the internal secret. Session resolution
   returns terminal `401`, dependency `503`, or defect `500`; only terminal
   outcomes clear cookies. The shared response finalizer owns all cookie effects
   and canonical `private, no-store` headers, including downstream failures.
5. **FastAPI** receives the request through its middleware stack — executed in this
   order (`python/nexus/app.py`): Edge (request id, wire check) →
   **Auth** → route. `AuthMiddleware` (`auth/middleware.py`) verifies the JWT via
   JWKS (`auth/verifier.py`), resolves first-login **bootstrap** through its bounded
   process-local success cache (threadpool + database only on a miss), and attaches
   a `Viewer{user_id, default_library_id, email, roles}` to `request.state`.
6. The **route handler** (`api/routes/*`) is transport-only: pull the `Viewer` and
   a DB `Session` via `Depends`, call exactly one **service** function, return
   its response model (`Data[XOut]`, per `docs/local-rules/typed-wire.md`) or
   raise an `ApiError`. Handlers are plain `def`, so
   FastAPI runs the blocking ORM work in a threadpool (never blocking the loop).
7. The **service** holds the business logic, returns plain data.
8. on the way out, the function-scoped `DbSession` dependency releases its pooled
   connection after returned-value serialization and before body transfer.
   `RepeatableReadDbSession` shares that cleanup owner. rollback and close run in
   a shielded worker; close still runs if rollback fails. session-free error
   handlers may render after dependency unwind. The edge middleware stamps
   `X-Request-ID` on every answer and logs `http.request.completed` when the
   request ends (a stream when it closes or its client leaves).

Errors become HTTP via three exception handlers (`responses.py`): `ApiError`
carries an `ApiErrorCode` enum mapped to a status; unhandled exceptions become a
detail-free `500 E_INTERNAL` (with special logging for DB pool exhaustion).

### 5.2 A public static asset

Oracle plate images are static web assets, `apps/web/public/oracle-plates/<key>.jpg`,
named by the plate key the reading carries (`MediaImage kind="static"`). Next Image
may optimize `/oracle-plates/**`; `/api/media/image` is not in
`images.localPatterns`. A plate's bytes never change under its key.

### 5.3 Live streams (SSE)

A stream is an ordinary session request through the BFF:

1. The client opens `openStream({path: "/api/stream/...", after})`
   (`lib/api/stream.ts`): a cookie GET with `X-Nexus-Wire`. The BFF's `Stream`
   lane forwards it with the session bearer and ends the body cleanly at 280 s,
   before the route's `maxDuration = 300`.
2. FastAPI `/stream/*` (`api/routes/stream.py`) authenticates like every route,
   asserts ownership, and **tails committed state** woken by Postgres
   `LISTEN/NOTIFY` — re-reading in a fresh session in a threadpool, never
   blocking the loop; at most 64 listeners per process (one more answers 429).
3. The client parses the SSE framing, each stream's caller decodes its events,
   and folds them into UI state. After any cut it resumes with `?after=<id>`
   (cursor streams) or receives the whole snapshot again (snapshot streams); a
   401 sends the tab to login.

This is used by chat runs, oracle readings, Dossier builds, media processing
status, metadata enrichment, and the active Podcast subscription lifecycle.
The lifecycle stream is keyed by the subscription epoch UUID while its public
route remains viewer + Podcast addressed; every snapshot reasserts that exact
epoch and viewer before it can cross the stream.

---

## 6. The data model: schema domain map

PostgreSQL is the single source of truth. The schema of record is the live
database (`pg_dump --schema-only`) plus the **hand-written** Alembic migrations
(`migrations/alembic/versions/NNNN_*.py`, linear chain, no autogenerate).
Revisions `0001`-`0292` are squashed into one baseline, `0292_baseline.py`,
which replays the dumped schema and seed rows beside it; the chain continues
from there. `python/nexus/db/models.py` holds only the ~90 classes the code
queries through the ORM — it mirrors no constraints or indexes — and many live
tables are reached only from raw SQL, among them **`background_jobs`**, defined
in `python/nexus/jobs/`.

Conventions throughout: UUID `id` PKs (`gen_random_uuid()`), `timestamptz` with
`now()` defaults, heavy `CHECK`/`UNIQUE`/partial indexes encoding business rules,
JSONB columns (with `jsonb_typeof` checks), and `pgvector` columns fixed at
**256 dimensions**. Readable content artifacts are current-only: reprocessing
replaces the current evidence rows instead of preserving app-level versions,
hashes, fingerprints, or supersession chains.

The tables group into these domains:

**Identity / auth / sessions** — `users` (PK = Supabase `sub`),
`extension_sessions`, `auth_handoff_codes`, `reader_profiles`,
`workspace_sessions`, `nexus_usages`. LLM access
runs on platform credentials only — there is no per-user key table.

**Media / ingestion** — `media` (the central readable entity; PDF `plain_text`
has a same-row STORED `plain_text_word_count` derivative), `media_file` (private
original-file object metadata), `project_gutenberg_catalog`,
`user_media_deletions`.

**Import history** — `media_upload_events` (owner `media_upload_sessions`) and
`media_processing_events` (owner `media`) are the two append-only narration
tables the Imports workspace reads. Each carries `occurred_at`, nullable
`stage`/`failure_code` query columns, and a closed typed `payload` that names its
own `kind`. `services/import_history.py` is their only writer: transaction-scoped
helpers with no commit, scheduling, or domain-policy authority, recording each
fact atomically with the transition it documents. The cut's one-time baselines
(one per extant upload session and source attempt) stay as stored facts. No
other owner reads history as an identity: an accepted attempt's surviving media
is ingest's `media_source_supersessions`.

**Reader content / fragments** — `fragments` (current render units carrying
`canonical_text` + `html_sanitized` and a same-row STORED
`canonical_text_word_count` derivative), `fragment_blocks`, EPUB structure
(`epub_toc_nodes`, `epub_nav_locations`, `epub_fragment_sources`,
`epub_resources` for private extracted asset object metadata),
`pdf_page_text_spans`.

**Reader publication identity** — `reader_publications` gives each ready PDF,
EPUB, or web article one document-only generation. `reader_publication.py` is
the publication and capture owner: immutable object writes precede the
transactional canonical pointer swap, a replacement increments the generation
once, and an object that vanished under a reading-copy build answers
`E_READER_CONTENT_CHANGED`. Every write that changes what a reader sees is a publication,
including metadata enrichment's title write. Offline copies and device
availability are not server rows.

**Retrieval index** — `evidence_spans`, `content_chunks`,
`content_embeddings` (pgvector, 256 dims),
`content_index_states(owner_kind, owner_id)`, `media_transcript_states`.
The index is owner-polymorphic: media-owned content and note-owned bodies share
the same chunk/span/embedding pipeline; notes no longer have a parallel
`object_search` substrate.

**Media Intelligence** — `media_summaries` is one current summary head per
Media content fingerprint; `media_claims` holds ordered grounded claims whose
targets are exact `evidence_span` rows. `services/media_intelligence_lifecycle.py`
owns the head lifecycle, `tasks/media_unit_build.py` publishes or fails a unit,
and `services/media_intelligence.py` publishes audience-gated single/batch
projections.
Media Intelligence is current-only reusable interpretation, not a Dossier.

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

passage routes retain `#passage-{anchor_id}`. on activation, the owner pane reads
`GET /passage-anchors/{id}/resolution?owner_ref=...`; the service checks anchor
ownership, the requested owner, and current owner access before resolving the
quote. the response is a present navigation target or absent when no unique
current location exists. text targets use current raw codepoint offsets; pdf
targets name the current page without claiming stored hint geometry is current.
no offsets or resolution status are persisted. each pane uses its existing positioning owner.

note quotes match in normalized text, then project unique hits into raw stored
codepoint offsets. projection preserves the matched unicode component
occurrences; a hit that cannot form one exact raw interval remains unresolved.
resolution never rewrites the note body or chooses among ambiguous matches.
the backend derives note text from the single-block prosemirror body. the
frontend's note-body projection mirrors that text and owns editor positions;
editing, transport decoding, and range decoration consume the same projection.

**Libraries / sharing** — `libraries`, `memberships`, `library_entries`, and
`library_invitations`. There is no separate provenance, closure, or backfill-job
table: the default library's read surface is a live query over
`library_entries` + `memberships`, computed at read time (§8.5).

**Contributors** — `contributors` (canonical identity; every row is active,
there is no self-FK, no merge/split/tombstone, and no status column),
`contributor_aliases`, `contributor_external_ids`, `contributor_credits`.

**Notes** — `pages` (title only), `daily_page_bindings` (one sparse
user/date role assignment to an ordinary Page), `note_blocks` (ProseMirror JSON
plus generated text only), `resource_versions` and `resource_view_states`. `users.calendar_time_zone` is the sole account-local
Today clock.
the account profile's single transport owner is native `UserProfileOut`, returned
by GET and PATCH `/me` as `Data[UserProfileOut]`. all six keys are required,
including nullable email, display name and ingest address. GET supplies the
configured ingest address; PATCH retains null. settings preserves its GET
address while acknowledging only the edited field. web calls use generated
method-specific contracts; bootstrap alone projects the two-field account domain.
its provider keeps the current account-local zone. plain-text share freezes that
date before saving. python owns the display-name bound (100 code points); the web form
defers to it (the 400 names it) and an empty name clears the name.
bare `/daily` opens today's daily page in the account zone (the workspace bootstrap
resolves it).
page/note links, highlight-note attachments and backlinks use `resource_edges`;
notes own no separate relationship table.

**resource graph** — `resource_edges` stores typed facts with polymorphic
`scheme`+`id` endpoints: user, citation, system, note-body embed, highlight-note,
discovery, document-embed, assistant and link-note origins. citations retain
ordinal/snapshot and discovery retains its rationale. machine kinds may express
supports or contradicts. user links have one shape: `origin=user`, `kind=context`,
canonical unordered endpoints, no self-link, ordinal, snapshot or source order.
repeated/reverse creation returns the existing pair. application admission owns
shape and visibility; the database owns pair uniqueness. endpoint view states
own independent adjacency order without defining link existence. an optional
link note is an ordinary note with two `link_note` attachments, one per endpoint.
connections exposes these facts and the pair's note preview with owner-specific
mutations and durable assistant creator receipts. external snapshots remain
public-web citation targets. see [connections](modules/connections.md).
the librarian names the presentation role for assistant and automatic connection
curation; stored origins and capabilities retain their operational meaning.

**Universal Dossiers** — `artifacts` is the stable head keyed by subject plus
derived audience, and carries its one revision: `revision_id` (the
`artifact_revision:` identity), one accepted semantic `content_html` article,
its `content_text`, its `coverage` (counts plus the input fingerprint) and its
provenance. `artifact_builds` records each generation attempt with a `status`
(`active | succeeded | failed | cancelled`, at most one active per head by a
partial unique index) and a failure code. Eight subject bindings cover Media,
Conversation, Library, Podcast, Contributor, Page, Note, and the internal
user-owned Idea (`artifact_idea_subjects`, seeded by `artifact_idea_seeds`). One
engine, API and `dossier_build` job own the lifecycle; a success swaps the
revision columns and citation edges and deletes every other build of the head in
one transaction.
published dossiers say `prepared by the librarian`; provenance distinguishes
`requested by you` from `requested by a library member` using `by_viewer`, and
retains model, tokens and date. media abstracts keep their own attribution.

**Conversations / chat** — `conversations` (carries the owner's
`active_leaf_message_id`), `messages` (the message tree with branch pointers;
a user turn may carry a `fork_title`); plus the **chat-run** machinery: `chat_runs`
(carries its admitted `generation_spec`, its frozen prompt `generation_intent`
and `support_id`; execution provenance lives in its `llm_calls` row),
`chat_run_events` (append-only SSE log); and the
**retrieval/citation** ledger: `message_retrievals` (each hangs off its answer and,
unless it is attached context, its `tool_calls` row) — the
sole durable per-result record (telemetry; carries `cited_edge_id` pointing
back at the citation edge). Candidate generation and rerank/selection are
transient, in-memory passes over a tool call's results; only the
selected/included outcome is ever written. Conversation
context membership combines incident neutral user links and outgoing
citation/system context facts; citation occurrences stay distinct. prompt, frozen
tool admission and scoped search share this projection. linked-chat reads page
all completed branches without importing their attachments. Assistant
message API responses include a
`trust_trail` read model assembled from these durable rows.

**Podcasts / playback** — `podcasts`, active-only `podcast_subscriptions`
(`id` PK, unique viewer/Podcast relationship, live `sync_status`, and
`auto_queue_watermark_at`), `podcast_subscription_backfills` (the separate
durable history-traversal fence), `podcast_episodes` (PK = `media_id`),
`podcast_episode_identities` (stable PodcastIndex/RSS aliases),
`podcast_episode_chapters`,
`podcast_listening_states` (position clamped to duration, nullable established
episode rate, the `reset_epoch` that alone fences listening writes, and
write-only `last_engaged_at`; operational `updated_at` is not engagement),
`podcast_transcription_jobs`, `podcast_transcript_segments`. Named
Podcast placement is only `library_entries(podcast_id)`; Default/All is virtual
and stores no Podcast entry.

**Reader cursor / Lectern / consumption** — `reader_media_state` (the canonical
revision-fenced resume cursor, including persisted `Empty` reset tombstones;
consumption state does not derive directly from it),
`consumption_queue_items` (the Lectern: one ordered, mixed-media list per
viewer, membership/order only — completion is never stored on the row),
`consumption_overrides` (explicit `Unread`/
`Finished` state), `reader_engagement_states` (one current-state row per
viewer/media: `last_engaged_at` recency), `consumption_activity_spans` (bounded
observed Reading/Listening/Viewing intervals), `consumption_completion_facts`
(the first observed post-cutover canonical completion per viewer/media), and
`media_teardown_intents` (media-deletion claim; see §8.8 and
[`modules/storage.md`](modules/storage.md)). Current state and historical facts
are separate. Explicit status and current progress are also independent:
`SetUnread` preserves the bookmark and advances reader/audio fences; accepted
activity clears its override. `ResetProgress` clears the
override and atomically resets Nexus-owned cursor, engagement, and listening
state without deleting history or Lectern membership. See
[`modules/consumption-activity.md`](modules/consumption-activity.md) and
[`cutovers/media-progress-reset-hard-cutover.md`](cutovers/media-progress-reset-hard-cutover.md).

**Jobs** — `background_jobs` (raw-SQL-only durable queue). Worker lane
topology and exact queue claims own local execution capacity; no anonymous
in-flight counter participates in admission or execution.

**Oracle** — the public-domain corpus is a real `libraries` row
(`system_key = 'oracle_corpus'`) of ordinary `media`; its text and embeddings live
in the shared content index (`content_chunks`/`content_embeddings`), not an
Oracle-owned vector store. `services/oracle/corpus.json` is the corpus's truth;
`oracle_corpus_sources` maps each `work_key` to its current `media_id`, and
`oracle_passage_anchors` holds each passage (label, curated quote, tags) with
FK-free cache pointers to its current `evidence_span`/`content_chunk`, re-resolved
lazily by the reading job. The anchor doubles as the `oracle_passage_anchor:<id>`
citation target. `oracle_readings` is the whole reading: pending until one
transaction completes it (folio fields, omens, plate key, jsonb passages) or fails
it; migration 0262 folded the retired event log's display into the same row.

> `models.py` maps only the tables the code queries through the ORM; the
> raw-SQL tables (`background_jobs` and roughly thirty others) never appear
> there. The schema of record is the live database (`pg_dump --schema-only`)
> plus the hand-written migrations; there is no autogenerate, so a forgotten
> migration is caught only by a failing query.

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
- **request session lifetime** (`db/session.py`): `DbSession` and
  `RepeatableReadDbSession` use native function scope. returned-value serialization
  finishes before worker rollback/close and body transfer; streamed bodies must
  not borrow the session. phase-owned stream sessions retain their own lifetime.
- **Server-side prepared statements are disabled** (`prepare_threshold=None`) for
  pooler safety.
- **SERIALIZABLE** isolation is opt-in via `use_serializable()` for
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
| `oracle_readings`       | status change on `oracle_readings` | oracle SSE tail  |
| `artifact_builds`       | insert, status change, delete     | Dossier SSE tail |
| `media_events`          | update on `media`                 | media-status SSE |
| `nexus_background_jobs` | enqueue in `jobs/queue.py`        | worker wake-up   |

### 7.3 Background jobs & the worker

A durable Postgres-backed queue (`python/nexus/jobs/`). Jobs are enqueued by
inserting a `background_jobs` row + `pg_notify` **in the caller's transaction**
(atomic with domain writes), with the attempt budget of the kind's registry row.
Two single-process workers run the same entrypoint with fixed `interactive` and
`background` lanes; each loop cycle:

- **Schedules**: the background lane enqueues each periodic kind's current UTC
  slot once cluster-wide (`periodic:<kind>:<slot start>`, unique dedupe key,
  `available_at` = slot start). Periodic rows use priority 200 and yield to
  ordinary priority-100 work. The interactive lane has no periodic kinds.
- **Claims and runs**: `claim_next_job` picks one due row of the lane's kinds with
  `FOR UPDATE SKIP LOCKED` (new work _or_ a row whose 30 s liveness lease expired),
  takes the one Heavy capacity lease for a Heavy kind, flips it to `running` and
  mints its `execution_id`. A heartbeat thread renews the lease every 5 s. The
  interactive lane runs the handler in process; the background lane in a fresh
  child bounded by the lane's 448 MiB cgroup.
- **Settles**: one transaction applies the outcome (complete, reschedule, retry
  after the kind's delay, or dead) under the fence `status = 'running' AND
  execution_id`, then the kind's `on_dead` and `on_history` hooks, so a domain
  finalizer and the import history commit with the transition they document.

The **registry** (`jobs/registry.py`) is the one table of kinds: lane, handler
(`module:fn` in the owning service), budget, retry delays, Heavy class, schedule,
retention and hook paths. Lanes, budgets and prune retention derive from it. See
[modules/jobs.md](modules/jobs.md).

Kinds (17): interactive `chat_run`, `dossier_build`, `enrich_metadata`,
`oracle_reading_generate`, `podcast_sync_subscription_job`; background
`ingest_media_source`, `media_content_reindex_job`, `note_reindex_job`,
`media_unit_build`, `connection_discovery_scan`, `podcast_backfill_subscription`,
`media_teardown`, and the periodic
`podcast_refresh_due_job`, `atlas_project_job`, `storage_orphan_sweep`,
`prune_background_jobs_job`,
`purge_expired_auth_handoff_codes`. The Project Gutenberg catalog sync is an
operator command (`nexus sync-gutenberg-catalog`), not a kind.

Author identity is resolved inline, synchronously, inside each ingest/enrichment
lane — there is no separate contributor-dedupe job, proposal table, or merge
contract. `services/contributors.py` is the sole author-mutation facade: a
resolver keyed on exact stable key → confirmed alias → new contributor
(§8.6) runs in the same transaction that replaces a lane's observed role slice,
so duplicate identity is prevented at write time rather than proposed and
reconciled after the fact.

> Gotcha: a handler that _returns_ `{"status":"failed"}` still marks the
> **queue** row succeeded — the failure is recorded on the domain row, and
> recovery is the user's retry (a source's dead job is its repair offer), not
> queue-level retries. A handler that wants the job dead returns `TerminalJobFailure`.

**Generation boundary.** Every generative job — chat, Oracle, connection
discovery, dossiers, media summaries, and metadata enrichment — makes one
`generate` call (`services/generation/run.py`). It reads the exact selection from
the chat run or the operation table, checks the catalog, opens one `llm_calls`
row, runs Codex Personal (the kernel's transient native mode) or a provider API
(the kernel's `run_generation` loop, held in memory), decodes the output with
the caller's decode, and closes the row once. All background operations select
Codex Personal. Chat may instead select any ready route/model/reasoning pair in
the configured `llm-calling` catalog. There are no user defaults, profiles,
presets, or fallback routes.

Nothing replays. A worker that dies mid-generation leaves its row open until its
job's next attempt starts, the job dies or is revoked, or migration 0269 closes
it `interrupted`; chat fails the run and the user reruns, background jobs rerun
from scratch. Within `dossier_build`, `services/dossier/synthesis.py`
owns the synthesis prompt and its `Published | Failed | Stopped` outcome; idea
research keeps its billed web search picks in the job payload across
reschedules. The existing PostgreSQL queue, leases, and publication owners
remain unchanged. See [modules/llms.md](modules/llms.md).

Eligible Chat and background runs use one canonical tool authority. Provider
API tool proposals adapt frozen plans to the executor and use
`generation/{generation_seq}/tool/{n}` with one monotonic parent-generation
ordinal, receipts, evidence, citations, trust, and Undo; Codex native callbacks
use the same positions. Every call that reaches dispatch leaves one row, completed
with its effects.

Local execution capacity belongs to the single-process interactive/background
lanes and queue claims. SERIALIZABLE retries everywhere go through the one helper
`db/retries.py:retry_serializable`.

### 7.4 Auth, identity & bootstrap

Supabase issues JWTs; FastAPI verifies them via JWKS (`auth/verifier.py`) and
derives a `Viewer`. On a user's first request per process, `AuthMiddleware`
coalesces concurrent cold requests into one cancellation-shielded task and runs
**bootstrap** (`services/bootstrap.py`: `ensure_user_and_default_library`) once —
idempotent under SERIALIZABLE across processes, creating the `users` row, a default
library, and an admin membership. Its bounded process-local LRU carries the
resulting `default_library_id` on later `Viewer` projections without another
threadpool or database hop. Failure is never cached; eviction only repeats the
idempotent bootstrap on a later request.
Visibility is enforced by boolean predicates (`auth/permissions.py`) that take an
explicit session and never leak existence (not-found == not-visible).

Membership is closed: global Supabase signup and anonymous users are disabled,
the phone provider is off, and email, Google, and GitHub remain enabled for
existing users. The operator
creates the only new principals with Supabase Dashboard invitations. Custom
invite and recovery messages lead to non-consuming Nexus GET landings; an
explicit POST fixes the token purpose, establishes the Supabase session, and
uses the same protected **Set or replace password** surface. Supabase alone
owns password hashes, email tokens, provider identities, and sessions. Nexus
stores no invitation, enrollment, authenticator, or password-presence state,
and `auth.identities` is never interpreted as evidence of a password. Linked
Identities projects only Google and GitHub; an OAuth identity can be unlinked
only while another supported OAuth identity remains, so unlink safety never
depends on inferred password presence.

web auth has one supabase boundary, `apps/web/src/lib/supabase/`: `cookie.ts`
owns the session cookie grammar, decoded bearer and network-free renewal
classification; `auth.ts` builds one sdk client per operation over an in-memory
jar seeded from the caller's cookies, collects the cookie writes the caller
publishes, and bounds the whole operation (requests, bodies, sdk retry/backoff)
with one 5 s deadline. establishing operations keep incoming cookie names for
chunk removal and the pkce verifier while withholding old session values;
`refresh()` is the only place a refresh token is spent (one in-flight refresh
per presented cookie per process). a session is `active` only with more than
120 s left, beyond auth-js's own 90 s self-refresh margin plus the deadline, so
the sdk never refreshes a live session itself. `lib/auth/session.ts` owns
verification (read-only, for server components), liveness (refresh inline,
for response owners) and the one cookie-effect adapter: `finish()` on route
responses and `withActionSession()` for server actions, both with native
deletion so expiry survives next's mutable-cookie merge, clear precedence and
private, no-store headers. a session the provider reports ended, at refresh or
under an operation (signed out or revoked elsewhere, a rejected token), is
cleared with one-minute feedback that selects the login heading "sign in to
continue". decoded bearers authorize nothing: read-only page and api verification
ignore the proactive renewal margin. node middleware owns silent GET/HEAD entry;
`verifySession()` verifies again without refresh. POST action rerenders can clear
credentials and return to login without a target loop. return-target ingress waits
for the browser hash and uses the same validated target for every sign-in action.

`/auth/session/unavailable` does no work on mount. its stable button alone posts to
`/auth/session/resolve`: 204 continues, 401 signs in, 503 preserves credentials.
a 12 s browser deadline means unconfirmed delivery; it cannot undo rotation.
unknown responses reach logged terminal containment. the old recovery namespace
is deleted and unknown auth paths return 404; unsupported methods on exact routes retain 405.

native handoff delivery owns local session failure cleanup: the user agent that
minted a handoff code (the custom tab, the native http client) keeps no
session, and any failed attempted installation clears old and new local auth
names. validation and consume failures before installation preserve the prior
jar. this is local cleanup, without restoring an old session, revoking provider
credentials or recovering a consumed code.

Other identity surfaces:

- **Extension sessions** (`services/extension_sessions.py`): opaque
  `nx_ext_<...>` bearer; only its sha256 is stored; revocable.
- **Android handoff codes** (`services/auth_handoff_codes.py`): single-use,
  PKCE-bound (`challenge = sha256(verifier)`), 90s TTL, consumed with an atomic
  `DELETE ... RETURNING`.

### 7.5 Generation credentials & rate limiting

- **Generation credential**: only the isolated Codex host can read the exact
  enrolled `codex-personal` ChatGPT `auth.json`, mounted read-write solely for
  pinned `0.144.4` in-place OAuth refresh persistence. All other mutable SDK
  state is per-turn tmpfs and deleted after close. The Codex host receives no
  generation API key. API/worker processes receive only the provider keys named
  by `GENERATION_API_PROVIDERS`; `services/generation/provider.py` projects that
  exact configured set into ProviderRuntime, and `services/embeddings.py`
  keeps the OpenAI embedding key in its separate narrow credential. See
  [modules/llms.md](modules/llms.md).

### 7.6 Search, retrieval & the embedding pipeline

browser discovery and strict evidence retrieval share `services/search/` visible
sql families, scope predicates, embeddings and resource items. `discovery.py` owns
`GET /search/preview` and `/search`: bounded launcher bands, resource grouping and
an explicit passages view. `DiscoveryQuery` adds libraries, readings, dossiers and
saved passages to the six browser kinds. `service.py` retains strict `SearchQuery`,
six-kind evidence retrieval, frozen chat context and citation reopen; browse,
connection discovery, oracle and the target picker keep those contracts.

`sources.py` separates readable visibility from strict location admission. browser
ranking distinguishes meaningful names from prose, groups generated occurrences
by owner before limits, and enriches selected sources with one best child.
independent notes and saved occurrences remain independent. strict ranking and
locator guards remain intact. `presentation.py` hydrates the shared resource item
and bounded literal evidence without discarding readable unavailable locations;
`project.py` remains the strict evidence projection. resource activation carries
its complete target independently of the displayed excerpt.

at most one embedding precedes one read-only repeatable-read snapshot. browser semantic
windows are fixed at 200 chunks each for media and notes; selected-owner enrichment
reuses them. expected semantic/credential failure retains text matches with an
explicit incomplete-search status. browser cursors bind query, view and semantic
mode; a failed hybrid continuation is rejected rather than changing page order.
each page reads a fresh snapshot, so corpus changes and approximate membership
are not frozen. see [modules/search.md](modules/search.md) for ordering, scope,
paging and strict-consumer contracts.

`POST /resource-items/targets/search` remains the link picker's bounded, uniquely
quoted passage admission path, with durable anchor identity and ten-row pages.
there is no openables endpoint or separate browser locator schema. canonical
resource reopening and visibility belong to `services/resource_graph/resolve.py`.

- **Indexing** (`services/content_indexing.py`, `content_chunking.py`,
  `embeddings.py`, `note_indexing.py`): `fragment | page | transcript segment |
  note body → blocks → chunks → embeddings`. `content_chunking` is pure: blocks
  in, chunks of at most 420 tokens with their locators and float32 embeddings
  out (64 per provider request). Every media owner (web article, epub, pdf,
  podcast episode or video through its transcript) is indexed by one job kind,
  `media_content_reindex_job`, under a monotonic `revision` in
  `content_index_states`: only `request_media_content_reindex` creates jobs, each
  for a fresh revision, and a job publishes only while its revision is current
  and it holds its claim, replacing the owner's spans, chunks and embeddings in
  one transaction. A transcript replacement retracts the index at once
  (`retract_media_content_index`, which raises the revision). Note bodies are
  rebuilt by `note_reindex_job`, which embeds with no transaction open and
  publishes only if the body is unchanged. `embeddings.py` owns the embedding
  identity (`EMBEDDING_PROVIDER`, `embedding_model()`, `EMBEDDING_DIMENSIONS`)
  every reader filters on; readers trust rows only while the owner's state is
  `ready` on that identity.
- **Retrieval** is hybrid — and hybrid is an _invariant_, not a per-request toggle:
  a vector ANN arm (cosine over pgvector, joined on the _active_ embedding config)
  **UNION** a lexical FTS arm, reranked by a weighted score (lexical hit + semantic
  similarity + recency), filtered by a similarity floor, and projected with typed
  retrieval locators. There is no `semantic` flag; the query embedding is built once
  for any semantic-capable kind regardless of structured filters. For chat, candidates are
  selected under a context-char budget; candidate/rerank/selection is a transient in-memory
  pass and `message_retrievals` is the sole durable per-result record. Selected rows become
  `message_retrievals` telemetry rows via the single validated writer
  `services/chat/retrievals.insert_retrieval` (the cited ones link back to their
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
  hand-maintained frontend projection must agree on the same capabilities.

### 7.7 Citations & the agent tool contract

Chat publishes one frozen six-tool read plan, with five additive writes only
after fresh per-run consent:

- **`web.search`** — bounded Brave public-web search; numbered and citable.
- **`nexus.search`** — scoped retrieval over the user's Nexus corpus; numbered
  and citable.
- **`nexus.resource.read`** — exact bounded text and immutable evidence for an
  admitted resource.
- **`nexus.document.search`** — bounded matching sections inside one admitted
  readable document.
- **`nexus.resource.inspect`** — an ordered document map and canonical read
  URIs; navigation only.
- **`nexus.relations.list`** — bounded one-hop graph relations from one admitted
  resource.
- **`nexus.library.add`**, **`nexus.note.create`**,
  **`nexus.highlight.create`**, **`nexus.edge.create`**, and
  **`nexus.queue.add`** — the five additive, owner-gated Write operations. They
  persist their exact effects with the tool result and support scoped Undo.

Dossier model turns, Idea ones included, carry no model tools: Idea research
calls the web search provider directly from the build, before the model turn.
Other background operations retain their direct evidence algorithms and publish
`NoModelTools`; none inherit Chat authority. Both transports hand every call to
the one dispatcher, `services/tools/run.run_tool`; the tool contract, plans,
domain handlers and the one `tool_calls` row per call are owned by
`services/tools/` ([model-tools](modules/model-tools.md)).

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

`CAPABILITIES` (`services/resource_items/capabilities.py`) is the backend authority for Inspector eligibility,
linked-items policy, Forks, and default surface order; the committed TypeScript
projection must agree with the backend. Every eligible resource implies Dossier.
`useResourceInspector` composes one stable publication and inspector action per
pane from route-owned Contents, Connections, Context, and Forks bodies plus the
shared Dossier body. Selecting that action validates the requested surface
against its route-owned publication and, when attached to the workspace host,
synchronously reasserts the same publication before requesting its surface, so
publication cleanup and command acceptance cannot race or silently discard a
valid first click.

The backend (`services/dossier/`) separates its owners:

- `subjects.py` is the one eight-entry binding table: prompt phrase, operation,
  the subject's visibility predicate (one sql string serving the single check
  and the batch `CASE` of `head_visible_sql`), input collector, media
  intelligence ensure, shared library audience, and route handle;
- `inputs.py` collects each subject purely, so a build and a head's freshness
  check call the same function; `research.py` gathers the Idea's sources;
- `document.py` accepts the model article against the closed grammar and
  compiles citations; `synthesis.py` runs the one model turn;
- `engine.py` owns heads, builds and every status transition (compare-and-set
  out of `active`), publish, purge and the head read; `run.py` is one worker
  attempt.

A revision's `coverage` (`unit`, `included`, `omitted`) is the coverage line;
its stored fingerprint against the live collection is `stale`. Head reads
never generate or mutate a dossier. Idea subject routes remain unavailable.
Failure facts reach the browser as a code; the diagnostic detail stays in the
database. Build identifiers are UUIDs, authorized through the owning head.

Resource bootstrap/Inspector lookup uses
`GET /artifacts/dossiers/{subject_scheme}/{subject_handle}`,
`POST /artifacts/dossiers/{subject_scheme}/{subject_handle}/builds`; an
existing head regenerates only through
`POST /artifacts/{artifact_ref}/builds`. `GET /artifacts/{artifact_ref}` is the
canonical authorized head read. Selection Learn uses
`POST /artifacts/dossiers/learn`, resolves an internal Idea, records the
Highlight as a seed, and adopts the standalone Artifact pane. The remaining
API is `POST /artifact-builds/{artifact_build_id}/cancel`. Build streaming is
`GET /stream/artifact-builds/{artifact_build_id}/events`, a snapshot stream:
`state` frames carry the build's `DossierBuildOut` whenever it changes and
`done` closes it once the build is no longer active. `lib/dossiers/dossierApi.ts`
is the one browser Dossier transport boundary over generated wire types
(typed-wire); Cancel is an exact 204. The browser renders a revision into an
open shadow root of the app document under the app's nonce csp, after
re-proving the grammar on the exact nodes it adopts (`DossierDocument`), with
one delegated click listener for citations. Media Intelligence reaches the web
only inside the Dossier read model as `media_abstract`; the Media Dossier
renders it as a compact Abstract and offers the same claims as generation
input.

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

- `media_source_ingest.py`: accepted source-attempt state machine for generic
  web URLs, X/Twitter URLs, YouTube URLs, remote PDF/EPUB URLs, uploaded
  PDF/EPUB files, and browser article/file captures. Its detached acquisition
  phase is one `_run_source_adapter` dispatch over an immutable run value;
  `_SourceAuthorshipPhase` owns fenced contributor observation and lets
  unexpected contributor or database defects remain worker defects;
  `_SourceTerminalPublication` owns the final fenced Media/attempt/index/embed
  mutation; `_run_claimed_source_attempt` composes supersession, failure,
  authorship, terminal, and post-success phases rather than embedding provider
  dispatch, contributor-failure fallback, or terminal mutation bodies.
- `web_article.py`: generic web URL acquisition (python egress, then the node
  readability filter) and the one article publisher for fetched pages, browser
  captures and emails.
- `x_identity.py`, `x_client.py`, `x_rendering.py`, `x_ingest.py`: official-API
  X/Twitter same-author thread capture. Identity comes from provider author ID
  plus conversation ID; quote posts are separate `post:<post_id>` media; provider
  billing/auth/rate-limit/timeout failures become their `E_X_*` API error in the
  client, with an `x_provider_failure` warning log. There is no scraping,
  oEmbed, or generic article fallback for X URLs.
- `youtube_identity.py`, `youtube.py`: YouTube URL identity and placeholder title;
  playable metadata materialization for queued source attempts using the YouTube
  Data API, and caption fetching. Add never initializes or fetches a transcript.
  The explicit canonical Transcribe command composes
  `youtube.fetch_youtube_transcript`; caption acquisition may require
  `YOUTUBE_TRANSCRIPT_PROXY_URL` from datacenter hosts.
- `remote_file.py`: PDF/EPUB URL classification, bounded download through the
  egress into storage, byte-size accounting, and signature validation for queued
  source attempts.
- `net/safe_fetch.py`, `net/http_retry.py`, `url_normalize.py`: the one pinned
  untrusted egress, trusted provider json with bounded retry, and the public-URL
  policy and address predicate.
- `epub_assets.py`: private EPUB resource asset authorization and byte-size
  checked reads.
- `api/routes/playback.py`: the player read (`GET /media/{id}/player`), the
  epoch-fenced listening write, the preview hand-off and activity capture;
  listening DML is owned by `services/consumption/listening.py` (§8.8).
- `media_file_access.py`: signed original-file download URLs.
- `media_processing_state.py`: in-process queued, extraction-start, readiness,
  failure, and warning transitions. Source retry policy remains singular in
  `source_attempts.py` ([the ingest owner](modules/ingest.md)).
- `source_publication.py`: the run's fence and the terminal source-attempt
  transaction across attempt, Media, transcript and Podcast job;
  `media_processing_state.mark_media_failed_by_id` is its Media failure-field
  writer.

**Entity & state machine:** `media.processing_status` runs
`pending → extracting → ready_for_reading` or `failed`. Search/embedding
readiness lives on the separate `content_index_states` machine.
A failure moves as one (status, `last_error_code`, `last_error_message`); a code on
a readable media is a soft warning (`mark_stage_warning`). Source retryability is
derived from the latest `media_source_attempts` row. Metadata research has its own
retained job/outcome projection and never changes that triple.

**Capture entry points**: `POST /media/from-url` with source recovery
(`api/routes/media_sources.py`), `POST /media/uploads` (`api/routes/media_uploads.py`)
plus session-scoped confirm/delete, and, behind the extension bearer,
`POST /extension/captures` with its session-scoped `confirm`/`DELETE` routes
(`api/routes/extension_captures.py`, owned by the same upload-session service).
A create carries the client's session id; resending it is the retry.
Routes are transport adapters; they call exactly one service owner. (The media routers are split per capability:
`media.py` catalog, `media_sources.py` and `media_uploads.py` ingest, `media_assets.py` image/EPUB-asset
serving, `reader.py` reader read-model, `playback.py`, and
`podcast_transcripts.py` — each importing only the services it delegates to.)
Ingest `library_ids` are writable non-default destinations; media services
validate them through library governance and assign default plus selected
destinations through `library_entries`.

An upload session is durable intent, not media: signed url expiry never
deletes it, and media/source attempt/exact queue job publish atomically only
after byte verification of the current generation. Every confirm is idempotent:
one locked read of the session row owns the already-published decision, so a
resend that queues behind the winning publication returns the same `Published`
rather than a conflict (`docs/modules/ingest.md`). Url acceptance carries a
client-minted attempt id and returns `media_id`, `source_attempt_id`, `created` and
`processing_status`. Provider,
network, sanitization, extraction, and post-acceptance storage failures update
the existing media row and latest source attempt; the user retries by creating a
new source attempt through `POST /media/{id}/retry`.

**Imports workspace:** the `/imports` pane is the one reader-facing view of
this pipeline. `services/imports.py` classifies every upload session and every
media with a source attempt into `Active | NeedsAttention | Complete` in one
query, so counts and membership cannot disagree; names the obligation that speaks
for each (`primary`); answers `GET /imports{,/summary,/{ref},/{ref}/history}`; and
takes each row's recovery offer from the media projection (`media_facts`), so a
row offers what the action menu shows. A published upload keeps its
`upload:<session id>` identity for life, so one import is one row from acceptance to
History. its stationary query controls keep the committed query and applied
constraints visible; a failed later page retains loaded rows, marks the loaded
count as failed, and offers one retry of that cursor. See
[the imports read owner](modules/imports.md).

**Recovery/deletion:** every source acceptance commits its job in the same
transaction, so nothing reconciles: a dead job is the repair offer and a failed
source the retry offer (`modules/ingest.md`). Upload-session expiry is
projected as a user repair obligation; explicit removal owns its cleanup.
`media_events` streams live status. `services/media_deletion.py` is explicit and
reference-counted; storage deletion happens only after the DB commit.

### 8.2 Reader

The reader renders EPUB/PDF/web-article/transcript content with **stable,
reflow-independent locators** so highlights, quotes, and citations anchor to exact
text. This is a linchpin area with its own design contract — read
[`modules/reader-implementation.md`](modules/reader-implementation.md) and
[`modules/reader-design-rationale.md`](modules/reader-design-rationale.md).

One primitive, `lib/documentReader`, reads for three hosts: the hosted media
pane, the public `/s` reader and the Android shelf. Its runtime loads the
publication (`GET /media/{id}/reader`, one snapshot) and the cursor together,
restores once, owns reading/exploring mode and the cursor sync; the text and
PDF surfaces render, measure and position. Hosts supply ports: a source, a
progress port (the hosted pane's revisioned online cursor, the shelf's device
store, none on `/s`), decorations and a host for mobile chrome. The primitive
does not import workspace, auth, API client or Next route owners.

An offline reading copy (`services/reading_copy.py`) is the hosted reader's
own payloads (`navigation`, `fragments` or EPUB fragments, serialized as their
routes serialize them) read in one repeatable-read snapshot, zipped with the
PDF bytes or EPUB assets, and stamped with its publication generation. Web
article images become text placeholders. It contains no credentials,
highlights, notes or AI state. See [offline](modules/offline.md).

The core idea is two coordinate systems, both **codepoint-based**:

- **Reflowable formats** (web/transcript/EPUB): a position is
  `(fragment_id, offset)` where `offset` is a Unicode codepoint index into that
  fragment's `canonical_text`. `canonical_text` is produced by a browser-equivalent
  HTML5 parse (`services/canonicalize.py`) and is **stable for the current
  artifact after `ready_for_reading`**, so the frontend DOM-text walk
  (`lib/canonicalText/domTextCursor.ts`) yields identical offsets regardless of
  typography. The frontend canonicalizer must byte-match the Python one; a unit
  whose rendered text differs from its `canonical_text` disables selection and
  paint for that unit.
- **PDF**: a locator is `(page_number, geometry quads)` plus a match into
  `media.plain_text` via `pdf_page_text_spans`. Highlight geometry is canonical
  page-space quads; duplicate detection uses the current anchor rows and PDF writes
  serialize on advisory locks (`services/pdf_highlight_geometry.py`).

EPUB ingestion (`services/epub_ingest.py`) produces ordered unique fragments and
exact `EpubNavLocation` targets. A named EPUB target resolves to its element
start in that fragment's canonical text; a missing named anchor rejects the
navigation source. `api/routes/reader.py` serves fragments separately from
sections: fragments own document length and sections own targets. Resume stores
reflow-safe canonical offsets (web/transcript/EPUB) or page/normalized
page-space position (PDF), never pixels.

The attached surface measures one viewport per scroll frame for the current
publication identity (a point at the reading line and the visible band as
`0..1` document fractions); backend marker owners publish their normalized
start positions. The cursor sync, Consumption activity and the desktop
document-map rail consume this same viewport. Only a viewport within a second of
genuine input is reading: restore, jumps, reflow and find can move the rail but
cannot create reader progress or activity.

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
text-layer match) — a first-class geometry-only state that Evidence
renders with an explicit placeholder. The current highlight
contract lives in [`modules/highlight.md`](modules/highlight.md). A highlight's
note is created and attached by `PUT /highlights/{id}/note {note_id, body_pm_json}`
(idempotent by the client's note id) and edited like any note
([`modules/notes.md`](modules/notes.md)).

The hosted pane reads every visible highlight once, through the document map,
and paints them as css custom highlights over the untouched dom (PDF: overlay
rects); a write paints from its acknowledgement until a later map read settles
it. See [`modules/reader-implementation.md`](modules/reader-implementation.md).

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
  remain `partial`, and unsupported scholarly/literary PDFs emit empty apparatus
  rather than inferring from raw layout text. Replacement preserves proven
  occurrence identities and rejects ambiguous changes to referenced items.

**Frontend** (`lib/documentReader/*`, `lib/canonicalText/*`, `HtmlRenderer.tsx`,
`lib/reader/*`, `app/(authenticated)/media/[id]/*`): `HtmlRenderer` is the only
`dangerouslySetInnerHTML` site. It renders already-sanitized HTML and applies
the bounded media `h1`-to-`h2` projection beneath the resource heading; the
reader never rewrites that dom for decorations. Media publishes one
shared **Resource Inspector** whose tabs are `Contents` when
available, `Connections`, and `Dossier`. Contents and Connections retain their
internal **Document Map** semantics:
connections is a target-centered aggregate of highlights, source references,
generated citations, links, and librarian links, separated into passage and
  whole-document scopes with typed one-hop associations. the evidence pane
  follows the reading position and owns complete note content; *all items*
  retains the full inventory. the narrow desktop rail shows aggregate marker
  positions and navigates only on explicit activation. the shared inspector
  action opens the
same `resource-inspector` publication on desktop and in the workspace mobile
sheet.
The contract is
[`reader-evidence-scope-associations-hard-cutover.md`](cutovers/reader-evidence-scope-associations-hard-cutover.md).

### 8.3 Chat & conversations

The AI chat: durable, branchable, streamed, RAG-grounded. Backend: the
`services/chat/` package (admit, context, quotes, citations, retrievals,
tool_calls, events, worker, reads, conversations) behind `api/routes/chat.py`.

- **Conversation = message tree.** Each "send" creates a user message plus a
  _pending assistant_ message; replying under an existing assistant forks a
  **branch**. `conversations.active_leaf_message_id` stores the owner's
  selected leaf (admission moves it to the new answer); history assembly only includes messages on the current path, so sibling branches
  never leak into context.
- **One send = one client-named run.** HTTP never calls the provider.
  `POST /chat-runs` serializes by its uuid `Idempotency-Key`, which becomes the
  run's id: the run that key names answers a resend, else the admission commits.
  Accepted chat/messages/run/job are atomic; a modeled rejection commits nothing
  (a resend decides again). The small Accepted receipt names conversation, run,
  and assistant IDs; the browser keeps the exact command in its draft until a
  receipt or a definite rejection, then reads `GET /chat-runs/{id}`. The **worker** executes accepted work: assemble
  context → run the exact frozen Codex/API selection and
  tool plan → append route-neutral events → finalize. The client merely
  tails `chat_run_events` over SSE and reconciles through bounded repeatable-read
  `GET /chat-runs/{id}` snapshots.
- **Context assembly** (`services/chat/context.py`): the instructions are the
  fixed system prompt; the input carries the turn's context (quote subject and
  `<reader_selection>`, a fork's selected answer text, the chat's numbered
  `<resources>`), then the active path's history newest first and contiguous
  within the token budget and chat's 512 KiB input bound, then the turn. The run
  stores only the frozen generation intent (`chat_runs.generation_intent`): no
  budget counts, inclusion manifests, prompt hashes or remote cache key.
- **No crash replay**: a chat job attempt that finds its run's generation
  already started fails the run `interrupted` (or `cancelled` when a stop was
  asked) and never reruns it; a dead chat job ends its run the same way. Code
  defects escape to queue retry. Publication is the final effect, taken under the
  run lock and the job claim.
- **Connection is not execution**: SSE only tails committed events. Unsequenced
  execution advisories (`Queued | Running | Recovering | Suspended`) report queue
  liveness without advancing the event cursor or starting work.
- **Selection is exact per run**: Chat sends one tagged route/model/reasoning
  selection from `GET /llm-catalog`, validated against the current catalog at
  admission, with `ReadOnly | AdditiveWrites` authority. The developer Codex seed initializes a
  new composer but is not a user default. There is no Fast/Balanced/Deep preset,
  preference, AI Settings control, or fallback. See [modules/llms.md](modules/llms.md).

Frontend: `components/chat/conversationStore.ts` holds one copy of the server
tree (`GET /conversations/{id}/tree`) and a live overlay per pending answer
(`lib/chat/runTail.ts`); every view — path, fork strips, the Forks outline, the
send target — is derived by `lib/chat/tree.ts`; `lib/chat/drafts.ts` keeps one
durable send per draft. Citations render `[N]` → `ReaderCitation` chips that
push a reader target (`lib/resourceGraph/*`). See [modules/chat.md](modules/chat.md).

### 8.4 Oracle

An agentic "reading" feature over one current curated **public-domain literary
corpus**, which is a real Nexus library (`system_key = 'oracle_corpus'`) of
ordinary indexed media — not an Oracle-owned text/vector store.
`services/oracle/` owns it ([modules/oracle.md](modules/oracle.md)): `corpus.py`
(the corpus file, seeding, lazy anchor resolution, passage ranking, plates),
`synthesis.py` (the llm contract and every reading rule) and `readings.py` (create,
read, concordance, the generation job). One active-model query embedding feeds two
lanes: the corpus's resolved anchors scored by `search/semantic.nearest_chunks`
(cited `oracle_passage_anchor:<id>`, quoting the curated passage) and the viewer's
visible media and notes with the corpus excluded in SQL (cited
`evidence_span`/`content_chunk`). Fewer than three rankable corpus passages fails
typed `E_ORACLE_CORPUS_NOT_READY`. The LLM emits only candidate indices + prose;
output that leaks a passage fails `invalid_output`. One transaction publishes the
reading; a status-snapshot SSE follows it. Plates are static web assets.

### 8.5 Libraries, sharing & the default library's virtual read surface

Content organization + access control, split into four owned modules:
`services/libraries.py` (the `libraries` table and the viewer's authority over
one: `access()` returns the row plus the viewer's role, the one capability rule;
create, rename, delete, the index, writable destinations),
`services/library_entries.py` (the **sole writer** of `library_entries`: the
`EntryTarget` media|podcast union, the locked append, the move command, filing,
unfiling and show placement), `services/library_listing.py` (the entry view
lenses and the one page statement; no DML), and `services/library_members.py` (the
  `memberships` and `library_invitations` tables; users and invitations are plain uuids). Visibility itself is enforced by the boolean
  predicates in `auth/permissions.py`; the search/object readers read
  `library_entries` under an explicit Tier-R allowlist. Library list hydration is
  private and total: the repeatable-read membership query filters visibility,
  and every admitted Media or Podcast row must produce exactly one response item.

- Every user has one **default library** (special: can't be renamed/deleted/shared
  or receive physical Podcast entries) plus shareable libraries with `memberships`
  (`admin`/`member` roles; owner is a distinct concept layered on admin).
  `library_entries` point at exactly one media or podcast and carry an integer
  `position` (a per-library `UNIQUE (library_id, position) DEFERRABLE` DB
  invariant since migration `0131`, with cleanup explicit in app code).
  mutable named libraries also carry a sequence-backed `order_revision`;
  strict moves compare it under the library lock and return committed visible
  ids plus revision. unfiltered custom-order pages bind it into their cursors;
  a rejected revision discards the incomplete browser walk. `/order` supplies
  a complete repeatable-read recovery snapshot without metadata pagination.
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
  `GET /libraries/destinations`; default libraries, member-only
  libraries, duplicate IDs, and inaccessible IDs are not valid write
  destinations.
- **The default library's read surface is a live, deduplicated personal
  "All" query**, not a materialized or backfilled set. It is the union of the
  distinct Media reachable through the viewer's _current_ non-system
  memberships and the viewer's active Podcast subscriptions, followed by one
  root-subsumption step: an active subscription contributes its virtual Podcast
  root and suppresses every child episode Media row from All. Subsumption runs
  before projection, exact-type filtering, ordering, pagination, and count.
  Child `library_entries` remain physical facts, so live sync and historical
  backfill do not change the subscribed show's All root cardinality; when the
  subscription is deleted, retained episodes immediately resurface with their
  consumption state intact. Outside Default/All, named-Library parent/child
  placement rules are unchanged. Media is otherwise deduplicated by `media_id`
  — a direct default entry wins the tie, else the earliest entry. Losing a
  membership removes that Library's Media contribution on the next read;
  deleting a subscription removes its virtual Podcast row.
  Default Podcast rows expose absent placement rather than a fabricated entry
  ID or position. Filing media into the default library directly — the one
  actor-authorized filing command in
  `library_entries.ensure_media_in_library_in_current_transaction`
  — always inserts (or idempotently keeps) a physical `library_entries` row
  there; a work already visible virtually through another membership can
  still be explicitly filed, and that direct entry is what a later
  membership loss cannot take away. The browser presents the Default library
  as **All** ("Across your libraries") on the closed alias boundary — library
  row, pane title/label, resource-target results, Dossier and Atlas labels —
  while the domain object, storage row, and API fields keep their internal
  Default identity; `All` is a reserved library name (`400 E_NAME_INVALID` on
  any non-default create/rename). Entries page as a keyset list (§8.12) whose
  cursor binds viewer, Library and view. Canonical order is
  the durable authored order for named Libraries and
  `(addedAt DESC, targetKind ASC, targetId DESC)` for Default. A `view` is the
  order plus a fixed entry projection: `All items (all)` includes Podcast
  shows, while `All items (unfinished)`, `Unfiled` (Default only — direct
  Default media with no other current, non-system placement), or
  `In Progress` (canonical consumption `read_state = 'InProgress'`; podcast
  show rows never match, and the completion filter is unrepresentable with
  it). Factual view lenses (Title/Creator/Published/Added/Remaining, each ascending or
  descending), projections, and the hide-finished completion filter are
  URL-only: they are never persisted and never write
  `library_entries.position`. In the browser every placement and consumption
  writer publishes its change topic after the write (§8.12), and the Library
  pane rereads its view when a topic it follows moves.
- **reading duration has one shared read owner.** `services/reading_time.py`
  composes stored integer counts from `media_document_metrics.py`, document
  quote-readiness from `capabilities.py`, and current-position facts from
  `consumption/reader_cursor.py`. quotable positive-count web/epub/pdf documents
  receive total seconds at 240 words/minute. no/empty cursor means full remaining
  duration; positioned web/epub uses current whole-document progression;
  positioned pdf or unknown progression means unknown remainder. percentage
  follows current position; persisted completion remains separate. one projection serves
  library ordering and suggestion eligibility; display alone uses coarse rounding
  and retains exact zero. `schemas/reading_time.py` owns the generated wire
  shape; collection formatting consumes its numbers directly. requests never scan document text.
- **remaining-time order belongs to library listing.** `sort=remaining` orders
  raw `float8` seconds before pagination, unknowns last in either direction,
  then title and target identity; its finite `FloatOrNull` cursor key keeps the
  view binding of §8.12. filters and authored positions retain their owners.
- **suggestions is the one relevance owner.** `services/suggestions.py` composes
  policy-neutral read ports from consumption, libraries, the resource graph,
  contributors and the semantic index. it owns quick reads, lectern and library
  suggestions; fact owners retain their tables and mutations. library entry
  ordering belongs to `library_listing`. `suggestion_shortlists.py` publishes
  ranked pools on the existing fenced background lane. get and independent
  `/view` hydrate at most 80 currently eligible refs without ranking; the pane
  displays ten in retained order and refills locally after an acknowledged add.
  active observation admits coalesced work; later publications stage until request
  or revisit. see [suggestions](modules/suggestions.md). payloads carry target, factual publication date,
  consumption and shared reading estimate; relation reasons remain internal.
  inline related discovery and `/media/{id}/related` are retired; the resource
  graph and opened-resource connections remain.
- **Library Dossier** is the Library binding of Universal Dossiers, not a
  Library-owned subsystem. The Library pane publishes Entries in primary
  content and capability-gated `Members | Connections | Dossier` in the shared
  Resource Inspector; Members is present only for mutable Libraries the viewer
  can administer, and Dossier remains default. Its audience is the Library
  membership scope; direct entries and expanded Podcast episodes are
  intersected with audience-visible Media (the library owner's), and freshness
  compares the stored input fingerprint with the same collection run live.

### 8.6 Contributors

One canonical person per author, attached to works by ordered, role-typed
credits, across four python owners (`docs/modules/contributors.md`):
`contributor_taxonomy.py` (pure values: role vocabulary, name keys, handle
grammar and generation, observation values, `build_observation`),
`contributor_writes.py` (the read-only identity planner, person creation,
aliases and role-slice replacement; never commits), `contributor_credits.py` (the sql
fragments and batch loaders other modules compose), and `contributors.py`
(the facade: search, detail, works, refs, and every write entry point — batch,
in-transaction, prepare/apply, cleanup and the media-author PUT; it owns
sessions and retries).
Every `contributors` row is active — there is no self-FK, status, merge, split,
rename or delete. `contributor_aliases` (searchable names; `resolves_identity`
marks the display alias that binds a future observation) and
`contributor_external_ids` (email address / X user / YouTube channel, globally
unique per authority) support identity; `contributor_credits` attaches a person
to exactly one media/podcast/Gutenberg-ebook role slice.
Identity selection is bound handle → existing exact key → earliest-created
owner of a resolving alias, unless that owner holds a different key of the same
authority (then a new, distinct person) → new person. It runs inline inside the
publishing transaction (batch publication opens a fresh SERIALIZABLE-retried
session per 200 targets; source ingest, podcast identity and metadata research
publish on their own transaction), so there is no dedupe job, proposal table,
or merge contract. A credit change moves rows across open author-works
continuations under the keyset guarantee (§8.12); the tab that made it rereads.
Visibility predicates (`visible_podcast_ids_cte_sql`,
`visible_content_credit_rows_sql`, `visible_contributor_ids_cte_sql`) live
solely in `auth/permissions.py`. An orphaned person is already invisible under those
predicates, so nothing prunes contributor rows. There is no `/authors`
directory or root Authors pane; author search lives in desktop Nexus at
`/search?kinds=people`, and credit links open the `/authors/{handle}` pane
(works list).

### 8.7 Notes and pages

Pages and notes are resources, not documents or trees. A `page` owns its title, a
`note_block` one ProseMirror block; an outline is a page's or note's neutral user links
(`origin = 'user'`, undirected) in that endpoint's own rank order, so a note can sit in
many outlines and a row is a link, not containment. `services/outline.py` reads
outlines and applies the idempotent outline commands (insert, move, relink, remove, body
and title writes, ensure-daily) in one SERIALIZABLE transaction; a removed note with no
other place (link, annotation, link note, citation) is deleted. `services/notes.py` owns
pages, the keyset index, the daily page (latent until its first write, its id derived
from the date) and quick capture; `services/note_bodies.py` the note row, its text
projection and reindexing. Note prose has no inline resource references; whole-block
`object_embed` nodes keep `origin='note_body'` facts; highlight and link notes are
ordinary notes on `highlight_note` / `link_note` edges.

The web writes online only (owner decision): `lib/notes/texts.ts` holds unsaved text in
memory and saves 1.5 s after typing stops or at once when the tab hides;
`lib/notes/writes.ts` sends one request at a time and retries transport failures; one
`useOutline` session per pane applies structure edits optimistically and keeps one undo
history over text and structure. `PagePaneBody` (pages and days) and `NotePaneBody`
render `OutlineEditor`; `NoteEditor` is the one prose editor. Contracts and invariants:
[`modules/notes.md`](modules/notes.md).

### 8.8 Lectern & podcast playback

`services/browse/*` owns Podcast Index discovery and read-only Preview.
`services/podcasts/*` owns Subscribe/unsubscribe, canonical Podcast and
episode identity, live feed sync, the independent historical backfill, and
explicit Transcribe after acquisition. A subscription exists exactly while its
row exists. Named Podcast placement is only `library_entries(podcast_id)`;
Default/All projects active subscriptions virtually as one Podcast root and
hides their retained child episode roots. Episode acquisition and sync still
write physical Media placement; root hiding is a read predicate, not deletion.
Unsubscribe removes the virtual parent predicate, so retained episodes resurface
with their existing consumption state.

Subscribe enqueues one live sync and one `podcast_subscription_backfills` chain.
The live path keeps current episodes fresh while the backfill walks history in
fenced, retryable steps, and either path may continue when the other fails.
Both paths ingest metadata, stable aliases, chapters, playback URLs, and RSS
transcript references only. They never fetch or publish a transcript. Explicit
Episode Transcribe publishes the publisher sidecar when it yields segments, else
generates with Deepgram; explicit Video Transcribe uses the YouTube caption
provider. Current transcript origin is exactly `Publisher | Imported | Generated`.
`services/podcasts/transcription.py::request_media_transcript_for_viewer` owns
authorization, one locked media snapshot, and strict media-kind dispatch only.
`_admit_episode_transcript` owns the Episode precedence: a readable transcript
answers with semantic repair; inflight work (transcript `queued | running` or job
`pending | running`) answers and writes nothing; otherwise admission materializes
transcript state, resets the job, marks the transcript `queued`, and creates one
durable transcript source attempt. The media row lock keeps at most one queued job
per Episode.
`reset_podcast_transcription_job` is the one writer that puts the Episode's job
row back to `pending`. Explicit admission and durable source requeue (retry,
refresh, system repair) both call it while holding a conflicting media lock; no
caller carries a second job upsert. A requeue never touches the current
projection: existing segments, fragments, and readable transcript state remain
authoritative until `transcripts/current.py` atomically installs their
replacement.
The batch forecast counts and fingerprints the eligible selection as a pure
read. A fingerprinted episode query is one atomic admission transaction: Media
rows lock in deterministic selection order, and a stale selection or enqueue
defect rolls back every episode's state, source attempt and queue job.
`media_source_ingest.enqueue_podcast_episode_transcript_source_attempt` binds
the accepted attempt to its durable job inside the transcript caller's current
transaction; it never commits or converts an enqueue defect into durable failed
state.
The worker, `run_podcast_transcription_now`, owns the sidecar-then-Deepgram
order for every run, requeues included: a present sidecar is fetched first and
its segments publish in one fenced phase; otherwise `_begin_generated_run` marks
the job and transcript running under the same fence before any Deepgram call.
`transcripts/request_reason.py` is the sole internal request-reason owner.
Validated API values and exact durable source/job values enter that type once;
missing, whitespace-altered, or unknown same-system discriminants defect rather
than becoming `episode_open` or `operator_requeue`. A transcript semantic job
persists only `media_id` and that request reason; request/user correlation is
not a worker input and is not copied into the durable payload.
Publisher and generated transcript success callbacks publish only source
artifacts plus their domain ledger. The common source terminal is the sole owner
of ready-state and semantic admission. The acquisition operation returns only
`PodcastTranscriptionCompleted`; every modeled failure raises its typed error,
so no nullable skipped/failed result fields or downstream variant guard exist.
Podcast source failure likewise has one terminal publication: the source owner
settles the attempt, while `podcasts/transcription_failure.py` atomically settles
Media, the transcription job, transcript state (`unavailable` for
`E_TRANSCRIPT_UNAVAILABLE`, else `failed_provider`). The failure owner
imports no provider adapter.
`services/transcripts/state.py` is the sole persistence owner for
`media_transcript_states`; `current.py` owns artifact publication and retracts the
media's content index in the same transaction. The transcript's index is the
media's index (`content_indexing`): re-requesting a readable transcript asks for a
new revision only when the index is missing, on another embedding model, or its
current job is dead (`request_stale_media_content_reindex`), never beside a live
job. Database enqueue defects propagate and roll back;
there is no transcript `enqueue_failed` runtime or persisted audit outcome.
Canonical YouTube Video caption import lives in `_import_youtube_captions`. It
crosses the provider boundary with no database transaction open, reauthorizes
before atomic `Imported` transcript publication.

The canonical Podcast detail pane observes those two independent owners through
one viewer-owned subscription-lifecycle snapshot stream. Transactional triggers
on the subscription and its current backfill notify only the subscription UUID;
the stream re-reads durable state and remains nonterminal until both owners are
`Complete | SourceLimited | Failed`. A serialized latest-state drain revalidates
detail and episodes without overlap when committed snapshots change, so reused
global episodes and later backfill pages converge without browser polling, a
manual Refresh, or a second ingest path.

The **Lectern** is the one ordered, mixed-media list of outstanding intentions
(podcast, video, reader, agent, and Nexus actions all address it); **Now
Playing** is one device-local audio session, not a second durable list.
`services/consumption/` is the sole backend consumption owner, split by table:
`lectern.py` (`consumption_queue_items` membership and order, and the Lectern
read), `state.py` (the DML of `consumption_overrides`, a `finished`/`unread`/none
register whose revision every write advances and never reuses,
`consumption_completion_facts`, and `reader_engagement_states` reader recency —
`last_engaged_at`; the finish, undo, unread, reset and natural-end writes),
`listening.py` (`podcast_listening_states` position/duration/nullable episode
rate under the `reset_epoch` fence), `reader_cursor.py`
(`reader_media_state` revisioned
`Empty`/`Positioned` cursor CAS), `activity.py`
(`consumption_activity_spans` ingest and `consumption_activity_exclusions`),
`stats.py` (read-time aggregation, sessionization and the Stats and Sessions
payloads), and `projection.py` (the one read-state ladder and batched
`PlayerDescriptor`s reusing `derive_playback_source`; the server owns
the resume point, so a finished episode's descriptor starts at 0). Consumption exposes
policy-neutral engagement and complete queue-membership reads to suggestions; it
does not own a second public Recent product. background suggestions ranking uses
Continuity, Arrival, and factual graph, author and calibrated semantic evidence.
`GET /lectern/suggestions` serves the latest successful pool outside complete
queue membership, excluding `Finished` targets. a full queue retains browsable
suggestions and separately disables fresh adds. `GET /lectern/quick-reads` returns at most five visible
unfinished documents with `0 < remaining_seconds < 600`, Lectern members
included, in progress first (most recently read), then newest added. Both perform no model
calls. every write runs under the viewer row lock. conditional
`PUT`/`DELETE /lectern/items/{media_id}` compare the captured order revision;
accepted membership intent advances it even when already satisfied. a null
placement ensures membership, `First`/`After` intentionally place it, and
`PUT /lectern/items/{media_id}/position` strictly reorders an existing visible
member. exact retries retain their original revision; no replay ledger or
automatic rebase exists. other state commands are
`POST /media/{id}/finish` (answering the token its undo echoes), `/finish/undo`,
`/unread`, `/progress/reset` and `/natural-end` (fenced on the override revision
and the terminal sample's reset epoch). The server names no next row: the
device that hears an end reads it from the Lectern
([`modules/player.md`](modules/player.md)). An absent value on every wire shape
is `null`, its key always present
([`local-rules/typed-wire.md`](local-rules/typed-wire.md)).

media teardown (see [`modules/storage.md`](modules/storage.md)) locks affected
lectern viewers before media, then calls lectern-owned queue cleanup/densification/
revision advancement and `state.delete_media_consumption_state_in_txn` for
override/listening/reader-cursor/reader-engagement/activity/completion rows.
an unseen read-committed insert's exact queue foreign-key conflict restarts the
whole serializable attempt, reloading the viewer set; no late viewer lock is
taken after media. `media_deletion.py` never writes those tables directly.

frontend: `AuthenticatedShell` mounts `LibraryOrderProvider` (library moves)
above `LecternProvider` (`lib/lectern/lectern.tsx`: the one lectern read, the
tab's one write lane for ensure/remove/place and moves, pending intents and
revision-gated receipts; the read-state writes are `lib/consumption/state.tsx`) and
`GlobalPlayerProvider` (`lib/player/playerRuntime.tsx`), which wraps
`WorkspaceHost` and `GlobalPlayerSurfaces`. The latter projects one shell-owned
**Media player** landmark as the desktop bar or the mobile mini bar and sheet;
it persists across pane navigation and is never an editor. The provider selects
exactly one engine: non-Android uses one browser-owned `<audio>` element with its
listening writer, Media Session and activity observer (`browserEngine.ts`); the
Android shell uses the service-owned Media3 player through `window.nexusPlayback`
(`nativeEngine.ts`) and mounts none of those browser owners. The provider
exposes stable Commands plus separate Session and Timeline contexts. A natural
end is one `POST /media/{id}/natural-end` sent by the engine that heard it; on
204 that engine plays the next audio row it read from the Lectern before
settling, from the position the server reports. See
[`modules/player.md`](modules/player.md) and
[`modules/consumption-activity.md`](modules/consumption-activity.md) for the
full file map. The shared player also owns an exhaustive ephemeral
`PreviewAudio` session: it starts at `1x` and has no Media ID, queue/history
origin, heartbeat, podcast preference, activity/completion writes, or
previous/next behavior. After Episode Add, the
consumption owner may install the observed Preview position once, only when
owned progress is still empty. `SuggestionsSection` delegates add to the existing
lectern or library owner; its suggestions hook owns adopted/staged pools,
current-fact reconciliation, active-only observation/admission and local refill.
rows survive refresh, errors and suspended work; successful empty and first
preparation remain visible. acknowledgement cannot reclaim focus moved elsewhere.
quick reads retain their separate direct read. the lectern
section order is queue, quick reads, then suggestions. quick reads have no
selection controls; each row's shared `LecternAddControl` (also in the
transcript) offers add/check/on-lectern; opening navigates without enqueueing
and addition retains the row. every user-facing add is the ensure write (a null
placement), which appends absent media without moving existing members. its
200 acknowledgement returns the new lectern order revision. the shared canonical
read and revision-gated membership receipts supply current facts; direct add
never fetches a resource menu.
`at_capacity` counts hidden rows too. an add without an answer keeps its
request above pane lifetime and offers "check add"; other edits remain
available. shared collection rows retain standard menus, factual dates and
reading estimates without relation explanations or inline expansion. known
stored media share title, author credits, original publication year,
unread/current percentage/finished, and plain remaining time at canonical 1×.
current cursor/listening position owns percentage and time; accepted progress
at ≥95% persists sticky completion. unread/reset fences older writes; genuine
accepted resumption clears unread. `MediaSummaryProvider` refreshes retained
facts in bounded account-scoped batches; query owners reconcile real topology
changes. unknown facts disappear and finished hides time. catalogue rows expose
stored author credits without invented viewer facts. the contract is in
[library](modules/library.md) (rows, estimates, refresh) and
[player](modules/player.md) (progress fences).

### 8.9 Consumption Activity & Stats

`services/consumption/` stores bounded observed spans, first post-cutover
completion facts, and exact-session exclusions that never rewrite observation
history. Observed spans are the sole positive-duration facts; no user command
creates time. The browser's tab-local recorder is fed by the reader,
the owned global audio element, and the visible embedded-video pane; it holds
closed spans in memory and delivers them in batches (a tab closed offline loses
what it held). Native Android listening uses its service-owned durable outbox.
Stable capture keys make regrouped delivery idempotent. The BFF stamps the
device from the httpOnly `nx_device` cookie; no client names it, and Stats shows
the viewer their own raw device ids.

`/stats` renders URL-owned factual time buckets, current visibility-scoped
breakdowns, derived observed sessions, active exclusions, and a deterministic
Year in Reading view. Exact session Exclude/Restore is the only correction
lifecycle. Accepted writes publish the Consumption change topic (§8.12); the
pane rereads on it only while active, on activation, and when the page returns
to the screen, without polling. Its figures are one `useServerValue` and its
sessions one `useServerList` (Load more) over the keyset sessions read. a
`null` cursor ends the list; no empty-string cursor stands in for it. stats'
full contract is
[`modules/consumption-activity.md`](modules/consumption-activity.md).

### 8.10 Search, Browse, desktop Nexus, and mobile Nexus

desktop and mobile nexus share the launcher controller and generated discovery
preview contract. commands and places, resources, saved passages and inside-source
matches have independent 4/4/2/2 budgets; one best match consumes its home slot.
explicit intent wins, then an exact canonical local label, then an exact meaningful
resource name. aliases and frecency cannot reorder server resources. canonical
refs use the existing resolver and bypass textual preview.

local actions paint immediately; direct preview waits 80 ms (zero for one
codepoint), then content preview waits another 160 ms after direct settles.
content success supersedes direct data/error; failure retains direct rows with
local retry. canonical resource identity merges open panes with search evidence
and pane-close menu actions. filtered/scoped searches require server admission.
late results preserve the active target; deliberate selection freezes its visible
prefix and group without consuming another section's capacity.

named resources open whole; matching passages have a separate menu action.
desktop enter follows a selected row, otherwise parsed intent or full search;
mobile keyboard submit follows intent/full search, leaving row activation explicit.
query actions never become automatic defaults. composition/repeat guards and
shift opening remain. the full-search pane defaults to resources, offers a
url-owned passages view, preserves criteria between views, and uses shared
resource bodies, metadata and outline controls. details belong to
[modules/search.md](modules/search.md).

mobile uses one opaque nexus full-screen task (`components/switchboard/`,
`lib/switchboard/`). its root paints synchronously from workspace state and fixed
place/quick projections. the controller computes only the active viewport's
projection and retains the last committed projection while hidden. accepted
selection history uses the existing write/retry contract. external discovery
remains in explicit acquisition workflows.

The task changes presentation only: the existing controller and pages remain
one replacement hierarchy with one page-owned header and content scroll owner.
After its first opening, the portal subtree stays mounted across dismissal so
controller, focus, and measurement lifecycles are not recreated on every use;
the inactive projection becomes `hidden` and `inert`, while children continue
to receive lifecycle updates before the next opening.
The mobile Nexus control also carries a primary-touch horizontal adjacent-tab
accelerator over visible panes in `state.panes` order, the store's clamped
traversal command; tap remains the task entrance and the gesture creates
no second navigation model.
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

Acquisition reuses canonical owners: URL Add calls `/media/from-url`, episode
Add calls `/podcast-episodes/from-discovery`, and Subscribe calls
`/podcasts/subscriptions`. URL Add mints one attempt `id` per press, so a resend
answers its own acceptance. Commands stage Default/All plus named destinations,
and replace Preview with the canonical owned pane only after success. browse
publishes a query focus capability; preview publishes none.

### 8.11 Collection refinement

Every primary collection pane composes the same visible grammar: input,
readable order, conditional filters disclosure, applied chips, and an honest
result status. shared query controls remain above the existing body scrollport;
inline native options own disclosure/focus, while domains own clear/reset and
request policy. the shell hosts independent query/navigation publications and
its `Pane.Search` focus command. each
domain owns a closed view type, URL codec, option inventory and labels, request
identity, server query, total order, cursor, and local match fields. this is
presentation composition, not a query engine: no row-metadata schema, runtime
registry, generic controller, Boolean AST, or client sorting of pageable rows.

| Surface | Local match fields | Canonical view | `Sort by` options | Execution |
| --- | --- | --- | --- | --- |
| Lectern | title; presented subtitle | Custom order | Custom order; newest/oldest added; title A–Z/Z–A | client over the complete snapshot |
| Author works | work title | Newest published | Newest/oldest published; title A–Z/Z–A | owner SQL before keyset |
| Chats | chat title | Newest update | Newest/oldest update; title A–Z/Z–A | owner SQL before keyset |
| Libraries | presented Library name | Oldest created | Oldest/newest created; name A–Z/Z–A | owner SQL before keyset |
| Notes index | Page title | Newest update | Newest/oldest update; title A–Z/Z–A | owner SQL over the complete result |
| Library entries | row title; contributor names | Recently added / Custom order | title/creator A–Z/Z–A; newest/oldest published or added; least/most time left | owner SQL before keyset |
| Podcast subscriptions | title; contributor names | Newest episode | Newest episode; most unplayed; title A–Z | owner SQL |
| Podcast episodes | title; contributor names | Newest released | Newest/oldest released; shortest/longest duration | owner SQL |
| Page/Note direct items | direct item text | Authored order | none | local inspection Filter |

browse and search use the shared query presentation while retaining their
remote query, facets, ranking and provider continuation. preview publishes no
query controls. page/note direct items use permanent local row filtering in
authored order. chat messages, TOCs, chapters,
transcripts, sources, citations, trust trails, fork trees, navigation, menus,
settings choices, destination pickers, and ranked slate/quick-read lists retain
semantic owner order. Connections, Downloads, Library members/invites,
choosers, overlays, Preview episodes and Stats tables are secondary lists and
out of scope.

The chain is:

```text
pane URL
  -> strict domain frontend codec (Invalid makes zero request)
  -> requested view + owner-built API query/cache identity
  -> BFF exact forwarding
  -> strict route parse + backend domain view
  -> authorized base relation
  -> domain filter -> order plan -> keyset -> limit+1
  -> useServerList: one view's rows, drained or Load more (§8.12)
  -> domain presenter + explicit local match fields
  -> visit-local Filter query -> CollectionView
```

The URL is requested state; the pane's list hook owns everything after it
(§8.12).

### 8.12 Lists

Every keyset list pages one way: the six collection families (chats,
libraries, library entries, author works, followed podcasts, podcast
episodes), library destinations, members and invitations, imports and import
history, and the chat read tool's completed messages.

- **One plan.** A list declares a total order of `SortKey`s ending in a unique
  key; `services/collection_keyset.keyset_page` derives the `ORDER BY`, the
  strict NULL-safe page predicate and the cursor from it, so the three cannot
  disagree. Each owner keeps its own plans: the sort vocabulary is domain
  language.
- **One cursor.** Unpadded base64url JSON `{after, binding}`: the last row's
  sort values and a sha256 over the list's binding, the plan and those values.
  The binding is `{list, viewer, …scope, …view}`: `Chats` (title search),
  `Libraries`, `LibraryEntries` (library, view), `AuthorWorks` (handle),
  `PodcastSubscriptions` (sort, filter, library), `PodcastEpisodes` (podcast,
  state, sort), `LibraryDestinations` (query), `LibraryMembers` (library),
  `LibraryInvitations` (library, status), `imports:{view}` (the normalized
  query), `imports:history` (import ref), `CompletedMessages` (resource uri).
  Decoding checks the digest, the arity and every value's kind; any failure is
  `400 E_INVALID_CURSOR`, never a reinterpretation. A cursor carries no
  revision, so a deploy that changes a plan or a binding answers each
  outstanding cursor 400 once.
- **One page contract** for the six families (`schemas/collection_page.py`):
  query `limit` (1..200, default 100), `cursor` and the list's own keys; an
  unknown or repeated key, a bad limit or an empty cursor is
  `400 E_INVALID_REQUEST`. The response is `{data: {items, nextCursor}}`.
  The other lists keep their envelopes (`page.nextCursor`, snake
  `next_cursor`).
- **The keyset guarantee.** Following cursors to the end returns every row
  whose sort values do not change during the walk exactly once, in plan
  order. A row inserted or moved after the cursor appears; one inserted or
  moved before it is missing until the next read from the first page; a
  deleted row disappears; a row moved forward across the cursor can come
  twice from the server and is shown once. The volatile orders are chats by
  update, podcasts by unplayed count and latest episode, the entries
  "remaining" order with the in-progress and unfinished projections, and the
  episode state filter. The tab's own writes always reread from page one.

The browser holds each list in `lib/api/useServerList.ts`. `key` names the
view; a new key loads its first page while the previous view's rows stay
shown (`current: false`), then swaps them at once and abandons the old
continuation. Rows are deduped by id, first wins. `refetch()` rereads the
loaded prefix (at least one page; a complete list to its end) in one commit,
queued behind the read in flight and shared by every call made meanwhile; a
change of `stale` under the same key calls it. `drain` loads to the end while
the pane is active and the document visible and stops at the first failure
until Retry; manual lists use `more()` (Load more, offered only while the
rows shown are the current view's). Rows are always kept: a
continuation that fails in transport or with a 5xx offers Retry, a rejected
cursor restarts the entire walk from page one, and only "cursor absent" licenses the
count header, the "Complete" filter status and reorder. A pane return paints
the visit's snapshot and rereads only if `stale` moved since it was read; a
server seed paints a first visit the same way.

In-tab change topics (`lib/api/changes.ts`) tell mounted lists that a
committed write in this tab changed server state. A writer publishes after
the write; an observing list puts the topics' stamp in its `stale` token.
Nothing crosses tabs, and no list rereads on focus (media summaries do,
through the media query revision some lists also follow).

| topic | publishers | observers |
| --- | --- | --- |
| `Libraries` | create, rename, delete library; accept invitation | libraries index; library pane (detail); placement overlay |
| `Entries` | placement add/remove; library delete; invitation accept; media delete; podcast subscribe, unsubscribe and episode add; upload, upload retry, URL add; entries reorder | library entries; placement overlay; quick reads; imports summary |
| `Consumption` | accepted listening heartbeat; native and offline engines; reader-state save; lectern commands; stats exclusions; episodes marked played | entries in consumption views; state-filtered episodes; quick reads; stats; media summaries |
| `Metadata` | metadata research that changed a title, contributors or first publication, seen by an open view or by the tab that admitted the run | media summaries (the media query revision); lectern |
| `Podcasts` | every podcast write in `lib/podcasts/api.ts` | followed podcasts; podcast detail and its episodes; author detail and works |
| `Chats` | chat delete; message send and delete | chats index |

Imports keeps its own window event (`Imports.Invalidated`, lib/imports/api.ts).
---

## 9. Frontend architecture

The web app (`apps/web`, Next.js 15 App Router) has one structural idea you must
internalize first:

**Routing is a client-side pane system, not Next.js `children`.** The
`(authenticated)` layout renders a fixed `AuthenticatedShell` and _ignores_
`children`. One optional catch-all `[[...path]]/page.tsx` exists only so Next
resolves every URL; the actual body is a `*PaneBody` component that the **pane
route table** (`lib/panes/paneRouteModel.ts`, with lazy bodies in
`lib/panes/paneRenderRegistry.tsx`) resolves and renders inside a pane; an
unknown path renders the unsupported pane. The URL is a _projection_ of the
active pane (mirrored through next's patched `history.replaceState`, so next's
router url follows), not the driver. New devs frequently look for a `page.tsx`
for behavior that lives in `*PaneBody.tsx`.

Authenticated entry is classified once by `loadWorkspaceBootstrap`: pathname
`/` is Resume and preserves the selected saved workspace exactly; every other
protected href is Navigate and uses the deep-link merge (`enterWorkspace`); bare
`/daily` is today in the account zone and a non-canonical path resumes. With no
usable saved session, Resume creates the one-pane Lectern empty state.
`/lectern` remains explicit Home. Shell global-access query intents are consumed
in a layout effect before the store's first state-to-URL projection, so they
open over Resume and never become panes.

- **Workspace shell** (`lib/workspace/*`, `components/workspace/*`): a tabbed,
  multi-pane canvas. Durable state (`WorkspaceState`: primary panes with
  visit-identified Back/Forward history, embedded inspectors, widths) lives in
  one external store (`useSyncExternalStore`) whose commands apply synchronously,
  and is persisted **per-user-per-device** to `workspace_sessions`; the api's
  pydantic model is the only validator. Current-tab return presentation is
  separate: the return memento keys scroll/eye-line/focus mementos and
  route-owned visit data by the exact `PaneVisit` UUID. `PaneShell` is the sole primary vertical scroll owner for
  ordinary routes; Reader, Chat transcripts, and Atlas retain distinct owners.
  Desktop keeps every primary pane host mounted. Mobile renders exactly the
  active primary pane through one stable host identity: switching panes replaces
  the route-scoped body while retaining the shell, scroll owner, and provider
  graph, rather than remounting the entire active-pane substrate. A route error
  is fenced by the route identity and clears before a different pane or route is
  rendered through that stable host.
  A pane is identified by a stable pane id; its resolved `routeKey` gates
  route-scoped labels and return data so stale cleanup cannot mutate a newer
  route instance. Pane chrome needs no key: a body publishes into the store
  its pane shell made for that mount, and withdraws by unmounting. The store separately owns a bounded page-lifetime recently-closed
  stack; it is not persisted.
  Routes resolve via one table (`paneRouteModel.ts`) bound to lazy React bodies
  (`paneRenderRegistry.tsx`). Bodies talk
  to the shell only through `paneRuntime.tsx` hooks (`usePaneRouter`, `usePaneParam`,
  `useSetPaneLabel`) and the `paneChrome.tsx` publication hooks
  (`usePaneChrome`, `usePaneCompanion`, `usePaneLayout`); `usePaneRuntime().isActive` exposes the
  host's pane-activity capability, which reader progress uses for
  adoption-versus-handoff arbitration. `MobileViewportProvider`
  (`lib/mobileShell/viewport.tsx`) resolves mobile bottom geometry in one
  ordered pass: the normal-flow MiniPlayer and persistent feedback rectangles
  place the fixed Nexus wrapper (`--mobile-nexus-bottom-offset`), the placed
  Nexus wrapper plus safe area and active mobile-overlay keyboard inset form the
  root content clearance (`--mobile-content-bottom-clearance`), and that
  protected band projects into an element-local clearance on each registered
  mobile pane content surface. The flow Player is never added to content
  clearance, so it is counted exactly once. Text entry keeps playback alive
  while hiding and unregistering the MiniPlayer.
  `MobileChromeProvider` (`lib/mobileShell/chrome.tsx`) writes reader collapse,
  `inert` and phase straight onto the registered top bar, the active contextual
  row and the inner Nexus control, without moving the Nexus wrapper. Every
  eligible resource pane publishes one
  `resource-inspector` secondary group through `useResourceInspector`: Media
  (`Contents | Connections | Dossier`), Conversation
  (`Context | Forks | Dossier`), Library
  (`Members | Connections | Dossier` when the viewer can administer it, else
  `Connections | Dossier`), and Podcast/Author/Page/Note
  (`Connections | Dossier`). One visible inspector action opens the same group
  on desktop and mobile; open state, active tab, width, and viewed Dossier
  revision are workspace-local. The Imports pane publishes the one other
  secondary group, `imports-inspector` (`Import details`), the same way, because
  its selection is a row rather than a resource; its selection lives in the pane
  URL (`selected=<ref>`).
  Every supported route declares a typed `Section`/`Resource` header contract.
  `PaneShell` combines that contract, the pane runtime label, and one
  primary-chrome publication into the pane's single route-level `<h1>`, and
  projects it into one 60px desktop or mobile identity track (mobile safe area
  additional). The label is the only title value: a publication carries typed
  section metadata or resource status plus structured credits, never a title.
  Actions/options are typed descriptors (`lib/ui/actionDescriptor.ts`) shared by
  the desktop More menu and companion button and mobile Options. PDF and EPUB
  publish canonical `ReaderNavigation` independently of the shared find query.
  identity, navigation and query stay above content scrolling; mobile find
  discloses alongside navigation. a pane-scoped error boundary contains chrome and body
  failures without replacing sibling panes or the workspace.
- **App navigation is a curated projection, not a feature directory.**
  `lib/navigation/destinations.ts` owns destination identity;
  `components/appnav/navModel.ts` independently owns the flat desktop rail, the
  footer utility link (Imports) and the Account pair; Nexus owns the mobile
  Places projection. Mobile global access is the bottom Nexus control
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
  quick reads, suggestions and Nexus ranking. See
  [`modules/app-navigation.md`](modules/app-navigation.md).
- **Entry and first usable content.** silent middleware resolution and read-only
  page verification precede the response. the verified layout places required data
  under a streaming suspense skeleton and workspace error boundary. auth can gate
  ttfb; data and the active seed gate first shell mount. `loadWorkspaceBootstrap`
  concurrently loads required account, reader profile and saved sessions on the
  30 s server deadline, then awaits only the active pane's first-paint reads
  (`paneSeeds`, `lib/panes/paneResourceLoaders.ts`) with the existing 500 ms
  per-request budget, returning `{ account, readerProfile, initialState, seeds }`.
  `seeds` holds them by the active pane's id, under the key of the
  `useServerValue`/`useServerList` hook that reads them (the api path); the pane
  body's first commit paints and spends them, so a later mount reads. named
  transport/resource misses leave normal pane reads in charge; internal defects,
  malformed json, unknown codes and bootstrap 401 terminate.
  only `E_NETWORK`, `E_UPSTREAM`, `E_UPSTREAM_TIMEOUT`, `E_AUTH_UNAVAILABLE` produce
  cold retry; a cold failure mounts no store. `WorkspaceEntry` retains the first
  successful initializer for its verified viewer. later modeled data reread failure
  preserves that exact shell and store and publishes one refresh notice; later
  success clears it without replacing live work. viewer identity keys the subtree.
- **Server-side restore (no round-trip, no flash).** Device identity is a server-owned
  httpOnly `nx_device` cookie minted in middleware (`lib/auth/deviceCookie.ts`) —
  request-forwarded so this SSR sees it, response-set for future requests. The data root
  reads it, fetches the saved sessions (only a missing row is null; corruption is `E_INTERNAL`), and classifies `/`
  as Resume or every other protected href as Navigate; `enterWorkspace`
  (`lib/workspace/model.ts`, isomorphic) picks the session and merges the deep link. The
  store is created from that `initialState`, so the first render already shows the
  right panes. `useWorkspaceSession` saves 1 s after a change and flushes with keepalive
  on page hide; the BFF stamps the device id from the cookie as `X-Nexus-Device` — the
  client never reads or sends it. Column
  **widths** are clamped on the client at render only (`primaryWidth`), never written
  back; a null width is the reader column, whose first-paint estimate
  (`estimatePrimaryWidthPx`) the shell's probe refines. The URL-hash fold navigates the active pane (preserving the
  restored layout) rather than resetting state. The canonical `/lectern` request is
  explicit home intent: restore preserves the saved layout, then reuses or appends and
  activates Lectern; it is not a neutral alias for the previously active pane.
- **Measurement.** The workspace pane boundary emits one bounded, authenticated
  structural failure through `/api/telemetry/client-defects`; the BFF injects the
  serving release and FastAPI logs `rum.client_defect` (a stale build's 426 is no
  defect and is not reported). It carries pane/visit, structural error code,
  request ID, and React component stack, never exception messages, request bodies, draft text, tokens, or
  provider payloads. Kept constraints: nonce-CSP + **streaming only** — no PPR,
  no `next/dynamic`, no server-emitted `modulepreload` (chunk URLs are unknown
  server-side); `React.lazy` stays the splitting mechanism (a lazy body starts
  its import while hydrating; a failed import is forgotten so "Retry pane" imports
  again).
- **BFF / proxy / auth / SSE** (`lib/api/*`, `lib/auth/*`, `lib/supabase/*`): covered
  in §5. The browser holds **no** Supabase client and no tokens; every
  Supabase call is behind `lib/supabase/` (`cookie.ts` edge-safe, `auth.ts`
  server); `lib/auth/session.ts` `verifySession()` is the one verified-session
  boundary for protected pages, `liveSession()`/`withActionSession()` the one
  refresh path for response owners; live streams cross the BFF like every
  request (`lib/api/stream.ts`).
- **Surfaces** (`components/*`, `app/(authenticated)/**/*PaneBody.tsx`): reader,
  chat, player, notes editor, Nexus, search, contributors, libraries/
  items, settings — all rendered as pane bodies. UI primitives live in
  `components/ui/*`; cross-cutting hooks in `lib/ui/*`; theming via a `nx-theme`
  cookie; fixed shortcuts in `lib/shortcuts.ts`; Android-shell adaptation in
  `lib/androidShell.ts`.

---

## 10. Non-web clients

**Android shell** (`apps/android`): a Kotlin app with `MainActivity` for the
hardened WebView and `ShareActivity` for system-share capture. The WebView has
no `addJavascriptInterface`, file/content access, third-party cookies, or
off-origin in-WebView navigation. Two AndroidX WebKit listeners are confined to
their owned main-frame origins: `nexusPlayback` carries service-player
ops/snapshots, and `nexusDownloads` carries the offline commands/snapshots
for the hosted origin and the packaged shelf.

Offline ([module](modules/offline.md)) is one store (`OfflineStore`: one json
state file and one directory tree), one user-initiated transfer job for episode
audio and reading copies, one sync job for reading positions, and the packaged
shelf at `appassets.androidplatform.net`, which is the Downloads screen online
and offline. While the shelf is the main document, `ShelfRouter` serves only
packaged assets and copy files (PDF byte ranges natively) and answers every
other subresource with a local 404. `NexusOriginClient` is the one native
product client: fixed BFF paths for listening state, Consumption activity,
`me`, reading copies and reader state, with WebView cookies and the exact pinned
hosted `Origin`; OkHttp does not synthesize browser CSRF headers. No renderer
supplies a URL, header, cookie or filesystem path; the hosted renderer names
its account in `hello`, and native checks it against `GET /api/me` before any
authenticated remote work.

Native Google sign-in
(Credential Manager) and Custom-Tab OAuth both converge on a server-minted,
single-use, PKCE-bound
`nexus://auth/handoff` code that injects a first-party session cookie into the
WebView. App Links are backed by
`apps/web/public/.well-known/assetlinks.json` (validated against the release
signing cert at build time). The web app detects the shell via a `NexusAndroidShell`
UA token for presentation adaptation only. Each exact capability handshake,
never the UA, is capability truth and the UA never authorizes browser-player
fallback. Native BFF requests install every `Set-Cookie` value with an
acknowledged `CookieManager.setCookie` callback and flush only after all
acknowledgements. an owned main-frame redirect loop stops loading, logs the
routing defect and shows the existing hosted terminal without retry. ordinary
connection failure keeps reload; downloaded copies are offered only when the shelf
router exists. neither outcome clears webview data or cookies. `onResume()` is
lifecycle-only.

**Browser extension** (`apps/extension`, Firefox manifest v2, built by
`bun run build:extension` from `apps/web/src/extension/`): a persistent background
page owns one capture at a time. It connects via `identity.launchWebAuthFlow`
against `/extension/connect/start`, obtains a revocable `nx_ext_` bearer token,
reads `GET /api/extension/session`, and saves through the upload-session
lifecycle at `/api/extension/captures` (article packets extracted from the live
DOM with Mozilla Readability, and PDF/EPUB bytes fetched in the browser); bytes
go straight to the signed storage capability, never through the BFF. These
routes use a **separate** BFF proxy path (`proxyExtensionToFastAPI`) that forwards
the extension bearer rather than the Supabase cookie. Published captures enter
the normal ingest pipeline. See `docs/modules/ingest.md`.

---

## 11. Build, run, deploy, env, migrations

The `Makefile` owns product setup, development, build, migration, and
deployment helpers; `make help` is canonical for those operations. static
verification has one separate entrypoint, `./scripts/test`.

- **Setup / dev loop**: `make setup` installs locked dependencies; `make dev`
  starts docker compose postgres + seaweedfs + supabase-local auth. run
  `make migrate`, then `make api`, `make web`,
  `make worker-interactive`, and `make worker-background` in separate
  terminals. Ports are written to `.dev-ports`.
- **disposable verification**: `./scripts/lab -- COMMAND [ARG ...]` in a dedicated
  worktree; fresh real services and browser state with scoped teardown.
  [runtime use](../README.md#disposable-verification) owns prerequisites and workflow.
- **Formatting**: `make format`, `make format-back`, `make fix-front`.
- **verification**: see §12; no Make aliases.
- **Build**: `make build` (Next.js), `make build-android[-release]`.

**Deploy** ([`deployment.md`](../deployment.md), sole runbook): each exact
`main` push triggers one backend publisher, and only on `run_attempt == 1`. It
builds API/worker targets once and publishes their GHCR digests in one strict
candidate manifest. Vercel builds the exact SHA as an unaliased
production-target candidate. `deploy/hetzner/deploy.sh <source-sha>` resolves
that manifest from the first CI run, converges the backend in one linear
idempotent pass, then promotes the bound frontend deployment. Config
publication and the Oracle corpus seed are separate explicit operations. Env
contracts live in `deploy/env/*` (real values untracked, `.example` tracked).
Permanent R2 policy is applied via `deploy/cloudflare/*`.

**Migrations** are hand-written Alembic files (`migrations/alembic/versions/`,
linear `NNNN_*` numbering, no autogenerate), rooted at the squashed baseline
`0292_baseline.py`. Dev: `make migrate`. The PR check
requires one canonical Alembic head without starting a database. Production
applies the candidate's baked head only inside the release, after the
stopped-writer verified R2 backup and a revision-ancestry proof, and before the
services start on the new digests.

**Environment**: `.env.example` is the source of truth for every variable
([`rules/codebase.md`](rules/codebase.md)); configure local `.env` overrides
manually. `make dev` writes live local auth settings to `.dev-ports` for the
make targets. Major groups: app/env, database + pool, Supabase
Auth (issuer/JWKS/audiences), internal secret, encryption key, Codex host
settings, the narrow OpenAI embedding key,
Brave Browse/chat search, streaming (token signing key + base URL + CORS),
podcasts, browse providers, and worker schedules. Worker lanes are
Compose-owned rather than stored in the merged production env.
The automated check starts no application services and reads no credentials.

**CI**: `.github/workflows/ci.yml` is a pull-request-only, self-hosted devbox
job. It installs locked dependencies and invokes only `./scripts/test`, with a
hard five-minute timeout. There are no scheduled, optional, browser, device, or
release verification workflows. Backend image publication after a `main` push
is an artifact operation, not a test or release gate.

---

## 12. verification

[`local-rules/testing-standards.md`](local-rules/testing-standards.md) is the
authoritative contract. `./scripts/test` runs workflow and shell lint, python
format/lint/type checking, web lint/type checking, and a single-head alembic
graph check. no automated tests, fixtures, or harnesses remain after the
2026-09-17 reset.

static checks target two minutes on the devbox. manually verify affected
behavior according to the change's failure risk and recovery cost. future
tests need a concrete benefit that exceeds their maintenance cost; historical
proof checklists impose no obligation to rebuild the suite.

---

## 13. Invariants cheat-sheet

The things most likely to bite you, distilled:

1. **Never call blocking DB on the event loop** — plain `def` handlers or
   `run_in_threadpool`. request sessions are released by the function-scoped
   dependency before body transfer; don't touch the borrowed session while streaming.
2. **The browser holds no tokens.** Product data and live streams go through
   `/api/*`; nothing in the browser reaches FastAPI.
3. **Private assets and static assets are different.** `/api/media/image` and EPUB
   assets are viewer-authenticated and unoptimized; the Oracle plates are static
   files under `/oracle-plates/`, named by key, and optimizable.
4. **`services/media.py` is catalog/hydration, not an ingest catch-all.** URL
   ingest, X, YouTube, remote files, EPUB assets, listening state, file access,
   and processing transitions have named owners.
5. **`ready_for_reading` is the document success terminal**; search/embedding
   readiness is a _separate_ state machine. Source-attempt retry and metadata
   retry are user-visible retry capabilities.
6. **Reader offsets are Unicode codepoints into current `canonical_text`.** The
   frontend canonicalizer must byte-match the Python one; a mismatch disables
   highlighting for that fragment.
7. **One send = one durable `ChatRun`**; HTTP only admits and enqueues; the worker
   alone opens generation; the client only tails SSE and reconciles.
8. **Active conversation path is per-viewer**; only path messages enter context.
9. **Citation `[N]` is a dense, turn-global ordinal carried on an
   `origin='citation'` `resource_edge`**, not a per-tool index and not a column on
   `message_retrievals` (which is telemetry pointing back via `cited_edge_id`); the
   attached-reference citation regression came from breaking this density.
10. **Assistant trust trails are read models, not new truth.** They are assembled
    when assistant messages are read from chat runs, tool calls, retrieval ledgers,
    citation edges, and context-ref-added events. Message documents remain text-only.
11. **`background_jobs` is raw SQL**, invisible in `models.py`. Most ingest tasks'
    `{"status":"failed"}` returns mark the _queue_ row succeeded; recovery is the
    user's retry, and a dead source job is its repair offer.
12. **No DB cascades.** Deletion is explicit, reference-counted, and orders external
    (storage) effects after the DB commit.
13. **pgvector is fixed at 256 dims**; chunk ANN uses the current embedding
    provider/model rows. A model change requires rebuilding current embeddings
    before semantic search should depend on them.
14. **Frontend routing is the pane system, not `children`.** Behavior lives in
    `*PaneBody.tsx`; the URL is a projection of the active pane.
15. **Migrations are hand-written**; the live database and `migrations/` are the
    schema of record, `models.py` maps only what the ORM queries, and there is no
    autogenerate diff.

---

## 14. Where to look (file index)

| You want…                                                         | Start at                                                                                                                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repository rules / boundaries                                     | [`rules/index.md`](rules/index.md)                                                                                                                                                                     |
| Reader behavior contract                                          | [`modules/reader-implementation.md`](modules/reader-implementation.md), [`modules/reader-design-rationale.md`](modules/reader-design-rationale.md)                                                     |
| FastAPI bootstrap / middleware / lifecycle                        | `python/nexus/app.py`, `python/nexus/api/edge.py`, `python/nexus/auth/`                                                                                                                                |
| DB layer / sessions / LISTEN-NOTIFY                               | `python/nexus/db/` (`engine.py`, `session.py`, `listen.py`)                                                                                                                                            |
| The schema                                                        | `migrations/alembic/versions/0292_baseline_schema.sql` (the squashed baseline) + the revisions after it + the live database (`pg_dump --schema-only`); `python/nexus/db/models.py` is the ORM-mapped classes only                                                               |
| Background jobs / worker                                          | `python/nexus/jobs/`, `python/nexus/tasks/`, `apps/worker/`                                                                                                                                            |
| Generation backends                                               | `python/nexus/services/generation/`, `apps/codex_agent/`, [`modules/llms.md`](modules/llms.md)                                                                                                    |
| Media catalog and ingest owners                                   | `python/nexus/services/media.py`, `media_source_ingest.py`, `source_attempts.py`, `source_runner.py`, `source_publication.py`, `web_article.py`, `x_ingest.py`, `youtube.py`, `remote_file.py`, `media_processing_state.py`, [`modules/ingest.md`](modules/ingest.md) |
| Imports workspace (query owner, history, pane)                    | `python/nexus/services/{imports,import_history}.py`, `python/nexus/api/routes/imports.py`, `apps/web/src/lib/imports/`, `apps/web/src/components/imports/`, `apps/web/src/app/(authenticated)/imports/`                                              |
| Reader/highlights backend                                         | `python/nexus/services/{reader_profile,epub_*,pdf_*,fragment_blocks,highlights,passage_anchors,locator_resolver,text_quote}.py`                                                                        |
| Chat / conversations                                              | `python/nexus/services/chat/`, `python/nexus/api/routes/chat.py`, `python/nexus/schemas/conversation.py`                                                                                              |
| Oracle                                                            | `python/nexus/services/oracle/` (`corpus.py`, `corpus.json`, `synthesis.py`, `readings.py`), `python/nexus/services/atlas.py`                                                                          |
| Search / retrieval / indexing / resource target/openable search   | `python/nexus/services/search/` (`sources`, `semantic`, `scope`, `project`, `service`, `pickers`), `python/nexus/services/{content_indexing,content_chunking,embeddings,note_indexing}.py`, `services/chat/retrievals.py` |
| Resource graph (edges, refs, citations, connections, links) | `python/nexus/services/resource_graph/` (`refs`, `resolve`, `edges`, `links`, `connections`, `context`, `citations`, `reader_targets`, `cleanup`)                                                     |
| Universal Dossiers / Media Intelligence                           | `python/nexus/services/dossier/`, `python/nexus/services/media_intelligence.py`, `python/nexus/api/routes/dossiers.py`                                                                               |
| Model tools (contract, dispatcher, writes, undo, memory)         | `python/nexus/services/tools/`, `python/nexus/api/routes/assistant_writes.py`, [`modules/model-tools.md`](modules/model-tools.md)                                                                      |
| Libraries / contributors / notes                                  | `python/nexus/services/{libraries,library_entries,library_listing,library_members,contributors,notes}.py`                                                                                               |
| Resource grants / public sharing                                  | [`modules/resource-sharing.md`](modules/resource-sharing.md), `python/nexus/services/{resource_grants,resource_sharing,public_resource_sharing}.py`, `apps/web/src/{components,lib}/sharing/`, `apps/web/src/app/s/` |
| Podcasts / playback                                               | `python/nexus/services/podcasts/`, `python/nexus/services/consumption/`, `python/nexus/api/routes/{lectern,listening_state}.py`                                                                        |
| Auth                                                              | `python/nexus/auth/`                                                                                                                                                                                   |
| Frontend BFF / auth / SSE                                         | `apps/web/src/lib/{api,auth,supabase}/`                                                                                                                                                                |
| Workspace / panes / mobile viewport                               | `apps/web/src/lib/{workspace,panes,mobileViewport}/`, `apps/web/src/components/workspace/`                                                                                                             |
| Desktop Nexus / mobile Nexus task                                 | `apps/web/src/components/{nexus,switchboard}/`, `apps/web/src/lib/{nexus,switchboard}/`                                                                                                                |
| Reader / chat / player UI                                         | `apps/web/src/components/{reader,chat}/`, `apps/web/src/lib/{reader,highlights,conversations,player,lectern}/`                                                                                         |
| Android shell                                                     | `apps/android/app/src/main/`                                                                                                                                                                           |
| Browser extension                                                 | `apps/extension/`                                                                                                                                                                                      |
| Build / run / deploy                                              | `Makefile`, `deployment.md`, `deploy/`                                                                                                                                                                 |
| verification | `docs/local-rules/testing-standards.md`, `scripts/test` |

---

_This document is an overview maintained alongside the code. When a slice's
behavior changes materially, update the relevant section here and the canonical
rule/module doc it links to._
