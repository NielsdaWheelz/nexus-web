# Workspace Pane Minimize Hard Cutover

## Purpose

Add first-class workspace pane minimization.

The current workspace can open, activate, navigate, resize, and close panes.
There is no hidden or minimized pane state. The final state makes
minimization a real workspace capability with explicit state, URL persistence,
focus behavior, command palette behavior, and accessibility semantics.

This is a hard cutover. The final state has no legacy workspace schema path, no
feature flag, no compatibility adapter, no duplicate pane strip, no fallback
minimize behavior, and no backward-compatible workspace URL migration.

## Goals

- Let users temporarily remove a pane from the visible desktop pane strip
  without closing it.
- Keep minimized panes open and restorable.
- Preserve each pane's order, width, href, runtime title, and mounted component
  state while minimized.
- Keep one active visible pane at all times.
- Keep desktop pane minimization discoverable beside close.
- Keep mobile behavior routed through the command palette, not inline tabs.
- Use one workspace state model for desktop and mobile.
- Make URL state authoritative for shareable multi-pane layout.
- Replace the global tab ARIA model with a pane-switcher model that matches
  the actual multi-pane workspace.
- Keep the implementation local to the existing workspace modules.
- Follow `docs/rules/codebase.md`, `docs/rules/module-apis.md`,
  `docs/rules/simplicity.md`, `docs/rules/control-flow.md`,
  `docs/rules/conventions.md`, and `docs/rules/testing_standards.md`.

## Reference Posture

- WAI-ARIA tabs are for one active tabpanel at a time. Nexus desktop panes are
  side-by-side, so the global workspace strip is not a strict ARIA tabs widget.
- WAI-ARIA supports `Delete` for closable tabs and context menus for extra tab
  actions. Multiple adjacent action buttons in a tab strip are still an
  unsettled accessibility pattern.
- Microsoft TabView, browser tabs, VS Code, JetBrains IDEs, and docking layout
  managers converge on explicit document-tab and pane-layout state rather than
  visual-only minimize buttons.
- Chrome minimized custom tabs and docked-pane systems treat minimize as
  "still open, temporarily out of the main surface." Nexus follows that model.

## Target Behavior

- Every workspace pane has a required visibility state:
  - `visible`,
  - `minimized`.
- Visible panes render in the desktop pane strip exactly as panes do today.
- Minimized panes stay represented in the desktop pane strip but their
  `PaneShell` is removed from layout and from the accessibility tree.
- Minimized panes remain mounted so transient route state is preserved.
- Clicking the minimize button on a visible pane changes it to minimized.
- Clicking a minimized pane's primary strip button restores and activates it.
- Clicking the restore button on a minimized pane restores and activates it.
- Closing a minimized pane removes it from workspace state.
- Opening a new pane always creates a visible pane.
- Navigating a pane with `activate: true` makes the target pane visible.
- Navigating a pane with `activate: false` preserves the pane visibility.
- Resizing applies only to visible pane shells through the existing resize
  handle. A minimized pane retains its previous width.
- The active pane is always visible.
- If the active pane is minimized, the nearest visible pane becomes active:
  - prefer the next visible pane to the right,
  - otherwise use the previous visible pane,
  - otherwise block the minimize action.
- The last visible pane cannot be minimized.
- The last visible pane's minimize button is disabled and remains labelled.
- Closing the last pane keeps the existing fallback-to-default-pane close
  behavior.
- Browser history records minimize and restore as workspace state changes.
- Reloading a v4 workspace URL restores minimized and visible panes exactly.
- Unsupported workspace URL versions are not migrated. They enter the canonical
  current-route startup path and produce a fresh v4 single-pane workspace.

## Desktop Behavior

- The pane strip shows every open pane in stable order.
- A visible inactive pane has:
  - primary pane activation button,
  - minimize button,
  - close button.
- A visible active pane has the same controls, with active styling on the
  primary button.
