# Workspace Pane History Cutover

Status: Implemented hard-cutover contract.
Scope owner: workspace pane navigation in `apps/web`.
Date: 2026-05-27.
Related: `docs/workspace.md`, `docs/workspace-tabs.md`,
`docs/workspace-pane-architecture-cutover.md`,
`docs/pane-internal-link-navigation-cutover.md`,
`docs/command-palette-global-cutover.md`, `docs/reader-implementation.md`,
`docs/web-article-reader-navigation.md`.

Hard cutover. No legacy `onBack` behavior, no parent-route fallback, no
browser-history fallback from pane chrome, no feature flag, no compatibility
mode, no schema migration for old workspace state, and no duplicate pane
history APIs.

---

## 1. Problem

Before this cutover, pane chrome exposed a Back button, but it was not pane
history.

The rendered control lived in `SurfaceHeader` as an optional `onBack` button.
`PaneShell` passed it through, and `WorkspaceHost` built that callback as:

1. navigate the pane to a mechanically derived parent route when
   `getParentHref(route)` returns one; or
2. call `window.history.back()` when no parent route exists.

That behavior is wrong for the product model:

- it is not universal history because Forward does not exist;
- it is not per-pane history because top-level routes call global browser
  history;
- it is not semantically Back because child routes go to route parents, not to
  the previous location in that pane;
- it is unpredictable in multi-pane workspaces because browser Back restores a
  whole workspace snapshot, not one pane;
- it makes routes without a parent look broken when browser history has no
  useful previous entry;
- it makes routes with a parent look functional while still violating the
  meaning of Back.

The repo already has the right navigation boundary: same-pane navigation uses
`paneRuntime.router`, new-pane navigation uses `paneRuntime.openInNewPane`, and
global launch surfaces use `requestOpenInAppPane`. What is missing is a
first-class pane-scoped Back/Forward stack owned by the workspace state model.

## 2. Goals

- G1. Every pane header exposes Back and Forward controls with identical
  behavior and accessibility.
- G2. Back and Forward operate on only the pane that owns the clicked header.
- G3. Back and Forward are real history operations, not route-parent shortcuts.
- G4. `paneRuntime.router.push` records pane-local history.
- G5. `paneRuntime.router.replace` updates the current pane location without
  adding pane-local history.
- G6. Existing same-pane internal link handling, reader `?loc` navigation,
  navbar active-pane navigation, and open-pane de-duplication all converge on
  one workspace-owned href transition helper.
- G7. Browser Back/Forward remains browser history for whole-workspace URL
  snapshots. Pane chrome never calls `window.history.back()` or
  `window.history.forward()`.
- G8. Workspace URL/session state carries the pane history contract in one
  versioned shape.
- G9. History is bounded deterministically so workspace URL encoding remains
  stable.
- G10. The implementation deletes the old parent-route Back behavior rather
  than leaving it as a fallback.

## 3. Non-Goals

- NG1. No global browser-history redesign.
- NG2. No browser-level interception of hardware Back beyond existing surfaces
  that already own it, such as the mobile command palette.
- NG3. No pane history in the command palette. The palette remains global-only.
- NG4. No pane-local command-palette mode.
- NG5. No parent/up navigation hidden behind the Back button.
- NG6. No route-specific Back handlers in media, notes, libraries,
  conversations, settings, or reader bodies.
- NG7. No reader scroll-position history. Pure scroll does not become pane
  history unless it changes the pane href.
- NG8. No PDF toolbar page-step history. PDF Previous page and Next page remain
  PDF controls unless they intentionally push a `?page=` href in a separate
  future design.
- NG9. No compatibility with workspace schema v4 encoded URLs or saved sessions.
- NG10. No speculative multi-level history UI such as a long-press history menu.
- NG11. No persisted title hints inside pane history entries.
- NG12. No server schema changes. Workspace history is frontend workspace state.

## 4. Definitions

- **Pane current href.** The `href` currently rendered by a workspace pane.
- **Pane Back stack.** Hrefs previously visited by that pane, ordered oldest to
  newest. The last item is the next Back target.
- **Pane Forward stack.** Hrefs that can be restored after pane Back, ordered
  oldest to newest. The last item is the next Forward target.
- **Committed pane navigation.** A workspace transition that changes a pane's
  current href.
- **Push navigation.** A committed pane navigation that appends the previous
  current href to the Back stack and clears the Forward stack.
- **Replace navigation.** A committed pane navigation that changes only the
  current href and preserves existing Back/Forward stacks.
- **Pane history traversal.** A Back or Forward operation that moves hrefs
  between the current href, Back stack, and Forward stack.
- **Workspace browser history.** Native browser history entries containing
  encoded whole-workspace snapshots in the URL.

## 5. Target Behavior

### 5.1 Pane Header Controls

Every pane header renders a compact Back/Forward control group before the title.

