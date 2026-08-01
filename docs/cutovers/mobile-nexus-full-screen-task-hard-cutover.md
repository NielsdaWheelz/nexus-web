# Mobile Nexus Full-Screen Task — Hard Cutover

**Status:** Implemented in ancestry · integration preservation required
**Type:** Presentation-only hard cutover
**Boundary:** Mobile Nexus only; 80/20 prototype slice

**Partial supersession (2026-07-31):**
[`nexus-intent-router-hard-cutover.md`](nexus-intent-router-hard-cutover.md)
replaces AC-3 in full, explicit Root -> Find, and the Root portion of AC-4.
Root now owns an autofocused search field and may open the software keyboard.
Full-screen geometry, modal lifecycle, guarded dismissal, safe-area,
visual-viewport, and focus-containment contracts remain authoritative.

**Historical follow-up authority (2026-07-30):**
[`daily-pages-quick-capture-hard-cutover.md`](daily-pages-quick-capture-hard-cutover.md)
deletes Today Capture and its workflow/recovery files, then composes the
gesture-time Quick Note handoff inside the final `SwitchboardTask`. Preserve
this document's task presentation, lifecycle, focus, Back, and geometry
contracts; its Today Capture file targets are historical.

Follow `docs/rules/`, especially cleanliness, simplicity, frontend,
correctness, boundaries, naming, control flow, and testing.

## Decision

The mobile Nexus control opens one opaque, full-viewport task surface.
Nexus is not a drawer or bottom sheet: it contains navigation, search,
multi-step workflows, and recovery.

Add one semantic `MobileFullScreenTask`. Do not add a full-screen mode to
`MobileSheet`. Both surfaces share modal lifecycle mechanics; each owns its
own geometry and affordances.

No product question blocks implementation.

## Integrated authority

The control and full-screen-task cuts are already ancestors of the current
reader-chrome repair. Their historical delivery order is no longer an
instruction to land or rebase commits. The repair targets the integrated final
state and must preserve the ownership precedence below:

- the reader cut owns mobile-chrome policy, stable-wrapper measurement, and
  inner-control motion;
- the control cut owns Nexus anatomy and count;
- this document owns task presentation and viewport capability names.

This document is the final authority for mobile Nexus presentation. It
supersedes only these predecessor clauses:

- `mobile-nexus-control-hard-cutover.md`: the final
  `SwitchboardSheet / MobileSheet` composition, sheet-preservation scope, and
  `MobileViewportProvider`-unchanged restriction. Preserve its complete
  48 px control anatomy, count, motion, focus, and obstruction-unregister
  contract.
- `mobile-reader-unified-scroll-chrome-hard-cutover.md`: its
  `MobileViewportProvider` “verify unchanged” instruction applies relative to
  the integrated base. Preserve the stable wrapper, inner-control motion, and
  mobile-chrome ownership contracts.
- `mobile-nexus-switchboard-hard-cutover.md`: the `MobileSheet` capability
  snippet and sole-importer gate; backdrop/drag dismissal grammar; sheet
  presentation ownership; and retained-one-`MobileSheet` final-state rule.
  Preserve its controller, page, workflow, focus, Back, accessibility,
  performance, and data contracts.
- `mobile-sheet-keyboard-unification-hard-cutover.md`: only the
  `MobileSheet`-exclusive keyboard importer and sheet-specific capability
  names. Preserve all contextual-sheet behavior and geometry.
- `desktop-nexus-switchboard-hard-cutover.md`: only its historical mobile
  `SwitchboardSheet` composition. Desktop Nexus remains unchanged.

The predecessor documents record this integrated precedence. Current module
docs describe the final state; the reader repair must preserve it.

## Goals

- Match surface to intent: persistent work is a pane; temporary sustained work
  is a full-screen task; brief contextual work remains a sheet.
- Preserve every current Nexus capability and state transition.
- Remove Nexus-only sheet geometry, gestures, terminology, and tests.
- Centralize shared mobile modal lifecycle without creating a universal
  overlay component.
- Lower total complexity and keep one path per behavior.

## Scope

In scope:

- mobile web and Android-web-shell Nexus presentation;
- one reusable full-screen-task primitive;
- shared mobile modal lifecycle extraction;
- generic mobile-overlay keyboard-report naming;
- Nexus presentation tests and current architecture/module docs.

