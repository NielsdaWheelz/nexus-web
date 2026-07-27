# App Launch Resume — Hard Cutover

**Status:** BUILT + REVIEWED · **Rev 2** · 2026-07-26
**Type:** Hard cutover — one launch contract; no legacy redirect, fallback
parsing, compatibility branch, or dual owner.

## Decision

A launcher open resumes the saved workspace exactly as persisted and keeps its
active primary pane active. Home remains the explicit `/lectern` destination.

No questions are blocking. This spec assumes the approved policy is:

- bare root `/` = **Resume**;
- any non-root protected href, including `/lectern` = **Navigate**;
- no usable saved session = the existing one-pane Lectern default;
- current same-device/cross-device session selection remains unchanged.

## Problem

Today every cold launcher open becomes an explicit Lectern navigation:

```text
Android null-data launch / installed PWA
  → /
  → next.config root redirect
  → /lectern
  → server restore + deep-link merge
  → append/reuse and activate Lectern
```

Android `singleTask` warm re-entry repeats the navigation because
`onNewIntent()` also loads the base URL for a null-data launcher intent. The
shell therefore treats “show the already-running app” and “go Home” as the same
capability.

## Goals

- **G1 — Resume means continuity.** Reopening the app preserves the saved pane
  set, order, histories, visibility, attached panes, sizing, and active primary
  pane.
- **G2 — Home stays explicit.** Brand, nav, auth default, and direct
  `/lectern` navigation retain current Lectern semantics.
- **G3 — Correct first paint.** Resume is resolved in the existing server
  bootstrap; no client restore pass or wrong-pane flash.
- **G4 — One entry classifier.** The bootstrap owns the complete web entry
  policy. Android owns only native intent-to-web-navigation policy.
- **G5 — Preserve shell intents.** Root Launcher query intents open Launcher
  over the restored workspace and never become panes.

## Non-goals

- No workspace persistence, revision, ETag, retry, conflict, or cross-device
  policy redesign.
- No database, migration, backend, BFF, wire API, or persisted schema change.
- No WebView `saveState`/`restoreState`, launch-mode change, new native
  navigation stack, preference, telemetry, or analytics.
- No change to login without an explicit `next`; its default remains
  `/lectern`.
- No broad Launcher, workspace, App Link, or auth refactor.

## Target behavior

| Entry | Saved session | Result |
|---|---|---|
| Cold browser/PWA/Android launch at `/` | usable | Restore it unchanged; keep its active pane |
| Cold launch at `/` | absent/unusable | Open the existing one-pane Lectern default |
| Root shell intent `/?launcher=1...` | usable | Restore unchanged; open Launcher; do not add a root pane |
| Explicit `/lectern` | any | Preserve saved panes; reuse/append and activate Lectern |
| Explicit owned href, e.g. `/media/123` | any | Preserve current deep-link merge semantics |
| Warm Android launcher re-entry, no URI | already running | Reveal the task; do not call `WebView.loadUrl` |
| Warm/cold owned App Link or auth callback | any | Load the exact owned URI |
| Explicit unsupported Android URI | any | Ignore it; never reinterpret it as Resume |

“Last open” means `WorkspaceState.activePrimaryPaneId`, not the last item in pane
order and not the last URL recorded by WebView history.

## Capability contract

- **C1 — Root is not a pane.** A request whose parsed pathname is `/` is
  `Resume`, regardless of query parameters. It is never passed to
  `createDefaultWorkspaceState`, `seedPane`, or deep-link merge.
- **C2 — Resume is identity-preserving.** Given a selected restored state,
  `initialState` is that state; no pane is added, removed, activated, or
  rewritten.
- **C3 — Empty Resume is defined.** With no selected state, initialize from
  `WORKSPACE_DEFAULT_FALLBACK_HREF` (`/lectern`). This is the valid empty
  product state, not a compatibility path.
- **C4 — Navigate is unchanged.** Every non-root protected href uses the
  existing `createDefaultWorkspaceState` +
  `mergeRestoredWorkspaceWithDeepLink` path.
- **C5 — Request identity is required.** Missing or malformed
  `REQUEST_PATH_HEADER` is a server contract defect. Do not silently substitute
  Lectern.
- **C6 — URL remains a projection.** After hydration, the existing workspace
  state-to-URL effect replaces `/` with the active pane href. The URL does not
  become workspace storage.
- **C7 — Root shell queries compose.** Launcher consumes `launcher`, `lane`,
  `q`, and `cmd` before workspace URL projection. Remaining query/hash behavior
  is unchanged.
- **C8 — Warm native Resume is a no-op.** A null-data `onNewIntent` cannot
  reload, redirect, duplicate history, reset JS state, or change the active
  pane.
- **C9 — First paint stays server-owned.** No mount-time session GET, hydration
  dispatch, loading interstitial, or client fallback is introduced.

## Architecture and final state

