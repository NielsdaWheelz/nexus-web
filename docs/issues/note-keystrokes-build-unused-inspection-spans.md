# note keystrokes build unused inspection spans

status: open · origin: owner source audit, 2026-10-21 · area: note bodies and editor (`lib/notes/noteBody.ts`, `components/notes/NoteEditor.tsx`)

problem: every changed editor transaction converts both its old and new block with
`bodyFromNode`. that builds the full source-inspection span map although the caller
keeps only the projected text, and the span builder walks every source fragment for
every logical line.

evidence (source at `2e154f053`; no frame-time measurement):
- `apps/web/src/components/notes/NoteEditor.tsx:911-915,938-941`: `dispatchTransaction`
  converts `before` and `after` on each document change outside composition.
- `apps/web/src/lib/notes/noteBody.ts:193-199`: `bodyFromNode` keeps only
  `projectBody(block).text` (`:197`).
- `noteBody.ts:275-337` (`projectBody`): inside the per-line pass (`:307-335`) a loop over
  all sources (`:316`) allocates spans that this caller discards (`:321-328`).
- the spans' only consumer is `inspectionDecorations` (`:340`, reading them at `:353`),
  called from `NoteEditor.tsx:1338` when an inspection target is shown.

impact: a long note with many hard breaks and inline fragments does
lines × fragments intersection work twice per keystroke on the input path.

fix: keep the exact canonical whitespace and codepoint contract while making the text
projection linear, and build spans only when inspection asks. reuse the prior immutable
body instead of rebuilding `before` on every keystroke where editor and history
ownership permit.

resolved when a profiled long multiline note has input work proportional to its
changed content or one linear block pass, ordinary edits allocate no inspection spans,
and text projection and inspection offsets still agree with the python canonical
contract, including unicode and line-break edge cases.
