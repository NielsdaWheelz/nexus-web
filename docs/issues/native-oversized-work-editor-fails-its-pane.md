# keep oversized installed writing in its row

the installed authored store rejects a single state larger than its 16 mib
transfer ceiling in `AuthoredStore.packRecords`. at `e4401016f` that rejection
gets generic `E_AUTHORED` from `AuthoredBridge`. pending work opens its editor
through `WritingRuntime.loadDocument` and `readSnapshot`, then hands the error
to `AuthoredReadFailure`. that component rethrows codes outside the recognized
storage failures. one large existing note can therefore replace the journal
pane, even when its work rank and label fit.

this is a source finding. reproduce on a paired webview with a sequence of
individually admissible edits that builds a single oversized pending note.
the work row should keep its order and extent, explain the size limit in place,
and offer its other admissible row actions. confirm a neighboring note still
opens and the editor stops requesting the same oversized state.