Out of scope:

- desktop Nexus;
- Nexus ranking, page union, controller, search, actions, acquisition,
  recovery, or performance budgets;
- Companion/secondary panes, Walknote Review, contributor editors, choosers,
  dialogs, and legitimate contextual `MobileSheet` callers;
- Now Playing refactoring;
- tabs, pins, new routes, persisted history, predictive Back, View
  Transitions, FAB morphing, haptics, detents, or a general overlay rewrite;
- backend, database, API, transport, or persisted schema changes.

## Target behavior

### Entry and geometry

- Tapping the existing mobile Nexus control opens Nexus over the current
  workspace.
- The task is fixed to the visual viewport: all four edges, opaque canvas,
  safe-area aware, and above root chrome.
- Compact mobile presentation includes widths through 768 px and coarse-pointer
  landscape phones through 900 px. Fine-pointer short desktop windows remain
  desktop.
- No underlying content is exposed as a dismissal target.
- No scrim, exposed backdrop action, grabber, rounded sheet edge, max-height,
  detent, or drag/swipe dismissal exists.
- The Nexus wrapper stays mounted for focus and geometry continuity. Its
  `"Nexus"` fixed-obstruction registration releases synchronously while the
  task is open; the inner control is hidden and inert. Closing re-registers
  exactly once.
- One content region owns scrolling. The task itself never scrolls the page
  beneath it.

### Navigation and dismissal

- Root, Find, actions, capture, creation, Add, and recovery replace one another
  inside one task. They never stack task surfaces.
- Visible page-owned headers remain the only headers; do not add a second
  primitive-owned toolbar.
- Nested Back, Escape, browser Back, and Android hardware Back request the
  existing `controller.guardClose()` transition:
  - nested page: pop exactly one Nexus level and keep the task open;
  - Root or root-level recovery: run the guard, then dismiss;
  - dirty/running workflow: remain open and show the existing confirmation.
- Root `Done` and existing workflow Close actions keep
  `controller.close()` semantics: request full task dismissal through the
  existing guard.
- There is no outside-click or swipe dismissal.
- No dismissal changes the workspace URL.

### Focus, keyboard, and continuity

- Root initially focuses the `Nexus` heading. It does not open the keyboard or
  start remote work.
- Entering Find explicitly focuses its search field.
- Only the top modal is interactive, focus-trapped, and `aria-modal`.
- A transient `ActionMenu` consumes Back/Escape before Nexus without
  inerting or suspending its containing modal.
- A nested modal `Dialog` suspends and inerts Nexus without removing its
  opaque canvas; the workspace never becomes visible between modal layers.
- Non-navigation dismissal returns focus to the Nexus control.
- Successful workspace activation preserves destination-owned focus and does
  not refocus the hidden opener.
- Task-local text-entry controls compute to at least 16 CSS px so iOS Safari
  does not focus-zoom and change the visual viewport scale.
- The focused field remains above the software keyboard on iOS and Android.
  The task shrinks to the unobscured viewport; it does not become a lifted
  sheet.
- Rotation and mobile/desktop breakpoint changes preserve the controller page,
  query, draft, and recovery state.
- Reduced motion removes travel; behavior and focus ordering do not change.

### Visual contract

- Reuse current tokens, typography, rows, controls, and 48 px minimum targets.
- Use one calm opaque canvas and current sticky page headers.
- Reuse the full-screen Now Playing safe-area rule: page headers pad the
  physical top with `max(current spacing, env(safe-area-inset-top))`; scroll
  content similarly respects left, right, and bottom safe areas.
- Preserve narrow-phone and landscape usability without introducing a second
  layout mode.
- Use one short full-surface enter transition. Under reduced motion, render the
  final state with no animation. Motion is decoration, never state.

## Capability contracts

### `MobileFullScreenTask`

```ts
interface MobileFullScreenTaskProps {
  /** Stay mounted; gate behavior and portal rendering with active. */
  active: boolean;
  /** Called only after the dismissal request is accepted. */
  onDismiss(): void;
  /** Owns Back/Escape safety and may perform an internal pop. */
  onDismissRequest(): DismissDecision;
  ariaLabel: string;
  children: ReactNode;
  initialFocus(container: HTMLElement): HTMLElement | null;
  skipReturnFocus?: () => boolean;
  focusKey: unknown;
}
```

