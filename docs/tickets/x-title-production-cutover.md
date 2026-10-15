# x title production cutover

status: in progress; actual reader reopening failed, corrective qualification pending
origin: 2026-10-14 x title implementation
area: release / existing x sources

release `3839b96a0cf2f5c5c103e32917cea130b61c016f` aligned api, both workers and
web at schema `0278`; all seven services are healthy. the canonical controller
verified its fresh 1,271,225,421-byte r2 backup, receipt
`/var/backups/nexus/r2/3839b96a0cf2f5c5c103e32917cea130b61c016f/receipt.json`.
the original frozen census accounts for 53 refreshed imports, one owner-approved
preserved inline-quote conflict, and 11 new children. source/cursor review and
all 64 current normalized title labels pass. old failed receipts remain intact;
no source/title work is unfinished or unaccounted. details and limits are in
[verification](../x-import-titles-verification.md).

the exact `3839` android packet passed entry/sign-in/offline checks; the matching
firefox extension passed ordinary authentication. production capture is explicitly
deferred. `03` title/body/metadata/expanded history passed. bare `114a` FAILED:
its saved endpoint is below the reading line and its active pane mostly outside
the canvas. the server cursor and canonical source remain unchanged.

prerequisite: finish the consolidated reader correction, canonical aligned release
and exact consumer rebind through the coordinated session owner. no further source
or model request is required. reopen the bare media route for
`114a5cc0-bed9-4f3c-b069-b84702abfdd9`; verify restoration to fragment
`826c3bed-826d-482c-a338-c1f5dc08b065`, code-point offset `134`, cursor revision
`6`, publication generation `3`, with both arrival axes accounted for. use the
complete expected locator and
publication evidence in `/tmp/nexus-book-repair-20261014/x-release-handoff.json`;
do not inject a target/hash jump or qualify offset `134` in another fragment.

acceptance: record those actual consumer observations in
`/tmp/nexus-book-repair-20261014/session-release-handoff.json`, with installed
consumer identities; delete this item. phone/extension release ownership remains
with that campaign; no duplicate web/backend release.
