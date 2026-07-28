# Mobile Reader Scroll-Linked Chrome Hard Cutover

> **Superseded (2026-07-28):**
> `mobile-reader-unified-scroll-chrome-hard-cutover.md` is the sole final
> implementation contract. This document is historical evidence only.

Status: IMPLEMENTED IN WORKTREE; focused automated and physical Android proof
complete; type: hard cutover; date: 2026-07-26

## Decision

Replace the mobile reader's threshold-triggered `hidden` boolean with one
scroll-linked collapse model owned by `MobileChromeProvider`.

The app top bar and optional reader toolbar:

- retreat together, continuously, as the reader scrolls down;
- return together, continuously, after a small upward-direction dead zone;
- settle to fully shown or fully hidden after scrolling stops;
- remain fully shown at the document top, during visibility locks, and when
  reduced motion is requested.

This is a replacement. Delete the old threshold/toggle path. Do not ship a flag,
fallback, compatibility branch, or second motion policy.

## Open questions

None. This document is the binding implementation contract.

## Governing standards

- `docs/rules/index.md`
- `docs/rules/simplicity.md`
- `docs/rules/cleanliness.md`
- `docs/rules/frontend.md`
- `docs/rules/control-flow.md`
- `docs/rules/naming.md`
- `docs/rules/timing.md`
- `docs/rules/testing.md`
- `docs/modules/workspace.md`
- `docs/modules/reader-implementation.md`
- `docs/modules/reader-design-rationale.md`

## Goals

1. Make reading feel calm, direct, and native on the primary mobile device.
2. Give content the full viewport while preserving instant access to navigation.
3. Keep one policy owner, one scroll signal, and one visual progress value.
4. Avoid React work, layout, and reflow on the high-frequency scroll path.
5. Preserve current reader state, accessibility, safe-area, and lock behavior.

## Key decisions

- Retain the current provider, reader publishers, and presentation surfaces.
- Replace the boolean with normalized progress; do not layer progress over it.
- Use reader-owned scroll only; do not observe window or workspace scroll.
- Use RAF-coalesced CSS-variable writes; do not render React per scroll sample.
- Keep layout reserved and move chrome with transforms only.
- Use one short idle timer; do not add prediction or a scroll framework.
- Pin rather than animate for reduced motion.

## Scope

Included:

- authenticated mobile Media readers;
- web article, EPUB, readable transcript, and PDF reader scroll owners;
- global app top bar;
- optional reader formatting toolbar;
- Android wrapper/WebView and supported mobile browsers.

Excluded:

- desktop;
- chat, list, notes, settings, and other workspace panes;
- sheets, dialogs, bottom navigation, global player, and browser chrome;
- focus-mode pointer-idle behavior;
- backend, persistence, network APIs, analytics, or user preferences.

## Capability contract

Given an active mobile reader:

1. Initial chrome is fully shown.
2. `scrollTop <= TOP_PINNED_SCROLL_PX` pins chrome fully shown.
3. Downward reader scroll increases collapse progress continuously.
4. Upward reader scroll decreases collapse progress continuously after the
   reversal dead zone is crossed.
5. Progress is clamped to `[0, 1]`.
6. `0` means fully shown; `1` means fully hidden.
7. Both chrome surfaces consume the same progress in the same animation frame.
8. Reader content and `scrollTop` do not move when chrome moves.
9. Scroll idle settles to the nearest endpoint.
10. A visibility lock or reduced-motion preference forces progress to `0`.
11. Desktop and non-reader scroll events cannot change progress.

## Motion policy

Use named constants in the motion owner:

```ts
TOP_PINNED_SCROLL_PX = 8
DIRECTION_REVERSAL_DEAD_ZONE_PX = 8
COLLAPSE_TRAVEL_SCROLL_PX = 64
SCROLL_IDLE_SETTLE_DELAY_MS = 120
MIN_SCROLL_DELTA_PX = 1
```

Rules:

- Clamp reported scroll to `[0, scrollHeight - clientHeight]`.
- Ignore deltas smaller than `MIN_SCROLL_DELTA_PX`.
- On first source sample, establish a baseline and show chrome; do not infer
  motion.
- On direction change, collect distance without changing progress until
  `DIRECTION_REVERSAL_DEAD_ZONE_PX` is crossed.
- Apply only the distance beyond that dead zone.
- Convert applied distance to progress by
  `distance / COLLAPSE_TRAVEL_SCROLL_PX`.
- Down increases progress; up decreases it.
- Reset the idle timer for every accepted delta.
- After `SCROLL_IDLE_SETTLE_DELAY_MS`, settle to `0` when progress is below
  `0.5`; otherwise settle to `1`.
- Settle with existing `--duration-fast` and `--ease-glide`.
- Active scroll tracking has no CSS transition.
- A new accepted scroll delta interrupts settling immediately.
- Do not add velocity prediction, fling heuristics, `scrollend`, or
  `ScrollTimeline`.

These values are product constants, not configuration.

## State model

The owned motion state is exhaustive:

```ts
type MobileChromeMotionPhase =
  | { kind: "Visible" }
  | { kind: "Tracking"; direction: "Up" | "Down" }
  | { kind: "Settling"; target: "Visible" | "Hidden" }
  | { kind: "Hidden" }
  | { kind: "Pinned" };

interface MobileChromeMotionState {
  phase: MobileChromeMotionPhase;
  progress: number;
  lastScrollTop: number | null;
  direction: "Up" | "Down" | null;
  reversalDistancePx: number;
}

type MobileChromeMotionEvent =
  | { kind: "Start"; snapshot: MobileChromeScrollSnapshot }
  | { kind: "Scroll"; snapshot: MobileChromeScrollSnapshot }
  | { kind: "Settle" }
  | { kind: "FinishSettle" }
  | { kind: "Pin" }
  | { kind: "Unpin" };
```

Mutable high-frequency fields remain private to the provider:

- collapse progress;
- last clamped scroll position;
- current direction;
- accumulated reversal distance;
- pending animation frame;
- pending settle timer;
- registered presentation surfaces.

React state changes only for semantic endpoint/phase changes and pane chrome
publication. Progress updates must not re-render reader bodies.

## Architecture

```text
TextDocumentReader scroll root ─────┐
MediaPaneBody transcript viewport ──┼─> MobileChromeProvider
PdfReader viewport ─────────────────┘      ├─ pure motion reducer
                                          ├─ one RAF writer
                                          ├─ visibility locks
                                          └─ settle timer
                                               │
                             shared --mobile-chrome-collapse
                                               │
                               ┌───────────────┴──────────────┐
                               ▼                              ▼
                        NavTopBar surface              PaneShell toolbar
```

### Ownership

- `MobileChromeProvider` remains the sole policy and lifecycle owner.
- `TextDocumentReader`, the `MediaPaneBody` transcript viewport, and `PdfReader`
  remain the sole publishers for their real scroll roots.
- `NavTopBar` and `PaneShell` remain presentation consumers only.
- `AuthenticatedShell` remains the provider placement owner.
- `WorkspaceHost` does not observe or proxy scroll.
- CSS owns geometry; TypeScript owns normalized progress and state transitions.

Do not create a global scroll service, generic hide-on-scroll hook, event bus,
external store, or pane-family abstraction.

### Pure motion subsystem

Extract the deterministic math into:

`apps/web/src/lib/workspace/mobileChromeMotion.ts`

It owns:

- initial state;
- source reset;
- clamping and delta reduction;
- direction/dead-zone accounting;
- progress calculation;
- settle-target selection.

It has no DOM, React, timers, media queries, or workspace imports. Its API
accepts current state plus one event and returns the next state. Keep it
internal to the workspace module.

### Runtime orchestration

`mobileChrome.tsx` owns:

- mobile/reduced-motion observation;
- pane/source resets;
- `requestAnimationFrame` coalescing;
- the single settle timer;
- surface registration and CSS custom-property writes;
- semantic hidden state;
- existing visibility-lock reference counting.

Adapt the passive-listener/RAF/cancel-cleanup pattern already used by
`usePaneCanvas.ts`. Do not generalize that pattern into a shared framework.
Register `--mobile-chrome-collapse` as a typed `<number>`. Surface registration
requires the explicit role `AppBar | PaneToolbar`; the always-present `AppBar`
is therefore the unambiguous interpolation source. Its custom-property
`transitionend` publishes `FinishSettle`; ignore stale completion events after
an interruption. An accepted scroll during settling samples the app bar's
interpolated progress before any write, freezes both surfaces at that value,
then resumes tracking. This is the only high-frequency-path style read and it
occurs only when settling is interrupted.

### Presentation

Each registered surface receives:

```css
--mobile-chrome-collapse: <number from 0 through 1>;
```

Each surface maps that value to its existing full safe-area-aware retreat
distance.

- Use compositor-only `transform`.
- Transition the registered custom property only during `Settling`.
- Remove the pane toolbar's opacity choreography.
- Do not change content padding, grid rows, measured header height, or scroll
  position while tracking.
- Keep the existing fixed/sticky structure and z-index ownership.
- At progress `1`, chrome is fully outside the viewport with no visual sliver.
- At progress `0`, current geometry is unchanged.
- The Android wrapper keeps a permanent native black status-bar protection view
  behind forced-light system icons. It is sized from the status-bar inset and
  stays outside the web chrome contract; the WebView remains edge-to-edge. The
  native status-bar color is also black on pre-enforced-edge-to-edge Android.

The two surfaces may have different pixel travel distances. They must share
progress, direction, frame, and settle phase.

## In-process API

Canonicalize the duplicate reader scroll snapshot:

```ts
export interface MobileChromeScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface PaneMobileChromeController {
  startReaderScroll(snapshot: MobileChromeScrollSnapshot): void;
  updateReaderScroll(snapshot: MobileChromeScrollSnapshot): void;
  acquireVisibleLock(reason: PaneMobileChromeLockReason): () => void;
}
```

Contract:

- Each mounted reader scroll source calls `startReaderScroll` once after its
  scroll root exists and before publishing updates.
- `startReaderScroll` establishes the clamped baseline and resets progress to
  visible.
- The actual scroll owner calls `updateReaderScroll`; window/document scroll is
  never accepted.
- The provider exposes an internal
  `useMobileChromeSurface(ref, "AppBar" | "PaneToolbar")` registration hook for
  `NavTopBar` and the pane toolbar.
- No optional policy arguments, alternate thresholds, or callbacks are allowed.

Delete `TextDocumentReader`'s local `DocumentScrollSnapshot` type.

There is no network API and no persisted schema.

## Locks and accessibility

Retain all current visible-lock reasons:

- reader restore;
- PDF selection;
- text selection;
- highlight navigation;
- mobile secondary surface;
- library picker;
- action menu.

Add one explicit `"chrome-focus"` reason. Focus entering either chrome surface
acquires it; focus leaving the surface releases it.

While any lock is held:

- cancel pending RAF and settle work;
- set progress to `0`;
- keep ingesting scroll samples as the next baseline;
- do not jump when the final lock releases.

Accessibility rules:

- Reduced motion pins chrome visible; it does not substitute a shorter motion.
- Only the fully hidden endpoint sets chrome controls `aria-hidden` and `inert`.
- Tracking and settling surfaces remain represented in the accessibility tree.
- Focus acquisition reveals chrome before interaction continues.
- The persistent pane-title heading remains available at every progress value.
- Touch targets, labels, menu semantics, and focus order remain unchanged.

## Resets

Reset to fully shown and establish a fresh baseline when:

- active pane or active pane route changes;
- reader source mounts or changes;
- mobile mode is entered or exited;
- reduced-motion preference changes;
- visibility lock state crosses from unlocked to locked.

