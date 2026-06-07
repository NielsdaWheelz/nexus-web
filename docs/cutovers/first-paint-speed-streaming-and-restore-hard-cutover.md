# First-Paint Speed: Streaming Shell + Server-Side Workspace Restore — Hard Cutover

**Status:** SPEC (not built) · **Rev 1** · 2026-06-07
**Type:** Hard cutover — no legacy code, no fallbacks, no backward-compat shims, no dual identity sources, no client-side restore round-trip.
**Migration:** None. (`workspace_sessions` table + `WorkspaceState` schema are unchanged; only *where* the device key lives and *when* the session is read change.)

## One-line

Make the authenticated app reach a **correct first paint as fast as possible** by (1) **streaming** the shell chrome immediately behind a Suspense boundary instead of blocking the first byte on best-effort data, (2) **parallelizing** the server bootstrap fetches, and (3) **restoring the user's workspace on the server** — moving the device key from `localStorage` to a server-owned httpOnly cookie, folding the `workspace-session` read into the server data root, and **seeding the store** so the first hydration already shows the right panes — which **deletes the post-mount restore round-trip and its flash**. Shipped with a **closed measurement loop** (RUM sink + CI bundle budget) so the win is evidence-backed and regression-proof.

---

## 0. Why this exists (measured, not assumed)

A measurement pass (production build + static waterfall read) overturned the leading hypothesis ("the app loads too much JS"):

- **Bundle is NOT the bottleneck, and splitting is already done.** Next reports **~104 kB gzipped First Load JS** for authenticated routes (oracle 119–125 kB); the conservative reading that folds the `(authenticated)/layout` client chunk in is **~210 kB gz** — either way ~8× below the stale "1.66 MB" figure. All 26 panes are already `React.lazy` chunks behind `<Suspense>` with `preloadPane()` warming, enforced by an ESLint rule (`apps/web/eslint.config.mjs:70-99`). **There is no bundle battle left to fight** — only a regression to prevent.
- **The real cost is a fully-blocking, serial SSR waterfall.** `app/(authenticated)/layout.tsx:6-18` awaits **three things in series** before a single byte flushes — `verifySession()` (local, cheap), `loadWorkspaceBootstrap()` (**two serial FastAPI round-trips**: `/me/reader-profile` *then* the pane prefetch, each on a 500 ms deadline — worst case ~1000 ms), `loadRenderEnvironment()` (local). **No Suspense, no streaming.** The two network fetches are explicitly *best-effort* (timeout → client refetch) yet they **gate the first byte** — blocking paint on data already declared optional.
- **The flash is a separate, smaller cost.** The set of open panes is keyed by a `device_id` that lives **only in `localStorage`** (`lib/workspace/deviceId.ts`), invisible to the server. So the server renders a guess (the URL pane), and `useWorkspaceSession` corrects it **after mount** via a client round-trip to `/api/me/workspace-session` — a wrong-then-right repaint, worst on multi-pane layouts and bare-landing (`/libraries` → last workspace).
- **The measurement loop is dead.** `WebVitalsReporter` captures LCP/INP/CLS/TTFB but the events go **nowhere** (a `window` event with no subscriber; `console.warn` only on "poor" — `lib/workspace/telemetry.ts:38-48`). No RUM sink, no CI bundle budget, no load trace. We had to measure statically because the app cannot report its own numbers.

**The governing principle this cutover installs:** *never let best-effort or personalized data block the first byte, and key personalization off something the server can read at request time.*

### Measured baseline → targets

| Metric | Baseline (measured) | Target (this cutover) | Gate |
|---|---|---|---|
| First Load JS, authenticated route (Next route-table) | 104 kB gz | ≤ **115 kB gz** (hold the line) | **CI** (AC-5/R5) |
| Blocking network round-trips before first byte | **2 serial** (≤ ~1000 ms) | **0** (skeleton streams; data resolves behind Suspense) | AC-3/R1 |
| Post-hydration pane-set change on reload (the flash) | present | **0** | AC-1 |
| Client restore round-trip on load | 1 (`GET /api/me/workspace-session`) | **0** | AC-2 |
| Prefetched-pane client `useResource` fetches on first paint | URL pane only | **all restored visible panes seeded** | AC-4 |
| RUM web-vitals reaching a durable sink | none | LCP/INP/CLS/TTFB → structured log, request-id-correlated | AC-8 |

---

## 1. Target behavior

**Open the app → the chrome is on screen instantly → your actual workspace (the panes you left open) paints with its data, with no wrong-screen flash, no address-bar jump, and no second render.**

