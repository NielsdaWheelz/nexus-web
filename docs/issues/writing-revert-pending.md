# reverting while a different value is pending loses the save intent

source counterexample: saved z, sealed autosave a in flight, then committed
revert z. `texts.ts` `intentFor` returns null on z == acknowledged z before
checking the branch's pending predecessor. only the checkpoint remains; a's
acknowledgement advances the base to a and leaves z dirty without a write.

resolve the existing branch dependency before the equality shortcut. a pending
result requires an absolute z successor; equality is a no-op only without one.
this also applies to deferred commits whose desired value already equals the
current acknowledgement. no causal expectation or retry semantics change.

resolved when a real held-a acknowledgement followed by committed z preserves
the exact successor on disk and eventually saves z without another input event.
live reproduction: lab `20261021-173813-e9aef096df90`,
`writing-revert-pending.spec.ts`. exact z revision 2 completed its checkpoint;
only sealed a was sent. after its genuine acknowledgement, canonical a remained
and z/base-a remained dirty with an empty outbox. the dependency-before-equality
repair is source-reviewed; green qualification remains pending.
