# Authenticated Shell — Honest First Paint, Server Bootstrap & Pane Code-Splitting

**Status:** Spec only — not built · **Revision 3** (owner decisions O-1…O-6 ratified; §16)
**Date:** 2026-06-02
**Type:** Hard cutover. No legacy paths, no fallbacks, no backward-compat shims, no dead code left behind.
**Owner sign-off:** Key decisions D-1…D-10 (§13) + open decisions O-1…O-6 (§16) **ratified 2026-06-02**.

> Rev-3 changelog (owner decisions ratified): O-1 budget = **≤250 KB gzip** (AC-5, CI-enforced); O-2 =
> **all** panes migrate this cutover; O-3 = trivialize **every** `(authenticated)/**/page.tsx`; O-4 =
> **reuse existing telemetry** for RUM; O-5 = **centralize FastAPI path strings into `ResourceDescriptor`
> now** (serverPath + clientPath; proxy routes derive from it, §8.1); O-6 = bootstrap deadline **500 ms,
> per-loader configurable, via `callFastAPI(…, { timeoutMs })` (aborting) — not `Promise.race`** (D-10).

> Rev-2 changelog (code-grounded review): (1) softened the dead-prefetch claim to *unreachable props*,
> not *executed-and-thrown-away* — the latter is not statically provable (§2.1); (2) added a **bounded
> bootstrap deadline** + default-profile-on-timeout (D-10 / AC-10) — `callFastAPI`'s 30 s must not become
> a TTFB gate; (3) **preserve `mounted`** as a non-render *restore-ready* ordering flag (URL→state
> projection + session restore/capture, `store.tsx:1119-1129`); only the render gate is deleted (AC-11);
> (4) **reuse the existing `x-nexus-request-path` header**, not a new `x-nexus-pathname` (D-5); (5)
> corrected the importer count (several, incl. render-bearing `store.tsx`) and clarified *lazy entrypoint*
> vs 1:1 pane:chunk (§8.5 / R6).

> One-line thesis: the "preloaded font not used within a few seconds" warning is the browser
> auditing a **broken critical-path promise**. We do not silence the warning — we make the
> authenticated shell honor the app-shell contract (static chrome paints instantly; content streams
> in), and the warning disappears as a side effect. Everything below follows from that.

---

## 1. Summary

The authenticated app is a **client-rendered workspace shell** — and that is the *correct* architecture
for it (live Web Audio graph that must survive navigation, 2–3 resizable independently-routed desktop
panes, in-flight upload tray, ProseMirror draft state; see §2.5). But its **implementation inverts the
app-shell contract**: the one thing that must be instant — the shell chrome — is the slowest thing,
because first paint is gated behind hydration **plus** a client `/api/me/reader-profile` round-trip,
behind a `<Suspense fallback={null}>`, behind a second `mounted` gate in the workspace store. The shell
also ships **~1.66 MB raw / ~500 KB gzip** of first-load JS because `paneRouteRegistry.tsx` statically
imports all ~30 pane bodies and **several always-loaded modules — including the render-bearing
`WorkspaceStoreProvider`** — import it *by value* for two metadata helpers (full importer list in §2.3).
And a server-prefetch→hydrate path that the codebase *thinks* it has is **dead code** (§2.1).

This cutover:

1. Turns `(authenticated)/layout.tsx` into a **server data root** that fetches the reader profile and
   the initial pane's data and serializes a single `WorkspaceBootstrap`.
2. Introduces a **hydration cache** keyed by `cacheKey` (React-Query-`dehydrate` shaped) so server data
   reaches the client pane router without prop-drilling — replacing the two bespoke, one dead,
   `initialData` patterns with **one** contract.
3. **Deletes every first-paint gate.** The shell renders synchronously from server-injected state.
4. **Splits `paneRouteRegistry`** into a cheap metadata table (always loaded) and a `React.lazy` render
   registry (per-pane chunks), and **preloads exactly the initial pane's chunk** — the same "preload
   only what's on the critical path" discipline that `next/font` already applies to Inter.
5. **Consolidates** the duplicated fetch hooks, loading skeletons, and pane-body boilerplate into one
   `useResource` hook, one `<PaneLoadingState>`, and one `<PaneBodyShell>`.
6. **Institutionalizes** the win: CI bundle budget on the layout entry + RUM Web-Vitals + a first-paint
   test, so the blank shell cannot silently return.

It is a **hard cutover**: the old gates, the dead prefetch props, the two fetch hooks, and the bespoke
loading notices are **removed**, not deprecated.

---

## 2. Current state — the "why"

### 2.1 The server-prefetch→hydrate path is **dead code**
`(authenticated)/layout.tsx` renders `<AuthenticatedShell/>` and **ignores `children`**:
```ts
// apps/web/src/app/(authenticated)/layout.tsx
export default async function AuthenticatedLayout() {
  await verifySession();
  return <AuthenticatedShell />;        // ← children is never a param, never rendered
}
```
Navigation is a **client-side pane router**: `WorkspaceHost` → `resolvePaneRoute(href)` →
`paneRouteRegistry.ROUTE_BINDINGS[id].render()` → `<MediaPaneBody/>` **with no props**
(`paneRouteRegistry.tsx:97` `render: () => <MediaPaneBody />`).

Meanwhile `media/[id]/page.tsx` server-fetches and passes props that **never arrive**:
```ts
// apps/web/src/app/(authenticated)/media/[id]/page.tsx  — OUTPUT DISCARDED BY THE LAYOUT
const media = (await callFastAPI<{ data: Media }>(`/media/${id}`)).data;
const initialNavigation = …callFastAPI<MediaNavigationResponse>(`/media/${id}/navigation`)…;
return <MediaPaneBody initialMedia={media} initialNavigation={initialNavigation} />;
```
Because the layout discards `children`, this page's element *is* the discarded `children`. Net effect
(statically provable): the page's `initialMedia`/`initialNavigation` props are **unreachable** from the
displayed shell — the pane router renders `<MediaPaneBody/>` with no props, so `initialMedia` is always
`null` (`MediaPaneBody.tsx:530`) and the client fetches from zero. (Whether the discarded page subtree
still *executes* server-side — i.e. a wasted `callFastAPI` per hit — is a **runtime** question we do not
assert from static reading; logs would be needed. The defect we rely on is the **unreachability**, which
is certain.) The `useAsyncResource` `skipKeyRef` hydration mechanism (`useAsyncResource.ts:29-31,45-47`)
is correct but never fed.

