# Mobile Reader Bottom Geometry — Hard Cutover

Status: Proposed implementation specification

Type: One frontend hard cutover. No flag, fallback, alias, compatibility path,
or mixed geometry model.

Owner: `MobileViewportProvider` for platform and obstruction geometry;
`MediaPaneBody` for ribbon presentation; `MobileMiniPlayer` and `NexusButton`
for surface registration.

Related contracts:

- [`android-webview-system-insets-hard-cutover.md`](android-webview-system-insets-hard-cutover.md)
  owns the Android-to-CSS inset boundary.
- [`mobile-reader-unified-scroll-chrome-council-plan.md`](mobile-reader-unified-scroll-chrome-council-plan.md)
  owns reader-linked AppBar, PaneToolbar, and Nexus motion.
- [`mobile-reader-position-ribbon-hard-cutover.md`](mobile-reader-position-ribbon-hard-cutover.md)
  owns semantic range projection and ribbon presentation; this cutover
  supersedes its bottom-placement clauses.

No blocking product question remains. The decisions below are locked.

## Decision

Separate three facts that are currently conflated:

1. full-window safe and fixed-obstruction clearance;
2. reader-local terminal-content clearance;
3. passive ribbon paint position.

The position ribbon is reader-owned, noninteractive, and painted at the reader
surface bottom. It does not consume content clearance and does not move above
Nexus, Player, or Android navigation merely because those surfaces exist.
Higher-priority surfaces may cover it.

The MiniPlayer remains normal-flow layout. It is a bottom surface used to place
Nexus, not a fixed content obstruction. Its flow layout already shortens the
reader.

Nexus keeps its stable outer reservation while its inner control retreats. That
reservation protects terminal content but does not position the decorative
ribbon.

## Goals

- Put the ribbon at the reader's actual visual bottom in portrait, landscape,
  three-button navigation, gesture navigation, rotation, and keyboard states.
- Count every obstruction exactly once in the coordinate system that consumes
  it.
- Keep Android safe-area ownership in the existing CSS/WebView boundary.
- Preserve the existing reader semantic range and mobile scroll-chrome policy.
- Keep Player progress separate from reader position.
- Delete the current double-counting path and dead geometry names.
- Prove the result with focused browser behavior and the real Android app.

## Target behavior

| Situation | Required result |
| --- | --- |
| Readable mobile Web, EPUB, or PDF | One 2px passive position ribbon; band equals the exact semantic visible range. |
| No Player | Ribbon remains at the reader bottom; it does not float above the Android bar or Nexus. |
| Flow MiniPlayer present | Reader layout ends before the Player; Player is not added again as reader clearance. |
| Nexus visible or retreated | Nexus protects terminal content; it does not move the ribbon. Its stable outer reservation remains unchanged. |
| Fixed overlay or keyboard | Terminal content clears the local obstruction; the ribbon may be covered by the owning surface. |
| Player mount, hide, dismiss, or unmount | Registration is released exactly once; no stale clearance remains. |
| Rotation, resize, safe-area change, or reflow | Geometry reprojects without changing scroll position or semantic reader state. |
| Transcript, loading, error, unreadable, or missing range | No ribbon. No approximation or scrollbar fallback. |
| Desktop | Existing Document Map rail is unchanged. |

## Architecture

```text
Android WindowInsets
  -> WebView CSS safe-area-inset-*
  -> globals.css platform tokens
  -> MobileViewportProvider
       ├─ bottom-surface measurements
       ├─ full-window content projection
       └─ registered content-surface projections

actual reader scrollport
  -> MobileChromeProvider
       -> --mobile-chrome-collapse

reader semantic viewport
  -> MediaPaneBody
       -> passive ribbon, bottom: 0
```

`MobileChromeProvider` owns motion, locks, direction, settlement, and surface
inertness. `MobileViewportProvider` owns safe area, keyboard, bottom-surface
rectangles, and local terminal clearance. They do not derive each other's state.

## Capability contract

Hard-cut the current fixed-obstruction API to this public capability:

```ts
type MobileBottomSurfaceId = "Nexus" | "Player";

interface MobileViewportCapability {
  registerBottomSurface(
    id: MobileBottomSurfaceId,
    element: HTMLElement,
  ): () => void;
  registerContentSurface(element: HTMLElement): () => void;
  reportMobileOverlayKeyboardInset(px: number): () => void;
  subscribeContentBottomClearance(listener: () => void): () => void;
}
```

Rules:

- One active registration exists for each bottom-surface id.
- Each active mobile content surface has one registration owned by its layout
  owner. Multiple surfaces may be registered when multiple mobile panes are
  mounted.
- Duplicate active registration fails loudly.
- Cleanup is idempotent, disconnects observers, removes element-local CSS
  variables, and immediately recomputes projection.
- `Nexus` is fixed and participates in terminal-content protection.
- `Player` is normal flow and participates only in Nexus avoidance.
- No caller reads raw `env(safe-area-inset-*)`, `window.innerHeight`, or another
  caller's rectangle to derive product geometry.
- The provider reads and writes geometry in one scheduled measurement pass and
  writes the local `--mobile-content-bottom-clearance` value on each registered
  content surface.
- `ResizeObserver`, `window.resize`, and top-level `visualViewport` resize/scroll
  events share one coalesced measurement path. No reader-scroll listener is
  added for geometry.

## Projection model

Keep the pure model in `lib/mobileViewport/model.ts` and make its inputs explicit:

```ts
interface MobileBottomSurfaceRect {
  top: number;
  bottom: number;
  width: number;
  height: number;
}
```

Amendment — 2026-08-04, discovered during implementation. This section first
sketched one `MobileViewportProjection { contentBottomClearancePx,
playerBottomClearancePx }` return computed from a single measurement snapshot.
That is not resolvable: the Nexus rectangle only exists at its published offset,
so it cannot be measured until `--mobile-nexus-bottom-offset` has been written,
and a registered content surface's bottom only exists after the clearance that
shortens it has been written. One combined return would need a second frame to
converge. The single projection type is therefore deleted and replaced by three
pure resolvers consumed in one ordered pass:

```ts
resolveNexusBottomOffsetPx(input: {
  viewportHeightPx: number;
  safeBottomPx: number;
  playerRect: MobileBottomSurfaceRect | null;
}): number;

resolveContentBottomClearancePx(input: {
  viewportHeightPx: number;
  safeBottomPx: number;
  nexusRect: MobileBottomSurfaceRect | null;
  overlayKeyboardInsetPx: number;
}): number;

resolveContentSurfaceBottomClearancePx(input: {
  viewportHeightPx: number;
  contentBottomClearancePx: number;
  surfaceBottomPx: number;
}): number;
```

The model must satisfy:

```text
Nexus bottom offset
  = max(safe bottom, Player bottom-surface clearance)

full-window content clearance
  = max(safe bottom, fixed Nexus clearance, keyboard inset)

registered content-surface clearance
  = max(0, ceil(full-window content clearance
               - the band below that surface's bottom))
```

The provider calls them in exactly that order inside one measurement pass,
reading each rectangle only after the write it depends on: the flow Player
places Nexus, the placed Nexus sets the protected full-window band, and that
band projects into every registered content surface. The pass converges without
a second frame.

Safe-bottom composition also moves. It was previously applied outside the model
by publishing a CSS `max(var(--viewport-safe-bottom), Npx)` string; it is now a
numeric `safeBottomPx` input to the pure resolvers, read once per pass at the
browser boundary through `readMobileCssLength("var(--viewport-safe-bottom)")`.
The published values are therefore plain pixel lengths, and `globals.css`
remains the only raw platform-inset adapter.

The flow Player is excluded from full-window content clearance because its
normal-flow layout already owns that space. Each content-surface projection
subtracts the band that flow layout already spent below that surface, so no
obstruction is counted twice.

The provider publishes:

- root `--mobile-content-bottom-clearance` for full-window consumers;
- root `--mobile-nexus-bottom-offset` for the fixed Nexus wrapper;
- element-local `--mobile-content-bottom-clearance` for terminal content
  padding on registered surfaces.

