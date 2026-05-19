# Workspace — Spatial Pane Canvas

Status: Implemented. Hard cutover: the inert pane row is replaced
outright — no flag, no fallback, no legacy path.
Scope owner: workspace pane surface (`apps/web`).
Date: 2026-05-19.

## 1. Problem

On desktop, `WorkspaceHost` lays open panes out in a horizontal flex row. The row
is a real `overflow-x: auto` scroll container — correctly sized (the implicit grid
column is clamped by the row's `min-width: 0`), genuinely scrollable — but
**nothing lets a user drive it**:

- A vertical mouse wheel scrolls *pane content*; it never reaches the row, and
  there is no wheel-to-horizontal mapping.
- A horizontal trackpad swipe reaches the row over `standard` panes, but is
  severed over reader / PDF / chat panes, whose inner scrollers set
  `overscroll-behavior: contain` — which blocks scroll-chaining in *both* axes,
  including the horizontal one the canvas needs.
- The scrollbar sits at the row's bottom edge, is overlay-hidden on macOS and
  recent Chrome, and panes fill the row edge-to-edge, so there is no empty track
  to grab.
- The pane strip's Arrow keys move roving focus between tab buttons (correct
  toolbar behaviour) — but there is no keyboard way to *pan the canvas* at all.
- Nothing signals that off-screen panes exist: no edge treatment, no overflow
  indicator, and the strip does not reflect what the canvas is showing.

The strip (`WorkspacePaneStrip`) and the row were each built as if it were the
sole navigator and were never wired together. The pane row's `overflow-x: auto`
is, in practice, dead surface.

## 2. Target behaviour

The desktop workspace is **one system, two layers**:

- **The canvas** — the pane row. The primary surface: a horizontally scrollable
  spatial strip of panes that the user pans freely. It owns scrolling and every
  affordance that drives it.
- **The strip** — `WorkspacePaneStrip`. An overview/index *onto* the canvas:
  click a tab to pan to a pane; the strip mirrors which panes the canvas shows.

The strip is not a separate place panes live — it is the thumbnail rail to the
canvas's document. "Tabs vs. canvas" is not a choice; the strip indexes the
canvas.

Mobile is out of scope and unchanged: it renders one pane, `overflow-x: hidden`,
no strip.

### 2.1 The canvas

**Free scroll, no snap.** The canvas comes to rest wherever the user releases it.
There is no `scroll-snap`. Tidiness comes from edge fades, not snap points.

**Pointer input:**

- **Horizontal wheel / trackpad** (`deltaX`) pans the canvas natively. The only
  reason it does not today is severed scroll-chaining; §5.6 fixes that. No JS.
- **`Shift` + wheel** pans the canvas natively, for the same reason. No JS.
- **Vertical wheel** is translated to a horizontal pan **only when the region
  under the pointer cannot scroll vertically at all** — a pane header, or a pane
  body whose content fits. Over a vertically-scrollable body a vertical wheel
  scrolls that body, unchanged. The translation never fires mid-scroll on a
  scrollable element.
- **Drag-to-pan from a pane header.** A primary-button press on header chrome —
  not on a header control — that moves past a small threshold begins a pan: the
  canvas follows the pointer. The cursor is `grab` on the header, `grabbing`
  while panning. Pane bodies are untouched, so text selection, links, and body
  scrolling are unaffected. A press that never crosses the threshold is a normal
  click and activates the pane as before.

**Edge fades.** When the canvas can scroll further toward an edge, a short fade on
that edge signals more panes. Neither fade ⇒ everything fits. The fades are
non-interactive (`pointer-events: none`).

### 2.2 The strip — live overview

The strip marks every pane that currently intersects the canvas viewport as
**in view**. *In view* is distinct from **active** (the one focused pane): a pane
can be in view without being active, and the active pane can be scrolled out of
view. As the canvas pans, the in-view set updates, so the strip reads as a live
minimap of the canvas.

### 2.3 Keyboard

A global, user-rebindable keybinding pans the canvas: **next pane** /
**previous pane** activate the adjacent visible pane (wrapping at the ends) and
centre it. The strip's roving Arrow-key focus is correct toolbar behaviour and is
left unchanged.

### 2.4 Activation & bring-into-view

