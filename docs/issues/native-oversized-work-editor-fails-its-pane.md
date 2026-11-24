# keep oversized installed writing in its row

the installed authored store rejects a single state larger than its 16 mib
transfer ceiling in `AuthoredStore.packRecords`. at `e4401016f` that rejection
gets generic `E_AUTHORED` from `AuthoredBridge`. pending work opens its editor
through `WritingRuntime.loadDocument` and `readSnapshot`, then hands the error
to `AuthoredReadFailure`. that component rethrows codes outside the recognized
storage failures. one large existing note can therefore replace the journal
pane, even when its work rank and label fit.

this is a source finding. individually admissible changes can grow a canonical
note beyond one native transfer in firefox or on the server. the android
commit, replication apply, and provisioning stage also carry the merged state
and projection through the native transfer ceiling. normal admission of a
single oversized canonical state on android remains unverified.

retained work now reads a bounded work projection with its label and work
actions for the selected day. editor loading still reads the canonical state
independently. if normal admission produces a state the editor cannot read,
verify that the row keeps its order and extent, reports the size limit in place,
and leaves its other eligible actions available without retrying the same read.
