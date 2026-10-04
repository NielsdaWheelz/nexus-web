# model history reset awaits reviewed production disposition

status: open; production release gate
origin: 2026-09-27 combined-release plan, `fbd08ba68`
area: migration 0246

tracking: [github #484](https://github.com/NielsdaWheelz/nexus-web/issues/484)

preparation is delivered by [pr #482](https://github.com/NielsdaWheelz/nexus-web/pull/482).
the application reset/release owner owns production disposition. fresh read-only
census at 2026-10-03 22:56:47 UTC confirms deployed
`7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`, revision `0241`, 54 outcome-null
parents: 52 media enrichment and two chat. the historical installed `617baf70e`
snapshot on the actual restored archive selects 69 generation/metadata jobs and
one original orphan parent `c6c6be28-0e1b-5d3a-a267-bc080132bbf6`.
the broader census contains 70 jobs; unrelated succeeded `synapse_scan`
`fa2cec95-23eb-413d-b695-87e2f129b8c8` has empty coordination/no admission and
is excluded from disposition. the actual full-chain proof retains it unchanged.
original rows, admissions/coordination and domain hashes:
`/private/tmp/nexus-metadata-release-uy48cjy2/production-model-metadata-census.json`,
sha256 `9f8dbb5311562eba80ad17ef37e880ac86ed5258a5f4ea2b4508320e80d6c212`.
visible existing R2 receipts predate this state (`0236` and `0230`). the fresh
live exported-snapshot archive was actually restored; it remains preliminary,
not final drained-release authority. no production drain/disposition/deploy.

current frozen `bcb86e0204ef2ea347a8836a9e5d48f031d09134` implements strict
`ReviewedModelCutover`, exact-id archival retirement and independent
completed-write receipts before `0246` history deletion. actual controlled
owner-populated `0241→0257`, authenticated inspection/undo and stale-owner
refusal pass: `0257-metadata-restored-cutover.receipt.json`, sha256 prefix
`b0b50e9f192f`, under `/private/tmp/nexus-metadata-release-uy48cjy2/`.
eight whole-transaction refusals pass (`25cd59b71508`). a separate controlled
negative reaches native `0255`, then metadata `0256` rejects an inactive
uncertain memo; all 114 public tables, full schema and credential table roll
back exactly to `0252` (`13d02c88c9c4`). the copied parent terminal retains its
original nested evidence; no authoritative child rows are invented or copied,
and that parent remains no recovery authority.

the controlled owner fixture adds one open parent/job: its 55 null parents and
70 retired jobs do not replace production's canonical 54/69/one-orphan census.
earlier `617baf70e/0256` and old-graph proofs remain historical. other current
installed/consumer/controller preparation receipts are recorded in
[the release ticket](production-release-pending-since-7dc68929b.md) and
[verification](../metadata-enrichment-verification.md#release-preparation).
no original uncertainty gained a terminal, seal or redispatch authority.

prerequisites: separate production authorization, stopped writers/native host,
fresh exact census and source/revision-bound R2 backup, actual restore/proof of
those exact bytes, reviewed migration losses and exact original IDs. follow
[the finite sequence](../../deployment.md#reviewed-model-history-reset).

acceptance: the reviewed aligned production release commits its audit/receipts
and canonical head; original uncertainty/history remains in the verified backup,
completed writes remain inspectable/undoable and stale replay cannot execute.
unknown owners or unfinished writes refuse atomically; no fabricated outcome or
old generation redispatch. delete this ticket only after actual release receipts.
