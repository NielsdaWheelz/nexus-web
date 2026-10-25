# a failed shared worker can leave later requests waiting forever

`apps/web/src/lib/authored/client.ts` handles `worker.onerror` by rejecting the
requests already in `waiting`. it does not close admission or reject later calls.
`WritingRuntime.store` retains the successfully opened store promise, so retry
can enqueue another request to the failed worker with no responder.

impact: retained unsaved input can lose an effective retry path after a worker
failure. the initial-open rejection path already clears its failed promise; this
is the failure after successful opening.

resolve at the store/runtime boundary: later requests must fail deterministically,
and retry must reopen a valid owner while retaining the same admitted intent and
uncertain commit identity. prove a worker failure after open, retry, and durable
reopen without a duplicate command or lost words. no recovery inventory.