1. **Instant chrome.** The first HTTP flush is the shell skeleton (AppNav rail + pane region in its loading state), painted before any FastAPI call resolves and before app JS executes. TTFB is gated only on the local auth check, not on data.
2. **Correct-from-first-paint workspace.** The first hydrated render shows the user's restored panes (count, order, active pane, per-pane history, attached tool panes) — not a default pane that later swaps. On a bare landing (`/libraries`) the user lands directly in their last workspace; on a deep link (`/media/123`) that pane is active inside the restored layout.
3. **Seeded pane data.** Every restored *visible* pane paints from server-prefetched data (hydration cache) — no client fetch for those panes. A pane whose prefetch timed out shows its normal loading state and the client fetches it (one code path; prefetch is the optimization).
4. **No round-trip, no flash.** There is no post-mount session fetch and no `hydrate` re-dispatch. The only client-side settle is column-width normalization to the current viewport (a layout adjust within the first frame, never a content/pane change).
5. **Cross-device continuity preserved.** First load on a new device restores the most-recent session from another device (resolved server-side), exactly as before.
6. **Invisible identity.** The device key is a server-owned httpOnly cookie; the client never reads, writes, or sends it. Capture/flush of layout changes is unchanged from the user's perspective.

---

## 2. Goals / Non-goals

### Goals

- **G1. Stream, don't gate.** Restructure the authenticated layout so the chrome skeleton flushes immediately behind a `<Suspense>` boundary; all data fetching happens *inside* the boundary and streams. The first byte depends on nothing but the local auth gate.
- **G2. Parallelize the server bootstrap.** No serial `await callFastAPI(...)` chains. Personalization fetches run concurrently in bounded waves.
- **G3. Restore on the server.** Read the saved `workspace-session` during SSR and **seed the store's initial state** with the merged restored identity, so the first render is correct. Delete the client-side restore fetch and its `hydrate` dispatch.
- **G4. Server-owned device identity.** Replace the `localStorage` device id with a server-minted httpOnly cookie. The client never touches it. Delete `lib/workspace/deviceId.ts`.
- **G5. One restore resolver.** Extract the restore/merge logic into a single **server-safe** module consumed identically by the server bootstrap and the client store (parity by construction — the same principle as the existing single `resolvePaneRouteModel`, D-5). Collapse the helpers currently split across `sessionSync.ts` and `store.tsx`.
- **G6. Close the measurement loop.** Wire the existing web-vitals event channel to a durable sink (BFF → FastAPI structlog, request-id-correlated; reuse the existing channel, no new vendor) and add a CI **First Load JS budget** so the already-won 104 kB cannot regress.
- **G7. Identity/sizing split.** Layout *identity* (which panes) is computed on the server; viewport *sizing* (widths) is reconciled on the client. One code path owns each.

### Non-goals (explicit)

- **N1. PPR / partial prerender / static authenticated HTML.** The nonce is per-request and auth is dynamic; PPR is incompatible (and was already rejected). Streaming dynamic SSR only.
- **N2. `next/dynamic` / server-emitted `<link rel="modulepreload">`.** Banned by strict-dynamic nonce-CSP (chunk URL unknown server-side). `React.lazy` + runtime `preloadPane` stays the only splitting mechanism. *(Streaming SSR itself is CSP-safe — it emits no nonced preloads.)*
- **N3. Server-rendering full pane-body HTML.** Pane bodies are heavy lazy client components with client-only hooks; SSR-ing their HTML is a separate, larger effort with diminishing returns. The win here is *streaming the shell + seeding pane data + warming pane chunks*, so a pane paints instantly on chunk load. The pane region's SSR output is its loading state.
- **N4. Changing `WorkspaceState`, the `workspace_sessions` table, or the capture/flush/last-write-wins persistence model.** Only the *key location* (cookie) and *read timing* (server) change. No migration.
- **N5. New telemetry vendor / analytics SaaS.** Reuse the `nexus:web-vitals` event channel and the backend's existing structlog + `request_id` correlation (`python/nexus/middleware/request_id.py:144`).
- **N6. Encoding the workspace in the URL.** The URL stays a *projection* of the active pane (`history.replaceState`), not the source of truth. Multi-pane layout remains DB-backed.
- **N7. Bundle splitting work.** Already done (§0). This cutover only *guards* it with a budget.
- **N8. Multi-user / multi-tenant concerns.** Single-user prototype; per-device restore can be optimized without contention.

---