> Scope note: the `(oracle)` group is a **separate, genuinely server-rendered** shell that *does*
> render `children`; `OracleReadingPaneBody`'s `initialDetail` prop **works** there
> (`oracle/[readingId]/page.tsx` → `OracleReadingPaneBody.tsx:438-456`). Oracle is **out of scope**;
> its working pattern is the proven reference for the contract we generalize.

### 2.2 Two blank-paint gates
| Gate | Location | Mechanism |
|---|---|---|
| **Metrics null-gate** | `AuthenticatedShell.tsx` (`AuthenticatedWorkspace`) | `<Suspense fallback={null}>` + `{workspacePrimaryMetrics ? … : null}`; `useWorkspacePrimaryMetrics` returns `null` until a DOM probe measures (`useWorkspacePrimaryMetrics.tsx:64-72`), and the probe is skipped while the reader profile `loading` is true (`:40-44`). |
| **Store `mounted`-gate** | `lib/workspace/store.tsx:1318` | `WorkspaceStoreProvider` returns `null` until a post-mount `useEffect` reads `window.location` and dispatches `hydrate` (`:991-1004`), flipping `mounted`. |

Chain: `useReaderProfile` POSTs `/api/me/reader-profile` in a `useEffect` (`useReaderProfile.ts:45-47`)
→ `loading` flips false → probe measures → `workspacePrimaryMetrics` non-null → first gate opens →
store reads `window.location` → `mounted` true → second gate opens. **Until all of that: blank.**
None of it needs to block paint — the profile is knowable server-side (session is already verified in
the layout), the width is derivable from the profile, and the initial href is in the request URL.

### 2.3 No code-splitting; the registry god-module
`paneRouteRegistry.tsx` statically imports all ~30 pane bodies (`:32-54`). **Several** always-loaded
modules import it **by value** for two metadata helpers, dragging the entire app surface into first-load
(the table below is the full list; `store.tsx` is the **render-bearing** importer — it *is* the provider
that wraps the tree, so it cannot be treated as a leaf):

| Importer | Symbols | Needs render()? |
|---|---|---|
| `appnav/AppNav.tsx:6` | `getPaneRouteIcon`, `resolvePaneRoute` | **No** — icon/id only |
| `CommandPalette.tsx:24-25` | `getPaneRouteIcon`, `resolvePaneRoute` | **No** |
| `workspace/WorkspacePaneStrip.tsx:5` | `getPaneRouteIcon` | **No** |
| `lib/workspace/store.tsx:51` | `resolvePaneRoute` (→ `getChrome`) | **No** — chrome is static |
| `command-palette/staticCommands.ts:18` | `getPaneRouteIcon` | **No** |
| `lib/panes/paneLinkNavigation.ts:4` | `resolvePaneRoute` | **No** |
| `settings/SettingsPaneBody.tsx:7` | `getPaneRouteIcon` | **No** |
| `workspace/WorkspaceHost.tsx:4,156` | `type ResolvedPaneRoute`, `route.render()` | **Yes** — the only render caller |

Result (verified against the on-disk build): `(authenticated)/layout` first-load = **1.66 MB raw /
~500 KB gzip**; biggest chunks are markdown+highlight.js (321 KB raw / 92 KB gzip), ProseMirror
(281 KB), the reader stack, dnd-kit — **none needed for first paint**. There are **zero**
`React.lazy`/`next/dynamic` in app source. `getChrome()` is data-independent on all 30 panes (returns
literal `{title, subtitle}`; worst case calls `isAndroidShell()`), so a pure metadata table is viable.

### 2.4 Duplication to consolidate (the "centralize" mandate)
| Pattern | Count | Evidence | Action |
|---|---|---|---|
| Loading notices | 24+ | `FeedbackNotice severity="info" title="Loading X…"` across `*PaneBody.tsx` + `.titleSkeleton` (`SurfaceHeader.module.css:114-126`) | One `<PaneLoadingState>` primitive |
| Async-fetch hooks | 2 overlapping | `useAsyncResource.ts` (base) + `useApiResource.ts` (thin GET wrapper) | Merge into one `useResource` |
| Hand-rolled `useEffect` fetch | ~10 panes | `AuthorPaneBody.tsx:78-140`, `SearchPaneBody`, `Settings*PaneBody` | Migrate to `useResource` |
| Pane-body boilerplate | ~30 panes | `fetch → feedback → loading → error → data` repeated per pane | One `<PaneBodyShell>` wrapper |
| `initialData` hydration | 2 bespoke + 1 dead | `MediaPaneBody` (dead), `OracleReadingPaneBody` (works, out of scope) | One hydration-cache contract |
| Resource path strings | server vs client | `callFastAPI("/media/{id}")` vs `/api/media…` proxy | One `ResourceDescriptor` (cacheKey + serverPath + clientPath); the `/api/*` proxy derives its target from it (O-5) |

Existing primitives to **reuse, not reinvent**: `useStringIdSet` (`lib/useStringIdSet.ts`),
`PaneShell.usePaneChromeOverride` (`components/workspace/PaneShell.tsx:114-142`), `SurfaceHeader`,
`Feedback`/`FeedbackNotice` + `toFeedback()`, `apiFetch`/`isApiError` (`lib/api/client.ts`).