- A minimized pane has:
  - primary restore-and-activate button,
  - restore button,
  - close button,
  - subdued visual state,
  - accessible state text through the button label or adjacent screen-reader
    text.
- The close target remains stable while the pointer is over the pane strip so
  repeated close clicks do not accidentally jump under the pointer.
- The pane strip remains horizontally scrollable when it overflows.
- Minimize and close buttons are fixed-size icon buttons with accessible names.
- Icons come from `lucide-react` when suitable.
- No tooltip-only information is required for operation.

## Mobile Behavior

- Mobile does not render inline workspace tabs or minimize buttons.
- The pane chrome keeps its existing command palette launcher.
- The command palette `Open tabs` section lists visible and minimized panes.
- Selecting a visible pane activates it.
- Selecting a minimized pane restores and activates it.
- Minimized panes show a compact `Minimized` badge in the command palette.
- Minimized panes can be closed from the command palette.
- No mobile-only minimize UI is added in this cutover.

## Accessibility

- The global workspace strip is a pane switcher, not a WAI-ARIA tab widget.
- Do not use `role="tablist"`, `role="tab"`, `aria-selected`, or
  `aria-controls` for the global desktop workspace strip.
- Use a toolbar or labelled region model with roving focus for the primary pane
  buttons and adjacent action buttons.
- The active visible pane primary button exposes current state.
- A minimized pane primary button exposes that activating it will restore the
  pane.
- The minimize button label is `Minimize {pane title}`.
- The restore button label is `Restore {pane title}`.
- The close button label remains `Close {pane title}`.
- Keyboard arrow navigation moves through pane primary buttons.
- `Home` and `End` move to the first and last pane primary buttons.
- `Enter` and `Space` activate or restore the focused pane primary button.
- `Delete` closes the focused pane when focus is on a pane primary button.
- Minimize and restore buttons are reachable by normal tab navigation.
- Focus after minimizing an active pane moves to the new active pane's primary
  button or pane chrome.
- Focus after closing a pane follows the existing nearest-surviving-pane rule.
- Minimized pane content is not keyboard reachable and is not announced by
  assistive technology.
- Do not add positive `tabindex`.
- Do not remove visible focus styling.

## Final State

### Removed

- Workspace schema v3 as a live decode target.
- Any v3-to-v4 workspace URL migration.
- Any optional or missing pane visibility handling in live state.
- `WorkspaceTabsBar` as a strict ARIA tablist implementation.
- `aria-selected` and `aria-controls` semantics for global desktop panes.
- Any duplicate old/new pane strip component.
- Any feature flag or viewport fallback for minimize.
- Any CSS class kept only for the old tablist behavior.

### Kept

- The workspace store remains the only owner of pane graph state.
- The URL remains the persistence surface for multi-pane workspace state.
- `PaneShell` remains the owner of pane chrome, body mode, and resizing.
- Route components continue to use `PaneRuntimeProvider`.
- Pane runtime title publication stays keyed by pane id.
- Command palette remains the mobile pane switcher.
- Close still removes a pane.
- Resize still clamps widths through the workspace schema.

## Architecture

```text
WorkspaceStoreProvider
  owns WorkspaceStateV4
  enforces active visible pane invariant
  exposes activate/open/navigate/close/resize/minimize/restore
  syncs state to URL

WorkspaceHost
  resolves pane descriptors for all panes
  builds strip items for all panes
  renders all PaneShell instances
  hides minimized PaneShell wrappers from layout and accessibility

WorkspacePaneStrip
  renders the desktop pane switcher and pane actions
  owns strip keyboard navigation and post-action focus

CommandPalette
  renders visible and minimized panes in Open tabs
  restores minimized panes on selection

PaneShell
  remains mounted for minimized panes
  is not responsible for visibility state decisions
```

The workspace store owns graph state. The host owns rendering policy. The pane
strip owns desktop controls. The command palette owns mobile switching. No route
component owns minimization.

## State Shape

Use a new schema version:

