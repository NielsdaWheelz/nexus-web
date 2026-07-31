# Mobile Reader Unified Scroll Chrome Hard Cutover

Status: APPROVED SPEC — implementation and device acceptance required

Type: hard cutover

Date: 2026-07-30

No blocking product question remains. The decisions below are locked.

**Subsequent-cut ordering:** this cutover lands first, followed by
[`mobile-nexus-control-hard-cutover.md`](mobile-nexus-control-hard-cutover.md),
and then
[`mobile-nexus-full-screen-task-hard-cutover.md`](mobile-nexus-full-screen-task-hard-cutover.md).
Its `NexusButton` and `MobileViewportProvider` verify-unchanged instructions
apply while executing this prerequisite only; each named follow-up may change
its explicitly owned slice after preserving this document's mobile-chrome and
stable-wrapper contracts.

Follow all of [`docs/rules/`](../rules/index.md), especially cleanliness,
simplicity, frontend, correctness, and timing, plus the Nexus-owned
[`testing-standards.md`](../local-rules/testing-standards.md).

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

## Failure model and red contract

The repair targets five code-verified defects:

1. Mobile route activation focuses AppBar and acquires `chrome-focus`; current
   E2E treats the resulting `Pinned` phase as success.
2. `chrome-focus` release trusts focus events. The provider does not derive the
   lock bidirectionally from the live active element after control replacement.
3. Transcript gestures move nested `.transcriptSegments`, while chrome samples
   the outer viewport. Transcript Find also captures, positions, and restores
   the nested list directly.
4. Web/EPUB chrome publication is inside progress/Find/reflow fences, so native
   reader input can be ignored for chrome.
5. Existing chrome E2E mutates `scrollTop`, dispatches synthetic events, and
   runs in resized Desktop Chrome; it does not prove trusted mobile input.

Before green implementation, add the smallest failing browser/component proof
for each observable defect and one trusted-input Playwright reproduction of the
all-format symptom. Record active element, reduced-motion state, source,
scrollport geometry, phase, collapse progress, and computed transforms. Use no
production-only diagnostic API. Do not claim one production root cause until
the trusted reproduction identifies it; the hard cut repairs every defect
above regardless.

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
- No desktop transcript-layout or non-reader scroll behavior change.
- No screen-reader detector, persistent preference, foldable-specific layout,
  or PWA-only behavior.

## Target behavior

| Situation | Required result |
| --- | --- |
| Forward reader scroll | All registered chrome tracks continuously toward hidden |
| Reverse reader scroll | Reveal after the existing reversal dead zone |
| Reader at top or content not scrollable | Fully visible |
| Route, source, reading unit, or mobile-mode change | Fully visible and rebaselined from the active scrollport |
| Actual focus inside chrome | Fully visible while the live active element is inside registered chrome |
| Find, menu, selection, restore, navigation, sheet, or picker interaction | Fully visible through an explicit owned lock |
| Reduced motion | Fully visible |
| Pointer tap on unhandled blank canvas while hidden | Reveal fully; never hide or activate a covered control |
| Keyboard or AT reading navigation | Same direction/top policy as other real scroll input |
| Interrupted or eventless settle | Provider reaches a deterministic interactive terminal phase |
| Tracking, settling, or hidden | Entire moving surfaces are inert, not hit-testable, and absent from accessibility navigation |
| IME, rotation, or safe-area change | No reader jump; chrome remains synchronized and live geometry is rebaselined |
| Chrome movement | Reader dimensions, `scrollTop`, selection, progress, and final-content clearance remain unchanged |

Nexus is transient global chrome, not an always-present FAB. It may retreat
fully because reverse scroll and top navigation work for pointer, keyboard, and
AT input. Blank-canvas tap is supplementary pointer recovery, not the
accessibility contract. No interactive sliver remains.

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
- The provider owns a fenced settle generation, completion deadline, and
  `transitionrun`/`transitionend`/`transitioncancel` inputs. A surface's
  `transitionrun` binds it to the current generation; end/cancel from an
  invalidated generation cannot finish or restart a newer settle. AppBar is not
  the completion clock. Derive the deadline from computed transition
  delay/duration rather than duplicating a CSS timing constant. Cancellation
  samples live progress; missing events cannot leave `Settling` stuck.
