# newer native reading intent conflicts with its own earlier acknowledgment

status: open
origin: 2026-09-13 bounded-workspace independent native review
area: native reader cursor synchronization

`OfflineReadingStore.kt:1257-1263` discards the entire acknowledgment when
`candidateIsCurrent` detects a newer locator. if A(base7) is in flight, the
reader records B(base7), and A succeeds at revision8, B survives but keeps base7.
the next fetch in `OfflineReaderProgressSync.kt` reports a conflict against A.
this is source-established unnecessary conflict, not observed data loss.

prerequisite: define whether the cursor owner automatically advances a newer
same-source intent across its own successful write. if yes, atomically retain B,
advance only its matching base7 to the attested revision8, and update the
observed baseline without accepting older generations, bindings, or revisions.

acceptance: actual native store/origin proof exercises A→B during the remote
write; B is never deleted, unrelated remote edits still conflict, and replayed
or stale acknowledgments cannot regress either baseline or pending intent.
