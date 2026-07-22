# Browse Dies — Hard Cutover

**Status:** Spec · Rev 1 · 2026-07-07
**Type:** Hard cutover — no legacy code, no fallbacks, no compat shims.

## One-line

The `/browse` pane and its nav entry are deleted; the Launcher's `browse` lane — already wired to `GET /api/browse` and `GET /api/web/search` — is the sole owner of external discovery, and the "Browse the web" pinned row switches lane in-place instead of navigating away.

---

## 0. Prerequisites (hard, no fallback)

- **P-1.** The Universal Launcher cutover is built and verified (`docs/cutovers/universal-launcher-hard-cutover.md` — BUILT+REVIEWED 2026-06-18). The Launcher already calls `GET /api/browse?q=...&limit=4` from `fetchBrowse()` (`components/launcher/useLauncherController.ts:64`) and surfaces results in the `browse` lane via `browseItems()` (`lib/launcher/providers.ts:267`). The backend service `services/browse.py` is already the Launcher's provider; no capability is new.
- **P-2.** The `dispatchTarget` seam (`lib/launcher/dispatch.ts`) is the single owner of every Launcher open; its exhaustive switch already handles `browse-acquire` targets (lines 113-173). This cutover adds one new target variant without changing the ownership contract.

---

## 1. Problem

### 1.1 Two owners for one job

The Launcher's `browse` lane (lane chip, six external result rows, live `/api/browse` + `/api/web/search` fetch, `browse-acquire` dispatch) does external discovery completely. The `/browse` pane (`BrowsePaneBody.tsx`) duplicates the same job with more chrome: a standalone search form, four type-filter checkboxes, paginated results via `CollectionView`, per-row `LibraryDestinationPicker`, and a "Follow" verb for podcasts. Every one of those features is either replicated in the Launcher or ripe for deletion.

The seam that connects them is the `browseWebItem` pinned row in the Launcher's `all` lane. Its target is:

```ts
// lib/launcher/providers.ts:391
target: { kind: "href", href: `/browse?${new URLSearchParams({ q: text })}`, externalShell: false },
```

Selecting it **closes the Launcher and opens a second surface** for the same query. That is the wrong model — a lane needs no page behind it.

### 1.2 The Universal Launcher spec's deferred decision, now overridden

`docs/cutovers/universal-launcher-hard-cutover.md` §2 (final line) and D-11 explicitly preserved `/browse` as "a deep-linkable full-pane see-all target" and N2 said "do not collapse the dense `/browse` page renderer." That was the right call at the time (the Launcher was not yet shipped). Post-ship, the page is redundant. **This spec is the override** (see D-1).

### 1.3 Concrete dependents (grep-verified)

| Area                 | File / symbol                                                         | Browse ref                                           |
| -------------------- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| Pane route model     | `lib/panes/paneRouteModel.ts:36,146-152`                              | `"browse"` in `PaneRouteId`; route entry             |
| Pane route table     | `lib/panes/paneRouteTable.ts:95-101`                                  | `browse` chrome entry                                |
| Pane render registry | `lib/panes/paneRenderRegistry.tsx:21`                                 | lazy `BrowsePaneBody` loader                         |
| Destination registry | `lib/navigation/destinations.ts:43-47`                                | `{ id: "browse", href: "/browse", slot: "primary" }` |
| Launcher providers   | `lib/launcher/providers.ts:391`                                       | `browseWebItem` href target `/browse?q=...`          |
| Podcasts pane        | `app/(authenticated)/podcasts/PodcastsPaneBody.tsx:610,650`           | `openInNewPane?.("/browse?types=podcasts")`          |
| Keybindings UI       | `app/(authenticated)/settings/keybindings/KeybindingsPaneBody.tsx:30` | `{ id: "browse", label: "Go to Browse" }`            |
| Config validator     | `python/nexus/config.py:655-663`                                      | dead `x_api_bearer_token` browse-provider check      |
| Tests                | Multiple (§9 below)                                                   |                                                      |

---

## 2. Target behavior (user-facing)

