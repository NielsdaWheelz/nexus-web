# reader chat waits on the wrong dependency

when remembered chat choices have loaded successfully with `last_used: null`
and the model catalog is unavailable, a reader question can enter recall waiting
instead of showing catalog recovery. retrying memory cannot supply the missing
catalog default.

evidence: `apps/web/src/app/(authenticated)/media/[id]/useSelectionComposer.ts`
resolves `memory.fresh(catalog)` before its catalog failure branch in `sendChat`;
its recall effect waits for that same selection or a memory read error.
`apps/web/src/lib/chat/selectionMemory.tsx` needs the catalog only when there is
no remembered selection. this ordering was introduced by main `f50007bce`.

reproduce with no remembered selection, a successful memory read and a failed
catalog read; send a question from a selected passage. resolve by classifying
the actual missing dependency at the reader composer owner. verify catalog
retry restores the original question and selection without sending it twice.
catalog/model admission is outside the quiet-feedback cutover.
