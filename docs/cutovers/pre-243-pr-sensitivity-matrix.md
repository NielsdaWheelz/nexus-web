# pre-243 restoration: exact pr sensitivity matrix

## status and boundary

this is a source audit, not a test receipt. snapshot: candidate head
`0bd5eac1d0cfa68df4c7b9ab2a8a7df61afac82f` plus the restoration working tree
on 2026-09-14; target `a1f59a755c91bdc22e77e33c12b93dde829a8e6e`;
coherent product source `98a8b63bf0e72da5cb7e82ba2a9098716de58c84`.
final committed proof receipts supersede these static counts.

this restoration encounters the already tracked
[oi-058 non-python hard-cut replay gap](../tickets/pr-sensitivity-cannot-accept-new-vitest-owners.md)
and [oi-059 python owner/fault gap](../tickets/three-changed-python-owners-lack-a-coherent-fault-witness.md).
this matrix extends their applicability; it creates no waiver or new test policy.

357 changed eligible test files resolve to 144 machine sensitivity owners:
97 use base, 46 already opt into coherent faults, and one uses its unchanged
exact owner's ordinary fault. of the 97 base owners, 72 owner files do not
exist at the target. that absence alone is not a blocker. base routing covers
72 pytest, 20 vitest, two playwright, two gradle, and one node owner.

36 base owners below have direct source evidence of missing imports, symbols,
or production types before their behavioral assertions. this is a conservative
lower bound: the audit does not resolve every transitive import, dependency,
fixture, or service initialization. no setup failure is counted as a red.

## why the existing exact gate cannot combine two baselines

- `cli.py::_selection` uses one base for change selection.
- `cli.py::_workflow_sensitivity` sends that same base to every owner.
- `sensitivity.py::workflow_sensitivity_request` selects base for a materially
  changed owner unless that owner has a valid explicit coherent-fault opt-in.
- `sensitivity.py::_base_overlays` overlays the candidate proof and enumerated
  support, not its restored product dependencies. python retains the target's
  dependency manifests and lockfile. grouped base attempts share the union of
  those declared proof/support overlays.
- `sensitivity.py::behavioral_red` requires the exact behavioral assertion
  marker; import/compile/setup failures and an already-green target fail closed.
- coherent opt-in admits only one exact module-level pytest node or one
  whole-file node owner, with one canonical fault, reviewed source digest,
  applicable product-only patch, and assertion fingerprint.

setting `NEXUS_TEST_BASE_SHA` to the coherent product source would change both
selection and the red baseline. that is a valid source comparison, but cannot
be reported as exact pr proof against the actual target. standalone `prove`
receipts are not imported as same-run pr sensitivity evidence.

## blocker matrix

all python rows below are routed to base and fail while loading unconditional
module imports at the target, before the exact behavioral assertion can run.
web rows show at least one missing runtime import; android rows show missing
production classes and, for the shared contract, a missing fixture property.
the listed faults are existing registered candidates, not newly demonstrated
red/green results. their patch and fingerprint live in
[`testdata/faults/manifest.json`](../../testdata/faults/manifest.json).

remedy codes:

- **exact**: the existing single exact python fault can be reviewed for the
  existing coherent contract, then pinned and proved. opt-in alone is not proof.
- **shared**: the existing fault owns two proofs; the one-owner coherent
  contract requires independently owned witnesses before opt-in.
- **whole**: the current python fault owns a whole file. review which exact
  existing behavioral node it falsifies before registering/pinning that node;
  preserve independent behavior and its witnesses. see oi-059.
- **missing**: no declared fault. preserve the behavioral contract and author
  its own product-only witness, or make the existing base replay reach its
  actual assertion without importing the absent dependency first.
- **base-required**: the coherent mechanism's own proof must stay base-owned;
  repair its setup so its actual policy/dispatch assertion reaches the target.
- **runner**: an explicit current-candidate fault can be proved now, but this
  runner cannot opt into coherent pr routing under the present contract. see
  oi-058. do not label that standalone receipt an exact pr pass.

### python: 23 owners