### 2.5 Why we keep the client shell (the architecture is justified, not drift)
- **Global player** (`lib/player/globalPlayer.tsx`): a live `AudioContext` graph (gain/compressor/
  analyser) + `<audio>` element bound in `GlobalPlayerFooter`; unmounting interrupts playback. A
  persistence test asserts "persists selected track across route changes."
- **Multi-pane** (`lib/workspace/store.tsx`): up to `MAX_PANES` resizable panes, each with its own
  href + back/forward history + optional attached secondary pane. **Cannot** map to App Router's single
  `children` or to fixed parallel-route slots.
- **Overlays**: `CommandPalette`, `AddContentTray` (holds an in-flight upload queue) must be mountable
  from any route.
- **Draft state**: ProseMirror editor in-memory doc/undo/selection (`PagePaneBody.tsx`).

→ This is a legitimate **workspace app-shell**. We fix the *implementation*, not the model.

---

## 3. Target behaviour

On a cold load of any authenticated URL (logged in):

1. **TTFB → first paint = server-rendered shell chrome** (nav rail / top bar / surface frame), in the
   **initial HTML**, painted with Inter. The Inter preload is now *used* → the console warning is gone
   intrinsically. No blank frame. No `fallback={null}`.
2. **The initial pane's data is already present** (server-prefetched into the hydration cache); its body
   chunk is **module-preloaded** so it renders without a fetch waterfall and without a skeleton flash.
3. **All other pane bodies are lazy** — their chunks load only when that pane opens.
4. Subsequent client navigation, multi-pane, audio, command palette behave **exactly as today** (no UX
   regression) — only first paint and bundle change.
5. No reader-settings reflow: the user's font-size/line-height/column-width are in the first paint
   because the profile is server-injected (zero CLS from settings application).

---

## 4. Architecture

```
 Request ─▶ middleware.ts ──(stamps x-nexus-pathname: /media/abc?…)──▶ RSC render
                                                                          │
 (authenticated)/layout.tsx  [SERVER DATA ROOT]                          │
   ├─ await verifySession()                          ── Viewer           │
   ├─ href = headers().get("x-nexus-pathname")                           │
   ├─ bootstrap = await loadWorkspaceBootstrap(href, viewer)             │
   │     ├─ readerProfile      ← callFastAPI("/me/reader-profile")  ┐ parallel
   │     └─ resources[]        ← paneServerLoaders[initialPaneId]() ┘ (Promise.all)
   ├─ ReactDOM.preload(initialPaneChunkUrl, { as: "script" })   // modulepreload the one critical pane
   └─ <AuthenticatedShell bootstrap={bootstrap} />
                                                                          ▼
 AuthenticatedShell  ["use client"]
   <BootstrapHydrationProvider value={bootstrap.resources}>   // dehydrated cache, keyed by cacheKey
     <ReaderProvider initialProfile={bootstrap.readerProfile}>      // no client fetch; no `loading` gate
       <WorkspaceStoreProvider initialHref={bootstrap.initialHref}  // synchronous init from href
                               initialMetrics={estimate(profile)}>  // non-null estimate; no probe gate
         <MobileChromeProvider>
           <CommandPalette/> <AddContentTray/>
           <div.layout> <AppNav/>            // metadata table only — no pane-body imports
             <main> <GlobalPlayerProvider>
               <WorkspaceHost/>              // renders panes via React.lazy + <Suspense fallback={<PaneLoadingState/>}>
               <GlobalPlayerFooter/>
             </GlobalPlayerProvider> </main>
           </div>
         </MobileChromeProvider>
       </WorkspaceStoreProvider>
     </ReaderProvider>
   </BootstrapHydrationProvider>

 WorkspaceHost ─▶ paneRenderRegistry[id] (React.lazy chunk) ─▶ <XPaneBody/>
                                                                  └─ useResource({cacheKey}) ─▶ reads
                                                                     BootstrapHydrationProvider cache
                                                                     (consume-once) → instant, else fetch
```

Three new seams, one deletion:
- **Server data root** (layout) + `loadWorkspaceBootstrap` + `paneServerLoaders` → server owns initial data.
- **Hydration cache** (`BootstrapHydrationProvider` + `useResource` reading it) → data reaches the client
  pane router without prop-drilling; the dead `initialMedia`/`initialNavigation` props are deleted.
- **Pane code-split** (`paneRouteTable` metadata + `paneRenderRegistry` lazy) + critical-chunk preload.
- **Gate deletion** — both gates removed; the shell renders synchronously.

---

## 5. Goals

- **G1 — Honest critical path.** Static shell chrome in the initial HTML; preloaded resources are
  actually used on first paint. LCP text is Inter, server-rendered.
- **G2 — Zero first-paint gates.** Delete the metrics null-gate and the store `mounted`-gate. The shell
  never returns `null`/blank waiting on client work.
- **G3 — One hydration contract.** Server→client initial data flows through a single `cacheKey`-keyed
  cache consumed transparently by `useResource`. No prop-drilled `initialData`. No dead prefetch.
- **G4 — Code-split by pane.** First-load JS for `(authenticated)/layout` excludes all pane-body code;
  only the initial pane's chunk is preloaded.
- **G5 — Consolidate.** One `useResource`, one `<PaneLoadingState>`, one `<PaneBodyShell>`, one
  cacheKey/serverFetch descriptor per resource. Delete `useApiResource`, the 24 bespoke loading notices,
  the ~10 hand-rolled fetches, the dead hydration props.
- **G6 — No UX regression.** Multi-pane, audio continuity, command palette, drafts, mobile chrome behave
  identically post-cutover.
- **G7 — Non-regressable.** CI bundle budget + RUM Web-Vitals + a first-paint test guard the win.

---

## 6. Non-goals

- **No server-first rewrite.** The client workspace shell stays (justified, §2.5). We are not converting
  panes to RSC or to parallel routes.