Whenever the active pane changes — strip click, command-palette "Open tabs", a
newly opened or restored pane, or a pane-step keybinding — the canvas centres
that pane with `scrollIntoView({ inline: "center" })`. This replaces
`inline: "nearest"`, which lands a pane flush against an edge or under a
neighbour's resize handle. Under `prefers-reduced-motion` the centring is
instant; otherwise it is smooth.

## 3. Architecture

The seam is a single hook. `WorkspaceHost` stays the orchestrator; one hook —
`usePaneCanvas` — owns the canvas element, the scroll mechanics, and the
observers. The strip and `PaneShell` receive props; neither imports the hook.

```
WorkspaceHost                         orchestrator — workspace state, pane
  │                                   descriptors, pane-step keydown listener.
  │                                   Calls usePaneCanvas().
  ├── usePaneCanvas() ───────────────  owns: the canvas element ref; wheel
  │                                   translation; header drag-to-pan;
  │                                   edge-fade flags; the in-view Intersection-
  │                                   Observer; scrollPaneIntoView().
  │
  └── <section.host>  (grid: auto / minmax(0,1fr))
        ├── <WorkspacePaneStrip/>      row 1 (desktop) — receives inViewPaneIds;
        │                              renders the in-view marker. Presentation.
        └── <div.canvasViewport>       row 2 — position: relative; min-width: 0
              ├── <div.paneCanvas>     the scroll container (overflow-x: auto);
              │     └── paneWrap × N   carries data-pane-id; flex: 0 0 auto
              │           └── PaneShell
              │                 chrome → drag handle (onMouseDown → hook)
              │                 body   → unchanged (overflow-x stays hidden)
              └── edgeFade × 2         absolute, pointer-events: none
```

**Why a hook, not a component or inlined effects.** The canvas mechanics are a
cohesive, non-trivial unit — a pointer-drag state machine, a wheel router, an
`IntersectionObserver`, an edge-metrics listener. Inlining them into
`WorkspaceHost` (the route `command-palette.md` took for its *thin* single-
consumer hooks) would bury real incidental complexity in an already-large
component; `cleanliness.md` calls for extraction exactly when a unit "hides real
incidental complexity." A *component* fails differently: `inViewPaneIds` must
reach the strip, a sibling rendered above the canvas, so the state has to live in
`WorkspaceHost` regardless — a component would only push it back up through a
callback. A hook keeps the state where both consumers (`WorkspaceHost` → strip,
`WorkspaceHost` → canvas) read it, with no extra indirection.

## 4. Capability contract

`usePaneCanvas` is the single owner of "where the canvas is and how it moves."

- **Inputs:** the pane order and visibility (`paneIds`); whether the workspace is
  on desktop (`enabled`); raw `wheel` events from the canvas and `mouse` events
  from pane headers.
- **Output:** the canvas element ref (`canvasRef`); the `onWheel` handler for the
  canvas; the edge-fade flags `edges` (`{ atStart, atEnd }`); the `inViewPaneIds`
  set; `handleChromeMouseDown(event)`; `scrollPaneIntoView(paneId)`.
- **Invariants:**
  - The canvas is the *only* horizontal scroll container in the workspace. Pane
    bodies keep `overflow-x: hidden`; no pane scrolls itself horizontally.
  - A drag begins only on header chrome, only on the primary button, only after
    the movement threshold, and never on an interactive element.
  - Vertical-wheel translation fires only when nothing from the pointer target up
    to the pane body can scroll vertically.
  - `inViewPaneIds` is derived solely from the `IntersectionObserver`; no other
    code computes visibility from scroll math.
  - `activePaneId` and `inViewPaneIds` are independent; activation *centres* a
    pane, but the two are never conflated.
  - `enabled: false` (mobile) ⇒ the hook is fully inert: no listeners, no
    observer, no state churn. Mobile behaviour is byte-for-byte unchanged.
  - No `scroll-snap` and no CSS `scroll-behavior` on the canvas — smooth scrolling
    is per-call, so drag and wheel stay instant.
- **Failure modes:** `IntersectionObserver` absent (non-browser test/SSR env) ⇒
  `inViewPaneIds` stays empty and the strip renders no markers — a guard for
  non-browser environments, not a behavioural fallback. A new header press while
  a drag's listeners are still attached tears the prior gesture down first (the
  hook holds a single drag-cleanup ref). None of these surface an error.

