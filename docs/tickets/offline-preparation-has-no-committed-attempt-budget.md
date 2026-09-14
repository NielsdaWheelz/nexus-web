# archive preparation has no committed per-attempt budget

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: offline delivery / job budgets

## what is wrong

the dead deadline/cancellation plumbing is gone from
`python/nexus/services/offline_reading_delivery.py` — `deadline_monotonic`,
`cancelled`, the local `checkpoint` closure, `OfflineReadingAssemblyTimeout` and
the whole `checkpoint` parameter chain through
`stage_reader_publication_members`, `assemble_offline_reading_zip_from_files`,
`verify_offline_reading_package_files` and `_write_zip_from_files`. the process
executor's wall timeout and the task's claim-lost check are now the only
cancellation owners, which is correct.

what that exposed is the real gap: there is no **preparation-specific** attempt
bound. the job's `wall_timeout_seconds` is not derived from any committed
preparation budget, so a pathological source is bounded only by a generic
timeout.

## prerequisites

the number is a qualification output, not a guess — it belongs with the other
reader-publication limits and needs the archive-preparation capacity run.

## proposed fix

add a per-attempt preparation budget to the reader-publication limits profile in
`python/nexus/config.py`, and have the job definition in
`python/nexus/jobs/registry.py` derive `wall_timeout_seconds` from it.

## acceptance

the preparation job's wall timeout is derived from a committed, qualified budget,
and a preparation that exceeds it fails as a typed preparation timeout rather
than a generic executor kill.