```text
platform entry
  ├─ browser/PWA cold launch ─────────────── GET /
  ├─ Android cold null-data launch ───────── GET /
  ├─ Android warm null-data re-entry ─────── no WebView navigation
  └─ explicit owned link/callback ────────── GET exact href

middleware
  └─ stamps required pathname+search in REQUEST_PATH_HEADER

authenticated root page + existing layout
  └─ loadWorkspaceBootstrap()
       ├─ classify pathname "/" ──────────── Resume
       │    └─ selected restored state ?? Lectern default
       └─ classify every other pathname ─── Navigate(href)
            └─ existing restore + deep-link merge

WorkspaceStoreProvider(initialState)
  ├─ first paint is already correct
  ├─ existing capture/flush persists changes
  └─ existing active-pane projection replaces browser URL
```

### Internal entry schema

Keep this private to `bootstrap.server.ts`; do not create a public module for one
consumer.

```ts
type WorkspaceEntryIntent =
  | { kind: "Resume" }
  | { kind: "Navigate"; href: string };
```

Classification:

1. Require `REQUEST_PATH_HEADER`.
2. Validate/canonicalize it with the existing workspace href primitive; reject
   a non-canonical or invalid value.
3. Parse its pathname.
4. Return `Resume` for pathname `/`; otherwise return `Navigate` with the full
   pathname+search href.
5. Branch exhaustively on `kind`.

Do not add `APP_LAUNCH_HREF`, a second route registry, a boolean
`isNeutral`, or a resurrected `isNeutralWorkspaceRestoreIntent`.

### Bootstrap composition

Retain the two-wave bootstrap:

- **Navigate Wave 1:** required reader profile + optional saved session + URL
  pane seed, concurrent.
- **Resume Wave 1:** required reader profile + optional saved session,
  concurrent; there is no speculative root seed.
- Select restored state with existing `selectRestoredState` unchanged.
- For Resume, choose `restored ?? createDefaultWorkspaceState(
  WORKSPACE_DEFAULT_FALLBACK_HREF, metrics)`.
- For Navigate, retain the current deep-link state and merge algebra unchanged.
- **Wave 2:** seed every remaining visible pane, concurrent and deduplicated by
  route identity.

Remove `initialHref` from `loadWorkspaceBootstrap`'s result. No consumer uses
it; returning it preserves a dead second representation of entry intent.

### Root and Launcher composition

- Delete the Next root redirect.
- Add the normal authenticated root leaf
  `app/(authenticated)/page.tsx`, matching the existing null-rendering pane
  route leaves. The shared authenticated layout remains the UI owner.
- Keep PWA `manifest.ts` `start_url: "/"` unchanged.
- Keep Launcher query parsing in its existing controller. Consume the initial
  query in a layout effect so it completes before the workspace's passive
  state-to-URL projection. Do not teach the workspace store Launcher syntax.

### Android composition

Keep `singleTask`, the current WebView, and the current owned-origin check.

- `onCreate`: null data loads `BuildConfig.NEXUS_BASE_URL`; owned data loads the
  exact URI.
- `onNewIntent`: always call `super` and `setIntent`; null data then returns
  without loading. Owned data follows the same exact-URI path.
- Refactor `loadUrlFromIntent` only enough to distinguish “no data” from
  “explicit but unsupported data.” Unsupported explicit data returns; it never
  falls through to the base URL.
- Auth handoff conversion and explicit callback behavior remain unchanged.

## API and schema design

- **Public API:** none.
- **Backend/BFF contract:** none.
- **Persisted schema:** unchanged `WorkspaceState` and `workspace_sessions`.
- **New internal schema:** only the private `WorkspaceEntryIntent` union above.
- **Existing capabilities reused:** `REQUEST_PATH_HEADER`,
  workspace href validation, `selectRestoredState`,
  `mergeRestoredWorkspaceWithDeepLink`,
  `createDefaultWorkspaceState`, `WORKSPACE_DEFAULT_FALLBACK_HREF`,
  pane resource loaders, and state-to-URL projection.

## Hard cuts and deletions

- Delete `next.config.ts` root redirect and its structural config test.
- Delete bootstrap's missing-header-to-Lectern fallback and fallback test.
- Delete `initialHref` from the bootstrap return type/object and assertions.
- Delete Android's explicit-invalid-intent-to-base-URL fallback.
- Do not retain a feature flag, old root redirect, neutral-route helper, dual
  bootstrap branch, or backward-compatible overload.

`APP_AUTHENTICATED_HOME_HREF` and `WORKSPACE_DEFAULT_FALLBACK_HREF` are not
legacy: they continue to own explicit Home/auth-default and valid empty-state
semantics.

## File plan

### Runtime

| File | Change |
|---|---|
| `apps/web/next.config.ts` | Remove root redirect and now-unused Home import |
| `apps/web/src/app/(authenticated)/page.tsx` | Add null root leaf under the authenticated shell |
| `apps/web/src/lib/workspace/bootstrap.server.ts` | Require/classify entry; split Resume/Navigate; remove dead `initialHref` result |
| `apps/web/src/components/launcher/useLauncherController.ts` | Consume initial shell query before passive URL projection |
| `apps/android/app/src/main/java/app/nexus/android/MainActivity.kt` | Cold Resume vs warm no-op vs exact owned navigation |

