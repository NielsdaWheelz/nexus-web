# daily handoff raw and canonical text coordinates diverge

status: deferred · origin: 2026-10-04 independent source review · area: notes / daily input

completed daily input supplies raw utf-16 selection offsets, including the current merge prefix. the editor maps those offsets through the canonical note projection, whose text trims whitespace. a raw/canonical offset disagreement can move the handoff caret. for raw `"  ab"` with cursor offset `2`, the current source mapping produces prosemirror position `5` instead of raw position `3`.

source-qualified evidence at `464098c1144d18a5a074f0a113268abb84d3cbbd`: `NoteBodyEditor.tsx:427` consumes the handoff offsets and `:1104` maps them through the canonical projection; `lib/notes/prosemirror/noteBodyProjection.ts:76` trims projected text. `lib/resourceSurface/useResourceSurfaceSession.ts:817` adds the current body-text prefix to incoming offsets before publication. no mounted daily failure is claimed. the note editor owner remains `2ce5bca0cc1fd67386a6a027eb2bdf2133fed134504d626ad53a256822662457`.

blocker: the daily input/merge owner must define whether offsets name raw buffered text, the merged raw body or canonical projected text. an editor-only whitespace adjustment cannot establish that contract.

resolved when: define and apply one coordinate contract through daily buffering, prefix merge and completed editor handoff; prove leading/trailing whitespace and an astral character place the native caret at the intended raw text boundary without losing accepted text. preserve composing-versus-completed claim behavior.
