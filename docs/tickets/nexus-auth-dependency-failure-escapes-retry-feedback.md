# nexus auth dependency recovery policy candidate

status: open policy candidate; source-verified, live not_run
origin: 2026-10-02 nexus feedback producer-completeness review
area: nexus history save / page create / library create

valid `503 E_AUTH_UNAVAILABLE` can reach all three commands. their current gates
send it to the original defect owner instead of manual retry. source reachability
is verified; a contract violation is not established. this failure is deliberately
outside the current consolidation and is not malformed or unknown wire.

evidence at main `104851703db7f445143bb0fff79ec8a6a3d84bf3`: all three POSTs
use `apps/web/src/app/api/[...path]/route.ts:63-70`; no explicit override exists.
`apps/web/src/lib/api/proxy.ts` `proxySession` emits auth503 when
`lib/auth/session.ts` `liveSession` throws `AuthUnavailable` from the one
refresh owner (`lib/supabase/auth.ts` `refresh`, dependency classification
`isDependencyFailure` and the operation deadline; paths since the 2026-10-10
auth reauthor). active bearer verification independently
emits auth503 on JWKS failure (`python/nexus/auth/verifier.py:123-136`,
`python/nexus/errors.py:218`, `python/nexus/auth/middleware.py:181-184`), forwarded
unchanged by proxy `:95-109`. client `lib/api/client.ts:312-320` preserves the
envelope. history `lib/nexus/useNexusFind.ts:43,133-136` and creation
`components/nexus/useNexusController.ts:52,280-283,296,310` exclude this code;
both retain the original error in `setDefect`. canonical `apiTransportFeedback`
at `lib/api/client.ts:116-135` also returns null. abbreviated web paths are
under `apps/web/src/`.

prerequisite/action: decide the writes' post-budget dependency policy explicitly;
`docs/rules/errors.md` defaults persistent dependency failure to a defect unless
terminal unavailability is an intended modeled outcome. a valid503 envelope alone
does not establish Retry policy. if recovery is adopted, update shared feedback
and affected consumer gates. preserve exact auth401 recovery,
strict malformed/unknown/internal refusal, titles/request ids and existing
manual replay identities; do not add automatic command replay.

acceptance: the owning contract explicitly chooses terminal defect or modeled
recovery, and producer/consumer classifications agree. if recovery is adopted,
actual isolated JWKS/provider outages must yield real public auth503 feedback
without login redirect or first-write mutation; actual Retry must preserve the
frozen body/id and one durable result. runtime/browser/production are not_run.
