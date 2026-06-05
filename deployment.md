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
- `deploy/env/env-prod-backend`: FastAPI/Caddy values and backend-only provider
  secrets, including `X_API_BEARER_TOKEN`.
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

X/Twitter thread ingestion uses the official X API from the backend only.
`X_API_BEARER_TOKEN`, `X_API_TIMEOUT_SECONDS`, and
`X_API_AUTHOR_THREAD_MAX_POSTS` are VPS runtime settings, not Vercel settings.
Provider credits are not env; if X capture fails with
`E_X_PROVIDER_CREDITS_DEPLETED`, add credits in the X developer account and then
run a direct provider probe or the gated live-provider test with
`X_LIVE_TEST_POST_URL` and `X_LIVE_TEST_EXPECTED_TEXT`.

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
APP_PUBLIC_URL=https://nexus.nielseriknandal.com
FASTAPI_BASE_URL=https://api.example.com
R2_S3_API_ORIGIN=https://<cloudflare-account-id>.r2.cloudflarestorage.com
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<supabase-anon-key>
AUTH_ALLOWED_REDIRECT_ORIGINS=https://nexus.nielseriknandal.com
AUTH_TRUSTED_PROXY_ORIGINS=
SERVER_ACTION_ALLOWED_ORIGINS=
NEXUS_EXTENSION_REDIRECT_ORIGINS=
NEXUS_INTERNAL_SECRET=<same value as VPS>
```

`R2_S3_API_ORIGIN` is a public shared origin used by backend signing and
frontend CSP. `NEXT_PUBLIC_SUPABASE_*` is for Auth only. Do not add Supabase
database, storage service-role keys, `SUPABASE_AUTH_ADMIN_KEY`, R2 credentials,
or bucket names to Vercel. `SUPABASE_AUTH_ADMIN_KEY` is local E2E bootstrap-only.
`AUTH_ALLOWED_REDIRECT_ORIGINS` is a full URL origin allowlist for app-generated
Supabase redirect URLs. `AUTH_TRUSTED_PROXY_ORIGINS` is only for trusted
host-rewriting proxy hops. `SERVER_ACTION_ALLOWED_ORIGINS` is a Next.js domain
pattern list for host-rewriting frontend proxies; leave it empty for direct
Vercel custom-domain deploys. `NEXUS_EXTENSION_REDIRECT_ORIGINS` is the separate
browser-extension callback origin allowlist.

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

Check recent X provider failures by request ID after an ingest failure:

```bash
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml exec postgres \
  sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "select created_at, request_id, status, api_error_code, provider_status_code, provider_error_title from external_provider_events where provider = '\''x'\'' order by created_at desc limit 20"'
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
7. Verify Supabase hosted Auth redirect config:
   `SUPABASE_MANAGEMENT_ACCESS_TOKEN=... ./deploy/supabase/verify-auth-redirects.sh`.
8. Confirm `/health`, Supabase Auth login, object upload/download, and a worker
   job against Hetzner Postgres/R2.
9. Switch frontend/API traffic and keep maintenance schedules at `0`.
10. Run the auth smoke checks (see Smoke Checks) against the live URLs.

After cutover, treat Supabase Database and Supabase Storage as legacy data
sources only. Do not write new production data to them and do not configure them
as a fallback path.

## Smoke Checks

`deploy/smoke/auth-smoke.sh` is the post-deploy auth gate. Run it after every
frontend/backend release once traffic is live; it exits nonzero on any failed
check. It verifies the production cutover behavior end to end: anonymous
default protected pages redirect to `/login` without redundant `next`,
anonymous non-default protected pages preserve `next`, a valid-shaped expired
cookie prompts a redirect with no `MIDDLEWARE_INVOCATION_TIMEOUT`, public pages
return `200`, BFF routes return JSON `401 E_UNAUTHENTICATED`, `/docs` is not
reachable, and the API health endpoint returns `200`.

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

