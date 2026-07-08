# Oracle without the wall — dissolve the shell, keep the manuscript — Hard Cutover

**Status:** Spec · **Rev 1** · 2026-07-07
**Type:** Hard cutover — no legacy code, no fallbacks, no compat shims, no flags-for-old-behavior.

## One-line

Delete the `(oracle)` Next.js route group and its bespoke shell; register three oracle pane bodies in the workspace pane system so the manuscript aesthetic and SSE streaming survive intact, attached now to the product shell rather than a parallel universe that requires a full-page navigation to enter.

---

## 0. Prerequisites (hard, no fallback)

- **P-1.** The universal-launcher cutover (`universal-launcher-hard-cutover.md`) is BUILT. The `externalShell` flag on the oracle destination (`lib/navigation/destinations.ts:86`) is the mechanism the launcher and nav rail use to escape to a full-shell navigation. This spec flips it; the launcher's dispatch path must already exist and be tested.
- **P-2.** The pane render registry (`lib/panes/paneRenderRegistry.tsx`) and route model (`lib/panes/paneRouteModel.ts`) are the stable extension points used by all 26 existing pane routes. No new primitive is introduced.
- **P-3.** `app/(authenticated)/*/page.tsx` returns `null` for every authenticated route — the workspace host ignores page content and renders the correct pane from the URL. Verified: `libraries/page.tsx`, `media/[id]/page.tsx`, and 24 others all export `export default function Page() { return null; }`.

---

## 1. Problem (grounded diagnosis)

### 1.1 A parallel universe

The Oracle lives at `app/(oracle)/` — a route group that owns its own `layout.tsx`, its own shell component (`OracleShell.tsx`), its own sticky-header back-link pattern, and its own auth boundary. To open Oracle today the launcher calls `window.location.assign('/oracle')` (verified: `destinations.ts:87 externalShell: true`; `lib/launcher/dispatch.ts:70 window.location.assign`). The nav rail falls through to the same result (`AppNav.tsx:114`: `resolvePaneRoute(href).id === "unsupported"` → early return skips `event.preventDefault()` → the native anchor default produces a full-page navigation). This is a full-page navigation away from the workspace, discarding the reader, the active chat, and every open pane.

### 1.2 The shell does nothing the workspace doesn't already do

`OracleShell.tsx` renders: a sticky top bar with a back link, a `UnauthenticatedApiBoundary`, and a `SessionRefresher`. After the cutover every oracle pane body is a child of `AuthenticatedShell` — which already owns `UnauthenticatedApiBoundary` (line 43) and `SessionRefresher` (line 44). The back link is a dead affordance: in-pane navigation is handled by `requestOpenInAppPane`.

### 1.3 The shell also steals the sticky headline

`OracleShell.tsx` exports `useStickyHeadline` — an `IntersectionObserver` hook that watches a page element and floats its text into the shell's top-bar `<div aria-live="polite">`. Both `OracleReadingPaneBody.tsx:419` and `AtlasPaneBody.tsx:248` depend on this hook via import path `"../../OracleShell"`. The pane shell (`PaneShell.tsx`) already provides a `SurfaceHeader` that owns the pane title. The sticky-headline mechanism is redundant; deleting it removes a duplicated scroll-observation concern.

### 1.4 The font landmine

`(oracle)/layout.tsx` declares three Google Fonts via `next/font`: `EB_Garamond`, `IM_Fell_English`, `UnifrakturMaguntia`. The root `app/layout.tsx` deliberately excludes them, commenting (line 40–45): *"EB Garamond / IM Fell / Unifraktur are owned by the (oracle) route group…so they only preload on /oracle routes where they are actually render-critical."* After the route group is deleted, these declarations have no valid Next.js home — `next/font` cannot be called inside a lazy pane component or a non-layout module.

---

## 2. Target behavior (user-facing)

- Pressing Oracle in the nav rail or Launcher **opens the oracle landing as a pane** — no full-page reload, no loss of context.
- Navigating to `/oracle`, `/oracle/atlas`, `/oracle/[readingId]` works normally; the workspace picks up the URL and renders the correct pane.
- The manuscript aesthetic — Black Forest Oracle dark theme, EB Garamond body, IM Fell English display, UnifrakturMaguntia fraktur headers, illuminated capitals, folio ornaments, sidenotes, concordance — is unchanged.
- The SSE reading stream (token-by-token oracle generation) is unaffected.
- The plate image proxy (`/api/oracle/plates/[id]`) is unaffected.
- Deep links to `/oracle/[readingId]` open the workspace with that reading in the active pane.

---

## 3. Goals / Non-goals

### Goals
- **G1.** Delete `app/(oracle)/` entirely — layout, shell, shell CSS, back-link logic, `useStickyHeadline`, `HeadlineContext`.
- **G2.** Register three new pane routes (`oracle`, `oracleAtlas`, `oracleReading`) in `PaneRouteId`, `PANE_ROUTE_MODELS`, `PANE_ROUTE_META`, and `PANE_LOADERS`.
- **G3.** Move the five oracle content components (`OracleLandingPaneBody`, `OracleReadingPaneBody`, `AtlasPaneBody`, `OracleAlephGrid`, `OracleConcordance`) under `(authenticated)/oracle/`, add `(authenticated)/oracle/page.tsx` stubs.
- **G4.** Replace `externalShell: true` with `externalShell: false` on the oracle destination; the launcher and nav rail now open oracle as a pane.
- **G5.** Carry the `data-theme="oracle"` scope and font variables into pane-land via a thin `OracleThemeWrapper` component used by each oracle pane body.
- **G6.** Solve the font landmine: move the three oracle `next/font` declarations to the root layout with `preload: false`.