## 5. API design

### 5.1 `usePaneCanvas` — `apps/web/src/components/workspace/usePaneCanvas.ts` (new)

The hook has no named return interface — the return type is inferred from the
returned object. Its single parameter is `{ enabled, paneIds }`.

```ts
function usePaneCanvas(options: {
  enabled: boolean;       // false on mobile — the hook is inert
  paneIds: string[];      // current pane order; drives observer lifecycle
}): {
  /** Attach to the scroll container (`.paneCanvas`). */
  canvasRef: RefObject<HTMLDivElement | null>;
  /** Wheel handler for the canvas — translates a vertical wheel to a pan. */
  onWheel: (event: ReactWheelEvent<HTMLDivElement>) => void;
  /** Edge-fade visibility. */
  edges: { atStart: boolean; atEnd: boolean };
  /** Pane ids currently intersecting the canvas viewport. */
  inViewPaneIds: ReadonlySet<string>;
  /** Begin a header-initiated pan. Wired to PaneShell's chrome onMouseDown. */
  handleChromeMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
  /** Smooth-centre a pane in the canvas (instant under reduced motion). */
  scrollPaneIntoView: (paneId: string) => void;
};
```

Internals:

- **Refs.** Only the canvas element (`canvasRef`), plus internal bookkeeping
  refs (the active drag's cleanup, the edge-measure `requestAnimationFrame`
  handle). The hook keeps no pane-wrap ref map: it reaches a pane by querying
  the canvas DOM — `canvasRef.current.querySelector('[data-pane-id="…"]')` — and
  observes every pane via `canvasRef.current.querySelectorAll('[data-pane-id]')`.
  Each pane wrap `<div>` carries a `data-pane-id` attribute.
- **Wheel** (`onWheel`): no-op if the hook is disabled, if the canvas has no
  horizontal overflow, if `deltaX !== 0`, or if `shiftKey` (those scroll
  natively). Otherwise walk from `event.target` up to the canvas; if any element
  on that path can scroll vertically, defer; else `canvas.scrollLeft += deltaY`.
- **Drag.** `handleChromeMouseDown` ignores non-primary buttons (`button !== 0`)
  and presses whose `target.closest()` matches an interactive selector (`button,
  a, input, select, textarea, [role='button'], [contenteditable]`). It records
  the start position, tears down any prior drag, and arms a drag; `mousemove` /
  `mouseup` listeners on the chrome element's `ownerDocument` run for the
  gesture's life — mirroring `useResizeHandle.ts`. The drag activates once
  movement exceeds `PANE_CANVAS_DRAG_THRESHOLD_PX`; from then it sets
  `canvas.scrollLeft = startScrollLeft - dx` and applies a `grabbing` cursor and
  `user-select: none` to `document.body`. `mouseup` runs the cleanup, which
  restores the cursor/`user-select` and removes the listeners.
- **Edges.** A passive `scroll` listener on the canvas plus a `ResizeObserver` on
  it recompute `{ atStart, atEnd }` from `scrollLeft` / `clientWidth` /
  `scrollWidth`, coalesced with `requestAnimationFrame`.
- **In view.** One `IntersectionObserver`, `root` = the canvas, observing every
  `[data-pane-id]` element queried from the canvas; the observed set is
  re-established when `paneIds` changes. `inViewPaneIds` is the set of pane ids
  currently intersecting, keyed off each entry's `data-pane-id`.
- **`scrollPaneIntoView`.** Queries the pane wrap by `data-pane-id` (escaped via
  `CSS.escape`) and calls `scrollIntoView({ inline: "center", block: "nearest",
  behavior })`, `behavior` = `"auto"` under `prefers-reduced-motion`, else
  `"smooth"`.

### 5.2 `WorkspaceHost` — wiring

`WorkspaceHost` calls `usePaneCanvas({ enabled: !isMobile, paneIds })`. It:

- replaces the pane-row's anonymous inline `style` object with
  `<div className={styles.canvasViewport}>` wrapping
  `<div ref={canvasRef} className={styles.paneCanvas} onWheel={onWheel}>`, plus
  two `edgeFade` elements driven by `edges`;