It owns:

- body portal and full-viewport opaque frame;
- `role="dialog"` and top-layer modal projection;
- shared focus, Escape, body-lock, return-focus, history, and keyboard
  lifecycle;
- visual-viewport and keyboard-aware full-screen geometry.

It does not own:

- open state, page state, title/header markup, business guards, content scroll,
  routing, persistence, or domain behavior;
- page padding. The feature's one header and one content scroll owner apply the
  exact top/side/bottom safe-area insets without creating a second scroll owner;
- layer/scrim/grabber/size/edge/axis/detent options.

Mount it unconditionally and drive `active`. Conditional mounting is forbidden
because `useHistoryDismiss` must observe the close transition.

Its DOM composition is fixed:

```text
portal
└── unpainted modal-projection wrapper
    data-modal-backdrop / data-suspended
    z-index: var(--z-nexus)
    └── opaque dialog frame
        role="dialog"
        panel ref / inert / aria-modal
        visual-viewport top + keyboard-bottom geometry
```

The wrapper carries `modalBackdropProjection` so modal stacking and root
text-entry classification remain correct. It has no background. The child
dialog frame owns the opaque canvas, so the global suspended-backdrop rule may
disable the wrapper without exposing the workspace.

### `useMobileModalLifecycle`

Extract one internal hook used by `MobileSheet` and
`MobileFullScreenTask`. It composes, but does not replace:

- `useDialogOverlay`;
- `useHistoryDismiss`;
- `useKeyboardInset`;
- `MobileViewportProvider` keyboard-inset publication.

Its complete internal contract is:

```ts
interface MobileModalLifecycleInput {
  panelRef: RefObject<HTMLElement | null>;
  active: boolean;
  onDismiss(): void;
  onDismissRequest?: () => DismissDecision;
  onEscape?: () => void;
  historyDismiss?: boolean;
  initialFocus?: (container: HTMLElement) => HTMLElement | null;
  returnFocusTo?: ReturnFocusTarget;
  returnFocusFallback?: ReturnFocusTarget;
  skipReturnFocus?: () => boolean;
  focusKey?: unknown;
  layerScope?: string;
}

interface MobileModalLifecycle {
  layerToken: ModalLayerToken;
  isTopmost: boolean;
  requestDismiss(): DismissDecision;
  keyboardBottomInsetPx: number;
  visualViewportTopPx: number;
}
```

`historyDismiss` defaults to `true`. `requestDismiss` runs the optional guard,
calls `onDismiss` only for `"accepted"`, and returns the decision.
`onEscape ?? requestDismiss` is passed to `useDialogOverlay`; history always
uses `requestDismiss`.

The hook renders no markup. It deliberately passes `panelRef` to
`useDialogOverlay`, which mutates `inert` and `aria-modal` and owns focus,
Escape, body lock, and return focus. The hook owns no CSS, scrim, gesture,
z-index, geometry application, or semantic surface choice.

Keyboard publication is load-bearing and active-gated: only
`active === true` registers `keyboardBottomInsetPx` with
`MobileViewportProvider`; inactive mounted surfaces publish nothing. Cleanup
releases that exact report. An inactive mounted surface consumes no viewport
context; an active surface still fails closed without the provider.
`MobileSheet` behavior and public props remain unchanged, including `onEscape`,
`historyDismiss`, return-focus targets, `focusKey`, layer scope, and
layer/scrim/gesture presentation.

`MobileFullScreenTask` consumes `visualViewportTopPx` locally. Do not publish
the top offset through `MobileViewportProvider`.

### Mobile viewport

Hard-rename the capability; add no alias:

```ts
interface MobileViewportCapability {
  registerFixedObstruction(
    id: MobileFixedObstructionId,
    element: HTMLElement,
  ): () => void;
  reportMobileOverlayKeyboardInset(px: number): () => void;
}
```

Rename `mobileSheetKeyboardInsetPx` to `mobileOverlayKeyboardInsetPx`,
`MobileSheetKeyboardReport` to `MobileOverlayKeyboardReport`, and all related
local identifiers. Keep `--mobile-overlay-keyboard-inset`; it is already the
correct public CSS name.

