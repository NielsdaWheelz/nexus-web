# Mobile Reader Unified Scroll Chrome — Council Plan

Status: Proposed implementation specification
Type: Hard cutover; one final path, no feature flag, fallback, alias, or compatibility branch
Owner: `MobileChromeProvider`

## Decision

Repair and complete the existing mobile-chrome owner. Do not create a second
scroll service, per-format motion model, native bridge, or Nexus-only path.

The product contract is one active reader scrollport → one provider policy →
one collapse progress → three synchronized surfaces:

```text
actual reader scrollport
  └─ useMobileChromeReaderScrollport
       └─ MobileChromeProvider
            ├─ motion reducer
            ├─ focus / visibility-lock policy
            └─ --mobile-chrome-collapse
                 ├─ AppBar retreats upward
                 ├─ PaneToolbar retreats upward
                 └─ NexusControl retreats downward
```

No blocking product question remains. Existing thresholds remain authoritative:
8px top pin, 8px reversal dead zone, 64px collapse travel, 1px minimum delta,
and 120ms idle settlement.

## Target behaviour

| Situation | Required result |
| --- | --- |
| Forward touch/trackpad/keyboard reader scroll | Chrome continuously retreats. |
| Reverse scroll | Chrome reveals after the reversal dead zone. |
| Top of document or short content | Chrome is fully visible. |
| Route/source/EPUB-unit/mobile-mode change | Fully visible; baseline from the live scrollport. |
| Focus in a real chrome control | Fully visible while focus remains there. |
| Find, menu, selection, restore, positioning, navigation, sheet, or picker | Fully visible under its owned lock. |
| Reduced motion | Fully visible; no motion is required. |
| Tracking, settling, or hidden | Whole moving surfaces are inert, non-hit-testable, and `aria-hidden`. |
| Hidden chrome receives a blank-canvas tap | Reveal only; never activate covered content. |
| New scroll during settlement | Sample immediately, cancel stale settlement, continue from current progress. |
| Rotation, IME, safe-area, resize, reflow, lazy media, or zoom | Rebaseline geometry without changing reading position. |
| Chrome movement | Never changes reader layout, `scrollTop`, selection, progress, or bottom clearance. |

Nexus is transient global chrome, not an always-present FAB. It may fully retreat.
Reverse scroll, top navigation, keyboard, and assistive technology are the
recovery contract; blank-canvas tap is supplementary pointer recovery.

## Scope

In scope:

- Web article, EPUB, readable transcript, and PDF mobile readers.
- AppBar, active PaneToolbar, and NexusControl presentation.
- Scroll ownership, focus handoff, visibility locks, settlement, inertness,
  accessibility, safe area, and trusted-input proof.
- Consolidation of duplicate reader scroll/positioning paths.

Out of scope:

- Backend, API, persistence, player policy, reader progress semantics, or data
  migrations.
- Desktop chrome or desktop transcript segment-list geometry.
- New motion thresholds, velocity prediction, ML, CSS Scroll Timeline, native
  scroll APIs, user preferences, or compatibility modes.
- A test-only auth bridge, local-HTML substitute, or production-only diagnostic
  endpoint.

## Architecture and ownership

### Provider

`MobileChromeProvider` is the sole owner of:

- normalized motion state and phase;
- the single reader scrollport registration;
- focus reconciliation and pointer focus handoff;
- typed visible-lock registry;
- settlement lifecycle and stale-event fencing;
- blank-canvas reveal adjudication;
- the single progress writer for all three surfaces.

`mobileChromeMotion.ts` remains a pure reducer. Presentation components do not
infer direction, read scroll position, own timers, or publish progress.

### Reader capability

The existing hook is the only reader registration API:

```ts
useMobileChromeReaderScrollport({
  sourceKey: string,
  enabled: boolean,
}): RefCallback<HTMLElement>
```

Its contract:

1. `enabled` means this is the active mobile reader and its element is the real
   native scroll owner.
2. Exactly one enabled registration exists per provider; duplicate registration
   fails loudly.
3. Native `scroll` samples are delivered independently of progress capture,
   Find, restore, reflow, activity, and persistence.
4. Unregistering, replacing, or changing `sourceKey` cleans every listener and
   resets visible state from the next live scrollport.
5. The provider never samples `window`, the workspace, or an incidental nested
   element.

The stable active-reader root remains the sole pointer focus-handoff boundary:
`[data-mobile-reader-interaction-root]`. It covers loading, error, short-content,
and scrollport replacement states.

### State schema

Keep the existing discriminated phase union:

```ts
type Phase =
  | { kind: "Visible" }
  | { kind: "Tracking"; direction: "Up" | "Down" }
  | { kind: "Settling"; target: "Visible" | "Hidden" }
  | { kind: "Hidden" }
  | { kind: "Pinned" };
```

The state also owns `progress: number` in `[0, 1]`, the last clamped
`scrollTop`, direction, and reversal distance. `Pinned` is valid only for
reduced motion or at least one live focus/visibility lock.

The only public lock capability is:

```ts
useMobileChromeVisibleLocks().acquire(
  reason: MobileChromeVisibleLockReason,
): () => void
```

Reasons remain a closed union: restore, positioning, PDF selection, text
selection, highlight navigation, pane Find, mobile secondary, library picker,
and action menu. Releases are idempotent and mandatory on completion and owner
unmount. Final release rebaselines from the live scrollport.

