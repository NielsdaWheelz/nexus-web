# worker startup recreates migrated disposable stores

disposable run `20261025-124448-db1982d20a71` completed migration through0318, then worker startup recreated postgres. the lab database lives on tmpfs, so recreation erased the migrated schema and worker readiness failed.

evidence: the run's `migration.log` ends with `0317 -> 0318`; `workers-start.log` records `postgres-1 Recreate` and `Recreated` before starting either worker. `python/scripts/disposable_runtime.py:1108` starts workers with compose `up -d --no-build` and therefore reconciles their postgres/storage dependencies. both dependencies already started and passed healthchecks in the stores phase before migration. another concurrent run may rebuild the shared postgres image tag, causing compose to see a different image identity at this later dependency reconciliation.

fix the lifecycle owner: worker startup must use `--no-deps` and leave the already prepared stores alone. no shared image locking framework is needed. resolved when a frozen canonical lab starts both workers without recreating stores and reaches schema-backed readiness.
