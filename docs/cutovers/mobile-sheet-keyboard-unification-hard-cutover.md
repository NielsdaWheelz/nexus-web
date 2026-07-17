# Mobile sheet & keyboard unification hard cutover

## Status

Spec written 2026-06-09. Implemented 2026-06-09. Verified 2026-06-09:
typecheck/lint/css-tokens clean; unit 744/744; browser 943/943; `next build`
+ bundle budget green (102 kB gz ≤ 115 kB); mobile e2e (`mobile-sheets.spec.ts`)
plus the palette and conversations canary specs green via `make test-e2e`.

AC-20 manual device checklist: deferred — requires the physical primary
device; not yet executed.

This is a hard-cutover plan. It does not preserve legacy behavior, compatibility
branches, per-component sheet geometry, or best-effort fallbacks. At the end of
this cutover there is exactly one mobile bottom-sheet owner and exactly one
keyboard-geometry owner, and every per-component copy of that machinery is
deleted.

This is the follow-up cutover that
`docs/cutovers/mobile-workspace-right-edge-hard-cutover.md` explicitly
scheduled:

> Create a shared `MobileSheet` or `ModalSurface` primitive for overlay
> geometry and token usage. Migrate all mobile sheets to that primitive in one
> separate hard cutover. Delete duplicated local sheet geometry after
> migration.

**Historical note (2026-07-16):** `lectern-player-lifecycle-hard-cutover.md`
deleted the queue panel this doc's `GlobalPlayerQueuePanel` references
describe (the "untouched desktop side panel" claims below, incl. the table
entry, AC-13, and N2). The panel it names was later renamed
`GlobalPlayerConsumptionPanel` and is now deleted outright — the Lectern pane
is the sole full-list editor and the footer has no list/dialog. Those
references describe the pre-cutover surface and are retained as historical
record only.

## Summary

The mobile chat drawer (`MobileSecondaryPaneHost`, hosting the
`reader-doc-chat` surface and its `ChatComposer`) sits behind the on-screen
keyboard: the sheet is a `position: fixed` flex-end layer sized in `dvh`, and
neither `fixed` nor `dvh` reacts to the virtual keyboard on iOS Safari (or on
Android since Chrome 108 made visual-only resize the default). The codebase
already contains the correct mechanism — `useKeyboardInset` driven by
`visualViewport`, consumed by `PaletteSheet` — but it is applied to exactly one
of six near-identical bottom-sheet implementations.

This cutover:

1. Declares keyboard intent at the platform layer
   (`interactiveWidget: "resizes-content"` in the root viewport export), which
   makes the keyboard an ordinary layout resize on Android/Firefox with zero
   JS.
2. Hardens `useKeyboardInset` into the single iOS keyboard-geometry shim
   (threshold, clamp) and makes it private to the sheet primitive.
3. Builds one `MobileSheet` primitive owning all bottom-sheet geometry and
   behavior: portal, scrim, grabber + drag-to-dismiss, keyboard avoidance
   (shrink, not translate-only), safe-area padding, history (back-button)
   dismissal, and the `useDialogOverlay` modal contract.
4. Migrates all five bottom sheets onto it — `MobileSecondaryPaneHost`,
   `PaletteSheet`, `AddContentTray` (mobile path), `GlobalPlayerFooter`
   expanded sheet, `ModelSettingsPopover` (mobile path) — and deletes their
   local geometry.
5. Adds `useHistoryDismiss` to `NavSheet` (which keeps its own side-drawer
   geometry; see Key decisions).
6. Locks the consolidation in with an ESLint import guard and grep-based
   negative acceptance criteria.

No feature flag. No compatibility branch. No per-sheet keyboard listeners.

## SME framing

The wrong question is "how do I fix this sheet." The right questions, and the
answers this spec commits to:

- **Who owns keyboard geometry?** One owner. Keyboard occlusion is an
  environment capability, like safe-area insets — measured once, exposed
  declaratively, consumed by every pinned-to-bottom surface. Today it is a
  per-component choice, which is why one sheet works and five don't.
- **Shrink or translate?** Shrink. Translating a sheet up by the keyboard
  height pushes its top edge past the visual viewport when the sheet is at max
  height. The sheet's height budget must also be reduced by the inset so all
  content (including the chat transcript) stays reachable and scrollable. This
  is the load-bearing insight from Vaul's drawer implementation.
- **Where does the platform end and the shim begin?** The
  `interactive-widget=resizes-content` viewport key solves Android/Firefox at
  the declaration layer (the layout viewport resizes; flex layouts and `dvh`
  just work). iOS Safari supports neither that key nor keyboard env vars
  through Safari 26.x, so a `visualViewport`-based JS inset remains the iOS
  shim. The two compose: where the platform resizes the layout, the measured
  inset is ~0 and the shim is inert.
- **Why does the chat transcript need no new code?** `useChatScroll` already
  re-pins via `ResizeObserver` on the scrollport. Keyboard avoidance done as
  *container shrink* flows through that exact code path — the keyboard, a new
  message, and a streaming token are all "the container changed size." That is
  the property that makes this architecture robust, and it is why translate-only
  approaches are rejected.
- **One sheet or six?** One. The right-edge cutover catalogued six duplicate
  sheet geometries and scheduled this consolidation. Fixing only the chat
  drawer would create a seventh variant and guarantee the next sheet ships
  broken.

Explicitly rejected lab-only hacks (none of these may appear in the
implementation): `--vh`-style `window.innerHeight` CSS polyfills,
`setTimeout`-after-focus `scrollIntoView`, `maximum-scale=1` zoom suppression,
global `touchmove` `preventDefault`, UA sniffing, and the VirtualKeyboard API
(Chromium-only; its env vars are buggy beyond `keyboard-inset-height`).

