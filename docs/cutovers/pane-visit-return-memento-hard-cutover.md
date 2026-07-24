# Pane Visit Return Memento Hard Cutover

Status: IMPLEMENTED · FOCUSED LOCAL PROOF COMPLETE · REAL-STACK E2E AND PRODUCTION GATE PENDING — 2026-07-23
Type: hard cutover
Date: 2026-07-23

## Decision

Pane Back/Forward traverses visit occurrences, not bare hrefs. Every supported
primary route participates. Every route except Reader, the Chat transcript, and
non-scrolling Atlas restores the viewport it had when the user left it.

```text
PaneVisit in workspace history
  -> visit-scoped, current-tab ReturnMemento
  -> PaneShell's one ordinary vertical scrollport
  -> semantic anchor, then exact raw position
```

No blocking product decision remains. This spec fixes these boundaries:

- coverage is every supported primary route; only Reader/Chat transcript
  scroll and Atlas's non-vertical canvas are separate;
- return state is current-tab presentation state, never URL or server state;
- keyboard-origin row journeys restore row focus; pointer journeys do not;
- reload and cross-device restore retain pane history but start presentation at
  the top;
- pane activation/minimize, Reader location, Chat transcript scroll, and Atlas
  camera-azimuth rotation are separate capabilities.

## Goals

- Back and Forward return the user to the prior eye-line, including rows loaded
  beyond page one.
- Duplicate visits to the same href remain independent.
- One layer owns each concern: history, transient return state, scroll,
  collection identity, and route-owned loaded data.
- The implementation adds no router, query framework, scroll library, or
  persistence API.
- The final system has fewer scroll owners and fewer history branches than the
  current system.

## Scope

`PANE_ROUTE_MODELS` declares one exhaustive `returnMemento` contract per route.

| Contract | Routes |
|---|---|
| `ShellScroll` | `lectern`, `libraries`, `library`, `conversations`, `podcasts`, `podcastDetail`, `search`, `author`, `notes`, `page`, `note`, `settings`, `settingsAccount`, `settingsBilling`, `settingsReader`, `settingsAppearance`, `settingsLocalVault`, `settingsIdentities`, `settingsKeybindings`, `oracle`, `oracleReading` |
| `NoVerticalScroll` | `atlas` |
| `Excluded.Reader` | `media` |
| `Excluded.Chat` | `conversationNew`, `conversation` |

All `ShellScroll` routes use `bodyMode: "standard"` after the cutover. `PaneShell`
is their only vertical scroll owner. Existing route-owned vertical overflow in
podcast detail, Page, and Note is deleted. Oracle and Oracle Reading gain the
ordinary shell scroll contract. Atlas remains a full-height `document` canvas;
it participates in visit history but has no vertical return state.

`unsupported` is outside the supported-route contract.

## Non-Goals

- no reload, cross-tab, cross-device, or durable memento;
- no browser History API rewrite; the URL remains the active-pane projection;
- no Reader cursor/location change and no Chat transcript change;
- no pane-switch/minimize continuity contract;
- no modal, draft, selection, editor caret, media playback, canvas transform, or
  secondary-pane restoration;
- no virtualization, keep-alive route tree, generalized query cache, or
  universal pagination refactor;
- no animation or new visible UI.

## Final State And Ownership

| Owner | Responsibility |
|---|---|
| `schema.ts` / `workspaceRestore.ts` | persisted visit shape, exact decode, visit creation, push/replace/traversal/trim algebra |
| `WorkspaceStoreProvider` | resolve the target pane, synchronously capture before a displacing command, then dispatch the pure transition |
| `PaneReturnMementoProvider` | current-tab registry, restore coordination, cancellation, typed visit-data slots, reachable-visit pruning |
| `paneRuntime.tsx` | carry `visitId` and narrow return-data capability; no scroll or history logic |
| `PaneShell` | the sole primary-route vertical scrollport for `ShellScroll`; register its scrollport/content root and apply instant restoration |
| `CollectionView` / editor primitives | publish stable semantic anchors and ready state |
| route controller | own loaded DTOs/cursor and register one synchronous snapshot getter |
| `paneRenderRegistry.tsx` | resolved lazy-body marker inside the successful Suspense branch |
| `paneRouteModel.ts` | exhaustive inclusion/exclusion contract |

`ReturnMemento` is not workspace state. The provider is a browser-local runtime
service above the workspace store:

