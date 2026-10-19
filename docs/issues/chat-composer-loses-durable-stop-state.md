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

pr #412 merged as `27e961be6`; its pr checks were static. the official
production web and api still served `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`
on 2026-09-28. close after the paired release proves new and existing chat
replies, same-run stream-loss/reload, selected-run stop, draft retention, focus
and transcript position on the exact promoted source.

2026-10-04 chat rewrite: Stop now belongs to the pending leaf of the active
path (`lib/chat/tree.ts::chatView.activeRun`), independent of the stream; the row
and the composer both read stop intent as the saved execution or the live
advisory (monotonic, so the OR is exact); a
suspended answer shows `Response paused` / `Stop requested` without the live
cue. the isolated harness's C5/C10/C23 journeys cover stop, reload mid-run and
stream loss. the paired production release proof above still closes this.