### Non-goals
- **N1.** No change to oracle backend routes (`/oracle/readings`, `/oracle/plates`, `/stream/oracle-readings/`).
- **N2.** No change to the oracle data model, oracle generation job, or the `useGenerationRun` hook.
- **N3.** No change to `oracle.module.css`, `atlas.module.css`, `IlluminatedCapital`, `BorderFrame`, `Sidenote` — the manuscript elements are preserved verbatim.
- **N4.** No secondary pane groups for oracle — oracle is `bodyMode: "document"`, no `secondaryGroups`, no reader tools.
- **N5.** Dynamic pane title via `PaneFixedChromePublication` — the pane chrome shows a static title ("Reading" or "The Atlas"); the folio motto continues to render inline in the manuscript, not in the chrome bar. A follow-up can publish the motto dynamically.

---

## 4. Architecture and final state

### 4.1 Ownership map (final)

| Concern | Before | After |
|---|---|---|
| `/oracle` route | `app/(oracle)/oracle/page.tsx` | `app/(authenticated)/oracle/page.tsx` (null stub) |
| `/oracle/atlas` route | `app/(oracle)/oracle/atlas/page.tsx` | `app/(authenticated)/oracle/atlas/page.tsx` (null stub) |
| `/oracle/[readingId]` route | `app/(oracle)/oracle/[readingId]/page.tsx` | `app/(authenticated)/oracle/[readingId]/page.tsx` (null stub) |
| Oracle pane render | OracleShell → page children | `WorkspaceHost` → `PANE_LOADERS["oracle"/"oracleAtlas"/"oracleReading"]` |
| data-theme oracle scope | `(oracle)/layout.tsx` wrapper div | `OracleThemeWrapper` in each pane body |
| Oracle fonts | `next/font` in `(oracle)/layout.tsx` | `next/font` in root `app/layout.tsx`, `preload: false` |
| UnauthenticatedApiBoundary | OracleShell | AuthenticatedShell (already present) |
| SessionRefresher | OracleShell | AuthenticatedShell (already present) |
| Oracle nav action | `window.location.assign('/oracle')` | `requestOpenInAppPane('/oracle')` |

### 4.2 OracleThemeWrapper

```tsx
// apps/web/src/app/(authenticated)/oracle/OracleThemeWrapper.tsx
export default function OracleThemeWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div data-theme="oracle" style={{ display: "contents" }}>
      {children}
    </div>
  );
}
```

The three pane body entry points (`OracleLandingPaneBody`, `OracleReadingPaneBody`, `AtlasPaneBody`) each wrap their root element with `<OracleThemeWrapper>`. The `display: contents` keeps the wrapper out of the layout/scroll model, exactly as in the old layout. The `[data-theme="oracle"]` block in `globals.css:249–261` — nine CSS custom properties (`--oracle-bg`, `--oracle-fg`, `--oracle-gold`, etc.) plus the three `--font-oracle-*` family aliases — cascades to all descendants.

### 4.3 Pane route additions

Three new `PaneRouteId` values and route model entries added to `paneRouteModel.ts`:

| id | pattern | staticTitle | titleMode | bodyMode |
|---|---|---|---|---|
| `oracle` | `["oracle"]` | `"Oracle"` | `static` | `document` |
| `oracleAtlas` | `["oracle", "atlas"]` | `"The Atlas"` | `static` | `document` |
| `oracleReading` | `["oracle", ":readingId"]` | `"Reading"` | `static` | `document` |

`oracleAtlas` MUST precede `oracleReading` in the `PANE_ROUTE_MODELS` array — `atlas` is a literal segment that must not be captured by `:readingId`. Both use `STANDARD_WIDTH_CONTRACT`. No `secondaryGroups`.

### 4.4 Font resolution: root layout with preload: false

**The landmine.** `next/font` is a build-time transform that must execute at module initialization in a layout or page — it cannot run inside a lazy pane component. The three oracle fonts currently live in the `(oracle)/layout.tsx` because (per the comment at `app/layout.tsx:40–45`) declaring them in the root layout would emit `<link rel="preload">` on every route, triggering browser "preloaded but not used" warnings on non-oracle pages.

**Solution: `preload: false`.** The root layout already uses this for JetBrains Mono (`app/layout.tsx:53–60`, `preload: false`): it keeps the `@font-face` CSS and the `--font-jetbrains-mono` CSS variable without emitting a preload link. The same pattern applies to the three oracle fonts. With `preload: false`, the font files are declared in the global CSS and download only when the oracle pane renders (when `var(--font-oracle-body)` is first referenced by a visible element). There are no preload warnings on non-oracle routes, and no CLS regression — `display: swap` is preserved.

The three font-variable class names (`ebGaramond.variable`, `imFellEnglish.variable`, `unifrakturMaguntia.variable`) move from the oracle layout's `div.className` onto `<html className={...}>` in the root layout. Because `[data-theme="oracle"]` only accesses these variables when the oracle theme wrapper is present, the font CSS is inert on non-oracle routes.

