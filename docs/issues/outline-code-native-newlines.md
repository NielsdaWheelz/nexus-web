# code presentation loses newlines during native editing

on candidate `99feec0d2`, the samsung/gboard same-host control enters return,
then immediately x and space. `control 1\nX ` becomes `control 1 X ` in both
the editor and canonical rich body. this changes authored code, not merely
its normalized search projection. both character input events reached the
same editor element; no focus change or composition occurred.

`NoteEditor.tsx:568` inserts a literal newline for code presentation.
`node/authored/src/body.ts:56` leaves the body node's whitespace policy normal;
its outer `pre` parse rule preserves whitespace, but installed
`prosemirror-view/src/domchange.ts:45` selects incremental preservation from
the node type's `whitespace`, using the mode that converts newlines to spaces.

repair the schema/parser contract that owns incremental whitespace. resolution
requires actual native return followed by typing to retain the exact newline
and characters in the canonical rich body, with ordinary prose and paste
behavior preserved. the separate fast-return missing-letter issue remains
unresolved; this control stopped before that phase.