- Back is enabled when that pane's Back stack is non-empty.
- Forward is enabled when that pane's Forward stack is non-empty.
- Disabled controls remain visible in every pane.
- Back has accessible name `Go back in this pane`.
- Forward has accessible name `Go forward in this pane`.
- The controls use lucide `ChevronLeft` and `ChevronRight`.
- Clicking Back changes only that pane's current href.
- Clicking Forward changes only that pane's current href.
- Clicking Back/Forward activates that pane if it is visible but inactive.
- Back/Forward never opens a new pane.
- Back/Forward never minimizes, restores, closes, resizes, or reorders panes.
- Back/Forward never calls `window.history.back()` or
  `window.history.forward()`.

### 5.2 Push Navigation

When a pane's current href changes through push semantics:

1. normalize and validate the target href at the workspace boundary;
2. if the target href equals the current href, do not modify history;
3. append the previous current href to that pane's Back stack;
4. clear that pane's Forward stack;
5. set the pane current href to the target href;
6. clamp width through the target route width contract;
7. preserve or activate visibility according to the existing caller semantics;
8. sync the resulting workspace to the browser URL with `pushState`.

Push semantics apply to:

- `paneRuntime.router.push`;
- internal same-pane anchor clicks handled by `PaneRouteBoundary`;
- active-pane navbar navigation;
- global `requestOpenInAppPane` or `openPane` de-duplication when it retargets
  an existing pane to a different href;
- reader section/navigation jumps that call `router.push`;
- citation/source activation when it calls `router.push` for the same media.

### 5.3 Replace Navigation

When a pane's current href changes through replace semantics:

1. normalize and validate the target href at the workspace boundary;
2. if the target href equals the current href, do not modify state;
3. set the pane current href to the target href;
4. preserve Back and Forward stacks;
5. clamp width through the target route width contract;
6. sync the resulting workspace to the browser URL with `replaceState`.

Replace semantics apply to:

- `paneRuntime.router.replace`;
- invalid or stale reader location cleanup that removes `?loc`;
- initial reader normalization that canonicalizes the requested reader href;
- URL/session hydration.

### 5.4 Pane Back

When a pane Back control is clicked:

1. if the Back stack is empty, do nothing;
2. pop the last Back stack href;
3. append the previous current href to the Forward stack;
4. set the pane current href to the popped href;
5. clamp width through the restored href's route width contract;
6. make the pane visible and active;
7. sync the resulting workspace to the browser URL with `replaceState`;
8. prune runtime title/width records through the same resource-key rules used by
   normal navigation.

Back traversal does not clear the Forward stack except for the moved current
href append.

### 5.5 Pane Forward

When a pane Forward control is clicked:

1. if the Forward stack is empty, do nothing;
2. pop the last Forward stack href;
3. append the previous current href to the Back stack;
4. set the pane current href to the popped href;
5. clamp width through the restored href's route width contract;
6. make the pane visible and active;
7. sync the resulting workspace to the browser URL with `replaceState`;
8. prune runtime title/width records through the same resource-key rules used by
   normal navigation.

Forward traversal does not clear the Back stack except for the moved current
href append.

### 5.6 Browser Back And Forward

Native browser Back/Forward remains whole-workspace history.

- `popstate` decodes the browser URL and hydrates the full workspace snapshot.
- A decoded snapshot includes pane history stacks because they are part of the
  current workspace schema.
- Browser Back can change multiple panes, active pane, minimized state, and pane
  history stacks because it restores an older workspace snapshot.
- Pane chrome Back/Forward does not consume or synthesize native browser
  `popstate` events.
- The mobile command palette keeps its existing one-entry browser-history marker
  behavior and remains separate from pane history.

### 5.7 Reader Behavior

Reader navigation participates when it changes the pane href.

- EPUB section jumps that push `/media/:id?loc=...` create pane history.
- Web article heading jumps that push `/media/:id?loc=...&fragment=...` create
  pane history.
- Citation/source activation that pushes `?loc`, `?fragment`, `?page`,
  `?highlight`, or `?evidence` creates pane history.
- Invalid web article `?loc` cleanup remains a replace and does not create pane
  history.
- EPUB initial restore normalization remains a replace and does not create pane
  history.
- Same-section EPUB anchor jumps that do not change href do not create pane
  history.
- Text selection, highlight creation, quote-to-chat, reader theme changes, and
  pure scroll do not create pane history.
- PDF toolbar page and zoom controls do not create pane history unless they
  change the pane href. Current PDF controls do not.

## 6. Final State

After the cutover:

- `WorkspaceStateV5` is the only accepted workspace state shape.
- Every pane state includes a bounded href-only history object.
- `WorkspaceStateV4`, v4 fixtures, v4 URL state, and v4 saved sessions are not
  supported.
- `SurfaceHeader` has a required pane navigation prop and always renders both
  Back and Forward controls.
