# large text edits can exceed the authored command limit after publication

the body and title bindings update their displayed baselines and live yjs documents before the runtime measures the durable command. undo also applies its retained yjs item before that measurement. a single large edit, or the inverse of several individually valid edits grouped within 500 ms, can exceed 2 mib and leave local writing blocked on an immutable command that cannot fit. a page work marker consumes part of the same limit.

see `InlineBinding.apply` and `handoff` in `apps/web/src/lib/notes/editorBinding.ts`, `OutlineBinding.apply` in `outlineBinding.ts`, `BoundPageTitleEditor.tsx`, `OutlineHistory.editor` in `structure.ts`, and `WritingRuntime.prepareAndPersist` in `runtime.ts`.

reproduce on an ordinary block by making two large deletions inside one capture interval, each individually small on the wire, then undoing the group. also try a single input whose body delta fits without the page marker and exceeds the limit with it.

ordinary return inside a descendant paragraph also publishes a split before measuring it. `OutlineController.keys` checks retained document count and bytes, then `OutlinePendingInput.split` binds the successor and moves focus immediately. `OutlineHistory.birth` only later resolves the predecessor’s pending move, the newborn’s actual parent and its insertion keys. the separate `splitCharge` check runs for annotation-child splits. calling it on the original placement would price the wrong graph when a move is pending.

reproduce by building a paragraph with individually valid writes, then splitting off a suffix over 1.6 mib of ascii. its base64 initializer alone exceeds 2 mib. near the limit the marker can be decisive. also split while the predecessor’s move is pending and type immediately in the successor.

close when the editor can budget or split an ordinary edit and its actual undo/redo group before changing durable-bound writing, including title, native composition and shared-document occurrences. for descendant splits, prove all three directions against the actual newborn and resolved placement and preserve the destination of subsequent input. show that the largest admitted group survives undo and redo, and refusal preserves text, selection, history and source sequence.
