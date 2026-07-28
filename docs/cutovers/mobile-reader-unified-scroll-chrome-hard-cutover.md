# Mobile Reader Unified Scroll Chrome Hard Cutover

Status: APPROVED SPEC; type: hard cutover; date: 2026-07-28

## Decision and authority

Repair the mobile reader's focus-pinned chrome path and make the fixed Nexus
control the third presentation surface of the existing scroll-linked
`MobileChromeProvider`.

This document supersedes
`mobile-reader-scroll-linked-chrome-hard-cutover.md` in full, including the
Android status-bar contract restated below. It functionally narrows
`mobile-nexus-switchboard-hard-cutover.md`: G1's one-tap Nexus entrance applies
while Nexus is visible; hidden reader chrome requires upward scroll first. All
other Switchboard, viewport, reader, workspace, and player contracts remain
authoritative.

No open questions remain.

## Governing standards

Follow `docs/rules/`, especially simplicity, cleanliness, frontend, naming,
timing, boundaries, and testing. `docs/modules/workspace.md` and
`docs/modules/reader-implementation.md` define the current owners; this document
defines only their cutover.

## Goals

1. One ordinary mobile reading gesture retreats all transient chrome.
2. Upward reader scroll restores it immediately after the existing dead zone.
3. Pointer reading intent releases stale chrome focus; keyboard focus remains
   protected.
4. Keep one policy, one progress value, one frame writer, and one lock system.
5. Add no layout motion, persistence, network contract, preference, or framework.

## Key decisions

- Repair the existing reducer/provider; do not replace the motion model.
- Centralize focus locks in surface registration; do not add a third copy.
- Hand off stale chrome focus once at the shared reader-layout boundary.
- Add Nexus as a third semantic surface; do not give it scroll state.
- Measure a stable Nexus wrapper; transform only its inner control.
- Register only active mobile surfaces and reconcile focus at breakpoints.
- Keep reduced-motion chrome visible.

## Target behavior

For an authenticated mobile web article, EPUB, readable transcript, or PDF:

- app bar and optional pane toolbar retreat upward;
- Nexus retreats downward;
- all three share progress, direction, frame, settle phase, resets, and locks;
- fully hidden chrome stays hidden until upward reader scroll, top arrival, or a
  visibility lock reveals it;
- content geometry and `scrollTop` never move with chrome;
- desktop and non-reader panes do not participate.

Android's active player, browser chrome, sheets, and dialogs do not move.

## Scope

Included:

- the existing text, EPUB, transcript, and PDF reader scroll owners;
- stale mobile chrome-focus handoff;
- desktop-to-mobile surface and focus reconciliation;
- `AppBar | PaneToolbar | NexusControl` presentation;
- stable Nexus obstruction measurement during visual retreat;
- Nexus hidden-state accessibility;
- focused real-stack and primary Android touch proof;
- current module docs and predecessor authority.

Excluded:

- motion-reducer redesign or tuning;
- general settle-engine or `transitioncancel` redesign;
- non-reader scroll;
- global player motion;
- dynamic bottom-clearance animation;
- backend, database, network API, analytics, flags, or preferences;
- iOS-native code or a reusable application-wide scroll system;
- cross-origin iframe event bridging or an unsupported-browser motion fallback.

## Existing defect

`WorkspaceHost` focuses active mobile pane chrome. The surface acquires
`chrome-focus`; any lock pins progress to `0`. Touch scrolling does not reliably
blur that focus. Existing E2E hides the defect by calling
`document.activeElement.blur()` before positive motion assertions.

The hard cut removes that test precondition and makes reader pointer intent own
the focus handoff.

## Final architecture

```text
MediaPaneBody reader pointer intent
                  │
                  └── beginReaderPointerInteraction()
                                │
Text / EPUB viewport ───────────┐
Transcript viewport ────────────┼──> MobileChromeProvider
PDF viewport ───────────────────┘      ├── pure existing reducer
                                      ├── one RAF writer / settle timer
                                      ├── one surface registry
                                      └── one lock registry
                                                │
                             --mobile-chrome-collapse
                                                │
                         ┌──────────────────────┼────────────────────┐
                         ▼                      ▼                    ▼
                    MobilePaneBar          PaneShell          NexusButton
                      AppBar              PaneToolbar      inner NexusControl
                      slide up              slide up            slide down
                                                                  │
                                                    stable fixed wrapper
                                                                  │
                                                    MobileViewportProvider
```

### Ownership

- `mobileChromeMotion.ts` remains the sole pure motion owner.
- `MobileChromeProvider` owns lifecycle, surface focus, pointer handoff, locks,
  progress publication, and settle completion.
