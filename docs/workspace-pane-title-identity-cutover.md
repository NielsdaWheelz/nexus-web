# Workspace Pane Title Identity Cutover

Status: Implemented.
Scope owner: workspace pane identity, pane title lifecycle, dynamic pane bodies,
and media reader URL synchronization in `apps/web`.
Related: `docs/workspace.md`, `docs/workspace-tabs.md`,
`docs/reader-implementation.md`.
Hard cutover. No legacy title-cache behavior, no compatibility mode, no feature
flag, and no fallback branch that preserves href-based title invalidation.

---

## 1. Problem

Workspace pane titles were invalidated by pane `href` changes. That was too
low-level: a pane `href` contains both resource identity and location/view
state. EPUB exposed the bug because the reader opened `/media/:id`, resolved the
media title, then canonicalized the reading position to `/media/:id?loc=...`.
The workspace store treated that query-string change as title-stale and cleared
the runtime title. The mounted `MediaPaneBody` still knew the same media title,
but `useSetPaneTitle` deduped by `paneId + title` and did not re-publish the
same string. The pane chrome then remained in dynamic-title pending state.

This is not an EPUB metadata problem. It is a resource-identity problem:

- `/media/book-a` and `/media/book-a?loc=chapter-2` are the same pane resource.
- `/media/book-a` and `/media/book-b` are different pane resources.
- Pane chrome title belongs to the resource.
- `?loc`, section id, scroll position, and active highlight belong to reader
  location state inside that resource.

The same category error can affect all dynamic panes, not only EPUB. Any route
whose URL contains query/hash/view state can lose or retain the wrong runtime
title unless title invalidation, title publishing, and body reset all use the
same resource identity contract.

## 2. Goals

- G1. Make pane title invalidation resource-aware, not full-href-aware.
- G2. Make dynamic title publication convergent: if a pane body knows its title,
  workspace chrome eventually reflects that title even after host-side cache
  changes.
- G3. Use one shared pane identity helper for title pruning, body remount keys,
  existing-pane de-duplication, and tests.
- G4. Keep media titles sourced from media metadata only. Reader content,
  EPUB navigation, EPUB section loading, PDF page state, transcript fragment
  state, highlights, and resume restoration do not own pane titles.
- G5. Treat `titleHint` as a first-class optimistic title for open-pane and
  same-pane navigation flows, superseded by runtime metadata.
- G6. Reset pane body state on resource changes without remounting on
  same-resource location changes.
- G7. Ensure pending title state is temporary and terminal. Success, not-found,
  and error states publish a non-empty terminal title or use a resolved hint.
- G8. Cover the EPUB `?loc` canonicalization regression and the generic
  same-resource query-change rule in tests.
- G9. Update docs so the implemented reference no longer says runtime titles are
  pruned on every `href` change.

## 3. Non-Goals

- NG1. No backend media schema changes. `GET /api/media/{id}` remains the
  canonical source for media title and contributors after load.
- NG2. No new media title derivation from fragments, EPUB navigation labels,
  section headings, `source_version`, highlight text, or canonical source URL.
- NG3. No change to EPUB reader deep-link shape. `?loc={section_id}` remains the
  canonical frontend location parameter.
- NG4. No generic router replacement, framework migration, or global data-fetch
  library migration.
- NG5. No broad visual redesign of pane tabs, `SurfaceHeader`, or reader chrome.
- NG6. No polling, timeout loop, or retry loop for title recovery.
- NG7. No old/new title-cache dual path, feature flag, or compatibility branch.
- NG8. No effort to backfill historical browser history entries or persisted
  workspace session URLs.

## 4. Terms

- **Pane instance.** A workspace pane row identified by `WorkspacePaneStateV4.id`.
- **Href.** The concrete route string stored on the pane. It may contain
  pathname, query string, and hash.
- **Route id.** The matched route definition id from `paneRouteRegistry.tsx`.
- **Resource ref.** The existing route-owned durable identity string, such as
  `media:<id>`, `library:<id>`, `conversation:<id>`, `page:<id>`,
  `note_block:<id>`, or `daily:<date>`.
- **Pane resource key.** The normalized key used by workspace infrastructure to
  decide whether a pane is still showing the same resource. It is derived from
  `resourceRef` when present. Routes without `resourceRef` use their normalized
  href because no stronger resource identity exists.
