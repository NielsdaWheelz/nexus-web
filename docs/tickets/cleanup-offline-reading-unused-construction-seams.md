# offline reading store exposes unused construction modes

status: open
origin: 2026-09-21 cleanup audit, main 93563d12b62af0b4f8d84c73269f051cec6555ff
area: offline-android / reading store

`apps/android/app/src/main/java/app/nexus/android/offline/reading/OfflineReadingStore.kt:91-114`
accepts configurable database, seal, ids, clock, verifiers, storage root,
durability, scheduler, origin factory, executor and startup reconciliation.
the sole construction at line 1953 passes only context. repository search
finds no override consumer. `reconcileOnInit` alone creates two initialization
modes at lines 122-133 although production always reconciles.

prerequisites: include this in the planned offline-android rewrite, preserving
all account transitions, durable progress and package publication semantics.
make the store own its fixed production dependencies and startup path. keep
interfaces only where they hide a currently used capability boundary; remove
configurability whose only callers disappeared with the test reset.

acceptance: no unused constructor override or reconciliation mode; manually
restart with an installed package and pending reading progress, reopen offline,
then reconnect and confirm progress sync. account switching still purges prior
account access. pass `./scripts/test`; record that its static checks do not
compile android.