- gives each pane wrap a `data-pane-id={paneId}` attribute — the hook reaches
  panes by DOM query, so no pane-wrap ref need be handed to it (`WorkspaceHost`
  keeps its own `paneWrapRefById` map for chrome-focus management, unrelated to
  the canvas);
- passes `isInView={inViewPaneIds.has(paneId)}` into the strip's items;
- passes `handleChromeMouseDown` down to `PaneShell` as `onChromeMouseDown`;
- centres the active pane through one `useEffect` on `state.activePaneId` that
  calls `scrollPaneIntoView` — the single owner of activation-centring. The
  direct `scrollIntoView` call in `handleActivatePane` is deleted;
- runs a `window` `keydown` listener matching `pane-next` / `pane-previous` (via
  `matchesKeyEvent` + `loadKeybindings()`), each stepping `activePaneId` to the
  next/previous visible pane (wrapping) and calling `activatePane`. The listener
  is suppressed while an editable element is focused.

### 5.3 `PaneShell` — header drag handle

`PaneShell` gains one optional prop, `onChromeMouseDown?: (event:
ReactMouseEvent<HTMLElement>) => void`, wired to the `.chrome` element's
`onMouseDown` (that element already carries `data-pane-chrome-focus="true"`).
The drag uses mouse events — `onMouseDown` plus document `mousemove` / `mouseup`
— mirroring `useResizeHandle.ts`, not pointer events. `PaneShell` does no
filtering — the hook's `handleChromeMouseDown` owns the interactive-element
exclusion. `.chrome` gets `cursor: grab` and `user-select: none` on desktop. The
resize handle is a separate, absolutely-positioned sibling outside `.chrome`,
structurally unreachable by a `.chrome` press; no extra exclusion is needed.
Mobile (`data-mobile="true"`) keeps no drag cursor and no handler.

### 5.4 `WorkspacePaneStrip` — in-view marker

`WorkspacePaneStripItem` gains `isInView: boolean`. Each item renders
`data-in-view={isInView}`; CSS adds a marker — a 2px accent bar on the item's
inner edge — distinct from the active item's filled-surface treatment, so
*active* and *in-view* compose visually on one item. The strip stays pure
presentation: it neither observes the canvas nor imports the hook.

### 5.5 Keybindings — `apps/web/src/lib/keybindings.ts`

`DEFAULTS` gains two entries:

```ts
"pane-next": "Meta+Shift+arrowright",
"pane-previous": "Meta+Shift+arrowleft",
```

`Meta` already resolves to ⌘ on macOS and Ctrl elsewhere (`matchesKeyEvent`).
`formatKeyCombo` is extended to render named keys — `arrowright` → `→`,
`arrowleft` → `←` — so the keybindings settings UI displays them legibly. The
pane-step actions appear in `settings/keybindings` automatically (it reads
`DEFAULTS`).

### 5.6 CSS

- **Overscroll fix.** In `chat/ChatSurface.module.css`, `PdfReader.module.css`,
  and `media/[id]/page.module.css`, `overscroll-behavior: contain` becomes
  `overscroll-behavior-y: contain`. Vertical containment — the original intent —
  is preserved; the horizontal axis returns to `auto`, so a horizontal swipe over
  those panes chains out to the canvas. `PaneShell`'s mobile pane bodies are
  unchanged — they keep `overscrollBehavior: "contain"` (both axes): mobile
  renders a single pane with no horizontal canvas to chain to, so the full
  rubber-band containment stays correct there.
- **`WorkspaceHost.module.css`.** New `.canvasViewport` (grid row 2:
  `position: relative; min-width: 0; min-height: 0; overflow: hidden`) —
  *`min-width: 0` is load-bearing*: it clamps the implicit grid column so the
  canvas scrolls instead of the row expanding. New `.paneCanvas`
  (`display: flex; flex-direction: row; width/height: 100%; min-width: 0;
  overflow-x: auto; overflow-y: hidden`) — the former inline style, now named and
  commented. New `.edgeFade` (absolute, full-height, `pointer-events: none`, a
  `linear-gradient` to transparent; `[data-side="start"]` / `[data-side="end"]`).
