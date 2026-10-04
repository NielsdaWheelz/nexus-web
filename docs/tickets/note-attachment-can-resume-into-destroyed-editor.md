# note attachment can resume into a destroyed editor

status: deferred · origin: 2026-10-04 source audit · area: notes / web

`apps/web/src/components/notes/NoteBodyEditor.tsx:619–670` awaits upload, then inserts into the captured editor view and calls `view.setProps` in `finally`. its cleanup at `:947–953` destroys that view when the pane closes or the resource changes. installed `prosemirror-view` clears its document view on destroy; a delayed accepted upload can therefore resume against a destroyed editor, with the `finally` call able to reject outside the earlier catch. this is a source-qualified lifetime risk, not an observed failure or lost upload.

hold an actual upload completion after native acceptance, replace the pane, then release it. resolve the accepted upload's note-insertion disposition explicitly, with no stale-view call or unhandled rejection. keep ordinary live-editor attachment behavior and cleanup.
