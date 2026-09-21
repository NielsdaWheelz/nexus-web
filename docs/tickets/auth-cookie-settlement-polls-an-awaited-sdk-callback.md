# auth cookie settlement polls an awaited sdk callback

status: open · origin: 2026-09-21 cleanup auth audit · area: web auth

`apps/web/src/lib/supabase/route-handler.ts:61-75` polls a cookie-write
counter for up to three timer turns; `lib/auth/refresh.ts:128-135` repeats
the mechanism. route callers must also remember to await settlement.
the installed `@supabase/auth-js` 2.108.2 awaits auth-state subscribers
(`GoTrueClient.ts:4942,5031`), and `@supabase/ssr` 0.10.2 awaits cookie
storage from that subscriber (`createServerClient.ts:196`). the claimed
post-operation cookie callback is already part of operation completion.

fix: remove the settlement methods, counters, timers and call-site awaits;
keep actual cookie/header collection and response publication at one owner.
prerequisite: verify all retained auth operations against the locked sdk.

acceptance: callback exchange, password sign-in/update, otp confirmation,
native sign-in and refresh publish the same cookies and no-store headers
when the provider operation resolves, without later timer turns. preserve
clear/rotate precedence and native handoff cleanup; pass `./scripts/test`.
