# a note attachment rescans the workspace to learn its visit retired

status: open · origin: notes re-slice spec N10, 2026-10-21 · area: notes editor / pane chrome

an upload started from a note body subscribes to every workspace change and, on
each, scans every pane's current visit and history to see whether its own visit
still exists, aborting when it does not
(`apps/web/src/components/notes/NoteEditor.tsx:420-423`). the work guard confirms
loss but never announces a visit's retirement, so each pipeline re-derives it.

impact: cost grows with panes and history on every workspace change while an upload
runs; the retirement rule lives in an editor instead of the visit's owner.

fix: pane chrome offers a visit-retirement signal (subscribe to one visit's end);
the attachment pipeline aborts on it.

resolved when the upload uses that signal and no notes code reads workspace history.
