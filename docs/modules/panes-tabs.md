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
Unsupported panes leave native browser Find untouched. Page and Note currently
publish local direct-item `FilterRows`; Conversation publishes
`FindOccurrences` with transient Companion results.

Open-pane management belongs to the Nexus Switchboard Root. It renders all
primary panes in stable workspace order, activates or restores an exact pane,
closes panes without dismissing, and exposes the workspace provider's bounded
session-local recently-closed stack. Mobile never recreates the desktop pane
strip or mounts inactive pane columns.
