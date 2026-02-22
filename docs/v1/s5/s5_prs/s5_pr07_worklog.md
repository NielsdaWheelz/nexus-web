# s5 pr-07 worklog

## purpose
Capture bounded-context evidence gathered while authoring `docs/v1/s5/s5_prs/s5_pr07.md`.

## spec authoring completeness checklist (source targets: `docs/v1/s5/s5_roadmap.md`)
- [x] PR-07 spec maps all S5 scenarios (1-15) to automated checks with explicit traceability.
- [x] PR-07 spec defines invariant and error-code conformance audit coverage across extraction, read, and retry paths.
- [x] PR-07 spec maps compatibility evidence for existing media/highlight/chat surfaces with no planned contract regressions.

## evidence log

| id | acceptance item | file | lines | evidence | impact on spec |
|---|---|---|---|---|---|
| e-001 | PR-07 roadmap scope | `docs/v1/s5/s5_roadmap.md` | 153-163 | PR-07 is explicitly hardening/freeze-only, and non-goals now also defer production embedding pipeline/orchestration and new persisted embedding artifact stores to S9. | Locked PR-07 hardening-only scope and explicit S9 boundary in non-goals/decisions. |
| e-002 | Ownership boundary (C8) | `docs/v1/s5/s5_roadmap_ownership.md` | 7-10, 22-23 | Ownership rules prohibit scope expansion by PR-07; C8 owns freeze gates only with minimal blocking fixes allowed. | Constrained PR-07 to test/audit closure and minimal fixes only. |
| e-003 | L2 error-code audit surface | `docs/v1/s5/s5_spec.md` | 638-660 | S5 error table defines the retry/read/ingest error semantics PR-07 must audit (`E_RETRY_INVALID_STATE`, `E_RETRY_NOT_ALLOWED`, `E_CHAPTER_NOT_FOUND`, `E_MEDIA_NOT_READY`, etc.). | Added explicit invariant/error audit coverage requirement and implementation report summary. |
| e-004 | L2 invariant + scenario freeze targets | `docs/v1/s5/s5_spec.md` | 664-685, 688-792 | Invariants 6.1/6.10/6.19 and scenarios 1/11/12 are the remaining high-risk lifecycle/data-integrity targets; sections 7 and 8 define full slice freeze traceability expectations. | Drove mandatory automated coverage for scenarios 1, 11, 12 and traceability matrix rows for all scenarios plus non-scenario coverage items. |
| e-005 | Constitution lifecycle contract includes embedding and retry cleanup | `docs/v1/constitution.md` | 414-447 | Constitution defines readable `embedding` state, lifecycle transitions, and retry cleanup of chunks/embeddings, plus `E_EMBEDDING_FAILED`. | Reinforced PR-07 architecture-aware coverage now and explicit S9 roadmap commitment for future embedding implementation. |
| e-006 | Future slice ownership anchor for embeddings | `docs/v1/slice_roadmap.md` | 516-534 | S9 Semantic Search now explicitly includes embedding production orchestration, persisted chunk/embedding artifact lifecycle cleanup, and lifecycle-safe retry/reset acceptance. | Added durable cross-slice ownership reference so PR-07 can defer pipeline implementation without indefinite ambiguity. |
| e-007 | Current retry cleanup implementation seam | `python/nexus/services/epub_lifecycle.py` | 258-321 | Retry flow validates source integrity before cleanup, then calls `_delete_extraction_artifacts`; helper deletes `epub_toc_nodes`, `fragment_blocks`, and `fragments` only. | Drove architecture-aware cleanup assertions and decision to verify persisted EPUB artifacts instead of non-existent tables. |
| e-008 | Readable status contract in backend EPUB read path | `python/nexus/services/epub_read.py` | 29-40 | EPUB read guards treat `ready_for_reading`, `embedding`, and `ready` as readable. | Anchored scenario-11 contract-state verification using controlled status transitions without new embedding pipeline code. |
| e-009 | Readable status contract in highlights path | `python/nexus/services/highlights.py` | 43-45 | Highlight mutations are allowed in `ready_for_reading|embedding|ready`. | Confirmed scenario-11/compatibility coverage can rely on existing semantics and should avoid service rewrites in PR-07. |
| e-010 | Existing ingest/upload coverage for non-scenario rows `4.1` and `4.2` | `python/tests/test_upload.py` | 115, 155, 174, 870, 904, 940, 1009, 1058, 1116 | Upload-init EPUB success/validation, ingest compat/idempotency, and extension-spoof rejection tests already exist and are explicit. | Marked `4.1`/`4.2` as audit-traceability reuse and added explicit anti-regression reference for extension-only spoof rejection. |
| e-010b | Existing error-code status mapping audit coverage | `python/tests/test_errors.py` | 121 | `test_error_code_maps_to_correct_status` includes S5 error primitives (`E_RETRY_INVALID_STATE`, `E_RETRY_NOT_ALLOWED`, `E_CHAPTER_NOT_FOUND`, `E_ARCHIVE_UNSAFE`) in the status mapping matrix. | Added explicit PR-07 audit-rerun coverage for error-code conformance bullet. |
| e-011 | Existing extraction artifact coverage for scenarios 5/8/9/10/14 | `python/tests/test_epub_ingest.py` | 213, 266, 397, 471, 522, 612, 653, 698 | Extraction tests already cover contiguous fragments/blocks, deterministic TOC snapshot, title fallback, resource rewrite/degradation, archive safety, and ingest task success/failure transitions. | Reused as PR-07 freeze evidence; no extractor feature changes in scope. |
| e-012 | Existing read/retry/assets coverage plus remaining retry assertion seam | `python/tests/test_media.py` | 584, 694, 813, 913, 1023, 1066, 1126, 1255, 1315, 1363, 1422, 1476, 1517, 1563, 1645, 1665, 1697, 1801 | Backend tests cover assets, chapter/TOC read contracts, visibility/kind/readiness guards, retry paths (including source-identity preservation), and `/fragments` compatibility; current retry tests do not explicitly assert seeded artifact purge. | Drove PR-07 deliverables to extend `test_media.py` with immutability and retry cleanup/no-mutation artifact assertions, while reusing source-identity preservation as explicit freeze evidence. |
| e-013 | Existing EPUB highlight compatibility coverage | `python/tests/test_highlights.py` | 1637, 1675, 1714 | PR-06 tests already prove fragment-scoped highlights, canonical text derivation, and rejection of legacy global offsets. | Reused as authoritative PR-07 evidence for scenarios 2-3 and compatibility row `4.7`. |
| e-014 | Existing EPUB quote-to-chat compatibility coverage | `python/tests/test_send_message.py` | 1316, 1368, 1425 | PR-06 tests already prove fragment-based quote rendering, chapter-local context, and masked `404 E_NOT_FOUND` semantics. | Reused as authoritative PR-07 evidence for scenario 3 and compatibility row `4.7`. |
| e-015 | Existing `/media/{id}/fragments` EPUB compatibility guard | `python/tests/test_media.py` | 1801 | PR-06 test explicitly verifies ordered full fragments payload for ready EPUB media. | Reused for PR-07 compatibility acceptance (`4.7`) without endpoint redesign. |
| e-016 | Existing browser-path embedding readability evidence | `apps/web/src/app/(authenticated)/media/[id]/page.test.tsx` | 551 | UI test confirms EPUB reader treats `embedding` status as readable. | Included as browser-path evidence for scenario 11 while adding backend contract-state transition test in PR-07. |
| e-017 | Existing route-bound attach-handoff compatibility baseline evidence | `apps/web/src/app/(authenticated)/conversations/page.test.tsx`; `apps/web/src/app/(authenticated)/conversations/[id]/page.test.tsx` | 91-159; 122-164 | PR-06 frontend tests provide baseline attach-handoff coverage (valid/invalid attach preload, failure retention, and success-path composer wiring presence) on both conversation routes. | Reused as baseline PR-07 compatibility evidence (`4.7`), with success-path canonicalization assertions strengthened per e-022. |
| e-018 | Legacy file-detection/raw-html/source-preservation risks | `docs/old-documents-specs/EPUB_SPEC.md` | 11-14, 42-46, 84-98 | Legacy EPUB flow accepted extension fallback, stored raw unsanitized concatenated HTML, and deleted the original file after processing. | Added PR-07 anti-regression traceability/evidence requirements for extension-spoof rejection, active-content sanitization assertions, and retry source-identity preservation. |
| e-019 | Legacy CSS leakage/isolation scope-creep risk | `docs/old-documents-specs/EPUB_SPEC.md` | 202-207, 319-323 | Legacy notes document EPUB CSS leakage into app UI and propose iframe/shadow DOM/style-stripping isolation strategies. | Added explicit PR-07 non-goal/boundary blocking CSS isolation/rendering-architecture changes in the freeze PR. |
| e-020 | Current extractor test strategy uses deterministic synthetic fixtures | `python/tests/test_epub_ingest.py` | 1-5, 31-150 | Test module header explicitly documents in-memory fixture construction and the file contains reusable EPUB builder helpers for EPUB2/EPUB3 variants. | Preserved synthetic in-memory builders as primary deterministic edge-case harness and documented them as complementary to (not replaced by) a new real-fixture smoke suite. |
| e-021 | Frontend EPUB reader page tests are currently over-mocked for freeze-grade integration confidence | `apps/web/src/app/(authenticated)/media/[id]/page.test.tsx` | 1-6, 20-125 | Test file header states heavy rendering modules are mocked; the suite mocks `next/navigation`, highlight internals, and multiple UI components including `HtmlRenderer`. | Added PR-07 requirements to reduce internal mocks, keep externals-only mocking bias, and strengthen the sanitized-HTML reader assertion through the real `HtmlRenderer` path where practical. |
| e-022 | Conversation attach-route tests cover attach preload/retention but success-path assertions stop short of full canonicalization/send lifecycle checks | `apps/web/src/app/(authenticated)/conversations/page.test.tsx`; `apps/web/src/app/(authenticated)/conversations/[id]/page.test.tsx` | 115-149; 148-173 | Existing tests verify chip presence and failure retention, but success tests mainly assert composer/chip presence and do not require explicit `router.replace` canonicalization + attach-param stripping after send success. | Added PR-07 requirements to strengthen both conversation route success-path tests with send lifecycle assertions (chip clear + canonical URL state). |
| e-023 | No checked-in real EPUB fixture corpus exists yet | `python/tests/fixtures` | n/a (repo tree query) | `rg --files python/tests/fixtures | rg 'epub'` returned no matches during PR-07 authoring, indicating no current real `.epub` test corpus. | Added PR-07 deliverables for `python/tests/fixtures/epub/`, provenance README, and `python/tests/test_epub_ingest_real_fixtures.py` smoke coverage. |

