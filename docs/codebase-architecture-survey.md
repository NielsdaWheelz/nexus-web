# Codebase Architecture Survey

This document records the current Nexus architecture and active drift leads.
It is descriptive; engineering rules live in `docs/rules/`.

## System Shape

Nexus is a reading, notes, chat, and media workspace.

- `apps/web/` owns the Next.js UI, authenticated workspace shell, and `/api/*`
  BFF routes.
- `apps/api/` owns the FastAPI ASGI bootstrap.
- `python/nexus/` owns backend routes, services, schemas, auth, jobs, storage,
  and tests.
- `apps/worker/` owns the Postgres-backed worker bootstrap.
- `apps/android/` owns the Android WebView shell, native auth handoff, app
  links, and local Android platform integration.
- `apps/extension/` owns browser-extension capture.
- `node/ingest/` owns the Node.js article-ingest runtime used by backend
  ingestion tasks.
- `migrations/` owns Alembic schema history.
- `e2e/` owns Playwright acceptance coverage.
- `supabase/` owns local Supabase Auth configuration.
- `deploy/` owns production environment sync and deploy scripts.
- `scripts/` owns local development, audit, and test orchestration helpers.
- `docs/rules/` owns repository-wide engineering standards.

The default request path is:

```text
browser -> Next.js page/component -> Next.js /api BFF route -> FastAPI route
  -> python/nexus service -> SQLAlchemy/Postgres or external provider
```

The direct browser-to-FastAPI exception is streaming SSE. The browser first
mints a short-lived stream token through the BFF, then calls FastAPI stream
routes directly.

## Layer Contracts

- Next.js middleware classifies cookies, gates auth navigations, and sets CSP.
  It performs no network I/O.
- `apps/web/src/lib/auth/dal.ts` is the verified session boundary for protected
  pages, route handlers, and server actions.
- Next.js BFF route handlers attach auth, forward requests, and shape transport
  errors. Product behavior belongs behind frontend helpers or backend services.
- FastAPI middleware verifies JWTs, injects the viewer, and adds request IDs.
- FastAPI routes validate transport input, call services, and return response
  envelopes.
- `python/nexus/services/` owns business behavior. Services do not depend on
  route handlers or HTTP framework types.
- `python/nexus/db/models.py` owns SQLAlchemy table definitions.
- Worker task modules call backend services instead of carrying separate
  product logic.

## Frontend Architecture

### App Router

`apps/web/src/app/` is split into authenticated product routes, Oracle routes,
auth routes, `/api/*` BFF routes, and static/legal/install routes.

Protected routes pass through `apps/web/src/app/(authenticated)/layout.tsx`,
which calls `verifySession()` before mounting the client shell.

### Authenticated Shell

`AuthenticatedShell` mounts session freshness, local-vault sync, reader global
state, workspace state, global navigation, command palette, add-content tray,
workspace host, and global player footer.

The shell is deliberately thin; workspace behavior belongs in workspace and
pane modules.

### Workspace And Panes

Workspace ownership is split by persistence, mutations, and runtime chrome:

- `apps/web/src/lib/workspace/schema.ts` owns persisted workspace state shape,
  sanitization, pane ids, pane history, and strict restore validation.
- `apps/web/src/lib/workspace/store.tsx` owns durable workspace mutations:
  opening, navigating, resizing, minimizing, restoring, and attaching secondary
  panes.
- `apps/web/src/components/workspace/WorkspaceHost.tsx` owns runtime
  publication: pane titles, layout metrics, fixed primary chrome, secondary
  surface publications, pending cross-pane secondary requests, validation, and
  stale-record pruning.

Route identity and capabilities are centralized:

- `apps/web/src/lib/panes/paneRouteModel.ts` owns route patterns, width
  contracts, body mode, resource refs, and secondary group eligibility.
- `apps/web/src/lib/panes/paneRouteRegistry.tsx` binds route models to icons,
  chrome descriptors, and React bodies.
- `apps/web/src/lib/panes/paneSecondaryModel.ts` owns secondary groups,
  surfaces, icons, titles, and width policies.
- `apps/web/src/lib/panes/paneRuntime.tsx` exposes pane-scoped commands to route
  bodies.
