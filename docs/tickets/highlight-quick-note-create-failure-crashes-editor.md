# highlight creation failure crashes the quick-note editor

- status: open
- origin: 2026-09-14 annotation focus/submit review; sha `7fa89b88c8`
- area: reader annotation failure handling

`apps/web/src/components/highlights/HighlightQuickNoteComposer.tsx:89` throws
`Error("Highlight was not created")` when the pending highlight creation resolves
`null`. `HighlightNoteEditor.tsx:38` rejects non-api errors; lines 252–256 store
this error as a defect and line 350 throws it during render. an expected creation
failure therefore replaces the editor instead of retaining the visible, copyable
draft required by `docs/cutovers/highlight-quick-note-composer-hard-cutover.md`
acceptance criterion 7. this is a code-path finding, not a browser reproduction.

prerequisites: distinguish an expected failed creation from an unexpected
creation defect without weakening api error classification.

proposed fix: model the failed creation at the composer/editor boundary and keep
its draft visible with explicit failure feedback. preserve the original creation
error and existing note mutation path.

acceptance: resolve pending creation to `null` after typing and submitting a note;
the composer remains usable with the exact text and failure feedback, no note
write occurs, and unexpected creation errors still reach the defect boundary.
prove through `./scripts/test`.
