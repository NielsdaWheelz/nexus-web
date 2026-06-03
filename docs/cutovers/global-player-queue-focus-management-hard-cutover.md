# Global Player Queue Focus Management Hard Cutover

Status: draft implementation spec
Date: 2026-06-03
Owner: web app / global player UI
Scope: `apps/web` global player queue overlay, player keyboard shortcut scope,
modal-overlay contract docs, and focused tests

## 1. Thesis

`GlobalPlayerQueuePanel` is currently a visual modal and an ARIA dialog in name
only. It renders a full-viewport scrim and `<section role="dialog">`, but it
does not implement modal-dialog behavior: focus does not move into the panel,
Tab can leave the panel, Escape does not close it, body scrolling is not locked,
the background is not declared modal, and focus return is undefined across both
open paths.

This is not a local button-focus bug. It is a broken app-level overlay contract.
The queue panel sits inside the global player system, not inside a pane, and it
must use the same overlay capability already used by `NavSheet`, command
palette, the mobile secondary-pane host, and the expanded mobile player sheet.

This is a hard cutover:

- no legacy queue overlay lane
- no compatibility branch for the old unfocused panel
- no route-local or viewport-local focus hacks
- no duplicated lock/trap/escape/focus effects
- no test-only hooks, props, or DOM markers
- no papering over with `autoFocus` alone

## 2. Governing Rules And Standards

Repo rules:

- `docs/rules/cleanliness.md`: one owner per concern, collapse repeated logic,
  remove fallback/compatibility lanes, and do not keep duplicated state
  machines.
- `docs/rules/module-apis.md`: expose each capability in one primary form and
  reuse existing module capabilities instead of introducing near-duplicates.
- `docs/rules/testing_standards.md`: frontend interaction and accessibility
  states belong in Vitest Browser Mode, with role/label queries and
  user-visible behavior assertions.
- `docs/architecture.md`: the authenticated app is a fixed client-side pane
  shell; player UI is an app-level surface, not a route `page.tsx` behavior.
- `apps/web/README.md`: `src/components/` owns UI components; `src/lib/ui/`
  owns cross-cutting UI hooks.

External accessibility targets:

- WAI-ARIA APG modal dialog pattern: focus moves into a modal dialog on open,
  Tab and Shift+Tab stay within the dialog, Escape closes the dialog, and focus
  returns to the invoking context unless workflow requires another logical
  target.
- WCAG 2.2 SC 2.1.2 No Keyboard Trap: keyboard users must be able to leave a
  focused component using the keyboard.
- WCAG 2.2 SC 2.4.3 Focus Order: sequential focus order must preserve meaning
  and operability.
- MDN / HTML platform direction: native `showModal()` puts dialogs in the top
  layer and makes same-document content inert; the repo's custom modal family
  does not use native `<dialog>`, so it must supply the equivalent behavior it
  can control: `aria-modal`, focus containment, dismissal, scroll containment,
  and return focus.

References:

- https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
- https://www.w3.org/WAI/WCAG22/Understanding/no-keyboard-trap.html
- https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html
- https://developer.mozilla.org/en-US/docs/Web/API/HTMLDialogElement/showModal
- https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inert

## 3. Current State

### 3.1 Queue Panel

Owner today:

- `apps/web/src/components/GlobalPlayerQueuePanel.tsx`
- `apps/web/src/components/GlobalPlayerFooter.tsx`
- queue styles in `apps/web/src/components/GlobalPlayerFooter.module.css`

Current behavior:

- `GlobalPlayerFooter` owns `queueOpen`, `effectsOpen`, `moreOpen`, and
  `mobileExpanded`.
- Desktop opens the queue from the `More controls` popover and immediately
  closes the popover.
- Mobile opens the queue from the expanded player sheet and immediately
  collapses that sheet.
- `GlobalPlayerQueuePanel` renders a full-screen `.queueOverlay` and
  `.queuePanel`.