- **No PPR / Cache Components.** Foreclosed by this app's per-request **nonce CSP** (Next docs: "PPR is
  incompatible with nonce-based CSP"). We achieve a fast shell via **streaming dynamic render**, not
  prerender. (Revisit only if RUM shows TTFB is the bottleneck; that path = migrate to experimental
  hash/SRI CSP and is a separate security project. Decision D-2.)
- **No Next.js upgrade in this cutover.** The Next 16 migration (Turbopack default, `proxy.ts`/async
  `cookies()`, GA Cache Components *availability*) is a separate, merit-based workstream (D-9). Note: the
  "next/dynamic banned because fixed in ≥15.6" premise is a **myth** — there is no 15.6 and the
  dynamic-import preload-nonce bug has no documented fix. We sidestep it with `React.lazy` (D-3), not by
  upgrading.
- **No `(oracle)` changes.** Separate group; its hydration already works.
- **No backend/API contract changes.** `callFastAPI`, the FastAPI endpoints, and the `/api/*` proxies
  are reused as-is. (We only *add* a server-side caller; we change no routes.)
- **No new runtime dependency.** No React Query/SWR import — we build a ~40-line dehydration cache on the
  existing `apiFetch`. (D-4.)

---

## 7. Scope

**In:** server data root in `(authenticated)/layout.tsx`; `loadWorkspaceBootstrap` + `paneServerLoaders`
+ resource descriptors (`cacheKey`+`serverPath`+`clientPath`, with the `/api/*` proxy routes deriving their FastAPI target from them — O-5); a `timeoutMs`/`signal` option on `callFastAPI` (O-6); **reuse** the existing `x-nexus-request-path` header (hoist its duplicated constant);
`BootstrapHydrationProvider` + hydration cache; unified `useResource` (reads the cache); deletion of both
gates (edits to `AuthenticatedShell.tsx`, `useWorkspacePrimaryMetrics.tsx`, `store.tsx`); `initialProfile`
on `ReaderProvider`/`useReaderProfile`; `initialHref`/`initialMetrics` on `WorkspaceStoreProvider`;
`estimatePrimaryWidthPx`; split of `paneRouteRegistry` → `paneRouteTable` (+ `paneRenderRegistry` lazy);
critical-chunk `modulepreload`; `<PaneLoadingState>`; `<PaneBodyShell>`; migration of **all**
`(authenticated)` pane bodies to `useResource` + `<PaneBodyShell>`; trivialization of dead data-fetching
`(authenticated)/**/page.tsx`; CI bundle budget + RUM + first-paint test.

**Out:** `(oracle)`; PPR/SRI; Next 16 upgrade; backend changes; new deps; `WorkspacePaneStrip`/
`CommandPalette` ranking/behavior; the multi-pane *restore-from-persistence* (extra non-primary panes may
fetch client-side — only the URL-primary pane is on the LCP path, §13 D-6).

---

## 8. Capability contract / API design

> TypeScript shown is the **design contract**, not final code. Names follow existing repo conventions
> (`lib/workspace/*`, `lib/api/*`, `lib/panes/*`).

### 8.1 Resource descriptor — single source of identity AND paths (O-5)
```ts
// lib/api/resource.ts — ONE descriptor per fetchable resource: the single source of its identity and
// both path forms. Consumed by the client hook, the server loader, AND the matching /api/* proxy route.
export interface ResourceDescriptor<TParams, TData> {
  cacheKey: (p: TParams) => string;    // identity — shared by client hook + server prefetch
  serverPath: (p: TParams) => string;  // FastAPI path → callFastAPI(serverPath(p), …)  (server loader)
  clientPath: (p: TParams) => ApiPath; // /api/* path  → apiFetch(clientPath(p))         (useResource GET)
}
// The matching /api/* proxy route imports the SAME descriptor and proxies to serverPath(p), so no FastAPI
// path string is written twice (closes §2.4 #6 / O-5). useResource derives cacheKey + clientPath from the
// descriptor; paneServerLoaders derive cacheKey + serverPath. One edit point per resource.
```
Centralizes the server↔client path duplication (§2.4) into one descriptor — the FastAPI path lives once,
and `cacheKey` is the hydration contract both sides agree on.

### 8.2 Hydration cache (dehydrate-shaped, ~40 lines, no new dep)
```ts
// lib/api/hydrationCache.tsx
export type DehydratedResources = Record<string /*cacheKey*/, unknown>;
export function BootstrapHydrationProvider(props: {
  value: DehydratedResources; children: ReactNode;
}): JSX.Element;
// Consume-once: returns the seeded value for a cacheKey the FIRST time it is read, then forgets it
// (so later client navigations to the same key fetch fresh). Internally a React context over a Map.
export function useHydratedInitialData<T>(cacheKey: string | null): T | undefined;
```

### 8.3 Unified resource hook (merges the two hooks; reads the cache)
```ts
// lib/api/useResource.ts  (REPLACES useAsyncResource.ts + useApiResource.ts)
export type AsyncResource<T> =
  | { status: "idle" } | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: ApiError; retry: () => void };

export function useResource<T, P = void>(args:
  | { descriptor: ResourceDescriptor<P, T>; params: P | null }    // PREFERRED — derives cacheKey + clientPath
  | { cacheKey: string | null; path: (k: string) => ApiPath }     // GET, ad-hoc
  | { cacheKey: string | null; load: (s: AbortSignal) => Promise<T> } // custom load
): AsyncResource<T>;
// Behavior: if useHydratedInitialData(cacheKey) is present → init {status:"ready"} and skip the first
// fetch (same effect as today's skipKeyRef, but sourced from the cache, not a prop). Keeps the existing
// 3×-retry/backoff/abort logic verbatim.
```

