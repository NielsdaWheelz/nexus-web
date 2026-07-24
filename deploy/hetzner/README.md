# Hetzner VPS Deploy

This deploy path runs only the FastAPI API and Postgres-backed worker on one
Hetzner Cloud server. Vercel keeps serving the Next.js app. Supabase is used for
Auth only; production data lives in Hetzner Postgres and production objects live
in Cloudflare R2.

## Shape

- `caddy`: public HTTPS reverse proxy for `https://api.example.com`
- `postgres`: local Postgres with pgvector on a Docker volume
- `api`: FastAPI from `docker/Dockerfile.api`
- `worker`: background worker from `docker/Dockerfile.worker`
- Secrets live on the server at `/etc/nexus/nexus.env`

## Prerequisites

Install and authenticate the Hetzner CLI:

```bash
brew install hcloud
hcloud context create nexus
```

Create or register an SSH key in Hetzner Cloud, then provision a server:

```bash
HCLOUD_SSH_KEY=<hetzner-ssh-key-name> \
HCLOUD_SSH_ALLOWED_IPS="$(curl -fsS4 https://api.ipify.org)/32" \
HCLOUD_LOCATION=hil \
HCLOUD_SERVER_TYPE=cpx11 \
./deploy/hetzner/provision.sh
```

Defaults are intentionally cheap: `hil` for Hillsboro, Oregon, and `cpx11` for
the smallest US CPX instance. Use a larger `HCLOUD_SERVER_TYPE` if image builds
or media jobs need more memory, and choose the region closest to users and R2.
The provisioned server has Hetzner delete/rebuild protection enabled.

## Server Env

Create local editable env files:

```bash
cp deploy/env/env-prod.example deploy/env/env-prod
cp deploy/env/env-prod-backend.example deploy/env/env-prod-backend
cp deploy/env/env-prod-worker.example deploy/env/env-prod-worker
```

Fill in the real values:

- Supabase Auth issuer, JWKS, and audiences, not Supabase DB or Storage secrets.
- `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` for the VPS Postgres.
- Cloudflare R2 bucket, shared S3 API origin, backend access keys, and browser
  upload CORS policy.
- Backend provider credentials required by startup validation, including
  `YOUTUBE_DATA_API_KEY` and `X_API_BEARER_TOKEN`.

Then upload the merged backend runtime env:

```bash
./deploy/hetzner/sync-env.sh
```

The script merges `env-prod`, `env-prod-backend`, and `env-prod-worker` into
`/etc/nexus/nexus.env` on the VPS. Do not commit the real env files. It defaults
to `5.78.194.235`; set `NEXUS_HOST` to override the host, or
`NEXUS_SSH_TARGET` to override the full SSH target. Set
`NEXUS_REMOTE_ENV_FILE` if the server env file lives somewhere else; deploy and
sync use the same value.

Important matching Vercel env vars:

```bash
FASTAPI_BASE_URL=https://api.example.com
R2_S3_API_ORIGIN=https://<cloudflare-account-id>.r2.cloudflarestorage.com
NEXUS_INTERNAL_SECRET=<same value as /etc/nexus/nexus.env>
```

Also make sure `STREAM_CORS_ORIGINS` includes the deployed Vercel origin.

For the frontend, create and fill the Vercel env file:

```bash
cp deploy/env/env-prod-frontend.example deploy/env/env-prod-frontend
./deploy/vercel/sync-env.sh
```

The Vercel script uses `vercel env rm` and `vercel env add` for the production
environment in `apps/web`; run `vercel link` there first if the project is not
linked. It keeps `NEXUS_INTERNAL_SECRET` sensitive and only leaves public
frontend/runtime values readable for verification.

Frontend production deploys are GitHub-triggered from `main` by the Vercel Git
integration. Do not run a manual `vercel deploy --prod` in the normal publish
path; reserve the CLI deploy command for explicit recovery or force-deploy
operations.

## DNS

Point an `A` record for `api.example.com` at the Hetzner server IPv4 address.
Caddy will request and renew the TLS certificate automatically after DNS is live.

## Deploy

From your local repo:

```bash
./deploy/hetzner/deploy.sh
```

The deploy script syncs the current working tree to `/opt/nexus-web`, builds both
images on the VPS, starts Hetzner Postgres, runs Alembic migrations against that
database, and starts the Compose stack.
By default it also runs `deploy/hetzner/sync-env.sh` first, so production env is
validated and uploaded on every normal deploy. Set `NEXUS_SYNC_ENV=0` only when
the remote env was already verified for the same deploy.
The env sync rejects maintenance worker settings unless
`NEXUS_ALLOW_WORKER_MAINTENANCE=1` is set for a bounded maintenance sync.

