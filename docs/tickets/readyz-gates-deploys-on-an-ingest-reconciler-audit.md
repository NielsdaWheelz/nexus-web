# /readyz gates the deploy on an ingest-reconciler audit

status: open · origin: 2026-09-17 slop sweep (claude session) · area: runtime
health · oi-160

`GET /readyz` (`python/nexus/api/routes/operational.py:22-43`) runs, on every
probe, the 29-line correlated-subquery proof
`ACCEPTED_SOURCE_JOB_DEFECT_COUNT_SQL` (`runtime_health.py:21`) that every
in-flight `media_source_attempt` points at exactly one matching `background_jobs`
row, plus a freshness check on the reconcile job, behind a
`threading.BoundedSemaphore(1)` (`_database_readiness_slot`). that is a
data-integrity audit on a readiness path, for one user on one box with immediate
rollback and live repair. `rg -n
'ACCEPTED_SOURCE_JOB_DEFECT_COUNT_SQL|reconciler_max_age_seconds'` returns only
`runtime_health.py` and `operational.py:27-37`; the other call sites are
`apps/worker/main.py:84-92` and `services/ingest_recovery.py:21,197`.

it is not stray code. `deploy/hetzner/docker-compose.yml` gates `caddy` (public
ingress, :40-42) and `worker-interactive` (:121-125) on `api:
service_healthy`, and the api healthcheck is `curl
http://127.0.0.1:8000/readyz` (:97); `release.py:4550,6522` assert the exact
`{"data":{"status":"ready"}}` body, and
`docs/cutovers/immutable-production-release-hard-cutover.md:242` states the
/readyz contract. so the branch ties public ingress and the interactive worker
to ingest-reconciler liveness. removing it only loosens the gate — a deploy
cannot start failing because of this.

fix: cut all four call sites together — delete
`ACCEPTED_SOURCE_JOB_DEFECT_COUNT_SQL`, the `reconciler_max_age_seconds`
parameter of `is_database_ready` and every branch under it, and
`operational.py:26-30`'s `2 * ingest_reconcile_schedule_seconds` computation,
reducing `is_database_ready` to the alembic-head identity check. delete
`_database_readiness_slot` regardless of whether the reconciler branch stays.
update the cutover doc's /readyz contract in the same change.

prerequisite: tied to the internal-ingest routes decision in oi-142 —
`services/ingest_recovery.py`'s operator aggregate feeds those routes, so settle
(b) there before cutting here.

acceptance: `/readyz` reports readiness from the alembic head alone, a deploy
still brings caddy and the interactive worker up, and `release.py`'s exact-body
assertions still pass.
