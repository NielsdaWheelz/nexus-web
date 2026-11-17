# workspace.md says the notes pane publishes `refresh`; it does not

found 2026-11-15 at `fcd6843db`; still present at `6fc320a75`.
`docs/modules/workspace.md:411-417` includes `notes` among finite panes publishing
`refresh`. `apps/web/src/app/(authenticated)/notes/NotesPaneBody.tsx:48-56`
publishes only query and header descriptors; it has no refresh descriptor or
corresponding pull gesture.

the local account database owns this index online and offline. resolve the
documentation mismatch against that owner contract; do not add a server refresh
merely to satisfy an outdated pane list.