| exact proof | first direct target incompatibility | existing fault | remedy |
| --- | --- | --- | --- |
| `pytest:python/tests/kernel/nexus_test_control/test_coherent_fault_contract.py::test_bound_coherent_fault_is_admitted_routed_and_invalidated_on_owner_drift` | line 11: `nexus_test_control.sensitivity` lacks `workflow_sensitivity_request` | none | base-required |
| `pytest:python/tests/kernel/nexus_test_control/test_provider_runtime_pin.py::test_provider_runtime_is_materialized_from_the_pin_without_retargeting_source` | line 8: `nexus_test_control.setup_dependencies` absent | `provider-runtime-developer-head-bypass` | exact |
| `pytest:python/tests/kernel/nexus_test_control/test_sensitivity.py::test_isolated_worktree_bounds_run_owned_unix_socket_paths` | line 22: `nexus_test_control.sensitivity` lacks `workflow_sensitivity_request` | none | missing |
| `pytest:python/tests/kernel/nexus_test_control/test_services.py::test_caller_resource_configuration_is_rejected_and_secrets_have_safe_reprs` | line 42: `nexus_test_control.services` lacks `reset_run_data_plane` | `test-environment-production-bypass` | shared |
| `pytest:python/tests/migrations/test_document_import_reliability_migration.py::test_0220_0221_backfill_is_resumable_fail_closed_and_hard_contracts_schema` | line 16: `nexus.db.models` lacks `MediaUploadSession`, `MediaUploadSessionDestination` | `document-import-digest-nullability-bypass` | exact |
| `pytest:python/tests/migrations/test_reader_structure_migration.py::test_reader_structure_repair_preserves_fragment_identity_and_cursor` | line 15: `nexus.services.generation_spec` absent | `reader-structure-cursor-migration-bypass` | exact |
| `pytest:python/tests/service/test_background_worker_process_dispatch.py::test_background_supervisor_dispatches_light_base_handler_to_fresh_child` | line 12: `nexus.jobs.process_executor` absent | none | missing |
| `pytest:python/tests/service/test_chat_admission_recovery.py` | line 23: `nexus.schemas.llm` lacks `Ready`, `TemporarilyUnavailable` | `chat-admission-serialization-bypass` | whole |
| `pytest:python/tests/service/test_chat_background_capacity_isolation.py::test_running_background_claim_does_not_block_foreground_chat_publication` | line 45: `nexus.services` lacks `generation_policy` | `chat-background-capacity-coupling` | exact |
| `pytest:python/tests/service/test_chat_search_query_budget.py::test_hybrid_search_projects_only_finalists_with_identical_visible_ranking` | line 42: `nexus.services.search.retrievers.content_chunks` absent | `chat-search-candidate-union-loss` | exact |
| `pytest:python/tests/service/test_codex_capacity_canary_contract.py::test_capacity_canary_rejects_succeeded_terminal_without_bounded_text` | line 22: `apps.codex_agent` absent | `durable-codex-canary-output-validation-bypass` | exact |
| `pytest:python/tests/service/test_llm_tool_projection_protocol.py::test_revision_gates_every_changed_chat_projection_boundary` | line 27: `nexus.schemas.conversation` lacks `ToolProjectionOut` | `llm-tool-projection-gate-bypass` | exact |
| `pytest:python/tests/service/test_llm_tool_safety.py::test_all_mutating_tools_enforce_owner_persistence_and_idempotent_undo` | line 41: `nexus.services.agent_tools.writes` lacks `add_to_queue` | `llm-write-tool-authorization-bypass` | exact |
| `pytest:python/tests/service/test_media_upload_sessions.py` | line 18: `nexus.config` lacks `DIRECT_UPLOAD_PUT_TIMEOUT_SECONDS` | `document-import-upload-generation-bypass` | whole |
| `pytest:python/tests/service/test_notes_search_result_resolution.py::test_note_search_unions_lexical_and_semantic_hits_into_owned_citable_results` | line 21: `nexus.services.search.resolver` absent | `chat-note-search-candidate-intersection` | exact |
| `pytest:python/tests/service/test_offline_reader_account_fence.py` | line 27: `nexus.db.models` lacks `ReaderPublication` | `offline-reading-expected-account-bypass` | whole |
| `pytest:python/tests/service/test_offline_reader_progress.py::test_offline_progress_is_account_generation_and_response_attested` | line 21: `nexus.db.models` lacks `ReaderPublication` | `offline-reading-generation-cas-bypass` | exact |
| `pytest:python/tests/service/test_offline_reading_caddy_delivery.py::test_production_caddy_proxy_preserves_exact_package_identity_bytes_without_encoding` | line 9: `nexus_test_control.services` lacks `offline_reading_caddy_ports`, `start_caddy_process`, `start_offline_reading_caddy_origin_process`, `wait_offline_reading_caddy_ready` | `offline-reading-caddy-path-scope-bypass` | exact |
| `pytest:python/tests/service/test_reader_publication.py::test_capture_restarts_once_without_mixing_database_and_minio_publications` | line 17: `nexus.services.reader_publication` absent | `offline-reading-mixed-publication-generation` | exact |
| `pytest:python/tests/service/test_upload_confirm_failed_fact.py` | line 11: `nexus.db.models` lacks `MediaUploadSession` | `document-import-confirm-failed-fact-omission` | whole |
| `pytest:python/tests/service/test_upload_confirm_replay_convergence.py` | line 11: `nexus.db.models` lacks `MediaUploadSession` | `document-import-confirm-replay-conflict` | whole |
| `pytest:python/tests/service/test_upload_verification_lease_renewal.py` | line 11: `nexus.db.models` lacks `MediaUploadSession` | `document-import-verification-lease-renewal-bypass` | whole |
| `pytest:python/tests/service/test_upload_verification_lease_theft.py` | line 11: `nexus.db.models` lacks `MediaUploadSession` | `document-import-verification-lease-theft-misclassification` | whole |

