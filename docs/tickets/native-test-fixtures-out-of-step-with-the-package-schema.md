# three native test fixtures no longer match the package schema they construct

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: native offline reading proofs

## what is wrong

the conversion-failure columns and the artwork source union changed under three
JVM fixtures. each is mechanical, and each one blocks its whole test class. no
Kotlin toolchain was available to this review, so these are eyeball-exact and
unverified by a compiler.

- `apps/android/app/src/test/java/app/nexus/android/offline/reading/InstalledLegacyReadingFixture.kt:42`
  — the positional INSERT into `offline_reader_packages` now needs two more
  columns:
  `"INSERT INTO offline_reader_packages VALUES(?, ?, ?, 'WebArticle', 'Original copy', 7, ?, 1, 1, 1, ?, ?, NULL, 0, NULL)"`.
  the argument array is unchanged. without it every test using this fixture dies
  at construction (`OfflineReadingLegacyActivationTest`,
  `OfflineReadingLegacyPurgeTest`, `OfflineReadingStoreLifecycleTest`'s
  "conversion checks available disk space before staging", and others).
- `apps/android/app/src/test/java/app/nexus/android/offline/reading/OfflineReadingDatabaseTest.kt:53`
  — the upgrade comparison must become
  `row(db, it).filterKeys { key -> key !in setOf("table_index_sha256", "conversion_failures", "conversion_failure") }`,
  because the rebuilt v3 packages table carries two conversion columns the v1
  snapshot does not. nothing else in that test changes.
- `apps/android/app/src/test/java/app/nexus/android/playback/NexusArtworkTest.kt:70,107,145,149`
  — `NativeArtworkSource.PreviewProxy(x)` becomes `artworkSourceFromProxyPath(x)`
  (same argument, same behaviour, same `require` messages). there is no
  `NativeArtworkSource.Remote` case any more; a direct-fetch vector in that test
  should be deleted, since the direct lane is gone.

## prerequisites

none.

## proposed fix

apply the three edits above.

## acceptance

the native JVM test classes compile and run; the v1 → v3 upgrade test still
compares every pre-existing column.
