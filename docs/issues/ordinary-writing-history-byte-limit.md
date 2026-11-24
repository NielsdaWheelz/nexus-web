# large text edits can exceed the authored command limit after publication

the body and title bindings update their displayed baselines and live yjs documents before the runtime measures the durable command. undo also applies its retained yjs item before that measurement. a single large edit, or the inverse of several individually valid edits grouped within 500 ms, can exceed 2 mib and leave local writing blocked on an immutable command that cannot fit. a page work marker consumes part of the same limit.

see `InlineBinding.apply` and `handoff` in `apps/web/src/lib/notes/editorBinding.ts`, `OutlineBinding.apply` in `outlineBinding.ts`, `BoundPageTitleEditor.tsx`, `OutlineHistory.editor` in `structure.ts`, and `WritingRuntime.prepareAndPersist` in `runtime.ts`.

reproduce on an ordinary block by making two large deletions inside one capture interval, each individually small on the wire, then undoing the group. also try a single input whose body delta fits without the page marker and exceeds the limit with it.

close when the editor can budget or split an ordinary edit and its actual undo/redo group before changing durable-bound writing, including title, native composition and shared-document occurrences. show that the largest admitted group survives undo and redo, and refusal preserves text, selection, history and source sequence.