- No CSS `scroll-snap-*` and no CSS `scroll-behavior` anywhere on the canvas.

## 6. Composition with other systems

| System | Touchpoint |
|---|---|
| Workspace store | Reads `panes` / `activePaneId` / visibility; calls `activatePane` for pane-step keys and centred activation. No store changes. |
| `WorkspacePaneStrip` | Receives `isInView` per item; renders the overview marker. |
| `PaneShell` | `.chrome` becomes the drag handle via `onChromeMouseDown`; body untouched. |
| `useResizeHandle` | The resize handle stays the width control; it is outside `.chrome`, so drag-to-pan and resize never collide. Width changes are picked up by the edge-fade `ResizeObserver`. |
| Command palette | "Open tabs" still calls `activatePane`; centring now flows through the shared `activePaneId` effect. |
| `useIsMobileViewport` | The single desktop/mobile decision; gates `usePaneCanvas` via `enabled`. |
| Keybindings (`lib/keybindings.ts`) | Adds `pane-next` / `pane-previous`; `WorkspaceHost` owns their keydown listener, mirroring how `CommandPalette` owns `open-palette`. |
| Pane runtime (`extraWidthPx`, `setPaneMinWidth`) | Unchanged. The canvas reads rendered widths; it never writes pane widths. |
| Reader / PDF / Chat panes | The inner scrollers' `overscroll-behavior-y` change restores horizontal chaining; no component logic changes. |

## 7. Rules & invariants

- **Hard cutover.** The pane-row inline `style` object is deleted, not flagged or
  commented out. `inline: "nearest"` is fully replaced by `inline: "center"`.
  `overscroll-behavior: contain` is fully replaced by `overscroll-behavior-y:
  contain`. No feature flag, no "classic" path, no backward-compat shim.
- **One owner.** Canvas position, edge state, and visibility live only in
  `usePaneCanvas`. The strip and `PaneShell` are presentation; they never observe
  the canvas.
- **No snap.** No `scroll-snap-*`; no CSS `scroll-behavior`.
- **Desktop only.** Every change is desktop-only or inert on the single-pane
  mobile layout; `enabled: false` proves it.
- **Drag safety.** A drag never begins on an interactive element, the resize
  handle, a pane body, or with a non-primary button; a sub-threshold press stays
  a click.
- **No dead code or dead CSS** in the final state.
- **Named constants** — `PANE_CANVAS_DRAG_THRESHOLD_PX`, the edge-fade width, any
  wheel normalisation factor (`timing.md` / conventions; no magic numbers).
- **Imports** — relative imports rise at most two levels, else the `@/` alias
  (`codebase.md`).
- **Accessibility** — the strip stays a `role="toolbar"` with roving focus;
  pane-step keys are suppressed inside editable elements; centring respects
  `prefers-reduced-motion`.

## 8. Final state

- `WorkspaceHost` renders `.canvasViewport` → `.paneCanvas` → pane wraps, plus two
  edge fades and the strip. Its only canvas logic is the `usePaneCanvas` call, the
  `activePaneId` centring effect, and the pane-step keydown listener.
- `usePaneCanvas` exists and is the sole owner of canvas scrolling, drag, edge
  metrics, and in-view detection.
- The pane row has no inline `style` object; its behaviour is named CSS plus the
  hook.
- The strip shows a live in-view marker; `WorkspacePaneStripItem` carries
  `isInView`.
- `PaneShell.chrome` is a drag handle; bodies are unchanged.
- `pane-next` / `pane-previous` exist in `keybindings.ts` and the settings UI;
  `formatKeyCombo` renders arrow keys.
- The three reader / chat / media CSS modules use `overscroll-behavior-y:
  contain`.
- A desktop user can pan the canvas with: a horizontal trackpad swipe,
  `Shift`+wheel, a vertical wheel over chrome or a non-scrolling pane, a header
  drag, the pane-step keys, a strip click, and the scrollbar. Off-screen panes
  are signalled by edge fades and the strip.

## 9. Key decisions

1. **No snap — free scroll.** Chosen by the product owner. Snap would fight
   side-by-side reading across resizable-width panes; edge fades and the
   scrollbar provide tidiness instead.
