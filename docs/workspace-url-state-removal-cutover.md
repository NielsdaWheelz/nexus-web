# Workspace URL State Removal Cutover

## Status

Proposed. Hard cutover. No legacy code, no fallbacks, no backward compatibility,
no schema migration. When this ships, the workspace layout no longer lives in the
URL in any form, and the workspace schema version concept is deleted outright.

## Problem Statement

The workspace today serializes the **entire** layout into the query string:

```
/conversations/abc123?wsv=8&ws=<base64url-json>
```

- `wsv` (`WORKSPACE_VERSION_PARAM`, `schema.ts:23`) is a schema version, currently `8`.
- `ws` (`WORKSPACE_STATE_PARAM`, `schema.ts:24`) is a base64url-encoded JSON blob of
  the full `WorkspaceState`: every pane's `href`, `primaryWidthPx`, `sidecar`,
  `visibility`, and per-pane back/forward `history` stacks, capped at 1800 chars
  (`urlCodec.ts:18`).

This is the only opaque, serialized, versioned blob in the app's URLs. It carries
real cost:

1. **Opaque.** The blob cannot be read, edited, or reasoned about. It forfeits the
   only thing a URL is good for — being an address.
2. **Silently destructive.** On version mismatch (`urlCodec.ts:179`) or oversize
   payload (`urlCodec.ts:122`), decode discards the layout and resets to default.
   Every `wsv` bump (now at 8) is a "reset everyone's open layout" event.
3. **Three copies of one fact.** The same `WorkspaceState` lives in (a) the URL
   blob, (b) the server session store (`/api/me/workspace-session`), and (c) the
   React reducer — reconciled by `mergeRestoredWorkspaceWithUrlIntent` and
   `isColdOpen`. This violates `docs/rules/cleanliness.md`: "One concern, one
   owner… If a registry or cache mirrors a source of truth that already exists,
   delete it."
4. **The URL only addresses half the truth.** The path names the active pane; the
   blob names everything else. Two side-by-side panes → the path identifies one,
   the rest is buried in base64.

We have decided **cross-user layout sharing is not a requirement**. That decision
removes the only reason full layout state must travel in the URL. Reload survival
and cross-device restore are already handled by the server session store. The blob
is pure cost.

## Goals

- Remove `wsv` and `ws` from the URL entirely. The workspace never reads from or
  writes layout to the query string again.
- Delete the schema version concept (`WORKSPACE_SCHEMA_VERSION`, `wsv`, the
  `schemaVersion` field on `WorkspaceState`). No versioning anywhere.
- Make the **server session store the single source of truth** for full layout,
  with the in-memory reducer as its live working copy.
- Make the **URL a pure projection** of the active pane's location: a deep-link
  entry point and a cosmetic address bar, kept in sync via `replaceState` only.
- Delete the URL codec, the decode/encode telemetry, the version-mismatch and
  payload-size fallbacks, and the cold-open branch.
- Reduce the three state representations to one owner (server store) plus one
  derived projection (URL).
- Keep deep-linking working: opening `/conversations/abc123` fresh focuses or
  opens that resource.

## Non-Goals

- **Cross-user sharing.** Explicitly dropped. A pasted URL restores only the
  active pane's resource, not the sender's full multi-pane layout.
- **Synchronous local layout cache / SSR of the full layout.** Out of scope. We
  accept a brief active-pane-first → siblings-hydrate transition on load (see
  Known Tradeoffs). A `localStorage`/`sessionStorage` fast path is a deferred
  optimization, not part of this cutover.
- **Changing the pane, sidecar, sizing, or title models.** Untouched.
- **Backend schema or endpoint changes.** The `workspace_sessions` table and the
  `/api/me/workspace-session` contract are unchanged. The server already stores
  state as opaque JSONB and never inspected `wsv`.
- **The mobile palette's own history usage** (`PaletteMobileShell.tsx:88-98`,
  `pushState`/`popstate`/`history.back` for the overlay) — a separate feature,
  left alone.
- **Removing the vestigial `page.tsx` route files.** They register routes for
  Next.js; reducing them to bare markers is a separate cleanup.

