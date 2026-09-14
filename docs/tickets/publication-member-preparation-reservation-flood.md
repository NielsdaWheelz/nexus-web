# every prepared member takes the media row lock and enqueues its own durable job

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: publication preparation / storage cleanup

## what is wrong

`python/nexus/services/reader_publication_artifacts.py:184` reserves one
`StorageObjectCleanupJob` per member: each reservation locks the media row and
enqueues its own durable job. a publication with hundreds of members therefore
takes the media lock hundreds of times and floods the durable queue for a single
preparation attempt.

the fence itself is now correct (a reservation is due only after the attempt
could still commit, a committed artifact row resolves it to `Retained`, and
`media_teardown` takes `max(writeMayLandUntil, retainUntil)` over both keys of
every armed writer), so this is a cost defect, not a correctness one.

## prerequisites

a reservation is keyed on `(owner, storagePath)` throughout the cleanup system,
and `media_teardown._prepare` reads a single scalar `payload["storagePath"]` from
each armed writer to extend its deletion set. an attempt-scoped or prefix-scoped
reservation therefore cannot be introduced without changing
`python/nexus/tasks/media_teardown.py` in the same change.

dropping the reservation in favour of `storage_orphan_sweep` is not acceptable:
its minimum age is 86400 s, and more importantly the reservation is how a
concurrent media teardown learns about in-flight preparation bytes at all.

## proposed fix

give the preparation attempt one reservation covering its member prefix, and
teach `media_teardown._prepare` to expand a prefix reservation into the paths it
covers, so the fence is unchanged and the row lock is taken once per attempt.

## acceptance

preparing a publication with N members takes the media lock once and enqueues one
cleanup job; a concurrent media teardown still refuses to delete member bytes a
live preparation is entitled to publish.
