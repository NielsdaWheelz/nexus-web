# chat composer loses durable stop state

status: open; final browser journey unverified
origin: 2026-09-27 current-main reliability audit, `fbd08ba68`
area: chat browser

`apps/web/src/components/chat/useConversation.ts:1368-1379` calls every
pending assistant running even when its row is suspended.
`ChatComposer.tsx:946-955` targets Stop through the active sse tail, which can
disappear on disconnect; it does not use the pending run's persisted stop
intent. the row can therefore say paused while the composer announces progress
or loses Stop. no new production browser observation was made for this audit.

project phase and cancel intent from one canonical selected pending run into
the row, composer and advisory. keep stop available after stream loss; disable
repeat stop after accepted intent; show paused without progress animation or
false reconnect remedy. prove these states in an authenticated browser across
reload, preserving draft, partial text, focus and transcript position.

the 2026-09-27 candidate now uses the selected pending run and monotonic
accepted stop intent. disposable browser/reducer proofs covered advisory loss,
reload and stopped/paused copy. an authenticated local existing chat rendered
`Stop requested` during catalog outage. a final-tree new/existing reply and
full reload/focus/transcript journey still need a live model host.