- **`Cmd/Ctrl-K` → "Browse" lane chip** is the sole external discovery entry. Documents, videos, podcasts, and episodes appear in the Launcher browse lane; selecting a row adds or opens the item. No separate page.
- **"Browse the web for ⟨text⟩" stays in the Launcher's `all` lane**, but now switches the Launcher to the `browse` lane with the current text seeded — it does not navigate away.
- **`/browse` redirects** (308) to `/?launcher=1&lane=browse`. Auth-guard intercepts unauthenticated requests first; after login the browser lands on `/browse`, which server-redirects to the workspace with the browse lane open.
- **`/browse?q=foo`** redirects to `/?launcher=1&lane=browse&q=foo`.
- **Podcasts pane empty state** replaces the "Browse podcasts" link that opened `/browse?types=podcasts` with a Launcher open action on the `browse` lane.

---

## 3. Goals / Non-goals

### Goals

- **G1.** Delete the `/browse` pane, its nav entry, its pane route id, and its BFF-facing BrowsePaneBody test.
- **G2.** Relocate the browse types (`BrowseResult`, `BrowseResponse`, etc.) out of the app route dir and into `lib/browse/types.ts`, which the Launcher already imports from the app dir.
- **G3.** Fix `browseWebItem`: lane-switch in-place (`set-lane` target) instead of navigating to a dead route.
- **G4.** Extend the Launcher URL-param trigger to support `?lane=<LauncherLane>` so the `/browse` redirect lands correctly.
- **G5.** Remove the dead `x_api_bearer_token` check from the browse-provider config validator.
- **G6.** Prune all test fixtures that use `/browse` as a pane href; update auth/redirect tests that navigate to `/browse` to reflect the redirect behavior.

### Non-goals

- **N1.** `GET /api/browse` (BFF proxy, `app/api/browse/route.ts`) is NOT deleted — the Launcher calls it.
- **N2.** `python/nexus/services/browse.py` and `python/nexus/api/routes/browse.py` are NOT deleted — they are now launcher-scoped providers. No function-level changes. `python/nexus/services/command_palette.py` is NOT in this guarantee — its browse-specific dispatch branch and helper functions are dead after the cutover and are removed (see §6).
- **N3.** The Launcher `browse` lane, `browse-results` section, `LauncherLane = "browse"`, `LauncherSource = "browse"`, and `browse-acquire` dispatch are NOT touched — they are the landing state.
- **N4.** `python/tests/test_browse_cursor.py` stays — it tests cursor validation in `browse_content`, which survives.
- **N5.** No pagination or per-row library picker is added to the Launcher. The Launcher browse lane is the first-page discover-and-add surface; see-more is future scope.
- **N6.** No backend migration.

---

## 4. Architecture — final state

### 4.1 Browse capability ownership after cutover

| Capability                                   | Before                                  | After                                   |
| -------------------------------------------- | --------------------------------------- | --------------------------------------- |
| External document search (Gutenberg + Nexus) | `/browse` pane + Launcher `browse` lane | Launcher `browse` lane only             |
| Video search (YouTube)                       | `/browse` pane + Launcher `browse` lane | Launcher `browse` lane only             |
| Podcast / episode search                     | `/browse` pane + Launcher `browse` lane | Launcher `browse` lane only             |
| Web search                                   | Launcher `browse` lane only             | Launcher `browse` lane only (unchanged) |
| Backend provider (`services/browse.py`)      | Serves page + Launcher                  | Serves Launcher only                    |
| BFF proxy (`/api/browse`)                    | Serves page + Launcher                  | Serves Launcher only                    |
| Nav rail entry                               | `BROWSE` slot                           | Removed                                 |
| Keybinding `browse`                          | "Go to Browse" (opens pane)             | Removed                                 |
| `/browse` URL                                | Pane render                             | 308 → `/?launcher=1&lane=browse`        |

### 4.2 New `set-lane` target

```ts
// lib/launcher/model.ts — added to LauncherActionTarget
| { kind: "set-lane"; lane: LauncherLane; query?: string }
```

`useLauncherController.select()` intercepts `set-lane` before dispatching:

```ts
if (target.kind === "set-lane") {
  setLane(target.lane);
  if (target.query) setQueryState(target.query);
  // stay open — do NOT call setOpen(false)
  return;
}
```

`dispatch.ts` adds `case "set-lane": return;` for exhaustiveness (controller never routes it to dispatch).