- AppBar, PaneToolbar, and the inner Nexus control are interactive only in
  `Visible` or `Pinned`. Their entire moving roots are `inert`, non-hit-testable,
  and `aria-hidden` in `Tracking`, `Settling`, and `Hidden`.
- Pane identity remains exposed by the stable `PaneShell` landmark outside the
  moving roots. Focus acquired inside visible chrome synchronously pins all
  surfaces before retreat.

### Scroll ownership

- Mobile Web and EPUB: `TextDocumentReader`'s `document-viewport`.
- Mobile transcript: the outer `document-viewport`, including playback,
  description, and segments.
- Mobile PDF: `PdfReader`'s viewer container.
- Mobile `.transcriptSegments` is not a scrollport. Desktop retains its current
  bounded segment-list scroll behavior.
- Exactly one enabled mobile reader scrollport may register, and the active
  pane has one `data-mobile-reader-interaction-root`. A duplicate is a defect.

### Focus ownership

- Workspace activation focuses the stable `PaneShell` landmark, never AppBar or
  PaneToolbar.
- Registered chrome roots are not route-focus targets.
- The provider owns exactly one derived `chrome-focus` lock. It exists iff the
  live, connected `document.activeElement` is inside registered chrome.
- Reconcile that lock on registration/unregistration, `focusin`, in a
  microtask after `focusout`, after registered-surface child replacement, and
  before reader pointer, click, keyboard, AT, or scroll input. Focus events are
  signals, not truth.
- Each surface registration owns one `childList`/`subtree` `MutationObserver`
  for replacement reconciliation and disconnects it on unregister.
- Primary pointer intent within the active pane's stable reader interaction
  root blurs only a focused descendant of registered chrome. It still works
  while the scrollport is loading, replaced, short, or absent.
- Pointer handoff never deletes menu, Find, selection, restore, navigation,
  sheet, picker, or reduced-motion state.
- Mobile return-to-command first pins/reveals chrome, then resolves and focuses
  a non-inert command; it falls back to the pane landmark. Synchronous
  return-focus APIs use the landmark, never a clipped or inert target.

### Recovery and assistive technology

- Do not infer or detect whether a screen reader is active.
- Real forward/reverse scrolling from touch, wheel, keyboard, switch access,
  TalkBack, or VoiceOver feeds the same reducer.
- Reverse scroll, top/Home navigation, and focus entering visible chrome are the
  non-pointer recovery paths. Blank-canvas reveal is pointer-only.

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
  | "action-menu";

interface MobileChromeVisibleLocks {
  acquire(reason: MobileChromeVisibleLockReason): () => void;
}

function useMobileChromeVisibleLocks(): MobileChromeVisibleLocks;

interface PaneChromeFocusReturn {
  focus(paneId: string): Promise<void>;
}

function usePaneChromeFocusReturn(): PaneChromeFocusReturn;

function composeRefs<T>(...refs: readonly Ref<T>[]): RefCallback<T>;

interface ReaderScrollCommands {
  setTop(scrollport: HTMLElement, top: number): void;
  adjustTop(scrollport: HTMLElement, delta: number): void;
  reveal(scrollport: HTMLElement, target: HTMLElement): void;
}

interface ReaderScrollPositioner {
  run(
    operation: (commands: ReaderScrollCommands) => void | Promise<void>,
  ): Promise<void>;
}

