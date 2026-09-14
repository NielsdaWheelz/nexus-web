status: open
origin: 2026-09-14 publication heartbeat fence source audit
area: conversation context / resource graph concurrency

the direct context route (`api/routes/conversation_context.py:87`) and initial
conversation creation (`services/conversations.py:416`) call
`add_context_ref_without_commit`, then commit through the ordinary session.
neither selects serializable isolation. the context owner resolves the target,
then creates a bare edge; content chunks and evidence spans are attachable.
these polymorphic endpoints have no target foreign key. index replacement
deletes matching edges before deleting the old chunks/spans, without a shared
endpoint lock covering context creation.

source-level counterexample: context creation validates an old chunk; cleanup
passes its edge predicate; context creation inserts; reindex deletes the chunk.
there is no established common lock/isolation contract preventing a dangling
bare edge. this is a source audit, not an executed interleaving receipt.

first reproduce through the actual context and reindex owners with separate
postgres connections. then establish a compatible transaction/fence contract
at the existing owners, preserving idempotence and cited-target survival. do
not weaken reindex isolation or add a global graph lock by assumption.

acceptance: forced create-versus-delete orderings either preserve a live target
or refuse/retry the context mutation, never commit a bare edge to a dead target;
existing context and cited-edge lifecycle oracles still pass.
