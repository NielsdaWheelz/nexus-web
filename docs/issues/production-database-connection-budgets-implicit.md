# database capacity remains unqualified

status: open; finite role quotas are implemented but provisional.

search source `7173b6a91484c14f6fe3944b9834763c0fb6ac19` bounds physical pools in
`python/nexus/config.py` and `db/engine.py`, keeps control checkout independent,
and admits one authored bulk-hydration body before database checkout. these
bounds do not establish aggregate memory headroom or useful concurrent progress.

production postgres exhausted its 512 mib cgroup and recovered. restored profiling
also exhausted memory while warming retained ordinary connections, before another
search. query peak versus retained/native allocation remains incompletely
attributed; neither an unbounded leak nor a particular allocator is proved.
see [the incident](production-search-postgres-oom.md).

prior c6 native api/postgres/background coexistence completed useful publication
and foreground reads within their actual leaves. evidence is private in
`.nexus-local/native-real-overlap-c6aa98b08-actual.private.tar`. current `7173b6a91`
qualification used a 1280 mib docker parent on a larger host and FAILED at notes
before any authored writing committed; cleanup was confirmed. neither that
envelope nor an earlier component pass proves actual 2 gib fit. the current main
integration passed static checks with one 0329/down 0328 head; its runtime is
unqualified and the earlier 0321 fixtures are a different lineage.
source, frozen cases and operational receipts remain private under
`.nexus-local/native-capacity-7173b6a91/`; the exact historical issue text is in
`.nexus-local/search-takeover-20261028.private/docs-before-final/`.

resolve with the current candidate on the actual 2 gib topology and unchanged
service caps: cold then warmed readers/listeners, both worker lanes, authored
buffers, representative physical maintenance/autoanalyze and online backup.
count all processes and operator connections, preserve the 64 mib conservative
postgres reserve and 128 mib host reserve, and require useful completion, zero new
oom/recovery/lost claims and confirmed owned cleanup. freeze numeric quotas only
after that proof. [the spec](../search-reliability-spec.md) owns the full gates.
