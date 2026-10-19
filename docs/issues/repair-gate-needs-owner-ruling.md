# the repair gate needs an owner ruling

status: open; waits on the owner.
origin: reauthoring campaign review, 2026-10-18.
area: release repairs, [reauthoring queue](../reauthoring.md#queue) item 11.

the owner's 2026-10-13 rule: after the release repairs R1-R7
([release record](../releases/2026-10-13-nexus.md)), purge the repair/cutover
code, squash the migrations and drop `model_cutover_archives`. the queue gates
that on R3, R4, R5 and R7 closed. state 2026-10-18:

- R3 closed: the 168 approved reader repairs are live
  ([2026-10-15 release](../releases/2026-10-15-nexus.md)).
- R4 dispositioned, not closed: frankenstein's credit repair is accepted and its
  consumer check is left unresolved by owner decision; closing it needs a
  session of the media's legitimate owner
  ([issue](frankenstein-consumer-check-unresolved.md)). the 235 retained epub
  source-person mismatches stay a deferred follow-up
  ([issue](epub-contributors-production-repair-pending.md)).
- R5 owner-deferred: brave answers 402 and the openai/brave key rotation is not
  done ([issue](brave-search-payment-required.md)).
- R7 open: the owner has not closed the rollback window.

no campaign work closes R4 or R5, so as written the gate never opens, and the
purge, squash, archive drop, db substrate, reader python, android, end release
and tooling slices wait forever.

ruling needed: do a dispositioned R4 and a deferred R5 count as closed for the
repair-code purge? R5 uses no repair code. a yes for R4 deletes
`services/epub_contributor_repair.py`, so a later fix of the 235 mismatches
starts from new code. R7 needs the owner to close the rollback window either way.

resolved when the ruling is in the decision log of
[reauthoring.md](../reauthoring.md) and queue item 11 states the gate it implies.
