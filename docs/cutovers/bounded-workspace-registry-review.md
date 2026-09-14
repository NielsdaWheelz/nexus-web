# Priority-risk ownership and routing review — X11a_proof_registry

> 2026-09-14 pause: historical document; implementation is stopped.
> the [evidence audit](bounded-workspace-evidence-audit.md) distinguishes findings,
> decisions and unverified claims. the [replacement plan](production-crash-replacement-plan.md)
> supersedes this execution scope and awaits user review.

Reviewed against base `7fa89b88c8` and the working tree of
`/home/niels/src/personal/nexus-web-bounded-workspace` on 2026-09-14.
Findings applied: G1-2, SPEC_coverage_global-2, T_python_tests-2, T_python_tests-3
(partial, see "Not mine"), F_android_tests-14.

## 1. Pins rewritten (both are review tokens, not conveniences)

| Pin | Was | Now |
|---|---|---|
| `PRIORITY_RISK_OWNERSHIP_SHA256` (model.py:167) | `825bad59…` (intermediate branch freeze, 2026-09-13 23:44) | `013f6f8be17832ad22c1a9aa776a7be69208fa8f99ac275ba7275e7f15477947` |
| `nexus-test-routing-sha256` (testing-standards.md:555) | `8e239589…` | `faa535199f2c1665e37a2f90aabd77da4461f57425537b5f73feb3393797a903` |

Chain integrity: the digest recomputed over `git show 7fa89b88c8:testdata/proofs.json`
is exactly `abc80697…`, the base commit's pin, so the frozen-floor mechanism is sound
at the last committed state. `825bad59…` was an **uncommitted intermediate** freeze;
its baseline file state is not recoverable from the tree, so this review audits the
whole branch delta (base → now) rather than the `825bad59…` delta. That is the
stronger reading, and it is the one the dossier should record: the stale
`progress.md:153` receipt ("policy now passes … reviewed floor is `825bad59…`")
must be replaced by this review.

Routing-contract delta (why `faa535199f…` differs from `8e239589…`): the only change
to `_TEST_ROUTING_CONTRACT` inputs since base is the new `api-capacity` capability —
three `qualification|api-capacity|…` lines, the `complete-proof|api-capacity|…` set
(`API_CAPACITY_COMPLETE_PROOFS`), and `Capability.API_CAPACITY` entering
`_FULL_NON_BROWSER` and `_CHANGED_AFFECTED`. No workflow scope, no deferral owner and
no existing capability requirement changed. `api-capacity` has **no**
`DEFERRED_CAPABILITY_OWNER` entry, so it is dispatched by `full`/`changed`, not deferred.

## 2. What this package changed in the ownership map

Registry hygiene (finding G1-2 / SPEC_coverage_global-2 leftovers):

- removed five source globs that matched no file: `citation-provenance-identity`'s
  `…/offline/reading/OfflineReadingTableGeometry.kt` and `…/OfflineReadingTableHeaders.kt`
  (both moved to `app/src/test`, i.e. qualification-only code, so they are no longer
  product owners), and `reader-progress-resume`'s `media/*/epubHelpers.ts`,
  `…/epubRestore.ts`, `…/useEpubPaneFind.ts`.
- **Decision on the two retained qualification proofs.**
  `gradle:…/OfflineReadingTableGeometryTest.kt` and `…/OfflineReadingTableHeadersTest.kt`
  stay registered under `citation-provenance-identity`. They no longer exercise product
  Kotlin — `OfflineReadingTableGeometry.kt`/`…Headers.kt` are test-local candidate
  implementations — but (a) `OfflineReadingTableHeadersTest` is a cross-language
  conformance consumer of `testdata/offline-reading/table-headers.json` +
  `table-header-geometry.json`, which the Python producer owns, and (b)
  `native-table-row-truncation` is a `coherent-fault` whose replay requires its owner to
  be the *registered canonical node* (policy.py:1959). Deregistering would silently break
  that fault. Their real inputs are now the two `testdata/offline-reading/table-*.json`
  globs added to the risk, so a corpus change re-routes them precisely.

Journey/risk globs for the publication index chain and account-bound progress route
(added to journey `reader-progress-resume` and to risks `reading-progress`,
`durable-consumption-activity`, `citation-provenance-identity`):
`python/nexus/api/routes/reader_publications.py`,
`apps/web/src/app/api/media/*/reader-publications/**/*`,
`apps/web/src/app/api/media/*/offline-reader-state/route.ts`.

