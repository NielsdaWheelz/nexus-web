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
Vercel's production environment, removes forbidden backend/runtime keys that may
still exist in Vercel, and verifies the required frontend keys after pulling the
remote env back down.

Production is a hard cutover:

- Supabase is Auth only: URL, issuer, JWKS, audiences, and frontend anon key.
- Hetzner Postgres is the only production database.
- Cloudflare R2 is the only production object store.
- Do not keep Supabase Database or Supabase Storage fallback secrets in prod env.
- Keep `SUPABASE_DATABASE_URL` and Supabase service-role cleanup keys in a
  separate one-off legacy file only.

Worker production defaults are intentionally conservative: the allowlist contains
only explicit user/domain job kinds, schedule values use `0` as disabled, and
maintenance jobs require a temporary allowlist edit for the specific job kind
being run. `deploy/hetzner/sync-env.sh` rejects maintenance allowlists or
positive maintenance schedules unless `NEXUS_ALLOW_WORKER_MAINTENANCE=1` is set
for that bounded sync.

Cutover checks before syncing env:

- `POSTGRES_PASSWORD` is set and backed up in the password manager.
- R2 bucket, access key, endpoint, and browser upload CORS policy are created.
- Supabase Auth callback URLs point only at the production app origins.
- `NEXUS_INTERNAL_SECRET` matches between Vercel and the VPS.
- Old backend writers and workers are stopped before the Hetzner worker starts.

Rollback means restoring the last known-good Hetzner Postgres backup/snapshot and
R2 object state, then redeploying the previous app revision with matching env.
There is no supported rollback path that points production back to Supabase
Database or Supabase Storage.