function useReaderScrollPositioner(): ReaderScrollPositioner;
```

Rules:

- `sourceKey` is opaque, session-local, never parsed or persisted, and changes
  only with semantic scroll identity: displayed route/document or EPUB reading
  unit. Reflow, lazy media, zoom, and geometry changes do not churn it.
- The element owner assigns the returned callback ref through the one shared
  `composeRefs` helper. That helper preserves React 19 callback-ref cleanup,
  clears object refs, runs callback cleanups once in reverse order, and does not
  assume React also calls the callback with `null`.
- Node identity, late mount, replacement, enable flips, StrictMode replay, and
  unmount register/unregister exactly once.
- `enabled` means active mobile pane plus mounted readable format.
- Registration attaches only scrollport-owned sampling and blank-canvas
  candidate handling to the actual element. Provider-level pointer capture is
  restricted to the active pane's `data-mobile-reader-interaction-root`.
- Registration samples current geometry immediately.
- Raw samples continue updating the baseline while pinned. Lock release,
  mobile entry, and source replacement rebaseline from the live element so a
  programmatic jump cannot become future reading intent.
- The provider RAF-coalesces scrollport/direct-content `ResizeObserver`,
  descendant `load`, `window.resize`, and `visualViewport.resize` signals into
  `RefreshGeometry`. Geometry refresh updates the live baseline while preserving
  synchronized presentation; it reveals only when the reader is now at top or
  non-scrollable. These signals never churn `sourceKey`.
- `paneScroll.ts` is the sole app-owned mutation boundary for reader
  `scrollTop`, `scrollTo`, and target revelation. Its `run` acquires
  `reader-positioning`, supplies the only mutation commands, holds through the
  final layout sample, and rebaselines before release. Transcript Find receives
  this capability as a dependency. `reveal` performs minimal nearest-edge
  movement inside the supplied scrollport. Browser/PDF.js-internal movement is
  not reimplemented.
- A scoped `no-restricted-syntax` rule permanently rejects direct reader
  `scrollTop` assignment and app calls to `scrollTo`/`scrollIntoView` outside
  `paneScroll.ts`; the residue gate proves the initial cut.
- Blank-canvas reveal requires a primary unmodified click, no drag-suppressed
  native click, no live selection, and no handled target. `isInteractiveTarget`
  is extracted from the player shortcut precedent and shared; reader
  annotation/highlight owners add `data-reader-tap-handled="true"`. Embedded
  browsing contexts such as `iframe` are interactive even though their clicks
  cannot bubble into the parent document.
- A passive focusable reading surface may opt into
  `data-reader-tap-reveal-surface="true"`. Blank-tap adjudication uses that
  surface as the exclusive interactive boundary: its own focusability and
  passive descendants do not suppress reveal, while nested links, controls,
  handled annotations, and live selection still do. `PdfReader` assigns the
  marker to each rendered PDF.js text layer from `textlayerrendered`; never
  infer this contract from vendor classes, remove the layer's focusability, or
  manufacture layout gutters.
- The scrollport's native click listener installs a one-shot `window` bubble
  listener during dispatch. It reveals only if propagation reaches `window`,
  `defaultPrevented` is false, and neither target contract matches. Remove the
  listener after the current task if propagation stopped. Do not decide in a
  target microtask, prevent propagation, or invent a gesture recognizer.
- Blank tap is a capability of an actual passive reading surface, not a
  fabricated per-format guarantee. Web, EPUB, and PDF expose one. Transcript's
  visible body is an embedded player, source link, and segment buttons, so
  those handled targets stay non-revealing; reverse scroll and top navigation
  remain its recovery paths.
- The hook does not write progress, activity, completion, URL, history, or
  persistence.
- Locks are idempotently releasable and release on owner unmount.
- `chrome-focus` and the transient `focus-return` lock are provider-private.
  `Pinned` is valid only for reduced motion or at least one live public/private
  lock.
- `PaneChromeFocusReturn.focus` acquires the transient lock, waits for
  interactive chrome, focuses the resolved command or pane landmark, reconciles
  `chrome-focus`, then releases. It never focuses an inert node or leaves focus
  on `<body>`.

Delete these APIs with no aliases:

```ts
startReaderScroll
updateReaderScroll
beginReaderPointerInteraction
usePaneMobileChromeController
```

`MobileChromeScrollSnapshot` becomes reducer/provider-private.
`acquireVisibleLock` is removed from `useMobileChrome`; every lock caller uses
the single `useMobileChromeVisibleLocks` capability. `finishSettle` is removed
from presentation context; registered surface events feed the provider
directly.

## Intra-system composition

### Web and EPUB

`TextDocumentReader`, the element owner, composes the returned callback ref with
`textViewportRef`. Chrome sees every native scroll event independently of
`scheduleTextViewportCapture`. Preserve that component's existing
progress/activity/trusted-intent listener and callbacks. Find-preview leases,
EPUB adoption suppression, reflow generations, activity, and progress may fence
their own writes only.

Pane Find owns `pane-find` for its entire open lifecycle. Preview and Return
use the positioning boundary and therefore rebaseline chrome without
collapsing it.

### Transcript

In the mobile media query, remove the `50vh`/`50dvh` cap and set
`.transcriptSegments` to unbounded/non-scrolling. Keep the desktop `320px`
bounded scroller unchanged.

`transcriptPaneFind.ts` receives the active layout's scroll owner and
`ReaderScrollPositioner`. Rename its origin from segment-list scroll position
to scroll-owner position. Preview, failure restoration, and Return use the
positioner against the outer viewport on mobile and the segment list on
desktop. The segment list remains the semantic region and match owner; do not
use browser `scrollIntoView` to choose an ancestor implicitly.

### PDF

Replace `PdfReader`'s bespoke start/update listener with the shared scrollport
hook. Route its app-owned restore, zoom, Find, and anchor scroll writes through
the positioning boundary. Keep PDF selection and restore locks.

### Route focus

Give the `PaneShell` section a stable programmatic-focus marker and
`tabIndex={-1}`. Rename the mobile activation path from chrome focus to pane
landmark focus. Add the distinct landmark resolver to `paneDom.ts`; do not add a
raw workspace selector.

Remove the mobile AppBar focus marker and root `tabIndex`. AppBar descendants
remain normally keyboard-focusable.

Mobile imperative return-to-command callers use `usePaneChromeFocusReturn`.
APIs requiring a synchronous element receive the stable landmark resolver.
`findPaneChromeFocusTarget` remains the desktop/non-retreated command resolver;
no mobile caller may use it to target clipped chrome.

### Interaction and accessibility

`MediaPaneBody` marks one stable active-reader interaction root covering
loading, error, short-content, and mounted-scrollport states. Provider pointer
capture uses it only for focus handoff; it never publishes scroll state.

AppBar, PaneToolbar, and the inner Nexus button apply the same phase predicate
to `inert`, `aria-hidden`, and hit testing. The AppBar's visual title and links
retreat with the whole surface. The `PaneShell` landmark's separate accessible
name preserves pane identity.

## Hard-cut deletion

Delete in the same implementation:

- all per-format mobile-chrome publication listeners and wrapper callbacks;
- the reader-layout's direct pointer-handoff command;
- mobile nested transcript overflow; preserve the desktop rule;
- mobile route focus on AppBar/PaneToolbar;
- the four deleted APIs and all test mocks/assertions of them;
- `acquireVisibleLock` on `useMobileChrome` and every duplicate lock entrypoint;
- the AppBar-owned `finishSettle` callback; transition end/cancel ownership
  moves to the provider;
- direct mobile uses of `findPaneChromeFocusTarget`;
- app-owned reader scroll mutations outside `paneScroll.ts`;
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
- `apps/web/src/lib/ui/composeRefs.ts` (new)
- `apps/web/src/lib/ui/interactiveTarget.ts` (new extraction)
- `apps/web/src/lib/reader/paneScroll.ts` (new)
- `apps/web/src/lib/player/usePlayerKeyboardShortcuts.ts` (import-only
  extraction)
- `apps/web/eslint.config.mjs`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/workspace/MobileSecondaryPaneHost.tsx`
- `apps/web/src/components/appnav/MobilePaneBar.tsx`
- `apps/web/src/components/switchboard/NexusButton.tsx`
- `apps/web/src/components/nexus/useNexusController.ts`
- `apps/web/src/components/player/GlobalPlayerSurfaces.tsx`
- `apps/web/src/components/collections/CollectionRow.tsx`
- `apps/web/src/components/collections/ReadingSlateSection.tsx`
- `apps/web/src/lib/sharing/openOptions.ts`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptContentPanel.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/transcriptPaneFind.ts`
- `apps/web/src/app/(authenticated)/media/[id]/useMediaPaneFind.ts`
- `apps/web/src/app/(authenticated)/media/[id]/useEpubPaneFind.ts`
- `apps/web/src/app/(authenticated)/media/[id]/paneTextAnchor.ts`
- `apps/web/src/components/HtmlRenderer.tsx`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/components/pdfPaneFind.ts`
- `apps/web/src/components/libraries/LibraryPlacementOverlay.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`

