# Deployment Notes

Nexus production is intended to run with:

- Vercel for the Next.js frontend/BFF.
- Supabase for Postgres, Auth, and Storage.
- One Hetzner Cloud VPS for the FastAPI API and Postgres-backed worker.
- Caddy on the VPS for HTTPS at the API domain.

The goal is to keep the operational surface small while avoiding background
workers or APIs running in more than one production location.

## Current Production

- Frontend: `https://nexus.nielseriknandal.com`
- API: `https://api.nexus.nielseriknandal.com`
- Hetzner server: `nexus-api-worker`
- Hetzner IPv4: `5.78.194.235`
- Hetzner location/type: `hil` / `cpx11`
- Vercel project: `niels-erik-nandals-projects/nexus-web`
- Supabase project URL: `https://jiaozhsisiphjtomoamy.supabase.co`

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

Important: `NEXUS_INTERNAL_SECRET` must match between Vercel and the VPS. The
sync scripts fail before uploading if required production env values are empty
or still contain placeholders.

Use Supabase's transaction-pooler `DATABASE_URL` on port `6543` for the VPS
runtime. The session pooler on port `5432` is too easy to exhaust on the current
free-tier Supabase project.

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
NEXUS_HOST=5.78.194.235 ./deploy/hetzner/sync-env.sh
```

Deploy API and worker:

```bash
NEXUS_HOST=5.78.194.235 ./deploy/hetzner/deploy.sh
```

Upload env and deploy in one command:

```bash
NEXUS_HOST=5.78.194.235 NEXUS_SYNC_ENV=1 ./deploy/hetzner/deploy.sh
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

The Vercel sync script validates required production keys locally, writes the
configured production env to Vercel as CLI-readable values, then pulls the
Vercel production env into a temporary file and verifies required keys without
printing secret values.

Key Vercel values:

```bash
FASTAPI_BASE_URL=https://api.example.com
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<supabase-anon-key>
NEXUS_INTERNAL_SECRET=<same value as VPS>
```

Current frontend values should use:

```bash
FASTAPI_BASE_URL=https://api.nexus.nielseriknandal.com
NEXT_PUBLIC_SUPABASE_URL=https://jiaozhsisiphjtomoamy.supabase.co
```

After syncing Vercel env, deploy production from the repo root:

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

Health check:

```bash
curl https://api.nexus.nielseriknandal.com/health
```

## Files To Remember

- `deploy/hetzner/README.md`: detailed VPS deploy instructions.
- `deploy/hetzner/cloud-init.yml`: server bootstrap.
- `deploy/hetzner/provision.sh`: Hetzner server/firewall creation.
- `deploy/hetzner/sync-env.sh`: uploads backend runtime env.
- `deploy/hetzner/deploy.sh`: builds, migrates, and starts services.
- `deploy/vercel/sync-env.sh`: pushes Vercel env.
- `.dockerignore`: keeps VPS Docker build contexts small.
