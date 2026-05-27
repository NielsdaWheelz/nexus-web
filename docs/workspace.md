# Workspace Spatial Pane Canvas

Status: Current implementation reference.
Scope owner: desktop workspace canvas in `apps/web`.
Related: `docs/workspace-tabs.md` owns pane tab anatomy, title states,
accessibility, and the visual rules for the strip marker.
`docs/workspace-pane-title-identity-cutover.md` records the resource-key
title/body-lifecycle cutover.

## Scope

`WorkspaceHost` renders desktop workspace panes as one horizontally scrollable
canvas. The pane strip above it is an index onto that canvas: strip actions
activate, minimize, restore, or close panes, while the canvas owns spatial
position and in-view detection.

Mobile renders only the active visible pane and does not render the pane strip.
Canvas event listeners and observers are disabled there; mobile chrome and body
scroll behavior stay owned by `PaneShell`.

## Ownership

- `WorkspaceHost` is the orchestrator. It reads workspace store state, resolves
  pane titles and route chrome, tracks runtime pane width contributions, renders
  the strip plus canvas, centers the active pane, and owns the pane-step
  keybinding listener.
- `usePaneCanvas` owns canvas mechanics: the canvas ref, vertical-wheel
  translation, header drag-to-pan, edge metrics, in-view pane detection, and
  `scrollPaneIntoView`.
- `PaneShell` owns pane chrome, body layout, resize handles, and mobile chrome.
  It exposes the chrome `onMouseDown` surface for canvas drag-to-pan, but does
  not decide when a drag is valid.
- `WorkspacePaneStrip` is presentational. It receives `isInView`, `isActive`,
  title state, visibility, and action callbacks from `WorkspaceHost`; it does
  not observe or measure the canvas.
- Reader, PDF, and chat panes keep vertical scroll containment with
  `overscroll-behavior-y: contain`, leaving horizontal chaining available to
  the workspace canvas.

## Layout

The desktop structure is:

```text
WorkspaceHost
  section.host
    WorkspacePaneStrip
    div.canvasViewport
      div.paneCanvas
        div.paneWrap[data-pane-id] x N
          PaneShell
      edgeFade[start]
      edgeFade[end]
```

`.canvasViewport` is the grid row wrapper. Its `min-width: 0` is load-bearing:
it keeps the grid column constrained so `.paneCanvas` scrolls instead of forcing
the host wider.

`.paneCanvas` is the horizontal scroll container. It is a row flex container
with `overflow-x: auto` and `overflow-y: hidden`. Pane wraps are `flex: 0 0
auto`; minimized pane wraps remain in the pane list for state and strip
rendering, but are hidden and inert in the canvas.

## Canvas Behavior

The canvas is free-scroll. It does not use scroll snap, and it does not set CSS
scroll behavior; smooth or instant centering is selected per
`scrollPaneIntoView` call.

Horizontal wheel and trackpad input are left to the browser. `Shift` plus wheel
is also left native. The hook handles only vertical wheel input that can safely
be converted into a horizontal pan:

- the hook is enabled;
- the canvas has horizontal overflow;
- the event has no horizontal delta;
- `Shift` is not held;
- no event-target ancestor up to the canvas is vertically scrollable.

If any ancestor on that path can scroll vertically, the pane body keeps the
vertical wheel event and the canvas does not pan.

Header drag-to-pan starts from pane chrome only. The hook ignores non-primary
mouse buttons and interactive descendants such as buttons, links, form controls,
`[role='button']`, and `[contenteditable]`. A drag arms only after
`PANE_CANVAS_DRAG_THRESHOLD_PX`; while armed, the document body gets the
`grabbing` cursor and `user-select: none`.

## Edge And In-View State

`usePaneCanvas` derives edge fade state from the canvas scroll metrics. The
start fade is shown when content is off-screen before the viewport; the end fade
is shown when content remains after the viewport. The fades are visual only and
do not receive pointer events.

`usePaneCanvas` also owns the `IntersectionObserver` rooted at `.paneCanvas`.
It observes pane wraps by `data-pane-id` and exposes `inViewPaneIds`.
`WorkspaceHost` maps that set onto strip items. No other code computes pane
visibility from scroll math.

In-view state is independent from active state. A pane can be in view without
being active, and the active pane can be outside the current viewport until the
next activation-centering pass completes.

## Activation And Keyboard

Any active pane change flows through a single `WorkspaceHost` effect that calls
`scrollPaneIntoView(state.activePaneId)`. The hook queries the pane wrap by
`data-pane-id` and calls `scrollIntoView` with `inline: "center"` and
`block: "nearest"`. The behavior is `"auto"` under
`prefers-reduced-motion: reduce`; otherwise it is `"smooth"`.

`pane-next` and `pane-previous` are persisted keybindings in
`apps/web/src/lib/keybindings.ts`. The defaults are `Meta+Shift+arrowright` and
`Meta+Shift+arrowleft`; `Meta` matches Command on macOS and Control elsewhere.
`WorkspaceHost` handles those commands at the document level, skips editable
targets, wraps through visible panes, and activates the destination pane.

The pane strip's Arrow, Home, and End keys remain roving-focus toolbar controls.
They do not pan the canvas.

## Invariants

- There is one desktop workspace canvas implementation and one owner for canvas
  motion: `usePaneCanvas`.
- `WorkspaceHost` may coordinate state and thread props, but it does not own
  wheel routing, drag state, edge math, or in-view observation.
- `WorkspacePaneStrip` renders state it receives. It never imports
  `usePaneCanvas`, reads scroll metrics, or observes pane wraps.
- `PaneShell` exposes chrome input and owns pane shell layout. It does not
  duplicate drag filtering or canvas scroll behavior.
- Pane bodies do not own horizontal workspace scrolling.
- No canvas scroll snap is allowed.
- `enabled: false` disables the hook's wheel handling, drag handling, scroll
  listeners, resize observer, and intersection observer.

## Implementation Surfaces

- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.module.css`
- `apps/web/src/components/workspace/usePaneCanvas.ts`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/workspace/PaneShell.module.css`
- `apps/web/src/components/workspace/WorkspacePaneStrip.tsx`
- `apps/web/src/components/workspace/WorkspacePaneStrip.module.css`
- `apps/web/src/lib/keybindings.ts`
- `apps/web/src/components/chat/ChatSurface.module.css`
- `apps/web/src/components/PdfReader.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`

## Verification

Current coverage for this surface:

- `apps/web/src/components/workspace/usePaneCanvas.test.tsx` covers vertical
  wheel translation, scrollable-child suppression, header drag threshold,
  interactive-header suppression, edge metrics, in-view reporting, and disabled
  hook behavior.
- `apps/web/src/__tests__/components/WorkspacePaneStrip.test.tsx` covers strip
  toolbar semantics, roving focus, pending title accessibility,
  minimize/restore, and keyboard close.
- `e2e/tests/workspace-canvas.spec.ts` covers real desktop canvas overflow,
  vertical wheel panning from pane chrome, header drag panning, pane-step
  keybindings, active pane centering, and edge fade updates.
- `e2e/tests/workspace-tabs.spec.ts` covers resolved dynamic pane titles in the
  strip.
- `bun run typecheck` and `bun run lint` cover the TypeScript and lint surface
  for the web app.

## Non-Goals

- Scroll snap.
- Pane drag-to-reorder.
- Persisting canvas scroll position across reloads.
- Touch gestures for the desktop canvas.
- Changing the pane width model.
- Changing command palette internals.
- Moving tab anatomy, title state rules, or marker styling out of
  `docs/workspace-tabs.md`.