Behavior proof:

- `apps/web/src/lib/workspace/mobileChromeMotion.test.ts`
- `apps/web/src/lib/workspace/mobileChrome.test.tsx`
- `apps/web/src/lib/ui/composeRefs.test.tsx` (new)
- `apps/web/src/lib/ui/interactiveTarget.test.tsx` (new)
- `apps/web/src/lib/reader/paneScroll.test.tsx` (new)
- `apps/web/src/lib/player/usePlayerKeyboardShortcuts.test.tsx`
- `apps/web/src/components/appnav/AppNav.test.tsx`
- `apps/web/src/components/appnav/MobilePaneBar.test.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.test.tsx`
- `apps/web/src/components/workspace/PaneShell.mobileChrome.browser.test.tsx`
- `apps/web/src/components/workspace/MobileSecondaryPaneHost.test.tsx`
- `apps/web/src/__tests__/components/PaneShell.test.tsx`
- `apps/web/src/__tests__/components/GlobalPlayerSurfaces.test.tsx`
- `apps/web/src/components/collections/CollectionRow.test.tsx`
- `apps/web/src/components/collections/ReadingSlateSection.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.ac4.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptContentPanel.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/transcriptPaneFind.test.ts`
- `apps/web/src/app/(authenticated)/media/[id]/transcriptPaneFind.browser.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/useMediaPaneFind.browser.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/useEpubPaneFind.browser.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/paneTextAnchor.test.ts`
- `apps/web/src/app/(authenticated)/media/[id]/paneTextAnchor.browser.test.tsx`
- `apps/web/src/__tests__/components/PdfReader.test.tsx`
- `apps/web/src/components/pdfPaneFind.browser.test.tsx`
- `apps/web/src/components/pdfPaneFind.pdfjs.browser.test.tsx`
- `apps/web/src/__tests__/components/Conversation.test.tsx`
- `apps/web/src/components/libraries/LibraryPlacementOverlay.test.tsx`
- `apps/web/src/components/nexus/Nexus.test.tsx`
- `e2e/playwright.config.ts`
- `e2e/tests/mobile-reader-chrome.spec.ts`
- `e2e/tests/pane-chrome.spec.ts`
- `e2e/tests/epub.spec.ts`
- `python/scripts/seed_e2e_data.py` (extend the shared transcript fixture; no
  product/backend contract change)