- The panel declares `role="dialog"` and `aria-label="Playback queue panel"`.
- The overlay has no backdrop click handler.
- The panel has no `aria-modal`, no heading linkage, no `tabIndex`, no panel
  ref, no `useDialogOverlay`, no initial-focus selector, no return-focus
  fallback, no Escape handling, and no body scroll lock.

Concrete defect:

- On desktop, focus is likely left on a queue button that has been unmounted by
  closing the More popover.
- On mobile, the expanded sheet's return-focus cleanup may restore focus to the
  mini-player opener while the queue overlay is opening.
- Keyboard users and assistive technologies do not get a coherent modal
  lifecycle.

### 3.2 Existing Overlay Capability

Strong owner:

- `apps/web/src/lib/ui/useDialogOverlay.ts`

Owned contract today:

- `useBodyOverflowLock(active)`
- `useFocusTrap(ref, active)`
- `useReturnFocus(active, returnFocusFallback)`
- `useInitialFocus(ref, active, { select, key })`
- `useEscapeKey(active, onDismiss)`

Known users:

- `components/appnav/NavSheet.tsx`
- `components/palette/PaletteSurface.tsx`
- `components/palette/PaletteSheet.tsx`
- `components/workspace/MobileSecondaryPaneHost.tsx`
- `components/GlobalPlayerFooter.tsx` expanded mobile player sheet
- `app/(authenticated)/podcasts/PodcastSubscriptionSettingsModal.tsx`

Important limitation:

- The hook does not render markup and does not own outside pointer dismissal.
  The repo's custom modal pattern uses a scrim `onClick` plus panel
  `stopPropagation`.

### 3.3 Neighbor Patterns To Reuse

Use:

- `MobileSecondaryPaneHost`: best in-tree custom sheet pattern with
  `useDialogOverlay`, explicit `aria-modal`, custom initial focus, return-focus
  fallback, backdrop dismissal, and panel click containment.
- `PaletteSurface` / `PaletteSheet`: best portaled modal patterns.
- `NavSheet`: best slide-over pattern.
- `ActionMenu`: best anchored menu pattern, especially its explicit
  panel-handoff focus decision. It is a menu pattern, not a queue-panel base.

Do not use as the queue base:

- `ui/Dialog.tsx`: native `<dialog>` wrapper, but it does not match the current
  custom modal-hook family and would create a second modal-overlay lane for this
  surface.
- `useDismissOnOutsideOrEscape`: correct for anchored popovers and menus, not
  for full-screen modal sheets.
- route-local pane focus code: the queue is global player chrome, not pane
  chrome.

## 4. Final State

The final state has one player queue overlay that behaves consistently on
desktop and mobile:

- `GlobalPlayerFooter` remains the state and viewport owner for the global
  player UI.
- `GlobalPlayerQueuePanel` owns queue panel markup and modal behavior.
- `useDialogOverlay` is the only focus/scroll/Escape owner for the queue panel.
- The panel is a real custom modal dialog:
  - `role="dialog"`
  - `aria-modal="true"`
  - `aria-labelledby` pointing at the visible `Playback queue` heading
  - deterministic initial focus
  - trapped Tab / Shift+Tab
  - Escape close
  - backdrop click close
  - body scroll lock
  - focus restoration to a stable footer fallback when the opener is gone
- Global player keyboard shortcuts do not steal keys from focused queue controls
  or other explicit overlay scopes.
- Queue sortable keyboard behavior remains intact.
- Current queue item state is exposed semantically, not only through
  `data-current`.
- Queue overlay z-index participates intentionally in the modal stack.
- Tests cover both viewport open paths and the shared modal contract.

## 5. Ownership And Layering

### 5.1 Global Player Provider

Owner:

- `apps/web/src/lib/player/globalPlayer.tsx`

Responsibilities:

- audio element binding
- current track state
- queue data
- queue refresh / remove / reorder / clear / play-item actions
- media session and listening-state behavior
- global playback keyboard shortcut registration

Non-responsibilities:

- queue overlay markup
- queue focus management
- modal lifecycle state

### 5.2 Global Player Footer

Owner:

- `apps/web/src/components/GlobalPlayerFooter.tsx`

Responsibilities:

- desktop versus mobile player presentation
- `queueOpen`, `moreOpen`, `effectsOpen`, and `mobileExpanded`
- opening queue from desktop More controls
- opening queue from the mobile expanded sheet
- stable focus fallback refs for queue close
- closing mutually exclusive player overlays before queue opens
- rendering `GlobalPlayerQueuePanel` when open

Non-responsibilities:

- implementing the focus trap itself
- queue list rendering details
- backend queue mutations

### 5.3 Global Player Queue Panel

Owner:

- `apps/web/src/components/GlobalPlayerQueuePanel.tsx`

Responsibilities:

- panel and scrim markup
- `useDialogOverlay` wiring
- initial focus target
- `aria-modal`, title linkage, and queue item semantics
- backdrop dismissal
- panel click containment
- queue list actions
- preserving sortable keyboard behavior

Non-responsibilities:

- owning `queueOpen`
- deciding viewport mode
- reaching into workspace/pane state
- owning global playback shortcut registration

### 5.4 UI Hooks

Owner:

- `apps/web/src/lib/ui/*`

Responsibilities:

- generic, reusable modal overlay behavior
- generic focusable-element discovery
- generic Escape handling
- generic return focus

Non-responsibilities:

- player-specific shortcut scoping
- queue-specific focus fallback selection
- modal markup rendering

## 6. Capability Contracts

### 6.1 Queue Overlay Contract

`GlobalPlayerQueuePanel` accepts:

```ts
interface GlobalPlayerQueuePanelProps {
  onClose: () => void;
  returnFocusFallback?: () => HTMLElement | null;
}
```

Contract:

- `onClose` closes the queue from every close path.
- `returnFocusFallback` is used only when the element focused at activation is
  no longer connected.
- The panel is active for its whole mounted lifetime. Do not add a separate
  `open` prop.
- The panel must not query viewport state directly.
- The panel must not know whether it was opened from desktop More controls or
  the mobile expanded player.

### 6.2 Global Player Footer Focus Contract

`GlobalPlayerFooter` owns refs for stable return targets:

- desktop: the persistent `More controls` button
- mobile: the persistent collapsed mini-player expand button

Rules:

- When desktop opens queue from the More popover, close the More popover but
  pass the persistent More button as fallback.
- When mobile opens queue from the expanded sheet, close the expanded sheet and
  pass the persistent mini-player expand button as fallback.
- The footer must not rely on the transient queue trigger inside a popover or
  sheet being connected after queue open.
- If the persistent fallback is unavailable because the track disappeared, focus
  restore may no-op. Do not create hidden fake targets.

### 6.3 Keyboard Shortcut Scope Contract

`usePlayerKeyboardShortcuts` continues to own document-level playback shortcuts,
but it must skip events whose target is inside an explicit interactive overlay
or control scope.

Target API:

```ts
export const PLAYER_SHORTCUTS_DISABLED_SELECTOR =
  "[data-player-shortcuts-disabled]";
```

Rules:

- `usePlayerKeyboardShortcuts` ignores events from editable targets as today.
- It also ignores events where the target element is inside
  `[data-player-shortcuts-disabled]`.
- `GlobalPlayerQueuePanel` marks its panel with
  `data-player-shortcuts-disabled`.
- Other modal/dialog owners can adopt the same attribute when playback
  shortcuts conflict with local keyboard behavior.
- Do not add queue-specific conditionals to the global-player provider.
- Do not disable shortcuts globally whenever `queueOpen` is true unless focus
  is inside the disabled scope; mouse users should not lose global shortcuts
  because a passive overlay is present, but keyboard events targeted at the
  dialog must stay local.

Rationale:

- This keeps shortcut scoping declarative at the DOM boundary where keyboard
  ownership changes.
