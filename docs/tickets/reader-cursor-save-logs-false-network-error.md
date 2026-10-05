# reader logs a cursor-save network error the server accepted

status: open, fixed by reader pr2 · origin: 2026-10-04 cleanup campaign (claude coordinator), reader harness baseline · area: web reader (hosted pane)

## what is wrong

on every reload or navigation after reading, the console shows "Failed to save reader cursor: Network request failed" although the server accepted the write (seen throughout the reader harness baseline). unclear whether the "progress not synced" ui ever shows for it.

## fix

the unload/keepalive save should report only real failures; verify the notice path (pr2). see `reader-pr2-replace-hosted-pane.md`.

## acceptance

the pinned journey passes on the hosted pane.