- **Location state.** Query, hash, reader position, active section, active page,
  active fragment, selected highlight, or other view state inside a resource.
- **Runtime title.** A title published by a mounted pane body through
  `useSetPaneTitle`.
- **Title hint.** A sanitized title supplied by the opener, usually from a list
  row that already has resource metadata.
- **Static title.** The route label from `paneRouteRegistry.tsx`.
- **Pending title.** A dynamic route with no usable title hint and no runtime
  title.

## 5. Target Behavior

### 5.1 EPUB From Library

1. The user opens an EPUB from a library row.
2. The media pane opens immediately.
3. If the row supplied a media title, the pane tab/header show that title as a
   resolved optimistic title while the pane body loads.
4. `MediaPaneBody` fetches `/api/media/{id}` and publishes the compact media
   title.
5. EPUB restore resolves the active section and updates the pane href to
   `/media/{id}?loc={section_id}`.
6. The pane title remains resolved throughout the `?loc` update.
7. EPUB navigation and section loading may show content-level loading states,
   but pane tab/header title does not return to pending.

### 5.2 Same Media, Different Location

For every media kind:

- `/media/{id}` -> `/media/{id}?fragment=...`
- `/media/{id}` -> `/media/{id}?loc=...`
- `/media/{id}?loc=a` -> `/media/{id}?loc=b`
- `/media/{id}` -> `/media/{id}#...`

all preserve pane resource identity, runtime title, optimistic title, pane
width, and reader chrome state. The pane body may update location-specific
content, but it is not remounted solely because location state changed.

### 5.3 Different Media

`/media/a` -> `/media/b` is a resource change:

- Existing runtime title and optimistic title for pane `a` are cleared.
- The route body is remounted or fully reset for media `b`.
- The pane returns to pending only if no title hint exists for `b`.
- If a title hint exists for `b`, it is used immediately and later superseded by
  the runtime media metadata title.
- Old media content, EPUB section state, PDF state, highlights, transcript
  fragments, and loading flags do not leak into media `b`.

### 5.4 Other Dynamic Panes

The same rule applies to all dynamic routes:

- Same `resourceRef`: preserve runtime title and body instance.
- Different `resourceRef`: clear runtime title and reset body state.
- Missing `resourceRef`: full normalized href is the identity.

Examples:

- `/libraries/a` -> `/libraries/a?tab=items` preserves `library:a` title.
- `/libraries/a` -> `/libraries/b` clears title and resets body.
- `/conversations/a` -> `/conversations/b` clears title and resets body.
- `/daily/2026-05-26` -> `/daily/2026-05-26?view=...` preserves title.
- `/settings/reader` has a static title, so runtime title state is irrelevant.

### 5.5 Pending And Accessibility

Pending pane titles are temporary:

- A dynamic route without hint/runtime title renders pending chrome with a
  non-empty accessible fallback title.
- A pending tab/header uses `aria-busy` only while the title is genuinely
  unresolved.
- Success, not-found, and error terminal states clear pending by publishing a
  non-empty runtime title or by retaining a resolved hint.
- The system never leaves a focusable tab in perpetual loading because a query
  string changed.

### 5.6 Text Surfaces

Text-list surfaces such as the command palette continue to render the best
available `title` string and ignore visual skeleton state. They consume the same
resolved title descriptor as pane tabs and headers. They do not derive titles
from routes independently.

## 6. Final Architecture

### 6.1 Single Pane Identity Helper

Add one workspace/pane identity helper and route all identity decisions through
it.

Public surface:

```ts
export interface PaneRouteIdentity {
  href: string;
  routeId: ResolvedPaneRoute["id"];
  resourceRef: string | null;
  resourceKey: string;
}

export function resolvePaneRouteIdentity(href: string): PaneRouteIdentity;
export function hasSamePaneResource(leftHref: string, rightHref: string): boolean;
```

Rules:

- `resolvePaneRouteIdentity` normalizes href using the existing workspace href
  parser/normalizer.
- If `resolvePaneRoute(href).resourceRef` is non-null, `resourceKey` is
  `${routeId}:${resourceRef}`.