```text
PaneReturnMementoProvider
  WorkspaceStoreProvider
    WorkspaceHost
      PaneRuntimeProvider
        PaneShell
          PaneContent
            mount key:
              ShellScroll -> `${currentVisit.id}:${routeKey}`
              otherwise   -> existingRouteMountKey
            Suspense
              fallback: PaneLoadingState
              success: ResolvedPaneBodyMarker -> route body
```

## Capability Contract

### Persisted visits

```ts
type PaneVisitId = string & {
  readonly __paneVisitId: unique symbol;
};

interface PaneVisit {
  readonly id: PaneVisitId;
  readonly href: string;    // canonical workspace href
}

interface WorkspacePaneHistory {
  readonly back: PaneVisit[];
  readonly forward: PaneVisit[];
}

interface WorkspacePrimaryPaneState {
  readonly id: string;
  readonly currentVisit: PaneVisit;
  readonly primaryWidthPx: number;
  readonly visibility: "visible" | "minimized";
  readonly history: WorkspacePaneHistory;
  readonly attachedSecondaryPaneId: string | null;
}
```

There is no top-level `pane.href` after the cutover. Callers read
`pane.currentVisit.href`.

`PaneVisitId` is exactly a canonical lowercase UUID. `createPaneVisitId()` uses
required `crypto.randomUUID()`; it never uses `createRandomId` or a
timestamp/prefix fallback. `parsePaneVisitId(raw)` validates untrusted persisted
input. `assumePaneVisitId(value)` brands already-validated internal values. The
workspace decoder rejects a duplicate visit id anywhere across every pane's
current, Back, and Forward visits.

`parsePersistedWorkspaceState` is the one exact, isomorphic structural decoder
used at persisted GET restore and web-BFF PUT. Viewport-dependent width
adaptation happens later in `workspaceRestore.ts`; parsing never silently
rewrites malformed state.

### Transient memento

```ts
interface ReturnAnchorKey {
  readonly scope: string;
  readonly id: string;
}

interface ReturnAnchor {
  readonly key: ReturnAnchorKey;
  readonly viewportOffsetPx: number;
}

type FocusReturn =
  | { readonly kind: "None" }
  | {
      readonly kind: "Keyboard";
      readonly anchor: ReturnAnchorKey | null;
    };

interface ReturnMemento {
  readonly routeKey: string;
  readonly scrollTopPx: number;
  readonly anchor: ReturnAnchor | null;
  readonly focusReturn: FocusReturn;
}
```

`routeKey` is the exact view signature. A changed route key invalidates return
state for an in-place `replace`; do not add a second `viewSignature`.

The registry is keyed by `PaneVisitId`, never href; the value does not repeat
the key. It retains records only for visits reachable as a pane's current, Back,
or Forward visit. Existing history limits—12 per direction and 48 total—bound
visit count, not memory.

Loaded-extent values have fixed code constants:

- `MAX_PANE_VISIT_DATA_BYTES = 2 MiB` per visit;
- `MAX_PANE_RETURN_DATA_BYTES = 16 MiB` per tab.

Size is the UTF-8 byte length of the snapshot's JSON encoding, measured only at
synchronous navigation capture. An oversized candidate is not stored. Global
overflow evicts loaded-extent values only in this order: historical before
current visits; non-active before active panes; greatest history distance first;
then pane order and visit id as stable tie-breakers. Mementos are never
budget-evicted. This is deterministic topology-based retention, not time-based
LRU.

Before synchronous capture enforces this budget, the store publishes the pure
post-command visit topology. Back targets, retained branches, and discarded
Forward visits are ranked by the state being dispatched, never by stale
pre-command topology.

### Route capability

```ts
type PaneRouteReturnContract =
  | {
      readonly returnMemento: { readonly kind: "ShellScroll" };
      readonly bodyMode: "standard";
    }
  | {
      readonly returnMemento: { readonly kind: "NoVerticalScroll" };
      readonly bodyMode: "document";
    }
  | {
      readonly returnMemento: {
        readonly kind: "Excluded";
        readonly owner: "Reader";
      };
      readonly bodyMode: "document";
    }
  | {
      readonly returnMemento: {
        readonly kind: "Excluded";
        readonly owner: "Chat";
      };
      readonly bodyMode: "contained";
    };
```