`CUTOVER_SHA` is deployment-owned attestation, not a persistent secret.
`deploy.sh` derives it from a clean local `HEAD`, requires a full exact match,
injects it into API/worker through Compose, then verifies API health, worker
environment, and migration head. Do not add it to `/etc/nexus/nexus.env`.

To deploy without uploading env again:

```bash
NEXUS_SYNC_ENV=0 ./deploy/hetzner/deploy.sh
```

### Universal resource-sharing hard cutover

This first schema/edge release is two explicit phases because the maintenance
gate and verified backup must exist before `main` is pushed. Start from the one
clean cutover commit. Use an ordinary probe SSH host whose public egress differs
from `NEXUS_RELEASE_SMOKE_IP`. The deployed typed fixture selects an entitled
viewer and a ready document without an existing creator Link; it never prints
the bearer token:

```bash
export CUTOVER_SHA="$(git rev-parse HEAD)"
export NEXUS_CUTOVER_STATE_FILE="/secure/operator/resource-sharing-${CUTOVER_SHA}.json"
export APP_URL="https://nexus.example.com"
export API_URL="https://api.example.com"
export NEXUS_RELEASE_SMOKE_IP="<release-public-ip>"
export NEXUS_ORDINARY_PROBE_SSH_TARGET="<ordinary-probe-host>"
export NEXUS_SSH_TARGET="<deploy-user>@<backend-host>"
export NEXUS_DEPLOY_PATH="/opt/nexus-web"
export NEXUS_REMOTE_ENV_FILE="/etc/nexus/nexus.env"
export NEXUS_SMOKE_MEDIA_KIND="pdf" # or web_article / epub
export VERCEL_TOKEN="<operator-token>"
export VERCEL_PROJECT_ID="<project-id>"
export VERCEL_TEAM_ID="<team-id>"
export VERCEL_CWD="/absolute/path/to/linked/apps/web"

deploy/hetzner/resource-sharing-cutover.sh --prepare
deploy/hetzner/resource-sharing-cutover.sh --release
```

`--prepare` publishes and reads back the maintenance rule first, proves an
ordinary `/s` request is denied, stops API/worker, creates a custom-format
PostgreSQL dump outside the rsynced deploy tree, validates it with
`pg_restore --file=/dev/null`, records the observed production start contract
at migration `0188` (distinct from the cutover chain's local
`down_revision`),
then publishes/reads back the permanent public-share rate limit. It leaves the
gate closed and writers stopped.

`--release` revalidates the stopped writers, backup bytes/digest, migration
head, and linked Vercel project identity. It records the exact pre-cutover Git
and READY Vercel deployment revisions in the protected state file before it
fast-forward pushes the exact
`CUTOVER_SHA` to `main`, waits for the Git-triggered Vercel production deployment
to report that SHA READY, deploys Hetzner, and requires migration `0192`
(including universal-sharing migration `0191`).
The server-side typed operator fixture proves entitlement, authority, and
projection readiness without a production JWT. The smoke reads it only through
the public BFF, proves bogus Cookie/Authorization/internal-trust inputs do not
change the public response, exercises PDF ranges when selected, then revokes
through the same typed operator and proves the masked public 404. Local
real-stack E2E owns authenticated API+BFF evidence. The release also checks the
token is absent from API/Caddy logs and verifies the permanent WAF. Only then
does it remove/read back the gate, prove ordinary traffic reopened, and repeat
the typed create/read/revoke smoke. A failure after deploy stops the new API and
worker; a failure after the gate may have opened first restores and verifies the
maintenance rule. Either way the state becomes `failed_closed`. While the
maintenance gate remains closed, inspect that state and run:

```bash
deploy/hetzner/resource-sharing-cutover.sh --rollback
```

`--rollback` is deliberately explicit and destructive: it rechecks the backup,
recreates Postgres from that verified dump, deploys an archive of the recorded
pre-cutover Git revision, invokes Vercel rollback for the recorded production
deployment, verifies the old API/worker and `/s` contract, and only then removes
the maintenance gate. Never use it after the cutover has reopened to user
writes; post-open recovery is a gated forward fix.

## Operations

SSH into the server and use:

```bash
cd /opt/nexus-web
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml ps
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml logs -f api
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml logs -f worker
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml logs -f caddy
```