```ts
export const WORKSPACE_SCHEMA_VERSION = 4;

export type WorkspacePaneVisibility = "visible" | "minimized";

export interface WorkspacePaneStateV4 {
  id: string;
  href: string;
  widthPx: number;
  visibility: WorkspacePaneVisibility;
}

export interface WorkspaceStateV4 {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  activePaneId: string;
  panes: WorkspacePaneStateV4[];
}
```

Rules:

- `visibility` is required.
- `activePaneId` must reference a visible pane.
- A valid state must contain at least one pane.
- A valid state must contain at least one visible pane.
- Sanitization creates only v4 state.
- Sanitization does not migrate v3 payloads.
- Invalid v4 state is replaced by the canonical current-route v4 startup state.

## Store Actions

Add reducer actions:

```ts
| { type: "minimize_pane"; paneId: string }
| { type: "restore_pane"; paneId: string }
```

Action rules:

- `minimize_pane` does nothing if the pane does not exist.
- `minimize_pane` does nothing if the pane is already minimized.
- `minimize_pane` does nothing if it would leave zero visible panes.
- `minimize_pane` moves active state only when minimizing the active pane.
- `restore_pane` does nothing if the pane does not exist.
- `restore_pane` marks the pane visible and active.
- `activate_pane` only activates visible panes.
- `open_pane` creates visible panes.
- `navigate_pane` with `activate: true` makes the pane visible and active.
- `navigate_pane` with `activate: false` preserves pane visibility.
- `close_pane` removes panes regardless of visibility.
- `resize_pane` preserves pane visibility.

## Structure

### Workspace Host

- Build descriptors for all panes, not only visible panes.
- Build strip items from all descriptors.
- Render all pane wrappers so minimized route trees remain mounted.
- Mark minimized pane wrappers with `hidden` and `inert`.
- Remove minimized wrappers from flex layout.
- Keep active visible pane scroll-into-view behavior.
- On mobile, render only the active visible pane.
- If viewport changes while a minimized pane has focus, move focus to the
  active visible pane chrome.

### Pane Strip

- Replace `WorkspaceTabsBar` with `WorkspacePaneStrip`.
- Keep the same visual density and horizontal overflow behavior.
- Keep roving focus for primary pane buttons.
- Make action buttons separate fixed-size controls.
- Add minimize/restore control next to close.
- Keep close focus transfer behavior.
- Add minimize focus transfer behavior.
- Use one component and one CSS module.
- Do not keep a `WorkspaceTabsBar` wrapper alias.

### Command Palette

- Include minimized panes in `Open tabs`.
- Add `Minimized` state text or badge.
- On row activation:
  - visible pane -> activate,
  - minimized pane -> restore.
- Keep close action available for all pane rows.
- Do not add a mobile minimize command in this cutover.
- Do not create a second command-palette pane model.

### URL Codec

- Encode v4 state only.
- Decode v4 state only.
- Reject unsupported versions without migration.
- Keep single visible pane URLs clean by omitting workspace params.
- Include workspace params when multiple panes exist or any pane is minimized.
- Preserve minimized panes in encoded state even if only one pane is visible.
- Keep the max workspace state param length protection.

### Styling

- Use existing color, spacing, radius, and transition tokens.
- Minimized pane strip item uses subdued foreground and inactive background.
- Disabled last-visible minimize button has disabled affordance.
- Active visible pane styling remains distinct.
- Fixed action button dimensions prevent tab width shifts from icon changes.
- The close target does not move under the pointer while the pointer remains in
  the pane strip.

## Rules

- Hard cutover only.
- No feature flag.
- No legacy component alias.
- No v3 URL migration.
- No backward-compatible schema type.
- No optional `visibility` in live pane state.
- No fallback minimize implementation.
- No duplicate desktop strip.
- No duplicate mobile pane switcher.
- No generic docking framework in this cutover.
- No drag-and-drop in this cutover.
- No floating windows in this cutover.
- No popout windows in this cutover.
- No per-route minimize policy.
- No route-owned minimize state.
- No global event bus for minimize.
- No localStorage persistence for workspace minimize state.
- No test-only props.
- No one-use exported type.
- No one-use helper unless it hides meaningful incidental complexity.
- No one-use constant unless the name improves the usage site.
- Branch explicitly on finite state values.
- Keep frontend changes in `apps/web/`.
- Keep docs updates in `docs/`.