Every literal route definition satisfies this union. Invalid ownership/body-mode
pairs are unrepresentable. Only Media and the two transcript routes may be
excluded; only Atlas may declare `NoVerticalScroll`.

### Route-owned loaded extent

The provider exposes one typed, visit-scoped slot API through pane runtime:

```ts
const KEY = definePaneVisitDataKey<Snapshot>("Domain.Pagination");
const restored = usePaneVisitData(
  KEY,
  () => committedSnapshotRef.current,
);

restored; // Snapshot | null during initial render
```

The capture getter returns `null` when no controller data has committed (for
example, an initial-load error); that stores no extent and never blocks
navigation. Each module-level key has opaque symbol identity plus a diagnostic name; equal
names do not alias. The provider stores the value under
`visitId + routeKey + KEY`; only the declaring route module knows `Snapshot`.
`captureCurrentSnapshot` reads `committedSnapshotRef`, which the controller
updates in a layout effect after the rendered controller state commits. Never
write capture refs during render or through a lagging passive publish effect.
An abandoned concurrent render must be unobservable to capture.

Required exact snapshot shapes:

```ts
interface LibrariesSnapshot {
  readonly libraries: readonly Library[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

interface LibrarySnapshot {
  readonly library: Library;
  readonly entries: readonly LibraryEntry[];
  readonly nextCursor: string | null;
}

interface SearchSnapshot {
  readonly rows: readonly SearchResultRowViewModel[];
  readonly nextCursor: string | null;
  readonly hasSearched: boolean;
}

type AuthorSnapshot = AuthorPaneSeed; // detail + works + worksNextCursor

interface ConversationsSnapshot {
  readonly conversations: readonly ConversationSummary[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

interface PodcastsSnapshot {
  readonly subscriptions: readonly PodcastSubscriptionListItem[];
  readonly hasMore: boolean;
  readonly nextOffset: number;
  readonly libraries: readonly MemberLibrary[];
}

interface PodcastDetailSnapshot {
  readonly detail: PodcastDetailResponse;
  readonly episodes: readonly PodcastEpisodeMedia[];
  readonly hasMoreEpisodes: boolean;
  readonly podcastLibraries: readonly PodcastLibraryMembership[];
}
```

These are the complete committed primary-controller data needed for a truthful
restored first render. Snapshots are immutable and JSON-safe. They exclude DOM
nodes, functions, requests, errors, busy/loading state, abort generations,
draft/search inputs, dialogs, expanded panels, selections, announcements, and
other process/UI state.

The href/route key already owns query, filter, sort, and library-view identity;
snapshots do not duplicate it. Restored data seeds the existing route controller
before first render and is authoritative for that visit's historical
presentation. Automatic initial-page effects must not overwrite or duplicate
it. Each owner has one rendered-extent state; delete parallel
base/appended/local branches that can diverge.

On a successful explicit mutation in any covered owner:

1. update the active controller with current server truth;
2. clear every previously captured loaded-extent value, but retain mementos;
3. let the active controller be captured afresh on its next departure.

The scoped clear keeps the caller visit eligible and blocks every other mounted
visit from capture. A blocked visit becomes eligible when it performs its own
scoped clear with fresh controller truth or registers a fresh getter after
remount; it cannot recapture pre-mutation truth in between.

When current truth requires async reconciliation, immediately set that
controller's committed capture ref to `null`, then clear extents. The getter
remains uncapturable until reconciled state commits. A delete followed by
synchronous navigation applies the same rule before the navigation command.

Explicit refresh uses the same global extent invalidation before refetch. This
coarse policy prevents same-tab explicit mutations from leaving stale
renamed/deleted/subscribed truth without adding tags, cross-entity patch graphs,
or a generalized cache. Otherwise an old visit intentionally remains historical
until explicit refresh or budget eviction. A visit without retained extent
refetches normally and degrades to anchor/raw clamping after readiness.

This is not `useResource` reuse: that cache remains consume-once first-paint and
prefetch infrastructure.

## Navigation Semantics

Every displacing command carries explicit input modality:

```ts
type PaneNavigationModality = "Keyboard" | "Pointer" | "Programmatic";
```

`PaneRouteBoundary` records pointer intent on `pointerdown` and keyboard intent
on activation `keydown`. The next synchronous navigation from that activation
event—delegated link or row-button router call—consumes the record. Pane chrome
does the same for Back/Forward. Calls without an activation record default to
`Programmatic`. CSS `:focus-visible` is presentation, never modality evidence.