### Tests

| File | Change |
|---|---|
| `apps/web/src/next-config.test.ts` | Delete obsolete redirect test/import |
| `apps/web/src/lib/workspace/bootstrap.server.test.ts` | Cover exhaustive Resume/Navigate contract and remove fallback/result-field assertions |
| `e2e/tests/workspace-session-restore.spec.ts` | Prove `/` restores the exact active workspace with no Lectern insertion |
| `e2e/tests/launcher.spec.ts` | Prove root Launcher intent composes over restored state |
| `apps/android/app/src/androidTest/java/app/nexus/android/MainActivityTest.kt` | Prove warm launcher re-entry preserves current URL; keep exact callback coverage |

### Current documentation

| File | Change |
|---|---|
| `docs/modules/app-navigation.md` | Separate Resume `/` from explicit Home `/lectern` |
| `docs/architecture.md` | Document entry classification in server restore |
| `docs/cutovers/first-paint-speed-streaming-and-restore-hard-cutover.md` | Supersede stale bare-landing/`initialHref` wording only |
| `docs/cutovers/auth-return-target-hard-cutover.md` | Supersede stale root-redirect wording only |

### Deliberately unchanged

`manifest.ts`, `routes/defaults.ts`, `workspaceHref.ts`,
`workspaceRestore.ts`, `schema.ts`, `store.tsx`, `useWorkspaceSession.ts`,
Android manifest/launch mode, auth redirects, and all backend files.

The Android runtime/test files currently contain unrelated status-bar work.
Implementation must preserve it and edit only the intent lifecycle slice.

## Implementation order

1. Add the authenticated root leaf; delete the static root redirect/test.
2. Hard-cut bootstrap entry classification and dead `initialHref`.
3. Preserve root Launcher query consumption before URL projection.
4. Hard-cut Android cold/warm intent behavior.
5. Update focused unit, E2E, and instrumentation coverage.
6. Update current architecture/module docs and supersession note.
7. Search for stale root-redirect, bare-Lectern, missing-header fallback, and
   `initialHref` claims; remove only this cutover's dead references.

## Acceptance criteria

- **AC1.** Seed a saved workspace with no Lectern pane and Notes active; GET `/`
  first-paints that exact workspace, keeps Notes active, adds no Lectern pane,
  and projects the URL to Notes.
- **AC2.** With no usable session, GET `/` first-paints one Lectern pane.
- **AC3.** GET `/?launcher=1&lane=browse&q=kafka` restores the saved workspace,
  opens Browse Launcher with `kafka`, and adds no `/` pane.
- **AC4.** GET `/lectern` retains current reuse/append-and-activate behavior.
- **AC5.** Another explicit deep link retains current merge, first-paint, and
  resource-seeding behavior.
- **AC6.** Missing/malformed request-path identity rejects bootstrap; no
  Lectern substitution occurs.
- **AC7.** A warm null-data Android launcher intent leaves `webView.url` and
  WebView history unchanged.
- **AC8.** Cold null-data Android launch loads the base root; owned App Links
  and auth callbacks load their exact URL; unsupported explicit URIs do not
  load root.
- **AC9.** No new client workspace-session GET, schema, API, feature flag,
  compatibility path, or duplicate route constant exists.
- **AC10.** Focused web unit/E2E and Android instrumentation tests pass; current
  explicit navigation, auth callback, and background/resume tests remain green.

## Focused verification

```bash
cd apps/web
bunx vitest run --project unit src/lib/workspace/bootstrap.server.test.ts \
  -t 'required request-path|malformed or non-canonical|saved root workspace|root shell query|Lectern default only|honors Lectern home intent|merges the deep-link pane|seeds the libraries pane resource keyed exactly'
bunx vitest run --project unit src/next-config.test.ts
bunx vitest run --project browser src/components/launcher/Launcher.test.tsx

cd ../../e2e
bunx playwright test \
  tests/workspace-session-restore.spec.ts \
  tests/launcher.spec.ts \
  --grep 'root Resume|root Launcher intent'

cd ../apps/android
./gradlew --no-daemon :app:connectedDebugAndroidTest \
  -PnexusGoogleWebClientId=test-web-client-id \
  -Pandroid.testInstrumentationRunnerArguments.class='app.nexus.android.MainActivityTest#coldLauncherIntentLoadsTheBaseRoot,app.nexus.android.MainActivityTest#unsupportedExplicitIntentDoesNotReloadTheWebView,app.nexus.android.MainActivityTest#ownedCallbackIntentWhileRunningLoadsThatExactUrl,app.nexus.android.MainActivityTest#warmLauncherIntentPreservesWebViewHistoryAndBackNavigation,app.nexus.android.MainActivityTest#ownedNexusUrlLoadsInsideTheWebView,app.nexus.android.MainActivityTest#nexusAuthStartDefaultsMissingNextToLectern,app.nexus.android.MainActivityTest#backgroundingAndResumingKeepsTheWebViewLoaded'
```

Do not substitute broad verification for these owner-level proofs. Run wider
checks only if a shared owner changed beyond the file plan.