2. **Drag-to-pan on headers only.** Chosen by the product owner. Pane bodies hold
   selectable text, links, and their own scrollers; confining the grab to header
   chrome avoids every gesture conflict.
3. **The strip is a live overview.** Chosen by the product owner. The in-view
   marker is what makes strip and canvas one system rather than two navigators.
4. **One `usePaneCanvas` hook**, despite a single consumer — justified in §3: the
   mechanics are non-trivial and cohesive, and the in-view state must live in
   `WorkspaceHost` for the strip anyway.
5. **`IntersectionObserver` for in-view**, not scroll arithmetic — robust to width
   changes, the highlights rail, and resizing, with one observer and no
   duplicated math.
6. **Vertical-wheel translation gated to non-scrollable regions** — predictable: a
   wheel never both scrolls a pane and pans the canvas.
7. **`inline: "center"` for activation** — a jumped-to pane lands predictably, not
   flush under a neighbour's resize handle.
8. **`overscroll-behavior-y` (axis-split), not a media query** — it fixes desktop
   chaining without duplicating the 768px breakpoint and without weakening
   mobile's vertical containment.
9. **`Meta+Shift+Arrow` for pane-step** — semantically obvious, cross-platform via
   the existing `Meta` handling, and free of browser/OS reserved combos when no
   editable element is focused.

## 10. Acceptance criteria

Canvas:

- [ ] With panes overflowing the viewport, a horizontal trackpad swipe pans the
      canvas over *every* pane type, including reader / PDF / chat panes.
- [ ] `Shift`+wheel pans the canvas from over any pane.
- [ ] A vertical wheel over a pane header, or over a pane whose content fits,
      pans the canvas; over a scrollable body it scrolls the body and does not
      pan.
- [ ] Pressing and dragging a pane header pans the canvas; the cursor shows
      `grab` / `grabbing`.
- [ ] A header click that does not move still activates the pane; header buttons
      (back, options, actions) still work; selecting text in a body still works.
- [ ] Edge fades appear only on the side(s) with more panes and disappear when
      everything fits.

Strip:

- [ ] The strip marks every in-view pane and updates as the canvas pans.
- [ ] In-view and active render distinctly and compose on the same item.

Keyboard & activation:

- [ ] `pane-next` / `pane-previous` move to the adjacent visible pane, wrap at the
      ends, and centre it.
- [ ] The pane-step keys do nothing while a text input, textarea, or
      contenteditable is focused.
- [ ] Activating a pane (strip, palette, open, restore) centres it; centring is
      instant under `prefers-reduced-motion`.

Cutover & platform:

- [ ] No inline `style` object remains on the pane row; no `scroll-snap` or CSS
      `scroll-behavior` exists on the canvas.
- [ ] Mobile (≤768px) is visually and behaviourally unchanged; `usePaneCanvas`
      registers no listeners there.

## 11. Test plan

- `usePaneCanvas.test.tsx` (new) — must be `.tsx` so it runs in the `browser`
  vitest project (real Chromium), where `IntersectionObserver`, `ResizeObserver`,
  and real scroll metrics exist. It renders a harness around the hook and drives
  real events: a vertical wheel pans the canvas; a wheel over a vertically
  scrollable child does not; a header drag past / below the threshold; a drag
  suppressed from an interactive header element; edge flags from scroll metrics;
  the in-view set from the `IntersectionObserver`; and full inertness when
  `enabled` is `false`.
- `WorkspacePaneStrip.test.tsx` (updated) — at `apps/web/src/__tests__/
  components/`; its item fixtures gained the now-required `isInView` field. The
  strip's existing semantics, roving focus, and minimize/restore/close coverage
  is otherwise unchanged.
- `e2e/tests/workspace-canvas.spec.ts` (new) — desktop, multiple panes: a
  vertical wheel over a header pans the canvas, header drag-pan, `pane-next` /
  `pane-previous` stepping the active pane and bringing it into view, and edge
  fades updating as the canvas pans. This is also where the pane-step keybinding
  and centred-activation behaviours are covered — there is no `WorkspaceHost`
  unit test.
- Manual: a real trackpad (horizontal swipe, momentum) and a real wheel across
  `standard`, `document`, and `contained` panes; `prefers-reduced-motion`.