- `.github/workflows/ci.yml`

Docs:

- `docs/modules/app-navigation.md`
- `docs/modules/workspace.md`
- `docs/modules/reader-implementation.md`
- `docs/modules/reader-design-rationale.md`
- `docs/cutovers/mobile-reader-scroll-linked-chrome-hard-cutover.md` (delete
  after its Android shell contract moves to `docs/modules/workspace.md`)
- this document

Verify unchanged unless an acceptance failure proves otherwise:

- `apps/web/src/lib/mobileViewport/MobileViewportProvider.tsx`
- global player playback, motion, and viewport geometry
- desktop transcript segment-list geometry and Find behavior
- unrelated credits scrolling in `e2e/tests/authors.spec.ts`
- Android production and instrumentation code
- backend, migrations, and API contracts

## Implementation order

1. Red at its real boundary: add provider/component regressions for the five
   failure-model defects and a trusted mobile Playwright journey that reproduces
   the shipped all-format symptom.
2. Make provider lifecycle authoritative: derived focus reconciliation,
   provider-owned settle completion/cancellation, one scrollport registration,
   shared ref cleanup, and stable reader-root pointer handoff.
3. Move route focus to the pane landmark. Add reveal-before-focus return,
   migrate mobile return callers, and remove mobile chrome-root focusability.