- `apps/web/src/components/workspace/SecondaryPaneShell.tsx`,
  `MobileSecondaryPaneHost.tsx`, and `SecondarySurfaceTabs.tsx` render shared
  desktop/mobile secondary chrome from the same secondary model.
- `apps/web/src/components/workspace/PaneRouteBoundary.tsx` owns internal pane
  link interception and title hints for route-rendered links.

Current workspace contract:

- Layout state is not encoded in the URL.
- Secondary pane identity and width are independent from primary pane width.
- Store state is strict; invalid topology is dropped rather than adapted.
- Mounted pane publications decide whether a secondary surface can render.

### Reader

Reader behavior is owned by the media route and reader modules:

- `MediaPaneBody` coordinates media loading, reader type selection, pane runtime
  publication, highlights, resume, and reader-side secondary surfaces.
- `TextDocumentReader`, PDF reader modules, transcript panels, EPUB helpers, and
  reader utilities own media-specific rendering.
- `docs/reader-implementation.md` is the behavior contract for typography,
  focus mode, resume, reader highlights, overview ruler, contents, and reader
  pane sizing.

Secondary surfaces:

- `reader-tools`: `reader-highlights`, `reader-doc-chat`, `reader-contents`
- `conversation-context`: `conversation-references`, `conversation-forks`
- `library-tools`: `library-chat`, `library-intelligence`

The overview ruler is fixed primary chrome, not a secondary surface.

### Chat And Conversations

The current chat state is one conversation engine:

- `components/chat/useConversation.ts` owns conversation state and lifecycle.
- `components/chat/Conversation.tsx` is the full conversation pane adapter.
- `components/chat/ReaderChatDetail.tsx` is the reader-adjacent chat adapter.
- `components/chat/ChatSurface.tsx` owns transcript view structure.
- `components/chat/useChatRunTail.ts` and
  `components/chat/useChatMessageUpdates.ts` own SSE tailing and batched message
  deltas.
- Conversation references are surfaced through the conversation context
  secondary group and backend `conversation_references`.

The durable backend reference model is URI-based. Singleton chat scope,
message-context tables, and removed payload aliases are non-goals under the
conversation references contract.

### Notes, Items, And Shared UI

- `apps/web/src/lib/notes/` owns notes API adapters and document helpers.
- `components/items/ItemCard.tsx` is the shared presentational item card.
- `components/ui/ActionMenu.tsx` is the shared action-menu primitive.
- `components/ui/Disclosure.tsx` is the shared disclosure primitive.

Shared UI should stay leaf-level. Domain adapters pass data and slots down; leaf
UI components do not import service, route, or host modules at runtime.

## Backend Architecture

### FastAPI App

`python/nexus/app.py` creates the FastAPI app, registers exception handlers,
middleware, routers, stream routes, shared HTTP clients, the LLM router, web
search provider, and rate limiter.

`apps/api/main.py` is the ASGI bootstrap. It creates the app and adds request-id
middleware last so it runs first.

`python/nexus/api/routes/__init__.py` is the route registry factory. It includes
feature routers and conditionally includes podcast/playback routes when podcast
support is enabled.

### Routes

Route modules in `python/nexus/api/routes/` are HTTP adapters. Their job is to
validate transport input, resolve viewer/session context, call services, and
return response envelopes.

Large route files are cleanup leads only after their service boundaries are
clear; splitting route files without moving behavior to the owning service does
not satisfy the rules.

### Services

`python/nexus/services/` is capability-oriented. Major service groups include:

- Auth handoff, user bootstrap, API keys, billing, and extension sessions.
- Libraries, media, uploads, object refs/links, search, vault, and contributors.
- Reader navigation, highlights, PDF/EPUB/web article lifecycle, transcript
  processing, and metadata enrichment.
- Conversations, chat runs, prompt assembly, conversation references, branch
  state, and agent tools.
- Podcasts, playback, subscription sync, and transcript ingestion.
- Background job policies, workers, and task handlers.

Service public surfaces should be small, typed commands and queries. Raw HTTP
payloads, vendor SDK details, database row shapes, and provider-specific
fallback branches should be normalized at boundaries.

### Jobs And Tasks

