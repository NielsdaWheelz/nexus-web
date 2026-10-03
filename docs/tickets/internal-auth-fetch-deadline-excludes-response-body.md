# internal auth deadline excludes response body

status: open · origin: 2026-10-02 native handoff contract review, `d5de2e922` · area: internal auth transport

`apps/web/src/lib/auth/internal-fetch.ts:19-25` clears the five-second abort
timer as soon as `fetch` returns headers. `lib/auth/mint-handoff-code.ts:48` and
`app/auth/handoff/route.ts:119` subsequently await json body transfer outside
that budget. an internal service that sends headers then stalls can hold mint
or consume beyond the claimed operation deadline. this is source-confirmed;
no actual stalled-body reproduction was induced.

this boundary directly owns internal FastAPI response consumption, unlike the
separate sdk body/retry debt in
`supabase-operation-deadline-ends-at-response-headers.md`. the native failure
repair does not include a deadline expansion.

fix: keep the owned abort/deadline in force through required internal response
consumption, preserving mint/consume failure classification and cookie effects.
size the mechanism to these callers; do not add a generic retry or sdk framework.

acceptance: a controlled internal response sends headers and stalls its body;
mint and consume terminate within their stated budget, abort transfer and use
their existing failure surfaces. normal response parsing and session behavior
remain. `./scripts/test` passes; temporary fixtures are removed.