- Existing reader scrollports remain the only scroll publishers.
- `MobilePaneBar`, `PaneShell`, and `NexusButton` are presentation consumers.
- `MobileViewportProvider` measures only Nexus's untransformed outer wrapper and
  remains the sole fixed-obstruction geometry owner.
- CSS owns per-surface retreat distance; TypeScript owns semantic state.

Do not create another context, hook family, listener service, event bus, store,
or FAB motion state.

## Capability and API contract

Retain the existing snapshot and motion-state shapes and add one role and one
command:

```ts
type MobileChromeSurfaceRole =
  | "AppBar"
  | "PaneToolbar"
  | "NexusControl";

interface PaneMobileChromeController {
  startReaderScroll(snapshot: MobileChromeScrollSnapshot): void;
  updateReaderScroll(snapshot: MobileChromeScrollSnapshot): void;
  beginReaderPointerInteraction(): void;
  acquireVisibleLock(reason: PaneMobileChromeLockReason): () => void;
}

function useMobileChromeSurface(
  ref: RefObject<HTMLElement | null>,
  role: MobileChromeSurfaceRole,
  enabled: boolean,
): void;
```

`beginReaderPointerInteraction`:

1. is a no-op outside mobile mode;
2. reads `document.activeElement`;
3. blurs it only when it is an `HTMLElement` contained by a registered chrome
   surface;
4. does not delete locks, change progress, settle, or inspect scroll geometry;
5. is called from `MediaPaneBody`'s reader-layout `pointerdown` capture path for
   the primary pointer.

Blur releases `chrome-focus` through normal surface focus-out ownership.
Keyboard scroll, programmatic restore, and synthetic scroll publication do not
invoke this command.

There is no network API or persisted schema.

## Intra-system composition

### Central focus ownership

Move duplicate surface focus-lock logic into surface registration:

- only enabled mobile surfaces register;
- AppBar and Nexus register while mounted; PaneToolbar registers only when
  `isMobile && isActive && effectiveToolbar != null`;
- more than one enabled surface for one role is a programming defect;
- registration attaches owned `focusin` / `focusout` listeners;
- registration and mobile-mode entry reconcile `document.activeElement`;
- first focus entry acquires one `chrome-focus` lock;
- movement within the same surface retains it;
- leaving or unregistering releases it exactly once;
- registration cleanup removes listeners and releases the owned lock.

Delete component-owned `releaseFocusLockRef` state and focus handlers from
`MobilePaneBar` and `PaneShell`. `NexusButton` receives no duplicate focus-lock
implementation.

Action-menu and domain locks remain separate and reference-counted.

### Nexus presentation

`NexusButton` renders a stable outer wrapper and one inner button:

- The wrapper owns fixed positioning, safe-area/player offset, layout footprint,
  and `MobileViewportProvider` obstruction registration.
- The wrapper is untransformed and noninteractive (`pointer-events: none`); the
  inner button restores normal pointer interaction.
- The inner button registers as `NexusControl`, consumes `motionPhase`, and owns
  visual and interactive styling.
- Apply the shared `--mobile-chrome-collapse` only to the inner button.
- Map `0` to current geometry.
- Map `1` to a downward translation clearing its height, safe-area/player
  offset, and existing bottom gap.
- Transition only during `Settling`, using existing duration/easing.
- Only `Hidden` sets motion-owned element-level `aria-hidden` and `inert` on the
  inner button.
- `switchboardOpen` retains its existing independent hidden/inert behavior.
- AppBar remains the sole interpolation sample and `transitionend` owner.

The wrapper's obstruction registration remains active while Switchboard is
closed. Resize, player-clearance RAF, or re-registration while the inner button
is partially or fully translated must measure the same wrapper rectangle.
`--mobile-content-bottom-clearance` stays stable, including while Nexus is
visually hidden.

### Preserved Android shell

The Android wrapper keeps its permanent native black status-bar protection view
behind forced-light system icons. It remains sized from the status-bar inset and
outside the web chrome contract; WebView remains edge-to-edge. The native
status-bar color remains black on pre-enforced-edge-to-edge Android.

### Motion policy

Retain without a second path:

| Rule | Value |
| --- | --- |
| top pin | `8px` |
| direction-reversal dead zone | `8px` |
| collapse travel | `64px` |
| minimum delta | `1px` |
| idle settle | `120ms`, nearest endpoint |
| reduced motion | pinned visible |

All registered surfaces receive the same normalized progress in the same RAF.
Tracking is transform-only. Route/source/mobile-mode changes reset visible.

## Interaction rules

- A primary pointer interaction in the reader hands stale registered-chrome
  focus to the document before scrolling.
- Actual keyboard focus in any registered surface pins all chrome visible.
- Reader restore, selection, highlight navigation, mobile secondary, library
  picker, and action menu retain their existing locks.