`browseWebItem` target changes to:

```ts
target: { kind: "set-lane", lane: "browse", query: text }
```

### 4.3 Type relocation

`BrowseResult`, `BrowseResponse`, `BrowseSectionType`, `BrowseDocumentResult`, `BrowseVideoResult`, `BrowsePodcastResult`, `BrowseEpisodeResult`, and `BrowseSectionData` move from `app/(authenticated)/browse/browseState.ts` to `lib/browse/types.ts`. The three Launcher importers (`lib/launcher/model.ts`, `lib/launcher/providers.ts`, `components/launcher/useLauncherController.ts`) and their test file (`lib/launcher/providers.test.ts`) update their import paths.

All `BrowsePaneBody`-specific functions (`getDocumentActionLabel`, `getDocumentFallbackDescription`, `getDocumentSourceLabel`, `isProjectGutenbergDocument`, `formatEpisodeMeta`, `parseVisibleTypes`, `mergeSectionResults`, `updateSection`, `updateSectionResults`, `BROWSE_TYPES`, `TYPE_LABELS`, `normalizeBrowseQuery`, `normalizeSections`, `emptySections`, `buildBrowseHref`, and the four predicates `isPodcastResult`, `isPodcastEpisodeResult`, `isDocumentResult`, `isVideoResult`) are page-local; no surviving Launcher file imports any of them. `dispatch.ts` uses `result.type` directly (no predicate imports). They all die with `BrowsePaneBody`. `lib/browse/types.ts` exports only the eight wire-format types the Launcher's runtime code needs.

### 4.4 URL-param lane seed

Extend `useLauncherController`'s URL-param trigger:

```ts
const laneParam = params.get("lane");
const validLanes: LauncherLane[] = [
  "all",
  "open",
  "search",
  "browse",
  "create",
  "ask",
  "go",
];
const seedLane =
  laneParam && (validLanes as string[]).includes(laneParam)
    ? (laneParam as LauncherLane)
    : null;
if (seedLane && seedLane !== "all") setLaneOverride(seedLane);
params.delete("lane");
```

### 4.5 `/browse` redirect

`app/(authenticated)/browse/page.tsx` becomes a server component:

```ts
import { permanentRedirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q =
    typeof params.q === "string" && params.q.trim() ? params.q.trim() : null;
  const dest = q
    ? `/?launcher=1&lane=browse&q=${encodeURIComponent(q)}`
    : "/?launcher=1&lane=browse";
  permanentRedirect(dest);
}
```

The function is `async` and `searchParams` is typed as `Promise<…>` per the Next.js 15 pattern used throughout the codebase (see `app/login/page.tsx`, `app/sign-up/page.tsx`).

---

## 5. Data model / migration

None. No schema change, no migration file.

---

## 6. API

- `GET /api/browse` (BFF proxy) — unchanged, stays.
- `python/nexus/api/routes/browse.py` `GET /browse` — unchanged, stays.
- `python/nexus/config.py` validator: remove lines that check `x_api_bearer_token` as a browse provider credential (the service never calls it; this check is dead).
- `python/nexus/services/command_palette.py`: remove the `if segments[0] == "browse": return _canonicalize_browse_target_href(parsed)` dispatch branch (lines 326-327) and the entire `_canonicalize_browse_target_href`, `_normalize_browse_query`, `_normalize_browse_visible_types`, and `BROWSE_VISIBLE_TYPES` definitions (lines 26, 395-453). After this cutover no FE code will send `target_key="/browse"` to the command-palette endpoint, so this branch is dead. Delete the corresponding integration test at `python/tests/test_command_palette_usage_integration.py:43-55`.

---

## 7. Frontend

### 7.1 Files deleted

- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/browse/browseState.ts` (contents relocated — see §4.3)
- `apps/web/src/app/(authenticated)/browse/BrowseTypeFilters.tsx`
- `apps/web/src/app/(authenticated)/browse/page.module.css`
- `apps/web/src/lib/collections/presenters/browse.ts`
- `apps/web/src/lib/ui/paneSurfaceCutover.guards.test.ts` entries referencing `browse/BrowsePaneBody.tsx` (remove those assertions, not the file)

### 7.2 Files created

- `apps/web/src/lib/browse/types.ts` — the eight wire-format types (`BrowseResult`, `BrowseResponse`, `BrowseSectionType`, `BrowseDocumentResult`, `BrowseVideoResult`, `BrowsePodcastResult`, `BrowseEpisodeResult`, `BrowseSectionData`)

### 7.3 Files modified

| File                                                               | Change                                                                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `app/(authenticated)/browse/page.tsx`                              | Replace stub `return null` with `permanentRedirect` (§4.5)                                                 |
| `lib/navigation/destinations.ts`                                   | Remove the `browse` entry (id/href/slot/keywords); NAV_MODEL auto-updates                                  |
| `lib/panes/paneRouteModel.ts`                                      | Remove `"browse"` from `PaneRouteId` union; remove from `PANE_ROUTE_MODELS`                                |
| `lib/panes/paneRouteTable.ts`                                      | Remove `browse` entry from the table                                                                       |
| `lib/panes/paneRenderRegistry.tsx`                                 | Remove `browse` from `PANE_LOADERS`                                                                        |
| `lib/panes/paneResourceLoaders.ts`                                 | Remove `"browse /"` from the comment on line 40 listing query-driven pane routes excluded from prefetching |
| `lib/launcher/model.ts`                                            | Add `set-lane` target variant; update `BrowseResult` import path                                           |
| `lib/launcher/dispatch.ts`                                         | Add `case "set-lane": return;` (exhaustive; never reached)                                                 |
| `lib/launcher/providers.ts`                                        | `browseWebItem`: change target to `set-lane`; update import path                                           |
| `components/launcher/useLauncherController.ts`                     | `select()`: handle `set-lane`; URL-param lane seed (§4.4); update import paths                             |
| `app/(authenticated)/podcasts/PodcastsPaneBody.tsx`                | Two `openInNewPane?.("/browse?types=podcasts")` calls → `dispatchOpenLauncher({ lane: "browse" })`         |
| `app/(authenticated)/settings/keybindings/KeybindingsPaneBody.tsx` | Remove `{ id: "browse", label: "Go to Browse" }` from `BINDABLE_ACTIONS`                                   |
| `python/nexus/config.py`                                           | Remove `x_api_bearer_token` check from browse validator block                                              |

### 7.4 Test files modified (not deleted)

| File                                          | Change                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/panes/paneRouteTable.test.tsx`           | Remove `"/browse"` from the href list (line 126)                                                                                                                                                                                                                                                                                                         |
| `lib/panes/paneResourceLocator.test.ts`       | Remove `"/browse"` from non-resource-route list (line 73)                                                                                                                                                                                                                                                                                                |
| `lib/panes/paneWarmIntegration.test.tsx`      | Remove `{ href: "/browse", id: "browse" }` entry (line 168)                                                                                                                                                                                                                                                                                              |
| `lib/workspace/workspaceRestore.test.ts`      | Replace `/browse` history fixtures with another valid pane href                                                                                                                                                                                                                                                                                          |
| `e2e/tests/authenticated-shell-ac4.spec.ts`   | Replace `/browse` pane history fixture (line 156)                                                                                                                                                                                                                                                                                                        |
| `components/appnav/navActive.test.ts`         | Remove browse-exact match assertion (lines 19-21)                                                                                                                                                                                                                                                                                                        |
| `components/appnav/AppNav.test.tsx`           | Remove browse active-pane test (around line 109)                                                                                                                                                                                                                                                                                                         |
| `lib/launcher/launcherCutover.guards.test.ts` | Remove `"/browse"` from the `hrefs` array (line 98) — it is no longer a destination                                                                                                                                                                                                                                                                      |
| `lib/launcher/providers.test.ts`              | S0: update import from `@/app/(authenticated)/browse/browseState` to `@/lib/browse/types`; S1: update "browse-web" test to assert `set-lane` target, not an href                                                                                                                                                                                         |
| `lib/auth/callback.test.ts`                   | Auth fixture uses `/browse` as a next-param URL — stays valid (auth guard fires before the redirect, middleware captures the signal)                                                                                                                                                                                                                     |
| `lib/auth/client-return-target.test.ts`       | Same — stays valid                                                                                                                                                                                                                                                                                                                                       |
| `app/sign-up/page.test.ts`                    | Same — stays valid                                                                                                                                                                                                                                                                                                                                       |
| `e2e/tests/auth.spec.ts`                      | Update the GitHub OAuth round-trip test (lines 115-117): replace `expect(page).toHaveURL(/\/browse/)` with `expect(page).toHaveURL(/lane=browse/)` — Playwright follows the 308 to `/?launcher=1&lane=browse` and the old pattern no longer matches. The unauthenticated-access test (lines 84-100) is unaffected (middleware redirects before routing). |
| `e2e/tests/workspace-tabs.spec.ts`            | Replace `/browse` pane history fixture (line 156) with a valid pane href (e.g. `"/notes"`)                                                                                                                                                                                                                                                               |
| `e2e/tests/workspace.ts`                      | Update `EXPLICIT_FALLBACK_HISTORY` (line 19): replace `"/browse"` with a valid pane href (e.g. `"/notes"`) — this constant seeds the back-stack for every `gotoSinglePaneWorkspace("/libraries", …)` call across multiple e2e suites                                                                                                                     |
| `lib/ui/paneSurfaceCutover.guards.test.ts`    | Remove the browse pane-body assertions (source file path + specific function checks at lines 15 and 99-110)                                                                                                                                                                                                                                              |

