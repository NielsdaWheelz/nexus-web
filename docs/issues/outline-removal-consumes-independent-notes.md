# outline removal can delete an independently identified note

owner invariant from review: resources are independent and links are bidirectional,
not ownership. unlinking or deleting one resource must never delete another.

evidence: `python/nexus/services/outline.py:582-603` checks remaining retainers and
physically deletes a note after removing its last retaining link.
`apps/web/src/lib/notes/useOutlineSession.ts:3183-3203` issues `remove` from the
ordinary outline consume gesture. `apps/web/src/lib/notes/outline.ts:552-608`
also joins text into the prior note and issues `consume_note` for the source.

impact: removing an occurrence can destroy the independently identified resource;
meaning changes according to unrelated links. this is a product-policy mismatch
even before local-first synchronization.

fix ordinary removal at its command owner: exact unlink preserves both endpoints;
explicit node deletion addresses that node only. the owner explicitly retained
joining as a two-note operation that merges into the destination and deletes the
source everywhere. it must not depend on retention-based ownership; concurrent
source edits use the separately agreed edit-wins rule.

resolved when unlink/delete commands preserve every non-addressed node and ordinary
outline removal behaves identically regardless of other references. qualify any
retained explicit multi-note gesture separately against its agreed semantics.

status (cutover worktree, unqualified): the server `remove`/`consume_note`
commands and `/resource-graph/commands` are deleted; links change only as
authored unlink/add commands that never delete an endpoint. the client outline
gesture and join remain with the editor owner's rewrite.