## Repository Rules

- `docs/rules/cleanliness.md`: one concern, one owner; collapse duplicate
  state/derivations; delete caches that mirror an existing source of truth.
  Reducing three layout copies to one is the core of this cutover.
- `docs/rules/layers.md`: parse transport shapes at the boundary and pass typed
  values inward; client product data goes through `/api/*`. Restore-time
  sanitization is the boundary parse; the session endpoint is the `/api/*` owner.
- `docs/rules/control-flow.md`: exhaustiveness; no catch-all branches that
  silently accept new variants. Removing version-coded fallbacks removes a
  silent-reset branch.
- `docs/rules/simplicity.md`: prefer deletion. This cutover is net-negative LOC.
- Project context: AI-first, simple, single-user prototype — favor deleting
  complexity over preserving it.

## Vocabulary

### Active Pane

The single pane currently focused (`state.activePaneId`). Its `href` is what the
address bar reflects.

### Layout

The full `WorkspaceState`: the ordered set of panes, their sizes, sidecars,
visibility, per-pane history, and which one is active. Owned by the server session
store; held live in the reducer.

### Deep-Link Intent

The single-pane resource derived from `window.location` (pathname + non-empty
search + hash) **at mount only**. It says "make this resource the active pane,"
nothing about siblings. External open events (command palette, window messages)
are not deep-link intent: they carry their own href in the event/message payload
and are normalized and dispatched directly — they never read `window.location`.

### URL Projection

The address bar as an **output** of the store: the active pane's `href`, written
via `replaceState`. It is never read back as layout state.

## Target Behavior

### Address Bar

- The URL is always exactly the active pane's `href` (pathname + that pane's own
  query params such as `?run=`/`?draft=` + hash). No `wsv`, no `ws`, ever.
- When the active pane navigates, or the active pane changes, the store calls
  `window.history.replaceState(null, "", activePaneHref)`. Never `pushState`.
- The URL is write-only from the store's perspective after load. The store never
  decodes layout from it again.

### Load (cold, warm, and deep link are now one path)

1. Next.js mounts `(authenticated)/layout.tsx` → `AuthenticatedShell` →
   `WorkspaceStoreProvider` → `WorkspaceHost` for whatever path was requested.
2. The store seeds **synchronously** from the Deep-Link Intent: a single visible
   pane whose `href` is the requested location. First paint shows that pane
   immediately (correct content, correct route).
3. The store then **always** attempts a session restore (no `isColdOpen` gate):
   `GET /api/me/workspace-session?device_id=…`, choose `own` else
   `most_recent_elsewhere`, `prepareRestoredState`, then merge the Deep-Link
   Intent into the restored layout.
4. Merge rule (`mergeRestoredWorkspaceWithDeepLink`, née
   `mergeRestoredWorkspaceWithUrlIntent`): if the restored layout already has a
   pane for the requested resource, focus it (and navigate it to the requested
   href); otherwise append a pane for it and focus it. A neutral intent (the bare
   default home href) restores the layout untouched.
5. If the user interacted before the fetch resolved, the restore is skipped
   (existing `workspaceStatesEqual(stateRef.current, baseline)` guard).

### Save

Unchanged: debounced (1s) `PUT /api/me/workspace-session`, plus a `keepalive` flush
on `pagehide`/`visibilitychange`. History bounding needs no new code — the reducer
already runs `trimWorkspacePaneHistory` on every action (via
`trimAndEnsureActivePaneId`), so the live state, and therefore every PUT, is always
trimmed. The deleted URL-encode trim was redundant with this, not load-bearing.

### Browser Back / Forward — Key Decision

Browser Back/Forward is **no longer a workspace navigation primitive**. Because the
store only ever calls `replaceState`, it creates no intra-app history entries; the
existing `popstate`-decodes-the-blob handler (`store.tsx:916`) is deleted. In-app
navigation is the per-pane back/forward already in the model
(`goBackPane`/`goForwardPane`, the `history.back/forward` stacks). The workspace
neither creates nor consumes browser history entries; pressing Back simply follows
whatever prior browser entry exists (an earlier full-page navigation within the
app, or the previous site) — the workspace does not react to it.