## Problem statement

Observed defects:

1. **Composer behind keyboard.** `MobileSecondaryPaneHost.module.css` builds
   the sheet as `position: fixed; inset: 0` backdrop + `align-items: flex-end`
   + `max-height: min(80dvh, 640px)`. The keyboard shrinks only the visual
   viewport; the layout viewport, `dvh`, and `fixed` positioning do not move.
   The sheet's bottom edge — where `ChatComposer` renders — stays at the
   layout-viewport bottom, exactly behind the keyboard.
2. **Back button leaves the page instead of closing the drawer.** Only the
   command palette wires `useHistoryDismiss`. Every other sheet lets the
   Android/browser back button navigate away while open.
3. **Inconsistent affordances and geometry.** Grabber: palette yes (36×4),
   tray yes (44×4), player yes (44×4), secondary host no, model settings no.
   Drag-to-dismiss: palette only. Safe-area bottom padding: three different
   formulas, secondary host none. Radius: `--radius-2xl` in three sheets,
   `--radius-lg` in the secondary host, `--radius-xl` in model settings.
   Entry animation: two different keyframe sets. Scrim: `--overlay-scrim` vs
   `--overlay-scrim-soft` without a stated rule. Z-index: tokens in five
   sheets, hardcoded `z-index: 1000` in `ModelSettingsPopover.module.css`.
4. **Hand-rolled hook composition.** `AddContentTray` and
   `ModelSettingsPopover` compose `useBodyOverflowLock` + `useFocusTrap` +
   `useReturnFocus` + `useInitialFocus` + escape handling by hand instead of
   `useDialogOverlay`, drifting from the documented modal contract.
5. **Single-consumer capability.** `useKeyboardInset` exists, is tested, and
   is consumed by exactly one of the six sheets.

## Target behavior

After the cutover, on a real phone:

- Opening the chat drawer and focusing the composer raises the composer above
  the keyboard. The sheet's visible height shrinks by the keyboard inset; the
  transcript remains scrollable; `useChatScroll`'s pin keeps the latest
  message in view through the resize.
- The same holds for every bottom sheet with a text input (palette omni-input,
  Add Content URL field, model settings inputs).
- The hardware/gesture back button closes the topmost open sheet (any of the
  five bottom sheets, or the nav drawer) instead of navigating away. Closing a
  sheet via its own UI never eats a real history entry.
- Every bottom sheet has the same affordances: grabber, drag-down-to-dismiss
  (≥96 px, disabled under `prefers-reduced-motion: reduce`), backdrop tap
  dismissal, Escape, focus trap + restore, body scroll lock, safe-area bottom
  padding, one entry animation, one radius, token-sourced scrim/shadow/z-index.
- On Android (Chromium/Firefox), keyboard avoidance happens with zero JS via
  the resized layout viewport; the JS inset measures ~0. On iOS the JS inset
  carries the keyboard height. No code path branches on user agent.

## Final architecture

```
apps/web/src/app/layout.tsx
  viewport.interactiveWidget = "resizes-content"      ← platform declaration

apps/web/src/lib/ui/useKeyboardInset.ts               ← iOS keyboard shim (hardened)
  visualViewport resize+scroll → max(0, innerHeight − vv.height − vv.offsetTop)
  → 0 below KEYBOARD_INSET_THRESHOLD_PX
  importable ONLY by MobileSheet (ESLint guard)

apps/web/src/components/ui/MobileSheet.tsx            ← the single bottom-sheet owner
apps/web/src/components/ui/MobileSheet.module.css
  portal → backdrop (scrim, tap-dismiss)
         → panel  (role=dialog, grabber, drag-dismiss,
                   --keyboard-inset consumption: bottom offset + height clamp,
                   safe-area padding, entry animation, tokens)
  composes: useDialogOverlay (modal contract: lock/trap/restore/Escape)
            useHistoryDismiss (back button; on by default)
            useKeyboardInset

Call sites (content only, zero geometry):
  workspace/MobileSecondaryPaneHost.tsx   → MobileSheet(scrim="soft", layer="overlay")
  palette/PaletteSheet.tsx                → MobileSheet(layer="palette", skin=glass)
  AddContentTray.tsx (mobile branch)      → MobileSheet(layer="modal")
  GlobalPlayerFooter.tsx (expanded)       → MobileSheet(layer="overlay")
  chat/ModelSettingsPopover.tsx (mobile)  → MobileSheet(scrim="soft", layer="modal")

Out of family (documented):
  appnav/NavSheet.tsx                     → keeps side-drawer geometry;
                                            gains useHistoryDismiss
  GlobalPlayerQueuePanel                  → desktop side panel; untouched
  FloatingActionSurface                   → non-modal owner per docs/modules/chat.md;
                                            keeps its own visualViewport handling
```

The keyboard signal flows in one direction with no cycles:

```
OS keyboard
  → (Android) layout viewport resize → dvh/flex reflow      [no JS]
  → (iOS) visualViewport resize → useKeyboardInset
      → MobileSheet sets --keyboard-inset on the panel
          → CSS: bottom offset + max-height clamp (shrink)
              → panel ResizeObserver consumers re-layout
                  (useChatScroll re-pins the transcript — existing code)
```

## Capability contract

### `useKeyboardInset` — keyboard-geometry owner

- Sole source of keyboard occlusion in app code. Formula unchanged:
  `max(0, window.innerHeight − visualViewport.height − visualViewport.offsetTop)`,
  subscribed via `useSyncExternalStore` on `window` resize +
  `visualViewport` resize/scroll. SSR → 0.