`useKeyboardInset` remains the sole keyboard-geometry reader but returns:

```ts
interface KeyboardViewportGeometry {
  keyboardBottomInsetPx: number;
  visualViewportTopPx: number;
}
```

`keyboardBottomInsetPx` keeps the existing thresholded formula:
`max(0, innerHeight - visualViewport.height - visualViewport.offsetTop)`.
`visualViewportTopPx` is the raw nonnegative finite `offsetTop` and is never
keyboard-thresholded. Missing/SSR viewport yields `{0, 0}`. Keep the existing
window/visual-viewport resize and scroll subscriptions.

The full-screen frame applies:

```text
top    = visualViewportTopPx
bottom = keyboardBottomInsetPx
```

Together those values cover the unobscured visual viewport vertically,
including iOS keyboard pan. A body overflow lock does not make pan
unreachable.

`useKeyboardInset` becomes importable only by
`useMobileModalLifecycle.ts`, plus its own test. No other production module
may read `visualViewport` to infer keyboard or overlay occlusion.
`FloatingActionSurface` remains the documented raw reader for non-modal
anchored placement; it is not a keyboard-geometry owner and is out of scope.

### Nexus

`NexusController`, `NexusPage`, `guardClose`, `close`, `dismissAccepted`,
`initialFocus`, `focusKey`, and
`shouldSuppressReturnFocusOnClose` remain the capability contract. Rename stale
sheet-only comments; do not alter transitions or add a presentation variant.
`ExitIntent` remains a private controller implementation type; do not export or
present it as a surface capability.

No data/API schema is introduced. The TypeScript props above are the entire new
boundary.

## Composition

```text
Nexus
├── DesktopNexus                         unchanged
└── SwitchboardTask
    ├── existing NexusController/pages   unchanged
    └── MobileFullScreenTask             new semantic geometry
        └── useMobileModalLifecycle      shared mechanics
            ├── useDialogOverlay
            ├── useHistoryDismiss
            ├── useKeyboardInset
            └── MobileViewportProvider

MobileSheet                             retained for brief contextual tasks
└── useMobileModalLifecycle             same mechanics, sheet geometry
```

`MobileNowPlaying` remains a product-specific full-screen modal. Migrating it
is a separate cutover; do not broaden this one.

## Hard-cut final state

Delete:

- `SwitchboardSheet.tsx`;
- the Switchboard `.sheet` size override;
- every Nexus import/reference to `MobileSheet`;
- Nexus sheet/grabber/scrim/drag assertions and wording;
- the old `reportMobileSheetKeyboardInset` identifier and all compatibility
  aliases;
- dead styles, comments, fixtures, and selectors exposed by those removals.

Create/rename:

- `SwitchboardTask.tsx` as the one mobile Nexus presentation owner;
- `MobileFullScreenTask.tsx` and its stylesheet;
- `useMobileModalLifecycle.ts` as the one shared mobile modal lifecycle owner.

Retain:

- `MobileSheet` and its real contextual callers;
- all shared overlay primitives;
- the Nexus controller/content components;
- the existing synthetic history-marker strategy;
- current Nexus interaction performance budgets.

Forbidden:

- `MobileSheet variant="fullScreen"` or equivalent geometry flags;
- dual Nexus sheet/task rendering, feature flags, fallbacks, compatibility
  exports, or deprecated aliases;
- a universal `Drawer`, `Overlay`, or surface component;
- copying modal, history, keyboard, or focus mechanics into the Nexus feature.

## Files