- It avoids passing queue UI state into `globalPlayer.tsx`.
- It composes with future overlays without adding new provider flags.

### 6.4 Sortable Queue Contract

The queue list continues to use `SortableList` and dnd-kit keyboard sensors.

Rules:

- Reorder handles remain actual `Button` elements with dnd-kit attributes and
  listeners spread onto them.
- Focus trapping must not remove or override dnd-kit keyboard listeners.
- Global player ArrowLeft/ArrowRight/Space shortcuts must not fire from focused
  reorder handles.
- Queue item removal and clear operations keep focus inside the dialog:
  - after removing the focused row, move focus to the next surviving row's
    primary play button; if there is no next row, move to the previous row's
    primary play button; if no rows remain, move focus to the queue title.
  - clearing the queue keeps the dialog open and moves focus to the queue title.

## 7. Key Decisions

### D1. Use `useDialogOverlay`, Not Native `<dialog>`

Native `showModal()` is the platform ideal because it provides top-layer
behavior and inert same-document content. The repo's current production overlay
family is custom markup plus `useDialogOverlay`. Queue must join that family
instead of introducing one native `<dialog>` island.

This keeps the hard cutover narrow and removes the defect without creating a
second modal architecture. A future native-dialog migration must happen as a
separate all-modal-family cutover, not opportunistically in the player queue.

### D2. Keep Overlay State In `GlobalPlayerFooter`

`GlobalPlayerFooter` already owns the mutually exclusive player overlays:
expanded mobile sheet, effects panel, More popover, and queue. Moving `queueOpen`
into the provider would mix UI overlay state with playback domain state and
force non-player UI to care about player overlay lifecycle.

### D3. Keep Queue Panel Markup In `GlobalPlayerQueuePanel`

The queue panel owns its own structure and semantics. It should not be folded
into `GlobalPlayerFooter`; that file is already responsible for desktop/mobile
player presentations. The footer passes stable focus fallback and close
callbacks; the panel owns the modal contract.

### D4. Initial Focus Goes To The Heading

Initial focus should land on the visible `Playback queue` heading with
`tabIndex={-1}`, not directly on Close.

Rationale:

- The queue is structured content: title, sortable list, item controls, and
  footer action.
- A long queue can be disorienting if focus jumps straight to a control and
  scrolls content.
- APG guidance permits focusing a static top element for large or structured
  dialogs.
- The first Tab from the heading reaches Close, then queue controls.

### D5. Backdrop Click Closes Queue

The queue overlay is a full-screen modal scrim. It should use the repo's custom
sheet dismissal pattern:

```tsx
<div className={styles.queueOverlay} role="presentation" onClick={onClose}>
  <section onClick={(event) => event.stopPropagation()} />
</div>
```

Do not use document-level outside pointer listeners for this modal.

### D6. Queue Overlay Uses Modal Stack Intentionally

The current `.queueOverlay` uses `--z-overlay`, while mobile nav and Add Content
use `--z-modal`, and command palette uses `--z-palette`. A visually modal queue
must use the modal overlay stack, not an incidental footer-local overlay level.

Target:

- `.queueOverlay { z-index: var(--z-modal); }`
- remove the fragile selector that promotes queue only when
  `.footer[data-mobile-view="expanded"]`

Rationale:

- Mobile queue opens after `mobileExpanded` is set false, so the selector is not
  a reliable state model.
- The queue is a modal peer of nav sheet and Add Content, not a local footer
  tooltip.

### D7. Expose Current Queue Item Semantically

The current row uses `data-current="true"` only. Add an accessible state:

- Prefer `aria-current="true"` on the row's primary play button when it
  represents the current track.
- Keep `data-current` for styling if needed.
- The accessible name may remain `Play {title} from queue`; do not add noisy
  repeated visible text solely for screen readers unless testing shows the state
  is not announced usefully.

### D8. No New Generic Overlay Component