- New: values below `KEYBOARD_INSET_THRESHOLD_PX = 60` report 0. Rationale:
  browser-chrome geometry noise and the iOS 26.0 regression where
  `visualViewport.height` stayed ~24 px stale after keyboard close (WebKit
  bug 297779) must not leave sheets floating above the bottom edge. 60 px is
  the threshold Vaul converged on; no real keyboard is shorter.
- Importable only from `MobileSheet.tsx`. `FloatingActionSurface` keeps its
  own raw `visualViewport` reads — it is the documented *non-modal* owner
  (docs/modules/chat.md) and clamps to viewport rects, a different concern.

### `MobileSheet` — bottom-sheet owner

Owns, for every mobile bottom sheet in the app:

- Portal to `document.body`.
- Backdrop: fixed full-viewport layer, scrim token, tap-to-dismiss
  (`onClick={onDismiss}` on the scrim, `stopPropagation` on the panel — the
  portal-safe pattern from dialog-overlay-hook-unification §9; outside-click
  is intentionally not owned by `useDialogOverlay`).
- Panel: `role="dialog"`, `aria-modal="true"`, label, `tabIndex={-1}`, flex
  column, `width: 100%`, top-corner radius, top hairline border, shadow token,
  entry animation, `overflow: hidden` with a `min-height: 0` content slot.
- Grabber + drag-to-dismiss (pointer capture on `[data-grabber]`, live
  `translateY`, 96 px threshold, disabled under reduced motion) — lifted
  verbatim from `PaletteSheet`.
- Keyboard avoidance: writes `--keyboard-inset` on the panel; CSS consumes it
  twice (see API design): once to lift the panel above the keyboard, once to
  clamp the height budget so the top edge never leaves the visual viewport.
- Safe-area: `padding-bottom: max(var(--space-2), env(safe-area-inset-bottom))`
  on the panel.
- Modal contract via `useDialogOverlay` (body scroll lock, focus trap, initial
  focus, return focus, Escape).
- Back-button dismissal via `useHistoryDismiss`, on by default.