- `SurfaceHeader` no longer accepts `onBack`.
- `PaneShell` has a required pane navigation prop and passes it to
  `SurfaceHeader`.
- `WorkspaceHost` no longer calls `getParentHref` for header Back behavior.
- `WorkspaceHost` no longer passes `window.history.back` to pane chrome.
- `getParentHref` is deleted if no non-history caller remains.
- `PaneScopedRouter` exposes `push`, `replace`, `back`, `forward`,
  `canGoBack`, and `canGoForward` as the one pane navigation API.
- `WorkspaceStoreProvider` exposes `goBackPane` and `goForwardPane` only if the
  router/chrome boundary needs named store callbacks. There is no second public
  history API with different semantics.
- Current title, route identity, width, session sync, URL codec, internal link,
  and command palette behavior all consume the single workspace history state.

## 7. Capability Contract

### 7.1 Workspace Store

The workspace store is the source of truth for pane history.

Inputs:

- current `WorkspaceStateV5`;
- normalized target hrefs;
- navigation mode: push, replace, back, forward, open/reuse, hydrate;
- pane id;
- activation and visibility options;
- optional title hint for the target resource.

Outputs:

- next `WorkspaceStateV5`;
- browser sync mode: push or replace;
- runtime title hint publication for target resources;
- telemetry for workspace encode/decode/title state as today.

Invariants:

- A pane's current href is never duplicated as the last Back or Forward entry.
- Push clears Forward.
- Replace preserves Back and Forward.
- Back and Forward move exactly one href between stacks and current href.
- A history operation mutates exactly one pane's href/history plus active and
  visibility state needed to reveal it.
- History entries are normalized same-origin workspace hrefs.
- Unsupported route hrefs may be stored if they are valid workspace hrefs,
  matching the current unsupported-pane behavior.
- External URLs, downloads, `_blank`, hash-only links, and modified browser
  clicks do not enter pane history through `PaneRouteBoundary`.
- History stacks are bounded before state is encoded or persisted.
- Invalid encoded workspace state fails closed at the schema boundary. It is not
  migrated, partially repaired, or interpreted as an old version.

### 7.2 Pane Runtime

`PaneRuntimeProvider` is the route-body API for pane navigation.

Inputs:

- pane id;
- current href;
- route id, resource ref, resource key;
- workspace store navigation callbacks;
- current pane Back/Forward availability.

Outputs:

- `paneRuntime.router.push(href, options)`;
- `paneRuntime.router.replace(href, options)`;
- `paneRuntime.router.back()`;
- `paneRuntime.router.forward()`;
- `paneRuntime.router.canGoBack`;
- `paneRuntime.router.canGoForward`;
- existing `openInNewPane`, title publication, and width publication.

Invariants:

- Route bodies do not import workspace store directly for history.
- Route bodies do not call `window.history.back()` for pane navigation.
- Route bodies do not reimplement stack logic.
- `openInNewPane` remains separate because it changes pane graph topology.

### 7.3 Pane Chrome

`PaneShell` and `SurfaceHeader` own the visual Back/Forward controls.

Inputs:

- current pane title, title state, subtitle, meta, options, actions, toolbar;
- pane navigation descriptor with Back/Forward availability and callbacks.

Outputs:

- visible Back and Forward controls in every pane header;
- disabled state when stack is empty;
- accessible labels and focus behavior.

Invariants:

- Pane bodies cannot hide the universal Back/Forward controls.
- Pane bodies cannot replace Back/Forward through `usePaneChromeOverride`.
- Pane-local options remain in `ActionMenu`.
- The command palette remains global-only.
- Mobile document chrome visible locks continue to work while action menus are
  open; history controls do not create a new lock reason.

## 8. API Design

### 8.1 Workspace Schema

Hard cutover to schema version 5.

```ts
export const WORKSPACE_SCHEMA_VERSION = 5;

type WorkspacePaneVisibility = "visible" | "minimized";

export interface WorkspacePaneHistoryV5 {
  back: string[];
  forward: string[];
}

export interface WorkspacePaneStateV5 {
  id: string;
  href: string;
  widthPx: number;
  visibility: WorkspacePaneVisibility;
  history: WorkspacePaneHistoryV5;
}

export interface WorkspaceStateV5 {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  activePaneId: string;
  panes: WorkspacePaneStateV5[];
}
```

History entries are href strings, not objects, to keep the encoded workspace URL
small and to avoid persisting title hints or stale route metadata.

### 8.2 History Limits

Add explicit constants in `schema.ts`:

```ts
export const MAX_PANE_HISTORY_STACK_LENGTH = 12;
export const MAX_TOTAL_PANE_HISTORY_ENTRIES = 48;
```

Rules:

- each stack keeps the nearest entries and evicts older entries first;
- total history budget is enforced after per-stack trimming;
- total-budget eviction removes oldest entries from non-active panes first,
  then from the active pane if needed;