This cutover should not introduce `<ModalSheet>`, `<Overlay>`, or a renderer
component. The repo already chose a hook-level contract; the queue only needs to
consume it. A generic wrapper would have to absorb divergent geometry, portal,
animation, and content needs and would violate the simplicity rule.

## 8. Duplicate And Similar Patterns To Consolidate Or Reuse

### 8.1 Reuse Directly

- `useDialogOverlay` for body lock, focus trap, return focus, initial focus,
  and Escape.
- `MobileSecondaryPaneHost` as the practical in-tree modal sheet example.
- `PaletteSurface` / `PaletteSheet` as portaled modal examples if the queue is
  later moved out of the footer DOM.
- `ActionMenu` focus handoff semantics for understanding why the desktop queue
  trigger cannot be the return target.
- `SortableList` for keyboard reorder semantics.

### 8.2 Consolidate In This Cutover

- Remove queue's bespoke non-modal dialog markup and make it a `useDialogOverlay`
  custom modal.
- Remove fragile queue z-index promotion tied to mobile-expanded footer state.
- Centralize global player shortcut opt-out in `usePlayerKeyboardShortcuts`,
  not in queue-specific event handlers.

### 8.3 Do Not Consolidate Here

- Do not migrate `AddContentTray` manual primitive composition to
  `useDialogOverlay`; it is a real adjacent cleanup but not needed for the queue
  defect.
- Do not migrate `ModelSettingsPopover` in this cutover; it has a desktop
  popover/mobile sheet split and deserves a separate focused cleanup.
- Do not resurrect the deleted `docs/cutovers/dialog-overlay-hook-unification.md`
  unless the docs cleanup explicitly owns deleted cutover history.
- Do not introduce sibling `inert` management unless applied to the whole custom
  modal family. Queue-only inert management would create a third modal isolation
  contract.

## 9. File Plan

### 9.1 Production Files

Edit:

- `apps/web/src/components/GlobalPlayerQueuePanel.tsx`
  - add `useRef`
  - import `useDialogOverlay`
  - add props interface with `returnFocusFallback`
  - create panel ref, title ref, and title id
  - call `useDialogOverlay({ active: true, ref: panelRef, onDismiss: onClose,
    initialFocus, returnFocusFallback })`
  - add `role="presentation"` and backdrop `onClick` to overlay
  - add panel `onClick={stopPropagation}`
  - add `aria-modal="true"`
  - replace `aria-label` with `aria-labelledby`
  - add `tabIndex={-1}` to the visible queue heading
  - add `data-player-shortcuts-disabled` to the panel
  - add semantic current item state
  - keep focus inside the dialog after row removal and queue clear

- `apps/web/src/components/GlobalPlayerFooter.tsx`
  - keep `queueOpen` local
  - add stable ref for the mobile mini-player expand button
  - keep existing `moreButtonRef` as desktop fallback
  - compute a `queueReturnFocusFallback`
  - pass `returnFocusFallback` to `GlobalPlayerQueuePanel`
  - ensure mobile open path closes expanded sheet and opens queue in a stable
    order
  - ensure desktop open path closes More and opens queue in a stable order

- `apps/web/src/components/GlobalPlayerFooter.module.css`
  - set queue overlay to modal z-index
  - remove `.footer[data-mobile-view="expanded"] .queueOverlay`
  - ensure panel scrolling is internal and full-height on desktop
  - ensure mobile panel accounts for safe-area bottom
  - ensure queue controls have a visible focus ring
  - keep no layout shifts on focus

- `apps/web/src/lib/player/usePlayerKeyboardShortcuts.ts`
  - add a single shared `PLAYER_SHORTCUTS_DISABLED_SELECTOR`
  - skip events from elements inside `[data-player-shortcuts-disabled]`
  - keep editable target guard
  - keep shortcut behavior otherwise unchanged

Explicitly out of scope:

- `apps/web/src/lib/ui/getFocusableElements.ts`
  - do not change this primitive for the queue cutover.

### 9.2 Test Files

Edit:

- `apps/web/src/__tests__/components/GlobalPlayerQueue.test.tsx`
  - keep existing queue behavior tests
  - add modal lifecycle tests
  - cover desktop and mobile open paths
  - cover shortcut scoping if the queue is the first consumer of
    `data-player-shortcuts-disabled`

Do not edit for this cutover:

- `apps/web/src/__tests__/components/GlobalPlayerFooter.test.tsx`
  - keep queue overlay behavior in `GlobalPlayerQueue.test.tsx` unless a
    pre-existing footer test fails because the footer behavior changed.

No backend files.

No API route files.

No migration files.

## 10. Target Behavior Details

### 10.1 Desktop

Flow:

1. A track is loaded.
2. User opens `More controls`.
3. User activates `Open playback queue (...)`.
4. Footer sets `queueOpen=true` and `moreOpen=false`.
5. Queue overlay mounts.
6. Focus moves to the queue title.
7. Body scroll is locked.
8. `Tab` cycles through Close, reorder handles, play buttons, remove buttons,
   Clear queue, and back to the title/first focusable according to the shared
   trap behavior.
9. Escape closes the queue.
10. Backdrop click closes the queue.
11. Close button closes the queue.
12. Playing an item closes the queue after invoking `playQueueItem`.
13. Focus returns to the persistent `More controls` button because the transient
    queue trigger inside the popover is gone.

### 10.2 Mobile

Flow:

1. A track is loaded.
2. User activates `Expand player`.
3. Expanded player sheet opens and receives focus using existing behavior.
4. User activates `Open playback queue (...)`.
5. Footer closes the expanded sheet and opens the queue.
6. Queue overlay mounts full-width.
7. Focus moves to the queue title, not back to the mini-player opener.
8. Body scroll remains locked for the active queue overlay.
9. Escape, backdrop click, Close, and item play close queue.
10. Focus returns to `Expand player`.

### 10.3 Empty Queue

If the queue is empty:

- the dialog still opens
- title receives initial focus
- Close remains available
- Clear queue remains visible but disabled
- `Queue is empty.` is visible
- Clear queue is disabled when there are no queue items
- Tab stays inside the dialog

### 10.4 Track Disappears While Queue Is Open

Current footer returns `null` when no track exists. If the track disappears,
footer unmounts the queue and audio element.

Target:

- no new compatibility behavior
- `useReturnFocus` tries the original active element, then fallback
- if both are gone, no fake target is created

## 11. API And Data Model Impact

No backend API changes.

No BFF route changes.

No database changes.

No playback queue service changes.

No queue item schema changes.

The cutover is purely frontend behavior and accessibility:

- `GlobalPlayerQueuePanelProps` gains a frontend-only callback prop.
- `usePlayerKeyboardShortcuts` gains DOM-scope filtering.
- Queue item semantic state may add ARIA attributes but does not change data.

## 12. Composition With Other Systems

### 12.1 Command Palette

Command palette is a higher z-index modal surface. The queue does not need to
open the command palette. If a global command palette shortcut can open while a
queue modal is active, that is a broader overlay-stack policy. Do not solve it
inside the queue unless tests reveal an immediate conflict.

### 12.2 App Navigation

App nav sheet and queue are modal peers. Queue must not depend on nav sheet
state. Both consume `useDialogOverlay`. Stacking order follows global z-index
tokens.

### 12.3 Add Content Tray

Add Content and queue are app-level overlays. They should not share state.
No new central overlay manager is introduced in this cutover.

### 12.4 Workspace And Pane Chrome

Workspace/pane code owns pane focus, pane tabs, secondary panes, and mobile pane
chrome. The queue must not import from `lib/workspace` or `components/workspace`
for focus fallback. It may coexist above the workspace because it is rendered in
the authenticated shell's main region via the global player footer.

### 12.5 Media Session And Playback

Queue overlay changes must not affect Media Session API behavior or audio
element binding. Playback can continue while the queue is open.

### 12.6 Sortable List

