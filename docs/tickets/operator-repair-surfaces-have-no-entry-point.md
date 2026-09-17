# operator repair surfaces have no entry point

status: open (decision needed) · origin: 2026-09-17 slop sweep (claude session)
· area: generation and ingest repair · oi-142

two repair surfaces exist in full and nothing can reach either.

(a) seven uncertain-generation reconcilers.
`services/artifacts/engine.py` (`reconcile_uncertain_build`,
`reconcile_uncertain_idea_resolution`), `services/dawn_write.py:265-334`,
`services/oracle.py:576-661`, `services/synapse.py:375-431`,
`services/media_intelligence.reconcile_uncertain_media_unit` and
`tasks/enrich_metadata.reconcile_uncertain_metadata_generation` have zero
callers: `rg -n 'reconcile_uncertain' .` over the whole repo returns 25 hits,
each a def, a `retry_serializable` label string, or an import inside another
reconciler. `jobs/registry.py` binds handlers by literal `handler_path`, none of
them these; `python/nexus/ops/` has no reconciliation CLI; `release.py`'s only
`nexus.ops.*` invocation is `oracle_reconcile`. the shared helpers
`llm_execution.prove_uncertain_generation_not_dispatched_in_current_transaction`
(:1416), `llm_execution.reconcile_uncertain_generation_in_current_transaction`
(:1479), `tool_runtime/execution.reconcile_uncertain_tool_completion` (:655),
`jobs/queue.replace_dead_job_payload` (:1589) and
`GenerationUncertainResolution` are called only from those seven, so they die
with them (~600 lines).

(b) `python/nexus/api/routes/internal_ingest.py:1-87` — POST
`/internal/ingest/reconcile`, GET `/internal/ingest/reconcile/health`, POST
`/internal/ingest/{content-index,source}/{media_id}/retry-dead`. `rg -n
'internal/ingest'` returns the four decorators and
`docs/cutovers/media-pipeline-reliability-hard-cutover.md:945-951`. there is no
BFF proxy (`apps/web/src/app/api` has no `internal*` directory and no catch-all)
and no script, make target or runbook calls them; they are reachable only by
hand-curl with `X-Nexus-Internal`.

this is not forgotten code: `docs/modules/jobs.md:322-326` and
`docs/modules/llms.md:141-146` state the uncertain-dispatch repair path as
current behaviour, which is exactly why deleting it is a capability decision.

decision: is an operator repair surface for uncertain durable generations
wanted? if yes it needs one entry point — one route or one ops command, not
seven per-owner wrappers. and has the owner ever curled the internal ingest
routes?

prerequisite: the owner's answer on each of (a) and (b).

fix: on delete, cut all seven reconcilers in one change together with the four
shared helpers above, then reword `docs/modules/llms.md:144` and
`docs/modules/jobs.md:322-326` to state that an uncertain dispatch stays
suspended with no automatic reset. note `requeue_dead_job` keeps a live caller
(`chat_runs.py:980`) and must stay. for (b), delete `internal_ingest.py`, drop
its router from `api/routes/__init__.py`, and delete
`IngestReconcileEnqueueOut` / `IngestRecoveryHealthOut` / `IngestRecoveryJobOut`
plus `get_ingest_recovery_health` and `enqueue_stale_ingest_reconcile` if they
lose their last caller; keep `repair_dead_source_execution` and
`repair_dead_media_reindex`, which the viewer-facing retry stages use. on keep,
build the single entry point in the same change.

acceptance: no repair function survives without a caller, and the docs describe
the repair path the code actually has.
