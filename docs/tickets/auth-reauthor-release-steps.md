# auth reauthor: release steps

status: open until the release that carries the auth reauthor (it lands after the
pending production release).
origin: 2026-10-10 auth reauthor (branch cleanup/auth-reauthor, base 0f664f1e8;
coordinator review R5).
area: release / web auth.

the web app now has one public origin, `APP_PUBLIC_URL`. `lib/env.ts` no longer
reads `AUTH_ALLOWED_REDIRECT_ORIGINS`, `AUTH_TRUSTED_PROXY_ORIGINS` or
`SERVER_ACTION_ALLOWED_ORIGINS`, and `NEXUS_EXTENSION_REDIRECT_ORIGINS` must hold
exactly one origin (a comma list fails `getEnv()`, so `next build` fails and
Vercel produces no READY deployment). web only: no api, android or extension
release; no migration.

before promoting:

1. set Vercel production `NEXUS_EXTENSION_REDIRECT_ORIGINS` to the one extension
   origin (`https://1ddcf81c2e8737ef7e045031d91fb2c3d6b899ae.extensions.allizom.org`
   for `capture@nexus.local`) in the private `deploy/env/env-prod-frontend`, and
   run `deploy/vercel/sync-env.sh` (it now refuses a list).
2. check hosted Supabase Auth `jwt_expiry` > 120 s (default 3600). the product
   calls a session refreshable with <= 120 s left (`lib/supabase/cookie.ts`
   `REFRESH_MARGIN_MS`); a shorter expiry makes every refresh a defect.
3. check `APP_PUBLIC_URL` equals the hosted `site_url` and the custom domain, and
   `${APP_PUBLIC_URL}/auth/callback` is an exact hosted redirect url (unchanged).

promote production web only through `deploy/hetzner/deploy.sh`'s promote.

after promoting:

4. add `AUTH_ALLOWED_REDIRECT_ORIGINS`, `AUTH_TRUSTED_PROXY_ORIGINS` and
   `SERVER_ACTION_ALLOWED_ORIGINS` to `FORBIDDEN_VERCEL_ENV_KEYS` in
   `deploy/vercel/sync-env.sh`, delete them from `deploy/env/env-prod-frontend`,
   and run `sync-env.sh`, which removes them from Vercel production and verifies
   (env changes reach new deployments only; doing this after promote keeps a
   rollback's env intact).

expected after release: sign-in works only at `APP_PUBLIC_URL`; the Vercel default
domain or an alias shows "This address can’t be used with Nexus."; open
`/login?error_description=…` urls show no notice.

acceptance: the release record names the extension origin set before promote,
the observed `jwt_expiry`, the promoted sha, and the follow-up commit that
forbids the three retired keys.
