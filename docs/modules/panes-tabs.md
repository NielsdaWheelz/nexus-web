# Panes And Tabs

## Scope

Primary panes are workspace-owned route containers. The pane strip is a desktop
workspace affordance for switching, minimizing, restoring, and closing primary
panes.

## Desktop Pane Strip

`WorkspacePaneStrip` renders only in desktop workspace mode. It reflects the
primary pane order and visibility state from the workspace store and delegates
pane activation/minimize/restore/close actions back to `WorkspaceHost`.

The strip is not part of mobile navigation. Mobile renders the active primary
pane directly and relies on app-level navigation plus pane chrome actions.

## Mobile Contract

Mobile workspace mode mounts exactly one active visible primary pane in the main
canvas. Non-active primary panes are not mounted as hidden mobile columns, and
desktop pane-strip controls are absent.

Mobile pane shells do not mount desktop resize handles, fixed primary chrome, or
desktop-attached secondary columns. Secondary content is presented by the
workspace mobile secondary sheet.

Pane-local Search is visit-local chrome, not pane history or workspace state.
Only the active capable `PaneShell` consumes Cmd/Ctrl+F; inactive panes retain
their mounted query/result state, while route/source replacement retires it.
Unsupported panes leave native browser Find untouched. Collection-shaped
Lectern, Author, Conversations-index, Library, Libraries-index, Podcast, and
Notes-index panes publish `FilterRows` over their loaded canonical rows; Page
and Note publish it over their direct ordered surface items. Filtering is
synchronous and local, never request or URL identity. Domain View/Filter/Sort
controls live in the expanded row as `Filter text -> domain controls -> Clear
filters`; collapsed Filter chrome marks any applied non-default domain state.
Document-shaped panes, including an individual Conversation, publish
`FindOccurrences` with transient Companion results.

Every domain view is pane-URL state decoded by one strict, total owner codec.
An unknown, duplicate, partial, or redundantly-default owned key is `Invalid`:
the pane renders `Invalid {surface} view` with `Reset view` and makes no
collection request. Because a view change replaces the pane URL on the same
path, every refinement-capable route declares `queryNavigation: "in-place"` so
its body survives the replacement with its local text, focus, scroll, and
previously committed rows intact.

Nexus Root projects at most five open panes in stable workspace order and then
one direct `Manage tabs…` row. The dedicated Manage Tabs page renders all
primary panes, activates or restores an exact pane, closes panes without
dismissing, and exposes the workspace provider's bounded session-local
recently-closed stack. Recovery opens the same page with the exact retained
activation; direct Manage Tabs needs no retained activation. Mobile never
recreates the desktop pane strip or mounts inactive pane columns.