### 8.4 Server bootstrap
```ts
// lib/workspace/bootstrap.server.ts  (RSC-only; "server-only" import guard)
export interface WorkspaceBootstrap {
  readerProfile: ReaderProfile;        // never null — server resolves or DEFAULT_READER_PROFILE
  initialHref: string;                 // normalized; falls back to WORKSPACE_DEFAULT_FALLBACK_HREF
  initialPaneId: PaneRouteId;          // for chunk preload
  resources: DehydratedResources;      // keyed by cacheKey; best-effort per resource
}
export function loadWorkspaceBootstrap(href: string, viewer: Viewer): Promise<WorkspaceBootstrap>;
// BOUNDED & ABORTING (D-10): every prefetch uses callFastAPI(serverPath(p), { timeoutMs: 500 }) — the
// 500 ms deadline lives in callFastAPI (which already owns abort/request-id/auth/ApiError), NOT a
// Promise.race that would leave the FastAPI request running. Per-loader timeoutMs override allowed.
// readerProfile also falls back to DEFAULT_READER_PROFILE within the SAME 500 ms; a timed-out/failed
// resource is omitted from `resources` and the client useResource path fetches it. Never a TTFB gate.
```
```ts
// lib/panes/paneServerLoaders.ts — mirrors the client registry, server side. Only deep-linkable panes.
export const paneServerLoaders: Partial<Record<PaneRouteId,
  (ctx: { params: PaneRouteParams; viewer: Viewer }) => Promise<{ cacheKey: string; data: unknown }[]>
>>;
// A loader for `media` returns [{cacheKey:`media:${id}`, data}, {cacheKey:`media:${id}:nav`, data?}],
// built from the resource DESCRIPTORS (callFastAPI(serverPath(p), {timeoutMs:500})) so its cacheKeys line
// up exactly with what the client useResource reads.
// A failed/timed-out loader (or one entry) is OMITTED from the cache → the client hook fetches it normally.
// This is per-resource resilience, NOT a legacy fallback: there is one code path; prefetch is an
// optimization layered on it.
```

### 8.5 Pane route table (metadata, no pane-body imports) + lazy render registry
```ts
// lib/panes/paneRouteTable.ts  — imported by AppNav, CommandPalette, WorkspacePaneStrip, staticCommands,
//                                 paneLinkNavigation, SettingsPaneBody, store(getChrome). NO bodies.
export interface PaneRouteMeta {
  icon: LucideIcon;
  getChrome: (ctx: PaneRouteContext) => PaneChromeDescriptor; // data-independent (verified)
  load: () => Promise<{ default: ComponentType }>;            // dynamic import of the pane body
}
export const PANE_ROUTE_TABLE: Record<PaneRouteId, PaneRouteMeta>;
export function getPaneRouteIcon(href: string): LucideIcon;   // unchanged signature
export function resolvePaneRoute(href: string): ResolvedPaneRoute; // now WITHOUT a render() field

// lib/panes/paneRenderRegistry.tsx — imported ONLY by WorkspaceHost.
const LAZY = mapValues(PANE_ROUTE_TABLE, m => lazy(m.load));   // React.lazy per pane
export function renderPane(id: PaneRouteId): ReactNode;        // <Suspense fallback={<PaneLoadingState/>}><Lazy/></Suspense>
export function paneChunkHref(id: PaneRouteId): string | null; // for modulepreload in the layout
```
Each pane body becomes a lazy **entrypoint** (`React.lazy(import())`); the bundler decides chunk
boundaries. Panes that transitively import other pane bodies (e.g. `NotePaneBody`/`DailyNotePaneBody` →
`PagePaneBody`, `ConversationsPaneBody` → `Conversation`) may **share** chunks — that is fine. The
invariant (R4 / R6) is *the always-loaded shell entry contains no pane body*, **not** a 1:1 pane:chunk
mapping. `paneChunkHref` returns the entrypoint URL to `modulepreload` for the initial pane only.

### 8.6 Shell composition seams
```ts
ReaderProvider(props: { children; initialProfile: ReaderProfile });          // + initialProfile
useReaderProfile(opts: { initialProfile?: ReaderProfile });                  // seed + skip first POST
WorkspaceStoreProvider(props: { children; initialHref: string; initialMetrics: WorkspacePrimaryMetrics });
useWorkspacePrimaryMetrics(initial: WorkspacePrimaryMetrics): { metrics: WorkspacePrimaryMetrics; probe }; // metrics NEVER null
estimatePrimaryWidthPx(profile: ReaderProfile): WorkspacePrimaryMetrics;     // pure; server + client
```

### 8.7 Consolidation primitives
```ts
// components/workspace/PaneLoadingState.tsx — one skeleton; Suspense fallback + replaces 24 notices.
PaneLoadingState(props?: { label?: string });
// components/workspace/PaneBodyShell.tsx — encodes idle/loading/error/ready once.
PaneBodyShell<T>(props: { resource: AsyncResource<T>; children: (data: T) => ReactNode; loading?: ReactNode });
```

---

## 9. How it composes with existing systems

- **middleware.ts / CSP**: already generates the per-request nonce and runs on every request, and already
  stamps **`x-nexus-request-path`** (read today by `auth/dal.ts`). We **reuse** that header — no new one,
  no CSP change. Dynamic render is *required* by nonce-CSP and is exactly what we keep (D-2). The matcher
  still excludes `_next/static` (fonts untouched).
- **Auth DAL**: `verifySession()` (`dal.ts:69`, React-`cache()`d) already runs in the layout; we now use
  its `Viewer` and the active session cookie via `callFastAPI` (`server.ts:35`) to prefetch — the exact
  toolkit `(oracle)` already uses. `refreshable` sessions are redirected by middleware before render, so
  the cookie is `active` at prefetch time.
- **AppNav (post-navigation-unification)**: imports only `getPaneRouteIcon`/`resolvePaneRoute` from the
  new metadata table — it already needs no pane bodies, so it simply stops pulling them transitively.
- **Global player / WorkspaceHost / multi-pane**: unchanged behavior. The store now initializes
  synchronously from `initialHref` instead of post-mount `window.location`; multi-pane build-up,
  history, resize, and the audio graph are identical.
