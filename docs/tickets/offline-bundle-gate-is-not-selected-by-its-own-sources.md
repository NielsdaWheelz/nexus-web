# The offline-bundle staleness gate is unreachable from the sources it guards

**Status:** open
**Origin:** Imports workspace cutover, Phase 7 chain Z review, 2026-09-10
**Area:** `testdata/proofs.json` (`immutable-production-release`)

## What is wrong

`nexus-offline/source-manifest.sha256` pins ~120 web source files as inputs of
the packaged Android reader bundle, and Gradle's `verifyOfflineReadingAssets`
fails the build when any of them changes without a regeneration. The only risk in
the registry whose proofs reach that gate is `immutable-production-release`, via
`gradle:apps/android/app/src/test/java/app/nexus/android/offline/readingweb/OfflineReadingRequestRouterTest.kt`.

Its `source_globs` name the bundle's *own* files —
`apps/web/src/offline-reading/**/*`, `apps/web/src/lib/offlineReading/**/*`,
`apps/web/scripts/build-offline-reading.mjs`,
`apps/android/app/src/main/assets/nexus-offline/**/*`,
`apps/android/app/build.gradle.kts` — and none of the shared sources the manifest
also pins. Editing `apps/web/src/app/globals.css` selects exactly one risk,
`native-system-insets`, whose proofs are vitest suites. So a change that breaks
the gate can never select the gate, and `./scripts/test changed` reports green on
a tree whose Android build cannot start.

That is how the cutover shipped a stale bundle for five phases
(oi-051, now resolved by the [reader native proof](../cutovers/reader-document-map-verification.md#final-focused-acceptance)) with
every governed run passing — including the seven modules the cutover newly pulled
into the shelf's module graph, none of which is matched by a glob of that risk
either.

## Evidence

- `testdata/proofs.json` `immutable-production-release` `source_globs` (46
  entries) matched against the source manifest (119 lines at `26b8161b`, 126
  after chain Z2's regeneration): no shared web source is covered.
- Matching `apps/web/src/app/globals.css` against every risk's `source_globs`
  returns `native-system-insets` alone.
- testing-standards §8 ("Proof owners") and §3 (sensitivity): a gate that the
  change it guards cannot select is dead coverage.

## Prerequisites

None. Track F owns `testdata/proofs.json`.

## Proposed fix

Make the glob list follow the manifest rather than restate a fraction of it —
either generate the `immutable-production-release` source globs from
`nexus-offline/source-manifest.sha256` at registry-check time, or add the
concrete shared roots the manifest pins (`apps/web/src/app/globals.css`,
`apps/web/src/lib/reader/**`, `apps/web/src/lib/highlights/**`,
`apps/web/src/components/**` as the manifest lists them) and add a registry
kernel case asserting every manifest line is matched by some glob of that risk,
so a new declared input cannot silently escape the gate again.

## Acceptance

A kernel case fails when a path pinned by `source-manifest.sha256` is matched by
no `source_globs` entry of the risk that owns the offline-bundle proof.
