# Mobile Reader Unified Scroll Chrome Hard Cutover

Status: SPEC — implementation and device acceptance required

Type: hard cutover

Date: 2026-07-30

No blocking product question remains. The decisions below are locked.

**Subsequent-cut ordering:** this cutover lands first, followed by
[`mobile-nexus-control-hard-cutover.md`](mobile-nexus-control-hard-cutover.md).
Its `NexusButton` and `MobileViewportProvider` verify-unchanged instructions
apply while executing this prerequisite only; that follow-up may change its
explicitly owned slice after preserving this document's mobile-chrome and
stable-wrapper contracts.

Follow all of [`docs/rules/`](../rules/index.md), especially cleanliness,
simplicity, frontend, correctness, timing, and testing.

## Decision

Repair the existing mobile-chrome owner; do not replace it.

One active reader scrollport publishes raw scroll state to
`MobileChromeProvider`. The provider alone owns focus handoff, visibility locks,
continuous progress, settlement, and the three synchronized presentation
surfaces:

```text
active real reader scrollport
  └─ useMobileChromeReaderScrollport
       └─ MobileChromeProvider
            ├─ mobileChromeMotion reducer
            ├─ visible-lock registry
            ├─ one RAF writer
            └─ --mobile-chrome-collapse
                 ├─ AppBar retreats up
                 ├─ PaneToolbar retreats up
                 └─ NexusControl retreats down
```

This document replaces the prior “implemented and verified” claim. The
reported production behavior is failed: Web, EPUB, transcript, and PDF chrome
remain visible. Prior synthetic proof and waived device gates are not
acceptance.

## Product principle

Attention without disorientation:

- sustained forward reading retreats nonessential chrome;
- a short reverse movement restores commands;
- interaction and accessibility needs pin commands visible;
- content geometry and the reader's place never move with chrome;
- animation is an output of semantic state, never its owner.