Queue preserves existing `SortableList` composition. If future accessibility
work improves sortable instructions or live announcements, it should happen in
`SortableList` and benefit library ordering too.

## 13. Acceptance Criteria

### 13.1 Behavior

- Opening queue on desktop moves focus inside the dialog.
- Opening queue on mobile moves focus inside the dialog.
- The queue dialog has `aria-modal="true"` and a visible-title accessible name.
- Tab and Shift+Tab cannot leave the dialog while it is open.
- Escape closes the dialog and prevents the default Escape event.
- Backdrop click closes the dialog.
- Clicking inside the panel does not close the dialog.
- Close button closes the dialog.
- Playing a queue item closes the dialog.
- Remove and Clear queue do not close the dialog.
- Removing the focused queue row moves focus to the next logical queue target.
- Clearing the queue moves focus to the queue title.
- Body scroll is locked while the queue is open and restored after close.
- Desktop close restores focus to `More controls` when the transient queue
  trigger has unmounted.
- Mobile close restores focus to `Expand player`.
- Space and Arrow key playback shortcuts do not fire from focused queue controls.
- Existing playback shortcuts still work when focus is outside disabled scopes.
- Keyboard reorder handle behavior remains available.
- Current queue item has a semantic current-state signal.

### 13.2 Architecture

- `useDialogOverlay` is the only queue focus/scroll/Escape implementation.
- No new generic modal component is introduced.
- No queue-specific global-provider state is added.
- No workspace/pane imports are added for queue focus handling.
- No native `<dialog>` queue implementation is introduced.
- No test-only props, exports, or DOM hooks are added.
- Queue overlay z-index uses the modal stack intentionally.
- The old mobile-expanded z-index promotion selector is removed.

### 13.3 Tests

- Browser component tests cover desktop open, focus-in, Escape close, body lock,
  and focus return.
- Browser component tests cover mobile open from expanded sheet and focus return
  to `Expand player`.
- Browser component tests cover Tab trap.
- Browser component tests cover backdrop click versus panel click.
- Browser component tests cover global shortcut opt-out from focused queue
  controls and unchanged shortcuts outside the scope.
- Existing queue behavior tests still pass.

## 14. Non-goals

- No backend playback queue changes.
- No API contract changes.
- No persistence changes.
- No queue reordering redesign.
- No all-app overlay manager.
- No migration of the whole modal family to native `<dialog>`.
- No inert implementation for only this one modal.
- No visual redesign beyond what the accessibility contract requires.
- No Playwright E2E unless a future real-stack playback journey is explicitly
  in scope.
- No changes to command palette, nav sheet, Add Content, or model settings
  beyond incidental test interaction if required.

## 15. Implementation Workstreams

### Workstream A: Queue Modal Contract

1. Add panel ref and title focus target.
2. Wire `useDialogOverlay`.
3. Add `aria-modal` and title linkage.
4. Add backdrop dismissal.
5. Add panel click containment.
6. Add `data-player-shortcuts-disabled`.
7. Add semantic current item state.

### Workstream B: Footer Focus Fallback

1. Add mobile mini-player expand ref.
2. Reuse desktop More button ref.
3. Derive fallback function based on current viewport.
4. Pass fallback to queue panel.
5. Keep open/close ordering explicit and simple.

### Workstream C: Shortcut Scope

1. Add disabled-scope check to `usePlayerKeyboardShortcuts`.
2. Keep existing editable-target guard.
3. Add tests proving queue controls do not trigger playback shortcuts.
4. Add tests proving document-level shortcuts still work outside the disabled
   scope.

### Workstream D: CSS Stack And Focus

1. Promote queue overlay to modal z-index.
2. Remove stale mobile-expanded promotion selector.
3. Ensure full-height desktop panel and full-width mobile panel keep internal
   scrolling.
4. Ensure focus-visible state is visible for queue controls.
5. Preserve existing density and layout.

### Workstream E: Tests

