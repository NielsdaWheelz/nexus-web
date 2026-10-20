# rejected provider jwt crashes session verification

problem: a webview cookie retained from an earlier disposable auth authority
causes `Unexpected Supabase verification error: bad_jwt` instead of a recoverable
session rejection. login cannot render.

evidence: action-menu run `20261020-020450-fafb8afa1237`, actual api35 debug
webview on `emulator-5590`; retained private `failure.png` shows the runtime
error. `apps/web/src/lib/supabase/auth.ts:148` already models `bad_jwt` for
provider-ended sessions, but `verify` at lines177–185 recognizes `invalid_jwt`
and two error classes without that code. this change does not alter auth.

impact: stale tokens from a replaced authority can block login. native lab runs
must start with a clean owned debug profile; clearing that profile establishes
isolation and does not repair the product's rejection classification.

resolved when the auth owner classifies this actual verification response
correctly and a retained invalid cookie reaches normal sign-in without a crash,
while provider unavailability and genuine contract defects remain distinct.