`MobileSheet` does not own: open/close state (caller's), content, desktop
variants, side-drawer geometry, non-modal surfaces, snap points.

**Mount contract (load-bearing):** `useHistoryDismiss` must stay mounted
across the overlay's open/close cycle (its own doc comment, C7). Therefore
`MobileSheet` itself stays mounted and gates rendering internally on `active`
— hooks first, conditional portal after. Callers must render `<MobileSheet>`
unconditionally (where the component is mounted at all) and drive it with
`active`, never `open && <MobileSheet …>`. `AddContentTray`
(`if (!open) return null` today) and `CommandPalette` (conditionally renders
the sheet) are restructured accordingly in their slices.

### `RenderEnvironmentProvider` — viewport classification (unchanged)

Stays the single breakpoint source (`(max-width: 768px)`), per
docs/cutovers/mobile-workspace-right-edge-hard-cutover.md. `MobileSheet` does
not classify viewports; callers decide when the sheet presentation applies
(they already do).

### `useChatScroll` — transcript pinning (unchanged, one hardening)

Already resilient: `ResizeObserver` on scrollport + transcript re-pins on any
container resize, which now includes keyboard-driven shrink. One hardening:
set `overflow-anchor: none` on the transcript scrollport
(`ChatSurface.module.css` `.scrollport`) because the pin logic self-manages
anchoring; native scroll anchoring on Chromium/Firefox can double-correct
during keyboard resizes.

## API design

```tsx
// apps/web/src/components/ui/MobileSheet.tsx
interface MobileSheetProps {
  /** Render/behavior gate. The component must stay mounted; gate with this. */
  active: boolean;
  /** Backdrop tap, drag-past-threshold, back button. */
  onDismiss: () => void;
  /** Escape override (default: onDismiss). Palette uses this to pop a level. */
  onEscape?: () => void;
  ariaLabel: string;
  children: ReactNode;

  /** Z-layer token. Default "modal". */
  layer?: "overlay" | "modal" | "palette";
  /** Scrim token. Default "default" (--overlay-scrim); "soft" for context sheets. */
  scrim?: "default" | "soft";
  /** Grabber + drag-to-dismiss. Default true. */
  grabber?: boolean;
  /** Back-button dismissal. Default true. */
  historyDismiss?: boolean;

  /** Forwarded to useDialogOverlay. */
  initialFocus?: (container: HTMLElement) => HTMLElement | null;
  returnFocusFallback?: () => HTMLElement | null;
  focusKey?: unknown;

  /** Skin on the panel (e.g. palette glass). Geometry stays in MobileSheet.module.css. */
  panelClassName?: string;
  /** Stable test ids for backdrop/panel (existing tests keep their selectors). */
  backdropTestId?: string;
  panelTestId?: string;
}
```

Render shape:

```tsx
const inset = useKeyboardInset();
useDialogOverlay({ ref: panelRef, active, onDismiss: onEscape ?? onDismiss, initialFocus, returnFocusFallback, focusKey });
useHistoryDismiss(active && historyDismiss, onDismiss);
if (!active) return null;
return createPortal(
  <div className={styles.backdrop} data-layer={layer} data-scrim={scrim} role="presentation" onClick={onDismiss}>
    <section
      ref={panelRef}
      className={cx(styles.panel, panelClassName)}
      role="dialog" aria-modal="true" aria-label={ariaLabel} tabIndex={-1}
      style={{ "--keyboard-inset": `${inset}px` }}
      onClick={(e) => e.stopPropagation()}
      {...dragHandlers /* active only when grabber */}
    >
      {grabber ? <div className={styles.grabber} data-grabber aria-hidden="true" /> : null}
      <div className={styles.content}>{children}</div>
    </section>
  </div>,
  document.body,
);
```

Geometry CSS (the heart of the keyboard fix — shrink AND lift):

```css
.panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  /* Lift above the keyboard (iOS shim; ~0 where the platform resized the layout). */
  bottom: var(--keyboard-inset, 0px);
  /* Height budget: caller-tunable dvh/px caps, ALWAYS clamped by the visible
     viewport minus the keyboard so the top edge never overflows. dvh does not
     react to the keyboard on iOS — the calc() term is what carries it there. */
  max-height: min(
    var(--mobile-sheet-max-size, 85dvh),
    var(--mobile-sheet-max-size-cap, 720px),
    calc(100dvh - var(--keyboard-inset, 0px) - var(--space-6))
  );
  border-top: 1px solid var(--edge-subtle);
  border-radius: var(--radius-2xl) var(--radius-2xl) 0 0;
  background: var(--surface-canvas);
  box-shadow: var(--shadow-4);
  padding-bottom: max(var(--space-2), env(safe-area-inset-bottom));
  overflow: hidden;
  animation: mobileSheetIn var(--duration-base) var(--ease-bloom);
}
.content { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.backdrop { position: fixed; inset: 0; display: flex; align-items: flex-end; justify-content: center; }
.backdrop[data-layer="overlay"] { z-index: var(--z-overlay); }
.backdrop[data-layer="modal"]   { z-index: var(--z-modal); }
.backdrop[data-layer="palette"] { z-index: var(--z-palette); }
.backdrop[data-scrim="default"] { background: var(--overlay-scrim); }
.backdrop[data-scrim="soft"]    { background: var(--overlay-scrim-soft); }
@keyframes mobileSheetIn { from { transform: translateY(100%); } }
@media (prefers-reduced-motion: reduce) { .panel { animation: none; } }
```

Notes:

- No `transition` on `bottom`/`max-height`: `visualViewport` resize fires
  after the keyboard animation settles; animating the catch-up fights
  subsequent geometry events. Accept the single jump (what Vaul and the
  palette do today).
- Callers needing a different size budget set `--mobile-sheet-max-size` /
  `--mobile-sheet-max-size-cap` via `panelClassName`. No size props.
- Scrollable content inside sheets keeps `overscroll-behavior: contain` (it
  already does in ChatSurface / palette list / tray body).
- Inner inputs stay ≥16 px font-size (existing global + palette rule; iOS
  zoom-on-focus prevention).

## Files in scope

### Runtime files

| File | Change |
| --- | --- |
| `apps/web/src/app/layout.tsx` | Add `interactiveWidget: "resizes-content"` to the `viewport` export. |
| `apps/web/src/lib/ui/useKeyboardInset.ts` | Add `KEYBOARD_INSET_THRESHOLD_PX = 60`; values below it report 0; expand doc comment (iOS-shim role, WebKit 297779 clamp rationale). |
| `apps/web/src/components/ui/MobileSheet.tsx` | **New.** The primitive. |
| `apps/web/src/components/ui/MobileSheet.module.css` | **New.** All bottom-sheet geometry. |
| `apps/web/src/components/workspace/MobileSecondaryPaneHost.tsx` | Rewrite as a `MobileSheet` caller: header (tabs + close) and tabpanel body become children; keep `active` derivation, `initialFocus`, `returnFocusFallback`, `focusKey`, test ids. Delete the unused `mobileBody` branch (see Key decisions). |
| `apps/web/src/components/workspace/MobileSecondaryPaneHost.module.css` | Delete backdrop/sheet geometry; keep only header/body content rules. |
| `apps/web/src/components/workspace/PaneSecondary.tsx` | Remove the never-published `mobileBody` field from `PaneSecondaryPublication`. |
| `apps/web/src/components/palette/PaletteSheet.tsx` | Rewrite as a `MobileSheet` caller (`layer="palette"`, glass `panelClassName`, `onEscape` = page-aware back/close, `initialFocus` combobox). Drag/grabber/portal/inset code deleted (now in the primitive). |
| `apps/web/src/components/palette/CommandPalette.tsx` | Drop its `useHistoryDismiss` wiring (the sheet owns it); keep `PaletteSheet` mounted with `active` instead of conditional render on mobile. |
| `apps/web/src/components/palette/palette.module.css` | Delete `.sheet` geometry + `paletteSheetIn` + `.grabber`; keep the glass skin as a panel-skin class. |
| `apps/web/src/components/AddContentTray.tsx` | Mobile branch becomes a `MobileSheet` caller; delete the five hand-composed micro-hooks for the mobile path (desktop panel keeps its own dismissal); restructure so the sheet stays mounted (`active={open && isMobile}`). |
| `apps/web/src/components/AddContentTray.module.css` | Delete `.mobileBackdrop`/`.mobileSheet`/`.handle`/`mobileSheetSlideIn`. |
| `apps/web/src/components/GlobalPlayerFooter.tsx` | Expanded mobile sheet becomes a `MobileSheet` caller (`layer="overlay"`); its `useDialogOverlay` call and backdrop markup deleted. |
| `apps/web/src/components/GlobalPlayerFooter.module.css` | Delete `.expandedBackdrop`/`.expandedSheet` geometry/`.expandedHandle`/`expandedSheetSlideIn`; keep expanded-content rules. |
| `apps/web/src/components/chat/ModelSettingsPopover.tsx` | Mobile path becomes a `MobileSheet` caller (`scrim="soft"`, `grabber` default); desktop popover path unchanged (keeps `useDismissOnOutsideOrEscape`); the five hand-composed mobile micro-hooks deleted. |
| `apps/web/src/components/chat/ModelSettingsPopover.module.css` | Delete the `data-mobile` fixed-layer/backdrop rules incl. hardcoded `z-index: 1000`; keep desktop popover + panel content rules. |
| `apps/web/src/components/appnav/NavSheet.tsx` | Add `useHistoryDismiss(open, onClose)` (hook mounted in `AppNav` if `NavSheet` unmounts when closed — same mount contract). Geometry untouched. |
| `apps/web/src/components/chat/ChatSurface.module.css` | Add `overflow-anchor: none` to `.scrollport` (pin logic self-manages anchoring). |
| `apps/web/eslint.config.mjs` | New `no-restricted-imports` entry: `@/lib/ui/useKeyboardInset` banned everywhere except `src/components/ui/MobileSheet.tsx`, message pointing at this spec (same mechanism as the `next/image`/MediaImage ban). |

### Test files

| File | Change |
| --- | --- |
| `apps/web/src/components/ui/MobileSheet.test.tsx` | **New.** Full primitive contract (see Test design). |
| `apps/web/src/lib/ui/useKeyboardInset.test.tsx` | Add threshold cases (59 → 0, 60 → 60), stale-residue case (~24 px → 0). |
| `apps/web/src/components/workspace/MobileSecondaryPaneHost.test.tsx` | Keep behavioral assertions (overflow lock, escape, trap, restore, tabs); selectors survive via `backdropTestId`/`panelTestId`; add back-button-dismiss + keyboard-inset assertions. |
| `apps/web/src/components/palette/PaletteSheet.test.tsx` | Keep (grabber, drag threshold, reduced motion, popstate close, combobox focus); assertions now exercise the primitive through the palette. |
| `apps/web/src/__tests__/components/AddContentTray.test.tsx` | Update for sheet-stays-mounted restructure; add back-button-dismiss case. |
| `apps/web/src/__tests__/components/GlobalPlayerFooter.test.tsx` | Same. |
| `apps/web/src/components/chat/ModelSettingsPopover.test.tsx` | **New** (currently untested): desktop popover dismissal + mobile sheet contract. |
| `apps/web/src/components/appnav/NavSheet.test.tsx` | Add back-button-dismiss case. |
| `e2e/tests/mobile-sheets.spec.ts` | **New**, 390×844 + `hasTouch`: open chat drawer → back button closes it and stays on page; geometry assertion per the right-edge cutover convention (panel bounding box within viewport). |

### Documentation files

| File | Change |
| --- | --- |
| `docs/modules/workspace.md` | `MobileSecondaryPaneHost` section: presentation now via the shared `MobileSheet` primitive; the "only workspace mobile secondary presentation" rule stands. |
| `docs/modules/chat.md` | Note `ModelSettingsPopover` mobile path uses `MobileSheet`; `FloatingActionSurface` non-modal ownership unchanged. |
| `docs/modules/overlays.md` (or the closest existing UI-primitives doc; create if absent) | `MobileSheet` capability contract, mount contract, the keyboard-geometry ownership rule, and the rejected-hacks list. |

## Existing patterns to reuse

- `useDialogOverlay` — the modal contract, used as-is. Backdrop-onClick
  dismissal stays caller-side (portal-safe pattern, dialog-overlay §9).
- `useHistoryDismiss` — used as-is, including the microtask navigating-close
  guard. The mount contract it documents becomes `MobileSheet`'s mount
  contract.
- `useKeyboardInset` — formula and `useSyncExternalStore` shape kept; only
  threshold + ownership change.
- `PaletteSheet`'s drag-to-dismiss pointer logic (capture on `[data-grabber]`,
  `DRAG_DISMISS_PX = 96`, reduced-motion gate) — lifted verbatim into the
  primitive.