`python/nexus/jobs/registry.py` owns job kind policy and task contract version.
`python/nexus/jobs/worker.py` owns the queue worker runtime. Task modules in
`python/nexus/tasks/` perform bounded background work through services.

The worker entrypoint in `apps/worker/main.py` wires settings, job registry,
session factory, worker identity, signal handling, and lifecycle logging.

## Data And Storage

- App data lives in Postgres through SQLAlchemy models and Alembic migrations.
- Supabase local/prod Auth owns identity; app tables do not store password
  material.
- Local object storage is MinIO through R2-compatible settings.
- Production object storage uses the same R2-compatible storage client layer.
- Database ownership and cleanup rules are canonical in
  `docs/rules/database.md`.

## Runtime And Environment

- `.env.example` is the environment contract.
- `make setup` creates local env files.
- `make dev` starts local Postgres, MinIO, and Supabase Auth, then writes live
  runtime ports to `.dev-ports`.
- `make api`, `make web`, and `make worker` run the main local processes.
- Deployment scripts are split between Vercel env sync and Hetzner env/deploy
  flows.

Production runtime is split by ownership:

- Vercel runs the Next.js frontend and BFF.
- Hetzner runs FastAPI, the worker, Postgres, and Caddy.
- Cloudflare R2 is the production object store.
- Supabase is Auth only; app data and object storage do not fall back to
  Supabase database or storage.
- `/health` is process liveness plus task contract version. Production smoke is
  the auth/API surface check, not a full product acceptance suite.

## Test Architecture

Canonical test commands and standards live in `Makefile`, `make help`, and
`docs/rules/testing_standards.md`. This survey records ownership:

- Python static checks, typing, and pytest coverage live under `python/`.
- Frontend lint, typecheck, unit tests, and browser component tests live under
  `apps/web/`.
- Playwright acceptance tests live under `e2e/tests/`.
- Android checks live under `apps/android/`.
- Node article-ingest checks live under `node/ingest/`.
- Real-media and live-provider tests are opt-in gates.

During concurrent cleanup, prefer the narrow owning test or static check for
the touched surface.

## Rule Sources

Use `docs/rules/` as the source of truth. Common cleanup references for this
survey are:

- `docs/rules/cleanliness.md`
- `docs/rules/layers.md`
- `docs/rules/module-apis.md`
- `docs/rules/database.md`
- `docs/rules/errors.md`
- `docs/rules/testing_standards.md`

## Current Drift Register

- BFF route repetition: many `/api/*/route.ts` files should remain thin, but
  repeated forwarding helpers and hand-written transport branches should use
  the existing proxy capability instead of near-duplicate adapters.
- Chat consolidation: keep route-specific lifecycle, scroll, send, and
  reference state centralized in `useConversation` plus `ChatSurface`.
- Reader secondary surfaces: keep desktop/mobile secondary publication on the
  same typed capability contract; remove any route-local sheets or icon
  registries that duplicate `paneSecondaryModel`.
- Item cards: keep row markup centralized through `ItemCard`, `ActionMenu`, and
  `Disclosure`; do not reintroduce old bespoke card/menu components.
- Pane route navigation: keep supported internal-anchor interception in
  `PaneRouteBoundary` and `paneLinkNavigation`. Shared UI primitives render
  links and actions only.
- Backend conversation references: keep URI reference behavior in
  `conversation_references` and `resource_resolver`; delete singleton/scope
  branches where they still exist.
- Backend services: split only around real owned capabilities. Do not introduce
  generic middle layers that simply rename parameters or wrap one call.
- `MediaPaneBody.tsx` is the largest frontend god-file lead. Split only along
  real reader ownership lines: media data, restore, highlights, secondary
  surface publication, and pane chrome.
- Mobile selection stabilization is duplicated between `MediaPaneBody.tsx` and
  `PdfReader.tsx`; keep medium-specific snapshot construction local and share
  the timing/stabilization hook.
- App-route internals can still leak into shared modules; when found, move the
  shared contract to its owning `lib/*` module instead of importing route-local
  internals.
- Resource URI parsing is repeated across conversation references, resource
  resolver, chat runs, app search, search, and frontend resource-kind mapping.
  The backend resolver should own one parser/contract; frontend UI metadata can
  validate against that contract without owning backend semantics.
