# Effect Discipline Cutover Specification

## Status

Planning artifact. This document defines the hard cutover target for frontend
effect discipline and backend resource lifetime discipline. It is not a
compatibility plan. The intended implementation removes ad hoc legacy patterns
as they are migrated.

## Problem Statement

The production incident was triggered by request storms, but the root class is
broader than a chatty frontend. The codebase has several repeated side-effect
patterns that are locally reasonable but globally unsafe:

- `useEffect` loaders whose dependency identity changes as a result of their
  own state updates.
- GET reads hand-rolled with `cancelled` booleans instead of a shared request
  lifecycle.
- Duplicate owners for the same resource.
- Search/autocomplete effects that suppress stale writes but still issue every
  intermediate request.
- Workspace/session effects that are lifecycle operations but are modeled as
  ordinary reactive effects.
- Streaming and asset-serving paths that can consume database resources outside
  the ordinary request-session invariant.

The target state is a codebase where product reads, polling, streaming,
workspace bootstrap, chrome publication, and backend resource lifetimes are
owned by explicit shared contracts.

## Governing Rules

This cutover is governed by:

- `docs/rules/layers.md`: client product data calls use `/api/*`; BFF routes
  proxy only; services own business logic.
- `docs/rules/concurrency.md`: nontrivial side-effect concurrency must be
  intentional, bounded, and sequentially explainable.
- `docs/rules/polling.md`: polling is avoided by default; unavoidable polling
  requires `justify-polling`.
- `docs/rules/timing.md`: retry and polling schedules are named and
  self-bounding.
- `docs/rules/database.md`: request database sessions are owned by the shared
  session layer; long-lived streams must use short-lived database phases.
- `docs/rules/testing_standards.md`: behavior must be proven at the appropriate
  boundary, with real browser or real backend coverage where user flows or BFF
  behavior are involved.

## Goals

- Make request count a semantic property of each user action, not an incidental
  result of React render timing.
- Ensure every client GET has one owner for loading, cancellation, stale-result
  suppression, retry behavior, and duplicate handling.
- Ensure every polling loop is explicit, named, bounded, and justified.
- Ensure streams and asset delivery cannot bypass the database resource
  lifetime invariant.
- Make bad patterns hard to reintroduce through lint and route-shape tests.
- Replace duplicated patterns with shared primitives and delete the migrated
  ad hoc code.

## Non-Goals

- No gradual dual path.
- No compatibility wrappers preserving legacy effect behavior.
- No endpoint-specific throttling as the main fix.
- No rate-limit-only solution.
- No backend pool-size increase as a substitute for correct lifetimes.
- No broad UI refactor unrelated to effect/resource ownership.
- No speculative caching of business data without a named owner and invalidation
  contract.

## Hard Cutover Policy

Each migrated area must end in one canonical pattern. The implementation should
remove local `cancelled`/`loading`/in-flight patterns when the shared primitive
replaces them. New exceptions require a named justification comment using the
same style as existing repo rules: `justify-polling`, `justify-concurrency`, or
an equivalent local allowlist reason in the lint rule.

## Target Architecture

### Client API Boundary

`apps/web/src/lib/api/client.ts` remains the only browser JSON transport for
same-origin product API calls.

Required final contract:

- Client product paths are typed as `/api/${string}`.
- Plain duplicate GETs are coalesced.
- Safe `cache: "no-store"` GETs without caller signals are also coalesced.
- Caller-provided `AbortSignal` remains a request-owner signal and is not
  merged blindly with unrelated callers.
- Mutations are never coalesced.
- Keepalive writes use a first-class helper such as `apiKeepaliveJson`, not raw
  `fetch`.
- Development diagnostics report duplicate GETs that bypass coalescing because
  of custom options or a caller signal.

### Sanctioned Read Hook

Introduce `apps/web/src/lib/api/useApiResource.ts` on top of
`useAsyncResource`.

Capability contract:

- Input is a stable `cacheKey` plus an API path factory.
- `cacheKey: null` means no request.
- The hook owns `AbortController`, stale-result suppression, loading state,
  error state, bounded retry, and optional seeded data.
