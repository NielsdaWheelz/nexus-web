# bounded workspace implementation: adversarial review and fix wave

> 2026-09-14 pause: historical document; implementation is stopped.
> the [evidence audit](bounded-workspace-evidence-audit.md) distinguishes findings,
> decisions and unverified claims. the [replacement plan](production-crash-replacement-plan.md)
> supersedes this execution scope and awaits user review.

status: review complete; fixes applied to the uncommitted tree; the candidate is NOT release-ready (see "not achieved")
origin: 2026-09-14 adversarial review of docs/cutovers/bounded-workspace-implementation.md against the worktree `nexus-web-bounded-workspace` (branch codex/bounded-workspace, base 7fa89b88c8)
area: capacity, transport, pending work, publication, hosted views, offline/native, cutover, test control

## what was reviewed and how

there is no pr. the deliverable is one uncommitted tree (modified=369 untracked=573 deleted=22 tickets=201 register_rows=135) implemented by codex sessions and live-edited by them during this review. the review ran 28 slices (spec coverage, retirement clause, static gates, tickets/register, and 24 code slices across python, web, android and test control), each with an independent adversarial verifier, then 43 fix packages by disjoint file ownership, then registry, docs and ticket reconciliation, then fault replays from committed checkpoints.

finding ledger (322 raised):

| outcome | blocker | major | minor |
|---|---|---|---|
| refuted by the verifier | 2 | 8 | 37 |
| fixed | 21 | 72 | 95 |
| partially fixed (remainder ticketed) | 3 | 33 | 20 |
| not fixed (ticketed) | 0 | 1 | 11 |
| already fixed upstream by codex / rejected on re-verification | 0 | 5 | 8 |

the nine registry findings (drifted coherent-owner pins, non-applying fault patches, the stale offline bundle) were handled outside the package ledger: the bundle was rebuilt by hand, the pins by the replay owners (see "registry state"). 244 trade-offs were stated by the packages; they are listed verbatim in bounded-workspace-adversarial-review-tradeoffs.md.

per package:

| package | fixed | partial | not fixed | upstream/rejected |
|---|---|---|---|---|
| P_x_ingest | 8 | 3 | 0 | 0 |
| P_pdf_anchor_provenance | 1 | 2 | 0 | 0 |
| P_publication_schema_core | 7 | 2 | 0 | 0 |
| P_publication_render | 6 | 1 | 1 | 0 |
| P_enrich_schema | 2 | 1 | 0 | 0 |
| W_artwork | 3 | 2 | 0 | 0 |
| W_reader_components | 4 | 2 | 1 | 0 |
| W_search_stance_overlays | 3 | 2 | 4 | 0 |
| W_retire_epub_find | 2 | 2 | 0 | 0 |
| W_web_tests | 2 | 1 | 0 | 0 |
| K_native_wire | 7 | 1 | 1 | 0 |
| K_native_store | 2 | 1 | 0 | 1 |
| P_resource_graph | 1 | 1 | 0 | 0 |
| P_offline_python | 7 | 3 | 1 | 0 |
| P_runtime_admission | 5 | 6 | 1 | 0 |
| P_test_control | 6 | 1 | 1 | 0 |
| P_python_tests | 3 | 4 | 1 | 0 |
| X1_capacity_server | 6 | 5 | 0 | 0 |
| W_hosted_progress | 6 | 4 | 2 | 0 |
| W_workspace_session | 3 | 1 | 2 | 0 |
| W_resource_cache | 5 | 1 | 4 | 0 |
| W_reader_window_session | 7 | 1 | 3 | 1 |
| W_offline_reader | 8 | 1 | 0 | 1 |
| W_bff_proxy | 9 | 0 | 0 | 0 |
| X8_python_leftovers | 4 | 2 | 0 | 0 |
| X7_android_verifier_tests | 7 | 5 | 2 | 0 |
| X4_nexus_containment | 5 | 2 | 0 | 0 |
| X5_pane_registry | 1 | 0 | 0 | 0 |
| X9a_publication_storage_leftovers | 1 | 7 | 1 | 0 |
| X9b_python_tests_controller_leftovers | 0 | 0 | 0 | 10 |
| X2a_capacity_client_seams | 3 | 4 | 3 | 0 |
| X9c_python_followup | 7 | 2 | 0 | 1 |
| X3_reader_state_hardcut | 10 | 3 | 0 | 0 |
| X10_android_leftovers | 4 | 1 | 0 | 0 |
| X2b_render_sites | 4 | 3 | 0 | 0 |
| X6a_media_pane_body | 9 | 4 | 0 | 2 |
| X6b_pdf_reader | 6 | 0 | 0 | 1 |
| X12_android_legacy | 4 | 1 | 1 | 0 |
| X14_pdf_location_lifecycle | 1 | 0 | 0 | 0 |
| X13_signature_sweep | 4 | 0 | 0 | 1 |
| X16a_figure_admission_reapply | 0 | 1 | 0 | 0 |
| X11a_proof_registry | 3 | 1 | 1 | 0 |
| X11b_docs_tickets_register | 12 | 10 | 0 | 1 |