Rejected alternative: intercept `popstate` and map browser Back to "active pane
goBack." Rejected because it reintroduces a second, competing history model on top
of the per-pane stacks the app already owns, and `pushState` of cosmetic
active-pane changes pollutes browser history with non-navigational entries. See
Resolved Decisions.

### Offline / Unauthenticated Load

Layout restore requires the session endpoint. If it is unreachable, the user gets
the Deep-Link Intent pane only (today they would also get whatever was in a shared
URL, if any). Acceptable for a single-user authenticated app.

## Architecture

### Before

```
URL (?wsv&ws blob) ─decode→ reducer ─encode→ URL        (push/replace, popstate re-decode)
        ▲                      │
        └──── server session (cold-open only) ───────────┘
3 representations, reconciled by isColdOpen + mergeRestoredWorkspaceWithUrlIntent
```

### After

```
server session store  ◀── PUT (debounced + flush) ── reducer ── replaceState ▶ URL (active pane href, projection)
        │                                               ▲
        └──────────── GET restore (always) ─────────────┘  merged with deep-link intent from URL path
1 source of truth (server) + 1 live copy (reducer) + 1 derived projection (URL)
```

### Why this is low risk on the render path

`(authenticated)/layout.tsx:1-7` renders `AuthenticatedShell` and does **not**
render `{children}`. Route `page.tsx` files (e.g. `ConversationPage` →
`ConversationPaneBody`) are vestigial registrations. All pane content is rendered
client-side by `WorkspaceHost` from the store via `PaneContent` →
`ResolvedPaneRouteView` (`WorkspaceHost.tsx:274-396`), keyed on `resolvePaneRouteModel(pane.href)`.
The URL path already does not drive rendering. We are formalizing the URL's
existing role (cosmetic projection + deep-link entry), not changing how panes mount.

## Final State

After the cutover the workspace URL layer consists of exactly:

- A read of `window.location` **at mount only**, parsed into a single-pane
  Deep-Link Intent. External opens (command palette / window messages) normalize
  their own provided href and dispatch `open_pane` directly — they never read
  `window.location`.
- A `replaceState` write of the active pane's href whenever it changes.

There is no codec, no version, no `ws`/`wsv`, no `popstate` workspace handler, no
encode/decode telemetry, no cold-open branch, no `schemaVersion` field, no
1800-char cap.

## Capability Contract

### Layout ownership

- The **server session store** owns the canonical layout, keyed `(user_id,
  device_id)`, last-write-wins (`python/nexus/services/workspace_sessions.py`).
- The **reducer** is the live working copy, mutated by user actions.
- The **URL** is a derived projection of `activePaneHref(state)`; it is never an
  input to layout.

### `WorkspaceState` (post-cutover)

```ts
export interface WorkspaceState {
  // schemaVersion: REMOVED
  activePaneId: string;
  panes: WorkspacePaneState[];
}
```

`WorkspacePaneState` is unchanged (`id`, `href`, `primaryWidthPx`, `sidecar`,
`visibility`, `history`).

### Restore boundary (the sole compatibility mechanism)

`sanitizeWorkspaceState(raw, { fallbackHref, workspacePrimaryMetrics })` is the
single boundary that turns untrusted JSON (from JSONB storage) into a valid
`WorkspaceState`. Its semantics are **valid-or-reset**, evaluated whole-state — not
per-pane salvage. The cutover removes exactly one line from it: the
`value.schemaVersion !== WORKSPACE_SCHEMA_VERSION` clause at `schema.ts:262` (and
the `schemaVersion:` it writes back at `schema.ts:305`). Nothing else in the
sanitizer changes. After that removal it behaves as today:

- **Field-lenient where it already is:** an invalid/missing `href` falls back to
  `fallbackHref` (`schema.ts:219-220`); a missing/duplicate `id` is regenerated
  (`schema.ts:226-229`); a numeric `primaryWidthPx` is clamped to policy
  (`schema.ts:235-238`); an invalid `sidecar` is sanitized (nulled if ineligible).
