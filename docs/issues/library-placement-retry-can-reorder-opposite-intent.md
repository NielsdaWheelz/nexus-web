# a delayed placement request can overtake the opposite intent

status: open · origin: 2026-10-14 library picker design audit; rechecked at `2e154f053` · area: api / library command ordering

problem: placement add and remove are absolute, but nothing orders an earlier
request against a later opposite one. after a lost or timed-out answer the
client rereads and admits the next edit; the earlier request can still be
running and land after it.

evidence: the client no longer replays lost writes.
`apps/web/src/lib/libraries/placementController.tsx:3-6,198-207` retires an
unknown answer, rereads and releases later edits. `:172-173` sends
`addPlacement`/`removePlacement` (`apps/web/src/lib/libraries/api.ts:121-142`)
under a 30-second client deadline (`:76,92`) with no expected version;
`python/nexus/api/routes/libraries.py:189-202` accepts none. library locks
serialize transactions but cannot tell a delayed request from a current one.
source-derived; no delayed-request journey was run.

fix: fence absolute membership commands at the library owner with a
server-checked version or an equivalent ordering fence, per the repository's
expected-version write rule. define the version scope; preserve authorization,
inherited placement and last-reference rules. no replay ledger, command id or
browser-persisted app data: the earlier replay/session-storage design is retired.

resolved when an original request released after its lost answer, a reread and
an inverse command cannot overwrite the later accepted intent. cover no-op
membership commands as well as changes; a reread alone is not proof that the
earlier request settled.
