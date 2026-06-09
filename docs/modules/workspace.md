# Workspace Module

## Scope

The workspace module owns authenticated pane composition. It decides which
primary panes, desktop pane-strip controls, desktop canvas affordances,
desktop-attached secondary panes, fixed primary chrome, and mobile secondary
sheets are mounted.

Frontend owners live under `apps/web/src/components/workspace/*` and
`apps/web/src/lib/workspace/*`.

## Layout Modes

`WorkspaceHost` owns the workspace layout mode. Viewport classification comes
from the render environment path, but workspace composition policy is decided in
`WorkspaceHost`.

Desktop mode:

- renders the pane strip
- renders every visible/minimized primary pane in the horizontal canvas
- enables `usePaneCanvas` in desktop mode
- renders edge fades only from desktop canvas edge state
- allows desktop-attached secondary panes
- allows fixed primary chrome such as the reader overview ruler
- mounts pane resize handles

Mobile mode:

- renders only the active visible primary pane in the main canvas
- disables desktop canvas measurement
- renders no edge fade DOM
- renders no pane strip
- renders no desktop-attached secondary pane column
- renders no fixed primary chrome
- renders no pane resize handle
- presents secondary content only through `MobileSecondaryPaneHost`

Mobile mode is not a narrow desktop canvas. It is a different composition
contract.

## Pane Canvas

`usePaneCanvas` owns desktop horizontal canvas measurement, wheel-to-horizontal
panning, header drag panning, in-view pane tracking, edge state, and
scrolling the active pane into view.

The hook accepts `mode: "desktop" | "disabled"`.

- `"desktop"` attaches listeners, observers, and measurement.
- `"disabled"` clears edge and in-view state, performs no measurement, and does
  not scroll panes into view.

Callers must not clear canvas state themselves. `WorkspaceHost` passes the mode
and renders edge fades only in desktop mode.

## Mobile Secondary Panes

`MobileSecondaryPaneHost` is the only workspace mobile secondary presentation.
It is modal sheet chrome, not a workspace column. It presents through the shared
`MobileSheet` primitive (`scrim="soft"`, `layer="overlay"`), which owns the
portal, scrim, grabber, keyboard avoidance, back-button dismissal, and the
`useDialogOverlay` modal contract. See `docs/modules/overlays.md`.
`MobileSecondaryPaneHost` owns only its header chrome, tab state, and surface
bodies.

Workspace secondary content can share the same surface bodies across desktop
and mobile, but the chrome owner differs:

- desktop: `SecondaryPaneShell`
- mobile: `MobileSecondaryPaneHost`

Do not introduce another workspace mobile drawer or sheet owner.

## Fixed Chrome

Fixed primary chrome is desktop-only. Pane bodies may publish fixed chrome, but
mobile workspace mode makes that publication inert for desktop fixed-chrome
rendering.

The reader overview ruler is fixed primary chrome and remains desktop-only.
