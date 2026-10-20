# local runtime storage cutover

status: local reset and storage configuration applied, 2026-10-19.

owner approved discarding local application data. removed the stopped ordinary
`nexus-local` postgres/minio containers and their exact volumes
`nexus-local_postgres-data` and `nexus-local_minio-data`; reset auth project
`nexus-web` with `supabase stop --no-backup`. recreated the compose bridge with
loopback publication. production r2 and unrelated projects were outside the reset.

the replacement persistent volumes are `nexus-local_postgres-data`,
`nexus-local_storage-data` and `supabase_db_nexus-web`. ordinary development is
stopped; start the selected new checkout with `make dev`, then `make migrate`.
both worker make targets now run linux containers. native-host and memory binds
require their explicit compose overlays. there is no object transfer or old path.

in the original checkout's ignored `.env`, renamed `MINIO_PORT` to
`LOCAL_S3_PORT=8333` and changed the loopback `R2_S3_API_ORIGIN` to port 8333.
removed its stale generated `.dev-ports`; `make dev` regenerates it. configure
any separate private extension storage origin to the same local endpoint.

owner delegated dependency-build credential setup. qualification used temporary
read-only deploy key `167013513` on `NielsdaWheelz/universal-memory`; it was
revoked, verified absent, and both private file copies deleted afterward. future
builds require an explicitly supplied read-only dependency key through
`UNIVERSAL_MEMORY_DEPLOY_KEY_FILE`; it is a BuildKit input, never app config.
