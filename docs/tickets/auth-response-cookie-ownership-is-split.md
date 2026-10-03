# auth response cookie ownership is split

status: open · origin: 2026-09-21 auth audit · area: web auth

`lib/supabase/route-handler.ts:23-57` maintains the next cookie store, an
effective-cookie map and pending response writes. `lib/auth/refresh.ts:54-91`
implements another effective jar and pending writes. both feed the same
`createSupabaseServerClient`. password update then seeds a second route client
with refresh output (`app/auth/password/update/route.ts:64-144`). paths here
are under `apps/web/src/` at main `bed71343cc`.

resolved native obligation, 2026-10-02: failed google/oauth mint and failed
attempted handoff installation now clear all old/new local auth names. native
deletion keeps expiry through the real Next mutable merge, including successful
obsolete chunk/verifier removal. `/tmp/nexus-native-handoff.gshAfz/after.receipt.json`
and `/tmp/nexus-native-handoff-independent-final-review.json` passed 25 actual
route cases, 35 synthetic HTTP calls and 12 checks with zero unhandled errors.
hosted auth, physical-device/browser flush and a real backend handoff transaction
were not exercised. the route and coalesced refresh collectors remain separate;
this record stays open for that ownership assessment.

fix: give response-owning auth operations one cookie adapter; keep server
actions' writable store and server components' read-only contract explicit.
do not merge distinct capabilities just to reduce file count. preserve sdk
headers, chunk removals, write order, clear precedence and native handoff.

acceptance: any selected collector change preserves the current sdk
cookie/header outputs through callback, sign-in, confirmation, refresh and
password update, including resolved failure cleanup and true deletion. retain
distinct writable/read-only capabilities. pass `./scripts/test`.
