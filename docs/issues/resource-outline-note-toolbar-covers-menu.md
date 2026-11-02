# annotation selection toolbar can cover the row menu

`NoteEditor.module.css` places `.toolbar` at `right: 0`, above the editor,
with `z-index: 35`. companion density's full-width annotation shell puts that
toolbar over `ResourceOutline.module.css`'s absolute `.actions` column.

impact: selecting annotation text can obscure `⋯`. select text in an annotation
under a short quote and inspect both controls. no toolbar placement repair is
included in the density change.

resolved when: selection formatting and row actions remain reachable together
without restoring a full-height reserved action column.