## verdict against the spec

the spec is not fully implemented, and the implementation's own dossiers say so. what this review changed is that the code that exists holds its contracts (typed outcomes instead of masked errors, one owner per invariant, retired paths deleted, proofs that can fail), the register names every remaining gap, and the receipts that were false are corrected.

| gate | required observable result | state after this review |
|---|---|---|
| 0/a | configured maximum admitted work meets budgets; zero kills; overload rejects promptly | admission mechanism exists (foreground/image/package-transfer pools, per-permit deadlines, request-body bound) and rejects with 503 + Retry-After; NO qualified numbers exist: every profile ships as a required `<qualified>` deploy key. the runtime dossier's own words: "no allocation profile or complete workload qualification exists yet". ticket oi-176. |
| b | raw gateway failures exhaust within the correct feature; malformed 2xx stays loud; no retry multiplication | terminal oversize is now 422 E_READER_CONTENT_TOO_LARGE (non-retryable by status class) and the admission owner is the only producer of E_READ_CAPACITY; nexus history/containment, pane registry defect arm, hosted-progress absent-row reconciliation landed. the enclosing real-stack proof the client dossier lists as remaining is still remaining. the blanket 5xx retry rule survives (ticketed). |
| c | pending intent preserved or explicit conflict; no false save acknowledgment | cursor provenance is required by the type; the unfenced reader-state route is deleted; the account-bound writer is the single owner; sessionSync no longer reports Saved from row absence. the two c-server product faults have never executed (need a committed candidate). |
| d/e | same-unit panes share one read; replacement cannot mix generations; old content readable; large documents traverse within budgets | six check constraints moved to application defects per database.md; member-route http proof added; find cursor reservation is scalar; publication assets on the admitted pool; hosted deferred figures now mount from the selected generation. table continuation (oi-106) and content-identity split (ticketed) remain open. |
| e | twelve-pane restore, pinned selection, slow cancellation within budgets; views take priority | view priority in the resource cache, two view pools (units vs query leases), capacity notices reason-aware everywhere. the twelve-pane journey does not exist (oi-177). |
| f | unchanged downloads reuse bytes; interrupted preparation publishes nothing; old packages convert without lost progress | schema-2 only; attestor schema 2; conversion failure classified and terminal on defect; retained staging resumes; storage refusal named; one clock; no seventh http client. device qualification remains waived/unverified; verifier heap scaling ticketed with a two-sided prescription. |
| g | exact candidate passes pr/full/native lanes and the exact-sha deployment protocol | not started: compose and release.py untouched; the candidate is uncommitted (oi-174); pr/full/native lanes not run. |

## decisions and arbitrations (stated, not absorbed)

- no numeric limits were invented anywhere: `API_READ_ADMISSION_LIMITS` (now seven numbers incl. `request_bytes`), `IMAGE_DECODER_LIMITS`, `READER_PUBLICATION_LIMITS` are required deploy keys with `<qualified>` placeholders; the test-control fixture carries explicit, deliberately generous, unqualified values.
- a terminal oversize is a 422 (`E_READER_CONTENT_TOO_LARGE`, details `{limit, limit_value, measured}`), never a 503 dressed as capacity; the client learns non-retryability from the status class and renders one terminal notice with no retry affordance.
- the transport request bound answers 413 `E_REQUEST_TOO_LARGE`; `E_CHAPTER_NOT_FOUND` and `E_EPUB_FIND_SOURCE_CHANGED` are retired with their producers; `E_OFFLINE_READING_PACKAGE_TIMEOUT` is retired as unproducible.
- the six check constraints for conditional nullability / tagged-union consistency were removed from 0229 and re-expressed as application defects, per docs/rules/database.md.
- the evidence read stays POST although the spec table says GET; the arbitration (what the body carries, what is given up) is recorded in the publication dossier and the spec's new "recorded deviations" section.
- all four publication member routes sit on the admitted-read pool; the package-transfer pool is only for the offline archive.
- the native schema-1 conversion is the only read path for installed schema-1 copies; failure is classified (defect = terminal until explicit retry; storage = retry) and recorded on the row inside the unreleased schema 3.
- `PRIORITY_RISK_OWNERSHIP_SHA256` and the routing token were re-frozen only after a field-by-field audit of the whole base-to-now ownership delta (docs/cutovers/bounded-workspace-registry-review.md).
- offline bundle: the runtime context no longer imports the pane render registry (the host injects `preloadPane`); the bundle guard now requires a host after `scheme://` and treats the epub href resolution base as inert.
- fable was used only for three review slices; every fix package ran on opus.

