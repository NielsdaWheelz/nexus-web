# non-reader find smoke lacks live data

status: blocked; owner approved chat and dossier blockers
origin: 2026-09-26 reader navigation acceptance
area: chat, dossier and transcript find

the isolated stack has no chat messages or dossier revisions, and its model
catalog returns 503. it cannot produce a normal chat or dossier find journey.
no task-safe transcript fixture was available for the playback smoke check;
this separate check was not covered by the owner's approval.
static compilation passed, but those live consumer checks have no green receipt.

prerequisite: a configured development catalog/provider or task-safe existing
messages, dossier revision and transcript on the isolated stack.

acceptance: run normal browser find for each consumer; chat and dossier results
activate without reader-only return behavior, and transcript find leaves playback
unchanged. record actual data identities and browser outcomes; delete this ticket.
