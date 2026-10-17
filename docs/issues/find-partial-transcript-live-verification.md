status: open
origin: 2026-10-16 find-bar implementation; owner authorized skipping this case
area: pane find / live verification

the partial-result presentation has no live verification fixture. both available
isolated snapshots (`nexus-search-memory-20261014-postgres` and
`nexus-book-repair-20261014-pg`) returned zero rows from
`media_transcript_states` where state or coverage is `partial`. the owner has no
existing partial transcript and authorized recording this gap instead of
fabricating evidence.

impact: code review can check qualification, zero results and singular/plural
copy, but cannot establish the real transcript-to-find integration.

prerequisite: a real published partial transcript, available in an isolated stack.
open it, find a matching term and an absent term, and exercise next/results.

acceptance: full incomplete-results qualification remains visible
for matching and zero results; descriptor comes from the source; results remain
usable. record source/build, fixture and observed outcomes in
the follow-up pr body, then delete this issue.