Unmount must cancel RAF, timer, media-query listener, and surface registrations.

## Hard-cut deletion

Delete all old threshold-toggle vocabulary and behavior:

- `hidden` as the motion policy state;
- `SCROLL_DELTA_EPSILON_PX`;
- `HIDE_TOLERANCE_PX`;
- `REVEAL_TOLERANCE_PX`;
- `TOP_ALWAYS_VISIBLE_SCROLL_PX`;
- `onDocumentScroll`;
- `data-hidden`;
- `data-mobile-chrome-hidden`;
- `.mobileChromeHidden`;
- endpoint-only tests that encode 24/16/60 px thresholds;
- comments describing hide/reveal as a delayed boolean toggle.

Do not retain aliases, deprecated types, duplicate CSS selectors, or legacy
tests.

## Files

Add:

- `apps/web/src/lib/workspace/mobileChromeMotion.ts`
- `apps/web/src/lib/workspace/mobileChromeMotion.test.ts`
- `apps/android/app/src/main/res/values/ids.xml`

Modify:

- `apps/web/src/lib/workspace/mobileChrome.tsx`
- `apps/android/app/src/main/java/app/nexus/android/MainActivity.kt`
- `apps/android/app/src/androidTest/java/app/nexus/android/MainActivityTest.kt`
- `apps/web/src/lib/workspace/mobileChrome.test.tsx`
- `apps/web/src/lib/workspace/paneDom.ts`
- `apps/web/src/components/appnav/NavTopBar.tsx`
- `apps/web/src/components/appnav/NavTopBar.test.tsx`
- `apps/web/src/components/appnav/AppNav.module.css`
- `apps/web/src/components/libraries/LibraryPlacementOverlay.tsx`
- `apps/web/src/components/libraries/LibraryPlacementOverlay.test.tsx`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/workspace/PaneShell.module.css`
- `apps/web/src/components/workspace/MobileSecondaryPaneHost.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.ac4.test.tsx`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/__tests__/components/Conversation.test.tsx`
- `apps/web/src/__tests__/components/PaneShell.test.tsx`
- `apps/web/src/__tests__/components/PdfReader.test.tsx`
- `e2e/tests/pane-chrome.spec.ts`
- `docs/modules/workspace.md`
- `docs/modules/reader-implementation.md`

`MediaPaneBody.tsx` adapts its existing Text-reader callback wiring and
transcript scroll root to the new start/update API. Do not redesign Media
routing.

## Acceptance criteria

### Motion

- A partial downward scroll produces matching intermediate retreat in both
  rendered chrome surfaces.
- An upward reversal produces no movement for 8 px, then reveals proportionally.
- Reversing again interrupts the prior direction without snapping.
- Idle partial progress settles to the nearest endpoint.
- Returning to the top reveals fully.
- Fast and slow scrolling remain frame-coherent.
- Content position, selection, and `scrollTop` are unchanged by chrome motion.

### Coverage

- Web article, EPUB, readable transcript, and PDF publish from their real scroll
  owners.
- A reader with no formatting toolbar moves only the app top bar.
- A reader with a toolbar moves both surfaces together.
- Window scroll and non-reader pane scroll have no effect.
- Safe-area and dynamically measured toolbar heights produce no gap or sliver.
- Desktop geometry and behavior are unchanged.

### Interaction

- Restore, selection, highlight navigation, secondary surface, library picker,
  action menu, and focused chrome pin fully visible.
- Releasing a lock does not jump or replay accumulated scroll.
- Hidden controls are not focusable or announced.
- Reduced-motion mode never collapses chrome.
- Pane/source/viewport changes reset cleanly.

### Performance

- Scroll listeners are passive.
- At most one presentation write is queued per animation frame.
- Active tracking writes transforms only.
- Reader bodies do not re-render per scroll sample.
- No layout read occurs after a progress write in the same frame.

## Required tests

