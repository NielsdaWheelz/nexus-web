# Hetzner VPS Deploy

This deploy path runs only the FastAPI API and Postgres-backed worker on one
Hetzner Cloud server. Vercel keeps serving the Next.js app, and Supabase keeps
Postgres, Auth, and Storage.

## Shape

- `caddy`: public HTTPS reverse proxy for `https://api.example.com`
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
HCLOUD_LOCATION=hil \
HCLOUD_SERVER_TYPE=cpx11 \
./deploy/hetzner/provision.sh
```

Defaults are intentionally cheap: `hil` for Hillsboro, Oregon, and `cpx11` for
the smallest US CPX instance. Use `HCLOUD_LOCATION=ash` if your Supabase project
is closer to US East. Use a larger `HCLOUD_SERVER_TYPE` if image builds or media
jobs need more memory.

## Server Env

Create local editable env files:

```bash
cp deploy/env/env-prod.example deploy/env/env-prod
cp deploy/env/env-prod-backend.example deploy/env/env-prod-backend
cp deploy/env/env-prod-worker.example deploy/env/env-prod-worker
```

Fill in the real values, then upload the merged backend runtime env:

```bash
NEXUS_HOST=<server-ip-or-api-domain> ./deploy/hetzner/sync-env.sh
```

The script merges `env-prod`, `env-prod-backend`, and `env-prod-worker` into
`/etc/nexus/nexus.env` on the VPS. Do not commit the real env files.

Important matching Vercel env vars:

```bash
FASTAPI_BASE_URL=https://api.example.com
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
linked.

## DNS

Point an `A` record for `api.example.com` at the Hetzner server IPv4 address.
Caddy will request and renew the TLS certificate automatically after DNS is live.

## Deploy

From your local repo:

```bash
NEXUS_HOST=<server-ip-or-api-domain> ./deploy/hetzner/deploy.sh
```

The deploy script syncs the current working tree to `/opt/nexus-web`, builds both
images on the VPS, runs Alembic migrations, and starts the Compose stack.
If Supabase reports Disk I/O exhaustion, follow the main
[Supabase Disk I/O runbook](../../deployment.md#supabase-disk-io-runbook);
deploy may recreate/start the worker.
The env sync rejects maintenance worker settings unless
`NEXUS_ALLOW_WORKER_MAINTENANCE=1` is set for a bounded maintenance sync.

To upload env and deploy in one command:

```bash
NEXUS_HOST=<server-ip-or-api-domain> NEXUS_SYNC_ENV=1 ./deploy/hetzner/deploy.sh
```

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
