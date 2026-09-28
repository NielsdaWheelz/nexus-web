# chat defect copy invites a new command

status: open; final browser defect journey unverified
origin: 2026-09-27 current-main reliability audit, `fbd08ba68`
area: chat recovery copy

`apps/web/src/lib/llm/failure.ts:32-35,70-71` tells the user to try again in
a new message for an operator or generic defect. `ChatFailureCard.tsx:129-150`
renders that guidance while rerun can be forbidden. a new message is a new
command even when the first run or its effects are uncertain.

at the existing copy owner, say the response could not complete and retain
its support reference without inviting a new send or promising repair. prove
the defect variants have no misleading retry instruction while eligible
rerun and same-run reconnect keep their distinct actions.

the 2026-09-27 candidate changed the operator and generic copy at the shared
failure presenter. an authenticated final-tree terminal-defect browser journey
has not yet been observed.

pr #412 merged as `27e961be6`. close after a terminal defect on the promoted
source shows its support reference without inviting another send, while an
eligible rerun and same-run reconnect still offer their distinct actions.
