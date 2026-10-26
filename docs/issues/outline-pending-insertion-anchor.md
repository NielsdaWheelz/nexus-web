# pending creation retains an earlier unlinked insertion anchor

exact `292018f8c`, run `20261026-004448-59e397bf4432`, passes the offline
last-child arrow removal, retained rich input and host identity, focus transfer,
and local unlink-only membership oracles. after releasing the next command lock,
`projected-children-flat.spec.ts:91` never finds the new rich note locally.
adjacency remains at store revision 2 through the ten-second deadline; the actual
editor displays “the selected insertion position is no longer available”. the
raw bold input remains visible with retry/copy controls. upload was not reached.

the reserved tail captured the child relationship as its insertion predecessor
before that queued unlink committed. `OutlinePendingInput.run()` resolves
`create.after_id` from the retained field's link without considering that the
same ordered owner already hid/unlinked it. absolute-tail input must pass null
for both its pending occurrence anchor and canonical link anchor, resolving the
current tail at command preparation. explicit insert-after keeps its chosen
anchor and the canonical position helper keeps rejecting stale anchors.

the source correction clears both absolute-tail anchors and the root's absolute
append anchor. no retry, field, history or canonical position helper changes.

prove the unchanged two-lock offline journey through exact local rich creation,
server absence while offline and later canonical upload. retained writing must
remain copyable and exact retry must not reapply an already committed command.