- **All-or-nothing on structural breaks:** if **any** pane has an invalid
  `visibility`, invalid `history`, or a non-numeric `primaryWidthPx`,
  `sanitizePane` returns `null` and the **entire state resets to the default
  single pane** (`schema.ts:232-233`, `schema.ts:281-283`) — individual bad panes
  are not dropped. Likewise if `panes` is empty, has no visible pane, or
  `activePaneId` resolves to nothing visible.
- **Bounds:** `MAX_PANES` truncates extras (`schema.ts:271-273`); history is
  trimmed (`MAX_PANE_HISTORY_STACK_LENGTH`, `MAX_TOTAL_PANE_HISTORY_ENTRIES`).

Consequence for old rows: a row written by the **current** (pre-cutover) client
already matches the current pane shape — numeric `primaryWidthPx`, valid
`visibility`/`history` — and differs only by carrying `schemaVersion`. With the
version clause removed, such a row restores intact. A row written by an **older**
client whose pane shape differs (e.g. legacy `widthPx` instead of
`primaryWidthPx`) does **not** restore — it resets to the default. That is the
intended "no migration, no backward compatibility" behavior, not a regression to
fix. We are **not** changing the sanitizer to salvage individual panes.

## API Design

### New / changed surface

No new helpers. Per the minimalism rules, the projection and the deep-link intent
are inlined at their single call sites in `store.tsx`, and one function is renamed:

- **Address-bar projection (inlined in the sync effect).** `buildWorkspaceUrl` is
  deleted; the sync effect finds the active visible pane and `replaceState`s its
  `href` directly. Pane hrefs are already normalized and never carry `ws`/`wsv`,
  so no codec, parse, or strip step is needed.
- **Deep-link intent (inlined at mount).** `getWindowLocationState` is deleted; the
  mount effect builds the initial single-pane state as
  `createDefaultWorkspaceState(<window.location pathname+search+hash>, metrics)`.
  `createDefaultWorkspaceState` already normalizes the href (`schema.ts:117`), so
  there is nothing else to do. The mounted state is itself the deep-link intent
  passed to the merge.
- **Merge rename only.** `mergeRestoredWorkspaceWithUrlIntent` →
  `mergeRestoredWorkspaceWithDeepLink(restored, deepLink, metrics)`. Same logic,
  minus the removed `schemaVersion`.

### Removed surface (deleted, not deprecated)

`urlCodec.ts` in full: `encodeWorkspaceStateParam`, `decodeWorkspaceStateParam`,
`decodeWorkspaceStateFromUrl`, `buildWorkspaceUrl`, `buildWorkspaceFallbackHref`,
`MAX_WORKSPACE_STATE_PARAM_LENGTH`, `WorkspaceDecodeResult`, `WorkspaceEncodeResult`,
the base64url helpers, `stripWorkspaceParams`.

`schema.ts`: `WORKSPACE_SCHEMA_VERSION`, `WORKSPACE_VERSION_PARAM`,
`WORKSPACE_STATE_PARAM`, and the `schemaVersion` field.

`sessionSync.ts`: `isColdOpen`.

`store.tsx`: `publishDecodeTelemetry`, `lastDecodeError`/`lastEncodeError` meta,
`lastDecodeTelemetryRef`/`lastEncodeTelemetryRef`, the `popstate` workspace
handler, the `HistoryMode` push/replace machinery and the `historyMode` parameter
on `dispatchAndSync`, `skipSyncRef`.

`telemetry.ts`: the `"decode"` and `"encode"` codec telemetry variants (keep
`"title"`, still emitted at `WorkspaceHost.tsx:480`).

## Composition With Existing Systems

### Next.js App Router

- Routes still exist (deep links must resolve to 200 and SSR a shell). The active
  pane's path is a real route segment; siblings are client-only and do not change
  the mounted Next.js route. `replaceState` does not trigger Next.js navigation —
  same as today.
- The vestigial `page.tsx` files are unaffected.

### Server session store