| File | Change |
| --- | --- |
| `apps/web/src/components/ui/MobileFullScreenTask.tsx` | New semantic primitive. |
| `apps/web/src/components/ui/MobileFullScreenTask.module.css` | New visual-viewport geometry, opaque child canvas, zero-option presentation, and `--z-nexus` layer. |
| `apps/web/src/components/ui/useMobileModalLifecycle.ts` | New shared mobile modal lifecycle. |
| `apps/web/src/components/ui/MobileSheet.tsx` | Recompose through the lifecycle hook; preserve behavior/API. |
| `apps/web/src/components/ui/{MobileFullScreenTask,MobileSheet}.test.tsx` | Observable semantic-surface behavior; no private-hook choreography tests. |
| `apps/web/src/components/ui/{Dialog.tsx,Dialog.module.css}` | Let product-owned nested dialogs opt into platform Back and put them in the `--z-nexus` top-modal band; retain `ActionMenu` above it. |
| `apps/web/src/lib/ui/useKeyboardInset.ts` | Return bottom inset plus raw visual-viewport top offset. |
| `apps/web/src/lib/ui/useDialogOverlay.ts` | Preserve outer return focus when a nested modal and its owner close together. |
| `apps/web/src/components/switchboard/SwitchboardSheet.tsx` | Delete/rename to `SwitchboardTask.tsx`; replace presentation only. |
| `apps/web/src/components/switchboard/switchboard.module.css` | Delete sheet override; adapt full-height content/scroll sizing and page-owned safe areas. |
| `apps/web/src/components/switchboard/NexusButton.tsx` | Keep the stable wrapper, release/re-register its obstruction, and make the inert inner control visually hidden while open. |
| `apps/web/src/components/nexus/{Nexus.tsx,useNexusController.ts}` | Rename import and stale presentation comments only. |
| `apps/web/src/components/nexus/{AddPanel,TodayCapturePanel}.module.css` | Apply safe areas at each page's header and sole scroll owner. |
| `apps/web/src/components/nexus/{AddPanel.tsx,AddPanelBoundary.tsx}` | Opt the real dirty-work confirmation into topmost platform Back dismissal. |
| `apps/web/src/components/nexus/TodayCapturePanel.test.tsx` | Rename the stale `mobile-sheet popstate` comment. |
| `apps/web/src/lib/mobileViewport/MobileViewportProvider.tsx` | Hard-rename sheet-specific keyboard-report names; retain active-report stack behavior. |
| `apps/web/src/lib/mobileViewport/model.ts` | Hard-rename sheet-specific projection inputs and diagnostics. |
| `apps/web/src/lib/mobileViewport/*.test.ts*` | Update the renamed capability contract. |
| `apps/web/src/lib/renderEnvironment/{provider,provider.test}.tsx` | Keep coarse-pointer landscape phones in compact mobile presentation without changing fine-pointer desktop windows. |
| `apps/web/eslint.config.mjs` | Make the lifecycle hook the sole keyboard-inset importer. |
| `apps/web/src/components/nexus/Nexus.test.tsx` | Preserve behavior; assert task dismissal/focus semantics. |
| `e2e/tests/{mobile-sheets,nexus}.spec.ts` | Keep contextual-sheet coverage in the former; move Nexus task coverage to the latter. |
| `apps/android/app/src/androidTest/java/app/nexus/android/MainActivityTest.kt` | Preserve/run nested Back and recreation gates; change only stale wording if present. |
| `apps/web/src/app/globals.css` | Verify the existing suspended-backdrop rule unchanged; the opaque canvas must not live on its marker. |
| `docs/{architecture.md,modules/overlays.md,modules/app-navigation.md,modules/workspace.md}` | Record final ownership and terminology. |
| `docs/cutovers/mobile-nexus-control-hard-cutover.md` | Record integrated ownership and presentation supersession. |
| `docs/cutovers/mobile-reader-unified-scroll-chrome-hard-cutover.md` | Record integrated ownership and preservation proof. |
| `docs/cutovers/mobile-nexus-switchboard-hard-cutover.md` | Enumerate the five superseded sheet/keyboard clauses; retain all behavior/data contracts. |
| `docs/cutovers/mobile-sheet-keyboard-unification-hard-cutover.md` | Supersede only sheet-exclusive keyboard naming/import ownership. |
| `docs/cutovers/desktop-nexus-switchboard-hard-cutover.md` | Supersede its historical mobile composition only. |

No Python, migration, API, database, route, or persistence file is in scope.

## Integration preservation proof

1. Treat the integrated reader/control/full-screen state as the baseline.
2. Run focused task presentation, focus, Back, viewport, keyboard, safe-area,
   and obstruction proof.
3. Prove the reader repair preserves the stable wrapper, inner-control motion,
   Nexus anatomy/count, and full-screen-task ownership.
4. Audit for ownership drift, duplicate paths, and stale sheet terminology.

Do not leave an intermediate dual path in the final diff.

## Acceptance criteria

### Behavior