| Action | Visit/history result | Presentation result |
|---|---|---|
| initial or new pane | mint current visit | top; no memento |
| `push` | append exact current visit to Back; mint target visit; clear Forward | capture source; target starts at top |
| `replace` | retain current visit id and both stacks; replace href | same route key retains live DOM; changed route key clears data/memento and starts at top |
| Back | pop Back to current; prepend displaced current to Forward | capture displaced visit; restore target |
| Forward | shift Forward to current; append displaced current to Back | capture displaced visit; restore target |
| same href | no-op | no capture or movement |
| branch after Back | normal `push`; discard Forward visits | delete discarded visits' mementos/data |
| close/trim | delete unreachable visits | prune their mementos/data |

Visit IDs are minted before reducer dispatch. Reducers are deterministic and
never call randomness or read the DOM. Back's nearest entry is its tail, so trim
its head; Forward's nearest entry is its head, so trim its tail. For the
workspace-wide 48-entry limit, preserve the existing deterministic pane-order
policy—first non-active pane with history, otherwise active—and evict Back head,
then Forward tail.

Existing entry points reduce to the same algebra:

- `open_pane`/adopt: activating an existing pane at the exact href is a no-op;
  navigating that pane elsewhere captures it and uses normal `push`;
- deep-link merge: a matched pane replaces its current href and retains its
  visit id; a new target pane mints a visit;
- URL-hash folding and provisional-route resolution are `replace`: same visit,
  no stack entry;
- restoring a workspace creates no memento; every current visit starts at top.

`routeKey` retains the existing hash-excluding semantics from
`normalizePaneRouteKeyHref`; hashes never create a visit or invalidate a
memento.

## Capture And Restore

Capture occurs synchronously before any command displaces a current visit.

1. Read PaneShell's registered scrollport.
2. Record `scrollTop`.
3. Independently find the first intersecting eye-line anchor; record its
   collision-safe
   `{scope, id}` and signed top offset relative to the scrollport.
4. Independently resolve the focused row from `document.activeElement`.
5. Store `focusReturn: {kind: "Keyboard", anchor}` only when the displacing
   command's explicit modality is `Keyboard`; store `None` for pointer and
   programmatic journeys. The focused row may differ from the eye-line row.

The exact DOM contract reuses identities shared primitives already own:

- every `CollectionView`, including `surface={false}`, renders one
  `[data-pane-return-scope="<Pascal.Dot.Scope>"]` root;
- collection anchors remain `[data-collection-row-id="<stable row id>"]`, and
  focus targets remain their existing `[data-row-focusable]`;
- Page/Note wrap the editor in
  `[data-pane-return-scope="Notes.EditorBlocks"]`; blocks retain their existing
  `[data-note-block-id]`;
- a scrollport may contain several scopes; raw row ids are never assumed
  pane-unique;
- a scope contributes anchors/readiness only when its committed root is a DOM
  descendant of PaneShell's registered primary content root. Portaled dialogs,
  overlays, and secondary panes are inert.

Collection anchor identity is the nearest scope root plus row id. Focus capture
uses the row containing `document.activeElement`; it never reuses the first
intersecting row by implication.

Readiness crosses lazy and async boundaries explicitly:

1. `paneRenderRegistry.tsx` places `ResolvedPaneBodyMarker` inside the successful
   lazy `Suspense` branch, immediately around `<Body />`; `PaneLoadingState`
   cannot publish readiness.
2. Every `ShellScroll` body calls `usePaneReturnReady(ready)` exactly once.
   Static bodies complete in a layout effect. Async bodies complete only after
   their canonical primary data and DOM commit.
3. `CollectionView` holds a descendant token until `rowsForRender` commits,
   including its queued view-transition update. The notes editor holds one
   until EditorView DOM commits. Async composites whose collection does not
   exist during loading keep one stable unscoped token across every render;
   Reading Slate is unready through `InitialLoading` and terminal-ready on
   success or failure, while its `CollectionView` remains the sole anchor-scope
   owner.
4. Streaming/raw owners hold readiness until the state needed to recreate the
   departed eye-line commits. Oracle Reading, for example, completes after its
   fetched detail/stream seed is applied, not on its loading placeholder and not
   necessarily after the whole stream ends.
