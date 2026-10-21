# release: python auth re-slice

status: open until the release that carries `cleanup/python-auth-reslice` ships.
area: auth (web and api; `docs/modules/auth.md`).

web and api ship in the same release, in either order. no migration, no wire
bump, no apk, no extension build.

## before promoting

1. **blocking.** the web now refuses a bearer whose `iss` is not
   `SUPABASE_ISSUER` or whose `aud` is not in `SUPABASE_AUDIENCES`, as the api
   always has. a missing value fails `next build`; a wrong one refuses every
   session (every page opens on "nexus couldn't open", and every navigation
   spends a refresh). the pair lives once, in `deploy/env/env-prod`, and the api
   already proves it against production tokens: it refuses any other `iss` or
   `aud`, and production serves signed-in users. so check that both runtimes
   carry the file's pair:
   - vercel: run `deploy/vercel/sync-env.sh`; it pushes the pair and fails unless
     vercel production reads it back unchanged.
   - VPS: `/etc/nexus/current.env` (what the release reads) carries the same
     `SUPABASE_ISSUER` and `SUPABASE_AUDIENCES`.
   to see a token's own claims, decode an existing session's access token (the
   `sb-<ref>-auth-token` cookie in the browser's devtools). do not sign in from a
   shell for it: that puts the password on a command line and mints a production
   session. a refusal after release is diagnosable from the vercel log in one
   look: each one logs `auth_verify_claim_refused iss|aud|sub`.
2. provider settings (supabase dashboard, read-only; step 2 of the retired
   `auth-reauthor-release-steps.md`, whose observed value nothing in the tree
   records):
   - access-token expiry (`jwt_expiry`) > 120 s (default 3600): the web renews a
     session within 120 s of expiry, so a shorter one renews on every navigation.
   - the current signing key is asymmetric (ECC or RSA): with a symmetric key the
     api refuses every bearer and `getClaims` asks the provider on every
     navigation. production's signed-in traffic already proves the api half.
3. census C2 on production, read-only (expected: 0, and no rows):
   `SELECT count(*) FROM users WHERE email <> lower(btrim(email));` and
   `SELECT lower(email), count(*) FROM users WHERE email IS NOT NULL GROUP BY 1 HAVING count(*) > 1;`.
   first sight now releases an address held by another row by exact match on
   the token's lowercased email; a non-canonical or case-twin mirror escapes that
   release until its own account's next sight rewrites it. not blocking: name
   any such rows in the release record.
4. if production configures the Post Room (`production-post-room-unconfigured.md`
   says it did not at `1c07b5ae`): `EMAIL_INGEST_OWNER_USER_ID` on the VPS is the
   owner's `users.id` (`SELECT id, email FROM users WHERE id = '<value>'`).
   `GET /me` now shows the address to that account only.

## after promoting

5. acceptance: production sign-in by password, google and github on the web;
   one android handoff; one extension connect; vercel logs show no
   `auth_verify_claim_refused`; the release record names the observed issuer.

## standing owner rule

6. rotate the supabase signing keys only after the new key has been published
   as standby for over an hour: the api caches the key set for an hour, and an
   unknown kid refetches it at most every 30 s and is otherwise 401, which ends
   the session at the bff.

## env lines that went (nothing breaks if they stay)

workers no longer read `SUPABASE_JWKS_URL`, `SUPABASE_ISSUER` or
`SUPABASE_AUDIENCES`; only the api does. removed in the tree:
`docker/docker-compose.worker.yml` (the three), `WORKER_SUPABASE_JWKS_URL` in
`Makefile` (`make dev`), `.env.example` and `python/scripts/disposable_runtime.py`.
the VPS keeps the triple: `deploy/env/env-prod` is the one config file api,
workers and migration share (`deploy/hetzner/docker-compose.yml` `env_file`),
and workers ignore it. a stale local `.dev-ports` carrying
`WORKER_SUPABASE_JWKS_URL` is ignored. vercel's `SUPABASE_JWKS_URL` stays
required by `deploy/vercel/sync-env.sh` and unread by the web.

resolved when steps 1-5 are recorded for the release that carries the slice.
