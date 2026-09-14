status: open
origin: 2026-09-14 bounded-workspace capacity run 71e44d03ca91ca18 at 1700c6d987
area: background indexing / lease health

the real 4,100-chunk indexing job `97461f14-0b13-4eda-9697-e19a183d98e7`
logs `worker_heartbeat_failed` at 09:19:14.044819 utc. postgres reports
`canceling statement due to lock timeout` while locking `background_jobs`
tuple `(95,11)`. the job subsequently completes at 09:19:23.481606 utc.
the exact exception is retained in `api-capacity-candidate-worker-epub.json`
under that run in `nexus-web-bounded-web-proof/test-results/runs/`.

inspect the indexing publication transaction and job ownership fence against
the independent heartbeat transaction. identify the actual blocking owner;
completion does not establish that lease renewal has sufficient headroom.
preserve atomic publication and stale-attempt refusal. do not mask the error
or lengthen lease/timeouts without a measured contract.

acceptance: maximum accepted indexing and concurrent heartbeat complete with
their ownership fences intact and no heartbeat lock failures; a stale attempt
still cannot publish or renew the replacement's lease.

reproduced in `a4f6e118079a369e` at `012606a32417b19ca2fb2a0577db5ec9d43bc24f`:
index job `a017b335-a91e-4511-8228-ca839268a57a` hits the same lock timeout
at 10:02:28.254493 UTC on tuple `(95,12)`, then completes at
10:02:37.607593 UTC. exact blocking transaction still requires attribution.

bounded insertion preparation is staged after actual row-by-row sensitivity
`25bc3f6e6e6b358c` and focused candidate `a7c51d710386cd10`. source/value/fk and
rollback oracles pass. fewer execute/executemany driver calls do not establish
fewer server statements or relief of the observed heartbeat lock; actual
blocking-owner attribution and the enclosing maximum-worker replay remain.

the proposed late job fence is not a safe local replacement. the publication
callback in `tasks/media_content_reindex.py` uses `retry_serializable` and
commits even when publication returns `None`. after writes, lost ownership
must roll back the entire transaction. `lock_and_renew_running_job_claim`
already validates the exact attempt and heavy-capacity owner, but moving it
after bulk writes makes intervening heartbeat updates conflict with the
transaction's original snapshot. postgres requires a retry when a serializable
transaction locks a row changed since that snapshot; see the
[transaction isolation contract](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-REPEATABLE-READ).

do not downgrade only this callback to read committed. its media → index-state
locks serialize same-media publishers/revision changes, but not graph writers.
`resource_graph/context.py::add_context_ref_without_commit` admits direct
content-chunk/evidence-span targets using unlocked visibility reads, then
creates bare edges. `resource_graph/cleanup.py` removes predicate-selected
edges and motif halves without foreign keys to those polymorphic endpoints.
no complete shared endpoint lock protocol was found. direct context routes
also omit a serializable wrapper; this existing source-level gap is recorded
separately in [the context-deletion ticket](conversation-context-can-race-resource-death.md).
a context writer can potentially validate an old chunk, insert after cleanup
passed, and leave a bare edge to a deleted chunk. neutral user links instead materialize passage
anchors; they are not this direct-target witness. retain serializable and the
current fence pending measured publication duration and actual blocker/lease
attribution. observed heartbeat timeout does not itself prove stale publication
or a lost claim.

the current registry gives `media_content_reindex_job` a 900-second lease.
the early publication fence renews both job and heavy holder. the worker logs
the observed sqlalchemy exception and continues; only a renewal returning
false sets its lost-claim signal. measure actual fence-to-commit time against
the renewed expiry instead of inferring lease loss from one lock timeout.
