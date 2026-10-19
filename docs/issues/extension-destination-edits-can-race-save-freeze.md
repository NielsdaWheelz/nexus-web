# extension destination edits can race the save boundary

status: open · origin: 2026-10-14 library chooser specification · area: extension / destination ordering

problem: save can remain in editable draft phase while waiting for permissions or hashing; destination writes can overlap save or draft clearing. simply removing the popup's selection busy state would additionally lose rapid edits.

evidence: `apps/web/src/extension/background.ts:208-226` starts messages independently; `:417-420` updates memory only after asynchronous draft storage; `:832-857` gates edits on phase but freezes save after awaits. `apps/web/src/extension/popup.tsx:193-197` leaves choices enabled while phase is draft. source-derived; no live reproduction yet.

prerequisites: keep the background as draft authority and preserve the existing permission-request user gesture and capture lifecycle. this is draft persistence, not live membership mutation.

fix: order explicit destination deltas at background admission, retain current desired selection during storage, and close edit admission synchronously when save/clear starts. save waits for preceding choices to persist; clear cannot be overtaken by an earlier storage write. stale pushes/replies must not erase newer intent.

acceptance: delayed storage with add a/add b/remove a then save includes only b; save followed by edit rejects the edit; closing the popup preserves admitted work; discard during storage never resurrects a draft; storage failure retains intent and starts no capture mutation.