New proof registrations by risk (all verified to exist; every exact pytest node verified
against the file's static nodes by `selection.proof_target`):

- `citation-provenance-identity`: `pytest:tests/kernel/test_x_quote_source_checkpoints.py`,
  `pytest:tests/kernel/test_reader_publication_index_page.py`,
  `pytest:tests/service/test_retained_reader_queries.py` (whole file — first registration of
  the member wire contract; globs now include `routes/reader_publications.py`),
  `pytest:tests/service/test_connection_note_projection.py::test_note_summary_label_matches_the_python_resolution_owner`,
  `pytest:tests/service/test_pdf_highlight_publication.py` (whole file beside the existing
  fault-bound exact node), `vitest:epubPathnameParity.unit.test.ts`,
  `vitest:readerTargetHash.unit.test.ts`, `vitest:canonicalTextFindCorpus.unit.test.ts`,
  `vitest:documentEmbeds.browser.test.tsx`, `vitest:MediaPaneBodyFigureAdmission.browser.test.tsx`,
  `vitest:MediaPaneBodyStanceChord.browser.test.tsx`, and gradle
  `OfflineReaderPublication{Embed,Epub,Identity}Test.kt`,
  `OfflineReadingLegacy{Source,String}Test.kt`.
- `reading-progress`: gradle `OfflineReadingProgressChoiceTest.kt`;
  vitest `readerWindowNavigation.browser.test.tsx`, `useReaderProgress.browser.test.tsx`,
  `OfflineReadingConnection.browser.test.tsx` (the three new-in-branch fault owners under
  `reader-window-navigation-completion`, `reader-unknown-source-lifecycle-invention`,
  `native-document-startup-open-loss`).
- `production-runtime-health`: `pytest:tests/service/test_image_decoder.py::test_a_child_killed_for_memory_is_the_owned_resource_envelope`,
  `pytest:tests/capacity/test_reader_raster_facts.py`, gradle `OfflineReadingRasterDecoderTest.kt`,
  vitest `publicationCapacity`, `readerCapacityNotices`, `ReaderContentBoundary`,
  `artwork`, `ArtworkCapacity`, `nexus/history.unit.test.ts`.
  Capability `api-capacity` added (required by the tests/capacity proof).
- `auth-privacy-secrets`: `pytest:tests/kernel/test_epub_svg_asset_sanitizer.py`,
  `pytest:tests/service/test_public_resource_sharing.py` (whole file beside the existing
  fault-bound exact node), `pytest:tests/service/test_workspace_session_account_binding.py::test_workspace_replay_rejects_another_account_before_changing_layout`
  (globs `routes/me.py`, `api/me/workspace-session/route.ts`), gradle `OfflineReadingSvgTest.kt`.
- `destructive-side-effects`: gradle `OfflineReadingInstalledAccessTest.kt`, glob
  `…/offline/reading/OfflineReadingStore.kt`, capability `android-host` added.
- `migration-compatibility`: `pytest:tests/migrations/test_pdf_anchor_source_backfill.py::test_0230_stamps_only_anchors_the_binary_history_establishes`.
- `document-import-reliability`: `pytest:tests/service/test_reader_content_too_large.py`.
- `production-release-test-control`: `pytest:tests/kernel/nexus_test_control/test_coherent_file_fault_contract.py`
  (whole file beside the existing exact node, so the new
  `test_coherent_file_fault_refuses_an_owner_its_replay_lane_cannot_execute` is routed).

Corpus manifest: `testdata/contracts/nexus-history.json` re-checksummed to
`f39be1ec…` after the nexus-containment fix extended it with `destinationHrefs`;
its source/purpose strings now name that grammar. The four
`retained-{unicode,table-context}-schema-2.{zip,json}` entries no longer claim "actual
schema-2 producer" output — they are repo-authored wire literals assembled and verified
by the real packager (their descriptor `media_id` is the hand-written sentinel
`00000000-0000-4000-8000-000000000007`, unlike the pdf/epub archives, which really are
producer output). `retained-unicode-schema-2-members.json` inherited the same false
claim and was corrected with them.

## 3. Deviations from the findings' letter (each deliberate)

1. F_android_tests-14 proposed `reading-progress` for the "legacy-conversion owners".
   Three of its five (`LegacyBoundary/Canonical/HtmlTest`) had already been landed under
   `citation-provenance-identity` by a concurrent owner; I placed the remaining two
   (`LegacySource`, `LegacyString`) with their siblings rather than split one fault family
   across two risks.
2. F_android_tests-14 proposed `auth-privacy-secrets` for `OfflineReadingInstalledAccessTest`.
   The proof asserts that a transient unreadable installed member must not delete the
   user's downloaded original and must not drop its database row. That is a destructive
   side effect, not an auth/privacy boundary, so it is registered under
   `destructive-side-effects` (which therefore gains `android-host`). The SVG half of the
   finding is unchanged: script/declaration rejection is a privacy/secrets boundary.
3. Package note asked for extra **exact** nodes on `test_pdf_highlight_publication.py`,
   `test_public_resource_sharing.py`, `test_reader_publication_ownership.py`,
   `test_retained_reader_queries.py` and `test_coherent_file_fault_contract.py`. Policy
   allows exactly one exact node per physical path (`proof-sensitivity-owner`), and a
   second one would also break `fault-canonical-proof` for the two files whose existing
   node is fault-bound. Where the file was unregistered I registered it whole; where it
   already carried a fault-bound exact node I added a whole-file entry beside it (legal,
   and the canonical node still resolves to the exact node). `test_reader_publication_ownership.py`
   and `test_read_admission.py` were already registered whole — no change needed.

## 4. Not registered, and why (for the owning packages)

The tree still holds ~28 untracked `*.test.*` web files that no risk registers, e.g.
`publicationDom/Transport/Contract/Locator`, `readerQueryLease`, `readerUnitLease`,
`readerSectionControls`, `useDocumentReaderSession`, `applySegments`,
`selectionToOffsets`, `canonicalWordPosition`, `client.unit`, `resourceCache.unit`,
`useResource`, `publicationCache`, `paneWarm`, `WorkspaceRecovery`, `HtmlRenderer`,
`ReaderListCompatibility`, `ReaderTableCapacity`, `MediaPaneBodyHighlight{Outcome,Selection}`,
`MediaPaneBodyLinkCompletion`, `epubHref.browser`. They run in their lanes by file
discovery. Registration is not free: **every** source glob of a risk routes to **every**
proof of that risk (selection.py:120-127), so adding 28 component proofs to the reader
risks would fire them on any of ~50 globs. They belong in their owning packages' review,
one risk at a time, not in a registry sweep.

Pre-existing (base-commit) fault owners that remain unregistered and so can never take a
`coherent-fault` pin: `DossierDocumentFrame`, `Nexus.browser`, `DesktopNexusSelection`,
`MobileFullScreenTask`, `usePaneSecondaryPublicationRegistry`, `nexus/dispatch.unit`,
`usePendingDocumentMapPulse`, `workspace/store.browser`, `test_openable_resources.py`.
Out of this wave's scope; worth a ticket. (The *new* nexus containment proof,
`apps/web/src/lib/nexus/history.unit.test.ts`, is registered under
`production-runtime-health` beside `test_nexus_history.py`.)

