# auth cutover review + hardening pass

## summary
- completed a full review/remediation pass across OAuth login, callback handling,
  signout behavior, linked identities UI, e2e auth bootstrap, and env/docs
  wiring
- removed unsafe public error echo in callback redirects and mapped user-visible
  auth errors to an allowlisted set of safe messages
- ensured callback-origin policy failures return a controlled 500 instead of an
  uncaught exception path
- updated e2e auth bootstrap so setup no longer depends on `/login` hash-token
  processing (it now persists Supabase session cookies directly in Playwright)
- fixed setup/ops/docs inconsistencies (`README` artifact removal, loopback URL
  canonicalization, redirect-origin env documentation)

## decisions
- **safe auth error surface**: callback and login now display only known
  allowlisted messages, not arbitrary provider/internal strings
- **fail-closed callback posture retained**: missing
  `AUTH_ALLOWED_REDIRECT_ORIGINS` on non-local callbacks still fails closed;
  route now responds in a controlled way
- **e2e setup decoupled from client hash import**: security hardening on login
  does not regress test setup reliability
- **signout semantics explicit**: `/auth/signout` intentionally uses local-scope
  signout and this is documented inline

## docs
- updated root docs: `README.md`
- updated app docs: `apps/web/README.md`
- added auth hardening note: `docs/auth/oauth-cutover-hardening.md`

## how to test
```bash
cd apps/web
npx vitest run --project unit src/lib/auth/callback.test.ts src/lib/auth/messages.test.ts src/lib/auth/redirects.test.ts src/lib/auth/identities.test.ts src/app/auth/callback/route.test.ts src/app/auth/signout/route.test.ts src/lib/supabase/middleware.test.ts src/lib/panes/paneRouteRegistry.test.tsx
npx vitest run --project browser src/__tests__/components/SettingsPage.test.tsx "src/app/(authenticated)/settings/identities/page.test.tsx" "src/app/login/LoginPageClient.test.tsx"
npm run lint
npm run typecheck
npm run build

cd ../e2e
CI=1 WEB_PORT=3001 API_PORT=8001 npx playwright test tests/auth.spec.ts --config=playwright.config.ts
```

## manual verification
```bash
# from repo root, with temporary servers on ports 3001/8001
curl -i "http://localhost:3001/login?next=%2Flibraries"
curl -i "http://localhost:3001/auth/callback?next=%2Flibraries"
curl -i -X POST "http://localhost:3001/auth/signout"
```

Observed behavior:
- `/login` returns 200 with Google/GitHub provider entrypoints
- `/auth/callback` without `code` returns 307 to `/login?...error_description=...`
- `POST /auth/signout` returns 302 to `/login`

## risks
- callback-origin strictness remains intentionally strict and will fail non-local
  callback traffic when `AUTH_ALLOWED_REDIRECT_ORIGINS` is missing
- e2e cookie bootstrap depends on current Supabase cookie payload encoding
  (`base64-...` session format); upstream format changes will require harness
  updates
- optional live GitHub provider round-trip remains credential-gated and was
  skipped in automated verification when credentials were not provided