5. `PaneContent` declares `Ready(Route)` only when the resolved marker, required
   body token, and all descendant tokens for the current
   `visitId + routeKey` are ready.

Missing required body registration is a development defect. `NoVerticalScroll`,
Reader, and Chat do not register return readiness.

Restore runs in a layout effect after the target visit, restored route data, and
scrollport commit:

1. require matching `visitId + routeKey`;
2. restore the semantic anchor and signed offset when present;
3. after `Ready(Route)`, degrade to clamped raw `scrollTop` if the eye-line
   anchor no longer exists;
4. for `focusReturn.kind === "Keyboard"`, restore its independent anchor's
   `[data-row-focusable]` with `focus({ preventScroll: true })`;
5. when that focus anchor/control is missing, focus
   `[data-pane-return-heading]`, then `[data-pane-chrome-focus]`; for
   `focusReturn.kind === "None"`, do not move focus.

Semantic position is written immediately in the layout effect, then reapplied
once after one painted frame before focus and completion. This bounded
post-commit boundary lets responsive shell geometry settle; it is not a
polling loop. While pending, one scoped `ResizeObserver` watches
PaneShell's content root, not its fixed scrollport, and retries as layout
settles. A reachable raw position is applied immediately. Pointer and
programmatic attempts then end; a keyboard attempt remains pending until
`Ready(Route)` so its focus target or heading/chrome degradation exists.
Otherwise the attempt remains pending until the target becomes reachable or
`Ready(Route)` permits exactly one final clamp. The attempt then ends; it cannot
observe forever. It also ends on
route/visit change, unmount, or user intent: wheel, touchstart, pointerdown, or
a scrolling key. Raw `scroll` events are not cancellation inputs, so provider
writes need no marker or exception. It does not infer intent from a raw `scroll`
event, observe arbitrary mutations, poll, smooth-scroll, or fight the user.

The provider exposes only these internal capabilities: register PaneShell's
scrollport and content root by `paneId + visitId`; register a typed capture getter by
`visitId + routeKey + KEY`; capture a pane; request restore by
`visitId + routeKey`; register/complete one route-readiness token; clear one
visit; clear all captured loaded extents; enforce the byte budget; and prune to
a reachable visit set. The loaded-extent clear is scoped by its origin visit so
only that visit remains eligible for recapture. Registrations return
generation-bound opaque unregister tokens; Strict Mode or stale cleanup cannot
remove a newer registration. Each capability has one canonical command path.

Missing memento after reload is an explicit fresh-presentation state: top. Raw
position after a missing/deleted anchor is the defined degradation order, not a
legacy fallback.

## Hard Cutover And Deletions

- Replace string Back/Forward stacks, `trimStack(string[])`, and their sanitizer
  with exact `PaneVisit` shapes.
- Replace mixed sanitize/clamp decoding with exact
  `parsePersistedWorkspaceState` plus separate restore-time layout adaptation.
- Consolidate duplicated Back and Forward reducer branches behind one pure
  traversal helper.
- At the `PaneContent` call site, key only `ShellScroll` content as
  `` `${currentVisit.id}:${routeKey}` ``. `NoVerticalScroll`, Reader, and Chat
  retain the existing resource/route mount key.
- Delete `ShellScroll` routes' nested primary-layout vertical overflow and
  switch them to `standard`; Atlas remains `document`.
- Delete href-only fixtures, assertions, comments, and E2E helper types.
- Remove the `LibrariesPaneBody` split between paginated data and
  `localLibraries`; one rendered collection state owns appended pages.
- Add Conversations to the same loaded-extent path as other cursor collections.
- Do not add a string-to-visit converter, version branch, feature flag,
  compatibility export, alternate decoder, or silent adoption path.

A one-way Alembic data migration deletes all `workspace_sessions` rows during
the release gate below. Its downgrade defects because discarded session JSON is
unrecoverable. The existing JSON column and GET/PUT transport do not change.
The backend remains the workspace module's opaque JSON store. `PaneVisit`
persists; `ReturnMemento` and visit data never do.

The web BFF exact-decodes PUT before proxying:

- malformed JSON or state returns
  `400 {error: {code: "E_INVALID_WORKSPACE_STATE", message}}`;
- valid new state is forwarded unchanged with the server-owned device id;
- malformed trusted state returned by persisted GET is a defect; bootstrap
  throws rather than adopting, upgrading, or silently replacing it.