- Back entries are older than Forward entries for eviction within a pane;
- eviction is deterministic and part of the contract, not an encoding fallback;
- current pane hrefs are never evicted by history budget logic.

If the current pane graph cannot be encoded even after history pruning, that is
an encode error in the existing workspace URL layer. The history implementation
must not silently drop panes, current hrefs, active pane, width, or visibility
to make encoding succeed.

### 8.3 Store Actions

Replace the single current `navigate_pane` reducer behavior with explicit
history-aware modes.

```ts
type PaneNavigationMode = "push" | "replace" | "back" | "forward";

type WorkspaceAction =
  | { type: "hydrate"; state: WorkspaceStateV5 }
  | { type: "activate_pane"; paneId: string }
  | {
      type: "open_pane";
      panes: WorkspacePaneStateV5[];
      afterPaneId: string | null;
      activate: boolean;
      historyMode: "push" | "replace";
    }
  | {
      type: "navigate_pane";
      paneId: string;
      href: string;
      activate: boolean;
      historyMode: "push" | "replace";
    }
  | { type: "go_back_pane"; paneId: string }
  | { type: "go_forward_pane"; paneId: string }
  | { type: "close_pane"; paneId: string }
  | { type: "resize_pane"; paneId: string; widthPx: number }
  | { type: "minimize_pane"; paneId: string }
  | { type: "restore_pane"; paneId: string };
```

If `open_pane` reuses an existing same-resource pane and the href differs, it
must use the same push/replace transition helper as `navigate_pane`. Opening a
brand-new pane creates an empty history object.

### 8.4 Store Public Surface

The public store surface becomes:

```ts
interface WorkspaceStoreValue {
  state: WorkspaceStateV5;
  runtimeTitleByPaneId: ReadonlyMap<string, WorkspacePaneTitleRecord>;
  activatePane: (paneId: string) => void;
  openPane: (input: {
    href: string;
    openerPaneId?: string | null;
    activate?: boolean;
    titleHint?: string;
    replace?: boolean;
  }) => void;
  navigatePane: (
    paneId: string,
    href: string,
    options?: { replace?: boolean; activate?: boolean; titleHint?: string },
  ) => void;
  goBackPane: (paneId: string) => void;
  goForwardPane: (paneId: string) => void;
  closePane: (paneId: string) => void;
  resizePane: (paneId: string, widthPx: number) => void;
  minimizePane: (paneId: string) => void;
  restorePane: (paneId: string) => void;
  publishPaneTitle: (input: {
    paneId: string;
    resourceKey: string;
    title: string | null;
  }) => void;
}
```

`replace` on `openPane` is optional and defaults to `false`. It exists only for
callers that intentionally retarget an existing pane without creating Back
history. Do not create a parallel `replacePane` API.

### 8.5 Pane Runtime Router

The pane runtime router becomes:

```ts
export interface PaneScopedRouter {
  canGoBack: boolean;
  canGoForward: boolean;
  push: (href: string, options?: { titleHint?: string }) => void;
  replace: (href: string, options?: { titleHint?: string }) => void;
  back: () => void;
  forward: () => void;
}
```

The router remains the only route-body API for same-pane navigation.

### 8.6 Header Navigation Props

Replace optional `onBack` with a required descriptor.

```ts
export interface SurfaceHeaderNavigation {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

interface SurfaceHeaderProps {
  title: ReactNode;
  titlePending?: boolean;
  subtitle?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  options?: SurfaceHeaderOption[];
  navigation: SurfaceHeaderNavigation;
  headingLevel?: 1 | 2;
  className?: string;
  onOptionsOpenChange?: (open: boolean) => void;
}
```

`PaneShellProps` carries the same `navigation` descriptor and passes it through.

## 9. Architecture

### 9.1 Ownership

`schema.ts` owns the persisted state shape, constants, sanitization, and history
entry validation.

`store.tsx` owns all history mutations. Reducer branches call a small set of
pure helpers:

- `createEmptyPaneHistory()`;
- `normalizePaneHistory(value)`;
- `pushPaneHref(pane, nextHref)`;
- `replacePaneHref(pane, nextHref)`;
- `goBackPaneHref(pane)`;
- `goForwardPaneHref(pane)`;
- `trimWorkspacePaneHistory(state)`;
- `transitionExistingPaneHref(...)`.

`WorkspaceHost` owns threading pane history availability and callbacks into
`PaneRuntimeProvider` and `PaneShell`.

`PaneRuntimeProvider` owns the route-body router object.

`PaneShell` owns pane chrome composition.

`SurfaceHeader` owns the visible navigation controls.

`paneLinkNavigation.ts` remains the internal-anchor click policy owner. It
continues to call `paneRuntime.router.push` and does not know about stacks.

### 9.2 Data Flow