- `search.py`, `media.py`, `epub_ingest.py`, and podcast transcript services are
  backend god-file leads. Split only when the extracted unit owns a capability
  end to end.
- Several FastAPI routes still coordinate multiple service calls or shape DB
  rows directly. Move behavior to the owning service before splitting route
  files.
- Private helper imports across services are public-surface drift. Replace them
  with named public service operations at the owning module boundary.
- Metadata-enrichment enqueue logic is repeated across ingest tasks and media
  service paths; one lifecycle owner should expose the retry/enqueue contract.
- Test drift includes internal `vi.mock`/`monkeypatch` seams and unmarked
  backend tests. When a behavior is touched, migrate that test toward the true
  owner and the public surface.

## Recent Cleanup Notes

- `SelectionPopover` tests now cover active highlight/chat destination behavior
  without preserving negative assertions for the old generic `Ask` action.
- Oracle reading, library-intelligence, and podcast semantic-reindex task
  wrappers now mark intentional worker failure boundaries with
  `justify-ignore-error` comments at the broad catch sites.
- EPUB archive/XML/spine parsing now catches only named archive and parser
  failures, so unexpected defects no longer get classified as unsafe archives
  or skipped optional entries.
- Stale-ingest health now computes cutoff and age with Postgres `now()` and
  interval arithmetic instead of comparing database timestamps to app time.
- `SearchResultRow` tests now cover the rendered row contract without negative
  assertions for removed object-ref ask attachments.
- Workspace-session persistence now relies on database defaults and `func.now()`
  for `created_at`/`updated_at`, refreshing rows after commits before returning
  API payloads.
- Persisted reader media-state timestamps now use database defaults and
  `func.now()`; clearing a state writes SQL `NULL` explicitly instead of JSON
  `null`.
- Conversation sharing state changes now use database `now()`, and share tests
  seed membership/share rows with explicit select-before-insert helpers instead
  of `ON CONFLICT DO NOTHING`.
- Reader resume-state parser tests no longer preserve a removed flat-payload
  negative case; strict current-shape validation remains covered.
- Command palette tests no longer preserve removed scope-chip, clear-scope, or
  pane-local action absence assertions; active global palette behavior remains
  covered.
- Chat context assembly now marks conflicting persisted prompt ledgers as an
  explicit service invariant and defect, and reader-context comments describe
  the current model-hint contract directly.
- Fragment block parsing now uses explicit runtime invariant checks with
  service-invariant and defect justification instead of Python `assert`.
- Web-article retry lifecycle now writes retry start/update timestamps with
  database `now()` instead of app time.
- Chat run event-store transitions now write run start/update timestamps with
  database `now()` instead of app time.
- Extension-session token usage and revocation now write persisted timestamps
  with database `now()` instead of app time.
- Media processing-state transitions now write failed/extracting timestamps
  with database `now()` from the shared transition owner.
- Chat run finalization now writes assistant-message and terminal run
  timestamps with database `now()` instead of app time.
- Permission predicate tests now seed memberships, library entries, intrinsics,
  and closure edges with explicit select-before-insert helpers instead of
  `ON CONFLICT DO NOTHING`.
- Visibility-helper tests now seed memberships and conversation shares with
  explicit select-before-insert helpers instead of `ON CONFLICT DO NOTHING`.
- The storage client settings boundary now resolves required R2 settings into
  typed values instead of relying on runtime `assert` statements after the
  missing-setting check.
- Crypto nonce validation and persisted-key version mismatch paths now carry
  explicit service-invariant and defect annotations at the detection sites.
- PDF quote-readiness docs now describe span-count mismatch as the predicate's
  fail-closed readiness result instead of calling it an impossible defect state.
- Job registry periodic-slot validation now marks non-positive schedule
  intervals as a runtime registry invariant.
- Highlight tests now seed media, fragments, and shared-library memberships
  with explicit select-before-insert helpers instead of `ON CONFLICT`.
- Citation guard tests no longer carry negative-only `@ts-expect-error`
  fixtures that manufacture impossible result-ref values; runtime rejection
  cases remain covered by the guard suite.
- Citation guard tests now derive invalid web/search cases from valid fixture
  builders, keeping each rejection focused on the mutated contract field.
