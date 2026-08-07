# Production environment contract

Operational order and recovery live only in [`deployment.md`](../../deployment.md).
This document owns the production variable boundaries.

## Inputs

Copy the tracked contracts to the ignored files beside them:

```bash
cp deploy/env/env-prod.example deploy/env/env-prod
cp deploy/env/env-prod-frontend.example deploy/env/env-prod-frontend
cp deploy/env/env-prod-backend.example deploy/env/env-prod-backend
cp deploy/env/env-prod-worker.example deploy/env/env-prod-worker
```

| File | Owner |
|---|---|
| `env-prod` | Values genuinely shared by web and VPS |
| `env-prod-frontend` | Vercel/Next.js only |
| `env-prod-backend` | API, Caddy, Postgres, R2 credentials, provider secrets |
| `env-prod-worker` | Worker timing and schedule values only |

The three VPS inputs must partition their keys: a key may occur in exactly one
file. Blank, placeholder, malformed, forbidden, and duplicate values fail before
publication. Compose, not env files, owns worker lane/kind selection and the
candidate API/worker image digests.

`POSTGRES_IMAGE` and `CADDY_IMAGE` are exact digest references to the established
production images. Changing either is an infrastructure operation, not an
application release. API and worker digests come only from the CI candidate
manifest.

## Publication

For a never-published source SHA, the VPS publisher validates and canonicalizes
the three VPS inputs, writes `/etc/nexus/config/<sha256>.env`, then atomically
moves `/etc/nexus/current.env`:

```bash
./deploy/hetzner/sync-env.sh <never-published-source-sha>
```

This is prepare-only. It does not restart a service. The application release
captures the exact path and digest in its attempt and immutable release record.
The command runs the host Python owner transferred from the exact clean
`origin/main` checkout, so first publication does not require or install a
current application bundle.

Vercel config is a separate provider snapshot:

```bash
./deploy/vercel/sync-env.sh
```

For a config-bearing release, publish Vercel config before the SHA triggers its
staged build; publish VPS config after that SHA is exact `origin/main` and before
application release. Keep the sequence serialized. A code-only release may reuse
current config. Any config change requires a new source SHA; one SHA may become
current only once.

## Boundary rules

- Supabase owns authentication only: issuer, JWKS, audiences, frontend URL, and
  frontend anonymous key. Product data never uses Supabase Database or Storage.
- Hetzner Postgres is the only product database. `DATABASE_URL` uses
  `postgresql+psycopg`, host `postgres`, port `5432`, and credentials equal to
  the Compose Postgres values.
- Cloudflare R2 is the only object store. `R2_S3_API_ORIGIN` is the shared public
  S3 origin; access key, secret, and bucket are VPS-only.
- `NEXUS_INTERNAL_SECRET` is identical in Vercel and VPS config.
- Browser auth/extension redirect origins and Server Action admission patterns
  are frontend-only. Direct Vercel custom-domain hosting leaves
  `SERVER_ACTION_ALLOWED_ORIGINS` empty.
- `SUPABASE_MANAGEMENT_ACCESS_TOKEN` is operator-only. It is never application
  config.
- `SUPABASE_AUTH_ADMIN_KEY` is local test-control bootstrap state. It is never
  production config.
- `X_API_BEARER_TOKEN`, platform LLM keys, stream signing material, R2
  credentials, database credentials, and billing credentials are VPS-only.
- Real env files, temporary merged files, provider tokens, and canonical
  published config contain secrets. Never commit, print, or copy them into
  release state.

## Worker contract

Production has exactly `interactive` and `background` workers. Their normal env
contains no `WORKER_LANE`, raw job-kind allowlist, or maintenance authorization.
Compose assigns lanes; the registry assigns kinds.

The background lane owns ordinary periodic work. Maintenance kinds run only in
a bounded explicitly authorized one-off process; there is no deployed
maintenance worker.

## Provider checks

Before a config-bearing release, prove:

- `deploy/supabase/verify-auth-config.sh` accepts hosted Auth settings;
- Supabase's dashboard-only current-password requirement is disabled;
- R2 bucket policy, browser upload CORS, lifecycle, and scoped credentials are
  current;
- paid provider accounts have the capacity implied by enabled feature flags;
- Vercel and VPS hold the same internal secret without displaying it.