Normal in-pane link:

```text
anchor click
  -> PaneRouteBoundary
  -> handlePaneInternalAnchorClick
  -> paneRuntime.router.push(href, titleHint)
  -> WorkspaceStore.navigatePane(historyMode: push)
  -> reducer transition pushes old href into pane.history.back
  -> URL sync pushState
  -> WorkspaceHost rerenders that pane
```

Pane Back:

```text
SurfaceHeader Back
  -> PaneShell navigation.onBack
  -> WorkspaceHost goBackPane(paneId)
  -> WorkspaceStore.goBackPane
  -> reducer moves current href to forward and popped back href to current
  -> URL sync replaceState
  -> WorkspaceHost rerenders only the affected pane route
```

Browser Back:

```text
native browser Back
  -> popstate
  -> decodeWorkspaceStateFromUrl
  -> sanitizeWorkspaceState(schemaVersion: 5)
  -> hydrate full workspace snapshot
  -> URL sync skipped for that popstate turn
```

Open-pane de-duplication:

```text
requestOpenInAppPane / paneRuntime.openInNewPane
  -> WorkspaceStore.openPane
  -> if same resource exists, transition that existing pane href with push
  -> otherwise insert a new pane with empty history
```

### 9.3 Single Transition Helper

All current-href mutation must pass through one helper that receives:

- current pane;
- next href;
- history mode;
- activation mode;
- width clamp policy.

This avoids a split where `navigate_pane`, `open_pane` de-duplication,
direct-URL merge, and history traversal each edit `href`, `widthPx`, and
`visibility` by hand.

### 9.4 Existing Patterns To Reuse And Consolidate

Reuse these existing repo patterns instead of inventing parallel machinery:

- **Workspace store reducer as state owner.** Pane graph state already lives in
  `store.tsx`; history belongs there, not in `PaneShell`, route bodies, or
  reader components.
- **Schema boundary sanitization.** `schema.ts` already normalizes same-origin
  workspace hrefs and rejects invalid pane state. Extend that boundary for
  history arrays instead of validating in UI components.
- **URL/session as one workspace contract.** `urlCodec.ts`,
  `useWorkspaceSession`, and `sessionSync.ts` already share
  `WorkspaceStateV4`. Cut over that one contract to v5 instead of creating a
  runtime-only history lane.
- **Pane runtime router.** Route bodies already call `router.push` and
  `router.replace`; Back/Forward should extend that router instead of exposing
  a second hook.
- **Full-pane internal-link boundary.** `PaneRouteBoundary` and
  `paneLinkNavigation.ts` already centralize same-pane versus new-pane click
  policy. They should keep dispatching `router.push` and stay ignorant of stack
  internals.
- **Pane chrome ownership.** `PaneShell` and `SurfaceHeader` already own
  persistent pane header controls. Universal Back/Forward belongs there, not in
  `usePaneChromeOverride`.
- **Pane options path.** Pane-local actions continue to use
  `usePaneChromeOverride({ options })` and `ActionMenu`. Back/Forward are not
  pane options because they are universal chrome.
- **Runtime resource-key pruning.** Runtime titles and runtime widths already
  prune on resource-key mismatch. History traversal should reuse those existing
  effects by changing pane href through the same transition path.
- **Reader href semantics.** Reader navigation already distinguishes
  `router.push` user jumps from `router.replace` cleanup/normalization. Pane
  history should consume that distinction instead of adding reader-specific
  stack code.
- **Global-only command palette.** Open tabs are global state and may remain in
  the palette, but pane Back/Forward stays in pane chrome.

## 10. Composition With Other Systems

### 10.1 Pane Internal Links

The existing internal-link contract is preserved:

- primary click routes through current-pane `router.push`;
- Shift-primary click opens a sibling pane;
- external and browser-modified clicks remain native.

Only the store behavior behind `router.push` changes: it now records pane-local
history before updating the href.

### 10.2 Workspace URL Codec

`urlCodec.ts` encodes and decodes `WorkspaceStateV5`.

- Single-pane trivial state may still omit `ws=` when the only pane has empty
  history and the default href rules allow omission.
- A single pane with non-empty history is non-trivial and must include `ws=`.
- Multi-pane state includes each pane's history stacks.
- Unsupported `wsv=4` or missing v5 history shape fails closed through the
  schema boundary.
- The codec does not migrate v4.

### 10.3 Workspace Session Restore

Workspace session APIs store and restore `WorkspaceStateV5`.

- Saved v4 sessions are ignored by v5 sanitization and restore to the default
  workspace.
- `workspaceStatesEqual` compares pane histories.
- `isNonTrivialSession` treats non-empty history as non-trivial.
- Android-shell restricted-route filtering removes restricted panes and their
  histories together.

### 10.4 Direct URLs

Direct URLs remain authoritative.

