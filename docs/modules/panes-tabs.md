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

## Sequential Traversal

Across all viewport modes, sequential traversal follows visible panes in stable
`primaryPaneOrder`, skips minimized panes, clamps at the first and last visible
pane, and never wraps. The workspace store is its sole owner, and the
`pane-next` / `pane-previous` keybindings invoke that store command on every
viewport. Mobile additionally maps a primary-touch horizontal swipe on the
Nexus control to the same command. No input restores, creates, reorders, or ranks
panes.

## refresh

`usePaneRefresh` owns the refresh command, gesture, source cancellation, and
settled announcement. `useResource` owns fetch identity and retries. Collection
panes use `useRevalidationSettlement` to own one pending promise and its abort
listener. Each pane keeps its source checks, committed-result marker, and
cancellation restoration; it resolves the promise only after its matching
result is committed. The settlement helper owns no data, fetch, or commit effect.

## Mobile Contract

Mobile workspace mode mounts exactly one active visible primary pane in the main
canvas. Non-active primary panes are not mounted as hidden mobile columns, and
desktop pane-strip controls are absent.

Mobile pane shells do not mount desktop resize handles, fixed primary chrome, or
desktop-attached secondary columns. Secondary content is presented by the
workspace mobile secondary sheet.

pane-local search is visit-local chrome, not pane history or workspace state.
only the active capable `PaneShell` consumes Cmd/Ctrl+F; inactive panes retain
their mounted query/result state, while source replacement retires it.
unsupported panes leave native browser find untouched. collection panes publish
one always-visible control band before their results, with local text first,
domain controls next, then status and reset. `Pane.Search` focuses its input.
page and note editors retain transient `FilterRows` over their direct ordered
items. document panes, including individual conversations, retain transient
`FindOccurrences` with transient Inspector results.

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