1. Unit-test the pure motion reducer: clamp, top pin, first sample, dead zone,
   both directions, reversal, endpoints, and settle target.
2. Browser-test provider orchestration: RAF coalescing, interruption, timer
   cleanup, source reset, locks, reduced motion, and surface synchronization.
3. Component-test top-bar and toolbar semantics at visible, partial, settling,
   and hidden states.
4. Component-test the real Text and PDF scroll publishers.
5. Extend `e2e/tests/pane-chrome.spec.ts` for continuous text/PDF motion,
   direction reversal, idle settle, locks, reduced motion, and unchanged content
   offset.
6. Manually verify on the primary Android wrapper/WebView with touch scrolling,
   inertial flings, selections, menus, and display cutout/safe area.

Tests assert user-visible behavior and public capability boundaries. They do not
assert private refs, reducer shape, or implementation call counts except the
single-frame presentation invariant.

## Negative gates

Before completion, these searches must return no runtime legacy residue:

```bash
rg "HIDE_TOLERANCE|REVEAL_TOLERANCE|TOP_ALWAYS_VISIBLE|onDocumentScroll" apps/web/src
rg "DocumentScrollSnapshot|data-hidden|data-mobile-chrome-hidden|mobileChromeHidden" apps/web/src
```

Focused verification only:

```bash
cd apps/web

bun run test:unit -- \
  src/lib/workspace/mobileChromeMotion.test.ts

bun run test:browser -- \
  src/lib/workspace/mobileChrome.test.tsx \
  src/components/appnav/NavTopBar.test.tsx \
  src/__tests__/components/PaneShell.test.tsx \
  'src/app/(authenticated)/media/[id]/TextDocumentReader.test.tsx' \
  'src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx' \
  'src/app/(authenticated)/media/[id]/MediaPaneBody.ac4.test.tsx' \
  src/components/libraries/LibraryPlacementOverlay.test.tsx \
  src/__tests__/components/PdfReader.test.tsx

bun run typecheck
bun run lint:css-tokens
bunx eslint \
  src/lib/workspace/mobileChromeMotion.ts \
  src/lib/workspace/mobileChromeMotion.test.ts \
  src/lib/workspace/mobileChrome.tsx \
  src/lib/workspace/mobileChrome.test.tsx \
  src/lib/workspace/paneDom.ts \
  src/components/appnav/NavTopBar.tsx \
  src/components/appnav/NavTopBar.test.tsx \
  src/components/workspace/PaneShell.tsx \
  src/__tests__/components/PaneShell.test.tsx \
  src/components/libraries/LibraryPlacementOverlay.tsx \
  src/components/libraries/LibraryPlacementOverlay.test.tsx \
  'src/app/(authenticated)/media/[id]/TextDocumentReader.tsx' \
  'src/app/(authenticated)/media/[id]/TextDocumentReader.test.tsx' \
  'src/app/(authenticated)/media/[id]/MediaPaneBody.tsx' \
  'src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx' \
  src/components/PdfReader.tsx \
  src/__tests__/components/PdfReader.test.tsx \
  --max-warnings 0

cd ../..
PLAYWRIGHT_ARGS='tests/pane-chrome.spec.ts --project=chromium' make test-e2e
git diff --check
```

Do not substitute a broad repository verification suite.

## Non-goals

- per-reader tuning or saved collapse state;
- animation preferences beyond reduced motion;
- velocity-aware prediction;
- browser address-bar control;
- bottom-chrome coordination;
- opacity, blur, scale, or parallax effects;
- a reusable application-wide scroll framework;
- telemetry or experimentation infrastructure;
- DOM reparenting or workspace layout redesign.

## Final state

Mobile reader chrome has one owner, one scroll-derived progress value, one
settle policy, and two presentation surfaces. Actual reader scroll owners publish
snapshots; the provider reduces and schedules motion; CSS performs
compositor-only retreat. The old boolean threshold path and all of its names,
selectors, tests, and compatibility residue are absent.