This follows the durable pattern used by iOS swipe-hiding bars, Android
enter-always app bars, and Chromium browser controls: one continuous policy,
direction-aware restoration, stable layout, and synchronized surfaces.
References: [UIKit](https://developer.apple.com/documentation/uikit/uinavigationcontroller/hidesbarsonswipe),
[Android Compose](https://developer.android.com/develop/ui/compose/components/app-bars),
[Chromium](https://chromium.googlesource.com/chromium/src/+/main/docs/ui/android/browser_controls.md).

## Goals

1. One ordinary forward mobile gesture retreats AppBar, optional PaneToolbar,
   and NexusControl in every supported reader.
2. One active real scrollport exists per rendered reader.
3. Route activation cannot permanently pin moving chrome.
4. Chrome sampling is independent of progress, activity, Find, and restore
   persistence.
5. Reverse scroll, top arrival, or a legitimate lock restores chrome.
6. Tests exercise observable behavior through real owners and real input.
7. The change reduces code paths and deletes predecessor machinery.

## Non-goals

- No new motion model or tuning of the existing `8px` top pin, `8px` reversal
  dead zone, `64px` travel, `1px` delta floor, or `120ms` idle settle.
- No Auto/Pinned preference, tap-to-hide/toggle mode, velocity prediction, ML,
  native bridge, CSS Scroll Timeline, or generic application scroll service.
- No player motion, viewport-clearance redesign, reader progress redesign,
  backend/API/database/persistence, analytics, or compatibility flag.
- No desktop or non-reader scroll behavior change.

## Target behavior

| Situation | Required result |
| --- | --- |
| Forward reader scroll | All registered chrome tracks continuously toward hidden |
| Reverse reader scroll | Reveal after the existing reversal dead zone |
| Reader at top or content not scrollable | Fully visible |
| Route, source, reading unit, or mobile-mode change | Fully visible and rebaselined from the active scrollport |
| Actual focus inside chrome | Fully visible until reader pointer intent or focus exit |
| Find, menu, selection, restore, navigation, sheet, or picker interaction | Fully visible through an explicit owned lock |
| Reduced motion | Fully visible |
| Unhandled blank-canvas tap while hidden | Reveal fully; never hide or activate a covered control |
| Tracking, settling, or hidden | Control clusters are inert, not hit-testable, and absent from accessibility navigation |
| Chrome movement | Reader dimensions, `scrollTop`, selection, progress, and final-content clearance remain unchanged |

Nexus is transient global chrome, not an always-present FAB. It may retreat
fully because reverse reader scroll and blank-canvas tap are guaranteed recovery
gestures. No interactive sliver remains.

## Final ownership

### Motion and presentation

- `mobileChromeMotion.ts` remains the sole pure reducer.
- `MobileChromeProvider` remains the sole stateful policy owner.
- `MobilePaneBar`, `PaneShell`, and `NexusButton` remain presentation-only
  consumers of one collapse value and phase.
- `MobileViewportProvider` continues measuring the stable, untransformed Nexus
  wrapper. Player/safe-area/content clearance stays stable while the inner
  control moves.
- CSS owns transforms and retreat distances. TypeScript owns state, locks,
  source lifecycle, and accessibility phase.
- Controls are interactive only in `Visible` or `Pinned`. Focus can never move
  into clipped chrome; focus acquired while visible synchronously pins all
  surfaces before any retreat.

### Scroll ownership

- Web and EPUB: `TextDocumentReader`'s `document-viewport`.
- Transcript: the outer `document-viewport`, including playback, description,
  and segments.
- PDF: `PdfReader`'s viewer container.
- The nested transcript segment list is not a scrollport.
- Exactly one enabled reader scrollport may register. A second registration is
  a defect.

### Focus ownership

- Workspace activation focuses the stable `PaneShell` landmark, never AppBar or
  PaneToolbar.
- Registered chrome roots are not route-focus targets.
- Focus entering a real control inside registered chrome acquires one
  reference-counted `chrome-focus` lock.
- Primary pointer intent captured by the active reader scrollport blurs only a
  focused descendant of registered chrome. Normal `focusout` releases the lock.
- Pointer handoff never deletes menu, Find, selection, restore, navigation,
  sheet, picker, or reduced-motion state.

## Capability contract

Hard-cut the public scroll commands into one owned registration hook:

```ts
interface MobileChromeReaderScrollportInput {
  readonly sourceKey: string;
  readonly enabled: boolean;
}

function useMobileChromeReaderScrollport<T extends HTMLElement>(
  input: MobileChromeReaderScrollportInput,
): RefCallback<T>;

type MobileChromeVisibleLockReason =
  | "reader-restore"
  | "reader-positioning"
  | "pdf-selection"
  | "text-selection"
  | "highlight-navigation"
  | "pane-find"
  | "mobile-secondary"
  | "library-picker"
  | "action-menu"
  | "chrome-focus";

interface MobileChromeVisibleLocks {
  acquire(reason: MobileChromeVisibleLockReason): () => void;
}

function useMobileChromeVisibleLocks(): MobileChromeVisibleLocks;
```

Rules:

- `sourceKey` is opaque, session-local, never parsed or persisted, and changes
  with the displayed route, EPUB reading unit, or rendered-layout generation.
- The element owner assigns the returned callback ref, composed locally with
  any existing owner ref. Node identity, late mount, replacement, enable flips,
  StrictMode replay, and unmount all register/unregister exactly once.
- `enabled` means active mobile pane plus mounted readable format.
- Registration attaches the passive `scroll` listener, primary `pointerdown`
  focus handoff, and reveal-only blank-canvas click handling to the actual
  element.
- Registration samples current geometry immediately.
- Raw samples continue updating the baseline while pinned. Lock release,
  mobile entry, and source replacement rebaseline from the live element so a
  programmatic jump cannot become future reading intent.
- Every code-owned scroll/reflow/zoom/anchor mutation holds an existing semantic
  lock or `reader-positioning` through its final layout sample. Release
  rebaselines before genuine input is accepted.
- Blank-canvas reveal requires a primary unmodified click left unhandled after
  bubbling, no live selection, and no interactive/annotation ancestor. Native
  click suppression distinguishes a drag. Decide in a microtask after bubbling;
  do not prevent propagation or invent a gesture recognizer.
- The hook does not write progress, activity, completion, URL, history, or
  persistence.
- Locks are idempotently releasable and release on owner unmount.
- `Pinned` is valid only for reduced motion or at least one explicit lock.

Delete these APIs with no aliases:

```ts
startReaderScroll
updateReaderScroll
beginReaderPointerInteraction
usePaneMobileChromeController
```

`MobileChromeScrollSnapshot` becomes reducer/provider-private.
`acquireVisibleLock` is removed from `useMobileChrome`; every lock caller uses
the single `useMobileChromeVisibleLocks` capability.

## Intra-system composition

### Web and EPUB

`TextDocumentReader`, the element owner, composes the returned callback ref with
`textViewportRef`. Chrome sees every native scroll event independently of
`scheduleTextViewportCapture`. Preserve that component's existing
progress/activity/trusted-intent listener and callbacks. Find-preview leases,
EPUB adoption suppression, reflow generations, activity, and progress may fence
their own writes only.

Pane Find owns `pane-find` for its entire open lifecycle. Preview and Return
therefore rebaseline chrome without collapsing it.

### Transcript

Remove `max-height` and `overflow-y` from `.transcriptSegments`. The segment
list remains a semantic region and Find target, but `scrollIntoView` moves the
outer document viewport. Delete the outer-listener/inner-scroller split.

### PDF

Replace `PdfReader`'s bespoke start/update listener with the shared scrollport
hook. Keep PDF selection and restore locks.

### Route focus

Give the `PaneShell` section a stable programmatic-focus marker and
`tabIndex={-1}`. Rename the mobile activation path from chrome focus to pane
landmark focus. Add the distinct resolver to `paneDom.ts`; do not add a raw
workspace selector or change `findPaneChromeFocusTarget`, which still owns
desktop and explicit return-to-command focus.

Remove the mobile AppBar focus marker and root `tabIndex`. AppBar descendants
remain normally keyboard-focusable.

## Hard-cut deletion

Delete in the same implementation:

- all per-format mobile-chrome publication listeners and wrapper callbacks;
- the reader-layout-wide pointer handoff;
- the nested transcript overflow;
- mobile route focus on AppBar/PaneToolbar;
- the four deleted APIs and all test mocks/assertions of them;
- `acquireVisibleLock` on `useMobileChrome` and every duplicate lock entrypoint;
- pane-chrome E2E helpers that set `scrollTop`, call `scrollTo`, dispatch
  synthetic `scroll`, or manually blur focus;
- the superseded
  `mobile-reader-scroll-linked-chrome-hard-cutover.md`;
- stale two-surface, waived-gate, or “verified” prose in current docs;
- any threshold boolean, Nexus-only motion state, compatibility alias, or
  duplicate lock/source owner found during the cut.

No feature flag, fallback path, deprecated export, dual publisher, or old/new
test survives.

## Files

Primary:

- `apps/web/src/lib/workspace/mobileChrome.tsx`
- `apps/web/src/lib/workspace/mobileChromeMotion.ts`
- `apps/web/src/lib/workspace/paneDom.ts`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/appnav/MobilePaneBar.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.tsx`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/components/libraries/LibraryPlacementOverlay.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`

Behavior proof:

- `apps/web/src/lib/workspace/mobileChrome.test.tsx`
- `apps/web/src/components/appnav/MobilePaneBar.test.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.test.tsx`
- `apps/web/src/__tests__/components/PaneShell.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.ac4.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.test.tsx`
- `apps/web/src/__tests__/components/PdfReader.test.tsx`
- `apps/web/src/__tests__/components/Conversation.test.tsx`
- `apps/web/src/components/libraries/LibraryPlacementOverlay.test.tsx`
- `apps/web/src/components/nexus/Nexus.test.tsx`
- `e2e/playwright.config.ts`
- `e2e/tests/mobile-reader-chrome.spec.ts`
- `e2e/tests/pane-chrome.spec.ts`
- `.github/workflows/ci.yml`

Docs:

- `docs/modules/app-navigation.md`
- `docs/modules/workspace.md`
- `docs/modules/reader-implementation.md`
- `docs/modules/reader-design-rationale.md`
- this document

Verify unchanged unless an acceptance failure proves otherwise:

- `apps/web/src/components/switchboard/NexusButton.tsx`
- `apps/web/src/lib/mobileViewport/MobileViewportProvider.tsx`
- global player code
- Android production and instrumentation code
- backend, migrations, and API contracts

## Implementation order

1. Red: reproduce permanent visibility with normal mobile activation and real
   input; record active element, reduced-motion value, lock reasons, source,
   scrollTop, phase, progress, and computed transforms.
2. Move mobile route focus to the pane landmark; delete mobile chrome-root
   focusability.
3. Add the callback-ref scrollport registration hook, focus handoff, and
   reveal-only blank tap; migrate Web/EPUB, transcript, and PDF; delete the old
   commands/listeners.
4. Remove transcript nested overflow and decouple text/EPUB sampling from
   progress/Find fences.
5. Add Pane Find/code-owned-positioning locks and release-time rebaseline.
6. Replace mock-call tests with composed behavior tests; restore Nexus/player
   clearance coverage under `Nexus.test.tsx`.
7. Delete residue, update canonical docs, then run the proof ladder.

## Residue gates

```bash
! rg -n 'PaneMobileChromeController|startReaderScroll|updateReaderScroll|beginReaderPointerInteraction|usePaneMobileChromeController' apps/web/src e2e
! rg -n 'acquireVisibleLock' apps/web/src
! rg -n 'MobileChromeScrollSnapshot' apps/web/src --glob '!lib/workspace/mobileChromeMotion.ts' --glob '!lib/workspace/mobileChromeMotion.test.ts'
! rg -n 'scrollTop\\s*=|\\.scrollTo\\(|dispatchEvent|activeElement.*blur' e2e/tests/mobile-reader-chrome.spec.ts
! rg -U '\\.transcriptSegments\\s*\\{[^}]*(max-height|overflow-y)' 'apps/web/src/app/(authenticated)/media/[id]/page.module.css'
! test -e docs/cutovers/mobile-reader-scroll-linked-chrome-hard-cutover.md
```

## Acceptance criteria

1. From normal mobile activation, one forward touch drag retreats AppBar,
   PaneToolbar when present, and Nexus in Web, EPUB, transcript, and PDF.
2. A short reverse drag or unhandled blank-canvas tap reveals all three;
   reaching the top reveals fully.
3. Real input proves proportional intermediate motion across the `64px`
   travel, the `8px` reversal dead zone, endpoint settlement, and interruption
   of an in-flight settle. All surfaces remain synchronized and clear their
   viewport edge at hidden.
4. The active reader has exactly one scrollport; transcript segments scroll the
   outer viewport.
5. Route activation leaves focus on the stable pane landmark and acquires no
   visible lock.
6. Focusing a chrome control pins visible; primary reader pointer intent
   releases only `chrome-focus` and permits retreat.
7. Find preview/Return, restore, reflow, zoom, anchor/highlight navigation,
   selection, menus, secondary sheets, and picker actions never collapse chrome
   or corrupt the next reader delta.
8. Reduced motion pins visible. Disabling it rebaselines and the next gesture
   works.
9. Source, route, EPUB unit, and desktop/mobile transitions reset visible
   without consuming the first real gesture.
10. Short/non-overflowing content remains visible.
11. Partially or fully retreated controls are inert, unclickable, and absent
    from keyboard and screen-reader navigation; pane identity remains
    announced and focus is never obscured.
12. Chrome motion changes no reader geometry, cursor, selection, progress,
    completion, or last-line/player/safe-area clearance.
13. No reader-body React render is required per scroll frame; writes are
    transform-only and RAF-coalesced.
14. No deleted API, duplicate publisher, nested transcript scrollport,
    compatibility path, or stale test/doc claim remains.

## Required proof

- Pure reducer tests for direction, hysteresis, top, short content, pin/unpin,
  proportional progress, settle, and settle interruption remain green.
- Browser component tests use the real provider, scrollport, surfaces, focus,
  locks, and accessibility state. They do not mock internal chrome APIs.
- Provider proof covers late mount/node replacement, enable/source changes,
  StrictMode replay, mobile-entry focus reconciliation, focus movement within a
  surface, overlapping locks, lock during Tracking/Settling, final-release
  rebaseline, disable/unmount cleanup, and reduced motion.
- Add a `mobile-chrome` Playwright project based on `devices["Pixel 7"]`,
  selected by `@mobile-chrome`. A shared Chromium CDP touch helper drives
  incremental trusted touch input and samples computed transforms during the
  gesture. Direct scroll mutation, synthetic scroll events, and manual blur are
  forbidden in chrome acceptance.
- The real-stack matrix covers all four formats plus Find and active-player
  composition.
- CI's default E2E job runs `mobile-chrome` and retains trace, screenshot, and
  video on failure.
- Manual authenticated primary-device Android WebView smoke uses the same
  real-stack seed IDs and covers all four formats, touch drag, inertial fling,
  reverse/tap reveal, selection, menu, Find, player, reduced motion, TalkBack,
  switch access, keyboard, rotation, cutout, and safe area. Do not build a
  test-only auth bridge or local-HTML substitute.
- One authenticated physical iOS Safari article smoke covers touch/tap reveal,
  VoiceOver recovery/focus, dynamic browser chrome, IME, rotation, and safe
  area. Do not repeat the four-format matrix on iOS.
- Typecheck, scoped lint, CSS-token lint, E2E TypeScript, residue search,
  `git diff --check`, and the relevant CI jobs pass.

Focused real-stack command:

```bash
PLAYWRIGHT_ARGS='tests/mobile-reader-chrome.spec.ts --project=mobile-chrome' make test-e2e
```

Do not mark this cutover implemented or verified until production-stack browser
and physical-device gates pass. No gate waiver.
