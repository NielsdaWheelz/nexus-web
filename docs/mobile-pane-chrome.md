# Mobile Pane Chrome Hard Cutover

## Purpose

Make mobile document-pane chrome a first-class shell behavior with one durable,
testable visibility controller.

This is a hard cutover. The final state has no legacy boolean chrome lock, no
route-local duplicated chrome visibility state, no window-scroll alternate path
for document panes, no compatibility mode, no hidden alternate scroll owner, and
no feature flag.

## Goals

- Preserve vertical reading space on mobile document panes.
- Hide the pane chrome smoothly when the user deliberately scrolls down.
- Reveal the pane chrome smoothly when the user deliberately scrolls up.
- Keep chrome visible when controls, selections, drawers, menus, or restore
  workflows require stable access to pane actions.
- Make mobile chrome visibility owned by `PaneShell`, not by route components.
- Make the active reader/PDF scroll container the only scroll source.
- Make chrome locks scoped, releasable, and impossible to leak silently.
- Keep reduced-motion users on a stable, non-animated visible chrome state.
- Keep safe-area and scroll-padding behavior correct on mobile browsers.
- Keep automated coverage focused on visible behavior and real reader flows.
- Record this policy in one doc so reader and workspace changes share a contract.

## Non-Goals

- Desktop auto-hiding pane chrome.
- Auto-hiding chrome for standard or contained panes.
- Browser `window` scroll ownership for document-pane readers.
- A general animation framework.
- A user setting for this behavior.
- Compatibility with the current boolean lock API.
- Runtime support for both old and new mobile chrome controllers.
- CSS scroll-driven animation as the primary implementation.
- Changing reader resume data shapes.
- Changing PDF rendering or text-reader layout outside chrome integration.

## Target Behavior

### Scope

- The behavior applies only when:
  - viewport is mobile,
  - pane `bodyMode` is `document`,
  - the pane has a registered document scroll owner,
  - the user has not requested reduced motion.
- Non-document panes keep chrome visible.
- Desktop panes keep chrome visible.
- Reduced-motion mobile document panes keep chrome visible and disable the
  hide/reveal transition.

### Scroll Intent

- At the top of a document, chrome is visible.
- Near the top reservation, chrome is visible.
- A one-off small scroll delta does not hide or reveal chrome.
- Downward scroll hides chrome only after a named downward tolerance is crossed.
- Upward scroll reveals chrome only after a named upward tolerance is crossed.
- Scroll positions are clamped to the scroll container range before direction
  calculation.
- Rubber-band, overscroll, momentum artifacts, and subpixel drift do not toggle
  chrome.
- Programmatic restore scrolls hold a restore lock, keep chrome visible during
  restore, and release the lock when restore settles or cancels.

### Visibility Locks

- A component never sets a shared `lockedVisible` boolean.
- A component acquires a scoped visible lock and receives a release function.
- Each lock has a typed reason.
- Releasing the same lock more than once is harmless.
- Unmounting a lock owner releases its lock.
- Shell visibility is computed from the lock set, not from the last writer.
- Chrome remains visible while any lock is held.
- Known lock reasons:
  - `reader-restore`
  - `pdf-selection`
  - `text-selection`
  - `highlight-navigation`
  - `highlights-drawer`
  - `quote-chat-sheet`
  - `library-picker`
  - `action-menu`

### User Interactions

- Opening a mobile selection popover shows chrome and keeps it visible.
- Opening the highlights drawer shows chrome and keeps it visible.
- Opening the quote chat sheet shows chrome and keeps it visible.
- Opening the library picker shows chrome and keeps it visible.
- Navigating to a deep link or highlight shows chrome through the navigation
  operation.
- After the interaction ends, chrome returns to normal scroll-intent behavior.
- If the current scroll position is already deep in the document when the last
  lock releases, the next downward scroll can hide chrome without requiring a
  route remount.

### Layout

- Mobile chrome is visually overlaid above document content.
- The document scroll owner reserves enough top space for visible chrome,
  `env(safe-area-inset-top)`, and the app spacing token.
- Deep links, highlight navigation, `scrollIntoView`, and PDF page navigation use
  the same top reservation through `scroll-padding-top` or equivalent page
  margins.