### web: 11 owners

| proof | first missing target runtime import | existing fault | remedy |
| --- | --- | --- | --- |
| `playwright:apps/web/e2e/journeys/reader-progress-resume.journey.spec.ts` | line 7: `../documentUploadFixture` | `reader-restore-write-suppression-bypass` | runner |
| `vitest:apps/web/src/app/(authenticated)/imports/ImportsPaneBody.browser.test.tsx` | line 13: `@/lib/imports/ImportsProvider` | `imports-pane-return-token-published-early` | runner |
| `vitest:apps/web/src/components/PdfReader.browser.test.tsx` | line 13: `@/app/(authenticated)/media/[id]/hostedPdfReaderDecorations` | `pdf-committed-highlight-projection-bypass` | runner |
| `vitest:apps/web/src/components/appnav/NavRail.browser.test.tsx` | line 6: `@/lib/imports/ImportsProvider` | `imports-collapsed-count-chip-is-full-size` | runner |
| `vitest:apps/web/src/components/chat/chatAdmission.browser.test.tsx` | line 23: `@/__tests__/helpers/generationCatalog` | `chat-admission-rejection-unlock-bypass` | runner |
| `vitest:apps/web/src/components/imports/ImportsWorkspace.browser.test.tsx` | line 5: `@/__tests__/helpers/contrast` | `document-import-upload-retry-ui-bypass` | runner |
| `vitest:apps/web/src/components/nexus/Nexus.browser.test.tsx` | line 11: `@/__tests__/helpers/trustedBrowserInput` | `nexus-openables-cache-bound-bypass` | runner |
| `vitest:apps/web/src/components/reader/ReaderDocumentMapDetail.browser.test.tsx` | line 7: `./ReaderDocumentMapDetail` | `reader-map-detail-scope-follow-bypass` | runner |
| `vitest:apps/web/src/lib/media/ingestionClient.unit.test.ts` | line 10: `@/lib/status/imports` | `document-import-upload-error-defect-laundering` | runner |
| `vitest:apps/web/src/lib/offlineReading/OfflineReading.browser.test.tsx` | line 4: `./packageContract` | `offline-reader-pixel-offset-bypass` | runner |
| `vitest:apps/web/src/lib/podcasts/subscriptionLifecycle.unit.test.ts` | line 2: `./subscriptionLifecycle` | `podcast-subscription-lifecycle-protocol-bypass` | runner |

### android: two owners

| proof | target compilation/setup incompatibility | existing fault | remedy |
| --- | --- | --- | --- |
| `gradle:apps/android/app/src/test/java/app/nexus/android/offline/reading/OfflineReadingSharedContractTest.kt` | the target has no `offline/reading` production package; the target gradle configuration also lacks `nexus.testdata.offlineReadingContract` | `offline-epub-source-path-uri-interpretation` | runner |
| `gradle:apps/android/app/src/test/java/app/nexus/android/offline/reading/OfflineReadingStoreLifecycleTest.kt` | the target has no `offline/reading` production package | `offline-reading-unsupported-package-progress-deletion` | runner |

## absent features versus already retained fixes

