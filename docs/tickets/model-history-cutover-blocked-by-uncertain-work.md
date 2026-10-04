# model history reset awaits reviewed production disposition

status: open; production release gate
origin: 2026-09-27 combined-release plan, `fbd08ba68`
area: migration 0246

metadata root owns preparation in `feature/metadata-enrichment`. fresh read-only
census at 2026-10-03 22:56:47 UTC confirms deployed
`7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`, revision `0241`, 54 outcome-null
parents: 52 media enrichment and two chat. canonical installed `617baf70e`
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

`617baf70e` implements strict `ReviewedModelCutover`, exact-id archival retirement
and independent completed-write receipts before `0246` history deletion. actual
owner-populated `0241→0256` restore/migration, authenticated inspection/undo,
stale-owner refusal and seven whole-transaction rollback cases pass. see
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