## Key Decisions

1. Use pane visibility, not tab visibility.

   The workspace owns panes. The strip is a control surface for panes. The state
   name should match the system being controlled.

2. Keep minimized panes mounted.

   Minimize means temporarily remove from the visible workspace, not close and
   reopen. Keeping the route tree mounted preserves draft text, local scroll,
   active requests, and component state.

3. Make active pane always visible.

   A hidden active pane creates broken keyboard, screen reader, and scroll
   behavior. The reducer must make this impossible.

4. Disable minimizing the last visible pane.

   A workspace with no visible panes has no useful primary surface. Close
   already owns the last-pane default behavior.

5. Restore on primary minimized-pane activation.

   Users should not need to find a tiny restore icon to recover a minimized
   pane. The minimized pane's main strip target restores it.

6. Replace strict tab semantics.

   The desktop workspace can show multiple panes at once. ARIA tabs describe
   one selected panel from a set. The global strip needs pane-switcher semantics
   instead.

7. Bump schema without migration.

   The user requested no backward compatibility. Old workspace URLs do not
   attempt to preserve v3 multi-pane state.

8. Keep mobile command-palette driven.

   Mobile already has one pane switcher surface. Adding inline mobile minimize
   controls would create duplicate UI paths.

9. Defer full docking.

   Docking, floating, popout, and drag/drop are separate layout-system
   capabilities. Minimize should not smuggle in a docking framework.

## Files

### Add

- `docs/workspace-pane-minimize-hard-cutover.md`
  - Owns this cutover contract.

### Rename

- `apps/web/src/components/workspace/WorkspaceTabsBar.tsx`
  -> `apps/web/src/components/workspace/WorkspacePaneStrip.tsx`
- `apps/web/src/components/workspace/WorkspaceTabsBar.module.css`
  -> `apps/web/src/components/workspace/WorkspacePaneStrip.module.css`
- `apps/web/src/__tests__/components/WorkspaceTabsBar.test.tsx`
  -> `apps/web/src/__tests__/components/WorkspacePaneStrip.test.tsx`

### Update

- `apps/web/src/lib/workspace/schema.ts`
  - Bump schema to v4.
  - Add required pane visibility.
  - Enforce at least one visible pane.
  - Remove v3 compatibility assumptions.

- `apps/web/src/lib/workspace/urlCodec.ts`
  - Encode and decode v4 only.
  - Include minimized state in workspace params.
  - Keep clean URL only for one visible non-minimized pane.

- `apps/web/src/lib/workspace/store.tsx`
  - Add minimize and restore actions.
  - Expose `minimizePane` and `restorePane`.
  - Enforce active visible pane invariant.
  - Preserve runtime title caches for minimized panes.

- `apps/web/src/components/workspace/WorkspaceHost.tsx`
  - Render all panes while hiding minimized pane wrappers.
  - Pass visibility state and actions to `WorkspacePaneStrip`.
  - Keep mobile rendering to the active visible pane.
  - Remove strict tab panel labelling from pane wrappers.

- `apps/web/src/components/workspace/WorkspaceHost.module.css`
  - Add minimized pane wrapper behavior.
  - Preserve visible pane flex layout.

- `apps/web/src/components/workspace/WorkspacePaneStrip.tsx`
  - Render primary pane, minimize/restore, and close controls.
  - Own roving focus for primary pane buttons.
  - Own post-minimize and post-close focus.
  - Implement `Delete` close on primary pane focus.

- `apps/web/src/components/workspace/WorkspacePaneStrip.module.css`
  - Add fixed action button layout.
  - Add minimized visual state.
  - Keep overflow behavior stable.