- The hook does not retry semantic 4xx responses.
- The hook only retries transient failures using named timing constants.
- Effects that need GET data use this hook unless explicitly exempted.
- Mutations stay in user/event handlers or action-specific hooks.

This replaces repeated `useEffect + apiFetch + cancelled` loaders.

### Search and Autocomplete

Introduce a shared debounced/latest-wins primitive for product search, either as
`useApiSearchResource` or a thin wrapper around `useApiResource`.

Capability contract:

- Input changes are debounced with named constants.
- Superseded requests are aborted or dropped before issuing duplicate work.
- A stale response cannot update results, loading, or error.
- In-flight work is single-flight per normalized query.

### Polling

`useIntervalPoll` is the only frontend interval polling primitive.

Required final contract:

- No product code calls `setInterval` directly.
- Every polling use carries `justify-polling`.
- Cadence and termination are named constants colocated with the polling
  schedule.
- Poll ticks are non-overlapping.
- Polling stops when the resource reaches a terminal state.

### Streaming

`apps/web/src/lib/api/sse-client.ts` is the browser stream owner.

Required final contract:

- Direct FastAPI SSE is allowed only through the shared SSE client.
- Stream token acquisition, abort, reconnect, backoff, cursor/last-event
  handling, and terminal close behavior are centralized.
- Oracle, chat, and media streaming compose with the same client contract.
- A stale page, media ID, reading ID, or conversation ID cannot open a stream.

### Workspace Bootstrap

Workspace bootstrap is lifecycle work, not ordinary reactive fetching.

Required final contract:

- URL hydration runs once per `WorkspaceStoreProvider` lifecycle.
- Session restore runs once per device/session lifecycle.
- Restored snapshots seed the last-saved baseline so restore does not
  immediately schedule a redundant PUT.
- Metric changes normalize layout; they do not recreate a workspace from URL.
- Workspace capture is armed only after restore resolution.
- Workspace tests assert GET and PUT counts, not just visual state.

### Pane Runtime and Chrome Publication

Pane runtime command functions must be stable independently from navigation
state. Consumers must not depend on a full runtime object for effects.

Required final contract:

- Stable command context is split from reactive navigation state where needed.
- Lint or tests reject `useEffect(..., [paneRuntime])` and comparable full
  context dependencies in pane bodies.
- `WorkspaceHost` publication callbacks are stable and use refs for current
  resource-key checks.
- Secondary and fixed-chrome publications do not clear and republish on
  unrelated host renders.
- `usePaneChromeOverride` accepts stable descriptors or performs semantic
  equality; reference-only churn is not a valid publication trigger.

### Backend Request Resources

The existing request-session middleware remains the ordinary JSON/API invariant.

Required final contract:

- Request-scoped SQLAlchemy sessions are tracked and released centrally before
  response bodies transfer.
- Route handlers do not add bespoke request-session cleanup.
- Long-lived streams open short-lived database phases only.
- Raw Postgres LISTEN connections are capped, logged, and owned by a shared
  stream resource layer.
- Storage-backed asset delivery performs authorization and DB metadata lookup in
  a short DB phase, releases the DB resource, then performs object-storage work.
- Checkout duration and stream listener counts are observable before pool
  exhaustion.

## Enforcement

### ESLint

Add local rules in `apps/web/eslint.config.mjs`:

- No raw same-origin `/api` `fetch` outside the API client and explicit
  keepalive/stream/upload allowlist.
- No direct FastAPI browser fetch outside the SSE client.
- No `setInterval` in product code outside `useIntervalPoll`.
- Require `justify-polling` near `useIntervalPoll`.
- Disallow `apiFetch` GET calls inside ad hoc `useEffect` bodies outside
  approved hooks after migration.
- Disallow pane effects that depend on full runtime/context objects.

### Route Shape

Add a route-shape test for `apps/web/src/app/api/**/route.ts`.

Acceptance:

- Every BFF route uses `proxyToFastAPI` or `proxyExtensionToFastAPI`.
- Extension proxy routes are explicit allowlist entries.
- BFF routes contain no business logic.
- Route count changes are intentional and reviewed.

