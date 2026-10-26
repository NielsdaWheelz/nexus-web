# owned saved passage cannot arrive offline

at `eb5c9ebf6`, local saved-passage search has no route because
`lib/resources/localResource.ts` handles highlights but not passage anchors.
even a correctly formed `#passage-<id>` enters the remote
`/resource-items/source-targets/resolve` call in `lib/reader/sourceArrival.ts`;
only highlights use the local path. paths are under `apps/web/src/`.

resolve the account-owned immutable passage from the existing authored store.
the mounted reader/note owns generation, part bounds, unique quote relocation,
painting and focus. a part-owned passage with a null locator is real supported
data (`resource_graph/links.py`, `passage_anchors.py`); use the published local
source-alias relationship, not a guessed owner or a server fallback.

resolved when local search opens the selected authorized reading and locates
owned text/pdf/note passages offline. ambiguous/stale/unrelated captures remain
truthfully unavailable; canonical writing and captures never change on arrival.