- **AC-1:** Tapping the Nexus control opens one visible dialog named `Nexus`
  whose frame covers the viewport within 1 px at 390×844, 320×568, 844×390,
  and 568×320.
- **AC-2:** The open task has an opaque canvas, no grabber, no sheet edge, and
  no pointer/drag dismissal. The modal-projection wrapper is unpainted; the
  wrapper uses `z-index: var(--z-nexus)`, and the child dialog frame owns the
  canvas. While open, the Nexus wrapper remains mounted and its inner control
  is hidden/inert, but no `"Nexus"` obstruction is registered; close
  re-registers exactly one obstruction without a duplicate-registration
  defect.
- **AC-3:** Root initially focuses its heading and exposes no search field or
  software keyboard; explicit Find entry focuses the search field.
- **AC-4:** Nested Back/Escape/browser Back/Android Back pops one Nexus page.
  The next Back dismisses Root without navigating the workspace.
- **AC-5:** Existing dirty/running workflow guards block Back, Escape, Done,
  and Close exactly as before.
- **AC-6:** Non-navigation close restores Nexus-control focus. Successful
  activation closes Nexus and leaves focus at the destination.
- **AC-7:** Keyboard-open focused controls remain visible and the task stays
  within the unobscured viewport on Chromium/Android and real iOS Safari.
  Task-local text-entry controls compute to at least 16 CSS px and focusing
  them does not trigger iOS Safari focus zoom.
  Within 1 px, frame top equals `visualViewport.offsetTop` and frame bottom
  equals `visualViewport.offsetTop + visualViewport.height`.
- **AC-8:** Rotation and mobile↔desktop changes preserve the active page,
  query, draft, and recovery state.
- **AC-9:** A transient `ActionMenu` consumes Back/Escape before Nexus but does
  not inert or suspend its containing modal. A nested modal `Dialog` suspends
  and inerts Nexus. Back/Escape closes only the topmost layer; the suspended
  Nexus canvas remains opaque and the workspace is never exposed.
- **AC-10:** Existing production-build Pixel 7 / 4× CPU p95 budgets remain
  exact: `nexus-open <100 ms`, `nexus-local-find <1000/60 ms`,
  `nexus-pane-activate <100 ms`, and `nexus-openables <250 ms`.

### Structure

- **AC-11:** Switchboard runtime code contains no `MobileSheet`,
  `SwitchboardSheet`, `mobile-sheet`, grabber, scrim, detent, or drag path.
- **AC-12:** `useKeyboardInset` has one production importer,
  `useMobileModalLifecycle.ts`; inactive mounted surfaces publish no keyboard
  report, and releasing the newest active report restores the preceding report.
- **AC-13:** `reportMobileSheetKeyboardInset` and `MobileSheetKeyboard*` have
  zero hits under `apps/` and `e2e/`. Historical cutover documents are
  explicitly excluded.
- **AC-14:** `MobileSheet` exposes no full-screen option and retains its
  contextual-sheet behavior.
- **AC-15:** The task's modal-projection marker carries
  `data-modal-backdrop`/`data-suspended`, has no painted background, and wraps
  the opaque dialog frame. The new task API has no `panelId`, layer, scrim,
  grabber, size, edge, axis, detent, or gesture option.
- **AC-16:** No legacy path, fallback, compatibility alias, feature flag, new
  backend/API schema, or new dependency exists.

### Verification

- Sociable browser/component tests through `MobileSheet`,
  `MobileFullScreenTask`, and Nexus for close/Back/focus, active-gated keyboard
  publication, viewport projection, opaque suspension, and modal stacking.
  Do not add a direct `useMobileModalLifecycle` implementation test.
- Static formatting, lint, CSS-token lint, and TypeScript gates.
- Real-stack Playwright mobile Nexus flows, geometry, breakpoint continuity,
  and performance.
- Android instrumentation for nested Back and orientation recreation.
- Manual iOS Safari keyboard/focus smoke.
- Screenshot review at 390×844, 320×568, 844×390, and 568×320, plus reduced
  motion and forced colors.

Report focused/local, real-stack E2E, Android, iOS, CI, and production proof as
separate verdicts. Unrun gates remain unproven.

## Done

The cutover is complete only when the new task is the sole mobile Nexus
presentation, all superseded sheet paths are deleted, current docs describe
the final state, and every applicable acceptance gate above passes.
