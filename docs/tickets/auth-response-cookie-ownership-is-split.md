# auth response cookie ownership is split

status: open · origin: 2026-09-21 auth audit · area: web auth

`lib/supabase/route-handler.ts:23-57` maintains the next cookie store, an
effective-cookie map and pending response writes. `lib/auth/refresh.ts:54-91`
implements another effective jar and pending writes. both feed the same
`createSupabaseServerClient`. password update then seeds a second route client
with refresh output (`app/auth/password/update/route.ts:64-144`). paths here
are under `apps/web/src/` at main `bed71343cc`.

current native failure contract, source-qualified at `ca1bb2e629`:
`app/auth/native/google/route.ts:13-16,48-58` finishes the failed mint's 502 with
`auth.applyCookies(response)` and its default `Preserve` effect. if google
sign-in established cookies before the mint failed, the route adapter promotes
pending writes to `Rotate` (`lib/supabase/route-handler.ts:80-123`) and publishes
them. it does not clear them. the credential-input candidate preserves this
behavior: `actual-native-mint-failure` in
`/tmp/nexus-auth-startup.E0TlcS/actual-after.receipt.json` records 502 with a live
auth cookie, two writes before return and no later writes, using the actual
route/sdk with synthetic loopback provider and a controlled mint failure.
hosted auth and native-device delivery were not exercised.
the failed-mint clearing acceptance below is a desired policy change, not
behavior to claim conserved during an adapter cleanup. it is a separate pending
repair, currently unselected for this slice; its own change must verify cleanup.

fix: give response-owning auth operations one cookie adapter; keep server
actions' writable store and server components' read-only contract explicit.
do not merge distinct capabilities just to reduce file count. preserve sdk
headers, chunk removals, write order, clear precedence and native handoff.

acceptance: actual sdk operations publish identical cookies/headers through
callback, sign-in, confirmation, refresh and password update; a failed native
handoff clears all established session names. pass `./scripts/test`.
