# writing runtime teardown can overtake a new start

`useWritingRuntime.ts` starts the journal from its effect and fires stop without
awaiting it in cleanup. `journal.ts` previously checked its same-account database
fast path before pending teardown finished. retry/account effect replacement can
therefore report ready, then lose its runtime when the older stop continues.
overlapping initial starts can also overwrite held account/observer leases.

serialize the actual runtime start/stop owner before the fast path; retain the
synchronous security pause. rejected starts must not block subsequent cleanup or
retry. prove same-account retry and account-switch ordering, sole-tab sign-out,
and the normal recovery journeys against the real runtime. no live proof yet.

source repair: exported start/stop enqueue their private operations on one settled promise chain. private start calls private stop, and the same-account fast path runs only inside that chain for active admission. stop/security pause synchronously invalidate the startup request generation; every existing startup epoch checkpoint also rejects superseded requests, including the authenticated storage-failure branch and final gate release. a rejected operation settles the chain before the next operation. live qualification remains pending.