## 3. Architecture — final state

### 3.1 Render path (server)

```
middleware (lib/supabase/middleware.ts)
  ├─ nonce + CSP (unchanged)
  ├─ REQUEST_PATH_HEADER stamp (unchanged)
  └─ NEW: mint device cookie if absent → rewrite request cookie + set response cookie

app/(authenticated)/layout.tsx          [server, async]
  ├─ await verifySession()              // local auth gate (warm JWKS ⇒ ~0 net); may redirect
  ├─ const env = loadRenderEnvironment() // local header read
  └─ return
       <Suspense fallback={<AuthenticatedShellSkeleton env={env}/>}>   ← FLUSHES FIRST (TTFB)
         <WorkspaceBootstrapGate env={env}/>                           ← streams in
       </Suspense>

WorkspaceBootstrapGate                   [server, async]   (new file)
  └─ const boot = await loadWorkspaceBootstrap()   // parallel waves, restore-aware
     return <AuthenticatedShell {...boot} env={env}/>

AuthenticatedShell                       ["use client"]
  └─ providers → WorkspaceStoreProvider initialState={boot.initialState} …
```

`loadWorkspaceBootstrap()` (the single server data root) becomes restore-aware and parallel:

```
loadWorkspaceBootstrap():
  initialHref = headers[REQUEST_PATH_HEADER] ?? FALLBACK_HREF
  deviceId    = readDeviceId(cookies())                       // server-owned cookie

  // Wave 1 — independent, concurrent (Promise.all), each best-effort under PREFETCH_DEADLINE_MS
  [ readerProfile, session, urlPaneSeed ] = await all(
        callFastAPI('/me/reader-profile'),
        deviceId ? callFastAPI('/me/workspace-session?device_id='+deviceId) : null,
        seedPaneResource(initialHref),                         // speculative: usually the active pane
  )

  restored    = selectRestoredState(session.own, session.mostRecentElsewhere)   // shared resolver
  initialState = mergeRestoredIdentity(restored, deepLinkIntent(initialHref))    // identity only, metrics-free

  // Wave 2 — remaining restored visible panes not already seeded, concurrent, deduped by cacheKey
  extraSeeds  = await all( visiblePanes(initialState)
                             .filter(p => !seeded(p))
                             .map(p => seedPaneResource(p.href)) )

  resources = mergeByCacheKey(urlPaneSeed, ...extraSeeds)      // DehydratedResources
  return { initialHref, readerProfile, initialState, resources }
```

Key properties: the first byte (skeleton) depends on **nothing** awaited here; every fetch is `Promise.all`-concurrent within its wave and best-effort; the **common single-pane case resolves in one wave** (the speculative `urlPaneSeed` is usually the active pane).

### 3.2 Restore path (no client round-trip)

```
Server: loadWorkspaceBootstrap → initialState (merged identity) + resources (seeded data)
          ↓ props
AuthenticatedShell → WorkspaceStoreProvider({ initialState, initialHref, metrics })
          ↓
store init: createWorkspaceStateFromServer(initialState, metrics)   // identity from server; widths from metrics
          ↓ (first render is already correct — NO dispatch, NO flash)
useWorkspaceSession(state, mounted, …, serverRestored=true)
   • RESTORE phase: NO-OP (server already restored)                 ← deleted round-trip
   • CAPTURE phase: debounced PUT (unchanged; device id from cookie via BFF)
   • FLUSH phase:   keepalive PUT on pagehide (unchanged)
   • URL-hash fold + state→URL replaceState projection: unchanged
```

### 3.3 Identity / sizing split

`mergeRestoredIdentity` and the server seed deal only in **identity** — pane hrefs, order, active pane, per-pane history, secondary-pane attachment — plus the persisted `primaryWidthPx` carried as-is. On client init, `useWorkspacePrimaryMetrics` measures the viewport and `createWorkspaceStateFromServer` **normalizes/clamps widths** to the current viewport. Same-device reloads (the common case) keep the persisted widths unchanged (no settle). Cross-viewport restores adjust column widths only — never the pane set, never content. This is the only client-side reconciliation, and it is a layout adjust within the first frame.

### 3.4 Device identity (server-owned)

