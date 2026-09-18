# readiness depends on an ingest health audit

status: open · origin: 2026-09-17 slop sweep, rechecked at `719f32173` · area:
runtime health · oi-160

`runtime_health.py:24-51` defines a correlated audit of accepted source attempts
and their exact ingest jobs. `is_database_ready` runs it and queries the last
successful reconciler when given `reconciler_max_age_seconds`.
`api/routes/operational.py:27-35` and `apps/worker/main.py:74-82` enable that
condition in staging and production. stale or missing ingest reconciliation
therefore makes the api and both worker lanes unready even when their database
and schema are available. compose gates public ingress and the interactive
worker on the api healthcheck. the earlier ticket's semaphore no longer exists.

`services/ingest_recovery.py:197` also uses the audit for its explicit operator
health projection. that is a live consumer; deleting the audit outright would
break an existing diagnostic contract. the internal ingest routes decision in
oi-142 need not block separating those responsibilities.

prerequisites: none for the separation. keep the operator interface and scheduled
reconciler. make readiness own bounded database reachability and exact schema
identity; move the audit sql to its one remaining ingest-health consumer. remove
the reconciler-age argument and api/worker computations, and update the release
readiness contract. retain worker listener/cgroup requirements and database
connection/statement deadlines.

trade-off: an ingest defect will remain visible through ingest health but will
stop blocking unrelated reads, ingress and interactive work during deployment.

acceptance: a real-db proof shows missing/stale reconciliation and a defective
source-job link do not change readiness with the correct schema; wrong/missing
schema and database failure still do. ingest health still reports the defect.
verify the actual api response and worker predicate, including their retained
requirements; preserve the deployment controller's exact response body.
