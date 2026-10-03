# share account transient recovery policy candidate

status: open policy candidate; source-verified, live not_run
origin: 2026-10-02 post-share producer-completeness review
area: inbound plain-text share / account read

the share auth/network cut deliberately admits only exact `401 E_UNAUTHENTICATED`
and `E_NETWORK`. its complete failure projection throws valid account dependency
errors instead of producing inline feedback. reachability is source-verified;
a contract violation is not established.
this is separate from the released auth401 fix; no release proof is reopened.

evidence: checked owners at main `104851703db7f445143bb0fff79ec8a6a3d84bf3` after share PR438, file sha256
`dc17b5c7920eea9973575ae9834d7dd5f437dece08c287ce338239cce48ea8ad`.
`apps/web/src/lib/api/proxy.ts:114,118` emits `504 E_UPSTREAM_TIMEOUT` or
`502 E_UPSTREAM` for real backend timeout/connectivity failures; `:164-169`
emits `503 E_AUTH_UNAVAILABLE` on refresh dependency failure. the structured
catch-all forwards `/api/me` (`app/api/[...path]/route.ts:63-66`). client parsing
preserves those envelopes (`lib/api/client.ts:312-320`); get retry exhausts three
attempts for these modeled 5xx (`lib/api/retryPolicy.ts:8,61-67`), then
`lib/api/useResource.ts:197-203` stores the original error. account render calls
`app/share/ShareCapture.tsx:324-328`; its strict helper at `:61` throws all three.
these paths are under `apps/web/src/`. backend JWKS failure independently emits
the same auth503 (`python/nexus/auth/verifier.py:123-136`,
`python/nexus/errors.py:218`, `python/nexus/auth/middleware.py:181-184`).

prerequisite/action: decide the account read's post-budget dependency policy;
`docs/rules/errors.md` defaults persistent dependency failure to a defect unless
terminal unavailability is an intended modeled outcome. valid-envelope reachability
alone does not establish Retry policy. if recovery is adopted, update the share
result owner while retaining strict defect refusal.
use canonical upstream feedback where applicable; choose auth-dependency copy
explicitly. preserve existing account retry, no capture before account success,
no login navigation, request ids and frozen mutation identities. do not broaden
unrelated nexus commands or URL/destination capture policy.

acceptance: the owning contract chooses terminal defect or modeled recovery,
and producer/consumer classifications agree. if recovery is adopted, an admitted
share must receive actual BFF 502/504/503 from isolated dependency failures and
show its exact request id/manual recovery without capture writes; restoring the
dependency must capture once. runtime/browser/device/production are not_run.
