# The packaged offline reader bundle drifted from its sources for five phases

**Status:** open
**Origin:** Imports workspace cutover, Phase 7 chain Z review, 2026-09-10
**Area:** `apps/android/app/src/main/assets/nexus-offline/**`,
`apps/web/scripts/build-offline-reading.mjs`

## What is wrong

`apps/web/src/offline-reading/main.tsx` imports `@/app/globals.css`, the reader
apparatus sheets and a long tail of shared components, so ~120 web source files
are declared inputs of the packaged Android bundle and are pinned by
`nexus-offline/source-manifest.sha256`. Any edit to one of them makes the
committed bundle stale, and both `bun run build:offline-reading --check` and
Gradle's `verifyOfflineReadingAssets` (a `preBuild` and `check` dependency) then
fail. `docs/cutovers/elvish-theme-the-solar/blueprint.md:143` already records the
trap and the remedy.

The cutover branch never applied that remedy. At its base `origin/main`
`4d457ab1` the manifest was clean; by `26b8161b` five declared inputs no longer
matched it, and no phase regenerated the bundle:

| Input | Went stale in |
|---|---|
| `apps/web/src/lib/validation.ts` | `6b1f771c` (phase 2a) |
| `apps/web/src/components/PdfReader.tsx` | `8df0943a` (phase 2c) |
| `apps/web/src/lib/media/mediaErrorMessage.ts` | `8df0943a`, again `26b8161b` |
| `apps/web/src/lib/panes/paneRouteModel.ts` | `ac9dfee5` (phase 3) |
| `apps/web/src/lib/panes/paneRouteTable.ts` | `ac9dfee5` (phase 3) |

Phase 7 chain Z added a sixth (`apps/web/src/app/globals.css`, the `--*-ink`
tokens) and regenerated the bundle, which cleared all six at once. So the debt is
paid, but it was paid blind. The regenerated `index-*.js` / `index-*.css` carry
five phases of source change that no phase built, ran or reviewed inside the
offline shelf, and the regeneration also grew the declared input set from 119
lines to 126 — the shelf's module graph now reaches seven modules it did not
before:

```
apps/web/src/lib/actions/resourceActions.ts
apps/web/src/lib/imports/importRef.ts
apps/web/src/lib/imports/importsClient.ts
apps/web/src/lib/lectern/contract.ts
apps/web/src/lib/media/documentReadiness.ts
apps/web/src/lib/media/ingestionClient.ts
apps/web/src/lib/status/imports.ts
```

Nothing was dropped. So the packaged shelf now ships imports-cutover code, and
the one proof that would exercise it —
`gradle:apps/android/app/src/test/java/app/nexus/android/offline/readingweb/OfflineReadingRequestRouterTest.kt`
— has not run against the regenerated bundle.

## Evidence

- Freshness computed directly against the manifest: 0 stale inputs at
  `4d457ab1`, 5 at `26b8161b`, 6 in the working tree before regeneration.
- `bash <scratchpad>/runner/t.sh bash -lc 'cd apps/web && node scripts/build-offline-reading.mjs --check'`
  → `Error: Offline reader source manifest is stale: apps/web/src/app/globals.css`
  (exit 1) before the regeneration; the same command exits 0 after it.
- `apps/android/app/build.gradle.kts:266-320` runs the identical two checks (asset
  closure + digests, then every source-manifest digest) and gates `preBuild` and
  `check` on them.
- The regeneration changed only `index.html`, the two content-hashed bundles and
  the two manifests; `pdfjs/**` came back byte-identical (207 files before and
  after).
- `bun run build:offline-reading` cannot complete inside the imports runner
  container: `fs.cpSync(recursive)` returns EACCES writing into the
  virtiofs-mounted worktree (reproduced with a two-line probe; the same copy into
  the container's ext4 `/tmp` succeeds). Chain Z2 ran it with `--require` of a
  `cpSync` replacement built from `mkdirSync` + `copyFileSync`, then verified the
  result with the unpatched `--check`.

## Prerequisites

An Android toolchain. The imports runner container has a JDK and `gradlew` but no
Android SDK (`ANDROID_HOME` unset), so the `android-host` capability is not
available there.

## Proposed fix

Run `gradle:.../OfflineReadingRequestRouterTest.kt` (and the offline-reading
journey, if one exists for the shelf) against the regenerated bundle before this
cutover merges, so the five phases of absorbed source change are exercised in the
packaged shelf rather than only hashed. The recurrence is a separate ticket:
`docs/tickets/offline-bundle-gate-is-not-selected-by-its-own-sources.md` (OI-052).

## Acceptance

The Android offline-reading proof passes on the regenerated bundle, recorded with
command and SHA.

## 2026-09-14 — it has happened again, on the bounded-workspace branch

`apps/android/app/src/main/assets/nexus-offline/source-manifest.sha256` is stale
again: the shipped shelf still contains the schema-1 `reader.json` reader while
the branch hard-cut schema-1 out of every other path. regenerating with `bun run
build:offline-reading` also pulls roughly ten newly shared modules into the
bundle graph (`publicationDom`, `useDocumentReaderWindow`, `publicationContract`,
`resourceCache`, `useResource`, `readerCapacity`, `readBoundedResponseBytes`,
`epubHref`, `codepoints`, `ReaderContentsPage`), none of which any
`immutable-production-release` source glob matches — exactly the hole OI-052
describes. regenerate and commit both manifests with the rebuilt assets, run the
gradle proof against the regenerated bundle, and land the glob generation from
OI-052 in the same change so the third occurrence is impossible rather than
merely unlikely.