### Surface contract

The existing surface roles remain the only roles: `AppBar`, `PaneToolbar`, and
`NexusControl`. Each surface consumes the provider phase and shared
`--mobile-chrome-collapse` value. Hidden/settling state applies the same whole-
surface `inert`, `aria-hidden`, and hit-testing predicate. The outer Nexus
wrapper remains the fixed-obstruction measurement surface; only the inner
control moves.

## Cross-system composition

- **Web and EPUB:** `TextDocumentReader` registers its `.documentViewport`.
  Existing progress/activity/trusted-intent listeners remain separate.
- **Mobile transcript:** the outer document viewport is the scroll owner;
  segments become unbounded/non-scrolling on mobile. Desktop keeps its bounded
  segment-list owner.
- **PDF:** `PdfReader` registers its viewer. Restore, zoom, Find, and anchor
  writes use the existing `paneScroll.ts` positioning boundary.
- **All app-owned positioning:** `paneScroll.ts` is the only mutation boundary;
  every operation acquires a positioning lock, performs the operation, waits
  one layout sample, releases, and rebaselines.
- **Focus:** mobile route activation focuses the pane landmark, never clipped
  AppBar chrome. Explicit return-to-command uses `usePaneChromeFocusReturn` and
  never focuses inert or disconnected nodes.
- **Viewport:** `MobileViewportProvider` remains the sole safe-area, keyboard,
  player, Nexus-obstruction, and visual-viewport geometry owner.

## Hard-cut deletions

Delete, with no aliases or shims:

- Per-format chrome publishers, direct chrome timers, and duplicate motion state.
- Any mobile use of `findPaneChromeFocusTarget` for route activation.
- Nested mobile transcript scrolling.
- Direct reader positioning outside `paneScroll.ts`.
- `startReaderScroll`, `updateReaderScroll`,
  `beginReaderPointerInteraction`, `usePaneMobileChromeController`, and any
  duplicate lock entrypoint.
- E2E helpers that mutate `scrollTop`, call `scrollTo`, dispatch synthetic
  scroll/pointer events, or manually blur focus for chrome acceptance.
- Old mobile-chrome docs, waived-gate claims, feature flags, fallback branches,
  compatibility exports, and dead tests.

## Files and reuse map

Primary owners:

- `apps/web/src/lib/workspace/mobileChrome.tsx`
- `apps/web/src/lib/workspace/mobileChromeMotion.ts`
- `apps/web/src/lib/workspace/paneDom.ts`
- `apps/web/src/lib/reader/paneScroll.ts`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/appnav/MobilePaneBar.tsx`
- `apps/web/src/components/switchboard/NexusButton.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.tsx`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`

Reuse rather than recreate: `composeRefs`, `interactiveTarget`,
`MobileViewportProvider`, `paneDom` landmark resolution, `useDialogOverlay`,
`useMobileChromeVisibleLocks`, and `useReaderScrollPositioner`.

Proof files:

- Update `apps/web/src/components/workspace/PaneShell.mobileChrome.browser.test.tsx`
  to prove component behavior without synthetic scroll mutation.
- Add focused unit/browser proofs beside `mobileChromeMotion.ts` and
  `mobileChrome.tsx` for the reducer, registration, locks, focus, and surface
  inertness contracts.
- Add `apps/web/e2e/journeys/mobile-reader-chrome.journey.spec.ts` and a mobile
  Playwright project in `apps/web/e2e/playwright.config.ts` for real touch input.

## Implementation order

1. Add failing provider/component proofs for missing samples, permanent pins,
   focus replacement, lock release, settlement interruption, inertness, and
   duplicate registration.
2. Make provider lifecycle authoritative: one registration, live focus
   reconciliation, lock cleanup, settlement cancellation, and stable root.
3. Migrate all four readers and all positioning writes to the shared contracts.
4. Remove mobile transcript nesting and mobile chrome-focus activation.
5. Apply whole-surface accessibility/hit-testing and robust Nexus target proof.
6. Add trusted Pixel/Android touch E2E and CI artifacts; delete synthetic legacy
   chrome proof.
7. Run residue, type, lint, browser, Android, deployment, and physical gates.

## Acceptance criteria

The cutover is incomplete unless all are green:

- One real forward gesture hides AppBar, PaneToolbar when present, and Nexus in
  Web, EPUB, transcript, and PDF.
- Reverse movement, top arrival, keyboard, assistive technology, and valid
  focus restore controls without moving reader content.
- Find, selection, restore, zoom, menu, player, navigation, rotation, IME,
  safe-area, reduced-motion, and short-content scenarios obey the contract.
- Trusted mobile input—not `scrollTop` mutation, synthetic events, or manual
  blur—drives the acceptance path.
- Physical Android WebView smoke passes on the authenticated primary device;
  production verification proves the exact deployed SHA.
- No duplicate scroll owner, lock leak, legacy API, compatibility branch,
  fallback, dead test, or stale documentation remains.

Use the repository’s canonical `./scripts/test` capability surface and record
each deferred physical/deployment gate explicitly; a green synthetic test is
not acceptance.

## Open questions

None. If implementation discovers a conflict, stop and update this contract
before adding a branch.

Detailed evidence and the existing proof ledger remain in
`mobile-reader-unified-scroll-chrome-hard-cutover.md`.