Health check:

```bash
curl https://api.example.com/health
```

### Oracle Corpus

The Oracle reads from a system library of ingested public-domain media. Set
`NEXUS_ORACLE_CORPUS_OWNER_USER_ID=<prod-user-id>` in `/etc/nexus/nexus.env`; deploy runs
migrations in the API image, then runs Oracle seed objects, corpus seed/drain, and readiness
as one-off worker-image commands. The deploy is not complete until readiness passes — it
proves every required media has a ready content index on the active embedding provider/model,
every anchor resolved, and every plate object present:

```bash
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml run -T --rm --no-deps worker \
  /app/.venv/bin/python /app/scripts/ensure_oracle_seed_objects.py
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml run -T --rm --no-deps worker \
  /app/.venv/bin/python /app/scripts/oracle/seed_corpus_library.py --owner-user "$NEXUS_ORACLE_CORPUS_OWNER_USER_ID" --drain
docker compose --env-file /etc/nexus/nexus.env -f deploy/hetzner/docker-compose.yml run -T --rm --no-deps worker \
  /app/.venv/bin/python /app/scripts/oracle/check_corpus_readiness.py
```

These commands are idempotent and safe to re-run; `check_corpus_readiness.py` exits non-zero unless ready.

## Supabase Exit Check

After moving app Postgres and object storage off Supabase, optionally use the
exit check against a separate legacy Supabase env file to verify Supabase is
Auth-only:

```bash
deploy/hetzner/supabase-exit-check.sh --env-file /path/to/legacy-supabase-exit.env
```

The default path is read-only and exits nonzero if legacy Supabase DB/storage
state remains. It reports `auth.users`, remaining `public` schema objects,
public extensions/routines/types, and Supabase Storage buckets/object counts.
Do not put these legacy database or storage service-role values in production
runtime env.

Keep legacy Supabase cleanup/export credentials in a separate local file. Do not
put these keys in `deploy/env/env-prod*`, `/etc/nexus/nexus.env`, Vercel env, or
any file synced by `sync-env.sh`:

```bash
SUPABASE_DATABASE_URL=<old-supabase-postgres-url>
SUPABASE_URL=<auth-project-url>
SUPABASE_SERVICE_KEY=<legacy-cleanup-only-service-role-key>
```

To clean the old app-owned `public` schema and all Storage buckets after a
successful cutover and backup, run the same script with explicit confirmation:

```bash
NEXUS_SUPABASE_EXIT_CONFIRM=clean-public-and-storage \
  deploy/hetzner/supabase-exit-check.sh --env-file /path/to/legacy-supabase-exit.env --clean
```

Cleanup drops and recreates only `public`, then empties/deletes every Supabase
Storage bucket through the Storage API. It does not delete the `auth` schema and
is not a rollback mechanism. After cleanup, the script reruns the same gate and
exits nonzero if any public schema or Storage leftovers remain.

## Cutover And Recovery

Hard cutover means no production fallback to Supabase Database or Supabase
Storage. Before pointing users at this stack, verify:

- Old production writers and workers are stopped before the Hetzner worker starts.
- Fresh cutover: Hetzner Postgres has migrations applied and R2 is empty except
  for objects created by this stack.
- Data-preserving cutover: Hetzner Postgres has the imported production data and
  R2 has the imported production objects, verified offline before traffic moves.
- Supabase Auth callback URLs and Vercel env point at the production app/API.
- The worker allowlist is at the safe default with maintenance schedules at `0`.

If cutover fails before user traffic is switched, fix the migration and rerun the
cutover. If it fails after traffic is switched, stop `worker`, keep `api` and
`caddy` up only if reads/auth still work, restore the last known-good Hetzner
Postgres backup and R2 object state, redeploy the matching app revision, then
force-recreate `api` and `worker`. Do not repoint production to Supabase DB or
Supabase Storage.

Use `deploy/cloudflare/r2-cors.example.json` as the production R2 bucket CORS
shape. The app needs browser `PUT` for presigned uploads and backend `GET`/`HEAD`
through the S3 API.

Apply `deploy/cloudflare/r2-lifecycle.example.json` to the production R2 bucket.
Direct browser uploads are staged under the `uploads/` prefix so lifecycle
deletes abandoned or replayed staging objects without touching canonical media
objects. The helper script is:

```bash
CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_API_TOKEN=<r2-edit-token> \
R2_BUCKET=<bucket-name> \
./deploy/cloudflare/apply-r2-lifecycle.sh
```