4. Add the shared scrollport hook and `paneScroll.ts`; migrate Web/EPUB, PDF,
   and every app-owned reader positioning write; delete old commands/listeners.
5. Remove only mobile transcript nested overflow. Migrate transcript Find
   capture/preview/failure/Return to the active scroll owner and preserve
   desktop behavior.
6. Apply whole-surface inert/`aria-hidden`/hit-testing to AppBar, PaneToolbar,
   and Nexus; implement trusted window-bubble blank-tap adjudication.
7. Replace mock-call/synthetic chrome tests with owned behavior proof. Add the
   mobile project, CI/artifacts, duplicate-registration, settle, accessibility,
   focus-return, and no-per-frame-render proof.
8. Move the Android status-bar/edge-to-edge contract into
   `docs/modules/workspace.md`; delete the predecessor and all residue; run the
   proof ladder.

## Residue gates

Run from the repository root. `assert_no_match` treats ripgrep exit `1` as the
only success; regex, path, and I/O errors remain failures.

```bash
set -euo pipefail

assert_no_match() {
  local rg_status
  if rg "$@"; then
    echo "unexpected cutover residue"
    return 1
  else
    rg_status=$?
    if [ "$rg_status" -ne 1 ]; then
      return "$rg_status"
    fi
  fi
  return 0
}

assert_no_match -n \
  'PaneMobileChromeController|startReaderScroll|updateReaderScroll|beginReaderPointerInteraction|usePaneMobileChromeController' \
  apps/web/src e2e
assert_no_match -n 'acquireVisibleLock' apps/web/src
assert_no_match -n 'MobileChromeScrollSnapshot' apps/web/src \
  --glob '!apps/web/src/lib/workspace/mobileChromeMotion.ts' \
  --glob '!apps/web/src/lib/workspace/mobileChromeMotion.test.ts' \
  --glob '!apps/web/src/lib/workspace/mobileChrome.tsx'
assert_no_match -n 'data-mobile-chrome-focus' apps/web/src
assert_no_match -n -F 'findPaneChromeFocusTarget' \
  'apps/web/src/lib/workspace/mobileChrome.tsx'
assert_no_match -n -F 'vi.mock("@/lib/ui/useIsMobileViewport"' \
  'apps/web/src/lib/workspace/mobileChrome.test.tsx' \
  'apps/web/src/lib/reader/paneScroll.test.tsx'
assert_no_match -n -F "vi.mock('@/lib/ui/useIsMobileViewport'" \
  'apps/web/src/lib/workspace/mobileChrome.test.tsx' \
  'apps/web/src/lib/reader/paneScroll.test.tsx'
assert_no_match -n -F 'vi.mock("@/lib/workspace/mobileChrome' apps/web/src
assert_no_match -n -F "vi.mock('@/lib/workspace/mobileChrome" apps/web/src
assert_no_match -n 'finishSettle' \
  apps/web/src/components/appnav/MobilePaneBar.tsx \
  apps/web/src/components/workspace/PaneShell.tsx \
  apps/web/src/components/switchboard/NexusButton.tsx
assert_no_match -n \
  'scrollTop\s*(\+=|-=|=)|\.scrollTo\(|\.scrollIntoView\(' \
  apps/web/src/components/PdfReader.tsx \
  apps/web/src/components/pdfPaneFind.ts \
  'apps/web/src/app/(authenticated)/media/[id]' \
  --glob '!*.test.ts' --glob '!*.test.tsx'
assert_no_match -n \
  'scrollTop\s*=|\.scrollTo\(|dispatchEvent|activeElement.*\.blur\(|\.blur\(' \
  e2e/tests/mobile-reader-chrome.spec.ts \
  e2e/tests/pane-chrome.spec.ts
assert_no_match -n 'max-height:\s*50(vh|dvh)' \
  'apps/web/src/app/(authenticated)/media/[id]/page.module.css'

if [ -e docs/cutovers/mobile-reader-scroll-linked-chrome-hard-cutover.md ]; then
  echo "superseded mobile-reader scroll-chrome spec remains"
  exit 1
fi
```