Delete `--mobile-reader-paint-bottom-inset` and any ad-hoc
`content-clearance - nexus-offset` formula after all consumers migrate. Delete
any other geometry token proven unused by the final residue search.

The CSS safe-area adapter in `globals.css` remains the only raw platform-inset
reader. If JavaScript needs a CSS pixel value, extract one browser-boundary
length reader from the existing `FloatingActionSurface` probe; do not add a
second `env()` path or native inset bridge.

## Ribbon contract

`MobileReaderPositionRibbon` keeps its existing props and semantic range source:

```ts
interface MobileReaderPositionRibbonProps {
  readonly visibleRange: ReaderDocumentOverviewRange;
}
```

It must:

- render only from the existing `MediaPaneBody` readable-mobile gate;
- use `position: absolute; inset-inline: 0; bottom: 0` in the reader column;
- use the supplied logical inline range without reprojecting it;
- remain 2px, passive, `aria-hidden="true"`, and `pointer-events: none`;
- remain below handoff, error, sheet, and modal surfaces;
- never read scroll geometry, safe-area values, Player state, or Nexus state;
- never share `PlayerMiniProgress` or acquire a chrome lock.

The ribbon is presentation only. Terminal content consumes the element-local
`--mobile-content-bottom-clearance` separately and exactly once.

## Cross-system composition

### Reader

`PaneShell` registers the active mobile `.body` as a content surface and
releases it for desktop or inactive panes. The surface is the layout boundary
for standard scrolling and the inherited clearance boundary for
document/contained readers. All readable Web, EPUB, and PDF formats use that
one local projection. The existing format-owned scrollport and semantic
viewport publication remain unchanged.

Each format's terminal scroll padding consumes the local content token. Remove
the current global-token and bespoke-subtraction variants. Do not change source
locators, restore, progress writes, completion, activity, or semantic range
projection.

### MiniPlayer

`MobileMiniPlayer` keeps its current flow DOM and safe-area row padding. Replace
fixed-obstruction registration with `registerBottomSurface("Player", element)`.
Hidden, suspended, root-text-entry, and unmounted states unregister it.
`PlayerMiniProgress` remains untouched.

### Nexus

`NexusButton` registers its outer fixed wrapper with
`registerBottomSurface("Nexus", element)`. The wrapper remains the measured
reservation surface; the inner button remains the motion surface owned by
`MobileChromeProvider`.

### Android and visual viewport

Do not modify the native inset transport in this cutover. Preserve full-window
edge-to-edge WebView bounds, unconsumed native insets, and the M144+ CSS safe-area
contract. VisualViewport is a provider-boundary input for viewport/IME geometry,
never a reader-position source.

## Scope

Modify only the geometry and its direct consumers:

- `apps/web/src/lib/mobileViewport/MobileViewportProvider.tsx`
- `apps/web/src/lib/mobileViewport/model.ts`
- `apps/web/src/app/globals.css`
- `apps/web/src/components/reader/MobileReaderPositionRibbon.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
- `apps/web/src/components/PdfReader.module.css`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/player/MobileMiniPlayer.tsx`
- `apps/web/src/components/switchboard/NexusButton.tsx`
- `apps/web/src/components/ui/FloatingActionSurface.tsx` only to use the
  centralized CSS-length boundary helper
- `apps/web/src/lib/mobileViewport/readMobileCssLength.ts`

Audit every current consumer of `--mobile-content-bottom-clearance`. Migrate a
consumer only when its containing surface is not the full WebView viewport;
otherwise leave it on the root contract. Do not redesign unrelated chat,
sheet, player, or scroll-chrome UX.

Add or update the narrowest proofs beside the owning boundaries:

- `apps/web/src/lib/mobileViewport/model.unit.test.ts`
- `apps/web/src/lib/mobileViewport/MobileViewportProvider.browser.test.tsx`
- `apps/web/src/lib/mobileViewport/mobileSafeArea.browser.test.tsx`
- `apps/web/src/components/workspace/PaneShell.mobileViewport.browser.test.tsx`
- `apps/web/src/components/reader/MobileReaderPositionRibbon.browser.test.tsx`
- the existing reader/PDF browser component proofs
- `apps/web/e2e/journeys/mobile-reader-bottom-geometry.journey.spec.ts`