## notes
- Phase 1 skeleton completed first across `s5_pr07.md`, `s5_pr07_decisions.md`, and `s5_pr07_worklog.md`.
- Phase 2 acceptance-cluster micro-loop was applied to the three PR-07 roadmap bullets by decomposing bullet 1 into S5 scenarios 1-15 plus non-scenario rows from `docs/v1/s5/s5_roadmap.md`.
- User-approved hardening strategy decisions captured during authoring:
  - make scenarios 1, 11, and 12 mandatory automated coverage in PR-07;
  - verify scenario 11 via contract-state transition tests (no new embedding pipeline in PR-07);
  - verify retry cleanup against current persisted EPUB artifact inventory;
  - explicitly assign future production embedding pipeline/orchestration and persisted embedding artifact cleanup to S9.
- Legacy EPUB-spec review integrated as PR-07 hardening refinements (no scope expansion):
  - explicit anti-regression traceability for extension-spoof rejection and retry source identity preservation;
  - explicit sanitization-assertion emphasis for scenario 9 evidence;
  - explicit CSS isolation/rendering architecture non-goal.
- User-approved testing-strategy refinements integrated into PR-07 docs:
  - integration-first (testing-trophy) bias for hardening coverage;
  - externals-only mocking default with targeted frontend de-mocking/partial-mock guidance;
  - small real EPUB fixture smoke corpus added in addition to existing synthetic builders.
- Hardening pass targets for final review:
  - roadmap completeness (all scenarios + non-scenario PR-07 rows mapped);
  - dependency sanity (PR-03/05/06 merged-state evidence only);
  - boundary cleanup (no feature expansion, no S9 work in PR-07);
  - ambiguity cleanup (exact tests for remaining gaps; implementation report requirement for freeze review).

## unresolved items
- none.
