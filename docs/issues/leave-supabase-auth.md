# leave supabase auth

status: open; out of the reauthoring campaign (owner, 2026-10-13: "exit NOT in
this campaign. write a scoped plan").
area: auth, local development, deploy.

auth runs on supabase. production uses a hosted supabase project
(`<project-ref>.supabase.co`); development runs the supabase cli's local stack.
supabase holds every account's credentials and oauth identities, issues and
refreshes the sessions, and sends the auth email. nexus holds only the user id
(the token's `sub`) and a mirrored email.

## dependencies

web (the boundary #558 drew: nothing outside `lib/supabase` imports `@supabase/*`):

- `apps/web/package.json:20-21`: `@supabase/ssr`, `@supabase/supabase-js`.
- `apps/web/src/lib/supabase/auth.ts`: the sdk client and every operation:
  claims check, refresh, password sign-in, recovery, password update, email-link
  confirm, email change, oauth start and code exchange, google id-token sign-in
  (android), revoke (`/auth/v1/logout`), identity list and unlink.
- `apps/web/src/lib/supabase/cookie.ts:30-35`: the session cookie is supabase's
  `sb-<ref>-auth-token`, read network-free by `src/middleware.ts`,
  `lib/auth/session.ts`, `lib/api/server.ts` and `app/share/page.tsx`.
- callers: `app/auth/{callback,confirm/[purpose],handoff,native/google,oauth,password/{recovery,sign-in,update},session/resolve,signout}/route.ts`,
  `app/(authenticated)/settings/{account,identities}/`, `lib/api/proxy.ts`,
  `app/extension/connect/start/route.ts`.
- `apps/web/src/lib/env.ts:128-137`: `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` are required.
- `apps/web/src/app/privacy/page.tsx:44`: the policy names supabase auth as the
  password-hash holder.

python:

- `python/nexus/auth/verifier.py`: `SupabaseJwksVerifier` checks every bearer
  against the project's jwks, issuer and audiences; `app.py:97-119` wires it.
- `python/nexus/config.py:51-53,147-166`: `SUPABASE_JWKS_URL`,
  `SUPABASE_ISSUER`, `SUPABASE_AUDIENCES` are required.
- `python/nexus/auth/middleware.py:161`: the user id is the token's `sub`;
  `db/models.py:139` says `users.id` is the supabase user id.
- `python/nexus/services/auth_handoff_codes.py`: the android handoff carries a
  supabase access and refresh token into the webview.

the firefox extension does not depend on it: its tokens are nexus extension
sessions (`python/nexus/auth/extension.py`). android code has no supabase
reference; it reaches supabase only through the web routes above.

development:

- `supabase/config.toml` (api 54321, github and google providers) and
  `supabase/templates/{invite,recovery}.html`.
- `Makefile:12,90-125,130`: `make dev` runs `supabase start` and writes `supabase
  status` into `.dev-ports`; `make down` runs `supabase stop`; `:146-170` blank
  `SUPABASE_AUTH_ADMIN_KEY` for api and workers.
- `.env.example:33-109,330,371`, `docker/docker-compose.worker.yml:43-44,97-98`
  (jwks and issuer default to the local stack), `docker/docker-compose.yml:2`.

deploy:

- `deploy/env/env-prod.example:6-16` and `env-prod-frontend.example:5-6`.
- `deploy/hetzner/sync-env.sh:25` and `deploy/vercel/sync-env.sh:21-23,27-28,37-38`
  require the names; `deploy/vercel/sync-env.sh:59-62` forbid the admin ones.
- `deploy/env/README.md:110-111,124-127,154-156`: the boundary rules and the
  hosted project's settings (refresh-token rotation, ten-second reuse interval)
  checked before a config-bearing release.

## impact

sign-in, session refresh, recovery and email change fail when the hosted
project does (`AuthUnavailable`). accounts live outside the nexus database and
its cloudflare r2 backups: a restore brings back `users` rows, not credentials
or identities. development needs the supabase cli and its docker stack.

## what leaving needs

- a session owner in nexus: credential check, issue, refresh, revoke, and a
  cookie the middleware still reads without a network call; it replaces
  `lib/supabase/*` behind the same exports.
- python verification against nexus's own keys instead of supabase's jwks.
- the accounts moved with their ids unchanged: emails, password hashes, github
  and google identities. whether the hosted project exports hashes is
  unverified; without them every password user resets.
- auth email (recovery, confirm, email change) from a sender nexus configures.
- oauth callbacks re-registered with github and google; android google
  id-token sign-in verified by nexus.
- one cutover for live sessions: web, android webview and handoff codes end or
  are honoured for a window.
- the dev stack, env names, sync scripts, deploy readme and privacy copy above
  rewritten or deleted.

resolved when production signs in by password, github and google (web and
android) with no supabase project, `git grep -i supabase` finds nothing outside
`docs/`, and `make dev` starts without the supabase cli.
