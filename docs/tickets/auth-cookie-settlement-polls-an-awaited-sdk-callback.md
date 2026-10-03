# auth cookie settlement polls an awaited sdk callback

status: open · origin: 2026-09-21 cleanup auth audit · area: web auth

`apps/web/src/lib/supabase/route-handler.ts:61-75` polls a cookie-write
counter for up to three timer turns; `lib/auth/refresh.ts:128-135` repeats
the mechanism. route callers must also remember to await settlement.
the installed `@supabase/auth-js` 2.108.2 awaits auth-state subscribers
(`GoTrueClient.ts:4942,5031`), and `@supabase/ssr` 0.10.2 awaits cookie
storage from that subscriber (`createServerClient.ts:196`). the claimed
explicit operation's cookie callback is already part of operation completion.

source qualification, 2026-10-02 at main `aea51d2b3`: the locked compiled
`@supabase/auth-js/dist/module/GoTrueClient.js:3542-3556` launches an unawaited
`_emitInitialSession` from `onAuthStateChange`. it calls `_useSession` and
`__loadSession`, which can refresh near-expiry storage (`2409-2483`).
explicit-operation awaits do not themselves join that startup task;
`refreshingDeferred` and any configured lock can affect whether the paths
converge. both distributed javascript builds and the actual Next auth bundle
contain these paths. no live post-response write defect has been verified.

proposed fix, only after that startup is qualified: remove the settlement methods, counters, timers and call-site awaits;
keep actual cookie/header collection and response publication at one owner.
prerequisite: verify retained operations and subscriber startup against the
locked executed sdk. prove whether near-expiry startup can publish after the
response, including shared refresh promises/locks. if no stable complete
boundary is established, park the deletion; do not add another timer fallback.

acceptance: callback exchange, password sign-in/update, otp confirmation,
native sign-in and refresh publish the same cookies and no-store headers
when the provider operation resolves, without later timer turns. preserve
clear/rotate precedence and native handoff cleanup; pass `./scripts/test`.