- Token system: `--z-overlay/modal/palette`, `--overlay-scrim(-soft)`,
  `--shadow-4`, `--radius-2xl`, `--duration-base`, `--ease-bloom`,
  `env(safe-area-inset-bottom)`.
- ESLint single-sanctioned-importer guard — same mechanism as the
  MediaImage/`next/image` ban (R1).
- Test conventions: browser project in real Chromium; role/label queries;
  `withRenderEnvironment(..., { initialViewport: "mobile" })`; the
  EventTarget-based `visualViewport` stub from `useKeyboardInset.test.tsx`;
  the `history` spy pattern from `useHistoryDismiss.test.tsx`.

## Duplicate patterns being deleted

The geometry catalogued in the right-edge cutover, now actually removed:

| Source | Deleted rules |
| --- | --- |
| `MobileSecondaryPaneHost.module.css` | `.backdrop`, `.sheet` (fixed layer, flex-end, `min(80dvh, 640px)`, radius, shadow) |
| `palette.module.css` | `.sheet`, `.grabber`, `paletteSheetIn`, sheet-variant backdrop geometry |
| `AddContentTray.module.css` | `.mobileBackdrop`, `.mobileSheet`, `.handle`, `mobileSheetSlideIn` |
| `GlobalPlayerFooter.module.css` | `.expandedBackdrop`, `.expandedSheet` geometry, `.expandedHandle`, `expandedSheetSlideIn` |
| `ModelSettingsPopover.module.css` | `data-mobile` fixed layer, `.settingsBackdrop`, hardcoded `z-index: 1000`, mobile max-height calc |
| `AddContentTray.tsx`, `ModelSettingsPopover.tsx` | Hand-composed micro-hook stacks for the mobile-modal contract |
| `PaletteSheet.tsx` | Local portal, drag handlers, grabber markup, inset wiring |
| `CommandPalette.tsx` | Sheet-specific `useHistoryDismiss` wiring |

`AppNav.module.css` sheet rules stay: NavSheet is a side drawer, not a bottom
sheet (Key decisions).

## Key decisions

### Decision: shrink + lift, not lift alone