- A direct URL without `ws=` creates a fresh v5 single-pane state with empty
  history.
- A direct URL merged into a restored v5 session uses the existing
  same-resource rule.
- If the merge updates an existing saved pane to the direct URL, the update is a
  replace during hydration, not a user push, because it represents initial URL
  intent rather than a user navigation inside the restored session.

### 10.5 Runtime Titles

Pane history entries do not store title hints.

- Runtime title records remain keyed by pane id and resource key.
- Same-resource query changes preserve runtime title records.
- Different-resource history traversal prunes stale records exactly like normal
  navigation.
- If Back returns to a dynamic route with no current runtime title, the existing
  pending-title behavior applies until the pane body publishes.

### 10.6 Runtime Width

History traversal clamps pane width through the restored href's route width
contract.

- User-resized width remains on the pane as today.
- Width is clamped when route max/min changes.
- Runtime min-width and extra-width records are pruned by resource key as today.
- History entries do not store historical widths.

### 10.7 Command Palette

The command palette remains global-only.

- Open-tab rows continue to activate or close panes.
- Global commands that target hrefs continue through `requestOpenInAppPane`.
- Pane history actions do not appear as palette commands.
- There is no scoped palette section for Back/Forward.

### 10.8 Navbar

The navbar currently navigates the active pane. That remains active-pane
navigation and now records pane-local history through `navigatePane(..., push)`.

Navbar navigation does not open a new pane and does not call browser history.

### 10.9 Reader

Reader components continue to express navigable locations as hrefs.

- `MediaPaneBody.navigateToSection` keeps pushing `?loc` for user section
  navigation.
- Reader repair/normalization keeps using replace.
- `TextDocumentReader` internal EPUB link handling keeps calling
  `navigateToSection`, which ultimately pushes only on cross-section href
  changes.
- `PdfReader` page/zoom controls remain internal PDF state.

### 10.10 Mobile

Mobile renders one active pane, but the same pane history model applies.

- The active pane header shows Back/Forward.
- Back/Forward only affects the active pane because only the active pane is
  rendered.
- The command-palette mobile history marker remains separate.
- Mobile document chrome hide/reveal continues to treat history buttons as
  normal header controls.

## 11. Files

### 11.1 Primary Files

- `docs/workspace-pane-history-cutover.md`
  - This spec.
- `apps/web/src/lib/workspace/schema.ts`
  - Bump schema version to 5.
  - Add pane history types and limits.
  - Sanitize v5 history shape.
  - Create default panes with empty history.
- `apps/web/src/lib/workspace/store.tsx`
  - Add history-aware reducer actions and helpers.
  - Add `goBackPane` and `goForwardPane`.
  - Route all href mutations through one transition helper.
  - Remove parent-route Back wiring assumptions from store callers.
- `apps/web/src/lib/workspace/urlCodec.ts`
  - Encode/decode v5 state.
  - Treat non-empty single-pane history as non-trivial.
- `apps/web/src/lib/workspace/sessionSync.ts`
  - Compare history stacks.
  - Preserve v5 history during restore.
- `apps/web/src/lib/panes/paneRuntime.tsx`
  - Add `back`, `forward`, `canGoBack`, `canGoForward` to
    `PaneScopedRouter`.
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
  - Build pane navigation descriptors from pane history state.
  - Pass descriptors to `PaneRuntimeFrame` and `PaneShell`.
  - Delete `getParentHref`/`window.history.back` header behavior.
- `apps/web/src/components/workspace/PaneShell.tsx`
  - Replace `onBack` prop with required navigation descriptor.
  - Pass navigation to `SurfaceHeader`.
- `apps/web/src/components/ui/SurfaceHeader.tsx`
  - Replace optional Back rendering with universal Back/Forward controls.
- `apps/web/src/components/ui/SurfaceHeader.module.css`
  - Rename/extend `.backButton` into navigation-control styles.

### 11.2 Secondary Files

- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
  - Delete `getParentHref` if no caller remains.
- `apps/web/src/lib/panes/paneRouteRegistry.test.tsx`
  - Delete parent-route Back expectations if `getParentHref` is removed.
- `apps/web/src/components/Navbar.tsx`
  - No behavior-specific code if it already uses `navigatePane`; verify it now
    records pane history.
- `apps/web/src/components/CommandPalette.tsx`
  - No pane-history commands. Verify global href execution remains correct.
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
  - No history stack code. Verify push/replace calls express intended semantics.

### 11.3 Test Files

- `apps/web/src/lib/workspace/schema.test.ts`
- `apps/web/src/lib/workspace/urlCodec.test.ts`
- `apps/web/src/lib/workspace/sessionSync.test.ts`
- `apps/web/src/lib/workspace/store.test.tsx`
- `apps/web/src/lib/panes/paneRuntime.test.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.test.tsx`
- `apps/web/src/components/ui/SurfaceHeader.test.tsx` if absent
- `apps/web/src/lib/panes/paneLinkNavigation.test.tsx`
- `e2e/tests/workspace-history.spec.ts`
- Existing E2E helpers and fixtures that hard-code `schemaVersion: 4`
- Existing workspace/pane E2E specs that encode `ws=`

