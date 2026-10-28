# arranging selected block ranges

the flat editor supports selecting a visible range and unlinking/copying that
range, but indent, outdent and movement still accept one occurrence.
`apps/web/src/lib/notes/outlineController.ts:928` rejects
`this.selected.size > 1` in `arrangementPlan`; the command bar and keyboard
arrangement paths use that same owner. this is a functional gap, not merely an
unperformed test.

full range arrangement needs explicit semantics for selected ancestor/descendant pairs and
multiple parents, then one atomic graph command with one undo group. do not claim
roam block-selection parity until this is implemented and qualified.

resolved when keyboard and touch act on exactly the same selected occurrences,
preserve their order/independent links, and undo restores structure and selection.
