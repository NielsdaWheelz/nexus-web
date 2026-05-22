# Workspace Pane Tabs

Status: Current implementation reference.
Scope owner: desktop workspace pane strip and pane title display in `apps/web`.
Related: `docs/workspace.md` owns the spatial canvas, scroll behavior, and
in-view detection. This document owns the tab anatomy, title states, and visual
rules for the strip's marker.

## Scope

`WorkspacePaneStrip` renders the desktop-only row of pane tabs above the
workspace canvas. It is a presentational toolbar: it receives item state from
`WorkspaceHost`, emits pane actions, and does not observe the canvas directly.
Mobile has no pane strip.

The strip has one internal tab component, `PaneTab`, colocated in
`WorkspacePaneStrip.tsx`. It is not a public module and has no direct callers
outside the strip.

## Tab Anatomy

Each tab has one activator and one action group.

- The activator contains the route icon from `getPaneRouteIcon(item.href)` and
  either resolved title text or a pending-title skeleton.
- The action group contains minimize-or-restore and close buttons.
- The action buttons are pointer affordances with `tabIndex={-1}`. Keyboard
  users close the focused pane with `Delete` or `Backspace`.
- The strip does not import or compose the generic `Button` component. Pane tabs
  own their own structure, sizing, focus ring, title truncation, and action
  affordances.

`WorkspacePaneStripItem` carries the full state needed to render the tab:
`paneId`, `href`, `title`, `titleState`, active state, in-view state, visibility,
and whether minimize is currently allowed. The strip does not derive route
identity or title status on its own.

## Title Model

`resolveWorkspacePaneTitle` in `lib/workspace/store.tsx` is the only owner of
pane title resolution. It returns:

- `title`: always a non-empty string.
- `titleState`: `"resolved"` or `"pending"`.
- `route` and `chrome`: the resolved route metadata used by host surfaces.

Resolution rules:

- A runtime title published by the pane body is always `"resolved"`.
- A static route without a runtime title uses its route label and is
  `"resolved"`.
- A dynamic route without a runtime title uses its route label as accessible
  stand-in text and is `"pending"`.

Persistent chrome surfaces that can show structure, such as the pane tab and
`SurfaceHeader`, render `"pending"` as a skeleton while preserving an accessible
name. Text-list surfaces, such as the command palette, render `title` directly
and ignore `titleState`.

Dynamic pane bodies use `useSetPaneTitle` to publish `null` while the resource
title is genuinely unknown, then publish a non-empty title for success, not
found, and error terminal states. Category labels must not be published as
resource titles during loading.

## Route Metadata

`paneRouteRegistry.tsx` owns two separate route concerns:

- `resourceRef`: pane identity for reuse and de-duplication.
- `titleMode`: title loading behavior, `"static"` or `"dynamic"`.

Every route definition declares `titleMode` explicitly. `ResolvedPaneRoute`
carries it through to the workspace store, and the synthetic unsupported route
is static.

## Host Composition

`WorkspaceHost` builds host-owned pane records from workspace state and the title
descriptor. It threads the same `title` and `titleState` into:

- `WorkspacePaneStrip`, where pending titles render as tab skeletons.
- `PaneShell` and `SurfaceHeader`, where pending titles render as heading
  skeletons.
- title telemetry, where `titleState` makes panes stuck in pending observable.

`runtimeTitleByPaneId` remains the runtime title cache. When a pane's href
changes, the store prunes the stale title for that pane, so dynamic routes return
to pending until the new body publishes a title.

## Visual Invariants

The tab is content-hugging and truncates only the title.

- `.tab` is `flex: 0 1 auto`, has no minimum width floor, has `max-width: 240px`,
  and carries `overflow: hidden`.
- `.activator` and `.title` both carry `min-width: 0`, keeping the truncation
  chain intact.
- The icon and action group never shrink.
- The title is left-aligned and uses `text-overflow: ellipsis`.
- The action group reserves its width in every state; hover and focus reveal
  actions by opacity, not layout changes.

The visual state model is:

- inactive: transparent tab on the strip surface.
- hover: visible lift toward the active surface.
- active: canvas-surface fill plus a top accent bar.
- in view: bottom accent marker, independent from active state.
- minimized: muted title styling and restore action.
- focus visible: inset `--ring` outline.
- pending: local skeleton block with reduced-motion support.

The in-view marker's meaning and `IntersectionObserver` ownership live in
`docs/workspace.md`; this document owns only the marker's tab-level appearance.

## Accessibility

- The strip is `role="toolbar"` and has one tab stop per pane.
- `ArrowLeft`, `ArrowRight`, `Home`, and `End` rove focus between activators.
- `Delete` and `Backspace` close the focused pane.
- The active activator carries `aria-current="page"`.
- Pending activators carry `aria-label` and `aria-busy`; the visible skeleton is
  `aria-hidden`.
- Minimized state is announced with screen-reader text.
- The action buttons remain outside the roving sequence.

## Code Owners

- `apps/web/src/components/workspace/WorkspacePaneStrip.tsx` owns tab markup,
  roving focus, keyboard close, and action dispatch.
- `apps/web/src/components/workspace/WorkspacePaneStrip.module.css` owns tab
  layout, truncation, visual state, marker appearance, and pending skeleton.
- `apps/web/src/lib/workspace/store.tsx` owns title resolution and runtime title
  cache behavior.
- `apps/web/src/lib/panes/paneRouteRegistry.tsx` owns route icons and
  `titleMode`.
- `apps/web/src/components/workspace/WorkspaceHost.tsx` owns threading title
  state from the store into strip items, pane shells, and telemetry.
- `apps/web/src/components/ui/SurfaceHeader.tsx` owns the header-level pending
  skeleton.

## Verification

Relevant checks for this surface:

- `apps/web/src/__tests__/components/WorkspacePaneStrip.test.tsx` covers toolbar
  semantics, roving focus, pending tab accessibility, action button tab stops,
  minimize/restore, and keyboard close.
- `apps/web/src/lib/workspace/store.test.tsx` covers title resolution through
  the public workspace store surface and `resolveWorkspacePaneTitle`.
- `apps/web/src/__tests__/components/CommandPalette.test.tsx` covers command
  palette composition with the workspace store.
- `bun run typecheck` and `bun run lint` cover the public TypeScript surface.
