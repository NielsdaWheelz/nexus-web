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