- `apps/web/src/components/CommandPalette.tsx`
  - Include minimized pane state in `Open tabs`.
  - Restore minimized panes on selection.
  - Keep close action available.

- `docs/mobile-command-palette.md`
  - Clarify that `Open tabs` includes minimized panes and selection restores
    them.

### Tests

- `apps/web/src/lib/workspace/store.test.ts`
  - Minimizing active pane activates nearest visible pane.
  - Minimizing inactive pane preserves active pane.
  - Last visible pane cannot be minimized.
  - Restoring a pane makes it visible and active.
  - Closing minimized pane removes it.

- `apps/web/src/lib/workspace/schema.test.ts`
  - Sanitization requires v4.
  - Sanitization rejects states with no visible panes.
  - Width clamping preserves visibility.

- `apps/web/src/lib/workspace/urlCodec.test.ts`
  - v4 round-trip preserves minimized panes.
  - Minimized single-visible workspaces keep workspace params.
  - v3 workspace params are not migrated.

- `apps/web/src/__tests__/components/WorkspacePaneStrip.test.tsx`
  - Renders pane switcher semantics, not tablist semantics.
  - Minimize action calls the expected handler.
  - Restore action calls the expected handler.
  - Close focus transfer still works.
  - Arrow, Home, End, Enter, Space, and Delete behavior works.
  - Mobile switcher behavior remains absent from desktop strip tests.

- `apps/web/src/__tests__/components/CommandPalette.test.tsx`
  - Minimized panes appear in `Open tabs`.
  - Activating a minimized pane restores it.
  - Closing a minimized pane removes it without closing the palette.

- `apps/web/src/__tests__/components/PaneShell.test.tsx`
  - No direct minimize behavior belongs in `PaneShell`.

- `e2e/tests/*`
  - Add one focused workspace minimize flow after lower-level tests exist:
    open multiple panes, minimize one, reload URL, restore it, close it.

## Execution Order

1. Add v4 schema and reducer actions.
2. Update URL codec and unit tests.
3. Replace `WorkspaceTabsBar` with `WorkspacePaneStrip`.
4. Update `WorkspaceHost` render and focus policy.
5. Update command palette pane handling.
6. Update mobile command palette docs.
7. Add browser-mode component coverage.
8. Add one E2E flow.
9. Run targeted frontend typecheck, browser tests, and E2E.

## Acceptance Criteria

- Desktop users can minimize any pane when at least two panes are visible.
- Desktop users cannot minimize the last visible pane.
- A minimized pane disappears from the side-by-side content area.
- A minimized pane remains in the workspace strip.
- Restoring a minimized pane returns it to its original order and width.
- Restoring a minimized pane preserves local component state.
- Minimizing the active pane activates the nearest visible pane.
- Closing a minimized pane removes it from the strip and URL state.
- Reloading a v4 workspace URL restores visible and minimized panes.
- Old v3 workspace URLs do not restore old multi-pane state.
- Mobile users can see minimized panes in `Open tabs`.
- Mobile users can restore minimized panes from `Open tabs`.
- The desktop workspace strip no longer exposes strict tablist semantics.
- Keyboard users can activate, minimize, restore, and close panes.
- Screen reader users hear distinct minimize, restore, and close actions.
- The last visible pane cannot be hidden from keyboard or screen reader users.
- No feature flag or legacy strip remains.
- No v3 workspace decode or migration tests remain.
- Targeted frontend tests pass.

## Non-Goals

- Pinned tabs.
- Recently closed tabs.
- Tab groups.
- Drag-and-drop pane reordering.
- Full docking layout tree.
- Floating panes.
- Popout browser windows.
- Per-route minimize rules.
- Suspended minimized pane lifecycle.
- LocalStorage workspace persistence.
- Backend persistence of workspace layout.
- Mobile inline tab strip.
- Command palette redesign beyond minimized pane handling.
- Changing pane route definitions.
- Changing chat, media, reader, library, podcast, or settings route behavior.
- Changing close-last-pane fallback behavior.
- Changing auth, API, database, or worker code.
