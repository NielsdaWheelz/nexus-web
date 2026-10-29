# moving selected ranges up or down

indent/outdent and removal share the range planner. move-up/down still accepts
one occurrence; a range receives “select one item to move.” the owner explicitly
excluded bulk movement from range editing.

evidence: `OutlineController.movePlan` and `commandState` in
`apps/web/src/lib/notes/outlineController.ts` retain the single-item boundary.
this is a deliberate capability limit, not a range-indent defect.

resolve only with an approved movement contract for mixed parents, selected
ancestors/descendants and shared edges. keyboard and existing controls must use
one atomic plan; undo must restore literal order and the captured selection.