- If `resourceRef` is null, `resourceKey` is `${routeId}:${normalizedHref}`.
- Unsupported routes use `unsupported:${normalizedHref}`.
- No caller reimplements this logic.

Call sites:

- `workspaceReducer` existing-pane de-duplication for `open_pane`.
- Runtime title pruning in `WorkspaceStoreProvider`.
- Pane body remount key in `WorkspaceHost` / `PaneContent`.
- Tests that assert resource identity.
- Future pane/session cleanup that needs resource equality.

### 6.2 Structured Title Cache

Replace the string-only runtime title cache with a structured title cache.

```ts
export type WorkspacePaneTitleSource = "hint" | "runtime";

export interface WorkspacePaneTitleRecord {
  title: string;
  source: WorkspacePaneTitleSource;
  resourceKey: string;
}
```

Rules:

- `runtime` outranks `hint`.
- A record is usable only when `record.resourceKey` equals the current pane
  resource key.
- A `runtime` title from the current resource resolves a dynamic pane.
- A `hint` title from the current resource also resolves a dynamic pane, but it
  is superseded by the first runtime title from the pane body.
- `null` runtime publication removes only the current-resource runtime title. It
  must not remove a current-resource hint unless the route body explicitly
  publishes a terminal fallback runtime title.
- Stale records for dead panes or changed resources are pruned.
- Static routes do not need title records, but a record may still exist if a
  body publishes one. The resolver's source-precedence rule still applies.

The public store field may keep the existing name
`runtimeTitleByPaneId` only if all callers are updated to treat it as a title
record map. There is no parallel legacy string map.

### 6.3 Resolver Contract

`resolveWorkspacePaneTitle` remains the single title resolver.

Input:

- pane id and href
- title record map

Output:

- `title`: non-empty string
- `titleState`: `"resolved" | "pending"`
- `titleSource`: `"runtime" | "hint" | "static" | "fallback"`
- `route`
- `chrome`
- `resourceKey`

Resolution order:

1. Current-resource `runtime` title.
2. Current-resource `hint` title.
3. Static route or route chrome title for static routes.
4. Dynamic fallback title with `titleState: "pending"`.

Dynamic fallback titles are accessible stand-ins, not resolved resource titles.

### 6.4 Title Publication Contract

`useSetPaneTitle` publishes the current desired title for the current pane
resource.

Rules:

- The hook's dedupe key includes `paneId`, `resourceKey`, and normalized title.
- A resource change causes a fresh publication attempt, even when the title
  string matches the previous resource's title.
- The hook never dedupes across different resources.
- The hook never publishes category labels during loading.
- Pane bodies publish `null` only while the resource title is genuinely unknown.
- Pane bodies publish non-empty terminal titles for success, not-found, and
  error states.

The store is authoritative for whether a publication applies to the current
resource. A stale publication is ignored rather than written.

### 6.5 Pane Navigation Title Hint Contract

`requestOpenInAppPane(href, { titleHint })` and
`paneRuntime.router.push(href, { titleHint })` transport the same optimistic
title contract. The workspace store consumes both at the pane resource-key
layer.

Rules:

- `titleHint` is optional.
- A valid hint is normalized by `normalizePaneTitle`.
- A hint is attached to the pane resource key for the target href.
- Opening a new pane with a hint writes a `hint` title record.
- Same-pane navigation with a hint writes a `hint` title record for that pane.
- Opening an existing same-resource pane with a hint writes a hint only when no
  current-resource runtime title exists.
- Opening an existing same-resource pane with no hint preserves existing title.
- Runtime metadata supersedes the hint without leaving a stale hint-visible
  state.
- Hints are never persisted into `WorkspaceStateV4`.
- Hints are not backend truth.

### 6.6 Body State Reset Contract

Pane body lifecycle follows the same resource key:

- Body key is `resourceKey`, not full href.
- Same-resource href changes preserve body state.
- Different-resource href changes remount or explicitly reset body state.
- Error boundary reset key uses `resourceKey` for resource errors and may also
  include route id for unsupported/static route cases.

This fixes media state leakage without remounting EPUB on every `?loc` update.

### 6.7 Media Title Contract

Media pane title source:

1. Title hint from a trusted opener row, if present.
2. `GET /api/media/{id}` response formatted by `buildCompactMediaPaneTitle`.
3. Terminal fallback such as `"Media unavailable"` or `"Media"` only for
   not-found/error paths where no media metadata is available.

