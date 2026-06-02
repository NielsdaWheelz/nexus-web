# Deployment Notes

Nexus production is intended to run with:

- Vercel for the Next.js frontend/BFF.
- Supabase Auth only.
- One Hetzner Cloud VPS for Postgres, the FastAPI API, and the worker.
- Cloudflare R2 for object storage.
- Caddy on the VPS for HTTPS at the API domain.

The goal is to keep the operational surface small while avoiding background
workers or APIs running in more than one production location. This is a hard
cutover: production does not fall back to Supabase Database or Supabase Storage.

## Current Production

- Frontend: `https://nexus.nielseriknandal.com`
- API: `https://api.nexus.nielseriknandal.com`
- Hetzner server: `nexus-api-worker`
- Hetzner IPv4: `5.78.194.235`
- Hetzner location/type: `hil` / `cpx11`
- Vercel project: `niels-erik-nandals-projects/nexus-web`
- Supabase Auth project URL: `https://jiaozhsisiphjtomoamy.supabase.co`

## Runtime Shape

On the Hetzner VPS:

- `postgres`: Postgres with pgvector, backed by the Compose `postgres_data`
  volume.
- `caddy`: public HTTPS reverse proxy.
- `api`: FastAPI service built from `docker/Dockerfile.api`.
- `worker`: background worker built from `docker/Dockerfile.worker`.

The worker has no public port. Browser requests go through Vercel except direct
SSE streaming, which uses the public API domain.

The API is always-on. The worker is safe to leave running only with the explicit
production allowlist in `WORKER_ALLOWED_JOB_KINDS`. Maintenance jobs are not in
that allowlist, and `*_SCHEDULE_SECONDS=0` means no autonomous polling, broad
repair scans, catalog syncs, or prune sweeps. Run maintenance only for a bounded
operator window after Hetzner Postgres and R2 are healthy.

Supabase is only an identity provider in production. Use it for hosted Auth,
JWKS, OAuth providers, and browser anon-key auth flows. Do not configure
production services to read/write Supabase Database or Supabase Storage.

Cloudflare R2 is the production object store. Keep bucket credentials scoped to
the production bucket and rotate them independently from Supabase Auth keys.

## Env Files

Tracked examples live in `deploy/env/*.example`.

Ignored local files to fill with real values:

- `deploy/env/env-prod`: shared production values.
- `deploy/env/env-prod-frontend`: Vercel-only values.
- `deploy/env/env-prod-backend`: FastAPI/Caddy values.
- `deploy/env/env-prod-worker`: worker-only values.

Create them from examples:

```bash
cp deploy/env/env-prod.example deploy/env/env-prod
cp deploy/env/env-prod-frontend.example deploy/env/env-prod-frontend
cp deploy/env/env-prod-backend.example deploy/env/env-prod-backend
cp deploy/env/env-prod-worker.example deploy/env/env-prod-worker
```

Important: `NEXUS_INTERNAL_SECRET` must match between Vercel and the VPS. The
sync scripts fail before uploading if required production env values are empty
or still contain placeholders.

Use Hetzner Postgres for production data. `deploy/hetzner/sync-env.sh`
validates that `DATABASE_URL` points at the private Compose service
`postgres:5432` and matches `POSTGRES_USER`, `POSTGRES_PASSWORD`, and
`POSTGRES_DB`, then the Compose `env_file` supplies that value to API, worker,
and one-off commands.

The backend DB pool is bounded by `DATABASE_POOL_SIZE`,
`DATABASE_MAX_OVERFLOW`, and `DATABASE_POOL_TIMEOUT_SECONDS`. Keep the default
`5/5/30` unless VPS Postgres metrics show sustained saturation.

## Hetzner Provisioning

Install and authenticate the Hetzner CLI:

```bash
brew install hcloud
hcloud context create nexus
```

Provision a cheap US server:

```bash
HCLOUD_SSH_KEY=<hetzner-ssh-key-name> \
HCLOUD_SSH_ALLOWED_IPS="$(curl -fsS4 https://api.ipify.org)/32" \
HCLOUD_LOCATION=hil \
HCLOUD_SERVER_TYPE=cpx11 \
./deploy/hetzner/provision.sh
```

Use the Hetzner location closest to users and Cloudflare R2. Use a larger server
type if Docker builds or media jobs run out of memory.

## DNS

Point the API domain at the Hetzner server IPv4 address with an `A` record.
Caddy will request and renew TLS automatically.

Current Cloudflare record:

```text
Type: A
Name: api.nexus
Value: 5.78.194.235
Proxy: DNS only
```

## Backend Deploy

Upload the merged VPS env:

```bash
./deploy/hetzner/sync-env.sh
```

Deploy API and worker:

```bash
./deploy/hetzner/deploy.sh
```