- **`next/font`**: untouched. Inter stays root-declared and preloaded; it is now *used* on first paint.
  This cutover is the real fix the font-preload investigation pointed at.

---

## 10. File plan

**New**
- `apps/web/src/lib/workspace/bootstrap.server.ts` — `loadWorkspaceBootstrap`, `WorkspaceBootstrap`.
- `apps/web/src/lib/panes/paneServerLoaders.ts` — server loaders per deep-linkable pane.
- `apps/web/src/lib/api/resource.ts` — `ResourceDescriptor`, cacheKey builders.
- `apps/web/src/lib/api/hydrationCache.tsx` — `BootstrapHydrationProvider`, `useHydratedInitialData`.
- `apps/web/src/lib/api/useResource.ts` — unified hook (replaces the two below).
- `apps/web/src/lib/panes/paneRouteTable.ts` — metadata table (icon/getChrome/load).
- `apps/web/src/lib/panes/paneRenderRegistry.tsx` — `React.lazy` render + `paneChunkHref`.
- `apps/web/src/lib/workspace/primaryMetrics.ts` — `estimatePrimaryWidthPx` (pure).
- `apps/web/src/components/workspace/PaneLoadingState.tsx` (+ `.module.css`).
- `apps/web/src/components/workspace/PaneBodyShell.tsx`.

**Modified**
- `app/(authenticated)/layout.tsx` — server data root: read header, `loadWorkspaceBootstrap`, preload
  initial chunk, render `<AuthenticatedShell bootstrap={…}/>`.
- `app/(authenticated)/AuthenticatedShell.tsx` — consume `bootstrap`; **delete** Suspense/metrics gate;
  wrap in `BootstrapHydrationProvider`; pass `initialProfile`/`initialHref`/`initialMetrics`.
- `lib/reader/ReaderContext.tsx`, `lib/reader/useReaderProfile.ts` — accept/seed `initialProfile`; the
  client POST becomes save-only (no load-on-mount).
- `lib/workspace/useWorkspacePrimaryMetrics.tsx` — never return null; seed from `initialMetrics`; probe
  **refines** post-paint, never gates.
- `lib/workspace/store.tsx` — `initialHref`/`initialMetrics` props; init state **synchronously** from
  `initialHref`; **delete** the `window.location` initial-hydrate dispatch (`:991-1004`) and the
  `if (!mounted) return null` **render** gate (`:1318`). **Preserve** `mounted`/`readyRef` as a non-render
  *restore-ready* ordering flag — it still gates the URL→state projection effect (`:1119-1129`) and
  workspace-session restore/capture. The cutover changes *when the shell paints*, not the ordering of
  post-hydration side-effects.
- `middleware.ts` / `lib/supabase/middleware.ts` — **reuse** the existing `x-nexus-request-path` header
  (already stamped; already read by `auth/dal.ts:13`). Hoist the duplicated `REQUEST_PATH_HEADER` constant
  (`supabase/middleware.ts:17` + `dal.ts:13`) into one shared module imported by all readers. Confirm it
  carries pathname **+ search** (extend the stamp if pathname-only); the URL **hash never reaches the
  server** (applied client-side post-hydration).
- `components/workspace/WorkspaceHost.tsx` — call `renderPane(id)` (lazy + Suspense) instead of
  `route.render()`.
- `appnav/AppNav.tsx`, `CommandPalette.tsx`, `WorkspacePaneStrip.tsx`, `command-palette/staticCommands.ts`,
  `lib/panes/paneLinkNavigation.ts`, `settings/SettingsPaneBody.tsx`, `lib/workspace/store.tsx` — import
  from `paneRouteTable` instead of `paneRouteRegistry`.
- **All** `(authenticated)` pane bodies — migrate to `useResource` + `<PaneBodyShell>` + `<PaneLoadingState>`;
  delete `MediaPaneBody`'s dead `initialMedia`/`initialNavigation` props (data now via cache).
- `(authenticated)/**/page.tsx` — reduce **every** page to a uniform trivial route marker (O-3); the
  former server fetches (`media/[id]`, settings server pages) move into `paneServerLoaders` (preflight
  AC-0 first).
- `lib/api/server.ts` — add `{ timeoutMs?, signal? }` to `callFastAPI` (O-6 / D-10); the deadline + abort
  live here (it already owns request-id/auth/ApiError), not in callers.
- `app/api/**/route.ts` (the `/api/*` proxy routes) — derive each FastAPI target from its
  `ResourceDescriptor.serverPath` (O-5); no FastAPI path string written twice. (Larger surface — one edit
  per proxied resource.)

**Deleted**
- `apps/web/src/lib/useAsyncResource.ts` and `apps/web/src/lib/api/useApiResource.ts` (folded into
  `useResource`).
- The dead prefetch body of `media/[id]/page.tsx` and the `initialMedia`/`initialNavigation` props.
- The ~24 inline `FeedbackNotice severity="info" title="Loading…"` loading branches (→ `<PaneLoadingState>`).
- Both **render** gates (the `{metrics ? … : null}` conditional + the `if (!mounted) return null` return).
  NOT `mounted` itself — it survives as the restore-ready ordering flag (see Modified ▸ `store.tsx`).

---

## 11. Final state — rules / invariants

- **R1.** `(authenticated)/layout.tsx` is the **only** server data root for the workspace; no
  `(authenticated)/**/page.tsx` fetches data for render (they are trivial markers). No RSC output is
  silently discarded.
- **R2.** Server→client initial data flows **only** through the hydration cache keyed by `cacheKey`.
  No component takes an `initialX` data prop for hydration. There is exactly one `initialData` mechanism.
- **R3.** The authenticated shell **never** renders `null`/blank as a first-paint gate. Any not-yet-ready
  content is a streamed `<Suspense>` boundary with a **visible** `<PaneLoadingState>` fallback, not a
  blank document.
- **R4.** Pane bodies are imported **only** through `paneRenderRegistry` (`React.lazy`). No module that is
  part of the always-loaded shell may statically import a pane body. (Lint-enforced, §14.)