some restored proofs already guard new imports so their real behavior can
reject an old architecture. examples include `test_generation_chat_api.py`,
`test_codex_generation_lowering.py`, and `test_agent_tool_grants.py`.
`test_chat_admission_contract.py` also explicitly diagnoses the absent admission
contract. do not infer a collection failure merely because a test is new.
do not replace an existing behavioral test with an existence assertion.

later safety goals retained from the actual target need preservation evidence;
the target is not expected to falsify a fix it already contains. source-only
inspection cannot claim that an entire revised owner remains green, because
that owner may also cover a restored feature. assess each claimed behavior.

in particular, `HighlightQuickNoteComposer.browser.test.tsx` has no registered
canonical machine owner or fault: `_canonical_selection` therefore does not
require machine sensitivity for its direct whole-file selection. its genuine
new restoration forward port can use an explicit red against the coherent
source, where the defect exists, or a reviewed candidate fault. the target
already has the quick-note safety goal, so demanding a target red for that same
goal would be logically wrong. that does not make this test an exact-pr blocker.

37 base-routed exact python owners have declared faults and the eligible node
shape; two share `test-environment-production-bypass`, so 35 additionally meet
the single-proof declaration shape. these counts identify review candidates,
not approved opt-ins. 38 base owners cannot use the current coherent shape
(14 whole-file pytest, 20 vitest, two playwright, two gradle). 21 base owners
have no declared fault. the mechanism's own canonical witness must remain base.

## smallest correct proof plan

1. retain the exact target for `./scripts/test pr` and record its actual result.
   a setup failure remains a failure. do not relabel it as restoration success.
2. validate the candidate with `./scripts/test full`, and prove the restoration
   tree invariant outside the reviewed exception allowlist. these establish
   current behavior and the intended coherent source, respectively.
3. prove each genuine forward port against the coherent source where that
   regression exists, or its reviewed current product fault. prove retained
   contracts through existing candidate faults where available.
4. where a python proof can use the already approved coherent mechanism, repair
   only its exact ownership/witness after review. where an old architecture
   can support the actual behavioral test, make setup compatible without
   changing the assertion. preserve the distinction between those remedies.
5. retain oi-058/oi-059 for the remaining exact-gate limitation. broad runner
   admission or a multi-baseline restoration contract is separate test-control
   work. this restoration does not silently introduce it.

tradeoff: tree equality, a complete current portfolio, and explicit regression
reds provide useful and truthful independent evidence, but their conjunction
is not the existing same-run exact pr proof. if the gate remains blocked, the
pr must state that limitation. do not merge on an invented equivalent verdict.

## reproducibility

these commands inspect source only. execute proof commands separately on the
authorized proof host, serially, after the final commit. quote proof identities
that contain route brackets or shell metacharacters.

```sh
git rev-parse HEAD
git diff --name-status --find-renames a1f59a755c91bdc22e77e33c12b93dde829a8e6e
git show a1f59a755c91bdc22e77e33c12b93dde829a8e6e:python/nexus_test_control/services.py
rg -n 'reset_run_data_plane|workflow_sensitivity_request|def _base_overlays|def behavioral_red' python/nexus_test_control
# a missing object here confirms the matching matrix import cannot resolve:
git cat-file -e a1f59a755c91bdc22e77e33c12b93dde829a8e6e:python/nexus/services/media_upload_sessions.py
git ls-tree -r --name-only a1f59a755c91bdc22e77e33c12b93dde829a8e6e -- apps/android/app/src/main/java/app/nexus/android/offline/reading
```

for any matrix row, read the named proof's import at the given line and compare
that exact module with `git show TARGET:path`; check the overlay list above
before calling it absent. the matrix records only unconditional python imports
and web runtime imports, not type-only imports or guarded feature imports.
android inspection compares the test's referenced production types and gradle
property with the target tree. this is reproducible source evidence, not a
substitute for the controller's first failure and retained logs.

```sh
NEXUS_TEST_BASE_SHA=a1f59a755c91bdc22e77e33c12b93dde829a8e6e ./scripts/test pr
./scripts/test full
./scripts/test prove --proof 'vitest:apps/web/src/components/chat/chatAdmission.browser.test.tsx' --against fault:chat-admission-rejection-unlock-bypass
./scripts/test prove --proof 'vitest:apps/web/src/components/highlights/HighlightQuickNoteComposer.browser.test.tsx' --against base:98a8b63bf0e72da5cb7e82ba2a9098716de58c84
```