Update only the adjacent module and cutover docs needed to remove the old
placement and fixed-Player claims:

- `docs/cutovers/mobile-reader-position-ribbon-hard-cutover.md`
- `docs/cutovers/android-webview-system-insets-hard-cutover.md`
- `docs/modules/workspace.md`
- `docs/modules/reader-implementation.md`

Preserve the separate scroll-chrome council plan.

## Hard-cut deletions

Delete with no alias or compatibility export:

- `registerFixedObstruction` and `MobileFixedObstructionId`;
- Player's fixed-obstruction registration semantics;
- ribbon use of `--mobile-content-bottom-clearance`;
- `--mobile-reader-paint-bottom-inset`;
- bespoke reader `content - nexus` clearance formulas;
- duplicate CSS-length readers or raw safe-area reads outside `globals.css`;
- dead geometry tests, residue docs, and obsolete “mobile no rail” wording;
- any fallback based on scrollbar ratio, Android bar height, player presence,
  or approximate viewport percentage.

Do not retain old and new variables or APIs during migration.

## Non-goals

- No Android native code, WebView version bridge, or inset fallback.
- No new player progress behavior or playback semantics.
- No reader completion, percentage text, scrubbing, seeking, or accessibility
  control redesign.
- No `100vh`/`100dvh` replacement project, CSS Anchor Positioning, Scroll
  Timeline, ML, velocity prediction, or animation redesign.
- No backend, API, persistence, schema, URL, analytics, or feature flag.
- No desktop rail or mobile scroll-chrome motion redesign.

## Acceptance criteria

### Geometry

- With no Player, ribbon bottom equals the registered content surface bottom
  within 1 CSS px.
- With a flow Player, reader layout accounts for Player exactly once.
- Nexus protects terminal content but never raises the ribbon.
- A fixed overlay or keyboard changes local terminal clearance only; the ribbon
  may be covered by that surface.
- Three-button and gesture navigation produce no extra gap or unsafe terminal
  content.
- Rotation, resize, IME, and visual-viewport changes leave no stale CSS values.

### Lifecycle and ownership

- Every surface registration has one owner and one idempotent cleanup.
- No duplicate registration succeeds.
- Player dismissal and root-text-entry suspension leave no Player geometry.
- Provider unmount removes all inline geometry variables and observers.
- `MobileChromeProvider` remains the sole motion/lock owner.

### Presentation and semantics

- Exact semantic range drives the ribbon; missing range removes it.
- The ribbon is noninteractive and absent from the accessibility tree.
- Player progress remains player-owned.
- Desktop rail and reader progress persistence remain unchanged.

### Proof

- Pure projection tests fail against the current full-clearance/local-surface
  defect before the implementation is accepted.
- Browser component proofs assert real bounding rectangles and computed CSS,
  not class names or registration call counts.
- The mobile journey uses trusted touch/scroll and production-shaped wiring; it
  does not mutate `scrollTop`, dispatch synthetic scroll events, or manually
  blur focus.
- Physical proof runs the authenticated `app.nexus.android` app on the Android
  device in three-button and gesture navigation, with Player absent/present and
  rotation/IME coverage.
- Final residue search finds no old API, token, subtraction formula, fallback,
  or contradictory documentation.

## Implementation order

1. Add failing projection and lifecycle proofs, including a sensitivity case for
   the current coordinate mismatch.
2. Extract the single CSS-length boundary helper.
3. Hard-cut provider API, model outputs, event coalescing, and cleanup.
4. Migrate content-surface registration and terminal padding.
5. Migrate MiniPlayer and Nexus registration semantics.
6. Move the ribbon to reader-bottom paint placement and delete old tokens.
7. Run browser, residue, type, lint, and real-app Android proofs.
8. Update adjacent docs to final state; do not alter the separate scroll-chrome
   plan unless implementation discovers a direct contract conflict.

If implementation discovers a conflict, stop and amend this document before
adding a branch.
