# Deployment Notes

Nexus production is intended to run with:

- Vercel for the Next.js frontend/BFF.
- Supabase for Postgres, Auth, and Storage.
- One Hetzner Cloud VPS for the FastAPI API and Postgres-backed worker.
- Caddy on the VPS for HTTPS at the API domain.

The goal is to avoid Render free-tier cold starts while keeping the operational
surface small.

## Runtime Shape

On the Hetzner VPS:

- `caddy`: public HTTPS reverse proxy.
- `api`: FastAPI service built from `docker/Dockerfile.api`.
- `worker`: background worker built from `docker/Dockerfile.worker`.

The worker has no public port. Browser requests go through Vercel except direct
SSE streaming, which uses the public API domain.

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

Important: `NEXUS_INTERNAL_SECRET` must match between Vercel and the VPS.

## Hetzner Provisioning

Install and authenticate the Hetzner CLI:

```bash
brew install hcloud
hcloud context create nexus
```

Provision a cheap US server:

```bash
HCLOUD_SSH_KEY=<hetzner-ssh-key-name> \
HCLOUD_LOCATION=hil \
HCLOUD_SERVER_TYPE=cpx11 \
./deploy/hetzner/provision.sh
```

Use `HCLOUD_LOCATION=ash` if Supabase is closer to US East. Use a larger server
type if Docker builds or media jobs run out of memory.

## DNS

Point the API domain, for example `api.example.com`, at the Hetzner server IPv4
address with an `A` record. Caddy will request and renew TLS automatically.

## Backend Deploy

Upload the merged VPS env:

```bash
NEXUS_HOST=<server-ip-or-api-domain> ./deploy/hetzner/sync-env.sh
```

Deploy API and worker:

```bash
NEXUS_HOST=<server-ip-or-api-domain> ./deploy/hetzner/deploy.sh
```

Upload env and deploy in one command:

```bash
NEXUS_HOST=<server-ip-or-api-domain> NEXUS_SYNC_ENV=1 ./deploy/hetzner/deploy.sh
```

The deploy script syncs the repo to `/opt/nexus-web`, builds Docker images on
the VPS, runs Alembic migrations, and starts the Compose stack.

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

Key Vercel values:

```bash
FASTAPI_BASE_URL=https://api.example.com
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<supabase-anon-key>
NEXUS_INTERNAL_SECRET=<same value as VPS>
```

## Operations

SSH into the VPS:

```bash
ssh nexus@<server-ip-or-api-domain>
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

Health check:

```bash
curl https://api.example.com/health
```

## Files To Remember

- `deploy/hetzner/README.md`: detailed VPS deploy instructions.
- `deploy/hetzner/cloud-init.yml`: server bootstrap.
- `deploy/hetzner/provision.sh`: Hetzner server/firewall creation.
- `deploy/hetzner/sync-env.sh`: uploads backend runtime env.
- `deploy/hetzner/deploy.sh`: builds, migrates, and starts services.
- `deploy/vercel/sync-env.sh`: pushes Vercel env.
- `.dockerignore`: keeps VPS Docker build contexts small.
