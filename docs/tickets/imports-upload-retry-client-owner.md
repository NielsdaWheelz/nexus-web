# Upload retry and remove have no `lib/imports` client function

**Status:** resolved (Track D2, 2026-09-08)
**Origin:** Imports workspace cutover, Track D1, 2026-09-08 (revised after review)
**Area:** `apps/web/src/lib/imports/importsClient.ts`; `apps/web/src/lib/media/ingestionClient.ts`

## What is wrong

The Track D1 ownership set names `retryUploadImport` and `removeUploadImport` in
`lib/imports/importsClient.ts`, hitting `POST /api/media/uploads/{handle}/retry`
and `DELETE /api/media/uploads/{handle}`. Neither was written.

`ingestionClient.ts` already owns both endpoints and, more importantly, owns the
**upload-session error contract**: `uploadSessionOutcome(endpoint, error)` maps
each declared code to one `UploadSessionOutcome`, and each command consumes that
outcome. `retryUploadSession` also owns the PUT + confirm orchestration a retry
needs. `removeUploadSession` maps `E_UPLOAD_SESSION_NOT_FOUND` and
`E_UPLOAD_ALREADY_PUBLISHED` to `Superseded` and returns silently, because a
session that is already gone or already published leaves nothing to remove.

A `lib/imports` copy of either command would give one capability two owners
(`docs/rules/cleanliness.md` "One concern has one owner";
`docs/rules/simplicity.md` "Do not expose interchangeable duplicate APIs for the
same capability"), and a copy that re-issued the bare request without the
outcome mapping would erase a modeled error channel
(`docs/rules/control-flow.md` "Do not erase finite error channels"). D1 first
shipped exactly that weaker `removeUploadImport`; it has been deleted, so the
two upload commands now have one owner each and the split is consistent.

`lib/imports` cannot simply import `uploadSessionOutcome` today: D2 re-points
`ingestionClient`'s `publishMediaActivityInvalidation` calls at
`importsClient.publishImportsInvalidation`, so `importsClient -> ingestionClient`
would close a module cycle. Moving the commands must move the outcome contract
with them.

## Prerequisites

Track C's `RetryUploadSessionRequest` (adds `client_mutation_id`,
`expected_generation`) and the modeled `NeedsAttention` retry outcome.

## Proposed fix

In Track D2, decide one home for the upload-session command channel and move
`uploadSessionOutcome` / `UploadSessionError` / `UploadSessionOutcome` there with
it (a directive-free `lib/media/uploadSessionOutcome.ts` both modules import
breaks the cycle). Change `retryUploadSession` to the contract signature, drop
`retriedCapability` (which throws on the now-modeled `NeedsAttention`), and keep
removal's `Superseded`-is-discharged branch wherever the function ends up. Do not
add a second upload-retry or upload-remove client.

## Acceptance

Exactly one browser function posts to `/media/uploads/{handle}/retry` and exactly
one deletes `/media/uploads/{handle}`; retry sends `client_mutation_id` and
`expected_generation` and returns the two modeled outcomes; a unit case proves
that removal treats `E_UPLOAD_SESSION_NOT_FOUND` and
`E_UPLOAD_ALREADY_PUBLISHED` as the obligation discharged rather than an error.

## Resolution (Track D2, 2026-09-08)

`ingestionClient.ts` keeps both commands and the outcome contract; no module was
moved and no cycle exists, because `importsClient.ts` never imports
`ingestionClient.ts` — the dependency runs one way,
`ingestionClient -> importsClient.publishImportsInvalidation`.
`retryUploadSession` now takes `{sessionHandle, file, expectedGeneration,
clientMutationId, signal}`, sends `client_mutation_id` and `expected_generation`,
handles the endpoint's `UploadRequired | NeedsAttention` answer through the modeled
`UploadSessionOutcome` channel (`retriedCapability`, which threw on
`NeedsAttention`, is deleted), and adds `409 E_RESOURCE_CONFLICT -> Conflicted`.
`removeUploadSession` is unchanged and still treats
`E_UPLOAD_SESSION_NOT_FOUND` / `E_UPLOAD_ALREADY_PUBLISHED` as the obligation
discharged, proved by `ingestionClient.unit.test.ts`.

Amended after review (2026-09-08): the retry answer is decoded by a `retryResponse`
narrowing that refuses `Published` at the boundary, so the two declared variants are
the whole type and no downstream guard remains; the declared-code table gained
`E_UPLOAD_GENERATION_STALE -> Superseded` and
`E_IDEMPOTENCY_KEY_REPLAY_MISMATCH -> IntentChanged`, the two 409s the replay
contract introduces; and the pre-cutover "re-request when the signed window has
already closed" branch is deleted — the server memoizes the admitted expiry and
will not extend it, so an expired admitted capability is the modeled
`NeedsAttention` answer and another renewal needs a fresh explicit command.
