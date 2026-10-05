# a cursor that failed to load is never read again

status: open · origin: 2026-10-05 reader rewrite pr2 (carried from `reader-core-pr2-surface-gaps`) · area: web reader (`lib/documentReader/progress.ts`)

when `GET /media/{id}/reader-state` fails on open, the document opens anyway with
*reading position unavailable* and nothing saves (correct: the reader must not
write over a cursor it never read). but `revalidate()` returns early while the
view is `LoadFailed`, so pane activation, focus, `online` and `pageshow` never
retry: the reader stays read-only until the pane is reopened. the hosted pane is
long-lived, so a transient failure (offline at open, a 5xx) costs the whole
session's progress.

fix: let revalidation retry the load while `LoadFailed`; on success adopt the
cursor exactly like a newer canonical (silently when dormant, else the *newer
reading spot* choice), then save normally.

acceptance: with the cursor GET failing at open and succeeding later, a
focus/activation after recovery shows the saved spot (or the choice), and reading
on saves; no write happens before the read succeeds.
