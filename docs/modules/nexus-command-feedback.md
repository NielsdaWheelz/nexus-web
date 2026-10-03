# nexus command feedback

status: implemented; local behavior and static passed
origin: 2026-10-02 cleanup; base `104851703db7f445143bb0fff79ec8a6a3d84bf3`

[`apiTransportFeedback`](../../apps/web/src/lib/api/client.ts) owns transport
wording. [`useNexusFind.ts`](../../apps/web/src/lib/nexus/useNexusFind.ts) owns
history admission/retry; the
[`controller`](../../apps/web/src/components/nexus/useNexusController.ts) owns
creation admission/domain copy. the old exported `nexusFailure` and its duplicate
transport policy are removed.

## adopted behavior and ownership

only those two nexus production files change. history calls unchanged
`apiTransportFeedback(error: ApiError, title: string): FeedbackContent | null`
after an explicit ApiError/accepted-code gate. its frozen send closure, raw body,
mutation id, persistent feedback key `nexus-history-save` and Polite Retry remain.

existing `createFailure(error: unknown, title: string, codes: readonly string[]): FeedbackContent | null`
owns the five creation-domain messages. auth handling remains first. only an
admitted ApiError reaches canonical feedback; nonnull transport feedback wins.
otherwise an owned domain message produces feedback. missing canonical/domain
content routes the ORIGINAL error through existing `setDefect` and returns null;
no feedback carries an undefined message. no new module, wrapper or interface.

public `TRANSPORT_CODES` stays the shared command admission contract, narrowed
to `E_NETWORK`, `E_UPSTREAM`, `E_UPSTREAM_TIMEOUT`.

| caller | additional admitted codes | retained title/retry identity |
| --- | --- | --- |
| history | none | `Nexus history wasn’t saved`; same serialized selection/mutation id |
| page | `E_FORBIDDEN`, `E_LIBRARY_FORBIDDEN`, `E_INVALID_REQUEST`, `E_RESOURCE_CONFLICT` | `Page couldn’t be created`; same page id/title/activation |
| library | page set + `E_NAME_INVALID` | `Library couldn’t be created`; same library id/name/activation |

the first changed-name call while Retryable rotates the id and returns Ready;
subsequent Ready edits retain that id. an unchanged-name call does not rotate it.
tone Danger, original optional requestId, exact auth401 recovery and original
defect routing remain. domain copy stays verbatim: forbidden/library-forbidden
“This account can’t make that change.”; invalid-request “Review the request and
retry.”; name-invalid “Enter a non-reserved library name between 1 and 100
characters.”; resource-conflict “The saved create request conflicts with another
resource.” no effects, state, activation, search timing, routes or persistence change.

intentional transport copy: network “retry” becomes “try again”; upstream/timeout
becomes “Please wait a moment, then try again.” actual manual Retry remains.
intentional hard cut: a contrary `E_RATE_LIMITED` envelope becomes the original
defect instead of Retry. its sole producer is SSE listener capacity
(`python/nexus/db/listen.py:44`), unreachable from these synchronous POSTs;
BFF/client/backend have no generic429-to-rate normalization. canonical feedback
retains its `E_RATE_LIMITED` arm. no SSE-to-feedback journey was qualified here.

valid `503 E_AUTH_UNAVAILABLE` reaches all three commands through BFF refresh
or backend JWKS dependency failure. it remains deliberately outside this current
command-feedback contract, preserving original-defect routing. future Retry
requires explicit operation policy for terminal dependency unavailability;
valid-envelope reachability alone does not establish that policy. the separate
[nexus policy candidate](../tickets/nexus-auth-dependency-failure-escapes-retry-feedback.md)
and [share policy candidate](../tickets/share-account-transient-failures-escape-inline-feedback.md)
remain source-only candidates, without an established contract violation;
this cut does not silently admit them.

## proportional qualification

the unchanged seven-journey oracle and prewrite dump ran against real local auth,
api/postgres head `0252` and production Next: history/page/library accepted-response
loss then actual Retry at both viewports; natural reserved-`All` failure then
edited-name success. baseline `1048517` passed **154/160**, with only six intended
network-copy failures. candidate **160/160** passed on that base plus these owner bytes:

- `useNexusFind.ts`: `0ec7b1dc9420623d3f7ab667b4aad951f3208fb990d38836425b00c7a5b78b3f`
- `useNexusController.ts`: `e217bf802cfe4fe1aff3aa5462cd811b8a0f633ec9d7e1c4626af345e12f2e2b`

production build exited 0; bundle id `ZutaLWQRgg5z2qJvhfaoR`. actual command URLs,
raw bodies/ids, first acceptance/replay data, scoped durable rows/revisions,
title/copy, activation and natural domain-error requestId were conserved.
network feedback fabricated no unseen success requestId. zero escaped errors,
search requests or incomplete journeys; no whole-database immutability claim.
candidate receipt sha256 `25fa4a22f15c98ac271640d1dfcfb6d13381d9cb88f1a5c9ecb332c41f0cd56d`.

upstream/timeout copy, strict negative classification, auth-first routing and
rate retirement are source-reviewed. live outages/auth-failure, external providers,
devices and deployed production are not_run. the sole static gate `./scripts/test`
passed, exit 0, on working tree `a567b11616e89a072a2f4e233e91ffe1cade788f`
based on `1048517`; all nine owned paths stayed unchanged. log sha256
`6e9d506c84966f29679006b156bb834c96f0e7c56ca4b56d9f3583c6d9704935`.
this receipt-only edit follows the checked tree. temporary proof is removed after
acceptance. the duplicate-copy issue
is resolved; the selection-concurrency issue and both policy candidates remain open.