Media pane title must not depend on:

- EPUB navigation section title
- EPUB active section content
- web/transcript fragment text
- PDF file loading state
- highlight data
- reader resume state
- `source_version`
- canonical source URL

### 6.8 Reader Location Contract

Reader location is subresource state:

- EPUB `?loc` is location state inside `media:<id>`.
- Web/transcript fragment selection is location state inside `media:<id>`.
- PDF page/zoom is location state inside `media:<id>`.
- Highlight selection/pulse is location state inside `media:<id>`.

Location changes may update pane href and browser history. They do not clear
pane title, title hint, or body identity.

### 6.9 Hard Cutover

Deleted behavior:

- Pruning runtime titles solely because `pane.href` changed.
- String-only runtime title map.
- Ignoring `titleHint` in workspace open event handling.
- Keying media/dynamic body state by full href.
- Tests that assert title is cleared on same-resource query/hash changes.

There is no compatibility layer that accepts both old and new title map shapes.

## 7. Capability Contract

### 7.1 Workspace Title Capability

Inputs:

- Current `WorkspaceStateV4.panes`.
- Current pane href.
- Route registry metadata.
- Title records keyed by pane id.
- Optional open-pane title hints.
- Runtime publications from pane bodies.

Outputs:

- Resolved pane descriptor for host rendering.
- Pending/resolved title state.
- Source classification for observability and testing.

Invariants:

- `title` is always non-empty.
- `resourceKey` is stable across same-resource location changes.
- A title record is used only for its own resource key.
- Runtime title outranks hint.
- Hint outranks dynamic fallback.
- Static route title is resolved without a title record.
- A changed resource clears or invalidates the old title record.
- The resolver is the only place that decides pending vs resolved.

### 7.2 Pane Runtime Capability

Inputs:

- Pane id.
- Current href.
- Route id.
- Resource ref/key.
- Scoped router callbacks.
- Runtime title callback.

Outputs:

- Pane body route params/search params.
- Pane-scoped navigation functions.
- Pane title publication.
- Open-in-new-pane callback.

Invariants:

- Pane body sees current location state.
- Pane body title publication is scoped to current resource key.
- Same-resource location changes do not remount the body.
- Resource changes remount or reset the body.

### 7.3 Media Reader Capability

Inputs:

- Media id.
- Pane search params.
- Media metadata API.
- Reader profile.
- Reader resume API.
- EPUB navigation/section APIs or PDF/web/transcript content APIs.

Outputs:

- Media title publication.
- Reader content.
- Reader location URL synchronization.
- Highlights and resume updates.

Invariants:

- Metadata loading and content loading are separate states.
- Title publication depends only on metadata state.
- Content loading does not clear title.
- URL synchronization for location does not clear title.
- Stale async responses from an old media id do not commit into a new media id.

## 8. API Design

### 8.1 New/Changed TypeScript APIs

```ts
// apps/web/src/lib/panes/paneIdentity.ts
export interface PaneRouteIdentity {
  href: string;
  routeId: ResolvedPaneRoute["id"];
  resourceRef: string | null;
  resourceKey: string;
}

export function resolvePaneRouteIdentity(href: string): PaneRouteIdentity;
export function hasSamePaneResource(leftHref: string, rightHref: string): boolean;
```

```ts
// apps/web/src/lib/workspace/store.tsx
export type WorkspacePaneTitleSource = "hint" | "runtime";

export interface WorkspacePaneTitleRecord {
  title: string;
  source: WorkspacePaneTitleSource;
  resourceKey: string;
}

export interface WorkspacePaneTitleDescriptor {
  chrome: PaneChromeDescriptor | undefined;
  route: ResolvedPaneRoute;
  resourceKey: string;
  title: string;
  titleState: "resolved" | "pending";
  titleSource: WorkspacePaneTitleSource | "static" | "fallback";
}
```

`publishPaneTitle` should accept the current resource key at the store boundary,
either explicitly:

```ts
publishPaneTitle(input: {
  paneId: string;
  resourceKey: string;
  title: string | null;
}): void
```

or through a context callback that closes over the current resource key. The
explicit object form is preferred because it is harder to misuse and follows the
repo rule favoring one object parameter at boundaries.

