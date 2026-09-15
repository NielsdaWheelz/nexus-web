# merge updated main and extend #254 cleanup

incoming main: `d1b9bf49b33d29cef6e4c3c1c6403eef450d77c1`.
restoration before merge: `aa3747c088d6e8663bd9aa1df6cb497590f5ca49`.

## decision

merge main into the existing inverse-merge restoration. the product source
remains `98a8b63bf0e72da5cb7e82ba2a9098716de58c84` plus reviewed fixes.
#254 owns ci/tests: one direct devbox command, fixed static checks, deterministic
units, and a structural migration-head check. no deleted #254 path survives.

the static command explicitly adds the restored codex application. python/web
locks are regenerated from reconciled manifests without upgrading product
dependencies. retain the production-consumed android player-protocol corpus,
reader/chat vectors, source identity, and runtime schemas; those are not test
controller state. deployed state remains untouched.

## conflict resolutions

| path | final resolution |
|---|---|
| `.github/actions/setup-test/action.yml` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `.github/workflows/backend-images.yml` | preserve restored source/migration/health/recovery boundaries with #254 publisher schema2 and strict legacy manifest ingress |
| `.github/workflows/ci.yml` | take #254 direct-check content |
| `.github/workflows/nightly.yml` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `.github/workflows/release.yml` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `README.md` | #254 direct-check contract and excluded-suite removal |
| `android-testing.md` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/android/app/build.gradle.kts` | #254 direct-check contract and excluded-suite removal |
| `apps/android/app/src/androidTest/java/app/nexus/android/playback/NativeActivityOutboxInstrumentedTest.kt` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/android/app/src/test/java/app/nexus/android/MainActivityRecoveryTest.kt` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/android/app/src/test/java/app/nexus/android/offline/OfflineMediaStoreContractTest.kt` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/android/app/src/test/java/app/nexus/android/playback/PlayerProtocolTest.kt` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/articleFixture.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/corpus.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/extension/capture.extension.spec.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/fixtures.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/journeys/auth-session.journey.spec.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/journeys/chat-regeneration.journey.spec.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/journeys/durable-consumption-activity.journey.spec.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/journeys/durable-ingest-reader-open.journey.spec.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/journeys/grounded-chat-citation.journey.spec.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/journeys/highlight-note-provenance.journey.spec.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/journeys/library-placement.journey.spec.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/journeys/mobile-reader-bottom-geometry.journey.spec.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/journeys/password-recovery.journey.spec.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/journeys/podcast-refresh-playback.journey.spec.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/journeys/reader-progress-resume.journey.spec.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/journeys/resource-action-parity.journey.spec.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/journeys/resource-share-boundary.journey.spec.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/playwright.config.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/e2e/runtime.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/package.json` | #254 direct-check contract and excluded-suite removal |
| `apps/web/src/app/(authenticated)/lectern/LecternPaneBody.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/app/(authenticated)/media/[id]/ReaderActivityAdapter.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/app/(authenticated)/notes/NotesPaneBody.pagesView.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.daily.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.episodesView.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/app/(authenticated)/stats/StatsPaneBody.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/components/PdfReader.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/components/auth/AuthSurfaces.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/components/chat/AssistantMessage.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/components/chat/ChatComposer.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/components/chat/conversationFindDom.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/components/collections/CollectionRow.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/components/dossier/DossierDocumentFrame.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/components/highlights/HighlightQuickNoteComposer.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/components/nexus/Nexus.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/components/nexus/desktop/DesktopNexusSelection.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/components/reader/MobileReaderPositionRibbon.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/components/reader/ReaderDocumentMapOverviewRail.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/components/resources/ContextualActionMenu.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/components/resources/ResourceActionMenu.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/components/workspace/PaneShell.mobileViewport.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/lib/actions/documentUploadFixture.ts` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/lib/reader/canonicalTextFindPresentation.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/lib/reader/usePendingDocumentMapPulse.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/lib/reader/useReaderTarget.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/src/lib/workspace/store.browser.test.tsx` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `apps/web/vitest.config.ts` | #254 direct-check contract and excluded-suite removal |
| `deploy/hetzner/fetch-release-bundle.sh` | preserve restored source/migration/health/recovery boundaries with #254 publisher schema2 and strict legacy manifest ingress |
| `deployment.md` | preserve restored source/migration/health/recovery boundaries with #254 publisher schema2 and strict legacy manifest ingress |
| `docs/architecture.md` | reconcile #254 testing documentation with restored product architecture |
| `docs/local-rules/testing-standards.md` | take #254 direct-check content |
| `docs/modules/chat.md` | reconcile #254 testing documentation with restored product architecture |
| `docs/modules/highlight.md` | reconcile #254 testing documentation with restored product architecture |
| `docs/modules/reader-implementation.md` | reconcile #254 testing documentation with restored product architecture |
| `docs/outstanding-issues.md` | reconcile #254 testing documentation with restored product architecture |
| `docs/tickets/devbox-buildkit-cache-retention.md` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `python/tests/kernel/test_auth_config_verifier.py` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `python/tests/kernel/test_backend_artifact.py` | #254 direct-check contract and excluded-suite removal |
| `python/tests/kernel/test_ci_pr_recovery.py` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `python/tests/kernel/test_oracle_host_release.py` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `python/tests/kernel/test_production_delivery_contract.py` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `python/tests/kernel/test_production_deploy_behavior.py` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `python/tests/kernel/test_production_release.py` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `python/tests/kernel/test_release_bundle_fetch.py` | honor #254 deletion; excluded suite, controller, support, or superseded ticket |
| `python/tests/kernel/test_worker_runtime_health.py` | take #254 direct-check content |
| `python/uv.lock` | #254 direct-check contract and excluded-suite removal |
| `scripts/agency_setup.sh` | take #254 direct-check content |