## Acceptance criteria

1. From normal mobile activation, one forward touch drag retreats AppBar,
   PaneToolbar when present, and Nexus in Web, EPUB, transcript, and PDF.
2. Short reverse scroll or top/Home navigation from touch, wheel, keyboard, or
   AT input reveals all three. On Web, EPUB, and PDF, an unhandled
   blank-canvas pointer tap also reveals; handled controls/annotations and
   drags do not. Transcript segment/player targets remain handled. PDF proof
   observes the actual trusted click target after Chrome touch-target
   adjustment and requires the marked passive text-layer boundary.
3. Real input proves proportional intermediate motion across the `64px`
   travel, the `8px` reversal dead zone, endpoint settlement, and interruption
   or cancellation of an in-flight settle. Missing transition events still
   reach the intended terminal phase. All surfaces remain synchronized and
   clear their viewport edge at hidden.
4. The active mobile reader has exactly one registered scrollport and one
   interaction root; a duplicate fails immediately. Mobile transcript segments
   scroll the outer viewport while desktop retains its bounded list.
5. Route activation leaves focus on the stable pane landmark and acquires no
   visible lock.
6. Focusing a chrome control pins visible. Replacing/removing that control or
   its surface reconciles from the live active element; the next reader input
   cannot remain pinned by stale `chrome-focus`.
7. Find preview/Return, restore, reflow, zoom, anchor/highlight navigation,
   selection, menus, secondary sheets, and picker actions never collapse chrome
   or corrupt the next reader delta. Every app-owned reader scroll write passes
   through `paneScroll.ts`.
8. Reduced motion pins visible. Disabling it rebaselines and the next gesture
   works.
9. Route/document, EPUB unit, and desktop/mobile transitions reset visible
   without consuming the first real gesture. Reflow, lazy media, zoom, IME, and
   rotation rebaseline without changing semantic source identity.
10. Short/non-overflowing content remains visible.
11. AppBar, PaneToolbar, and Nexus are wholly inert, unclickable, and absent
    from keyboard/screen-reader navigation in `Tracking`, `Settling`, and
    `Hidden`; the independent pane landmark remains named and focusable.
12. Chrome motion changes no reader geometry, cursor, selection, progress,
    completion, or last-line/player/safe-area clearance.
13. A render-counter browser scenario proves incremental samples within
    `Tracking` do not rerender reader bodies or presentation surfaces; only
    semantic phase transitions may render. Progress writes are transform-only
    and RAF-coalesced.
14. Closing a player, sheet, menu, picker, or Find returns focus to visible
    non-inert chrome or the pane landmark, never `<body>`.
15. No deleted API, duplicate publisher, mobile nested transcript scrollport,
    direct reader positioning write, compatibility path, or stale test/doc
    claim remains.

## Required proof

- Pure reducer tests for direction, hysteresis, top, short content, pin/unpin,
  proportional progress, settle, and settle interruption remain green.
- Browser component tests use the real provider, scrollport, surfaces, focus,
  locks, and accessibility state. They do not mock internal chrome APIs.