- No change. `GET` returns `{ own, most_recent_elsewhere }`; `PUT` upserts by
  `(user_id, device_id)`. State remains opaque JSONB (64 KB cap). Removing
  `schemaVersion` from the body is a no-op server-side. Old rows restore fine via
  shape sanitization.

### Android shell

- `prepareRestoredState` keeps filtering Android-restricted hrefs
  (`isAndroidShellRestrictedHref`). Unchanged.

### Command palette / external opens

- `NEXUS_OPEN_PANE_EVENT`, `window.message`, and the pending-open queue
  (`store.tsx:924-962`) continue to open panes. These dispatch `open_pane`
  directly; they do not depend on URL state. The only change: `open_pane` no
  longer needs a `"push"` history mode.

### Mobile palette

- `PaletteMobileShell` keeps its own `pushState`/`popstate`/`history.back` for the
  overlay. Out of scope; verify no shared assumption with the deleted workspace
  `popstate` handler (there is none — different listener, different purpose).

## Extant Patterns To Reuse

- **Sanitize-at-boundary** (`sanitizeWorkspaceState`) already exists and is the
  right compat mechanism — keep and lean on it; delete version checks from it.
- **Session seeding in E2E** already exists (`workspace-session-restore.spec.ts`,
  `pane-chrome.spec.ts` define a `putWorkspaceSession` wrapper). Promote this into
  the shared `e2e/tests/workspace.ts` helper as the canonical multi-pane setup,
  replacing URL construction.
- **`replaceState` projection** is already used (`store.tsx:1067`); the cutover
  keeps that line and removes the `pushState` branch and the encode call feeding it.
- **Deep-link intent** is the existing `"inferred"` decode path
  (`urlCodec.ts:168-178` builds a single pane from the current pathname); we keep
  that behavior, just sourced directly from `window.location` without the codec.

## Files To Change

- `apps/web/src/lib/workspace/schema.ts`
  - Remove `WORKSPACE_SCHEMA_VERSION`, `WORKSPACE_VERSION_PARAM`,
    `WORKSPACE_STATE_PARAM`, and the `schemaVersion` field on `WorkspaceState`.
  - In `sanitizeWorkspaceState`: delete only the
    `value.schemaVersion !== WORKSPACE_SCHEMA_VERSION` clause (`schema.ts:262`) so
    the guard becomes `if (!isRecord(value))`, and drop `schemaVersion:` from the
    returned object (`schema.ts:305`). Leave the valid-or-reset, all-or-nothing
    pane logic exactly as-is — no per-pane salvage.
  - In `createDefaultWorkspaceState`: drop the `schemaVersion:` it sets.
  - Keep `trimWorkspacePaneHistory` and the `MAX_*` history bounds (now serving
    session-size hygiene instead of URL length).
- `apps/web/src/lib/workspace/store.tsx`
  - Delete the `urlCodec` import; inline the mount intent as
    `createDefaultWorkspaceState(<window.location pathname+search+hash>, metrics)`
    and delete `getWindowLocationState`.
  - Delete the `popstate` workspace handler; keep the open-pane/message listeners.
  - State→URL effect: find the active visible pane and
    `window.history.replaceState(null, "", activePane?.href ?? WORKSPACE_DEFAULT_FALLBACK_HREF)`;
    delete `buildWorkspaceUrl`, encode/decode telemetry, `setMeta`/`lastDecodeError`/
    `lastEncodeError` and their refs, the `emitWorkspaceTelemetry` import,
    `skipSyncRef`, `historyModeRef`, the `HistoryMode` type, and `dispatchAndSync`
    (convert every `dispatchAndSync(action, _)` call to `dispatch(action)`).
  - **Keep** the `mode: "push" | "replace"` field carried inside `open_pane`/
    `navigate_pane` actions — that drives the per-pane history stack and is
    unrelated to browser history. Only the browser-history (`replaceState`) machinery
    is removed.
  - Rename `mergeRestoredWorkspaceWithUrlIntent` → `mergeRestoredWorkspaceWithDeepLink`;
    drop `schemaVersion` from the constructed state.