### Backend Tests

Add integration coverage that uses real `get_db` plus middleware behavior, or
make the authenticated test override track request sessions so route tests
exercise the invariant.

## Issue Map and Required End State

### P0 Shared Contracts

Files:

- `apps/web/src/lib/api/client.ts`
- `apps/web/src/lib/api/useApiResource.ts`
- `apps/web/src/lib/useAsyncResource.ts`
- `apps/web/src/lib/useIntervalPoll.ts`
- `apps/web/src/lib/api/sse-client.ts`
- `apps/web/eslint.config.mjs`

End state:

- All migrated GET effects use `useApiResource` or a specific approved wrapper.
- Raw API fetch exceptions are named and centralized.
- Duplicate safe GETs are coalesced.
- Tests cover coalescing, abort, latest-wins, retry, and no 4xx retry.

### P1 Request Loops and Duplicate Owners

Files:

- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/lib/media/useNonDefaultLibraries.ts`
- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`

End state:

- `/api/libraries` loads once per semantic page/session need.
- Failed library load is terminal until explicit retry.
- Podcast detail fetch does not depend on local UI sets.
- Web article fragments have exactly one owner.
- Tests assert request counts for success, failure, and UI-only state changes.

### P1 Workspace Invariants

Files:

- `apps/web/src/lib/workspace/store.tsx`
- `apps/web/src/lib/workspace/useWorkspaceSession.ts`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/PaneSecondary.tsx`
- `apps/web/src/components/workspace/PaneFixedChrome.tsx`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/lib/panes/paneRuntime.tsx`

End state:

- Restore and URL hydration are one-shot lifecycle operations.
- Metric changes cannot collapse restored multi-pane state.
- Publication callbacks do not churn on unrelated renders.
- Runtime command identity is stable across reactive navigation state changes.
- Tests assert state preservation and request counts.

### P1 Stale Async Writes and Search

Files:

- `apps/web/src/lib/reader/useReaderResumeState.ts`
- `apps/web/src/components/notes/ProseMirrorOutlineEditor.tsx`
- `apps/web/src/components/CommandPalette.tsx`
- `apps/web/src/components/contributors/ContributorFilter.tsx`
- `apps/web/src/components/LibraryEditDialog.tsx`

End state:

- Reader resume hydration is keyed by media ID and rejects stale saves.
- Object-reference autocomplete is debounced/latest-wins/single-flight.
- Command Palette Oracle recents has in-flight and unmount guards.
- Contributor hydration tracks in-flight handles.
- Invite user search cannot be overwritten by stale responses.

### P2 Streaming and Reader Resource Ownership

Files:

- `apps/web/src/lib/media/useMediaProcessingStatus.ts`
- `apps/web/src/components/chat/useConversation.ts`
- `apps/web/src/components/chat/useChatRunTail.ts`
- `apps/web/src/app/(oracle)/oracle/[readingId]/OracleReadingPaneBody.tsx`
- `apps/web/src/components/PdfReader.tsx`

End state:

- Current media status, not an initial ref from another media, controls media
  event streams.
- Stale conversations/readings cannot start streams.
- Oracle streaming uses the shared SSE client.
- PDF highlights load once per page/mutation owner, not per render/zoom.

### P2 Mutating Effects and Local Side Effects

Files:

- `apps/web/src/app/(authenticated)/LocalVaultAutoSync.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/lib/player/globalPlayer.tsx`
- `apps/web/src/components/GlobalPlayerFooter.tsx`
- `apps/web/src/app/(authenticated)/daily/DailyNotePaneBody.tsx`
- `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx`
- `apps/web/src/app/(oracle)/oracle/OracleConcordance.tsx`
- `apps/web/src/app/(oracle)/oracle/atlas/AtlasPaneBody.tsx`

End state:

- Local vault sync is globally single-flight and cancellation-aware across each
  awaited boundary.
- Transcript forecast reservations persist until promise settlement.
- Playback queue refresh is single-flight.
- Pane chrome override descriptors are stable or semantically compared.
- Oracle concordance clears on identity/status change.
- Atlas delayed navigation is cancelled on unmount.