## restored-only cleanup

the exact per-path allowlist records every exception. removal extends beyond
#254’s bridge-era tree to the restored equivalents:

- nineteen python controller modules and their kernel meta-tests;
- service, populated migration, release artifact, hosted/eval, external-suite,
  process fixture, source-audit/fault, and release-simulation apparatus;
- all browser/e2e sources and browser-only helpers/dependencies;
- android host/device/shared test sources and Gradle test configuration;
- isolated test compose and obsolete planner/receipt/sensitivity data;
- dormant tooling tickets whose owning machinery no longer exists.

retain 38 deterministic python unit files and 125 node unit files. mixed files
keep their pure schema/config/codec units and drop process certification or
test-harness dependencies. #254’s db0215 GenerationRequest unit is obsolete in
the restored shared-agent architecture and is removed rather than reviving that
legacy product contract. no service/browser checks are hidden in unit fixtures.

## generated assets

the offline reader build regenerates its source/asset hashes and js/css/index
outputs. five source inputs were already stale at the pre-merge restoration
head: PdfReader.tsx, SelectionActionDock.tsx, ActionMenu.tsx, ActionMenu.module.css,
and useInitialFocus.ts. the new source manifest also reflects the reconciled
package and lock files. js changes from 416,216 to 417,380 bytes; css from
329,780 to 329,873 bytes. pdfjs and image assets remain unchanged. the existing
css-minifier warning ticket remains open. this is source asset generation on
the macbook, not a test verdict.

## deployment reconciliation and tradeoffs

- publish source-bound schema2 manifests; accept canonical schema1 only for
  installed-bundle compatibility. reject boolean/float schema versions.
- preserve codex capacity/apparmor assets and android contract corpus in the
  exact bundle file census. retain exact image digest retirement.
- preserve source identity, settings-before-quiescence, stopped writers, verified
  backups, migration ancestry/head, health, capacity qualification and production
  verification. after data mutation/backend activation recovery is forward-only.
- #254 removes successful-ci provenance from publication and removes release
  simulations. a green direct check is not image, migration, worker capacity,
  browser or device qualification. later release still requires those reviews.
- fix the reader-publication runbook reference to0219; close its ticket.
- keep unknown product concerns from historical browser/memory failures ticketed;
  removing their old suite does not establish product correctness.

## retired tickets

the following test-machinery tickets are superseded by #254. the quick-note
creation ticket is instead resolved by retained product commit `98d9f08f`; the
runbook revision ticket is resolved by this semantic merge. history remains in
git. no production concern is closed merely because its suite was removed.

- `appnav-glob-selects-the-whole-import-reliability-risk`
- `ci-gate-time-budget`
- `coherent-fault-owner-digest-omits-imported-support`
- `complete-python-static-omits-changed-owner-checks`
- `controller-base-provisioning-port-allocation`
- `devbox-buildkit-cache-retention`
- `fault-registry-rejects-literal-route-brackets`
- `gate-capacity-pause-owner-exact-node`
- `gate-chat-owner-isolation-marker-guard`
- `host-oracle-fixture-ownership-blocks-confidence`
- `native-docker-vm-storage-admission-unavailable`
- `offline-bundle-gate-is-not-selected-by-its-own-sources`
- `pr-sensitivity-cannot-accept-new-vitest-owners`
- `test-controller-interrupt-discards-completed-capabilities`
- `three-changed-python-owners-lack-a-coherent-fault-witness`
- `zero-context-fault-patches-can-reverse-onto-another-occurrence`
- `test-host-release-worker-owner-privilege`
- `oracle-host-replay-received-unowned-sigterm`
- `highlight-quick-note-create-failure-crashes-editor`

## runner toolchain

the running devbox github runner resolves bun1.3.10; restored build source pins
bun1.3.14. ci installs the version file through the existing immutable
`oven-sh/setup-bun` action pin before locked dependencies. this small bootstrap
retains #254's direct check and five-minute job; it restores no test controller.
the action updates the persistent runner-home `.bun/bin/bun` installation and
adds it to that job's path; it is not an ephemeral binary. authoritative manual
validation uses the already isolated, pinned restoration tool environment.

## final source-audit corrections

remove the restored-only `scripts/ci-proof-artifact.sh`: its run claims and
summary enforcement are unused by #254 and must not survive as dormant receipt
machinery. the client-defect route unit replaces its loopback http server with
a narrow fake fetch boundary, preserving actual route/proxy assertions without
a listener or service fixture.

remove the orphaned resource-action AST policy script, ingest network/process
suite, and unused pdf/epub/consumption fixture corpora. retain the existing pure
ingest article-extraction unit in the fixed direct check, adding only its locked
product dependency installation and one explicit node command. this adds no mode
or second gate. normal imports replace remaining sensitivity-era unit owner
lookup. production manual smoke operations remain source-identical and are not
executed by this pr.

## recorded predecessor compatibility

current main's installed db0215 bundle has six files and its web version route
returns only source_sha. the restored controller previously demanded nine files
and a player protocol from every release, preventing preflight of the actual
incumbent. the owning bundle boundary now accepts exactly six files only for
the recorded current db0215 publication, matching manifest hash, source, both
image digests and oracle identity. only that validated legacy shape receives the
source-only web contract. new candidates still require all nine files.

this narrow compatibility does not accept arbitrary historical bundles. source,
schema, worker/api health, images, config, infrastructure, capacity, backups and
forward-only recovery remain checked. nine pure unit cases exercise admission
and identity rejection without restoring a host/release simulation harness.

unused journey-only oracle declarations are removed while active pure vectors
remain. four authentication unit suites freeze the expiry clock in existing
hooks; no timer or service framework is introduced. stateless server-render
units remain deterministic node tests and start no browser.