---

## 8. Key decisions

- **D-1. Override the universal-launcher spec's N2/D-11.** That spec deferred `/browse` deletion because the Launcher was unbuilt. It is now shipped. A lane needs no page behind it; the Launcher IS the surface. The override is recorded here explicitly; no further reconciliation needed.
- **D-2. Backend survives entirely.** `services/browse.py` and `routes/browse.py` become launcher-scoped providers. Deleting them would require removing the Launcher's `fetchBrowse()` call and rebuilding discovery in-Launcher, which gains nothing. One backend, one caller.
- **D-3. `set-lane` stays in the controller, not dispatch.** `browseWebItem` switching to the browse lane is a Launcher-internal state change (no side effect outside the Launcher). Routing it through `dispatchTarget` would require firing an external event from inside dispatch, which is the wrong direction. The controller intercepts `set-lane` before dispatch is called; dispatch gets a no-op case for exhaustiveness.
- **D-4. Types relocate to `lib/browse/types.ts`, not inline into the Launcher.** The shapes (`BrowseResult` et al.) describe the API wire format, not Launcher internals. A dedicated module is cleaner than scattering them across `lib/launcher/`.
- **D-5. Auth-redirect tests — two cases, different treatment.** (a) Unauthenticated-access test (`auth.spec.ts` lines 84-100): navigates to `/browse` without a session; middleware fires before Next.js routing and redirects to `/login?next=/browse`. The test asserts on the login URL, not on what `/browse` renders. Stays untouched. (b) GitHub OAuth round-trip test (`auth.spec.ts` lines 115-117): navigates to `/login?next=%2Fbrowse`, completes OAuth, and lands on `/browse` — Playwright follows the 308 to `/?launcher=1&lane=browse`. The assertion `toHaveURL(/\/browse/)` no longer matches; update it to `toHaveURL(/lane=browse/)` (see §7.4).
- **D-6. No pagination in the Launcher.** The page offered load-more per section. The Launcher shows first-page results (limit 4). Not adding pagination keeps the Launcher focused. Future scope if needed.
- **D-7. Dead `x_api_bearer_token` config check removed.** The browse service (`services/browse.py`) never calls the X/Twitter API. The validator has been requiring a credential for a non-existent provider; removing it is strictly correct.

---

## 9. What dies (exhaustive deletion list)

### Deleted files

- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/browse/browseState.ts` (contents moved)
- `apps/web/src/app/(authenticated)/browse/BrowseTypeFilters.tsx`
- `apps/web/src/app/(authenticated)/browse/page.module.css`
- `apps/web/src/lib/collections/presenters/browse.ts`
- `apps/web/src/app/(authenticated)/browse/__screenshots__/` (dead snapshot directory)

### Dead symbols (die with their files)

- `BrowsePaneBody` component
- `BrowseTypeFilters` component
- `presentBrowseResult` function
- `buildBrowseHref`, `formatEpisodeMeta`, `getDocumentActionLabel`, `getDocumentFallbackDescription`, `getDocumentSourceLabel`, `isProjectGutenbergDocument`, `parseVisibleTypes`, `updateSection`, `updateSectionResults` helpers (page-local; Launcher does not need them)
- `PaneRouteId = "browse"` literal
- `NAV_MODEL` `browse` entry (auto-removed via DESTINATIONS derivation)
- `PANE_LOADERS.browse` entry
- `PANE_ROUTE_MODELS` `browse` route definition
- `paneRouteTable.ts` `browse` chrome entry
- Keybinding action `{ id: "browse", label: "Go to Browse" }`
- Destination entry `{ id: "browse", href: "/browse", slot: "primary", … }`
- Config browse validator `x_api_bearer_token` check (lines 658-660 of `config.py`)
- `command_palette.py` browse dispatch: `BROWSE_VISIBLE_TYPES`, `_canonicalize_browse_target_href`, `_normalize_browse_query`, `_normalize_browse_visible_types`, and the `if segments[0] == "browse":` branch
- Integration test case `test_command_palette_usage_integration.py:43-55` (the `/browse` canonicalization test)

### What explicitly survives

- `lib/browse/types.ts` (new home for the wire types)
- `LauncherLane = "browse"`, `LauncherSectionId = "browse-results"`, `LauncherSource = "browse"` — Launcher lane vocabulary
- `{ kind: "browse-acquire" }` dispatch target — Launcher add/open action
- `fetchBrowse()` and `browseFetch` in `useLauncherController` — Launcher fetch
- `GET /api/browse` (BFF) and `python/nexus/api/routes/browse.py` — backend
- `python/nexus/services/browse.py` — all functions
- `python/tests/test_browse_cursor.py` — tests live browse service

---

## 10. Sibling cutovers and sequencing

- **Must land after:** Universal Launcher cutover (P-1). Already built; this extends it.
- **Pane-header composition:** deleting the Browse `PaneRouteId` also deletes its
  exhaustive `PANE_ROUTE_MODELS` definition and typed section-header contract;
  there is no independent standing-head map.
- **No dependency on #3, #4, #5, #7-#10.** Those are orthogonal surfaces.

---

## 11. Slices

- **S0 — Type relocation.** Create `lib/browse/types.ts` with the eight wire-format types (`BrowseResult` union + four subtypes + `BrowseResponse` + `BrowseSectionType` + `BrowseSectionData`). Update import paths in `lib/launcher/model.ts`, `lib/launcher/providers.ts`, `components/launcher/useLauncherController.ts`, and `lib/launcher/providers.test.ts` (all four import from the old app-dir path). Delete `browseState.ts`. Verify: typecheck/lint 0, unit + browser suites green.

- **S1 — `set-lane` target + URL-param lane seed.** Add `{ kind: "set-lane"; lane: LauncherLane; query?: string }` to `LauncherActionTarget` in `model.ts`. In `dispatch.ts` add `case "set-lane": return;`. In `useLauncherController.select()` intercept `set-lane` before dispatch. Extend URL-param trigger (§4.4). Change `browseWebItem` target in `providers.ts` to `{ kind: "set-lane", lane: "browse", query: text }`. Update providers.test.ts for the changed browseWebItem target. Verify: typecheck/lint 0; unit tests for `set-lane` controller path (lane switches, query seeded, Launcher stays open); URL-param test `?launcher=1&lane=browse` opens on browse lane.

- **S2 — Pane route + render registry cleanup.** Remove `"browse"` from `PaneRouteId`, `PANE_ROUTE_MODELS`, `paneRouteTable.ts`, `paneRenderRegistry.tsx`, `destinations.ts`. Replace `page.tsx` with `permanentRedirect` (§4.5). Update `PodcastsPaneBody.tsx` (two calls) and `KeybindingsPaneBody.tsx`. Verify: typecheck/lint 0; the two podcast buttons open the Launcher on the browse lane; keybindings pane no longer shows "Go to Browse"; navigating to `/browse` in-app opens the workspace with the browse lane.

- **S3 — Delete page files + presenters.** Delete `BrowsePaneBody.tsx`, `BrowsePaneBody.test.tsx`, `BrowseTypeFilters.tsx`, `page.module.css`, `lib/collections/presenters/browse.ts`, and the `__screenshots__` directory. Remove dead browse assertions from `lib/ui/paneSurfaceCutover.guards.test.ts`. Verify: typecheck 0; bundle size ≤ 104 kB gz (browse chunk removed); no imports of deleted files anywhere.

- **S4 — Backend config cleanup.** Remove `x_api_bearer_token` check from browse-provider validator in `config.py`. Remove the `if segments[0] == "browse": ...` dispatch branch and the `_canonicalize_browse_target_href` / `_normalize_browse_query` / `_normalize_browse_visible_types` / `BROWSE_VISIBLE_TYPES` definitions from `command_palette.py`. Delete the corresponding test case at `test_command_palette_usage_integration.py:43-55`. Verify: `make test-unit` (Python) green.

- **S5 — Test fixture cleanup.** Update `paneRouteTable.test.tsx`, `paneResourceLocator.test.ts`, `paneWarmIntegration.test.tsx`, `workspaceRestore.test.ts`, `workspace-tabs.spec.ts` (line 156), `workspace.ts` (EXPLICIT_FALLBACK_HISTORY line 19), `auth.spec.ts` (OAuth round-trip assertion lines 115-117), `navActive.test.ts`, `AppNav.test.tsx`, `launcherCutover.guards.test.ts`, and `providers.test.ts` (set-lane target assertion — import path was already updated in S0). Verify: full unit + browser suites green; gates pass.

---

## 12. Acceptance criteria

- **AC-1.** The nav rail has no Browse entry. `DESTINATIONS` contains no entry with `href: "/browse"`.
- **AC-2.** Navigating to `/browse` (browser or pane router) redirects to `/?launcher=1&lane=browse` (308). `/?launcher=1&lane=browse` opens the Launcher on the `browse` lane.
- **AC-3.** Navigating to `/browse?q=kafka` redirects to `/?launcher=1&lane=browse&q=kafka` and the Launcher opens with "kafka" queried in the browse lane.
- **AC-4.** The Launcher's "Browse the web for ⟨text⟩" pinned row switches the Launcher to the `browse` lane with the text seeded — it does NOT close the Launcher and does NOT navigate to any URL.
- **AC-5.** The Podcasts pane "Browse" button and empty-state "Browse podcasts" link open the Launcher on the `browse` lane.
- **AC-6.** `GET /api/browse?q=...` continues to work and return browse results (used by the Launcher).
- **AC-7.** No dead `browse` keybinding action appears in the keybindings settings pane.
- **AC-8.** typecheck/lint/pyright/ruff all 0; unit and browser suites green; first-load JS ≤ 104 kB gz (browse chunk removed).

---

## 13. Negative gates (grep-able, CI-enforced)

```sh
# G-1: no BrowsePaneBody or BrowseTypeFilters anywhere outside the deleted dir
if rg -rn "BrowsePaneBody|BrowseTypeFilters|presentBrowseResult" apps/web/src --glob "!**/__screenshots__/**"; then
  echo "FAIL: deleted browse symbols still referenced"; exit 1; fi