### P1 Backend Resource Invariants

Files:

- `python/nexus/db/session.py`
- `python/nexus/middleware/db_session.py`
- `python/nexus/db/listen.py`
- `python/nexus/api/routes/stream.py`
- `python/nexus/api/routes/media_events.py`
- `python/nexus/api/routes/media.py`
- `python/nexus/services/media.py`
- `python/nexus/db/engine.py`
- `python/tests/test_db_session_lifecycle.py`
- `python/tests/conftest.py`

End state:

- Ordinary request-session lifecycle remains centralized.
- SSE LISTEN connections have a process cap, structured open/close logs, and
  rejection behavior when capacity is exhausted.
- EPUB asset service separates DB authorization/metadata from storage reads.
- Tests cover release-before-body, stream short-session behavior, and asset
  storage reads after DB release.

## API Design Details

### `apiFetch`

Proposed shape:

```ts
export type ApiPath = `/api/${string}`;

export async function apiFetch<T>(
  path: ApiPath,
  init?: ApiFetchInit
): Promise<T>;

export function apiKeepaliveJson(
  path: ApiPath,
  body: JsonValue
): Promise<void>;
```

`ApiFetchInit` should preserve standard fetch options but carry explicit
coalescing semantics. The default is safe coalescing for GET requests with no
body and no caller-owned signal. Any opt-out must be named.

### `useApiResource`

Proposed shape:

```ts
useApiResource<T>({
  cacheKey,
  path,
  parse,
  initialData,
  retry,
});
```

`path` is evaluated only when `cacheKey` is non-null. `retry` defaults to the
shared bounded transient policy. The hook returns `{ data, error, loading,
reload, status }`.

### Stream Resource

The browser stream API owns token acquisition and SSE. Callers provide resource
identity, terminal status detection, and event application. Reconnect schedule
and abort behavior remain centralized.

### Backend LISTEN Resource

`wait_for_notifications` must not be the public raw primitive. A stream manager
owns capacity, connection creation, open/close logging, and cancellation.

## Acceptance Criteria

- Navigating to each authenticated top-level page cannot create an unbounded
  request loop on success or failure.
- All listed P1/P2 findings have targeted tests proving request count,
  latest-wins behavior, or resource release.
- `rg "fetch\\(" apps/web/src` shows only approved raw fetch sites.
- `rg "setInterval\\(" apps/web/src` shows only approved polling primitive or
  tests.
- `rg "apiFetch" apps/web/src` has no ad hoc GET-in-effect call sites outside
  approved hooks or documented exceptions.
- `useIntervalPoll` call sites include `justify-polling`.
- API route shape test passes and guards all BFF proxy routes.
- Backend tests prove request DB release before body, stream capacity behavior,
  and EPUB asset storage reads outside request-session ownership.
- Production smoke includes request-count checks for workspace bootstrap,
  libraries, podcasts, media reader, command palette search, and streaming page
  transitions.

## Verification Plan

Run after implementation:

- `cd apps/web && bun run lint`
- `cd apps/web && bun run typecheck`
- `cd apps/web && bun run test:unit`
- Targeted `bun run test:browser` for resource hooks and affected components.
- Targeted Playwright for workspace restore, podcasts, media reader, and
  streaming flows.
- `cd python && uv run ruff check .`
- `cd python && uv run ruff format --check .`
- `cd python && uv run pyright`
- Targeted `uv run pytest` for DB session, stream, and media asset invariants.
- Production smoke after deploy.

## Key Decisions

- Shared contracts first, migrations second. The codebase should not accumulate
  more local stale guards.
- Request-count tests are first-class behavior tests for effect discipline.
- Backend resource invariants are part of this cutover, not deferred hardening.
- BFF route shape is an architectural invariant and should be tested like one.
- Hard cutover means migrated areas remove legacy effect code immediately.

## Completion Definition

The cutover is complete when all listed issue-map entries have been migrated to
the shared contracts, enforcement rejects the old patterns, tests prove request
counts and resource lifetimes, and production smoke shows no request storms or
database resource retention across representative page navigation.