**Rejected alternative: self-hosted `@font-face` in `public/fonts/`.** This would require downloading Google Fonts woff2 binaries, committing them to the repo, and maintaining custom `@font-face` declarations that replicate next/font's subset extraction and cache-busting. next/font already optimizes subsets correctly; redundant binaries bloat the repo and create maintenance drift. Programmatic `<link rel="preload">` injection from a `useEffect` would arrive after hydration (too late for LCP) and requires `useEffect` in a server-rendered layer — a worse outcome than `preload: false`.

**First-load budget impact:** zero. `preload: false` emits no extra `<link>` tag. Font files download only when the oracle pane's CSS references them. The ~104 kB gz JS budget is unaffected.

---

## 5. Data model / migration

None. This is a frontend-only routing change. The oracle backend tables (`oracle_readings`, `oracle_reading_folios`, `oracle_reading_events`, `oracle_corpus_sources`, `oracle_passage_anchors`, `oracle_plates`) are untouched.

---

## 6. API

No API changes. Explicitly confirmed unaffected:

- **SSE reading stream:** `python/nexus/api/routes/stream.py:141` (`GET /stream/oracle-readings/{reading_id}/events`) — called by `useGenerationRun` with `kind: "oracle-readings"` (`lib/api/useGenerationRun.ts:32`). The stream opens via a bearer token minted by `fetchStreamToken`; the oracle pane body and its `useGenerationRun` hook call are unchanged.
- **Plate image proxy:** `app/api/oracle/plates/[id]/route.ts` — a Next.js API route under `app/api/`, not under `app/(oracle)/`. Deletion of the route group does not touch it. `next.config.ts:18–20` whitelists `/api/oracle/plates/**` in `images.localPatterns`; that is unchanged.

---

## 7. Frontend

### 7.1 Files touched / created / deleted

**Root layout** `app/layout.tsx`:
- Add `EB_Garamond`, `IM_Fell_English`, `UnifrakturMaguntia` imports from `next/font/google` with `preload: false` and `display: "swap"`.
- Add the three `.variable` class names to `<html className={...}>`.
- Update the comment at lines 40–45 to reflect that oracle fonts now live here.

**Pane route model** `lib/panes/paneRouteModel.ts`:
- Add `"oracle" | "oracleAtlas" | "oracleReading"` to `PaneRouteId` union.
- Add three `route({...})` entries to `PANE_ROUTE_MODELS` array (oracle, then oracleAtlas BEFORE oracleReading).

**Pane route table** `lib/panes/paneRouteTable.ts`:
- Add `Sparkles` to the `lucide-react` import list at line 4 of `paneRouteTable.ts` (it is not currently imported there; it lives in `destinations.ts` and `resourceKind.ts`). Add three entries to `PANE_ROUTE_META` with `icon: Sparkles` and `getChrome` returning appropriate static titles.

**Pane render registry** `lib/panes/paneRenderRegistry.tsx`:
- Add three entries to `PANE_LOADERS` pointing to `(authenticated)/oracle/` paths.

**Destinations** `lib/navigation/destinations.ts`:
- Set `externalShell: false` on the oracle destination (line 86). Remove the comment explaining `externalShell` — the general comment on the `Destination` interface (line 16) is sufficient.

**Launcher providers** `lib/launcher/providers.ts`:
- Line 164: change `externalShell: true` to `externalShell: false` on the oracle folio item target. The G3 gate (below) checks both files. Update `providers.test.ts` section (d) at lines 220/224/242: flip the comment, test description, and `externalShell` expectation to `false`; update line 278 oracle destination assertion in the destinations describe block to `externalShell: false`.

### 7.2 New files under `(authenticated)/oracle/`

| File | Description |
|---|---|
| `oracle/OracleThemeWrapper.tsx` | `data-theme="oracle"` scope wrapper |
| `oracle/page.tsx` | `export default function Page() { return null; }` |
| `oracle/OracleLandingPaneBody.tsx` | Moved; wraps root with `OracleThemeWrapper`; replaces `useRouter`/`router.push('/oracle/...')` → `usePaneRouter().push(...)` (sub-case A, §7.4) |
| `oracle/OracleAlephGrid.tsx` | Moved; replaces `useRouter`/`router.push('/oracle/...')` → `usePaneRouter().push(...)` (sub-case A, §7.4) |
| `oracle/OracleConcordance.tsx` | Moved; replaces `useRouter`/`router.push('/oracle/...')` → `usePaneRouter().push(...)` (sub-case A, §7.4) |
| `oracle/IlluminatedCapital.tsx` | Moved verbatim |
| `oracle/BorderFrame.tsx` | Moved verbatim |
| `oracle/types.ts` | Moved verbatim |
| `oracle/oracle.module.css` | Moved verbatim |
| `oracle/atlas/page.tsx` | Null stub |
| `oracle/atlas/AtlasPaneBody.tsx` | Moved; removes `useStickyHeadline` import+usage+ref; wraps root with `OracleThemeWrapper`; replaces `router.push('/oracle/...')` → `usePaneRouter().push(...)` (sub-case A, §7.4) |
| `oracle/atlas/StarLabel.tsx` | Moved verbatim |
| `oracle/atlas/projection.ts` | Moved verbatim |
| `oracle/atlas/atlas.module.css` | Moved verbatim |
| `oracle/[readingId]/page.tsx` | Null stub |
| `oracle/[readingId]/OracleReadingPaneBody.tsx` | Moved; removes `useStickyHeadline` import+usage+`headlineRef`+`ref={headlineRef}` on `.foliumMotto` div; wraps root with `OracleThemeWrapper`; replaces navigation calls (see §7.4). **Prop signature migration:** change the component signature from `{ readingId, initialDetail }: { readingId: string; initialDetail?: ReadingDetail \| null }` to zero arguments `()`; read `readingId` via `usePaneParam("readingId")` imported from `@/lib/panes/paneRuntime` (throws if null, matching the pattern in `MediaPaneBody`, `AuthorPaneBody`, etc.); drop `initialDetail` and the optimization that seeds state from it — the new `page.tsx` is a null stub so server-prefetch is unavailable. |
| `oracle/[readingId]/Sidenote.tsx` | Moved verbatim |