- Pointer handoff never releases those non-focus locks.
- Focus entering partially visible chrome reveals it.
- Hidden controls are not focusable or announced. AppBar and PaneToolbar apply
  motion-owned `aria-hidden` / `inert` to control clusters, never their
  registered roots. NexusControl applies them to the whole inner button.
- Pane identity, including any title heading, remains outside motion-hidden
  subtrees at every progress value.
- Reduced motion remains visible; do not introduce a snap-hide variant.

## Accepted limitations

- Pointer events inside cross-origin iframes, such as transcript video, do not
  reach the reader-layout capture path. They do not release stale
  `chrome-focus`; another reader interaction must do so.
- A hidden Nexus is not a one-tap Switchboard entrance. Upward reader scroll
  reveals it; no separate edge gesture or reveal control is added.
- Reaching the document end does not reveal chrome without upward scroll.
- Pane activation may focus and re-pin chrome. The next primary reader pointer
  interaction releases that focus by design.
- Supported Chromium and Android WebView must support the typed
  `--mobile-chrome-collapse` property. No fallback is added. A settle failure in
  either supported target blocks release.

## Hard-cut deletion

Delete in the same change:

- `releaseMobileChromeFocus` and every E2E call that manually blurs chrome;
- component-owned chrome-focus refs, handlers, and cleanup in `MobilePaneBar`
  and `PaneShell`;
- the two-role-only `MobileChromeSurfaceRole` contract;
- last-write-wins or unconditional desktop `PaneToolbar` registration;
- direct obstruction registration on the transformed Nexus button;
- the two-surface prose in `docs/modules/workspace.md` and
  `docs/modules/reader-implementation.md`;
- any new or existing Nexus-only scroll listener, hidden boolean, threshold,
  progress value, transition owner, or compatibility alias encountered.

Do not retain flags, deprecated exports, fallbacks, dual focus policies, or
old/new tests.

## Files

Add:

- `docs/cutovers/mobile-reader-unified-scroll-chrome-hard-cutover.md`

Modify:

- `apps/web/src/lib/workspace/mobileChrome.tsx`
- `apps/web/src/lib/workspace/mobileChrome.test.tsx`
- `apps/web/src/components/appnav/MobilePaneBar.tsx`
- `apps/web/src/components/appnav/MobilePaneBar.test.tsx`
- `apps/web/src/components/appnav/AppNav.module.css`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/workspace/PaneShell.module.css`
- `apps/web/src/__tests__/components/PaneShell.test.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.test.tsx`
- `apps/web/src/components/switchboard/NexusButton.tsx`
- `apps/web/src/components/switchboard/switchboard.module.css`
- `apps/web/src/components/launcher/Launcher.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.ac4.test.tsx`
- `e2e/tests/pane-chrome.spec.ts`
- `docs/architecture.md`
- `docs/modules/workspace.md`
- `docs/modules/reader-implementation.md`
- `docs/cutovers/mobile-reader-scroll-linked-chrome-hard-cutover.md`

`docs/architecture.md` receives only the three-surface/stable-wrapper ownership
sentence. Do not modify `mobileChromeMotion.ts`, reader progress/completion,
`WorkspaceHost.tsx`, player, `MobileViewportProvider`, or Android production
code unless a failing acceptance criterion proves the listed boundary
insufficient.

## Implementation order

1. Red: replace manual E2E blur with reader pointer interaction; prove current
   chrome remains pinned.
2. Centralize active-mobile surface focus ownership, breakpoint reconciliation,
   and pointer handoff.
3. Split Nexus into stable obstruction wrapper plus inner `NexusControl`.
4. Replace affected component tests with behavior assertions.
5. Delete superseded paths and update current docs.
6. Run focused gates and primary Android touch acceptance.

## Acceptance criteria

1. From normal mobile-first activation, one downward touch gesture retreats the
   app bar and Nexus without caller- or test-owned manual blur.
2. Text, EPUB, transcript, and PDF drive identical chrome behavior from their
   real scrollports.
3. AppBar, pane toolbar when present, and Nexus expose equal progress/phase in
   one frame and fully clear their respective viewport edges at `1`.
4. Chrome stays hidden without upward reader scroll; upward reversal reveals
   after `8px`; top arrival reveals fully.
5. After focusing AppBar, pane-toolbar, or Nexus controls, a primary reader
   pointer interaction releases only `chrome-focus` and permits retreat.
6. A desktop-multipane to mobile transition retains only the active mobile
   PaneToolbar registration. Existing focus inside it pins chrome until reader
   pointer handoff.
7. Keyboard focus, menu, selection, restore, secondary-surface, and picker locks
   keep all chrome visible.
8. Hidden control clusters are inert and absent from accessibility navigation;
   pane identity remains represented and no focused element moves offscreen.
9. Nexus clears the viewport above safe area and an active player. Resizing or
   player remeasurement while `Hidden` does not change its obstruction rectangle
   or `--mobile-content-bottom-clearance`.
10. Reader layout, selection, resume state, completion state, and `scrollTop` do
    not change because chrome moves.
11. Window, workspace, non-reader, desktop, and global-player scroll/motion are
    unchanged.
12. Active tracking queues at most one transform-only write per frame and does
    not re-render reader bodies.
13. Android retains its black status-bar protection, edge-to-edge WebView, and
    display-cutout/safe-area behavior.
14. The predecessor is marked superseded and no runtime/test compatibility
    residue remains.

## Required proof

- Pure reducer tests remain green; do not duplicate them.
- Provider tests cover three-surface synchronization, centralized focus-lock
  lifecycle, one enabled surface per role, mode-entry focus reconciliation,
  pointer handoff, unregister cleanup, resets, and reduced motion.
- Component tests cover active-mobile PaneToolbar registration, Nexus
  partial/hidden accessibility, Switchboard-open composition, and stable
  clearance after a hidden-phase resize.
- Workspace coverage flips a focused multi-pane desktop layout to mobile and
  proves that the active toolbar alone owns focus.
- Real-stack E2E begins with normal mobile focus, performs reader pointer intent
  plus scroll without manual blur, and proves retreat/reveal for text and PDF.
- Existing EPUB/transcript real-scroll-owner coverage remains green.
- Manual primary Android WebView smoke covers touch drag, inertial fling,
  upward reversal, Options, Nexus/Switchboard, selection, active player, and
  reduced motion, status-bar protection, display cutout, and safe area.

Tests assert visible behavior. Do not assert private refs, listener counts, or
direct callback calls where the real composed surface is available.

## Residue and verification gates

These must return no matches:

```bash
rg "releaseMobileChromeFocus" e2e/tests/pane-chrome.spec.ts
rg "releaseFocusLockRef" \
  apps/web/src/components/appnav/MobilePaneBar.tsx \
  apps/web/src/components/workspace/PaneShell.tsx \
  apps/web/src/components/switchboard/NexusButton.tsx