### 11.4 Docs To Update After Implementation

- `docs/workspace.md`
  - Add pane history ownership and browser-history distinction.
- `docs/workspace-tabs.md`
  - Update session/direct URL notes for v5 history.
- `docs/pane-internal-link-navigation-cutover.md`
  - Note that primary same-pane links now write pane-local history.
- `docs/reader-implementation.md`
  - Clarify `?loc` push/replace history semantics.
- `docs/command-palette.md`
  - State explicitly that pane Back/Forward are pane chrome controls, not palette
    commands.

## 12. Implementation Plan

1. Add this spec.
2. Update workspace schema to v5 and add history fields.
3. Update schema, URL codec, and session tests to v5.
4. Add pure history helper tests before wiring UI.
5. Update `store.tsx` reducer/actions and preserve existing behavior for
   activate, open, close, minimize, restore, resize, title hints, URL sync, and
   session sync.
6. Update `PaneRuntimeProvider` and its tests.
7. Update `WorkspaceHost` to pass history availability and callbacks.
8. Update `PaneShell` and `SurfaceHeader` to render universal controls.
9. Delete `getParentHref` if no caller remains and remove its tests.
10. Update all workspace E2E fixture schema versions.
11. Add E2E coverage for per-pane Back/Forward in a multi-pane workspace.
12. Update related docs listed above.
13. Run focused web tests, then broader typecheck/lint and targeted E2E.

## 13. Acceptance Criteria

- Every pane header shows Back and Forward controls.
- Back and Forward controls are disabled, not hidden, when unavailable.
- Clicking Back in pane A changes pane A only.
- Clicking Forward in pane A changes pane A only.
- Clicking Back or Forward activates the owning pane.
- Clicking Back in pane A does not change pane B's href, history, width, or
  visibility.
- Normal same-pane link navigation adds one Back entry and clears Forward.
- Same-pane replace navigation changes current href and does not add Back.
- Push to the same href is a no-op for history.
- Replace to the same href is a no-op for history.
- Back moves current href to Forward and restores the last Back href.
- Forward moves current href to Back and restores the last Forward href.
- Open-pane de-duplication that retargets an existing pane records history for
  that target pane.
- Opening a brand-new pane creates empty Back and Forward stacks.
- Closing a pane removes its history with the pane.
- Minimizing/restoring a pane preserves its history.
- Resizing a pane preserves its history.
- Direct URL cold open starts with empty history.
- Workspace session restore preserves v5 pane histories.
- Old v4 workspace URL/session state is not migrated.
- Browser Back hydrates the whole workspace snapshot and preserves decoded pane
  histories.
- Pane chrome Back/Forward never call `window.history.back()` or
  `window.history.forward()`.
- `getParentHref` no longer controls pane header Back.
- Reader `?loc` user navigation creates pane history when it pushes href.
- Reader cleanup/normalization does not create pane history when it replaces
  href.
- PDF toolbar page/zoom controls do not create pane history.
- Command palette has no pane Back/Forward commands and no scoped pane-history
  mode.
- TypeScript exhaustive checks cover new reducer action variants.
- Tests cover behavior through public store/runtime/UI surfaces, not private
  helper implementation details alone.

## 14. Test Plan

### 14.1 Unit And Component Tests

`schema.test.ts`

- creates default v5 pane with empty history;
- sanitizes valid v5 pane history;
- rejects v4 workspace state;
- rejects panes without history;
- rejects invalid history hrefs;
- trims history stacks to the configured bounds.

`urlCodec.test.ts`

- round-trips v5 multi-pane state with histories;
- treats single-pane non-empty history as non-trivial;
- rejects unsupported version 4;
- encodes history arrays without title metadata.

`sessionSync.test.ts`

- `workspaceStatesEqual` detects Back/Forward differences;
- restored Android-filtered panes drop their histories with the pane;
- `isNonTrivialSession` returns true for non-empty history.

`store.test.tsx`

- push navigation records Back and clears Forward;
- replace navigation preserves stacks;
- Back and Forward mutate only the target pane;
- same-href push/replace are history no-ops;
- open-pane de-duplication records target-pane history;
- close/minimize/restore/resize preserve or remove history correctly;
- popstate hydration restores histories from URL.

`paneRuntime.test.tsx`

- router exposes canGoBack/canGoForward;
- router back/forward call workspace callbacks for the current pane;
- push/replace continue normalizing hrefs.

`SurfaceHeader.test.tsx`

- Back/Forward render in enabled and disabled states;
- accessible labels are correct;
- disabled controls do not invoke callbacks.

