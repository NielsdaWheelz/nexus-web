# old prefetch completion can replace a newer request

status: open
origin: 2026-10-02 cleanup discovery, origin/main 56b889bdc
area: web / pane resource cache

`apps/web/src/lib/api/resourceCache.tsx:60-68` settles a request whenever the
current entry for its key is pending, without checking which promise owns that
entry. `consume()` deletes an adopted pending entry without aborting its request
(`:38-41`; `useResource.ts:140-155` explicitly preserves the shared request).

reproduction: prefetch key k (a), consume k, prefetch k again (b), then settle
a while b is pending. a's success writes its old data over b; a's failure deletes
b. an intent on another copy of the same resource can create this sequence.
subsequent consumers can paint stale data or lose request deduplication.

prerequisites: none. compare the current pending promise or entry with the
settling request before replacing/deleting it; preserve consume-once adoption
and the existing prefetch bound.

acceptance: manually settle a before b in both success and failure cases;
the cache still exposes b until b settles. normal adoption, failed prefetch,
and eviction retain their existing behavior. `./scripts/test` passes.