`openPane`, open-pane events, and pane-scoped navigation accept `titleHint`:

```ts
openPane(input: {
  href: string;
  openerPaneId?: string | null;
  activate?: boolean;
  titleHint?: string;
}): void

paneRuntime.router.push(href, { titleHint?: string }): void
```

### 8.2 No Backend API Change

No FastAPI route, schema, or database migration is required.

## 9. Composition With Other Systems

### 9.1 Workspace URL Encoding

Workspace URL encoding continues to serialize pane hrefs. The identity cutover
does not change persisted workspace state shape. It changes how runtime chrome
state interprets href changes.

### 9.2 Pane Route Registry

`paneRouteRegistry.tsx` remains the owner of route id, static title, title mode,
icon, body renderer, and `resourceRef`. This cutover strengthens the meaning of
`resourceRef`: it is not only for open-pane de-duplication; it is the resource
identity for title lifecycle and body reset.

### 9.3 Command Palette

The command palette consumes `resolveWorkspacePaneTitle`. It must not inspect
title records or route titles directly. Open-tab rows show the same best title
as the pane strip, but without skeletons.

### 9.4 Pane Strip And Surface Header

`WorkspacePaneStrip` and `SurfaceHeader` remain presentational. They receive
`title` and `titleState`. They do not know about hints, runtime titles, or
resource keys except through the descriptor.

### 9.5 Reader

`MediaPaneBody` keeps its current reader responsibilities, but state reset is
defined by media resource identity. EPUB URL canonicalization remains inside the
reader and uses `router.replace`, but that replace is a location update, not a
chrome/title reset.

### 9.6 Accessibility

Existing skeleton behavior remains, but title pending must not become
permanent. `aria-busy` is valid only while a title is actually resolving. A
resolved hint is not busy.

## 10. Files

### 10.1 New

- `apps/web/src/lib/panes/paneIdentity.ts`
  - Owns `resolvePaneRouteIdentity` and `hasSamePaneResource`.

### 10.2 Changed

- `apps/web/src/lib/workspace/store.tsx`
  - Replace string title map with structured title records.
  - Use `resolvePaneRouteIdentity` for open-pane de-duplication.
  - Consume `titleHint`.
  - Prune titles on resource-key changes, not href changes.
  - Return `resourceKey` and `titleSource` from
    `resolveWorkspacePaneTitle`.

- `apps/web/src/lib/panes/paneRuntime.tsx`
  - Expose `resourceKey` in pane runtime.
  - Publish titles with `{ paneId, resourceKey, title }`.
  - Include resource key in `useSetPaneTitle` dedupe.

- `apps/web/src/components/workspace/WorkspaceHost.tsx`
  - Thread `resourceKey` into `PaneRuntimeProvider`.
  - Key route body or route view by `resourceKey`.
  - Keep same-resource location changes mounted.

- `apps/web/src/lib/panes/openInAppPane.ts`
  - Keep current sanitized `titleHint` transport.
  - No fallback shape or legacy event shape.

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
  - Keep title publication tied to metadata.
  - Ensure terminal error/not-found states publish non-empty titles.
  - Ensure stale async responses cannot commit after media id changes.

- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
  - Continue passing media title hints when opening media panes.
  - No route-specific title workaround; workspace store consumes hints.

- Any other dynamic pane body using `useSetPaneTitle`
  - Confirm it publishes `null` only while title is unknown and publishes a
    terminal fallback on error/not-found.

- `docs/workspace-tabs.md`
  - Replace the href-pruning rule with resource-key pruning.
  - Describe hint/runtime title source precedence.

- `docs/workspace.md`
  - Reference this cutover if needed for body identity.

- `docs/reader-implementation.md`
  - Clarify that EPUB `?loc` is location state inside the media resource and
    does not affect pane title lifecycle.

### 10.3 Tests

- `apps/web/src/lib/panes/paneIdentity.test.ts`
  - Same media with different `?loc` has same resource key.
  - Different media ids have different resource keys.
  - Dynamic non-media routes use `resourceRef`.
  - Routes without `resourceRef` fall back to normalized href.

