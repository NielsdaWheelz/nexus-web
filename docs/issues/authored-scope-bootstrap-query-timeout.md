# authored scope bootstrap query times out

open until the existing installed clients complete scope provisioning after
forward repair. production `5fbca67f4` / schema 0329 returns statement timeouts
from `POST /authored/scope-inputs`; firefox and android 0.3.9 report “couldn't
sync”. local saving and change-feed acknowledgement remain separate facts.

three retained api failures reach `scope.py` `inputs` → `_revision` → `_records`
and expire during the server cursor's first fetch, before any metadata record.
the first is `56b1c359-98d8-4e5b-aa37-3ad46f13b0ab` at
2026-10-30T18:42:35Z. the held hydration permit explains concurrent 503
`E_DATABASE_BUSY`; replica registration and change-feed reads return 200.

the body interval query joined the complete canonical interval relation back to
readings. its estimated plan placed that relation inside an unmaterialized nested
loop, expecting one qualifying reading; actual core metadata contains 1,107.
original body construction timed out at 30 seconds; the full diagnostic statement
also timed out at 115 seconds. those censored executions returned no actual plan.

the narrow repair passes ready ordinary-text reading ids into the existing
canonical interval owner and removes the redundant outer readings join. the
same viewer/snapshot, fragment checks, bounds, records, revision digest, page
cursors and final fence remain. on current production data, the candidate body
returned 15,516 rows in 2.825 seconds and the full metadata statement returned
22,201 rows in 4.609 seconds under the unchanged 30-second limit, with no temp io.
this proves the affected query, not installed client completion.

metadata still enumerates records for its digest and page; text/status requests
still compute the account-wide digest. that retained cost is outside this narrow
repair, not evidence that installed hydration has finished.

resolved when both existing installed clients finish their real scope and reach
current, with preserved writing and bidirectional sync. no client clear, account
reset, pending-change deletion, timeout increase or partial-current claim.
