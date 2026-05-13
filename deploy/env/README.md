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