- The chrome hides with `transform`, not `top`, `height`, or `display`.
- Hidden chrome does not intercept pointer events.
- The shell exports the measured chrome height as
  `--mobile-pane-chrome-height`.
- The scroll owner uses `overscroll-behavior` to prevent scroll chaining from
  corrupting document scroll intent.

## Final State

### Kept

- `PaneShell` as the owner of pane chrome rendering.
- `SurfaceHeader` as the chrome content/layout component.
- `bodyMode = "document"` as the opt-in for document-pane scroll behavior.
- Route-owned reader, EPUB, transcript, and PDF content rendering.
- `--mobile-pane-chrome-height` as the measured layout contract.
- Mobile reduced-motion pinning.
- Existing reader resume behavior and saved state shapes.

### Removed

- `setMobileChromeLockedVisible(boolean)`.
- Any visibility logic where the last component to write a boolean wins.
- Any reader-specific duplicate hidden/visible chrome state.
- Any route-level CSS class that directly hides pane chrome.
- Any window-level scroll alternate path for `/media/:id` document panes.
- Any test that proves the old boolean API instead of visible behavior.

## Architecture

```text
WorkspaceHost
  determines mobile viewport
  renders PaneShell with route bodyMode

PaneShell
  renders SurfaceHeader chrome
  measures chrome height
  owns MobilePaneChromeController
  exposes controller context to route bodies
  computes visible/hidden state
  writes data-mobile-chrome-hidden

MobilePaneChromeController
  receives scroll snapshots from the registered scroll owner
  clamps scroll positions
  derives scroll direction and tolerance distance
  tracks top/not-top state
  tracks scoped visible locks
  tracks reduced-motion state
  emits a single visibility state

MediaPaneBody / PdfReader
  registers the actual document scroll owner
  sends scroll snapshots
  acquires visible locks for restore, selection, drawers, and navigation
  releases locks on settle, cancel, completion, error, and unmount
```

Route components provide facts and lifecycle signals. `PaneShell` owns policy.

## Controller Contract

The shell context exposes one controller API:

```typescript
type MobileChromeLockReason =
  | "reader-restore"
  | "pdf-selection"
  | "text-selection"
  | "highlight-navigation"
  | "highlights-drawer"
  | "quote-chat-sheet"
  | "library-picker"
  | "action-menu";

interface MobileChromeScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

interface MobileChromeController {
  onDocumentScroll(snapshot: MobileChromeScrollSnapshot): void;
  acquireVisibleLock(reason: MobileChromeLockReason): () => void;
}
```

The implementation keeps this API behind `PaneShell` context hooks. Route
components must not receive raw state setters.

## State Rules

- State is explicit:
  - `atTop`
  - `direction`
  - `directionStartScrollTop`
  - `lastScrollTop`
  - `hiddenByScroll`
  - `visibleLocks`
  - `reducedMotion`
- `effectiveHidden` is derived:
  - false when not mobile document mode,
  - false when reduced motion is active,
  - false when `visibleLocks.size > 0`,
  - false when `atTop`,
  - otherwise `hiddenByScroll`.
- Leaving mobile document mode clears scroll state and releases shell-owned
  transient state.
- Route unmount cleanup releases route-owned locks.
- All thresholds are named constants near the controller logic.
- Branches over lock reasons and pane modes are exhaustive.

## Key Decisions

- Use a scoped lock set instead of a boolean lock.
  This prevents stuck chrome caused by an effect that sets `true` and never
  writes `false`.
- Keep policy in `PaneShell`.
  Reader routes must not know how scroll tolerance, reduced motion, or
  top-reservation behavior is computed.
- Keep route-specific scroll ownership.
  Text readers and PDF readers have different scroll containers; both report to
  the same shell policy.
- Keep transform-based animation.
  This preserves compositor-friendly movement and avoids layout reflow.
- Keep reduced-motion visible.
  Removing animation alone is not enough because scroll-triggered motion remains
  non-essential chrome movement.
- Do not adopt Headroom.js.
  The repo already has the shell boundary and route-specific scroll containers;
  importing a browser widget would add API surface without owning reader locks.
