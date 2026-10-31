# rejected normalization coverage can retry silently

`Persistence.scopeNormalized` and android `AuthoredStore.scopeNormalized` return
false when final normalized rows fail `scope_normalized_coverage`. that is the
same return channel as expected stale-revision refusal. `Sync.scopeStep` discards
its normalizer and returns; `Sync.run` treats the turn as successful and schedules
another. the next turn resets the unfinished interval and starts over.

a persistent coverage defect can therefore loop with no reported sync error and
only successful network requests. no current input triggering this branch has
yet been established; it is not the diagnosed cause of the earlier slow
preparation. the later user-reported paired completion does not repair this
source-established failure-reporting hazard.
source: apps/web/src/lib/authored/persistence.ts:302–312,
apps/web/src/lib/authored/sync.ts:199–218, node/authored/src/scope.ts:130–135,
apps/android/app/src/main/java/app/nexus/android/authored/AuthoredStore.kt:286–298.

separate expected stale refusal from invalid final coverage at the persistence
owner; retain existing data and expose the actual invariant failure. resolve
with meaningful current/stale/failing-coverage behavior, without weakening the
coverage check, resetting unrelated completed readings or adding retry clocks.
