# qualify external text replacement after the overlap repair

the historical prefix/suffix replacement defect is repaired in source.
`apps/web/src/components/notes/NoteEditor.tsx:1917` adjusts both replacement
ends for overlap; `lib/notes/editorBinding.ts` and `outlineBinding.ts` apply
the same correction. the [notes contract](../modules/notes.md) owns current
causal editing and history.

at `c0063b28e`, the replacement logic could turn “left right” → “left” into
“leftt”, or leave “helloo” after undo to “hello”. a split showed one transient
bad frame; undo and external-adoption loss were source/model findings, not
observed browser losses. source review at `636d3603e` already found the repair.

remaining qualification: actual external adoption, undo/redo and composition
preserve exactly “left right” → “left”, “aa” → “a” and “ab” → “abab”, without
saving a doubled character. verify both standalone and outline editing through
their current owners. close after that bounded check; no new editor is needed.
