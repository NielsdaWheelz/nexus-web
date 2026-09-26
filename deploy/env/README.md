# Production environment contract

Operational order and recovery live only in [`deployment.md`](../../deployment.md).
This document owns the production variable boundaries.

## Inputs

Create the ignored files owner-only beside the tracked contracts:

```bash
install -m 600 deploy/env/env-prod.example deploy/env/env-prod
install -m 600 deploy/env/env-prod-frontend.example deploy/env/env-prod-frontend
install -m 600 deploy/env/env-prod-backend.example deploy/env/env-prod-backend
install -m 600 deploy/env/env-prod-worker.example deploy/env/env-prod-worker
install -m 600 deploy/env/env-prod-backup.example deploy/env/env-prod-backup
```

| File | Owner |
|---|---|
| `env-prod` | Values genuinely shared by web and VPS |
| `env-prod-frontend` | Vercel/Next.js only |
| `env-prod-backend` | API, Caddy, Postgres, R2 credentials, provider secrets |
| `env-prod-worker` | Worker parser path, timing, and schedule values only |
| `env-prod-backup` | operator-only private database backup bucket and credentials |

The three VPS inputs must partition their keys: a key may occur in exactly one
file. Blank, placeholder, malformed, forbidden, and duplicate values fail before
publication. Compose, not env files, owns worker lane/kind selection and the
candidate API/worker image digests.

`POSTGRES_IMAGE` and `CADDY_IMAGE` are exact digest references to the established
production images. Changing either is an infrastructure operation, not an
application release. API and worker digests come only from the CI candidate
manifest.

`env-prod-backup` contains exactly `R2_BACKUP_S3_API_ORIGIN`,
`R2_BACKUP_BUCKET`, `R2_BACKUP_ACCESS_KEY_ID`, and
`R2_BACKUP_SECRET_ACCESS_KEY`. use a separate private bucket and credentials
scoped to object read/write access in that bucket. these values never enter
the three application inputs, vercel settings, api, or workers. the bounded
backup container receives them only during backup operations.
the access key id is 32 lowercase hexadecimal characters; its secret is 64.
copy the s3 secret access key, not the separate cloudflare api token value.

## Publication

```bash
./deploy/hetzner/sync-env.sh
```

One command publishes both host inputs. It concatenates the three VPS files
into the application config, validates shape, required keys, digest-pinned
`POSTGRES_IMAGE`/`CADDY_IMAGE` and a Compose-local `DATABASE_URL`, then writes
`/etc/nexus/config/<sha256>.env` and repoints `/etc/nexus/current.env` with an
atomic rename. It publishes `env-prod-backup` the same way to
`/etc/nexus/backup-config/<sha256>.env` and `/etc/nexus/backup.env`, and refuses
any `R2_BACKUP_*` key found in the application config.

Publication is prepare-only: nothing restarts, and the next release picks up
whatever the pointers name. It is never invoked implicitly by a release, and it
is not tied to a source SHA — content addressing, not release state, is what
makes a published config identifiable. Keep a superseded config file in place
until you are sure no rollback wants it.

Vercel config is a separate provider snapshot:

```bash
./deploy/vercel/sync-env.sh
```

For a config-bearing release, publish Vercel config before the SHA triggers its
staged build, and VPS config before the release. Keep the sequence serialized.

Neither publisher is a release entrypoint. The sole application release command
is `deploy/hetzner/deploy.sh <source-sha>`.

## Boundary rules

- Supabase owns authentication only: issuer, JWKS, audiences, frontend URL, and
  frontend anonymous key. Product data never uses Supabase Database or Storage.
- Hetzner Postgres is the only product database. `DATABASE_URL` uses
  `postgresql+psycopg`, host `postgres`, port `5432`, and credentials equal to
  the Compose Postgres values.
- Cloudflare R2 is the only object store. `R2_S3_API_ORIGIN` is the shared public
  S3 origin; access key, secret, and bucket are VPS-only.
- `R2_BACKUP_*` is operator-only; application storage credentials cannot read
  or write the private database backup bucket.
- `NEXUS_INTERNAL_SECRET` is identical in Vercel and VPS config.
- Browser auth/extension redirect origins and Server Action admission patterns
  are frontend-only. Direct Vercel custom-domain hosting leaves
  `SERVER_ACTION_ALLOWED_ORIGINS` empty.
- `SUPABASE_MANAGEMENT_ACCESS_TOKEN` is operator-only. It is never application
  config.
- `SUPABASE_AUTH_ADMIN_KEY` is local development bootstrap state. It is never
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

`PARSER_TEMP_ROOT` is exactly `/var/lib/nexus/parser-tmp`. Production Compose
binds that host directory only into the background worker; it is not a tunable
capacity control.

The background lane owns ordinary periodic work. Maintenance kinds run only in
a bounded explicitly authorized one-off process; there is no deployed
maintenance worker.

## Provider checks

Before a config-bearing release, prove:

- hosted Supabase Auth settings are current: refresh-token rotation on, a
  ten-second reuse interval, and the dashboard-only current-password
  requirement disabled (the release no longer checks this);
- R2 bucket policy, browser upload CORS, lifecycle, and scoped credentials are
  current;
- the backup bucket has neither an enabled `r2.dev` endpoint nor a public custom
  domain, and its dedicated credentials can read and write objects;
- paid provider accounts have the capacity implied by enabled feature flags;
- Vercel and VPS hold the same internal secret without displaying it.