### 7.3 useStickyHeadline deletion

`useStickyHeadline` and `HeadlineContext` exist solely in `OracleShell.tsx` and are imported only by `OracleReadingPaneBody.tsx:34` and `AtlasPaneBody.tsx:10`. After the shell is deleted, the hook is deleted with it. The two callers remove:
- The import statement.
- `const headlineRef = useStickyHeadline(...)` call.
- `ref={headlineRef as React.RefObject<HTMLDivElement>}` on the observed element.

The folio motto continues to render inline in the manuscript; the pane `SurfaceHeader` shows the static pane title. The `aria-live="polite"` region in `OracleShell` that announced the sticky folio motto to screen readers is intentionally removed. The pane `SurfaceHeader` provides a static landmark title. A follow-up using `PaneFixedChromePublication` (noted in N5) can restore dynamic announcement once implemented — that follow-up should include an aria-live region in the chrome or a visually-hidden live region in `OracleReadingPaneBody`.

### 7.4 `router.push` → pane-native navigation

Seven call sites use `useRouter().push()` from `next/navigation`. In a pane body, `useRouter` is the top-level Next.js router — calling `router.push('/oracle/...')` triggers a top-level navigation that loses pane context. The correct replacement depends on the navigation target:

**Sub-case A — within-oracle navigation (navigate current pane in place).** AC-2 says "clicking a star navigates *the pane* to `/oracle/[readingId]`" — in-place. Use `usePaneRouter().push()` (from `@/lib/panes/paneRuntime`). This replaces the pane's URL without opening a new slot.

| File | Site | Before | After |
|---|---|---|---|
| `OracleLandingPaneBody.tsx` | submit handler | `router.push('/oracle/${body.data.reading_id}')` | `paneRouter.push('/oracle/${body.data.reading_id}')` |
| `OracleReadingPaneBody.tsx` | `retryFailedReading` | `router.push('/oracle/${body.data.reading_id}')` | `paneRouter.push('/oracle/${body.data.reading_id}')` |
| `OracleConcordance.tsx` | `onOpen` callback | `router.push('/oracle/${id}')` | `paneRouter.push('/oracle/${id}')` |
| `OracleAlephGrid.tsx` | `onClick` | `router.push('/oracle/${row.id}')` | `paneRouter.push('/oracle/${row.id}')` |
| `AtlasPaneBody.tsx` | `onSelectStar` (×2) | `router.push('/oracle/${star.id}')` | `paneRouter.push('/oracle/${star.id}')` |

For each sub-case A file: replace `import { useRouter } from "next/navigation"` with `import { usePaneRouter } from "@/lib/panes/paneRuntime"`, replace `const router = useRouter()` with `const paneRouter = usePaneRouter()`, and update the call sites.

**Sub-case B — cross-pane navigation (open or activate a different pane type).** Use `requestOpenInAppPane` (from `@/lib/panes/openInAppPane`; dispatches `NEXUS_OPEN_PANE_EVENT`, picked up by the workspace store at `lib/workspace/store.tsx:899`).

| File | Site | Before | After |
|---|---|---|---|
| `OracleReadingPaneBody.tsx` | `openReadingChat` | `router.push('/conversations/${conversationId}')` | `requestOpenInAppPane('/conversations/${conversationId}')` |
| `OracleReadingPaneBody.tsx` | `activateCitation` callback (line 527) | `navigate: (href) => router.push(href)` | `navigate: (href) => requestOpenInAppPane(href)` |

For `OracleReadingPaneBody`: after replacing all sub-case A and B call sites, remove `useRouter` import and `const router = useRouter()`. The `activateCitation` citations navigate to `/media/…` and `/notes/…` panes (cross-pane), so `requestOpenInAppPane` is correct there.

### 7.5 Tests

**Oracle test files — move and update.** Move test files and their `__screenshots__` directories to the new paths; update relative import paths:

- `(oracle)/oracle/atlas/projection.test.ts` → `(authenticated)/oracle/atlas/projection.test.ts` (pure unit, no imports changed)
- `(oracle)/oracle/[readingId]/Sidenote.test.tsx` → `(authenticated)/oracle/[readingId]/Sidenote.test.tsx` (update relative imports only)

**`AtlasPaneBody.test.tsx`** (moved to `(authenticated)/oracle/atlas/`): this file uses `vi.mock("next/navigation", ...)` with a `routerPushMock`, which is banned by `testing_standards.md §7` and breaks when `router.push` is replaced by `paneRouter.push`. Update: remove `vi.mock("next/navigation")` and the `routerPushMock` hoisted variable; import `usePaneRouter` from `@/lib/panes/paneRuntime` and spy on it with `vi.spyOn`; replace `expect(routerPushMock).not.toHaveBeenCalled()` at lines 198 and 203 with assertions on the `usePaneRouter().push` spy. Update relative imports after move.