Native trackpad momentum is not deterministically assertable; the e2e spec
drives synthetic wheel/mouse sequences and the rest is the manual pass.

## 12. Implementation phases

Each phase compiles and leaves the suite green; all land together on
`workspace-pane-canvas`.

1. **Canvas scaffold + cutover.** Add `usePaneCanvas` with the canvas ref, edge
   metrics, the wheel handler, and `scrollPaneIntoView`. `WorkspaceHost` adopts
   it: the inline `style` becomes `.canvasViewport` / `.paneCanvas` / `.edgeFade`;
   the `activePaneId` centring effect replaces the `handleActivatePane` scroll
   call.
2. **Drag-to-pan.** `usePaneCanvas` gains `handleChromeMouseDown` + the document
   `mousemove` / `mouseup` listeners + the movement threshold; `PaneShell` wires
   `onChromeMouseDown` and the `grab` styling.
3. **Strip live overview.** `usePaneCanvas` gains the `IntersectionObserver` +
   `inViewPaneIds`; `WorkspaceHost` passes `isInView`; `WorkspacePaneStrip`
   renders the marker.
4. **Keyboard + overscroll fix.** `pane-next` / `pane-previous` in
   `keybindings.ts`, the `formatKeyCombo` arrow rendering, the `WorkspaceHost`
   keydown listener; `overscroll-behavior-y` in the three CSS modules.
5. **Tests + sweep.** Unit + e2e per §11; reduced-motion; a final dead-code /
   dead-CSS pass; `typecheck` + `lint` + `test:unit` green.

## 13. Scope & non-goals

**In scope:** the canvas affordances (wheel translation, header drag-to-pan, edge
fades); the `overscroll-behavior-y` fix; the strip live-overview marker; the
`pane-next` / `pane-previous` keybinding and its `formatKeyCombo` rendering;
centred activation; the inline-style → `usePaneCanvas` + CSS-module cutover.

**Non-goals:** scroll snap; the pane resize / width model (`widthPx`,
`extraWidthPx`, `minWidthPx` unchanged); mobile pane layout; touch gestures on
desktop; drag-to-*reorder* panes; the strip auto-scrolling to follow the canvas;
persisting canvas scroll position across reloads; the command palette internals;
any change to pane routing or the workspace store.

## 14. Files

New:

- `apps/web/src/components/workspace/usePaneCanvas.ts`
- `apps/web/src/components/workspace/usePaneCanvas.test.tsx`
- `e2e/tests/workspace-canvas.spec.ts`
- `docs/workspace.md` (this document)

Modified:

- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.module.css`
- `apps/web/src/components/workspace/WorkspacePaneStrip.tsx`
- `apps/web/src/components/workspace/WorkspacePaneStrip.module.css`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/workspace/PaneShell.module.css`
- `apps/web/src/lib/keybindings.ts`
- `apps/web/src/components/chat/ChatSurface.module.css`
- `apps/web/src/components/PdfReader.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
- `apps/web/src/__tests__/components/WorkspacePaneStrip.test.tsx` — item fixtures
  updated for the new required `isInView` field.

## 15. Risks

| Risk | Mitigation |
|---|---|
| A header drag is mistaken for a click, or starts a text selection | Movement threshold before the drag arms; `user-select: none` on `document.body` during a drag. Pane activation is bound to `mousedown` on the pane wrap, not `click`, so a header press activates the pane on press whether or not a drag follows — there is no trailing `click` to suppress. |
| Vertical-wheel translation surprises a user mid-scroll | Translate only when *nothing* under the pointer can scroll vertically; never on a scrollable body, never at a scroll boundary. |
| `overscroll-behavior-y` weakens mobile rubber-band containment | Only the (unused on the canvas) horizontal axis changes; vertical containment is preserved verbatim. |
| `IntersectionObserver` churn on fast pans | One observer rooted at the canvas; the browser coalesces callbacks; `inViewPaneIds` updates are cheap set rebuilds. |
| The `activePaneId` centring effect fights a user mid-drag | Centring fires only on `activePaneId` *change*; a drag never changes the active pane, so the two never contend. |
| The `Meta+Shift+Arrow` default collides with a user's text selection | The pane-step listener is suppressed whenever an editable element is focused; selection in inputs is unaffected. |