- `apps/web/src/lib/workspace/sessionSync.ts`
  - Delete `isColdOpen` and the `WORKSPACE_STATE_PARAM`/`WORKSPACE_SCHEMA_VERSION`
    imports.
  - `prepareRestoredState`: drop `schemaVersion` from the returned object (sanitize
    already trims history, so no extra trim).
  - `workspaceStatesEqual`: remove the `schemaVersion` comparison.
  - `isNonTrivialSession`: unchanged.
- `apps/web/src/lib/workspace/useWorkspaceSession.ts`
  - Remove the `isColdOpen` gate — always attempt restore on mount; keep the
    in-flight-change guard. No trim needed (reducer already trims).
- `apps/web/src/lib/workspace/telemetry.ts`
  - Remove the `decode`/`encode` (`WorkspaceCodecTelemetryDetail`) variant; collapse
    to the single `title` shape; keep `emitWorkspaceTelemetry`.
- `apps/web/src/lib/workspace/workspaceHref.ts`
  - Unchanged. The projection is inlined in the store (no new helper).

## Files To Add

- None required. (`activePaneAddressBarHref` lives in `workspaceHref.ts`.)

## Files Or Symbols To Delete

- `apps/web/src/lib/workspace/urlCodec.ts` — entire file.
- `apps/web/src/lib/workspace/urlCodec.test.ts` — entire file.
- All `wsv`/`ws` URL construction in E2E (see Tests).

## Tests

### Unit / component

- **Grep-driven `schemaVersion` cleanup (do this first).** Removing the
  `schemaVersion` field makes every object literal that still sets it a TS
  excess-property error, including mocks outside the workspace lib. Run
  `grep -rln "schemaVersion" apps/web/src` and strip the field from **all** of
  them. Known sites beyond schema/sessionSync/store/urlCodec tests:
  - `apps/web/src/components/workspace/WorkspaceHost.test.tsx:15` (mock store
    `state`).
  - `apps/web/src/lib/androidShell.commandPalette.test.tsx:11` (hoisted mock store
    `state`).
  Re-run the grep after edits to confirm zero remaining references in app code.
- **Delete** `urlCodec.test.ts` (all cases test the deleted codec).
- **Rewrite** the `mergeRestoredWorkspaceWithUrlIntent` block in `store.test.tsx`
  as `mergeRestoredWorkspaceWithDeepLink`: deep-link focuses an existing matching
  pane; appends when absent; neutral intent restores untouched; respects
  `MAX_PANES`. Keep the `/api/me/workspace-session` mock.
- **Update** `sessionSync.test.ts`: drop `schemaVersion` from fixtures; remove the
  `workspaceStatesEqual` schemaVersion-difference case.
- **Update** `schema.test.ts`: remove version-mismatch sanitize cases; keep all
  shape-sanitization cases.
- **Add** a store test: mount on `/conversations/:id` with a stored multi-pane
  session → restored layout contains the deep-linked pane as active; address bar
  ends as the active pane href with no `wsv`/`ws`.
- **Add** a store test: navigating the active pane updates the address bar via
  `replaceState` and never appends query params; opening a second pane does not
  push browser history.

### E2E

- Promote the `putWorkspaceSession` seeding wrapper into `e2e/tests/workspace.ts`;
  delete `WORKSPACE_E2E_SCHEMA_VERSION` and the local `encodeWorkspaceStateParam`
  copy and all `wsv`/`ws` URL building.
- Rewrite multi-pane setup in `workspace-history`, `workspace-tabs`,
  `workspace-canvas`, `command-palette`, `workspace-pane-minimize`,
  `workspace-session-restore` to seed via session PUT (or UI actions) and assert
  clean URLs (no `wsv`/`ws`). Back/forward assertions that relied on blob restore
  are rewritten against per-pane back/forward.

### Backend

- No changes required. Optionally drop `schemaVersion` from
  `test_workspace_sessions.py` fixtures for tidiness (server ignores it).

## Acceptance Criteria

1. No app code references `wsv`, `ws`, `WORKSPACE_VERSION_PARAM`,
   `WORKSPACE_STATE_PARAM`, `WORKSPACE_SCHEMA_VERSION`, or `schemaVersion`
   (verified by grep returning only deleted-test absence).
