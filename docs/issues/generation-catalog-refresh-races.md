# concurrent generation catalog refreshes can replace newer facts

`Catalog.read()` has a process-local cache but no shared in-flight refresh. two
reads after expiry can fetch independently; a later failing fetch can replace a
successful fresh catalog with the older rows it captured before awaiting.

source evidence at `6d6a6799c`:
`python/nexus/services/generation/catalog.py:153-159` reads and publishes the cache
around an unguarded await; `:164-186` returns its captured previous catalog on
failure. interleaving: reads a and b capture old rows; a succeeds and publishes
new rows; b fails and publishes old rows with unavailable readiness. this also
contradicts the module's one-fetch-per-period description. no runtime reproduction
has been performed.

impact: unnecessary provider work and regression of catalog facts/readiness.
frontend request deduplication does not serialize independent backend callers.

resolve at the catalog owner with one in-flight refresh per endpoint per process
and explicit lifetime/publication ownership. prove overlapping successful and
failing reads cannot republish an older snapshot, including caller cancellation.