# G-2: browseState is gone; types now in lib/browse/types.ts
if [ -f apps/web/src/app/"(authenticated)"/browse/browseState.ts ]; then
  echo "FAIL: browseState.ts still exists"; exit 1; fi

# G-3: no pane render entry for browse
if rg '"browse"' apps/web/src/lib/panes/paneRenderRegistry.tsx; then
  echo "FAIL: browse still in PANE_LOADERS"; exit 1; fi

# G-4: no browse destination in the registry
if rg 'href: "/browse"' apps/web/src/lib/navigation/destinations.ts; then
  echo "FAIL: browse destination still registered"; exit 1; fi

# G-5: browseWebItem must NOT use an href target to /browse
if rg 'kind.*href.*browse|href.*kind.*browse' apps/web/src/lib/launcher/providers.ts; then
  echo "FAIL: browseWebItem still navigates to /browse"; exit 1; fi

# G-6: no openInNewPane call targeting /browse anywhere
if rg 'openInNewPane.*"/browse|"/browse.*openInNewPane' apps/web/src; then
  echo "FAIL: openInNewPane still targeting /browse"; exit 1; fi

# G-7: no PaneRouteId "browse" type
if rg '"browse"' apps/web/src/lib/panes/paneRouteModel.ts; then
  echo "FAIL: browse still in PaneRouteId"; exit 1; fi