## Production Release Gate

Vercel and Hetzner are not atomic. This hard cut uses one explicit maintenance
window:

1. Stop the Hetzner API before merging/pushing `main`; keep it stopped so no
   workspace GET/PUT writer can race the cutover.
2. Land the branch and wait for the strict Vercel deployment to be Ready.
3. With the API still stopped, verify the deployment identity and verify an old
   href-only PUT is rejected by the BFF with exact `400
   E_INVALID_WORKSPACE_STATE` before proxying.
4. Deploy Hetzner, run the one-way session purge while API/worker are stopped,
   then start the services.
5. Smoke: absent session creates a fresh visit-shaped workspace; exact PUT then
   GET round-trips it; malformed PUT remains `400`.
6. End maintenance only after those checks pass.

Do not purge before writer quiescence, restart the opaque backend before the
strict BFF is live, or rely on “one branch” as deployment ordering.

## Files

Core:

- `apps/web/src/app/(authenticated)/AuthenticatedShell.tsx`
- `apps/web/src/app/api/me/workspace-session/route.ts`
- new `apps/web/src/app/api/me/workspace-session/route.test.ts`
- `apps/web/src/lib/workspace/schema.ts`
- `apps/web/src/lib/workspace/workspaceRestore.ts`
- `apps/web/src/lib/workspace/bootstrap.server.ts`
- `apps/web/src/lib/workspace/store.tsx`
- new `apps/web/src/lib/workspace/paneReturnMemento.tsx`
- new `apps/web/src/lib/workspace/paneReturnMemento.test.tsx`
- `apps/web/src/lib/panes/paneRouteModel.ts`
- `apps/web/src/lib/panes/paneIdentity.ts`
- `apps/web/src/lib/panes/paneLinkNavigation.ts`
- `apps/web/src/lib/panes/paneRenderRegistry.tsx`
- `apps/web/src/lib/panes/paneRuntime.tsx`
- `apps/web/src/components/workspace/PaneRouteBoundary.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/collections/CollectionView.tsx`
- every production/test `CollectionView` call site (required `returnScope`)
- `apps/web/src/components/notes/ProseMirrorOutlineEditor.tsx`
- `apps/web/src/components/ui/SurfaceHeader.tsx`
- every `ShellScroll` `*PaneBody` entry in `PANE_LOADERS` (required readiness)

Non-owner `CollectionView` call sites that must not be missed:

- `LecternPaneBody.tsx`, `NotesPaneBody.tsx`, `SettingsPaneBody.tsx`;
- `SettingsIdentitiesPaneBody.tsx`, `PasswordRow.tsx`,
  `KeybindingsPaneBody.tsx`;
- `PodcastEpisodeList.tsx`, `ReadingSlateSection.tsx`;
- `ConversationsPaneBody.tsx`.

Loaded-extent owners:

- `LibrariesPaneBody.tsx`
- `LibraryPaneBody.tsx`
- `SearchPaneBody.tsx`
- `AuthorPaneBody.tsx`
- `ConversationsPaneBody.tsx`
- `PodcastsPaneBody.tsx`
- `PodcastDetailPaneBody.tsx`

Scroll-owner cleanup:

- `paneRouteModel.ts` for podcast detail, Page, Note, Oracle, and Oracle Reading;
- `notes/notes.module.css`;
- `podcasts/[podcastId]/page.module.css`;
- adjacent route CSS only where required to let content expand under PaneShell.

Docs and tests:

- new `migrations/alembic/versions/0191_clear_workspace_sessions_for_pane_visits.py`
- `docs/modules/workspace.md`
- `docs/architecture.md`
- `deployment.md`
- `deploy/hetzner/deploy.sh` only if needed to expose the stopped-service gate;
- adjacent schema, restore, store, runtime, route-model, PaneShell,
  WorkspaceHost, PaneRouteBoundary, paneRenderRegistry, CollectionView,
  web-BFF PUT, and seven route-controller tests;
- `e2e/tests/workspace.ts`;
- new `e2e/tests/pane-return-memento.spec.ts`.

## Implementation Order

1. Add failing visit algebra, route exhaustiveness, and observable restoration
   tests.
2. Hard-cut workspace state to `currentVisit` and one traversal algebra; rewrite
   fixtures.
