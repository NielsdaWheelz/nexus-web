# Production Env Files

The tracked `*.example` files define the env contract. The untracked files next
to them hold real values:

- `env-prod`: shared values used by frontend and backend/runtime
- `env-prod-frontend`: Vercel-only values
- `env-prod-backend`: FastAPI/Caddy values
- `env-prod-worker`: worker-only values

Create the editable local files:

```bash
cp deploy/env/env-prod.example deploy/env/env-prod
cp deploy/env/env-prod-frontend.example deploy/env/env-prod-frontend
cp deploy/env/env-prod-backend.example deploy/env/env-prod-backend
cp deploy/env/env-prod-worker.example deploy/env/env-prod-worker
```

`deploy/hetzner/sync-env.sh` uploads and merges `env-prod`,
`env-prod-backend`, and `env-prod-worker` into `/etc/nexus/nexus.env` on the
VPS. `deploy/vercel/sync-env.sh` merges `env-prod` and `env-prod-frontend` into
Vercel's production environment.

Worker production defaults are intentionally conservative for Supabase free/Nano:
the allowlist contains only explicit user/domain job kinds, schedule values use
`0` as disabled, and maintenance jobs require a temporary allowlist edit for the
specific job kind being run. `deploy/hetzner/sync-env.sh` rejects maintenance
allowlists or positive maintenance schedules unless
`NEXUS_ALLOW_WORKER_MAINTENANCE=1` is set for that bounded sync.
