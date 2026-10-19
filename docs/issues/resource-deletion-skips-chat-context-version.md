# resource deletion skips surviving chat context versions

status: open; source-confirmed, no concurrent reproduction
origin: 2026-10-16 details specification; main `48bc7fbad`
area: resource graph / deletion / context versions

`python/nexus/services/notes.py:141-157` deletes a page through graph cleanup.
`python/nexus/services/resource_graph/cleanup.py:54-111` deletes incoming
context edges, but bumps only the `links` lane for surviving user/highlight-note
endpoints. it neither locks surviving conversations nor bumps their `context`
version. normal context removal now does both at its context owner.

impact: deleting an attached resource changes a surviving chat's context
membership without advancing the version used to identify that membership.
admission now freezes the reference set returned by context assembly; that
separate fix does not repair graph teardown versions.

prerequisite/fix: make teardown obey the context owner's membership/version
contract, with explicit lock ordering across resource and conversation deletion.
this is outside the details presentation change; do not patch it in the reader.

acceptance: deleting an attached resource advances each affected surviving
chat's context version once; stale context commands detect the changed version.
ordinary detach, resource deletion and concurrent admission retain consistent
membership, with no lock-order regression. qualify through actual public writes.