**`OracleReadingPaneBody.test.tsx`** (moved to `(authenticated)/oracle/[readingId]/`): this file uses `vi.mock("next/navigation", ...)` (banned) and asserts `expect(streamMocks.routerPush).toHaveBeenCalledWith(...)` for citation-chip navigation at lines 370, 432, and 504 (paths like `/media/media-1#fragment-fragment-1`, `/notes/block-1`, `/media/media-9#fragment-fragment-9`). After the cutover, those calls use `requestOpenInAppPane` (sub-case B). Update: remove `vi.mock("next/navigation")` and the `routerPush`/`routerReplace` entries from `streamMocks`; spy on `requestOpenInAppPane` from `@/lib/panes/openInAppPane` via `vi.spyOn`; replace the three `routerPush` assertions with assertions on the spy. Also update the component render calls (lines 71, 76, 144, 157, 204, 231, 270, 299, 363, 426, 496, 529) to render `<OracleReadingPaneBody />` with zero props, wrapping in a `PaneRuntimeProvider` that injects `pathParams: { readingId: "reading-1" }` (or `"reading-2"` where the test rerenders to a second ID). The `useStickyHeadline` mock entry is confirmed absent from the file — no change needed there. Update relative imports after move.

**Five external test files that assert current oracle-is-unsupported behavior:**

- **`apps/web/src/lib/panes/paneRouteTable.test.tsx` line 90:** retitle and update assertions — change `it("returns the unsupported placeholder for full-screen Oracle routes", ...)` to assert `.id === "oracle"` for `/oracle` and `.id === "oracleReading"` for `/oracle/reading-1`.
- **`apps/web/src/lib/panes/paneRouteModel.test.ts` line 71:** remove `"/oracle"` from the unsupported-routes loop; add a new assertion block: `expect(resolvePaneRouteModel("/oracle")).toMatchObject({ id: "oracle" }); expect(resolvePaneRouteModel("/oracle/atlas")).toMatchObject({ id: "oracleAtlas" }); expect(resolvePaneRouteModel("/oracle/some-uuid")).toMatchObject({ id: "oracleReading", params: { readingId: "some-uuid" } });` — note `oracleAtlas` must resolve before `oracleReading` (literal segment beats capture).
- **`apps/web/src/lib/launcher/providers.test.ts` lines 220/224/242:** update section (d) comment from "externalShell true" to "externalShell false", retitle the `it(...)` description, and change `externalShell: true` to `externalShell: false` in the `expect(first.target).toEqual(...)` assertion. Update line 278 oracle destination assertion to `externalShell: false`.
- **`apps/web/src/components/launcher/Launcher.test.tsx` line 308:** retitle to `"warms oracle pane on hover after shell dissolution"` and change the assertion to `expect(preloadPane).toHaveBeenCalledWith("oracle")` — after the cutover, `externalShell` is `false` on the oracle destination, so `useLauncherController` calls `preloadPane` on hover.

---

## 8. Key decisions

**D-1. Fonts: `preload: false` at root layout (rejected: self-hosted `@font-face`).**
The root layout already applies this pattern for JetBrains Mono (`app/layout.tsx:53–60`). `preload: false` keeps the `@font-face` CSS and the CSS variables in the global sheet without emitting `<link rel="preload">` on non-oracle routes. Self-hosted `@font-face` would require committing font binaries, maintaining custom declarations, and forgoing next/font's subset optimization — more maintenance for the same outcome.

**D-2. OracleThemeWrapper: render-side (rejected: data-theme on the pane shell element).**
The pane shell (`PaneShell.tsx`) does not expose a `data-*` slot on its DOM boundary. Threading `data-theme="oracle"` through the pane shell's `style`/`className` props would couple the pane system to a single surface's theme. A thin wrapper in the oracle pane body file is self-contained and follows the principle that oracle owns its own scope.

**D-3. Delete `useStickyHeadline` (rejected: move to OracleThemeWrapper).**
The pane `SurfaceHeader` already provides a title bar. Re-implementing the sticky-headline scroll-observation just to float text into an oracle-specific header that no longer exists would be dead code with a live observer. The `titleMode: "static"` pane chrome is sufficient for V1; a follow-up can publish the folio motto via `PaneFixedChromePublication` if desired.

**D-4. Three pane routes (rejected: one `oracle` route with a param).**
The reading and atlas are distinct surfaces with different layouts, scroll behaviors, and future secondary-pane affordances. Collapsing them to one route with a query param would complicate route resolution and obscure intent. Three named routes follow the existing pattern (`conversation` / `conversationNew`).

**D-5. `bodyMode: "document"` for all three oracle panes.**
Oracle readings are long-form, scroll-driven content — the same reason `media` and `page` use `document` mode. The `document` body mode allows `allowsIntrinsicPrimaryWidth: false` under `STANDARD_WIDTH_CONTRACT`, which caps the reading column at 1400 px.

---

## 9. What dies (exhaustive)

### Files deleted