- **R5.** There is **one** async-resource hook (`useResource`), **one** loading primitive
  (`PaneLoadingState`), **one** pane-body wrapper (`PaneBodyShell`). The old hooks/notices are gone.
- **R6.** No pane body is eagerly bundled into the always-loaded shell entry; pane bodies are reached only
  via lazy entrypoints (§8.5). Exactly one pane's chunk(s) are `modulepreload`-ed per load — the initial
  pane's. Chunk boundaries are the bundler's call (transitively-shared chunks are fine); the invariant is
  *shell entry contains no pane body*, not 1:1 pane:chunk. (Budget-enforced, §15.)

---

## 12. Acceptance criteria

- **AC-0 (preflight).** A code-grounded pass confirms **no** `(authenticated)` route depends on `children`
  rendering (i.e., all content routes through the pane router) before any page is trivialized. Any
  exception is listed and handled explicitly.
- **AC-1.** Cold load of `/` and of a deep route (e.g. `/media/:id`) shows server-rendered Inter chrome in
  the **initial HTML** (assert via `curl`/RSC payload: nav landmarks + title text present pre-hydration).
- **AC-2.** The "preloaded font … not used within a few seconds" console warning **no longer fires** on the
  authenticated shell (manual + a Playwright console-assertion).
- **AC-3.** No `<Suspense fallback={null}>` and no `return null` first-paint gate remain in the
  authenticated shell path (grep + review).
- **AC-4.** The initial pane renders with **zero** client data fetch for its primary resource (network
  panel shows the resource was server-prefetched; hydration cache hit). Other panes still fetch on open.
- **AC-5.** `(authenticated)/layout` first-load JS (gzip) drops to **≤ 250 KB gzip** (O-1; CI-enforced
  ceiling; ~½ of today's ~500 KB) and contains **no** markdown/highlight.js/ProseMirror/reader chunk.
- **AC-6.** No UX regression: audio continuity across pane switches, multi-pane open/resize/history,
  command palette, add-content upload queue, ProseMirror drafts, mobile chrome — all pass existing e2e +
  new tests.
- **AC-7.** Reader settings (font size/line-height/column-width) apply on first paint with **no** visible
  reflow (CLS unaffected; assert profile present in initial render).
- **AC-8.** Exactly one async-resource hook, one loading primitive, one pane-body wrapper exist; the two
  old hooks and the 24 inline loading notices are deleted (grep counts = 0).
- **AC-9.** `bun run` typecheck + lint clean; unit + browser test projects green; the new lint rule (R4)
  fails the build if a shell module imports a pane body.
- **AC-10 (bootstrap deadline).** Bootstrap prefetches use `callFastAPI(…, { timeoutMs: 500 })` (O-6); a
  simulated slow upstream is **aborted** at 500 ms (assert the FastAPI request is cancelled, not merely
  ignored), the shell renders with `DEFAULT_READER_PROFILE` + empty cache, and the client hydrates/fetches
  normally. TTFB delta vs baseline stays within budget (RUM).
- **AC-11 (ordering preserved).** Workspace URL→state projection and session restore/capture ordering is
  unchanged: the `mounted`/restore-ready flag still gates those effects (`store.tsx:1119-1129`); a
  regression test asserts projection does not fire before restore-ready. Only the *render* gate is removed.

---

## 13. Key decisions

- **D-1 — Bootstrap payload, not parallel routes.** Server data reaches the client pane router via a
  serialized `WorkspaceBootstrap` + hydration cache. Parallel routes can't express 2–3 equal resizable
  panes; the bootstrap only needs the **single URL-primary** pane on the critical path.
- **D-2 — Keep nonce CSP; achieve speed via streaming, not PPR.** Per Next docs PPR ⊥ nonce-CSP. Dynamic
  render is required and sufficient — a streamed dynamic shell is instant. PPR/SRI deferred (Non-goal).
- **D-3 — `React.lazy`, not `next/dynamic`.** The dynamic-ban is about server-emitted preload `<link>`
  nonces; client-only `React.lazy` doesn't emit them. We **verify** under the real strict CSP (AC), not
  inherit folklore. No Next upgrade needed for code-splitting.
- **D-4 — Hand-rolled hydration cache, no React Query.** ~40 lines over `apiFetch`; a full data-layer dep
  is unjustified for a single-user prototype (aligns with the "simple, delete complexity" project stance).
- **D-5 — Reuse the existing `x-nexus-request-path` header.** Layouts can't read the pathname natively;
  the repo already stamps `x-nexus-request-path` in middleware and reads it in `auth/dal.ts` — we reuse it
  (and hoist its duplicated constant), **not** invent `x-nexus-pathname`. The layout resolves the initial
  pane with the same `resolvePaneRouteModel` the client uses (one resolver). Constraint: the header carries
  pathname(+search); the URL **hash never reaches the server**, so hash-encoded pane state is applied
  client-side after hydration (not on the LCP path).
- **D-6 — Only the URL-primary pane is prefetched.** Multi-pane restore (if any) hydrates client-side; its
  extra panes are not LCP. Prefetching all restored panes is a follow-on, not this cutover.
- **D-7 — Preload exactly the initial pane chunk.** Mirror `next/font`'s discipline: code-split
  everything, preload only what's provably on the critical path (`ReactDOM.preload`/`modulepreload`).
- **D-8 — Best-effort prefetch is resilience, not a fallback.** One code path (the `useResource` fetch);
  a missing cache entry just means the hook fetches. This is not a legacy/back-compat shim.
- **D-9 — Next 16 upgrade is out of scope** and is *not* a prerequisite (the ban-lift premise is a myth).
  Tracked separately on its own merits.
- **D-10 — Bootstrap prefetch deadline is explicit and aborting (500 ms).** `loadWorkspaceBootstrap`
  treats the reader profile and initial-pane resources as *paint-adjacent, not paint-blocking*. Each
  bootstrap FastAPI prefetch uses `callFastAPI(…, { timeoutMs: 500 })` (per-loader configurable); timeout
  or failure **omits** that resource from the hydration cache and the client `useResource` path fetches it
  normally. **Do not** wrap these in `Promise.race` without aborting the underlying request — `callFastAPI`
  already owns request deadlines, abort, request IDs, auth forwarding, and `ApiError` shaping, so the
  deadline belongs in that owner layer (`server.ts`), not in callers. The reader profile likewise falls
  back to `DEFAULT_READER_PROFILE` **within the same 500 ms budget**, so it can never block first paint.
  500 ms (not 300) because a cold backend hop needs the headroom while still being clearly *paint-first*.

---

## 14. Lint / structural enforcement (R4)

Add an ESLint `no-restricted-imports` (or a small custom rule) forbidding imports of any
`*PaneBody`/pane-implementation module from the always-loaded shell set (`appnav/**`, `CommandPalette`,
`WorkspacePaneStrip`, `staticCommands`, `paneLinkNavigation`, `store.tsx`, `paneRouteTable.ts`). Pane
bodies are reachable **only** via `paneRenderRegistry`'s dynamic `import()`. This makes the bundle win
**structural**, not a one-time cleanup — the registry fan-out cannot silently grow back.

---

## 15. Rollout, budgets & verification

1. **Measure first.** Record current `(authenticated)/layout` first-load (≈500 KB gzip) and CWV from RUM
   as the baseline.
2. **Land in slices** behind the hard cutover (no flags), in dependency order:
   (a) `useResource` + hydration cache + `PaneLoadingState`/`PaneBodyShell` (no behavior change yet);
   (b) registry split + `React.lazy` + lint rule (bundle drop);
   (c) server data root + bootstrap + gate deletion (first-paint fix);
   (d) migrate pane bodies + trivialize pages + delete dead code.
3. **CI budget** (size-limit or the Next build budget) on the layout entry — ceiling **locked at ≤250 KB
   gzip** (O-1 / AC-5); the post-(b) measurement must land at or under it.
4. **RUM** via the **existing telemetry sink** (O-4): `web-vitals` → the repo's current telemetry (no new
   vendor) with **LCP/INP/CLS/TTFB** SLOs on the authenticated routes.