- Provider proof covers late mount/node replacement, duplicate rejection,
  enable/source changes, StrictMode replay, mobile-entry focus reconciliation,
  focused-control/surface replacement, focus movement within a surface,
  overlapping locks, lock during Tracking/Settling, final-release rebaseline,
  disable/unmount cleanup, reduced motion, settle end/cancel/missing-event
  completion, and reveal-before-focus fallback.
- Ref proof covers object refs, callback refs with and without cleanup, reverse
  cleanup order, replacement, StrictMode replay, and unmount under React 19.
- Reader proof covers Web/EPUB sampling during Find/reflow fences, all
  app-owned positioning through `paneScroll.ts`, mobile transcript outer-owner
  preview/Return, unchanged desktop transcript ownership, and PDF
  restore/zoom/Find rebaseline.
- Accessibility proof asserts whole-surface `inert`, `aria-hidden`, hit testing,
  tab order, stable landmark naming, and safe focus return for every phase.
  A render counter proves incremental Tracking samples do not rerender reader
  bodies or surfaces.
- Add a `mobile-chrome` Playwright project based on `devices["Pixel 7"]`,
  selected by `@mobile-chrome`; add `@mobile-chrome` to the desktop Chromium
  project's `grepInvert`. Set `video: "retain-on-failure"` alongside existing
  trace and screenshot retention.
- `e2e/tests/mobile-reader-chrome.spec.ts` is the red and final trusted-input
  home. A shared Chromium CDP touch helper drives incremental touch input while
  a page-side RAF recorder samples raw scroll events, their top-pin baseline,
  specified/computed collapse values, phases, and transforms. A real top-pin
  sample proves the exact 8px dead zone; later gestures use the reducer's
  history-safe 0–8px dead-zone envelope without inventing a reset. The format
  table requires PaneToolbar presence for EPUB/PDF and absence is a failure. Settle
  transition events prove lifecycle only; a sticky RAF-frame oracle proves
  every rendered `Settling` frame inert and `aria-hidden`, while gesture
  samples cover the Tracking/Settling interruption handoff.
  Continuous-gesture proof must remain below the idle-settle boundary and
  observe no settle transition; a separate scenario holds a trusted touch
  stationary while settle begins, then requires its native scroll to cancel the
  live transition. Direct scroll mutation, synthetic scroll/pointer events, and
  manual blur are forbidden in chrome acceptance and removed from predecessor
  pane-chrome helpers.
- The real-stack matrix covers all four formats plus Find and active-player
  composition.
- CI's default E2E job runs `mobile-chrome` and retains trace, screenshot, and
  video on failure.
- Manual authenticated primary-device Android WebView smoke uses the same
  real-stack seed IDs and covers all four formats, touch drag, inertial fling,
  reverse/tap reveal, selection, menu, Find, player, reduced motion, TalkBack,
  switch access, keyboard reverse/top recovery, rotation, cutout, and safe area.
  Do not build a test-only auth bridge or local-HTML substitute.
- One authenticated physical iOS Safari article smoke covers touch/tap reveal,
  VoiceOver reverse/top recovery and focus, dynamic browser chrome, IME,
  rotation, and safe area. Do not repeat the four-format matrix on iOS.
- Existing Android instrumentation continues proving the permanent black
  status-bar protection, light icons, inset sizing, pre-edge-to-edge fallback,
  and edge-to-edge WebView. The durable contract lives in
  `docs/modules/workspace.md` before the predecessor is deleted.
- Typecheck, scoped lint, CSS-token lint, E2E TypeScript, residue search,
  `git diff --check`, and the relevant CI jobs pass.

Focused real-stack command:

```bash
PLAYWRIGHT_ARGS='tests/mobile-reader-chrome.spec.ts --project=mobile-chrome' make test-e2e
```

Do not mark this cutover implemented or verified until production-stack browser
and physical-device gates pass. No gate waiver.