- `apps/web/src/lib/workspace/store.test.tsx`
  - Same-resource query change preserves title record.
  - Different-resource change prunes title record.
  - Stale runtime publications from a previous resource are ignored.
  - Hint resolves dynamic title before runtime title.
  - Same-pane navigation with a hint resolves the dynamic title.
  - Runtime title supersedes hint.
  - Stale title record with wrong resource key is ignored.
  - Open-pane event with `titleHint` writes a hint record.

- `apps/web/src/lib/panes/paneRuntime.test.tsx`
  - `useSetPaneTitle` republishes on resource key change even when title string
    is the same.
  - `useSetPaneTitle` does not republish on same resource and same title.
  - `router.push` and `router.replace` transport `titleHint`.
  - `openInNewPane` transports `titleHint`.

- `apps/web/src/components/workspace/WorkspaceHost.test.tsx`
  - Resource change remounts route body.
  - Same-resource query change preserves route body.

- `e2e/tests/workspace-tabs.spec.ts`
  - Open EPUB at `/media/{id}` without `?loc`.
  - Wait for real title.
  - Wait for URL/pane href to become `?loc=...`.
  - Wait for section content.
  - Assert pane tab and header title remain resolved, not pending, not
    `aria-busy`, and not skeleton.
  - Assert library EPUB row title hint appears before the media API load
    resolves.

- `e2e/tests/epub.spec.ts`
  - No duplicate coverage unless EPUB-specific URL canonicalization needs a
    narrower assertion. Prefer one workspace-level regression to avoid testing
    title internals in the EPUB suite.

## 11. Key Decisions

### K1. Resource key is the title invalidation boundary.

Full href is too broad because it includes location state. Route id alone is
too narrow because every media pane would share one route. `resourceRef` is the
right existing abstraction.

### K2. Title hints are resolved but supersedable.

A library row title is already metadata from the same media contract. Showing it
immediately is better than a blank skeleton. It is still not canonical; runtime
metadata supersedes it.

### K3. Runtime title map becomes structured.

String-only title maps cannot prove that a title belongs to the current
resource. A structured record prevents stale-title leaks when pane ids are
reused across resources.

### K4. Body key is resource key, not href.

Keying by full href would fix stale media id state but break EPUB by remounting
on every `?loc`. Keying by resource key gives the intended lifecycle.

### K5. Media title comes from media metadata only.

EPUB section titles are navigation labels, not publication titles. The pane tab
should identify the book/document, not the current chapter.

### K6. No polling or timeout recovery.

The title system must be deterministic and event-driven. A stuck title is a
state ownership bug, not a timing problem.

### K7. Docs are part of the cutover.

`docs/workspace-tabs.md` documented href-based pruning before this cutover. The
implemented reference now documents resource-key pruning.

## 12. Implementation Record

The cutover shipped in these phases.

### Phase 1. Identity Helper

1. Add `paneIdentity.ts`.
2. Add unit tests for resource-key behavior.
3. Replace open-pane de-duplication's ad hoc `resolvePaneRoute(...).resourceRef`
   comparison with `resolvePaneRouteIdentity`.

### Phase 2. Structured Title Records

1. Replace `ReadonlyMap<string, string>` with
   `ReadonlyMap<string, WorkspacePaneTitleRecord>`.
2. Update `resolveWorkspacePaneTitle`.
3. Update command palette and any test helper consuming the map.
4. Add title-source tests.

### Phase 3. Resource-Aware Pruning

1. Derive current pane resource keys from `state.panes`.
2. Prune only when pane id is gone or current resource key differs from the
   title record's resource key.
3. Add same-resource and different-resource tests.

### Phase 4. Title Hints

1. Thread `titleHint` through `buildPanesForOpen`, open-pane events,
   `openPane`, `paneRuntime.router.push`, and `requestOpenInAppPane`
   consumers.
2. Write hint title records for current resource keys.
3. Ensure runtime publication supersedes hints.
4. Add tests for library/media title hints.

### Phase 5. Pane Runtime And Body Lifecycle

1. Add `resourceKey` to `PaneRuntimeProvider`.
2. Publish titles with `{ paneId, resourceKey, title }`.
3. Include resource key in `useSetPaneTitle` dedupe.
4. Key body view/error boundary by resource key.
5. Confirm same-resource query changes preserve reader body.

### Phase 6. Dynamic Pane Body Audit