- PDF highlight shared-visibility tests now seed shared-library memberships
  with explicit select-before-insert helpers instead of `ON CONFLICT`.
- Media transcript view types and pure helpers now live in
  `apps/web/src/lib/media/transcriptView.ts`. Media route components, the
  processing-status hook, and podcast episode transcript helpers import that
  shared media contract instead of duplicating or leaking route-local state.
- SSE citation-index parsing now narrows parsed entry values before returning
  typed events, and password unlinking follows the Supabase server-client
  identity contract while preserving the explicit ownership comment.
- Library and conversation delete tests now name the current explicit child-row
  cleanup behavior instead of describing it as cascade-owned cleanup.
- Web-article canonical dedup now delegates duplicate loser teardown to
  `media_deletion.delete_duplicate_document_media`, which explicitly removes
  library/default-library provenance, viewer tombstones, content-index state,
  object links, storage metadata, fragments, and the media row.
- Upload PDF/EPUB SHA-256 dedup now reuses the same duplicate document media
  cleanup owner. Upload remains responsible for staging/final object deletion
  after the DB transaction commits.
- Stale pending upload reconciliation now delegates abandoned document teardown
  to `media_deletion.delete_abandoned_document_media`, while the reconciler
  keeps ownership of stale-object cleanup after commit.
- The conversation response suite no longer carries a negative dead-format
  assertion for removed scope/singleton fields; the positive `ConversationOut`
  owner-field contract and conversation-reference tests cover current behavior.
- Health, metadata-enrichment, and SSE LISTEN/NOTIFY tests/docs now describe
  current worker contracts, unstructured payload rejection, and trigger
  behavior directly instead of carrying deploy-compatibility, legacy, or
  migration-number labels.
- Sanitizer and EPUB ingest anchor-preservation fixtures now name the current
  named-anchor contract directly instead of carrying finished-era terminology
  in test data.
- Rate-limit RPM admission now uses PostgreSQL `now()` and interval arithmetic
  for request-window and retention decisions, letting the DB-owned
  `requested_at` timestamp remain the shared clock across app servers.
- Podcast subscription sync lease freshness now uses one SQL stale-running
  predicate backed by PostgreSQL `now()` for polling, manual refresh, and
  worker claim paths; a DB-clock regression keeps healthy running claims from
  being reclaimed by skewed app-server clocks.
- Podcast transcription worker stale-claim logic now uses a SQL stale-running
  predicate and heartbeat writes use PostgreSQL `now()`, with a skewed app-clock
  regression proving fresh DB-heartbeat jobs are not double-claimed.
- Rate-limit token-budget reservations, charges, usage buckets, and expiration
  cleanup now use DB-derived UTC dates plus PostgreSQL `now()`; skewed-clock
  regressions cover reservation creation and expiry reclamation.
- Podcast transcription claim lifecycle timestamps now come from the atomic
  claim `RETURNING updated_at` value, so job, media, and running transcript
  state timestamps share the DB clock before provider execution starts.
- Scheduled podcast poll singleton leases now use PostgreSQL `now()` for
  lease expiry, inserted run lease timestamps, and the right-open
  `lease_expires_at <= now()` invalidity rule; a skewed-clock test keeps a
  healthy DB lease from being expired by a fast app server.
- Rate-limit in-flight counters now write `updated_at` with PostgreSQL
  `now()`, and the integration suite asserts app-clock skew cannot leak into
  the durable limiter state.
- Reader citation data and reader-source targets now have lib-owned contracts
  in `apps/web/src/lib/conversations/readerCitation.ts` and
  `readerTarget.ts`; UI components render those values instead of owning types
  that conversation helpers import back across the layer boundary.
- Supabase identity unlinking now uses the full identity object returned by
  `getUserIdentities` and a shared identity-matching helper, so password and
  linked-identity Server Actions honor the Supabase client contract without
  partial payload casts.

## Definition Of Pristine

A slice is pristine when:

- One module owns the concern.
- Entry points are thin.
- Public APIs are narrow and semantic.
- Runtime values are parsed at boundaries into typed internal shapes.
- No old/new dual-path branch remains.
- No duplicate state derivation remains.
- Tests assert observable behavior through the true owner.
- Targeted checks for the touched surface pass.
