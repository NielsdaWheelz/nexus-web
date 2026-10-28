# arranging selected block ranges

the mobile editor supports selecting a visible range and unlinking/copying that
range, but arrangement still accepts one occurrence. `LocalOutline.tsx` disables
indent, outdent and move buttons for `owner.state.keys.length > 1`; the row
keyboard handler consumes and refuses those same range commands.

full range arrangement needs explicit semantics for selected ancestor/descendant pairs and
multiple parents, then one atomic graph command with one undo group. do not claim
roam block-selection parity until this is implemented and qualified.

resolved when keyboard and touch act on exactly the same selected occurrences,
preserve their order/independent links, and undo restores structure and selection.