`deploy.sh` runs `deploy/hetzner/sync-env.sh` first by default, so normal
deploys validate and upload env before rebuilding. Skip that only when the
remote env was already verified for the same deploy:

```bash
NEXUS_SYNC_ENV=0 ./deploy/hetzner/deploy.sh
```

The Hetzner scripts default to the current production IPv4 listed above. Set
`NEXUS_HOST` to target another host, or `NEXUS_SSH_TARGET` to override the full
SSH target. The deploy script syncs the repo to `/opt/nexus-web`, builds Docker
images on the VPS, runs Alembic migrations, and starts the Compose stack.

Deploy may recreate/start the worker. Keep the safe worker env in place during
normal deploys; use `NEXUS_ALLOW_WORKER_MAINTENANCE=1` only for a bounded
maintenance window.

## Frontend Env

Install/link Vercel CLI if needed:

```bash
cd apps/web
vercel link
cd ../..
```

Push production frontend env:

```bash
./deploy/vercel/sync-env.sh
```

The Vercel sync script validates required production keys locally, writes the
configured production env to Vercel, keeps `NEXUS_INTERNAL_SECRET` sensitive,
then pulls the Vercel production env into a temporary file and verifies readable
required keys without printing secret values.

Key Vercel values:

```bash
FASTAPI_BASE_URL=https://api.example.com
R2_S3_API_ORIGIN=https://<cloudflare-account-id>.r2.cloudflarestorage.com
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<supabase-anon-key>
NEXUS_INTERNAL_SECRET=<same value as VPS>
```

`R2_S3_API_ORIGIN` is a public shared origin used by backend signing and
frontend CSP. `NEXT_PUBLIC_SUPABASE_*` is for Auth only. Do not add Supabase
database, storage service-role keys, R2 credentials, or bucket names to Vercel.

Current frontend values should use:

```bash
FASTAPI_BASE_URL=https://api.nexus.nielseriknandal.com
NEXT_PUBLIC_SUPABASE_URL=https://jiaozhsisiphjtomoamy.supabase.co
```

Frontend production deploys are GitHub-triggered. Push `main` to GitHub and let
the Vercel Git integration build and promote the production deployment for
`niels-erik-nandals-projects/nexus-web`.

Use the CLI only for exceptional manual recovery or an explicitly requested
force deploy, not for the normal publish path:

```bash
vercel deploy --prod --scope niels-erik-nandals-projects
```

## Operations

SSH into the VPS:

```bash
ssh nexus@5.78.194.235
cd /opt/nexus-web
```

Check services:

```bash
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml ps
```

Tail logs:

```bash
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml logs -f api
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml logs -f worker
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml logs -f caddy
```

Stop only the worker:

```bash
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml stop worker
```

Recreate the worker after env changes. `docker compose restart` does not reload
`env_file` values:

```bash
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml up -d --no-deps --force-recreate worker
```

Check non-secret worker safety env:

```bash
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml exec worker env | sort | rg 'WORKER_|PODCAST_ACTIVE|INGEST_RECONCILE|GUTENBERG|BACKGROUND_JOB_PRUNE'
```

Health check:

```bash
curl https://api.nexus.nielseriknandal.com/health
```

## Cutover

Before switching production traffic:

1. Provision Hetzner and DNS.
2. Create the production R2 bucket, shared S3 API origin, access keys, and
   browser CORS policy.
   Apply the CORS policy as code with
   `CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... R2_BUCKET=... ./deploy/cloudflare/apply-r2-cors.sh`.
3. Stop or disable old backend writers and workers before starting the Hetzner
   worker.
4. Use a fresh cutover by default: run migrations on empty Hetzner Postgres and
   start with an empty R2 bucket. If preserving old data, export/import it
   offline before traffic moves; do not configure Supabase as a live fallback.
5. Sync VPS env and Vercel env.
6. Deploy backend and run migrations.
7. Confirm `/health`, Supabase Auth login, object upload/download, and a worker
   job against Hetzner Postgres/R2.
8. Switch frontend/API traffic and keep maintenance schedules at `0`.
9. Run the auth smoke check (see Smoke Checks) against the live URLs.

After cutover, treat Supabase Database and Supabase Storage as legacy data
sources only. Do not write new production data to them and do not configure them
as a fallback path.

## Smoke Checks

`deploy/smoke/auth-smoke.sh` is the post-deploy auth gate. Run it after every
frontend/backend release once traffic is live; it exits nonzero on any failed
check. It verifies the production cutover behavior end to end: anonymous
protected pages redirect to `/login` with a preserved `next`, a valid-shaped
expired cookie prompts a redirect with no `MIDDLEWARE_INVOCATION_TIMEOUT`,
public pages return `200`, BFF routes return JSON `401 E_UNAUTHENTICATED`,
`/docs` is not reachable, and the API health endpoint returns `200`.

