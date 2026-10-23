# downloaded state corruption silently removes copies

`apps/android/app/src/main/java/app/nexus/android/offline/OfflineStore.kt:106`
catches malformed stored json or invalid ids/policies and calls `wipe()`. this
can remove an existing account namespace and its downloaded copies without an
explicit sign-out. offline startup preserves valid existing namespaces, but
this older corruption path remains destructive.

replace the wipe with an explicit unreadable-downloads state which preserves
the file and copies for owner repair. resolved when a malformed existing
`files/offline/state.json` produces a visible failure, retains the bytes/copies,
and cannot bind another account until explicit sign-out or owner repair.
