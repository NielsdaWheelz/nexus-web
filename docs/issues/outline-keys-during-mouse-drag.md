# keys pressed during a mouse drag edit the caret's row and cancel the drag

priority: deferred rare interaction. ordinary typing undo is the recovery; investigate if encountered during use or when drag keyboard handling changes.

problem: an admitted mouse press on a bullet prevents its mousedown default, so
focus stays in the editor through the drag (`OutlineDrag.tsx`; this is what keeps
a chord after a drop working). keys pressed while the button is still down
therefore go to the caret's row: printable keys edit its text, and the drag's
mutation observer on `.ProseMirror` then sees the change and cancels the drag
with no write. escape and alt are consumed by the drag first; nothing else is.

impact: typing during a drag quietly edits a row the reader is not looking at and
abandons the drag. unlikely with a mouse in hand; nothing is lost, since the edit
is ordinary text with its own undo.

evidence: source reading (the admitted-press `preventDefault`, the observer, the
document-capture `modifier` listener that handles only escape and alt); named by
the drag fixes' own review. not cased.

resolved when either the drag consumes non-modifier keydowns while live, so the
row's text is unchanged and the drag survives, or a case pins the present
behaviour as intended and the outline's module doc says so.