1. Extend `GlobalPlayerQueue.test.tsx`.
2. Prefer Testing Library role and label queries.
3. Use existing audio helpers and viewport helpers.
4. Do not mock internal components.
5. Keep assertions on behavior, not implementation details.

## 16. Verification Plan

Targeted local commands:

```bash
cd apps/web && bun run test:browser -- src/__tests__/components/GlobalPlayerQueue.test.tsx
cd apps/web && bun run test:browser -- src/__tests__/components/GlobalPlayerFooter.test.tsx
cd apps/web && bun run typecheck
cd apps/web && bun run lint
```

If Vitest project path filtering is not accepted by the script, use the nearest
supported narrow command:

```bash
cd apps/web && bun run test:browser
```

E2E is not required for this cutover unless the implementation changes routing,
auth/session setup, or real-stack queue seeding. If E2E is added later, use a new
focused `e2e/tests/playback-queue.spec.ts` rather than expanding unrelated
reader or workspace specs.

Manual smoke:

- desktop: load track, More controls, Queue, Tab, Shift+Tab, Escape
- desktop: reopen, backdrop click, Close, play queue item
- mobile width: Expand player, Queue, Tab, Escape, focus returns to Expand
  player
- verify playback controls still respond to global Space/Arrow when focus is on
  the document/body and do not respond when focus is inside queue

## 17. Risks And Mitigations

### R1. Nested Dialog Focus Cleanup Race On Mobile

Opening queue closes the expanded player sheet. The expanded sheet's
`useReturnFocus` cleanup can restore focus to `Expand player` while queue is
mounting.

Mitigation:

- Queue `useInitialFocus` runs on the next animation frame and must win the final
  active focus while mounted.
- Tests must assert final focus inside queue after opening from mobile sheet.

### R2. Opener Is Disconnected On Desktop

The queue trigger inside the More popover unmounts immediately.

Mitigation:

- Pass persistent `More controls` button fallback.
- Test focus return after Escape or Close.

### R3. Global Shortcut Interference

The global player shortcut listener is document-level.

Mitigation:

- Add disabled-scope selector to the shortcut hook.
- Mark queue panel as disabled scope.
- Test Space/Arrow from queue controls.

### R4. dnd-kit Keyboard Reorder Regression

Focus trap and shortcut filtering could interfere with reorder handles.

Mitigation:

- Do not stop propagation for all key events in the queue panel.
- Scope only global player shortcut handling.
- Leave dnd-kit listeners on reorder handles.

### R5. Overlay Stack Conflict

Queue currently uses `--z-overlay`, which can sit under modal peers.

Mitigation:

- Move queue to `--z-modal`.
- Do not create new tokens.

### R6. Over-broad Inert Change

Adding `inert` to app siblings for only the queue would create a one-off modal
contract inconsistent with the rest of the custom modal family.

Mitigation:

- Do not implement queue-only inert.
- If inert becomes required, write a separate whole-family modal isolation
  cutover.

## 18. Rollout Plan

1. Add tests for the current broken behavior first where practical. They should
   fail before production edits:
   - initial focus inside queue
   - Escape close
   - Tab trap
   - focus return for disconnected desktop trigger
   - mobile queue final focus
   - shortcut opt-out
2. Implement queue modal contract.
3. Implement footer fallback refs.
4. Implement shortcut scope.
5. Clean CSS stack.
6. Run targeted browser tests.
7. Run `typecheck` and `lint`.
8. Do not leave TODOs, compatibility branches, or alternate code paths.

## 19. Done Definition

The cutover is complete when:

- `GlobalPlayerQueuePanel` is no longer an a11y-deficient raw dialog.
- Every modal lifecycle behavior in the acceptance criteria is test-covered.
- The global player shortcut hook has a reusable scope opt-out.
- Queue overlay stacking is explicit and old state-dependent CSS is gone.
- No production code contains queue-specific focus hacks outside the owner
  layers named in this spec.
- No broad unrelated modal-family refactor is mixed into the patch.