`bottom: var(--keyboard-inset)` alone (PaletteSheet today) pushes the panel's
top edge past the visual viewport whenever the sheet is at max height — the
grabber and header become unreachable. The `calc(100dvh − inset − margin)`
clamp in `max-height` is mandatory and is the actual fix for "content above
the composer is unreachable while typing." The transcript pin
(`useChatScroll`) absorbs the shrink automatically.

### Decision: `interactive-widget` at the root, app-wide

`resizes-content` changes keyboard behavior for the whole app on
Android/Firefox (any focused input resizes the layout viewport), not just for
sheets. That is the desired behavior — the inline chat pane's composer rides
up too, and the existing flex/`min-height: 0`/`dvh` layout is already built
for layout-viewport resizes (it handles URL-bar changes today). iOS ignores
the key. No per-surface opt-outs.

### Decision: the JS inset is a hook + inline CSS var, not a `:root` global

A document-level `--keyboard-inset` writer (singleton effect on `:root`) was
considered and rejected: exactly one component family consumes the value, the
`useSyncExternalStore` hook is already SSR-safe and shared-subscription-cheap,
and a root global invites ad-hoc consumers — the precise failure mode this
cutover deletes. If a second legitimate consumer family ever appears, promote
it then; the ESLint guard marks the spot.

### Decision: threshold 60 px inside the hook

Noise from bottom browser chrome and the iOS 26.0 stale-`visualViewport`
regression (~24 px residue) must not leave sheets hovering. 60 px (Vaul's
constant) is far below any real keyboard and far above observed noise. Placing
it in the hook (not per-caller) keeps the capability contract single-owner.

### Decision: NavSheet keeps its own geometry, gains history dismissal

NavSheet is a left-anchored, full-height, `translateX` drawer — a different
interaction model sharing no geometry with bottom sheets. Forcing it into
`MobileSheet` would mean axis/anchor props the other five callers never use
(speculative generality). It already uses `useDialogOverlay` and the portal
pattern correctly; the only gap is back-button dismissal, which it gains
directly. The queue panel (desktop right panel) is untouched.

### Decision: `useDialogOverlay` stays the modal contract; MobileSheet wraps it