Durable source ingest has a separate production check because the important
contract lives in Postgres, worker logs, and provider events. After a backend or
worker deploy, SSH to the host and run read-only checks from `/opt/nexus-web`:

```bash
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml ps
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml logs worker \
  | grep -E "ingest_media_source|source_attempt|x_provider|provider_event" \
  | tail -100
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml exec -T postgres \
  sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT status, source_type, COUNT(*)
FROM media_source_attempts
WHERE created_at > now() - interval '24 hours'
GROUP BY status, source_type
ORDER BY source_type, status;
SQL
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml exec -T postgres \
  sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT kind, status, COUNT(*)
FROM background_jobs
WHERE kind = 'ingest_media_source'
  AND created_at > now() - interval '24 hours'
GROUP BY kind, status
ORDER BY status;
SQL
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml exec -T postgres \
  sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT provider, capability, status, api_error_code, COUNT(*)
FROM external_provider_events
WHERE created_at > now() - interval '24 hours'
GROUP BY provider, capability, status, api_error_code
ORDER BY provider, capability, status, api_error_code;
SQL
```

These checks prove the deployed worker is using the single
`ingest_media_source` job kind, source attempts are durable and queryable, and X
provider failures are recorded in the provider ledger. Mutating production
canaries for forced X failures or forced remote-file failures are allowed only
with an isolated canary account, dedicated canary library, known disposable
URLs, and available X API credits. When those prerequisites are absent, record
the read-only evidence above and do not fake the canary with lab-only fixtures.

Redirect construction has a separate explicit smoke entrypoint. Production
defaults to read-only verification: it checks hosted Supabase Auth redirect
configuration, verifies the smoke URLs match the same env files, then runs the
safe auth HTTP smoke above. Auth redirect/provider releases must run this lane,
not only `make smoke`. Mutating canary modes require dedicated smoke accounts
and mailbox automation before they can be enabled.

```bash
SUPABASE_MANAGEMENT_ACCESS_TOKEN=<operator-token> \
NEXUS_SMOKE_APP_URL=https://nexus.nielseriknandal.com \
NEXUS_SMOKE_API_URL=https://api.nexus.nielseriknandal.com \
NEXUS_SMOKE_SUPABASE_URL=https://jiaozhsisiphjtomoamy.supabase.co \
  make smoke-auth-redirects
```

Staging can run the mutating redirect-construction proof against a controlled
mailbox domain:

```bash
SUPABASE_MANAGEMENT_ACCESS_TOKEN=<operator-token> \
NEXUS_SMOKE_APP_URL=https://staging.example.com \
NEXUS_SMOKE_API_URL=https://api-staging.example.com \
NEXUS_SMOKE_SUPABASE_URL=https://<staging-ref>.supabase.co \
NEXUS_SMOKE_MAILBOX_URL=https://mailbox.example.com \
NEXUS_SMOKE_EMAIL_DOMAIN=smoke.example.com \
  ./deploy/smoke/auth-redirect-construction-smoke.sh --mode staging \
  --env-file deploy/env/env-staging \
  --frontend-env-file deploy/env/env-staging-frontend
```

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
- `deploy/supabase/verify-auth-redirects.sh`: read-only hosted Auth redirect allowlist verifier.
- `deploy/smoke/auth-smoke.sh`: post-deploy auth smoke check.
- `deploy/smoke/auth-redirect-construction-smoke.sh`: explicit redirect-construction smoke wrapper (`make smoke-auth-redirects`).
- `.dockerignore`: keeps VPS Docker build contexts small.
- `deploy/cloudflare/r2-cors.example.json`: production R2 browser upload CORS policy.
- `deploy/cloudflare/r2-lifecycle.example.json`: production R2 lifecycle policy that expires `uploads/` staging objects.
- `deploy/cloudflare/apply-r2-cors.sh`: applies the R2 browser CORS policy through the Cloudflare API.
- `deploy/cloudflare/apply-r2-lifecycle.sh`: applies the R2 lifecycle policy through the Cloudflare API.
