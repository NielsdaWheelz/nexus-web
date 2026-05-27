# Workspace Pane Tabs

Status: Current implementation reference.
Scope owner: desktop workspace pane strip and pane title display in `apps/web`.
Related: `docs/workspace.md` owns the spatial canvas, scroll behavior, and
in-view detection. This document owns the tab anatomy, title states, and visual
rules for the strip's marker.
Related cutover record: `docs/workspace-pane-title-identity-cutover.md`.

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
- `titleSource`: `"runtime"`, `"hint"`, `"static"`, or `"fallback"`.
- `resourceKey`: the route resource identity used to validate title records.
- `route` and `chrome`: the resolved route metadata used by host surfaces.

Resolution rules:

- A runtime title published by the pane body for the current resource is always
  `"resolved"`.
- A title hint supplied by the opener for the current resource is `"resolved"`
  until a runtime title supersedes it.
- A static route without a runtime title uses its route label and is
  `"resolved"`.
- A dynamic route without a current-resource runtime title or title hint uses
  its route label as accessible stand-in text and is `"pending"`.

Persistent chrome surfaces that can show structure, such as the pane tab and
`SurfaceHeader`, render `"pending"` as a skeleton while preserving an accessible
name. Text-list surfaces, such as the command palette, render `title` directly
and ignore `titleState`.

Dynamic pane bodies use `useSetPaneTitle` to publish `null` while the resource
title is genuinely unknown, then publish a non-empty title for success, not
found, and error terminal states. Category labels must not be published as
resource titles during loading.

`titleHint` from `requestOpenInAppPane(href, { titleHint })`,
`paneRuntime.router.push(href, { titleHint })`, or
`paneRuntime.openInNewPane(href, titleHint)` is an optimistic title for the
target resource. It is useful when the opener already has metadata, such as a
library row opening a media pane. The hint is sanitized, attached to the pane
resource key, and superseded by the first runtime title from the pane body.
Hints are runtime chrome state, not persisted workspace state.

## Route Metadata

`paneRouteRegistry.tsx` owns two separate route concerns:

- `resourceRef`: pane identity for reuse and de-duplication.
- `titleMode`: title loading behavior, `"static"` or `"dynamic"`.

Every route definition declares `titleMode` explicitly. `ResolvedPaneRoute`
carries it through to the workspace store, and the synthetic unsupported route
is static.

`lib/panes/paneIdentity.ts` derives the shared `resourceKey` from the resolved
route. Routes with `resourceRef` use that resource reference; routes without one
fall back to normalized href identity. Workspace title caches, pane body
lifecycles, and open-pane de-duplication all use this helper.

## Host Composition

`WorkspaceHost` builds host-owned pane records from workspace state and the title
descriptor. It threads the same `title` and `titleState` into:

- `WorkspacePaneStrip`, where pending titles render as tab skeletons.
- `PaneShell` and `SurfaceHeader`, where pending titles render as heading
  skeletons.
- title telemetry, where `titleState` makes panes stuck in pending observable.

`runtimeTitleByPaneId` is the runtime title record cache. Each record stores the
title, source (`"hint"` or `"runtime"`), and `resourceKey`. When a pane's
resource key changes, the store prunes stale records for that pane, so dynamic
routes return to pending unless the opener supplied a current-resource hint.
Same-resource location changes, such as `/media/:id` to
`/media/:id?loc=section`, preserve title records.

## Session Restore And Direct URLs

Saved workspace sessions restore silently on a neutral `/libraries` open when the
URL does not carry `ws=` state. Explicit direct URLs remain authoritative even
without `ws=`: if the browser opens `/media/:id`, `/conversations`, or another
non-neutral route, the restored session is merged with that requested pane and
the requested pane becomes active. Same-resource identity uses
`lib/panes/paneIdentity.ts`, so a direct URL such as `/media/:id?loc=section`
updates and activates an existing saved media pane instead of duplicating it.

## Visual Invariants

The tab is content-hugging and truncates only the title.

- `.tab` is `flex: 0 1 auto`, has no minimum width floor, has `max-width: 240px`,
  and carries `overflow: hidden`.
- `.activator` and `.title` both carry `min-width: 0`, keeping the truncation
  chain intact.
- The icon and action group never shrink.
- The title is left-aligned and uses `text-overflow: ellipsis`.
- The action group reserves its width in every state; hover, focus-within, and
  active lift the action group from an ambient rest opacity to full opacity,
  not by layout changes.

The tab is a pill with uniform `--radius-md` corners. It does not adopt the
folder-tab metaphor of joining the canvas below, because the canvas is
horizontally scrollable and the active pane is not always directly below the
active tab.

The visual state model is:

- inactive: transparent tab on the strip surface.
- hover: `--surface-hover` fill, title at full contrast.
- active: `--surface-active` fill, `--shadow-1` elevation, route icon in
  `--accent`.
- in view: left-edge accent tick, half-height; independent from active state.
- minimized: `--surface-sunken` fill, muted title, dimmed icon.
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
- `apps/web/src/lib/panes/paneIdentity.ts` owns route resource keys used by
  title caches and pane body lifecycle.
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