`WorkspaceHost.test.tsx`

- header Back calls `goBackPane(paneId)`;
- header Forward calls `goForwardPane(paneId)`;
- internal link routing still calls same-pane push;
- Shift-click still opens sibling pane.

### 14.2 E2E Tests

Add `e2e/tests/workspace-history.spec.ts`.

Core desktop scenario:

1. open an encoded v5 workspace with two visible panes;
2. navigate pane A from `/libraries` to `/search`;
3. navigate pane B independently;
4. click pane A Back;
5. assert pane A href/title/body changed and pane B did not;
6. click pane A Forward;
7. assert pane A restored and pane B still did not change;
8. assert tab strip, active pane, and URL state are coherent.

Reader scenario:

1. open EPUB or web article;
2. use reader contents to push two `?loc` values;
3. click pane Back;
4. assert active section and URL loc return to previous location;
5. click pane Forward;
6. assert section and loc move forward;
7. assert pane title does not become a section title.

Mobile scenario:

1. use a mobile viewport;
2. open a pane with history;
3. assert Back/Forward are visible in the active pane header;
4. click Back and Forward;
5. assert command palette behavior and mobile chrome hide/reveal remain intact.

## 15. Key Decisions

1. **Back means pane history, not parent route.**
   The old parent-route behavior was plausible as an Up button but wrong as
   Back. It is removed from pane chrome.

2. **Forward ships with Back.**
   Back without Forward creates an incomplete history model and makes traversal
   state invisible.

3. **Pane chrome never calls browser history.**
   Browser history restores whole-workspace snapshots. Pane chrome controls must
   be scoped to their pane.

4. **History is href-only.**
   Hrefs are the existing navigation currency. Titles, widths, resource keys,
   and reader source metadata are derived by existing systems.

5. **Hard schema cutover to v5.**
   The old v4 shape has no history and cannot represent the new contract. It is
   rejected rather than migrated.

6. **Traversal uses `replaceState`.**
   Pane Back/Forward is application-local traversal. It should not add a new
   native browser entry every time a user clicks the pane header controls.

7. **Push navigation still uses `pushState`.**
   Existing same-pane navigations remain visible to browser history as
   whole-workspace snapshots.

8. **One transition helper.**
   The reducer must not keep separate hand-written href updates in open,
   navigate, direct-URL merge, and history traversal branches.

9. **Command palette stays global-only.**
   Pane history is local pane chrome, not a palette command category.

10. **Reader semantics follow href semantics.**
    Reader actions that push hrefs create history. Reader actions that replace
    hrefs or only move scroll state do not.

## 16. Risks And Mitigations

| Risk | Mitigation |
|---|---|
| Encoded workspace URLs get too large. | Store href-only stacks, cap per-stack and total history entries, and prune deterministically before encoding. |
| Old saved sessions disappear after v5 cutover. | This is accepted hard-cutover behavior. Document it and do not add migration code. |
| Header controls crowd mobile chrome. | Use compact icon-only controls and keep meta hidden on mobile as today. Disabled controls remain visible but compact. |
| Back traversal clears dynamic pane titles. | Preserve existing runtime-title resource-key behavior. Pending title is acceptable until the body republishes. |
| Reader `?loc` replace paths accidentally create history. | Cover push vs replace in reader E2E and store tests. |
| `openPane` de-duplication bypasses history. | Route existing-pane retargeting through the same transition helper as `navigatePane`. |
| Browser Back and pane Back are confused. | Keep browser Back as whole-workspace popstate and pane Back as header-local `replaceState` traversal. |

## 17. Rules

- Do not add feature flags.
- Do not support schema v4.
- Do not migrate v4 URLs or saved sessions.
- Do not keep `onBack` as a compatibility prop.
- Do not call `window.history.back()` from pane chrome.
- Do not call `window.history.forward()` from pane chrome.
- Do not use `getParentHref` for pane Back.
- Do not add route-specific Back/Forward handlers.
- Do not add pane Back/Forward to the command palette.
- Do not store title hints in pane history entries.
- Do not store historical widths in pane history entries.
- Do not store external URLs in pane history entries.
- Do not silently repair malformed history entries.
- Do not duplicate push/replace/back/forward logic outside the workspace store.
- Do not let pane bodies hide the universal Back/Forward controls.
- Do not change native browser modified-click behavior.

## 18. Final State Summary

The final system has one pane navigation contract:

```text
Pane chrome and pane route bodies
  -> pane runtime router
  -> workspace store history-aware transition
  -> v5 workspace state
  -> URL/session sync
```

Back and Forward are visible in every pane, operate only on that pane, and are
driven by the same href transition model as internal links, reader navigation,
navbar active-pane navigation, and open-pane de-duplication. Browser history
remains whole-workspace history. Parent-route navigation is no longer mislabeled
as Back. Old workspace state is not migrated.
