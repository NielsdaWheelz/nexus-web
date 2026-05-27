# Pane Internal Link Navigation Cutover

## Purpose

Internal workspace links must behave identically wherever they appear inside a pane:
route body, reader chrome, header metadata, action menus, row lists, and other pane-owned
surfaces. A contributor credit rendered in media chrome must navigate to the author pane
without being overwritten by the source media pane, and Shift-click must open that author
in a sibling pane.

This cutover makes pane-scoped internal navigation a host-level capability rather than a
feature reimplemented by individual components.

## Problem Statement

Pane content already had a click boundary that routed supported internal anchors through
`PaneRuntimeProvider`. Chrome override content was rendered by `PaneShell` outside that
runtime and boundary. Links promoted from a route body into pane chrome therefore looked
like normal anchors, but they did not participate in pane navigation. The observable bug
was an author credit on a media pane header appearing to navigate to `/authors/:handle`
and then returning to the media pane.

Local component handlers are not a durable fix. They do not cover all chrome surfaces,
they miss portal-rendered menus, and they duplicate route support checks, title hint
handling, and Shift-click behavior.

## Target Behavior

- A primary click on a supported same-origin workspace link inside a pane replaces the
  current pane href through `paneRuntime.router.push`.
- A Shift-primary click on the same supported link opens a new sibling pane through
  `paneRuntime.openInNewPane`.
- Meta-click, Ctrl-click, Alt-click, non-primary clicks, `_blank` targets, downloads,
  hash-only anchors, unsupported workspace routes, and external links keep native browser
  behavior.
- Disabled menu anchors do not route through the pane runtime.
- `data-pane-title-hint` is the canonical way for a rendered link to carry a title hint
  into pane navigation.
- Header metadata, route bodies, row lists, action menu portals, and reader chrome all
  share the same internal-link decision function.
- Author pages remain the canonical destination for contributor work aggregation:
  `/authors/:handle` renders all visible work by that contributor.

## Final Architecture

The pane runtime boundary covers the whole pane shell:

`WorkspaceHost -> PaneRuntimeProvider -> PaneRouteBoundary -> PaneShell -> route body`

That makes `PaneShell` chrome, chrome override content, and route content members of the
same pane runtime. The route body is still error-isolated by `PaneRouteErrorBoundary`, but
navigation ownership lives above chrome/body composition.

The shared link contract lives in `apps/web/src/lib/panes/paneLinkNavigation.ts`:

- normalize the candidate href with `normalizeWorkspaceHref`;
- reject unsupported destinations with `resolvePaneRoute`;
- read title hints from `data-pane-title-hint`;
- apply the click-policy rules once;
- dispatch same-pane and new-pane navigation through the provided pane runtime.

`ActionMenu` uses the same helper because menu content is portal-rendered into
`document.body`; React context flows through the portal, but DOM event delegation from the
pane shell does not. Generic row and contributor components render semantic anchors only
and rely on the pane contract instead of owning navigation.

## Capability Contract

Any component that renders an internal workspace destination inside a pane should render a
real anchor:

```tsx
<a href="/authors/ursula-le-guin" data-pane-title-hint="Ursula K. Le Guin">
  Ursula K. Le Guin
</a>
```

The component must not:

- call `window.location.assign` for pane-internal navigation;
- call `requestOpenInAppPane` for pane-local Shift-click behavior;
- duplicate route support checks;
- special-case authors, media, podcasts, libraries, or settings links.

Global launch surfaces that are not inside a pane, such as the command palette or add
content tray, continue to use `requestOpenInAppPane` because their job is to open or
activate panes from outside the pane runtime.

## Files And Responsibilities

- `docs/pane-internal-link-navigation-cutover.md`
  - Records the target contract, acceptance criteria, and non-goals for this cutover.
- `apps/web/src/lib/panes/paneLinkNavigation.ts`
  - Owns the shared internal-link resolution and click dispatch rules.
- `apps/web/src/lib/panes/paneRuntime.tsx`
  - Exports the runtime context shape used by the shared navigation helper.
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
  - Provides pane runtime above the full pane shell and delegates all in-pane anchor
    decisions to `paneLinkNavigation`.
- `apps/web/src/components/workspace/WorkspaceHost.module.css`
  - Keeps the full-pane boundary layout-neutral on desktop and full-width on mobile.
- `apps/web/src/components/ui/ActionMenu.tsx`
  - Applies the shared pane-link contract to portal-rendered menu anchors.
- `apps/web/src/components/ui/AppList.tsx`
  - Renders list item anchors with title hints and no local pane navigation logic.
- `apps/web/src/components/contributors/ContributorChip.tsx`
  - Renders contributor author links as semantic anchors with title hints and no local
    pane navigation logic.
- `apps/web/src/components/workspace/WorkspaceHost.test.tsx`
  - Verifies full-pane chrome links route through the current pane and Shift-click opens a
    sibling pane.

## Key Decisions

- Use one route-support check: `resolvePaneRoute(normalizedHref).id !== "unsupported"`.
- Preserve native browser behavior for explicit browser gestures and non-workspace links.
- Treat portals as first-class pane surfaces by using React context in `ActionMenu`.
- Keep `requestOpenInAppPane` as a global-surface API, not an in-pane link workaround.
- Keep anchors as anchors for accessibility, copy-link behavior, browser status text, and
  progressive behavior outside the pane host.
- Do not add author-specific redirects or URL synchronization exceptions.

## Acceptance Criteria

- Clicking a media header author credit from `/media/:id` navigates that same pane to
  `/authors/:handle`.
- Shift-clicking that author credit opens `/authors/:handle` in a new pane and leaves the
  media pane in place.
- Author pane rendering uses the existing contributor endpoint and works endpoint.
- Links in route bodies and pane chrome use the same routing rules.
- Portal-rendered `ActionMenu` links inside pane chrome use the same routing rules.
- External links, API downloads, `_blank` links, downloads, modified browser clicks, and
  unsupported routes are not hijacked.
- There is no component-level fallback from pane links to `window.location.assign`.
- Focus, pane width, title publication, and route remount behavior remain unchanged.

## Non-Goals

- Redesigning author pages or contributor aggregation semantics.
- Changing backend contributor APIs.
- Changing global command palette, navbar, or add-content tray launch behavior.
- Supporting unsupported routes inside panes.
- Preserving any legacy body-only pane link boundary.

## Verification

- Unit/browser tests cover pane chrome click and Shift-click routing.
- Existing contributor chip tests continue to assert canonical author hrefs.
- Existing app list tests continue to assert that row links do not nest action links.
- Typecheck must pass for the pane runtime/link helper contract.