```
apps/web/src/app/(oracle)/layout.tsx
apps/web/src/app/(oracle)/OracleShell.tsx
apps/web/src/app/(oracle)/OracleShell.module.css
apps/web/src/app/(oracle)/oracle/page.tsx
apps/web/src/app/(oracle)/oracle/OracleLandingPaneBody.tsx
apps/web/src/app/(oracle)/oracle/OracleAlephGrid.tsx
apps/web/src/app/(oracle)/oracle/OracleConcordance.tsx
apps/web/src/app/(oracle)/oracle/IlluminatedCapital.tsx
apps/web/src/app/(oracle)/oracle/BorderFrame.tsx
apps/web/src/app/(oracle)/oracle/types.ts
apps/web/src/app/(oracle)/oracle/oracle.module.css
apps/web/src/app/(oracle)/oracle/atlas/page.tsx
apps/web/src/app/(oracle)/oracle/atlas/AtlasPaneBody.tsx
apps/web/src/app/(oracle)/oracle/atlas/AtlasPaneBody.test.tsx
apps/web/src/app/(oracle)/oracle/atlas/StarLabel.tsx
apps/web/src/app/(oracle)/oracle/atlas/projection.ts
apps/web/src/app/(oracle)/oracle/atlas/projection.test.ts
apps/web/src/app/(oracle)/oracle/atlas/atlas.module.css
apps/web/src/app/(oracle)/oracle/atlas/__screenshots__/   (entire dir)
apps/web/src/app/(oracle)/oracle/[readingId]/page.tsx
apps/web/src/app/(oracle)/oracle/[readingId]/OracleReadingPaneBody.tsx
apps/web/src/app/(oracle)/oracle/[readingId]/OracleReadingPaneBody.test.tsx
apps/web/src/app/(oracle)/oracle/[readingId]/Sidenote.tsx
apps/web/src/app/(oracle)/oracle/[readingId]/Sidenote.test.tsx
apps/web/src/app/(oracle)/oracle/[readingId]/__screenshots__/   (entire dir)
```

### Symbols and behaviors deleted

- `OracleLayout` (default export of `(oracle)/layout.tsx`)
- `OracleShell` (default export) — the sticky topBar, back-link chrome, `HeadlineContext`, `HeadlineContext.Provider`
- `useStickyHeadline` (exported function, `OracleShell.tsx:22`) — the `IntersectionObserver`-based scroll hook
- `derivedBackLink` (internal function, `OracleShell.tsx:43`) — the pathname→{label,href} mapper
- The `← Index` / `← Home` back-link rendered in the oracle header
- `externalShell: true` on the oracle destination — the last barrier between oracle and the pane system

---

## 10. Sibling cutovers and sequencing

- **#1 machine-hand-hard-cutover.md** — no overlap; oracle does not use `MachineText` or `--ink-machine` tokens.
- **#2 running-journal-hard-cutover.md** — no overlap; oracle has no `RunningHead` or `SectionOpener`.
- **#3 two-rooms-hard-cutover.md** — zero conflict. Two Rooms sets tokens on `[data-theme="light"]` and `:root` (dark default). Oracle sets tokens on `[data-theme="oracle"]` — a sibling selector with a disjoint custom-property namespace (`--oracle-*`). The Press canvas grain sits on `body::before`; the oracle pane body renders `background: var(--oracle-bg)` (fully opaque `#14110f`), occluding the grain inside the pane. No token collision, no selector fight.
- **#6 browse-surface-deletion-hard-cutover.md** — the Browse destination in `destinations.ts` is removed; oracle destination stays. No conflict.
- **#7 daily-surface-consolidation-hard-cutover.md** — no overlap.
- **#8 reader-sidecar-consolidation-hard-cutover.md** — no overlap; oracle reading pane uses `ReaderCitation` but not the reader sidecar or its secondary groups.

**Sequencing:** this spec has no hard dependency on any sibling. It can land before or after all others. The `paneRenderRegistry.tsx` and `paneRouteModel.ts` edits are disjoint from all sibling specs.

---

## 11. Slices (independently buildable)

### S0 — Font migration

**Scope:** `app/layout.tsx` only.

