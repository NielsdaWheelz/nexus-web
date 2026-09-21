# auth response cookie ownership is split

status: open · origin: 2026-09-21 auth audit · area: web auth

`lib/supabase/route-handler.ts:23-57` maintains the next cookie store, an
effective-cookie map and pending response writes. `lib/auth/refresh.ts:54-91`
implements another effective jar and pending writes. both feed the same
`createSupabaseServerClient`. password update then seeds a second route client
with refresh output (`app/auth/password/update/route.ts:64-144`). paths here
are under `apps/web/src/` at main `bed71343cc`.

fix: give response-owning auth operations one cookie adapter; keep server
actions' writable store and server components' read-only contract explicit.
do not merge distinct capabilities just to reduce file count. preserve sdk
headers, chunk removals, write order, clear precedence and native handoff.

acceptance: actual sdk operations publish identical cookies/headers through
callback, sign-in, confirmation, refresh and password update; a failed native
handoff clears all established session names. pass `./scripts/test`.
