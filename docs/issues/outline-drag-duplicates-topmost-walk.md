# the drag keeps its own copy of the topmost-selection walk

priority: deferred maintenance; leave alone until selection or drag ownership changes. no present behavior defect is established.

problem: `OutlineController.roots()` consolidated the topmost selected occurrences
for fold and clipboard; `OutlineDrag.tsx`'s `liftedRows` still walks ancestors
itself to find the same roots.

impact: none today. two definitions of "topmost" can drift, and the drag would
lift a different set than a chord moves.

evidence: the clipboard, zoom and return review (finding 16), by source reading.

resolved when the drag reads the controller's roots for a selected press, with
the drag cases still green.