rg -F 'MobileChromeSurfaceRole = "AppBar" | "PaneToolbar";' \
  apps/web/src/lib/workspace/mobileChrome.tsx
```

Focused verification:

```bash
cd apps/web
bun run test:unit -- src/lib/workspace/mobileChromeMotion.test.ts
bun run test:browser -- \
  src/lib/workspace/mobileChrome.test.tsx \
  src/components/appnav/MobilePaneBar.test.tsx \
  src/__tests__/components/PaneShell.test.tsx \
  src/components/workspace/WorkspaceHost.test.tsx \
  src/components/launcher/Launcher.test.tsx \
  'src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx' \
  'src/app/(authenticated)/media/[id]/MediaPaneBody.ac4.test.tsx'
bun run typecheck
bun run lint:css-tokens
bunx eslint \
  src/lib/workspace/mobileChrome.tsx \
  src/lib/workspace/mobileChrome.test.tsx \
  src/components/appnav/MobilePaneBar.tsx \
  src/components/appnav/MobilePaneBar.test.tsx \
  src/components/workspace/PaneShell.tsx \
  src/__tests__/components/PaneShell.test.tsx \
  src/components/workspace/WorkspaceHost.test.tsx \
  src/components/switchboard/NexusButton.tsx \
  src/components/launcher/Launcher.test.tsx \
  'src/app/(authenticated)/media/[id]/MediaPaneBody.tsx' \
  'src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx' \
  'src/app/(authenticated)/media/[id]/MediaPaneBody.ac4.test.tsx' \
  --max-warnings 0
cd ../..
PLAYWRIGHT_ARGS='tests/pane-chrome.spec.ts --project=chromium' make test-e2e
git diff --check
```

## Non-goals

- per-surface timing, progress, or visibility policy;
- velocity/fling prediction, springs, `scrollend`, or `ScrollTimeline`;
- animated/dynamic obstruction clearance;
- persistent visibility state or user tuning;
- Nexus scale, fade, parallax, or gesture shortcuts;
- generic focus manager or generic hide-on-scroll abstraction;
- unsupported-browser fallback or general settle/transition-cancellation repair;
- redesign of pane headers, Switchboard, reader layout, or mobile navigation.

## Final state

Mobile reading has one scroll-derived chrome capability with three semantic
presentation roles. Registered surfaces own focus through the provider. A
primary reader pointer interaction releases stale chrome focus without weakening
keyboard or overlay protection. Only active mobile surfaces register. Nexus's
stable outer wrapper preserves obstruction geometry while its inner control
shares visual progress. The Android status-bar contract remains explicit. The
masked E2E blur path, duplicate focus handlers, two-surface contract, direct
transformed obstruction, and every fallback or compatibility path are absent.