## cross-cutting fixes landed

- capacity taxonomy split server-side (28 sites) and client-side (source, session, cache, every render site incl. MediaPaneBody and PdfReader).
- reader-state hard cut: `PUT|GET /media/{id}/reader-state`, `/epub-find`, `/sections/{id}`, `/navigation` and their bff routes and services deleted; three journeys moved to the account-bound writer; cursor `source` required.
- nexus containment: history read grammar as scoring filter, one contract fixture, boundary around the session not the opener, per-locator Defected arm in the pane registry.
- hosted progress four-way absent-row reconciliation; 409 duplicate delivery acknowledged by equality; workspace recovery terminal discard.
- resource cache reserves view reads; one permit across the retry schedule; tagged unit settlement; two view pools with one owner for the 11×/4× factors.
- publication: member reservation retainUntil, `prepared` required, one pdf-source owner, scalar find cursor, index-page unit-ref validation, typed unprepared outcome, media-teardown fence = max(writeMayLandUntil, retainUntil).
- offline python: typed package errors, no requeue on mint, schema-1 lane deleted, archive_revision_key dropped; pdf anchor provenance backfill 0230.
- runtime: per-permit deadlines, package-transfer pool, request-body bound, 499 on client disconnect, image decoder signal classification, import-phase classification.
- test control: whole-file capacity selection, dirty-tree qualification refused, receipts require build-input identity, coherent owners lane-checked, ownership floor re-frozen.
- web reader: stance outcomes tagged and bounded walk; paint outcomes one tagged surface; committed writes acknowledged before paint; expiresAtMs deleted; options-object constructors; tagged find preparations; contents trail; fixture consolidation; epubFind retired; deferred figures mounted from the selected generation in both readers through one dom owner.
- android: attestor schema 2, verifier origin rule, storage admission, per-media progress sync isolation, conversion-failure accounting, resumable retained staging, single clock, artwork through the owned proxy, table experiments moved out of app/src/main.
- offline reader bundle rebuilt and closure-checked (graph 126 → 165 sources).

## not achieved (honest ledger)

- gate 0/a numbers, gate e twelve-pane journey, gate g compose/release, native device qualification, and the pr/full/native lanes: not attempted here; each has a ticket (oi-174..178 and the extended oi-083).
- the candidate is uncommitted; `prove` and capacity qualification refuse it by design. replays in this review ran from throwaway committed checkpoints, not from the candidate.
- db-backed service proofs written by the packages (member routes, public sharing, delivery budget, image decoder signals, connection projection) were not executed here; they are ruff/pyright clean and modelled on running siblings. the full browser vitest project was not swept; each package ran its own proofs.
- 217 of the dossiers' cited receipt ids have no run directory in the tree (oi-175).
- D_ingest_producers-7's race proof is specified but not written (oi-211); D1-3's content-identity split is a migration scheduled behind gate 0 (ticketed).

## registry state

the controller's policy gate on the shared tree at the end of the review: repository, proof-manifest, proof-contract (ownership floor re-frozen twice, both audits recorded in bounded-workspace-registry-review.md), corpus, resource-capability and exception violations all 0; fault-manifest violations 3 (native-package-upgrade-retained-size-drift, native-table-unready-publication, reader-epub-caption-loss: owners repaired or edited after their last observed replay; see the table).

coherent-fault replays were run from committed checkpoint worktrees (`nexus-web-review-checkpoint-{python,native,web}`), pinning the shared manifest only from an observed green-on-candidate / red-under-fault receipt, never from a re-hash:

| group | observed and pinned | patch re-derived and observed | retired | left drifted |
|---|---|---|---|---|
| python | offline-reading-expected-account-bypass (70e57c7140a42e47), offline-reading-generation-cas-bypass (9101af98ecaa6c44), read-admission-cancellation-unwind (486d64486e7bdbcc), capacity-container-owner-replacement (b9d508b76aa25821) | reader-body-classification-media-route-substitution (f438b48c1c601018) | | reader-epub-caption-loss: owner edited by another session at the end of the review; its replay was killed by the machine's memory guard (swap exhausted by concurrent codex lanes); replay from `nexus-web-review-checkpoint-python` (23baa64511, provisional pin committed) |
| web | reader-contents-dom-retention, publication-find-row-release-before-preview, native-shelf-refused-removal-dismissal, reader-apparatus-body-source-substitution, reader-completed-find-navigation-identity-loss, reader-completed-apparatus-navigation-identity-loss, reader-apparatus-input-authority-loss, pdf-reattachment-unpainted-row-loss, reader-published-query-close-release, pdf-location-cancelled-key-retention (a534704d724f20c2, after the owner proof was reordered so the settle oracle fires first) | publication-find-tail-omission, reader-apparatus-retired-preview-clear, publication-embed-canonical-ui-inclusion, reader-margin-retired-source-retention, pdf-committed-highlight-projection-bypass | | |
| native | native-corrupt-package-pending-deletion (b0cffc571dc4561e) | native-table-unready-publication (red observed in c606cc47e743d0fb; green blocked by the proof defect since repaired), native-legacy-units-canonical-substitution, native-legacy-url-activation (both re-derived and applying, not yet observed: the gradle replays were stopped when the box reached its swap ceiling) | native-table-row-truncation, native-table-header-opacity-bypass (their targets moved to app/src/test; a fault must mutate product code) | native-package-upgrade-retained-size-drift and native-table-unready-publication (proof defects repaired; replay from `nexus-web-review-checkpoint-native` 8149dc9254 pending a box with ~3 GB free) |

two native proofs were red on the unfaulted candidate because the schema-3 conversion columns entered rows they compared byte-for-byte (`OfflineReadingDatabaseTest`, `OfflineReadingTablePreparationTest`); both were repaired to exclude and assert those columns explicitly. run ids are `test-results/runs/<id>/summary.json` in the owning checkpoint.

## collisions the merge owner must know about

- the codex client checkpoint (`nexus-web-bounded-client-proof/apps/web/src/components/PdfReader.tsx`) carries an identity-symbol selection-ownership change in `handleCreateHighlight` that is not in the shared tree; this review's acknowledge-before-paint rewrite of the same function will collide with it. keep the identity ownership and apply the acknowledge-before-paint ordering on top.
- twice during this review a concurrent session rewrote files and dropped landed work (16:11 utc: contract.ts, presentation.ts, OfflineReadingStore.kt, OfflineReadingModels.kt, OfflineReadingWebCapability.kt; later: DocumentReaderSession.memberAssetUrl, the MediaPaneBody figure-admission calls and publicationDom.applyReaderUnitResources). all were re-applied and a symbol checklist passes at the end of the review; re-run that checklist before merging.
- three pre-existing red proofs were repaired as proof defects, not product defects: PdfReaderLocationLifecycle (encoded the retired frame-polling semantics), resourceActionPlan.contract "text-only" case (the confirmation was retired with schema-2 packages), MediaPaneBodyStanceChord's synchronous assertion after re-prepare.
- pytest collection has three duplicate basenames across tests/kernel and tests/service (pre-existing at the base).
- the whole db-free kernel suite (`pytest tests/kernel`, 1569 collected) ends with 66 failures that this review did not introduce: 53 in `test_production_deploy_behavior.py` / `test_android_player_protocol_release_gate.py` (their fake `git` runs `tests/testkit/production_deploy.py` by path and cannot import `tests` outside the controller's environment), 9 controller-selection/worker-contract proofs (`test_selection.py` ×5, `test_llm_tools_capability.py`, `test_ingest_node_capability.py`, `test_runner.py` ×1, `test_bounded_resource_worker_contract.py`) that fail identically in the codex client checkpoint, 2 characterizations that require `NEXUS_TEST_RESULTS_DIR` from the controller (`test_reader_publication_lists.py`, `test_table_header_fixture.py`), and 4 that wait on the last fault-manifest pin (`test_coherent_fault_contract.py`, `test_policy.py::test_fault_manifest_is_complete_and_every_patch_applies`, `test_sensitivity.py` ×2). the other 1501 pass. run the suite through `./scripts/test` for the first two groups.