5. **Tests:** Playwright console-warning assertion (AC-2); initial-HTML-contains-chrome assertion (AC-1);
   hydration-cache-hit / no-initial-fetch test (AC-4); audio-continuity + multi-pane regression (AC-6);
   first-paint-not-blank test. (Browser project per the repo's vitest split.)

---

## 16. Owner decisions — RATIFIED (2026-06-02)

- **O-1 ✓ ≤ 250 KB gzip.** Locked as the CI-enforced ceiling on the `(authenticated)/layout` first-load
  (AC-5, §15).
- **O-2 ✓ All panes this cutover.** Every `(authenticated)` pane body migrates to `useResource` +
  `<PaneBodyShell>` now — no fast-follow (hard-cutover / no-legacy).
- **O-3 ✓ Trivialize every page.** **All** `(authenticated)/**/page.tsx` become uniform trivial markers
  (R1); the ~25-file sweep is in scope. Former server fetches move to `paneServerLoaders`.
- **O-4 ✓ Reuse existing telemetry.** RUM Web-Vitals flow into the repo's current telemetry sink; no new
  vendor (§15.4).
- **O-5 ✓ Centralize FastAPI paths now.** `ResourceDescriptor` owns `serverPath` + `clientPath`; the
  `/api/*` proxy routes derive their target from it (§8.1, §10). Accepts the larger proxy-route surface.
- **O-6 ✓ 500 ms, aborting, in `callFastAPI`.** Per-loader-configurable `timeoutMs` on `callFastAPI`
  (which aborts the underlying request); **not** `Promise.race`. Reader profile defaults within the same
  budget. Baked into D-10.

---

## 17. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| A route secretly depends on `children` → trivializing pages 404s/blanks it | Low | AC-0 preflight; explicit exception list |
| `React.lazy` still trips the strict-CSP preload-nonce bug | Low–Med | D-3 empirical verification under real CSP before relying on it; fallback is eager-import that one pane (kept off the shell) |
| Server prefetch adds TTFB (extra `callFastAPI` before HTML) | Med | **Aborting 500 ms deadline via `callFastAPI(…, { timeoutMs: 500 })` (D-10 / AC-10)** — *not* the 30 s default, *not* a non-aborting `Promise.race`; on timeout the FastAPI request is cancelled and the resource is omitted (client fetches, D-8); reader profile defaults within the same budget. Runs after the already-awaited `verifySession`. |
| Width estimate ≠ measured → post-paint pane resize jump | Med | `estimatePrimaryWidthPx` tuned to Inter metrics; refine within one frame; pane width is not LCP text |
| Pane-body migration surface is large | Med | Mechanical; `<PaneBodyShell>` is a thin wrapper; land in slice (d); lint rule prevents backslide |
| Multi-pane restore panes fetch client-side | Low | Accepted (D-6); not on LCP path |

---

## 18. One-paragraph rationale (for reviewers)

We are not fixing a font warning. We are making the authenticated shell obey the app-shell contract it
already implicitly chose: **static chrome instant, content streamed.** The shell is a justified client
workspace (audio graph, multi-pane, drafts) whose implementation inverted that contract by gating the
instant part behind a client fetch and two `null` gates, while shipping every pane's code on first load
and leaving its own server prefetch **unreachable** from the displayed shell. The cutover moves data fetching to a single server root, threads
it through one hydration cache, deletes the gates, code-splits the panes behind one lazy registry, and
consolidates three families of duplication into one hook / one skeleton / one wrapper — then locks the
result with a lint rule, a CI bundle budget, and RUM. The font preload becomes *used*, the warning
vanishes, first paint becomes real, and the win cannot silently regress.