`MobileSheet` does not absorb or re-implement the modal contract — it composes
the hook, exactly as the workspace docs mandate ("uses `useDialogOverlay` for
focus trap, focus restore, Escape handling, and body scroll lock"). Desktop
overlays (PaletteSurface, queue panel, NavSheet) keep using the hook directly.

### Decision: unify visuals to the majority geometry

One radius (`--radius-2xl`), one shadow (`--shadow-4`), one safe-area formula
(`max(var(--space-2), env(safe-area-inset-bottom))`), one entry animation
(full `translateY(100%)` slide, `--duration-base`/`--ease-bloom`,
reduced-motion → none), one default size budget (`min(85dvh, 720px)`,
CSS-var-tunable). This visibly changes the secondary host (lg→2xl radius, new
animation, slightly larger budget) and model settings (full-bleed sheet
instead of a 480 px inset card). Accepted: visual unification is a goal of the
consolidation, and per-sheet bespoke geometry is what this cutover deletes.
Scrim stays a two-value semantic choice: `soft` for in-context companion
sheets (secondary surfaces, model settings), `default` for app-level modals
(tray, player, palette) — matching current usage, now stated as a rule.

### Decision: delete `PaneSecondaryPublication.mobileBody`

Defined, rendered (`activeSurface.mobileBody ?? activeSurface.body`), and
published by nobody. Dead optionality; desktop and mobile share surface bodies
by design (docs/modules/workspace.md). Removed rather than carried.

### Decision: no Vaul, no native `<dialog>`, no VirtualKeyboard API

Vaul would import a second overlay system alongside `useDialogOverlay` for one
behavior (drag) the palette already implements in ~15 lines. Native `<dialog>`
/ popovers were already ruled out by the dialog-overlay cutover (portal
landmine). The VirtualKeyboard API is Chromium-only with broken env vars
beyond `keyboard-inset-height`; `interactive-widget` covers the same browsers
declaratively. Revisit only if iOS ships keyboard env vars.

## Implementation plan

Each slice leaves the tree green (typecheck, lint, unit, browser).

1. **Platform + hook groundwork.** `interactiveWidget` in `layout.tsx`
   (assert in `layout.test.ts` alongside the existing `viewportFit` check);
   `useKeyboardInset` threshold + tests; `overflow-anchor: none` on the chat
   scrollport.
2. **`MobileSheet` primitive + tests.** Component, CSS, full
   `MobileSheet.test.tsx`. Nothing consumes it yet.
3. **Migrate `MobileSecondaryPaneHost`** (the headline bug). Includes the
   `mobileBody` deletion and `PaneSecondary.tsx` type change. Update its
   tests; run the workspace/chat browser suites.
4. **Migrate `PaletteSheet` + rewire `CommandPalette`.** `onEscape`
   page-aware dismissal; glass skin via `panelClassName`; sheet stays mounted;
   palette history wiring moves into the primitive. Palette DOM contract
   (roles/labels) must not change — `reference_palette_dom_contract` selectors
   are load-bearing for e2e.
5. **Migrate `AddContentTray` mobile path** (incl. mounted-restructure and
   micro-hook deletion; desktop Escape behavior preserved).
6. **Migrate `GlobalPlayerFooter` expanded sheet.**
7. **Migrate `ModelSettingsPopover` mobile path** + new test file.
8. **`NavSheet` history dismissal** + test.
9. **Guards + deletion sweep.** ESLint `useKeyboardInset` restriction; delete
   all CSS listed in "Duplicate patterns being deleted"; run the grep gates
   (below) and fix any stragglers.
10. **Docs + full verify.** Module docs; `cd apps/web && bun run typecheck &&
    bun run lint && bun run test` (unit + browser projects); `next build` +
    bundle check (CSS-module purity has broken builds before — run it);
    mobile e2e spec; manual device checklist.

## Acceptance criteria

### Functional

- AC-1: With a stubbed `visualViewport` reporting a 300 px keyboard, the open
  chat drawer's panel computes `bottom: 300px` and a `max-height` no greater
  than `100dvh − 300px − var(--space-6)` (browser test asserts the inline
  `--keyboard-inset` value and resolved geometry).
- AC-2: With inset 0 (or below threshold), panel geometry equals the
  keyboard-closed state exactly — no residual offset.
- AC-3: For each of the five bottom sheets and NavSheet: dispatching
  `popstate` while open calls the sheet's dismiss exactly once and does not
  call `history.back()` again; closing via the sheet's own UI pops the
  synthetic entry unless the close navigated (existing `useHistoryDismiss`
  semantics, now asserted per sheet).
- AC-4: Each migrated sheet preserves its current behavioral contract: body
  overflow locked/restored, Escape dismisses (palette: pops a level on the
  actions page), backdrop tap dismisses, panel tap does not, focus moves in on
  open and restores on close, grabber drag past 96 px dismisses, drag inert
  under reduced motion.
- AC-5: `viewport` export includes `interactiveWidget: "resizes-content"`
  (unit-asserted next to the existing `viewportFit` assertion).
- AC-6: Mobile e2e (390×844, touch): open chat drawer → browser back → drawer
  closed, URL unchanged; panel bounding box within the viewport.

### Structural

- AC-7: `MobileSheet.module.css` is the only stylesheet in `apps/web/src`
  containing bottom-sheet geometry (fixed flex-end backdrop + bottom-anchored
  panel). The six per-component geometry blocks are gone.
- AC-8: `MobileSecondaryPaneHost`, `PaletteSheet`, `AddContentTray` (mobile),
  `GlobalPlayerFooter` (expanded), `ModelSettingsPopover` (mobile) contain no
  portal, scrim, grabber, drag, keyboard, history, or modal-contract code —
  content and state only.
- AC-9: `PaneSecondaryPublication` has no `mobileBody` field.

### Negative invariants (grep gates)

From repo root; all must return nothing:

- AC-10: `grep -rn "useKeyboardInset" apps/web/src --include="*.tsx" --include="*.ts" | grep -v "components/ui/MobileSheet.tsx" | grep -v "lib/ui/useKeyboardInset"` (tests of the hook itself exempt; enforced in ESLint as well).
- AC-11: `grep -rn "expandedSheet\|mobileSheet\|mobileBackdrop\|settingsBackdrop\|paletteSheetIn\|mobileSheetSlideIn\|expandedSheetSlideIn" apps/web/src --include="*.css"`.
- AC-12: `grep -rn "z-index: 1000" apps/web/src --include="*.css"` (token-only z-indexes).
- AC-13: `grep -rEn "align-items: *flex-end" apps/web/src/components --include="*.module.css"` returns only `MobileSheet.module.css` and `HoverPreview.module.css` (NavSheet/queue panel are side-anchored and do not match; if another legitimate non-sheet match exists at implementation time, list it here explicitly rather than weakening the gate). `HoverPreview.module.css` `.sheetBackdrop` is the explicit exception: HoverPreview's `(hover: none)` tap fallback is a lightweight, non-interactive preview surface outside this cutover's six-sheet scope, not a migrated modal sheet.
- AC-14: `grep -rn "DRAG_DISMISS_PX\|data-grabber" apps/web/src --include="*.tsx" | grep -v MobileSheet` returns only test files.
- AC-15: `grep -rn "useHistoryDismiss" apps/web/src --include="*.tsx" | grep -v test` returns only `MobileSheet.tsx` and the NavSheet/AppNav wiring.

### Verification

- AC-16: `cd apps/web && bun run typecheck && bun run lint` clean.
- AC-17: Full unit + browser vitest projects green.
- AC-18: `next build` + bundle budget check green (CSS purity).
- AC-19: Mobile e2e spec passes locally.
- AC-20: Manual device checklist (below) executed on the primary device and
  recorded in this file's Status line. This gate may not be silently skipped;
  if deferred, the Status line must say so explicitly.

## Test design details

### `MobileSheet.test.tsx` (browser project, real Chromium)

- Render with `withRenderEnvironment(..., { initialViewport: "mobile" })`.
- Dialog semantics: `getByRole("dialog", { name: ... })`, `aria-modal`.
- Modal contract: body overflow locked while active, restored after; focus
  trap wraps Tab; initial focus honors `initialFocus`; return focus honors
  `returnFocusFallback`; Escape calls `onEscape ?? onDismiss`.
- Dismissal: backdrop click dismisses; panel click does not; drag from
  `[data-grabber]` past 96 px dismisses, below does not; reduced-motion
  matchMedia stub disables drag (reuse PaletteSheet test approach).
- Keyboard: install the EventTarget-based `visualViewport` stub
  (`useKeyboardInset.test.tsx` pattern); assert `--keyboard-inset` inline
  value tracks resize events, threshold zeroes small values, and computed
  `bottom`/`max-height` respond (AC-1/AC-2).
- History: `vi.spyOn(history, ...)` pattern; assert push on activate, popstate
  → one dismiss, UI-close → deferred pop, navigating-close → no pop
  (delegated to `useHistoryDismiss` but asserted once through the primitive);
  assert the mount contract (hook does not re-push when `active` toggles
  without unmount).
- `historyDismiss={false}` and `grabber={false}` opt-outs.

### Per-sheet migration tests

Existing suites are behavioral (role/label queries, overflow/focus/escape
assertions) and survive largely intact; each gains a popstate-dismiss case.
`PaletteSheet.test.tsx` is the donor suite for drag semantics and must pass
unmodified in its assertions (selectors may shift to the shared test ids).
Palette e2e (`e2e/tests/command-palette.spec.ts` mobile describe) must pass
unchanged — it is the canary for the DOM contract.

### What tests cannot cover

No CI environment opens a real OS keyboard. The browser tests verify the
*math and plumbing* (stubbed `visualViewport` → geometry); only the manual
checklist verifies the *experience*. This is stated here so the gap is a
known, named gate (AC-20) rather than a silent one.

## Manual device verification (AC-20)

On the primary phone (iOS Safari is the hard case), production build:

1. Open a document → chat drawer → tap composer: keyboard opens, composer
   visible above keyboard, grabber/header still on screen, transcript
   scrollable while keyboard is open.
2. Type a message; streaming response keeps latest content pinned with
   keyboard open.
3. Dismiss keyboard: sheet returns to full budget, no residual gap above the
   home indicator (threshold check).
4. Rotate to landscape and back with the drawer open.
5. Browser/gesture back with drawer open → drawer closes, page unchanged;
   back again → actually navigates.
6. Repeat 1/3/5 for: palette sheet (omni-input), Add Content (URL field),
   model settings, expanded player; back-button check for nav drawer.
7. Drag-dismiss each sheet via grabber; verify scroll inside sheet content
   does not trigger dismissal.

## Composition with other systems

- **Workspace:** `MobileSecondaryPaneHost` remains the only workspace mobile
  secondary presentation (docs/modules/workspace.md rule unchanged); it is now
  chrome-on-`MobileSheet`. `WorkspaceHost` integration (`isMobile &&
  pane.secondaryPane` render, `onClose`/`onActiveSurfaceChange`) unchanged.
- **Chat:** `ChatSurface`/`ChatComposer`/`useChatScroll` unchanged except
  `overflow-anchor: none`. The keyboard fix reaches chat purely through its
  container shrinking — no chat-side keyboard awareness, by design.
- **Palette:** controller, lanes, input semantics, and the palette DOM
  contract untouched; only the mobile presentation shell is replaced.
  `--z-palette` layering preserved via `layer="palette"`.
- **History/URL sync:** `useHistoryDismiss`'s navigating-close microtask guard
  already coexists with workspace URL `replaceState` sync; the primitive
  inherits that behavior verbatim. Sheets that can close *by navigating*
  (palette result selection, tray "open created page") are covered by the
  existing guard.
- **FloatingActionSurface:** untouched, by contract — it is the non-modal
  action-surface owner with its own visualViewport clamping
  (docs/modules/chat.md). It is not a sheet and must not migrate.
- **Global player:** the collapsed footer bar and `--mobile-bottom-obstruction`
  are unaffected; only the expanded sheet presentation migrates.
- **First-paint/CSP:** `MobileSheet` is a client component already inside
  lazy-split pane/shell trees; no new top-level client boundary, no CSP/nonce
  interaction, no bundle-budget concern beyond the normal check.

## Non-goals

- N1. Snap points / multi-detent sheets, sheet stacking management, or a
  generic "single Escape owner" arbiter for stacked overlays (existing gap,
  unchanged by this cutover; the z-token order already encodes priority).
- N2. Migrating NavSheet's geometry or the desktop queue panel/popovers into
  `MobileSheet`.
- N3. Adopting Vaul/Radix or any overlay library.
- N4. Native `<dialog>`/popover adoption (ruled out by the dialog-overlay
  cutover; portal landmine).
- N5. VirtualKeyboard API (`overlaysContent`, `env(keyboard-inset-*)`).
- N6. PWA/standalone-mode work, scroll-driven keyboard animations, or
  `scrollend`-based settle logic.
- N7. Changing `useChatScroll`'s pinning model.
- N8. Desktop behavior changes of any kind.
- N9. A `:root`-level `--keyboard-inset` global (see Key decisions; revisit
  only with a second consumer family).

## Risks

### Risk: `interactive-widget` changes keyboard behavior app-wide on Android

Any focused input now resizes the layout viewport (URL-bar-style reflow).
Mitigation: the app shell is already built for layout-viewport resizes
(`100dvh` + flex + `min-height: 0` throughout, verified in the audit); the
manual checklist includes an Android pass if an Android device is available —
otherwise noted in Status (single-user prototype; primary device is the spec).

### Risk: sheet-stays-mounted restructure changes render timing

`AddContentTray` and `CommandPalette` currently unmount their sheets when
closed; keeping `MobileSheet` mounted changes when effects run. Mitigation:
the primitive renders `null` when inactive (only the two dismissal hooks stay
live, both built for exactly this lifecycle); existing open/close tests gate
regressions.

### Risk: visual deltas from geometry unification

Secondary host radius/animation/budget change; model settings becomes
full-bleed. Accepted intentionally (Key decisions); flagged here so screenshot
diffs aren't mistaken for bugs.

### Risk: iOS keyboard quirks the stubs can't reproduce

Autofocus races, blur-without-resize, stale `visualViewport` residue.
Mitigation: threshold + clamp in the hook; manual checklist items 1/3/4; no
transition on the inset so late geometry events can't fight an animation.

## Definition of done

All ACs green; the five bottom sheets and the nav drawer dismiss on back
button; the chat composer is demonstrably above the keyboard on the primary
device (AC-20 recorded in Status); `useKeyboardInset` has one importer;
`grep` gates return clean; module docs updated; no remaining reference to the
deleted per-sheet geometry anywhere in `apps/web/src`.