```bash
NEXUS_SMOKE_APP_URL=https://nexus.nielseriknandal.com \
NEXUS_SMOKE_API_URL=https://api.nexus.nielseriknandal.com \
NEXUS_SMOKE_SUPABASE_URL=https://jiaozhsisiphjtomoamy.supabase.co \
  make smoke
```

The same values can be passed as `--app-url`, `--api-url`, and `--supabase-url`
flags. `--supabase-url` is the deployed `NEXT_PUBLIC_SUPABASE_URL`; its project
ref names the auth cookie the boundary parser reads, so the crafted expired
cookie is one the deployed app interprets. The script makes only safe `GET`
requests and never prints cookie or token values.

Keep legacy Supabase cleanup/export credentials in a separate local file that is
never synced as runtime env. These values feed the one-off Supabase-exit cleanup
scripts only; none of them is a required production runtime variable (`SUPABASE_URL`
in particular is not — FastAPI verifies tokens with `SUPABASE_ISSUER`,
`SUPABASE_JWKS_URL`, and `SUPABASE_AUDIENCES`):

```bash
SUPABASE_DATABASE_URL=<old-supabase-postgres-url>
SUPABASE_URL=<auth-project-url>
SUPABASE_SERVICE_KEY=<legacy-cleanup-only-service-role-key>
STORAGE_BUCKET=media
```

## Rollback

Rollback is revision plus data restore, not provider fallback:

1. Stop `worker`.
2. Restore the last known-good Hetzner Postgres backup or server snapshot.
3. Restore or reconcile the matching R2 object state.
4. Redeploy the previous app revision with the matching env.
5. Force-recreate `api`, confirm health/login/read paths, then recreate
   `worker`.

Do not point production back to Supabase Database or Supabase Storage. If the
legacy data needs to be consulted, export from it offline and import into
Hetzner Postgres/R2.

## Failure Recovery

- Supabase Auth failure: keep Postgres/R2 unchanged, stop worker only if jobs
  are repeatedly failing on auth-dependent work, and wait for Auth/JWKS recovery
  or rotate Supabase Auth keys if compromised.
- Hetzner Postgres failure: stop `worker`, keep `caddy` up, restore from the
  latest verified database backup/snapshot, run migrations for the deployed
  revision, then force-recreate `api` and `worker`.
- R2 failure: stop write-heavy jobs, verify Cloudflare status/credentials, retry
  failed object operations after recovery, and reconcile DB object metadata
  against R2 inventory if writes partially completed.
- Bad deploy/env: redeploy the previous revision with the previous env, recreate
  services, and verify `/health`, auth, DB query, object read/write, and worker
  logs.
- Worker runaway: stop `worker`, restore the safe allowlist/schedules, sync env,
  force-recreate `worker`, and watch DB/R2 metrics before any maintenance
  window.

## Maintenance Windows

Maintenance is opt-in per job kind:

```text
podcast_active_subscription_poll_job -> PODCAST_ACTIVE_POLL_SCHEDULE_SECONDS
reconcile_stale_ingest_media_job -> INGEST_RECONCILE_SCHEDULE_SECONDS
sync_gutenberg_catalog_job -> SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS
prune_background_jobs_job -> BACKGROUND_JOB_PRUNE_SCHEDULE_SECONDS
```

To run a repair window, append only the required maintenance job kind to
`WORKER_ALLOWED_JOB_KINDS`, set only its schedule above `0`, sync env with
`NEXUS_ALLOW_WORKER_MAINTENANCE=1`, force-recreate the worker, and watch
Postgres and R2 metrics. When the window is done, remove the maintenance kind,
restore its schedule to `0`, sync env again without
`NEXUS_ALLOW_WORKER_MAINTENANCE`, and force-recreate the worker again.

## Files To Remember

- `deploy/hetzner/README.md`: detailed VPS deploy instructions.
- `deploy/hetzner/cloud-init.yml`: server bootstrap.
- `deploy/hetzner/provision.sh`: Hetzner server/firewall creation.
- `deploy/hetzner/sync-env.sh`: uploads backend runtime env.
- `deploy/hetzner/deploy.sh`: builds, migrates, and starts services.
- `deploy/vercel/sync-env.sh`: pushes Vercel env.
- `deploy/smoke/auth-smoke.sh`: post-deploy auth smoke check.
- `.dockerignore`: keeps VPS Docker build contexts small.
- `deploy/cloudflare/r2-cors.example.json`: production R2 browser upload CORS policy.
- `deploy/cloudflare/r2-lifecycle.example.json`: production R2 lifecycle policy that expires `uploads/` staging objects.
- `deploy/cloudflare/apply-r2-cors.sh`: applies the R2 browser CORS policy through the Cloudflare API.
- `deploy/cloudflare/apply-r2-lifecycle.sh`: applies the R2 lifecycle policy through the Cloudflare API.