1. Audit all `useSetPaneTitle` callers.
2. For each dynamic pane body, ensure loading/null/success/error title states
   satisfy the contract.
3. For media, ensure stale async responses are guarded by media id and aborted
   requests do not commit.

### Phase 7. EPUB Regression

1. Add E2E coverage for `/media/{epubId}` -> `?loc` canonicalization.
2. Add library-row EPUB title hint coverage with the media API load blocked.
3. Run targeted unit/browser/E2E checks.

### Phase 8. Docs

1. Update `docs/workspace-tabs.md`.
2. Update `docs/reader-implementation.md`.
3. Mark this spec implemented when code and tests ship.

## 13. Acceptance Criteria

- AC1. Navigating an EPUB pane from `/media/{id}` to
  `/media/{id}?loc={section}` does not clear the pane title.
- AC2. Opening an EPUB from a library row shows the row title immediately when a
  title hint is available.
- AC3. The runtime media metadata title supersedes the hint without an
  intermediate pending title.
- AC4. Same-resource query/hash changes preserve title records for every route
  with `resourceRef`.
- AC5. Different-resource changes clear or invalidate title records.
- AC6. A stale title record whose resource key does not match the pane's current
  resource key is ignored by `resolveWorkspacePaneTitle`.
- AC7. Dynamic pane bodies do not remain pending after terminal success,
  not-found, or error states.
- AC8. Media body state resets on `/media/a` -> `/media/b`.
- AC9. Media body state does not remount solely on `/media/a` ->
  `/media/a?loc=...`.
- AC10. `titleHint` is no longer a dead parameter.
- AC11. No code path prunes title records solely by comparing full href strings.
- AC12. No live code keeps a string-only runtime title map.
- AC13. `docs/workspace-tabs.md` documents resource-key title pruning, not
  href-based pruning.
- AC14. Targeted unit tests and the EPUB workspace E2E regression pass.

## 14. Verification Plan

Targeted local checks:

```bash
cd apps/web && bun run test:unit -- src/lib/panes/paneIdentity.test.ts
cd apps/web && bun run test:browser -- src/lib/workspace/store.test.tsx src/lib/panes/paneRuntime.test.tsx src/components/workspace/WorkspaceHost.test.tsx src/__tests__/components/SurfaceHeader.test.tsx
cd apps/web && bun run typecheck
cd apps/web && bun run lint
make test-e2e PLAYWRIGHT_ARGS='tests/workspace-tabs.spec.ts --grep "epub title"'
```

Broader checks before merge:

```bash
make verify
make test-e2e PLAYWRIGHT_ARGS="tests/workspace-tabs.spec.ts tests/epub.spec.ts"
```

If DB-backed or full E2E checks are blocked locally, the implementation report
must name the blocked command and include the targeted unit/type/lint evidence
that did run.

## 15. Risks And Mitigations

| Risk | Mitigation |
|---|---|
| Stale title leaks from one resource to another. | Title records include `resourceKey`; resolver ignores mismatches; resource change prunes records. |
| Body remount on `?loc` breaks EPUB restore. | Body key uses resource key, not href. |
| Body fails to reset on `/media/a` -> `/media/b`. | Resource key changes; route view remounts; tests assert reset. |
| Hint masks backend title updates. | Runtime source outranks hint. |
| Dynamic panes without `resourceRef` preserve titles too broadly. | Missing `resourceRef` falls back to normalized full href identity. |
| Title source model leaks into presentational components. | Only store/host resolver knows source; strip/header still receive `title` and `titleState`. |
| Tests overfit implementation internals. | Unit tests cover public helper/resolver contracts; E2E covers user-visible title stability. |

## 16. Final State Summary

Pane chrome title lifecycle is owned by resource identity:

```text
route href -> resolvePaneRoute -> resourceRef -> resourceKey
resourceKey -> title record validity
resourceKey -> body lifecycle
resourceKey -> stale async guard boundary
```

EPUB `?loc` is reader location state. It composes with workspace URLs and
browser history, but it is not a new pane resource and does not invalidate pane
title chrome.

The result is one reusable rule for all panes:

```text
same resource -> preserve title and body
different resource -> clear title and reset body
runtime metadata -> canonical title
title hint -> immediate supersedable title
dynamic fallback -> pending accessible stand-in only
```
