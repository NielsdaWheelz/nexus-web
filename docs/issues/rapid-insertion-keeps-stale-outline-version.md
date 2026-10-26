# rapid insertion keeps a stale outline version

problem: after a note insertion is acknowledged, another insertion can capture
the new edge with the old outline version while the adjacency refresh is pending.
the server refuses the second write; the user must review the retained draft.

evidence: `d29cbcda38b6b7b8e273da3ad44059f0f499cf8d`, real browser lab
`20261025-162141-d6cf6900d732`, following journey, `1-trace.network`.
at `23:24:18.011Z`, the mobile literal `@` insertion acknowledged highlight
`89a4fbed-2c03-49d3-a8c9-9f104117a00b` links version `5 → 7`, creating edge
`898bdcdd-b9a2-4818-95a0-8abd1ebc75cf`. outline reads at `.015Z` and `.170Z`
were aborted. at `.755Z`, the next insertion used that new edge as `after` but
`expected_links_version: 5`; it received `409 E_RESOURCE_CONFLICT`,
`Outline version changed`, request `ce2af6f7-19fc-447a-aa7a-0cc7468bc2d0`.
the next successful outline read, version `7`, completed after the refusal.

owner: `apps/web/src/lib/notes/useOutlineSession.ts:2145` derives positions from
the optimistic graph before consulting a pending edge's producer proof. the
graph contains the new edge but retains the observed version. acknowledgement
records version `7` on the pending occurrence at line `1709`, without replacing
that graph observation. `apps/web/src/lib/notes/writes.ts:474` captures only live
queued predecessors, so the already settled producer cannot advance the fence.

reproduce: insert prose in an expanded resource's trailing blank line; after
its acknowledgement, resize or otherwise invalidate its pending outline read,
then immediately insert again after the new edge, before fresh adjacency lands.

proposed repair: the position owner must preserve the exact insertion producer's
causal proof while its acknowledged edge lacks a current adjacency observation.
do not silently retry, substitute a newer unrelated version, or move the slot.

resolved when rapid consecutive insertions succeed at their captured positions
without an intervening refresh, including an aborted refresh and an already
settled producer. concurrent unrelated changes must still refuse stale intent.
this writing-owner defect is outside the reader controls presentation bundle.