2. `urlCodec.ts` and `urlCodec.test.ts` are deleted; the project type-checks and
   lints clean.
3. With a single pane, the URL is the pane's href and contains no query params
   beyond the pane's own (`?run=`, etc.).
4. With multiple panes, the URL is exactly the active pane's href; switching the
   active pane updates the address bar; reloading restores all panes from the
   session store with the URL's resource active.
5. Opening, closing, minimizing, or restoring a pane adds **no** browser history
   entry; the address bar only ever changes via `replaceState`.
6. A fresh deep link to `/conversations/:id` with no/neutral session opens that
   conversation as the sole pane; with a stored layout, it focuses or appends that
   pane within the restored layout.
7. The `popstate` workspace handler is gone; in-app per-pane back/forward still
   works.
8. No decode/encode telemetry is emitted; `title` telemetry still fires.
9. A stored session row written by the **current** pre-cutover client — already
   matching the current pane shape (numeric `primaryWidthPx`, valid
   `visibility`/`history`) and differing only by carrying `schemaVersion` —
   restores intact once the version clause is removed, without resetting to
   default. Rows from older pane shapes are explicitly unsupported (no migration)
   and reset to default; this is intended, not a bug.
10. Cross-device `most_recent_elsewhere` restore still works.
11. Server: zero changes; existing backend tests pass.

## Known Tradeoffs

- **Active-pane-first hydration.** Every load now restores siblings via an async
  session fetch, so a multi-pane layout briefly shows the active pane before the
  rest hydrate (~1 RTT). Previously a URL with a blob restored all panes
  synchronously. The active/deep-linked pane is always correct immediately. A
  synchronous local cache could remove the transition but is a deferred non-goal.
- **Offline/unauth loads** restore only the active pane. Acceptable for a
  single-user authenticated app with no sharing requirement.
- **Browser Back no longer undoes pane operations.** The workspace neither creates
  nor consumes browser history entries; Back follows whatever prior browser entry
  exists (see Key Decision). In-app per-pane back/forward is the navigation model.

## Resolved Decisions

1. **Browser Back/Forward semantics — DECIDED: `replaceState`-only.** The store
   never calls `pushState`, so the workspace creates no browser history entries and
   the `popstate` workspace handler is deleted; Back follows whatever prior browser
   entry exists and the workspace does not react to it. In-app per-pane
   back/forward (`goBackPane`/`goForwardPane`) is the sole workspace navigation
   model. The "map Back → active-pane goBack" alternative is rejected (competing
   history models, cosmetic `pushState` pollution).
2. **Hydration transition — DECIDED: accept active-pane-first hydration.** The
   server session store is the sole layout store; no synchronous local cache in
   this cutover. Reload shows the active pane immediately and hydrates siblings
   ~1 RTT later. A `localStorage` write-through cache remains a deferred non-goal.

## Implementation Plan

1. **Delete the codec.** Remove `urlCodec.ts` + test. Temporarily breaks
   `store.tsx` imports — expected.
2. **Strip versioning from `schema.ts`.** Remove the version constant, the param
   constants, the `schemaVersion` field, and version checks in sanitize/default.
3. **Rewrite the store's URL boundary.** Add `readDeepLinkIntent` and
   `activePaneAddressBarHref`; seed at mount; convert the sync effect to
   `replaceState`-only; delete the `popstate` handler, history-mode machinery,
   `skipSyncRef`, and decode/encode telemetry; rename the merge function.
4. **Simplify the session hook.** Remove `isColdOpen`; always restore; trim before
   PUT.
5. **Trim telemetry.** Drop `decode`/`encode` variants.
6. **Fix unit/component tests.** Delete codec tests; rewrite merge tests; update
   schema/sessionSync fixtures; add the new projection + deep-link tests.
7. **Fix E2E.** Centralize session seeding; remove all `wsv`/`ws` URL building;
   rewrite back/forward assertions.
8. **Verify acceptance criteria**, including a pre-cutover-row restore and a
   cross-device restore.