- Do not use CSS scroll timelines as the main implementation.
  They do not model scoped locks, restore lifecycles, or drawer/menu visibility.

## Files

### Primary Implementation

- `apps/web/src/components/workspace/PaneShell.tsx`
  - replace boolean lock context with controller API,
  - own scoped locks,
  - compute effective hidden state,
  - keep mobile chrome measurement.
- `apps/web/src/components/workspace/PaneShell.module.css`
  - keep transform-based hide/reveal,
  - keep reduced-motion transition removal,
  - keep mobile layout contract.
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
  - report complete scroll snapshots,
  - acquire/release locks around text restore, EPUB anchor/top restore, highlight
    navigation, text selection, highlights drawer, quote sheet, and library
    picker.
- `apps/web/src/components/PdfReader.tsx`
  - report complete scroll snapshots,
  - acquire/release locks around PDF selection.
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
  - keep non-PDF document viewport top reservation and scroll padding.
- `apps/web/src/components/PdfReader.module.css`
  - keep PDF viewport top reservation and scroll padding.

### Tests

- `apps/web/src/__tests__/components/PaneShell.test.tsx`
  - update unit coverage to the controller API and visible behavior.
- `e2e/tests/pane-chrome.spec.ts`
  - keep mobile scroll hide/reveal coverage for text and PDF readers.
  - add coverage for lock release after reader restore.
- `e2e/tests/reader-resume.spec.ts`
  - assert mobile reader resume does not leave chrome permanently locked.

### Documentation

- `docs/mobile-pane-chrome.md`
  - owns this policy.
- `docs/reader-implementation.md`
  - links to this policy and remains the reader status overview.

## Acceptance Criteria

- On mobile web article readers, scrolling down past the named tolerance hides
  chrome.
- On mobile web article readers, scrolling up past the named tolerance reveals
  chrome.
- On mobile EPUB readers, the same hide/reveal behavior works after initial
  section restore settles.
- On mobile transcript readers, the same hide/reveal behavior works while the
  transcript panel remains the scroll owner.
- On mobile PDF readers, the PDF scroll container controls hide/reveal behavior.
- Reduced-motion mobile document panes never hide chrome by scroll.
- Standard and contained mobile panes never hide chrome by body scrolling.
- Opening and closing each visible-locking interaction returns chrome to normal
  scroll behavior:
  - text selection,
  - PDF selection,
  - highlights drawer,
  - quote chat sheet,
  - library picker,
  - highlight deep link,
  - reader restore.
- Reader restore can be cancelled by user scroll intent and does not leave a
  visible lock held.
- Deep-linked anchors and highlights are not obscured by visible chrome.
- Hidden chrome does not intercept taps.
- No code path calls `setMobileChromeLockedVisible`.
- No route component owns a second chrome visibility state.
- Unit tests and E2E tests assert visible behavior, not internal callback counts.

## Validation

```bash
make test-front-unit
make test-e2e
```

Targeted commands during development:

```bash
bunx vitest apps/web/src/__tests__/components/PaneShell.test.tsx
bun run test:e2e -- e2e/tests/pane-chrome.spec.ts
bun run test:e2e -- e2e/tests/reader-resume.spec.ts
```

## References

- Headroom.js documents the offset, tolerance, custom scroller, class-driven, and
  transform-based pattern for auto-hiding headers:
  <https://wicky.nillia.ms/headroom.js/>
- Material UI documents hiding an app bar on scroll down to leave more space for
  reading, with threshold and hysteresis:
  <https://v5.mui.com/material-ui/react-app-bar/>
- Android Compose models app bar scroll behavior as explicit scroll behavior
  objects:
  <https://developer.android.com/develop/ui/compose/components/app-bars>
- MDN documents scroll event rate and throttling considerations:
  <https://developer.mozilla.org/en-US/docs/Web/API/Document/scroll_event>
- Chrome documents passive listeners for scroll performance:
  <https://developer.chrome.com/blog/passive-event-listeners>
- MDN documents reduced-motion preferences:
  <https://developer.mozilla.org/docs/Web/CSS/%40media/prefers-reduced-motion>
- MDN documents safe-area environment variables:
  <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/env>
- MDN documents overscroll behavior and scroll chaining:
  <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overscroll-behavior>
