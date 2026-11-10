# tall-note caret visibility

explicit note focus reveals the occurrence's row start, then retains the
editor's existing end selection. for a body taller than the pane, that does not
establish that the end caret is visible. this is a source-inferred limitation,
not an observed new regression.

evidence: `apps/web/src/lib/notes/outlineController.ts` `focusNote` reveals the
stable row anchor; `tryFocus` selects the field's end. the current live capture
check uses a short note. `AnchorGeometry.position` describes occurrence starts.

resolve with a real tall rich-body entry check, then coordinate caret visibility
through the existing memento/editor owners. preserve selection, cancellation
and the single scroll owner; do not add a competing `scrollIntoView` call.