- A new httpOnly cookie `nx_device` (per browser profile = per device) is **minted in middleware** when absent: `request.cookies.set(...)` (so this request's SSR sees it) **and** `response.cookies.set(...)` (so future requests carry it).
- `lib/auth/deviceCookie.ts` (server-safe) owns the name + read/mint helpers. Value = `createRandomId()`.
- The server bootstrap reads it for SSR restore. The **BFF** `/api/me/workspace-session` route reads it and injects `device_id` into the upstream FastAPI call for **both** GET and PUT — the client never sends it.
- `lib/workspace/deviceId.ts` (localStorage) is **deleted**; its 3 call sites in `useWorkspaceSession` drop the argument.

### 3.5 Measurement loop

- **RUM sink:** a single subscriber to the existing `nexus:web-vitals` event POSTs each vital via `navigator.sendBeacon`/keepalive to a new BFF route `/api/telemetry/web-vitals`, which proxies to FastAPI `/internal/telemetry/web-vitals` → structlog `rum.web_vital`, correlated with `request_id`. Payload: `{ name, value, rating, id, href, navId }`. No new vendor (reuses the event channel and structlog — O-4).
- **CI bundle budget:** `apps/web/scripts/check-bundle.mjs` parses the production build's First Load JS for authenticated routes and **fails** above the budget; wired as `make check-bundle` in the `build-front` CI job.
- **Backend latency** is already emitted (`http.request.completed` with `duration_ms`); the RUM `request_id` correlation lets a single log stream join front-paint vitals to the FastAPI fetch latencies that drive them.

---

## 4. Capability contract

The authenticated shell guarantees, as invariants:

- **C1 — Data never gates the first byte.** The first HTTP flush (skeleton chrome) is produced after only local work (`verifySession`, `loadRenderEnvironment`). No network round-trip precedes it.
- **C2 — First hydration is correct.** The pane set rendered at first hydration equals the settled pane set. No post-mount pane-set mutation occurs on load.
- **C3 — No restore round-trip.** On load, the client issues **no** `GET /api/me/workspace-session`. Restoration is fully server-side.
- **C4 — Seeded data for restored panes.** Every restored visible pane whose loader succeeded within the deadline paints from the hydration cache with **zero** client `useResource` fetch. A timed-out loader degrades to the normal client fetch (one code path).
- **C5 — Server-owned identity.** The device key is an httpOnly cookie. No client code can read or set it; no client request body/query carries it.
- **C6 — One restore resolver.** Server and client compute identical restored identity from identical inputs (shared module; property test).
- **C7 — Best-effort everywhere.** Any bootstrap fetch may fail/timeout without affecting correctness — the client owns retry/refetch; a slow backend degrades latency, never correctness.
- **C8 — Observable.** Core Web Vitals reach a durable, request-id-correlated sink; First Load JS is gated in CI.

---

## 5. API & module design

### 5.1 Device cookie — `apps/web/src/lib/auth/deviceCookie.ts` (new, server-safe)

```ts
export const DEVICE_COOKIE_NAME = "nx_device";
// read from a RequestCookies/cookies() store; returns null if absent
export function readDeviceId(store): string | null;
// mint + cookie options (httpOnly, sameSite:"lax", secure in prod, path:"/", maxAge ~10y)
export function mintDeviceId(): { value: string; options: CookieOptions };
```

Minted in `lib/supabase/middleware.ts` on protected-page passthrough (and any authenticated response): if `readDeviceId(request.cookies)` is null, `const { value, options } = mintDeviceId(); request.cookies.set(DEVICE_COOKIE_NAME, value); response.cookies.set(DEVICE_COOKIE_NAME, value, options)`.

### 5.2 BFF `/api/me/workspace-session/route.ts` (modified — cookie injection)

No longer a thin pass-through. Reads `DEVICE_COOKIE_NAME` from `cookies()`; **GET** appends `?device_id=<cookie>`; **PUT** injects `device_id` into the forwarded body. Any client-supplied `device_id` is ignored. (FastAPI `WorkspaceSessionPutRequest` keeps `device_id` with `extra="forbid"`; the BFF supplies it.)

### 5.3 `sessionSync.ts` (modified — transport only)

```ts
getWorkspaceSession(): Promise<{ own; mostRecentElsewhere }>   // no deviceId arg (BFF injects)
putWorkspaceSession(state, keepalive=false): Promise<void>     // no deviceId arg
```
The pure helpers `prepareRestoredState`, `isNonTrivialSession`, `workspaceStatesEqual` **move out** to §5.4.

### 5.4 `lib/workspace/workspaceRestore.ts` (new, server-safe — the one resolver)

No `"use client"`, no `apiFetch` import — importable by the server bootstrap *and* the client store.

```ts
selectRestoredState(own: unknown, elsewhere: unknown): RawSession | null   // own-if-non-trivial-else-elsewhere
prepareRestoredState(raw, opts): WorkspaceIdentity                          // sanitize → identity (metrics-free)
mergeRestoredIdentity(restored, deepLinkIntent): WorkspaceIdentity          // identity merge, no widths
isNonTrivialSession(identity): boolean
workspaceStatesEqual(a, b): boolean                                         // moved verbatim
```
Where `WorkspaceIdentity` is the metrics-free projection of `WorkspaceState` (panes/order/active/history/secondary, persisted widths carried but not computed). `store.tsx`'s `mergeRestoredWorkspaceWithDeepLink` is rebuilt on top of this (identity here + client width application).

### 5.5 Server bootstrap — `lib/workspace/bootstrap.server.ts` (modified)

```ts
loadWorkspaceBootstrap(): Promise<{
  initialHref: string;
  readerProfile: ReaderProfile;
  initialState: WorkspaceIdentity;     // NEW — merged restored identity (server)
  resources: DehydratedResources;      // now multi-pane
}>
```
Two-wave concurrent fetch (§3.1). Reuses `paneServerLoaders` for `seedPaneResource`, `callFastAPI` for the session read, and `resolvePaneRouteModel` for routing — all existing seams.

### 5.6 Store — `lib/workspace/store.tsx` (modified)

```ts
WorkspaceStoreProvider({ children, workspacePrimaryMetrics, initialHref, initialState })
// init: createWorkspaceStateFromServer(initialState, metrics)  — identity from server, widths from metrics
useWorkspaceSession(state, mounted, applyRestoredState, metrics, /* NEW */ serverRestored)
```
`useWorkspaceSession` restore effect early-returns when `serverRestored` (keeps capture + flush). `initialHref` is retained only for the URL-hash fold and as the deep-link intent record.

### 5.7 RUM — `/api/telemetry/web-vitals/route.ts` (new BFF) + FastAPI `/internal/telemetry/web-vitals` (new) + subscriber

`WebVitalsReporter` (or a sibling) subscribes to `nexus:web-vitals` and `sendBeacon`s `{name,value,rating,id,href,navId}`; the BFF proxies to FastAPI which logs `rum.web_vital` via structlog under the request's `request_id`.

---

## 6. Slices (build order; hard cutover — all land together, no interim dual paths)

- **S0 — Measurement loop (lands first; permanent guard).** RUM sink (subscriber + BFF route + FastAPI structlog route); `check-bundle.mjs` + `make check-bundle` + CI wiring; record the measured baseline in this doc. *Rationale: establish the before/after evidence and the regression gate before changing the render path.*
- **S1 — Server-owned device identity.** `deviceCookie.ts`; mint in middleware (request-rewrite + response set); BFF cookie injection (GET+PUT); strip `deviceId` from `sessionSync` + `useWorkspaceSession`; **delete `deviceId.ts`**.
- **S2 — One restore resolver.** Create `workspaceRestore.ts`; move `prepareRestoredState`/`isNonTrivialSession`/`workspaceStatesEqual` out of `sessionSync.ts`; add `selectRestoredState` + `mergeRestoredIdentity`; rebuild `store.tsx` merge on top; sessionSync becomes transport-only.
- **S3 — Parallel, restore-aware bootstrap.** Rewrite `loadWorkspaceBootstrap` to the two-wave concurrent shape returning `initialState` + multi-pane `resources`.
- **S4 — Streaming shell.** `AuthenticatedShellSkeleton` (server, CSS-only, env-aware; reuses `PaneLoadingState` + an AppNav skeleton); `WorkspaceBootstrapGate` (async server); layout returns `<Suspense fallback=…><Gate/></Suspense>` with only local work above it.
- **S5 — Server-seeded store; delete the round-trip.** `WorkspaceStoreProvider` takes `initialState`; `createWorkspaceStateFromServer`; `useWorkspaceSession` restore no-op under `serverRestored`; extend `preloadPane` to warm all restored visible panes.
- **S6 — Gates, tests, docs.** §8 negative gates; §9 tests; `docs/architecture.md` §9 update; enforce the bundle budget.

---

## 7. Key decisions

- **D1 — Stream, don't gate.** Best-effort/personalized data resolves behind a Suspense boundary; the skeleton is the first flush. *Why: the first byte must never wait on optional data; it's the single biggest measured win.*
- **D2 — Server-owned httpOnly device cookie, minted in middleware.** *Why: the restore key must be server-readable at request time to render correctly on the server; httpOnly + BFF-injection removes the localStorage/cookie dual source and keeps the key off the client entirely.*
- **D3 — One restore resolver, server-safe.** *Why: server/client parity by construction (same module), mirroring the existing single `resolvePaneRouteModel`; eliminates drift between a server merge and a client merge.*
- **D4 — Seed the store with server identity → no dispatch on load.** *Why: a passed-down-then-dispatched restore is still a post-hydration state change (a smaller flash); only seeding the initial state removes it entirely.*
- **D5 — Identity on the server, widths on the client.** *Why: viewport metrics are inherently client-only; splitting lets the server be correct about *which* panes while the client settles *how wide* — a layout adjust, not a content flash.*
- **D6 — Two-wave concurrent fetch with a speculative URL-pane seed.** *Why: the session is needed to know secondary panes, but the URL pane is usually the active pane — seeding it in wave 1 collapses the common single-pane case to one wave. The occasional wasted seed (bare-landing) is bounded by the deadline and never blocks the stream.*
- **D7 — Keep nonce-CSP; streaming only.** *Why: streaming SSR is CSP-safe; PPR/`next/dynamic`/modulepreload are not (per-request nonce, unknown chunk URLs). No CSP relaxation.*
- **D8 — Skeleton matches the chrome's first frame.** *Why: the skeleton→shell→pane-loading→content transition must be seamless; the pane region's skeleton is the same `PaneLoadingState` the real shell shows during chunk load, so there is no visual discontinuity.*
- **D9 — Measure first, gate forever.** *Why: the loop was dead; without a sink and a budget, neither this win nor future regressions are visible.*

---

## 8. Negative gates (grep-enforced; hard-cutover cleanliness)

- **R1.** `app/(authenticated)/layout.tsx` contains a `<Suspense` boundary and **no** `await` of any `callFastAPI`/`loadWorkspaceBootstrap` above it (only `verifySession`/`loadRenderEnvironment`).
- **R2.** No `getInstallationId`, no `nexus.installationId`, no `localStorage` device key anywhere; `deviceId.ts` does not exist. No `device_id` in any **client** request body/query (only the BFF injects it).
- **R3.** `bootstrap.server.ts` contains **no** sequential `await callFastAPI(...)` followed by another `await callFastAPI(...)`; fetches go through `Promise.all`.
- **R4.** `useWorkspaceSession` has no restore-phase network call when `serverRestored`; `sessionSync.ts` exports only `getWorkspaceSession`/`putWorkspaceSession` (no `prepareRestoredState`/`workspaceStatesEqual`/`isNonTrivialSession`).
- **R5.** CI `check-bundle` is present in `build-front` and fails over budget.
- **R6.** `workspaceRestore.ts` has no `"use client"` and no `@/lib/api/*` import (server-safe), and is imported by both `bootstrap.server.ts` and `store.tsx`.

---

## 9. Acceptance criteria & test plan

- **AC-1 (no flash).** Browser test: load a 3-pane workspace; assert the pane set at first commit equals the settled set and that the reducer receives **no** `hydrate` action on load. *(unit: store init from `initialState`; browser: WorkspaceHost renders N panes on first paint)*
- **AC-2 (no round-trip).** Playwright: reload an authenticated route; assert **no** `GET /api/me/workspace-session` request occurs.
- **AC-3 (streaming TTFB).** Server test: the initial streamed HTML contains the skeleton (`data-testid="shell-skeleton"`) *before* any FastAPI response is required; assert the layout flushes without awaiting bootstrap. RUM TTFB recorded post-cutover.
- **AC-4 (seeded multi-pane).** Browser test: with a 2-pane restored layout whose loaders are stubbed, both panes paint with **zero** client `useResource` fetch (hydration-cache hit by exact `cacheKey`).
- **AC-5 (bundle budget).** CI: build → First Load JS ≤ 115 kB gz for authenticated routes; PR fails otherwise.
- **AC-6 (device cookie).** Integration: first authenticated response sets `nx_device` (httpOnly, SameSite=Lax, Secure in prod); a capture PUT with no client `device_id` succeeds (BFF-injected); no client code can read the cookie.
- **AC-7 (cross-device).** Integration: with only a `most_recent_elsewhere` session, the server seeds it; the rendered layout matches.
- **AC-8 (RUM).** Integration: a posted web-vital produces a `rum.web_vital` structlog line carrying the request's `request_id`.
- **AC-9 (resolver parity).** Property/unit: `mergeRestoredIdentity`/`selectRestoredState` give identical results when driven from the server bootstrap and from the client store for the same inputs.
- **AC-10 (graceful degradation).** Integration: cookie absent **or** session fetch times out → server renders the `initialHref` pane; the client functions normally; capture re-mints on next write. No crash, no console error.

Test placement follows house standards (`reference_frontend_test_standards`): `.test.ts` (node/unit) for `workspaceRestore`, bootstrap waterfall, sink; `.test.tsx` (Chromium/browser) for store seeding, no-flash, hydration-cache; Playwright (`e2e/`) for AC-2/AC-3 round-trip & streaming.

---

## 10. Files

**Create**
- `apps/web/src/lib/auth/deviceCookie.ts` — cookie name + read/mint (server-safe).
- `apps/web/src/lib/workspace/workspaceRestore.ts` — the one restore resolver (server-safe).
- `apps/web/src/app/(authenticated)/AuthenticatedShellSkeleton.tsx` — server, CSS-only, env-aware skeleton.
- `apps/web/src/app/(authenticated)/WorkspaceBootstrapGate.tsx` — async server gate (await bootstrap → render shell).
- `apps/web/src/app/api/telemetry/web-vitals/route.ts` — BFF RUM sink.
- `python/nexus/api/routes/telemetry.py` — FastAPI `/internal/telemetry/web-vitals` → structlog.
- `apps/web/scripts/check-bundle.mjs` — First Load JS budget checker.

**Modify**
- `apps/web/src/lib/supabase/middleware.ts` — mint device cookie (request-rewrite + response set).
- `apps/web/src/lib/workspace/bootstrap.server.ts` — parallel waves; restore-aware; new return shape.
- `apps/web/src/app/(authenticated)/layout.tsx` — Suspense + gate; only local work above the boundary.
- `apps/web/src/app/(authenticated)/AuthenticatedShell.tsx` — accept `initialState`; pass to store; (RUM subscriber).
- `apps/web/src/lib/workspace/store.tsx` — `initialState` seed; `createWorkspaceStateFromServer`; merge rebuilt on `workspaceRestore`.
- `apps/web/src/lib/workspace/useWorkspaceSession.ts` — drop `getInstallationId`; restore no-op under `serverRestored`; keep capture/flush.
- `apps/web/src/lib/workspace/sessionSync.ts` — transport-only; drop `deviceId` args; helpers moved out.
- `apps/web/src/app/api/me/workspace-session/route.ts` — cookie injection (GET+PUT).
- `apps/web/src/components/workspace/WebVitalsReporter.tsx` — subscribe + `sendBeacon` to the sink.
- `python/nexus/api/routes/me.py` — `device_id` sourced from BFF (no client trust); (optionally) read from injected body/query.
- `.github/workflows/ci.yml` + `Makefile` — `check-bundle` in `build-front`.
- `docs/architecture.md` §9 — streaming shell + server-side restore + identity/sizing split.

**Delete**
- `apps/web/src/lib/workspace/deviceId.ts` — localStorage device id (replaced by the cookie).

---

## 11. Consolidations this exposes (reuse, don't add)

- **Restore logic** is currently split across `sessionSync.ts` (`prepareRestoredState`, `isNonTrivialSession`, `workspaceStatesEqual`) and `store.tsx` (`mergeRestoredWorkspaceWithDeepLink`, `applyRestoredState`), and is re-run on every client load. → **One `workspaceRestore.ts`**, server-safe, consumed by server + client (G5/R6).
- **Device identity** had one ad-hoc owner (`deviceId.ts`, localStorage). → **One `deviceCookie.ts`**, server-owned; identity sourcing centralized in middleware + BFF.
- **Telemetry** has a channel (`nexus:web-vitals`) with no consumer. → **Reuse** the channel + the backend's existing structlog/`request_id`; add no vendor (G6/N5).
- **Loading skeletons** — reuse `PaneLoadingState` for the pane region of the shell skeleton (D8); factor a minimal AppNav skeleton rather than a new bespoke spinner.
- **Server data root** stays the single `loadWorkspaceBootstrap`; restore folds *into* it rather than spawning a parallel data path. **Pane routing** stays the single `resolvePaneRouteModel`; **prefetch** stays `paneServerLoaders` (now looped over visible panes). **Hydration cache** (`useResource` consume-once) is reused unchanged, only seeded with more keys.

---

## 12. Composition with existing systems

- **Auth.** `verifySession` remains the gate above the boundary (cheap/local; may redirect). Middleware still owns nonce + CSP + `REQUEST_PATH_HEADER` + auth redirects; the device cookie is minted alongside, on the same authenticated passthrough.
- **CSP.** Unchanged. Streaming emits no nonced preloads; PPR/`next/dynamic`/modulepreload remain out (N1/N2/D7).
- **Hydration cache / `useResource`.** Unchanged contract; seeded with all restored visible panes' `cacheKey`s. A miss → normal client fetch (one path).
- **Reader profile.** Same best-effort fetch, now concurrent in wave 1; `ReaderProvider` still owns save/retry.
- **Workspace persistence.** Capture (debounced PUT) + flush (keepalive) unchanged except the device id now comes from the cookie via the BFF; last-write-wins unchanged.
- **Backend.** `workspace_sessions` service/table unchanged. New `/internal/telemetry/web-vitals` route logs via the existing structlog + `request_id` middleware.

---

## 13. Risks & mitigations

- **Skeleton↔shell visual discontinuity.** Mitigate via D8 (skeleton = chrome's first frame; pane region = `PaneLoadingState`); AC-3 asserts presence, manual/Playwright visual check for fidelity.
- **Cross-viewport width settle visible.** Bounded to column widths within the first frame; same-device reload is a no-op (persisted widths match). Acceptable per D5.
- **Cold-JWKS TTFB.** `verifySession` is local with a warm JWKS cache; a cold cache adds one hop process-wide (not per-request). If ever material, warm JWKS at boot — noted, not a slice.
- **Speculative URL-pane seed wasted on bare landing.** One best-effort fetch, deadline-bounded, never blocks the stream (D6). `log`/metric the seed hit-rate via RUM if desired.
- **httpOnly cookie + capture.** Client never needs the id (BFF injects); AC-6 covers PUT-without-client-id.

---

## 14. Out of scope / future

Full pane-body SSR (N3); JWKS warmup; RUM dashboards beyond structured logs; performance budgets for non-authenticated routes; INP optimization of the heaviest panes (separate, post-measurement).

---

## 15. Implementation divergences (as built)

The cutover shipped; these are the places the implementation deliberately diverged from the design sketch above. Each was the simpler/sounder choice; the sections above are kept as the original design record, and this section is the authority on what actually exists.

- **No `WorkspaceIdentity` type, no `mergeRestoredIdentity`, no `createWorkspaceStateFromServer` (§3.1, §3.3, §5.4, §5.6, §3.2 line `store init`).** The resolver reuses `WorkspaceState` directly. The single merge — `mergeRestoredWorkspaceWithDeepLink(restored, deepLink, metrics)` — runs **once, on the server** (`bootstrap.server.ts`); there is no second, client-side identity merge. The store seeds the merged `WorkspaceState` straight into `useReducer(reducer, initialState)`; column widths reconcile lazily at render in `WorkspaceHost` via `resolveEffectivePaneSizing` (`paneSizing.ts`). This removes a speculative metrics-free projection and a second merge path. AC-9's server/client *parity* is therefore carried structurally by the R6 source gate (one isomorphic module imported by both sides), not by a client re-run of the merge; the `workspaceRestore.test.ts` AC-9 case asserts determinism.

- **Restore is server-only; no `serverRestored` flag (§5.6, S5).** `useWorkspaceSession` no longer has a restore phase and `getWorkspaceSession` was deleted — there is nothing to gate, so the flag does not exist.

- **RUM uses `next/web-vitals` `useReportWebVitals` directly; the dead `nexus:web-vitals` window channel was removed, not reused (N5, §3.5, §5.7, §11).** The spec's "reuse the channel" premise was hollow — the channel had no producer wiring. `WebVitalsReporter` beacons in the `useReportWebVitals` callback. The "no new vendor / reuse structlog + `request_id`" goal is fully met.

- **Web-vitals sink is viewer-scoped `/telemetry/web-vitals`, not `/internal/telemetry/web-vitals` (§3.5, §5.7).** The FastAPI route is gated by `get_viewer` (authenticated), matching the BFF `/api/telemetry/web-vitals` proxy.

- **`AuthenticatedShellSkeleton` takes no `env` prop (§3.1, §5/§10 "env-aware").** The skeleton is a pure CSS-only loading frame (nav-rail placeholder + `PaneLoadingState`) whose appearance does not depend on `androidShell`, so it is rendered prop-less above the Suspense boundary.

- **Payload key is `nav_id` (snake_case), not `navId` (§3.5, §5.7).** The JSON boundary to FastAPI is snake_case end-to-end (Pydantic `extra="forbid"`).