# G-8: x_api_bearer_token dead check removed from browse validator
if grep -n "x_api_bearer_token" python/nexus/config.py | grep -i "browse"; then
  echo "FAIL: dead X API browse credential check still present"; exit 1; fi
```

---

## 14. Test plan

- **Unit (node):** `set-lane` target in `select()` (lane switches; query seeded; Launcher stays open; dispatch not called); URL-param `?lane=browse` opens Launcher on browse lane; `?lane=invalid` falls back to `all`.
- **Browser (Chromium):** "Browse the web for X" row in the `all` lane switches to browse lane in-place; typed text is seeded; Launcher stays open. Podcasts pane "Browse" button fires `OPEN_LAUNCHER_EVENT` with `lane: "browse"`. `/browse` redirect (test via `navigate()` to `/browse` and assert the Launcher opens on browse lane).
- **Backend:** `GET /api/browse?q=audio` still returns results; `browse_content()` unit tests still pass (`test_browse_cursor.py`).
- **E2E (optional, known heavy):** navigate to `/browse?q=podcast` → Launcher opens on browse lane with "podcast" query.

---

## 15. Files touched/created/deleted

**Created:**

- `apps/web/src/lib/browse/types.ts`

**Modified:**

- `apps/web/src/app/(authenticated)/browse/page.tsx` (redirect)
- `apps/web/src/lib/navigation/destinations.ts`
- `apps/web/src/lib/panes/paneRouteModel.ts`
- `apps/web/src/lib/panes/paneRouteTable.ts`
- `apps/web/src/lib/panes/paneRenderRegistry.tsx`
- `apps/web/src/lib/launcher/model.ts`
- `apps/web/src/lib/launcher/dispatch.ts`
- `apps/web/src/lib/launcher/providers.ts`
- `apps/web/src/components/launcher/useLauncherController.ts`
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/keybindings/KeybindingsPaneBody.tsx`
- `apps/web/src/lib/panes/paneResourceLoaders.ts`
- `python/nexus/config.py`
- `python/nexus/services/command_palette.py`
- Multiple test files (§7.4)

**Deleted:**

- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/browse/browseState.ts`
- `apps/web/src/app/(authenticated)/browse/BrowseTypeFilters.tsx`
- `apps/web/src/app/(authenticated)/browse/page.module.css`
- `apps/web/src/lib/collections/presenters/browse.ts`
- `apps/web/src/app/(authenticated)/browse/__screenshots__/` (dead snapshot directory)

---

## 16. Risks

- **R1. `permanentRedirect` in a server component with dynamic search params requires `force-dynamic` and the Next.js 15 async `searchParams` API.** Mitigation: the code snippet in §4.5 includes `export const dynamic = "force-dynamic"`, marks the function `async`, and types `searchParams` as `Promise<…>` — matching the pattern used in `app/login/page.tsx` and `app/sign-up/page.tsx`.
- **R2. Launcher `set-lane` close→open flash if the target somehow reaches dispatch.** Mitigation: the controller intercepts `set-lane` before `setOpen(false)` is called — the Launcher never closes. The dispatch no-op case is defense-in-depth only.
- **R3. The browse `__screenshots__` directory is left behind.** Resolved: `apps/web/src/app/(authenticated)/browse/__screenshots__/` is listed in §9 and §15 for deletion alongside the other browse files.
- **R4. Auth e2e tests that navigate to `/browse`.** Two distinct cases. Unauthenticated-access test (lines 84-100): auth guard fires before Next.js routing; the `?next=/browse` capture is still valid; no change needed. GitHub OAuth round-trip test (lines 115-117): Playwright follows the 308, URL assertion must be updated — see §7.4 and D-5.
- **R5. Route/header removal can drift if split.** Mitigation: remove Browse from
  `PaneRouteId`, `PANE_ROUTE_MODELS`, and the render/icon registries in the same
  change; the typed route/header model has no second map to sequence.
