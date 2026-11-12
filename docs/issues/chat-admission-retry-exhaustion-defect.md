# chat admission retry exhaustion becomes a defect

confirmed in source and a disposable browser run, 2026-11-12. after three ordinary
transport failures, `apps/web/src/lib/api/retry.ts:73` wraps the final api error in
`RetryExhaustedError`. `lib/chat/wire.ts:36-47` recognizes only `ApiError`, so it
classifies that wrapper as a defect. `lib/chat/commands.ts:137-141` correctly keeps
the uncertain command, but also reports the ordinary network exhaustion as an
operation defect.

`components/chat/ChatOperationBoundary.tsx:13-15` sends defect telemetry. the
command's `retry()` does not clear this defect; by source inspection, after a successful exact replay,
`components/chat/Librarian.tsx` may replace the retired uncertain hold with
“this librarian action stopped unexpectedly.” the draft and immutable retry
identity remain retained. the suspected stale notice after replay has not been
verified at runtime.

run `20261112-151203-0067d33ca6e0` interrupted three actual admission responses.
the unknown-admission trace records `chat operation failed: RetryExhaustedError:
request recovery exhausted`; `api.log:362` records `rum.client_defect`. its browser
snapshot retains the draft and search results, with the uncertain notice behind
the shared “show notice” control.

the corrected public-ui journey passed in run `20261112-151734-e9bdc8e74073`
(`/tmp/nexus-librarian-green5.log`): all four delivery attempts retained identical
idempotency key and body; exactly one turn was stored. the search view and draft
survived uncertainty, and acknowledging the replay navigated to latest and cleared
the accepted draft. the remaining confirmed defect is false defect classification
and telemetry, not failed replay or duplicate admission.

resolve at the retry/chat failure boundary so exhausted known transport errors
remain uncertain writes, while actual defects retain their existing boundary.
proof: interrupt all three real admission responses, observe retained draft/view
without defect telemetry, then acknowledge the same request on retry; one turn
exists and no stale defect remains. application changes are outside history
search scope.