3. Add the transient provider, byte budget, PaneShell registration, route
   capability, and conditional visit-keyed mount identity.
4. Add the successful-Suspense marker, mandatory route readiness, exact DOM
   anchors, explicit navigation modality, independent focus return, and
   cancellation.
5. Add the seven exact loaded-extent snapshots and global mutation/refresh
   invalidation; remove the Libraries split owner.
6. Move `ShellScroll` routes to PaneShell scrolling; remove nested primary
   overflow; retain Atlas as `NoVerticalScroll`.
7. Add strict BFF errors and the session-purge migration; run focused
   unit/browser/E2E, route, and migration proof; update durable docs.
8. Execute the production release gate. Main never contains dual history
   shapes.

## Acceptance Criteria

| Behavior | Required proof |
|---|---|
| Library/Libraries load beyond page one, open a target, then Back/Forward | browser/E2E: same scoped row, eye-line, loaded extent; no page-one overwrite |
| Conversations load beyond page one, open a transcript, then Back | browser/E2E: list extent and eye-line restore; transcript scroll remains Chat-owned |
| Search, Author, Podcasts, and Podcast Detail append pages | focused browser: exact snapshot restores without collapse or duplication after initial resources settle |
| Notes list, Page, and Note | browser: row/editor-block anchor restore through PaneShell; missing block clamps raw |
| Lazy pane body is delayed behind Suspense | paneRenderRegistry/browser: fallback never marks ready; successful body restores |
| Oracle Reading detail grows after its first loading commit | browser: no early clamp; restore waits for owner readiness, not stream completion |
| Focused keyboard row is not the eye-line row | browser: eye-line and focused row independently restore; missing focus row uses heading/chrome; pointer journey never moves focus |
| Duplicate same-href visits; Back/Forward overflow | algebra plus browser: distinct mementos; Back trims head, Forward trims tail; branch pruning clears unreachable state |
| Per-visit/global byte budget is exhausted | provider unit plus browser degradation: deterministic farthest-topology extent eviction; memento survives; ordinary refetch/clamp completes |
| Strict Mode mounts and stale unregister callbacks race | component test: newest scrollport/getter/readiness registration survives |
| Pane width or mobile orientation changes before return | browser/E2E: semantic offset is preserved when possible; raw pixels clamp to the new range |
| Page/Note/editor/canvas layout after scroll-owner cleanup | focused browser: fill, touch, bounded overlays, and secondary panes remain correct; Atlas azimuth rotation is unchanged |
| Route classification | exhaustive type/test: 21 `ShellScroll`, Atlas only `NoVerticalScroll`, Media only Reader-excluded, and only `conversationNew`/`conversation` Chat-excluded |
| BFF and persisted-state failures | route/integration: malformed PUT is exact `400 E_INVALID_WORKSPACE_STATE`; malformed trusted GET defects |
| Production purge | migration/deploy contract plus smoke proves API writer quiescence, strict Vercel first, purge-before-restart, and exact new PUT/GET |
| Reload/cross-device restore | visits persist; presentation starts at top; Reader and Chat transcript behavior is unchanged |

## Negative Gates

- no `string[]` pane history and no top-level primary-pane `href`;
- no href-keyed memento map, persisted memento, or workspace-session write on
  scroll;
- no second vertical scroll owner in a `ShellScroll` primary route layout;
  bounded dialogs, listboxes, overlays, Reader/Chat, and secondary panes retain
  their legitimate owners;
- no supported route with an omitted return contract;
- no legacy/compat/fallback parser, dual state shape, rollout flag, or old test
  fixture;
- no browser-history interception, return-memento use of Reader's
  `getPaneScrollContainer`, scroll library, query framework, keep-alive tree,
  virtualizer, or smooth restore;
- no unbounded loaded-extent retention, time-based LRU, cache tags, or
  cross-entity snapshot patch graph;
- no route snapshot containing transient UI/process state;
- no readiness from a Suspense fallback, raw scroll event, polling loop, or
  arbitrary mutation observation;
- no use of `:focus-visible` as activation-modality state.

## Done Means

Back/Forward feels spatial: the pane returns to the exact visit, loaded extent,
eye-line, and keyboard context the user left. The implementation has one
primary-route vertical scroll owner where vertical scrolling exists, one
visit-history algebra, one bounded transient return-state owner, explicit
Reader/Chat transcript exclusions, and no legacy path.