Move the three oracle `next/font` declarations from `(oracle)/layout.tsx` into `app/layout.tsx` with `preload: false`. Add the three `.variable` class names to `<html className={...}>`. The `(oracle)/layout.tsx` font declarations can then be removed (their variables are now set on `<html>`; the oracle layout's own div no longer needs to re-set them). Update the comment in root layout.

**Verification:** `bun run typecheck` passes. Build passes. Navigating to `/oracle` in the browser (oracle shell still present) renders all three fonts identically — EB Garamond body text, IM Fell English display, UnifrakturMaguntia heading. No `<link rel="preload">` for oracle fonts appears on the `/libraries` route (check DevTools Network → Font). No CLS on `/oracle/[readingId]` (display:swap, same as before).

### S1 — Pane registration and shell dissolution (atomic)

**Scope:** all remaining changes; must land together to avoid conflicting Next.js routes.

1. Register `oracle`, `oracleAtlas`, `oracleReading` in `paneRouteModel.ts`, `paneRouteTable.ts`, `paneRenderRegistry.tsx`.
2. Create `app/(authenticated)/oracle/` tree: `OracleThemeWrapper.tsx`, null-stub `page.tsx` files, all moved content components (verbatim moves of CSS, IlluminatedCapital, BorderFrame, Sidenote, StarLabel, projection, types).
3. In `OracleLandingPaneBody`, `OracleAlephGrid`, `OracleConcordance`: replace `useRouter()`/`router.push('/oracle/...')` with `usePaneRouter().push(...)` (sub-case A); add `OracleThemeWrapper` wrapper.
4. In `OracleReadingPaneBody`: remove `useStickyHeadline` import/call/ref; change prop signature to zero-arg + `usePaneParam("readingId")`; replace within-oracle `router.push` with `usePaneRouter().push(...)` (sub-case A); replace cross-pane `router.push` (openReadingChat, activateCitation) with `requestOpenInAppPane` (sub-case B); add `OracleThemeWrapper`.
5. In `AtlasPaneBody`: remove `useStickyHeadline` import/call/ref; replace `router.push('/oracle/...')` with `usePaneRouter().push(...)` (sub-case A); add `OracleThemeWrapper`.
6. Move test files and `__screenshots__` dirs to new paths; update import paths.
7. Set `externalShell: false` on oracle destination (`destinations.ts`) and oracle folio items (`providers.ts:164`); update the five affected test files listed in §7.5.
8. Delete `app/(oracle)/` entirely.

**Verification:** `bun run typecheck` and `bun run lint` pass. Unit + browser test suite green (878+ unit, 1132+ browser). Navigate to `/oracle` — workspace opens with oracle landing pane, no full-page reload, nav rail and launcher remain visible. Navigate to `/oracle/atlas` — Atlas canvas pane renders. Navigate to `/oracle/[a-real-reading-id]` — reading pane streams. Press Oracle in the nav rail from the Libraries pane — oracle pane opens, Libraries pane remains in the tab strip. Oracle pane uses Garamond/Fell/Unifraktur. Concordance buttons navigate within the oracle pane.

---

## 12. Acceptance criteria

- **AC-1.** Navigating to `/oracle` from the nav rail does NOT trigger a full-page reload; the workspace URL changes to `/oracle` and the oracle landing pane renders inside the shell with the nav rail still visible.
- **AC-2.** Navigating to `/oracle/atlas` renders the celestial canvas inside the pane shell; dragging rotates the sky; clicking a star navigates the pane to `/oracle/[readingId]`.
- **AC-3.** Navigating to `/oracle/[readingId]` for a pending reading opens the reading pane and the SSE stream starts within 2 s (same timing as before).
- **AC-4.** All three oracle fonts (EB Garamond body text, IM Fell English display, UnifrakturMaguntia fraktur titles) render inside the oracle pane; no FOUT/FOIT regression beyond the display:swap already present.
- **AC-5.** On a non-oracle pane (e.g. `/libraries`), no `<link rel="preload" as="font">` for EB Garamond, IM Fell, or UnifrakturMaguntia appears in the document head.
- **AC-6.** `app/(oracle)/` does not exist in the working tree.
- **AC-7.** `grep -r "useStickyHeadline" apps/web/src` returns zero results.
- **AC-8.** `grep -r "externalShell.*true" apps/web/src/lib/navigation/destinations.ts` returns zero results AND `grep "externalShell.*true" apps/web/src/lib/launcher/providers.ts | grep -i oracle` returns zero results (oracle no longer externalShell in either destinations or folio items).
- **AC-9.** "Chat about this reading" button in the oracle reading pane opens a new conversation pane alongside the oracle pane (same tab strip), not a full-page navigation.
- **AC-10.** The plate image at `/api/oracle/plates/[uuid]` serves correctly; `next.config.ts` `images.localPatterns` is unchanged.

---

## 13. Negative gates

```bash
# G1: shell is gone
find apps/web/src/app -type d -name "(oracle)" | grep -q . && echo FAIL || echo PASS

# G2: useStickyHeadline is gone
grep -r "useStickyHeadline" apps/web/src && echo FAIL || echo PASS

# G3: oracle is no longer external-shell (check both destinations.ts and providers.ts oracle folio items)
grep -r "externalShell.*true" apps/web/src/lib/navigation/destinations.ts && echo FAIL || echo PASS
grep "externalShell.*true" apps/web/src/lib/launcher/providers.ts | grep -i oracle && echo FAIL || echo PASS

# G4: no Next.js useRouter (next/navigation) imports remain in oracle pane bodies
# (within-oracle navigation now uses usePaneRouter; cross-pane uses requestOpenInAppPane)
grep -r "import.*useRouter.*from.*next/navigation" apps/web/src/app/"(authenticated)"/oracle && echo FAIL || echo PASS

# G5: oracle pane body entry points are registered
grep -q 'oracle:' apps/web/src/lib/panes/paneRenderRegistry.tsx || echo FAIL
grep -q 'oracleAtlas:' apps/web/src/lib/panes/paneRenderRegistry.tsx || echo FAIL
grep -q 'oracleReading:' apps/web/src/lib/panes/paneRenderRegistry.tsx || echo FAIL

# G6: oracle fonts declared in root layout with preload:false
grep -q "EB_Garamond" apps/web/src/app/layout.tsx || echo FAIL
[ "$(grep -c 'preload: false' apps/web/src/app/layout.tsx)" -ge 4 ] || echo FAIL  # JetBrains Mono already has 1; 3 oracle fonts add 3 more = at least 4
```

---

## 14. Test plan

| Layer | What to check |
|---|---|
| **Unit** (`*.test.ts`, node) | `projection.test.ts` moves to new path; re-run to confirm math unchanged |
| **Browser** (`*.test.tsx`, Chromium) | `AtlasPaneBody.test.tsx`, `OracleReadingPaneBody.test.tsx`, `Sidenote.test.tsx` move and re-run; screenshot baselines regenerate (new paths) |
| **Typecheck** | `bun run typecheck` — confirms no stale imports to `(oracle)/OracleShell` |
| **Lint** | `bun run lint` — ESLint `@next/next/no-html-link-for-anchors` etc. |
| **Build** | `bun run build` — confirms no missing pages, no font-variable conflicts |
| **Manual: pane entry** | Open app at `/libraries`. Click Oracle in nav rail. Confirm oracle pane opens; nav rail stays; no full reload. |
| **Manual: deep link** | Navigate directly to `/oracle/[real-reading-id]`. Confirm workspace loads with reading pane, oracle fonts render. |
| **Manual: streaming** | Consult the oracle. Confirm the SSE stream delivers tokens; status transitions `pending → streaming → complete`. |
| **Manual: concordance** | On a complete reading, click a concordance entry. Confirm it navigates the oracle pane to the linked reading (same pane slot, no new tab). |
| **Manual: fonts on non-oracle** | Open `/libraries`. Open DevTools → Network → Font. Confirm no EB Garamond, IM Fell, or UnifrakturMaguntia preload appears. |
| **Manual: plate image** | Confirm plate images render in the reading; check network tab for `/api/oracle/plates/[uuid]` 200. |

---

## 15. Files (complete list)

### Created
```
apps/web/src/app/(authenticated)/oracle/OracleThemeWrapper.tsx
apps/web/src/app/(authenticated)/oracle/page.tsx
apps/web/src/app/(authenticated)/oracle/OracleLandingPaneBody.tsx
apps/web/src/app/(authenticated)/oracle/OracleAlephGrid.tsx
apps/web/src/app/(authenticated)/oracle/OracleConcordance.tsx
apps/web/src/app/(authenticated)/oracle/IlluminatedCapital.tsx
apps/web/src/app/(authenticated)/oracle/BorderFrame.tsx
apps/web/src/app/(authenticated)/oracle/types.ts
apps/web/src/app/(authenticated)/oracle/oracle.module.css
apps/web/src/app/(authenticated)/oracle/atlas/page.tsx
apps/web/src/app/(authenticated)/oracle/atlas/AtlasPaneBody.tsx
apps/web/src/app/(authenticated)/oracle/atlas/AtlasPaneBody.test.tsx
apps/web/src/app/(authenticated)/oracle/atlas/StarLabel.tsx
apps/web/src/app/(authenticated)/oracle/atlas/projection.ts
apps/web/src/app/(authenticated)/oracle/atlas/projection.test.ts
apps/web/src/app/(authenticated)/oracle/atlas/atlas.module.css
apps/web/src/app/(authenticated)/oracle/[readingId]/page.tsx
apps/web/src/app/(authenticated)/oracle/[readingId]/OracleReadingPaneBody.tsx
apps/web/src/app/(authenticated)/oracle/[readingId]/OracleReadingPaneBody.test.tsx
apps/web/src/app/(authenticated)/oracle/[readingId]/Sidenote.tsx
apps/web/src/app/(authenticated)/oracle/[readingId]/Sidenote.test.tsx
```

### Modified
```
apps/web/src/app/layout.tsx                         (add 3 oracle fonts, preload: false)
apps/web/src/lib/panes/paneRouteModel.ts            (add oracle|oracleAtlas|oracleReading)
apps/web/src/lib/panes/paneRouteTable.ts            (add Sparkles import + PANE_ROUTE_META entries)
apps/web/src/lib/panes/paneRenderRegistry.tsx       (add PANE_LOADERS entries)
apps/web/src/lib/navigation/destinations.ts        (externalShell: false on oracle)
apps/web/src/lib/launcher/providers.ts              (externalShell: false on oracle folio items)
```

### Deleted
```
apps/web/src/app/(oracle)/   (entire directory tree, 25 files)
```

---

## 16. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `oracleAtlas` defined after `oracleReading` in `PANE_ROUTE_MODELS` — `/oracle/atlas` is treated as a reading for ID "atlas" | High | Assert `oracleAtlas` entry precedes `oracleReading` entry in the models array; add a negative-gate unit test that `resolvePaneRouteModel('/oracle/atlas').id === "oracleAtlas"` |
| Font variable names (`--font-eb-garamond` etc.) not set on `<html>` after S0 if root layout `className` update is missed | Medium | AC-4 + build-time check; the CSS will visibly fall back to Georgia |
| `__screenshots__` dirs not moved — browser tests write new ones to `(oracle)/` (now deleted) causing test runner errors | Low | Move `__screenshots__` dirs in S1; Chromium project writes new baselines on first run |
| `requestOpenInAppPane` called before the pane graph is ready (e.g. during oracle pane SSE connect) | Low | `openInAppPane.ts` has a pre-ready queue (`enqueuePendingPaneOpen`); events fired before the store mounts are replayed on store ready (`store.tsx:901–907`) |
| Android shell: oracle pane now reachable via pane navigation; if oracle has content that requires `Local Vault`-restricted features, the Android guard needs extending | Low | Oracle reads no local vault content; the guard in `dispatch.ts:57` applies only to `isAndroidShellRestrictedRouteId` routes; oracle is not in that set |
