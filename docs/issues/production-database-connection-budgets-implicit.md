# database capacity remains unqualified

status: open; finite role quotas are implemented but provisional.

search source `7173b6a91484c14f6fe3944b9834763c0fb6ac19` bounds physical pools in
`python/nexus/config.py` and `db/engine.py`, keeps control checkout independent,
and admits one authored bulk-hydration body before database checkout.
the bulk permit and normal functional flow are now exercised on 7173. finite
bounds still do not establish aggregate memory headroom.

production postgres exhausted its 512 mib cgroup and recovered. restored profiling
also exhausted memory while warming retained ordinary connections, before another
search. query peak versus retained/native allocation remains incompletely
attributed; neither an unbounded leak nor a particular allocator is proved.
see [the incident](production-search-postgres-oom.md).

prior c6 native api/postgres/background coexistence completed useful publication
and foreground reads within their actual leaves. evidence is private in
`.nexus-local/native-real-overlap-c6aa98b08-actual.private.tar`. the 7173 e8 case
completed its functional recheck, including writing and both feed publications,
but FAILED because backup creation rejected an invalid filename. the next 1b case
had a valid backup and a parent oom 1/kill 1 under 1280 mib; a strict job remains
DEAD attempt 1. postgres retained its epoch and sampled conservative peak
444350464 bytes stayed below 448 mib. backup naturally verified and maintenance
exited 0, without repairing the failed [overlap](search-backup-overlap-oom.md).
this larger-host component neither qualifies nor disproves actual 2 gib fit.
integration `ff83a5318` passed static/head checks for 0329/down 0328 and the
[canonical/semantic lab composition](../search-reliability-spec.md#evidence-and-uncertainty)
with fake providers. full native memory qualification remains open; the executed
0321 fixtures are a different lineage.
source, frozen cases and operational receipts remain private under
`.nexus-local/native-capacity-7173b6a91/`; the exact historical issue text is in
`.nexus-local/search-takeover-20261028.private/docs-before-final/`.

resolve with the current candidate on the actual 2 gib topology and unchanged
service caps: cold then warmed readers/listeners, both worker lanes, authored
buffers, reachable physical maintenance/autoanalyze and verified backup. all normal
services count while present, including idle workers and retained connections.
the user's revised acceptance permits heavy work and backup to queue and serialize,
including an enforced backup window; useful search and finite queue drain remain
required. simultaneous peak/backup overlap is not required, and the historical
failed verdict is unchanged.
count all processes and operator connections, preserve the 64 mib conservative
postgres reserve and 128 mib host reserve, and require useful completion, zero new
oom/recovery/lost claims and confirmed owned cleanup. freeze numeric quotas only
after that proof. [the spec](../search-reliability-spec.md) owns the full gates.
the actual host keeps its provisioned swap enabled; no-swap remains a service-leaf
constraint. include host swap use/pressure and physical ram headroom in that proof,
without treating swap capacity as the host reserve.
the [capacity specification](../database-capacity-spec.md) owns the reachable
topology and accounting, not a separate delivery pr. the detailed main-side
profiling record is preserved in
`.nexus-local/pr866-e219-doc-contract-before.private/e219/docs/issues/production-database-connection-budgets-implicit.md`.
