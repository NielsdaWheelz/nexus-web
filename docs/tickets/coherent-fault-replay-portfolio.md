# the coherent-fault portfolio must be replayed, not re-pinned

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: testdata/faults/manifest.json, sensitivity evidence

## what is wrong

`testdata/faults/manifest.json` fails the repository's own policy capability
closed. a read-only policy scan of the current tree reports 28 fault-manifest
violations: 18 `fault-coherent-owner-drift` (a changed-owner coherent fault whose
pinned `changed_owner_sha256` no longer matches its owner's bytes) and 10
`fault-applicability` (a registered patch that no longer applies to the product
tree). every blocking workflow fails on this, and four dossier passages claim
"byte-identical" pins for owners in this set.

a pin exists so a human re-reads the owner before its BASE-inapplicable fault is
trusted. recomputing the 18 digests and re-deriving the 10 patches without
re-running each fault converts the mechanism into a no-op — it would re-pin bytes
whose red has never been observed, which is the reward-hacking
`docs/local-rules/testing-standards.md` §3 forbids.

### drifted owner pins (by fault index and id)

23 `offline-reading-expected-account-bypass`; 24 `offline-reading-generation-cas-bypass`;
125 `read-admission-cancellation-unwind`; 129 `capacity-container-owner-replacement`;
134 `native-corrupt-package-pending-deletion`; 161 `reader-contents-dom-retention`;
164 `publication-find-tail-omission`; 168 `publication-find-row-release-before-preview`;
173 `native-shelf-refused-removal-dismissal`; 181 `reader-apparatus-retired-preview-clear`;
183 `reader-apparatus-body-source-substitution`;
187 `reader-completed-find-navigation-identity-loss`;
188 `reader-completed-apparatus-navigation-identity-loss`;
192 `reader-apparatus-input-authority-loss`; 193 `pdf-reattachment-unpainted-row-loss`;
196 `reader-published-query-close-release`; 200 `native-table-unready-publication`.
`native-package-upgrade-retained-size-drift` is in the same class:
`OfflineReadingDatabaseTest.kt` was edited for the two new conversion columns.

### patches that no longer apply

`native-legacy-units-canonical-substitution`, `native-legacy-url-activation`,
`publication-embed-canonical-ui-inclusion`, `reader-apparatus-retired-preview-clear`,
`native-table-row-truncation`, `pdf-location-cancelled-key-retention`,
`native-table-header-opacity-bypass`, `native-table-unready-publication`,
`reader-margin-retired-source-retention`,
`reader-body-classification-media-route-substitution`,
`pdf-committed-highlight-projection-bypass`.

`native-table-row-truncation` and `native-table-header-opacity-bypass` patch the
old main-source paths; their owners moved to `apps/android/app/src/test/java/...`
with unchanged content, so they need re-pinning to the test-source paths.
`native-legacy-canonical-*` must be re-derived against the current
`OfflineReadingLegacyCanonical.kt` so it still expresses the reviewed mutation
(losing the original source coordinate at a canonical boundary).

### faults that have never executed at all

- `reader-cursor-source-ack-bypass` and `reader-cursor-source-migration-invention`
  (gate c's cursor-provenance contract): the only runs under `test-results/runs`
  are `b44b8008c8fe390d` and `0a0777a4e78a812b`, both `status: fail`, detail
  `sensitivity execution did not complete: sensitivity requires a clean committed
  checkout`. the whole contract is green-only.
- `publication-find-tail-omission` and `publication-find-row-release-before-preview`:
  neither registered fault has a receipt, so the find slice's central new
  behaviour has no demonstrated sensitivity. reading-level confirmation exists
  (the tail fault strands `publicationFind.browser.test.tsx:14`) but is not a run.
- `reader-restore-write-suppression-bypass`: its patch targets
  `MediaPaneBody.tsx` `armCaptureSuppressionUntilGenuineInput`, which was
  rewritten; the context is stale and must be re-derived against the current file.
  its `expected_failure` substring is preserved verbatim in the journey.
- `reading-progress-cas-bypass`: the patch still applies (`git apply --check`
  passes) and the injected bypass still yields `DID NOT RAISE`, but red/green must
  be re-observed on a checkpoint with a database.

## prerequisites

a committed candidate. the controller refuses sensitivity on a dirty worktree by
design, and the branch is uncommitted (see the candidate-identity ticket).

## proposed fix

for each entry: re-run `./scripts/test prove --proof <owner> --against
fault:<id>` on the committed candidate, confirm the recorded `expected_failure`
string is still the assertion that fires, record the red/green run id in the
owning dossier, and only then write the new `changed_owner_sha256`. do not bulk
refresh.

close the recurrence rather than relying on memory:

- make the pin a derived artifact of the `prove` run — emit the observed owner
  digest into the run receipt and add a policy check that refuses a manifest
  whose pin changed without a run receipt naming that fault in the same run
  directory.
- extend the `PolicyViolation` at `python/nexus_test_control/policy.py:1968-1975`
  to carry the fault id, owner path, pinned digest and actual digest, and surface
  a `policy` verdict listing every drifted owner with the exact `prove`
  invocation. today the message names only `manifest.json#faults[N]`.
- promote coherent-fault OWNER paths (not only `testdata/faults/`) to
  `Capability.POLICY` in `selection.py`, so editing a pinned proof selects policy
  in the same `changed` run instead of surfacing at `pr` time.

## acceptance

the policy scan reports zero `fault-coherent-owner-drift` and zero
`fault-applicability` violations, every pin in the list above is backed by a
run receipt naming its fault in the same run directory, and a deliberate edit to
a pinned owner selects the policy capability in `changed`.


## replay outcomes (2026-09-14, adversarial review)

replays ran from committed checkpoint worktrees (`nexus-web-review-checkpoint-{python,native,web}`); the shared manifest was pinned only from an observed green-on-candidate / red-under-fault receipt. `test-results/runs/<id>/summary.json` lives in the owning checkpoint.

| group | fault | outcome | run ids |
|---|---|---|---|
| python | offline-reading-expected-account-bypass | repinned_from_observed_red_green | 70e57c7140a42e47 |
| python | offline-reading-generation-cas-bypass | repinned_from_observed_red_green | 9101af98ecaa6c44 |
| python | read-admission-cancellation-unwind | repinned_from_observed_red_green | 486d64486e7bdbcc |
| python | capacity-container-owner-replacement | repinned_from_observed_red_green | b9d508b76aa25821 |
| python | reader-body-classification-media-route-substitution | patch_rederived_and_observed | f438b48c1c601018 |
| web | reader-contents-dom-retention | repinned_from_observed_red_green | cc0df4fae206e8f6 |
| web | publication-find-tail-omission | patch_rederived_and_observed | 9e9234377a43d4b7 |
| web | publication-find-row-release-before-preview | repinned_from_observed_red_green | b788faf5aea184b4 |
| web | native-shelf-refused-removal-dismissal | repinned_from_observed_red_green | c6cbdc3a3bf35d1e |
| web | reader-apparatus-retired-preview-clear | patch_rederived_and_observed | 92fd7ee90780a871 |
| web | reader-apparatus-body-source-substitution | repinned_from_observed_red_green | 858d90ca34b63efc |
| web | reader-completed-find-navigation-identity-loss | repinned_from_observed_red_green | e2afc6ec009884c3 |
| web | reader-completed-apparatus-navigation-identity-loss | repinned_from_observed_red_green | b2419f848091fb09 |
| web | reader-apparatus-input-authority-loss | repinned_from_observed_red_green | 09617d980aabf3a4 |
| web | pdf-reattachment-unpainted-row-loss | repinned_from_observed_red_green | d509e47a9d875a21 |
| web | reader-published-query-close-release | repinned_from_observed_red_green | 0ae4e0c17aefecf2 |
| web | publication-embed-canonical-ui-inclusion | patch_rederived_and_observed | b82e3173862eec48 |
| web | reader-margin-retired-source-retention | patch_rederived_and_observed | 45803ebe5e0f4355 |
| web | pdf-committed-highlight-projection-bypass | patch_rederived_and_observed | bfaa9c4b0beafd12, bc56e8f586c06caa |
| web | pdf-location-cancelled-key-retention | left_drifted | 8bc987563b910b4f |
| native | native-corrupt-package-pending-deletion | repinned_from_observed_red_green | b0cffc571dc4561e |
| native | native-package-upgrade-retained-size-drift | proof_needs_product_fix | 54c9b773e17af552 |
| native | native-table-unready-publication | proof_needs_product_fix | c606cc47e743d0fb, 7186a537182932a0 |
| native | native-legacy-units-canonical-substitution | left_drifted | — |
| native | native-legacy-url-activation | left_drifted | — |
| native | native-table-row-truncation | retired_with_reason | — |
| native | native-table-header-opacity-bypass | retired_with_reason | — |
| web | pdf-location-cancelled-key-retention | repinned_from_observed_red_green (orchestrator, after reordering the owner proof's oracles) | a534704d724f20c2 |
| python | reader-epub-caption-loss | left_drifted (owner edited late by another session; replay killed by the memory guard) | — |
| native | native-package-upgrade-retained-size-drift | proof repaired (snapshots exclude the schema-3 conversion columns); replay pending | 54c9b773e17af552 (red on candidate, pre-repair) |
| native | native-table-unready-publication | proof repaired (row comparison asserts the recorded Storage failure); re-derived patch carried into the tree; replay pending | c606cc47e743d0fb (red), 7186a537182932a0 (green failed pre-repair) |
| native | native-legacy-units-canonical-substitution, native-legacy-url-activation | re-derived patches carried into the tree (apply cleanly); not yet observed | — |

still open after this pass: the three drifted owners named above and the two unobserved re-derived native patches. finish from the checkpoints named in docs/cutovers/bounded-workspace-adversarial-review.md when the box has ~3 GB free; the two native proof repairs must be replayed green before their pins are written.
