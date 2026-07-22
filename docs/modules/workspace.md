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
- allows fixed primary chrome such as the reader Document Map overview rail
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

## Pane Headers and Primary Chrome

Every supported route declares one `PaneRouteHeaderContract`:

- `section` resolves the destination-owned standing head and an optional folio
- `resource` resolves a title plus structured credit groups

Pane bodies publish the orthogonal `{ header, toolbar, actions, options }`
capabilities through `usePanePrimaryChrome`. Each update carries the current
`routeKey`; `PaneShell` rejects stale updates before validating the header kind.
There is no route-level chrome descriptor, body-mode inference, or ambient title
override.

The three projections are fixed:

- desktop section header: 44px
- desktop resource header: 60px
- mobile top bar: 60px plus safe area

Desktop actions render through `ActionBar`; the same typed descriptors render in
mobile Options through `ActionMenu`. Free-form `toolbar` content is reserved for
bounded format navigation such as PDF and EPUB controls. It is not another
action channel.

Each pane landmark is named from its resolved header. Resource identity owns its
`h1`; imported reader headings are projected beneath it, and pending resource
identity supplies an accessible loading name. The
route-scoped error boundary wraps runtime, chrome, body, and mobile secondary
composition so one pane failure cannot replace its siblings or the workspace.

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

An expanded secondary region uses
`paneSecondaryRegionId(primaryPaneId, groupId)`. Disclosure actions expose that
id only while the region exists. Mobile open requests may carry the exact trigger
element as ephemeral focus state; the sheet focuses its active tab, returns to
that trigger on close, and falls back to the same pane's chrome if the trigger
disconnects.

Do not introduce another workspace mobile drawer or sheet owner.

## Fixed Chrome

Fixed primary chrome is desktop-only. Pane bodies may publish fixed chrome, but
mobile workspace mode makes that publication inert for desktop fixed-chrome
rendering.

The reader Document Map overview rail is fixed primary chrome and remains
desktop-only. Its markers activate contextual targets; it contains no generic
Document Map opener.

## Pane History

Each primary pane owns one Back/Forward history stack of hrefs. The workspace
is the sole owner of `push`, `replace`, Back, and Forward mechanics.

- `push` records the current href as a Back checkpoint, sets the new href,
  and clears Forward.
- `replace` changes the current href without changing either stack.
- Back and Forward traverse the stored checkpoints.
- A replace that consumes a target hash writes `pathname + search` — hash
  consumption always strips the hash from the href it stores.
- The workspace never infers push-versus-replace from URL shape or resource
  equality. Feature owners choose the operation for every navigation they
  perform; the workspace only executes it.
- Per-pane history is capped at 12 entries in each direction; the workspace
  holds at most 48 history entries across every pane combined. When a write
  would exceed either budget, the oldest entry is trimmed; non-active panes'
  history is trimmed before the active pane's own history is touched.

## Reader-To-Chat Launch Intent

A reader Highlight quote launches chat through a pane-local intent hash
`#mediaId=<uuid>&highlightId=<uuid>`, read only through `paneRuntime` pane-local
hash parameters (never ambient `window.location`). Before the send commits the
hash is reload/navigation safe and excluded from pane identity.

Reaching the destination uses canonical-pane adoption: the target chat pane is
reused or opened without duplication — desktop shows it adjacent, mobile
activates it while preserving the reader pane in the session — and source
activation returns to that reader pane. On a successful run the feature
route-`replace`s to consume the provisional history entry, so Back cannot
rehydrate a completed intent.
