# Reader Contents Secondary Cutover

This records the reader table-of-contents state after the workspace secondary
pane consolidation.

## Target Behavior

- EPUB and web article contents are exposed as `reader-contents`, a
  `reader-tools` secondary surface.
- The reader toolbar `Contents` button toggles the secondary pane to the
  Contents surface. If Contents is already the active visible surface, the
  button closes that secondary pane.
- Contents is independent of highlights. It is available whenever navigation
  nodes exist, even when the Highlights surface is absent.
- Contents shares the same secondary pane group, width policy, desktop shell,
  and mobile drawer as Highlights and Document chat.
- Selecting a Contents entry runs the existing reader navigation path. On
  mobile it also closes the secondary drawer; on desktop it leaves the
  secondary pane open.

## Architecture

- Surface registry and icons live in
  `apps/web/src/lib/panes/paneSecondaryModel.ts`.
- The route publishes reader surfaces through
  `usePaneSecondary` from `PaneSecondary.tsx`.
- The tree UI is `ReaderContentsNav` under `apps/web/src/components/reader/`.
- The secondary shell owns scrolling. `ReaderContentsNav` has no independent
  scroll container.
- Primary reader width is unaffected by opening, closing, or switching Contents.
  Workspace layout may translate neighboring panes, but no pane is resized.

## Contract

- Route code opens Contents with
  `paneRuntime.requestSecondarySurface("reader-contents")`.
- Route code closes the active secondary with `paneRuntime.closeSecondaryPane()`.
- No legacy secondary API, state, action, test id, component, or doc language
  is part of the contract.

## Acceptance Criteria

- No legacy secondary-pane references remain in source, tests, or active docs.
- `reader-contents` is present in the secondary surface registry and both
  desktop and mobile secondary icon maps.
- EPUB and web article toolbar Contents controls expose correct `aria-pressed`
  state.
- Mobile Contents selection navigates and closes the drawer.
- Desktop Contents selection navigates without changing pane widths or closing
  the secondary pane.