## 5. Gate state after this package

`repository_violations 0`, `proof_manifest_schema_violations 0`,
`proof_contract_violations 0`, `corpus_manifest_schema_violations 0`,
`corpus_violations 0`, `resource_capability_projection_violations 0`,
`exception_violations 0`. `fault_manifest_violations` is 30 and belongs to the fault-replay
owner (`fault-coherent-owner-drift` + `fault-applicability`); it was 29 before this package
and none of its entries names a proofs.json canonicalization problem.
`pytest tests/kernel/nexus_test_control/test_model.py test_policy.py -q -p no:randomly`:
166 passed, 1 failed — `test_fault_manifest_is_complete_and_every_patch_applies`, the same
pre-existing fault-manifest red.


## 4. orchestrator correction (1 rows changed after this audit)

`testdata/proofs.json` was edited again after the pin above was frozen (mtime 18:35 utc, by a session other than this review's registry owner). the rows, reviewed by the orchestrator against the same rules (each proof path exists, each glob matches a file, one exact node per physical proof, capability routing unchanged), are:

- `+` database-object-convergence proofs: `pytest:python/tests/service/test_epub_fragment_spool.py::test_epub_source_keeps_exact_staged_bodies_through_publication`

the floor was re-frozen from `013f6f8be17832ad22c1a9aa776a7be69208fa8f99ac275ba7275e7f15477947` to `add57541fb7791ac5f4556c8a8d44eb4e0debb63005663c460d07e3fee26ee00` over the resulting map. any later edit re-reds the floor and must recompute the pin the same way.
