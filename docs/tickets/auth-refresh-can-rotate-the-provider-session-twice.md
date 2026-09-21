# auth refresh can rotate the provider session twice

status: open · origin: 2026-09-21 cleanup auth audit · area: web session refresh

`apps/web/src/lib/auth/refresh.ts:95` calls sdk `refreshSession()` with
the presented cookie jar. in locked `@supabase/auth-js` 2.108.2,
`GoTrueClient._refreshSession` first calls `_useSession`; `__loadSession`
refreshes near-expiry credentials, then `_refreshSession` explicitly
refreshes the successor again (`GoTrueClient.ts:3002,3709,3723`). the
independent audit reproduced two refresh grants for near-expiry cookies.
this adds a provider round trip and an avoidable failure point after an
already successful rotation.

fix: make the refresh owner request exactly one provider grant and collect
its successor cookies. preserve in-flight deduplication and exact terminal
versus dependency-failure classification. a blind switch to `getSession()`
is insufficient: `dal.ts` can demand refresh after invalid claims on an
otherwise active cookie, and sdk loading can preserve still-valid access
after a refresh rejection.

acceptance: near-expiry, expired and active-but-rejected credentials each
request one grant; concurrent identical credentials share it; terminal
rejection clears cookies, dependency failure preserves them, and successful
rotation publishes a live successor. use the real locked sdk against a
controlled provider, then remove the probe and pass `./scripts/test`.
