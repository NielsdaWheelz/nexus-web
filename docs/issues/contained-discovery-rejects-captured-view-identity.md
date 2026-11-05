# contained discovery loses older rich captures

source-traced on main `2b0c01c36`. existing reader captures from articles with
embedded x posts can retain `gN:x<manifest>` in their frozen excerpt extent.
`node/authored/src/queries.ts:480–509` and
`python/nexus/services/resource_items/locations.py:473–493` require a bare
publication identity for rich-context proof inside a contained reading. older
captures therefore fall back to selected-text matching; their surrounding rich
context is lost, and table captures become unavailable even when the whole table
is permitted. reproduce by opening such a saved source capture through a piece
that contains its complete extent. this limitation predates the chat change.

saved-chat preview, admission and historical disclosure use the separate stored
evidence path (`python/nexus/services/resource_items/evidence.py:868,1172`), which
preserves frozen provenance and checks current disclosure independently. they do
not acquire this rejection from the browser publication-identity correction.

resolve at the current passage-proof owner, without parsing old view identities
or rewriting historical captures. proof: an unchanged older manifest-bearing
capture retains its permitted rich context and complete table through both local
and server contained discovery; partial tables and out-of-scope context remain
unavailable, and saved chat evidence remains unchanged.
