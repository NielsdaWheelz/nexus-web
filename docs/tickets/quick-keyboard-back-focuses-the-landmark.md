# keyboard Back right after a keyboard activation focuses the pane, not the row

status: open · origin: 2026-10-09 workspace harness baseline (J5.quick-keyboard-back-returns-focus); unchanged by the workspace reauthoring · area: return memento / collections

Enter on a Libraries row, then keyboard Back with no dwell, returns focus to
the pane landmark; after a ~300 ms dwell the row gets it
(J5.keyboard-back-returns-focus passes). the memento records the focused row
at capture (`:focus-visible`), and the restore focuses the row's
`[data-row-focusable]` or falls back to the landmark
(`apps/web/src/lib/workspace/paneReturnMemento.tsx`, `finish`). with no dwell
the visit's retained rows render at once and the fallback wins; whether the
row or its control is missing two frames after ready is not attributed.

resolved when: harness J5.quick-keyboard-back-returns-focus passes with its
xfail removed.
