# PR-07 implementation report: s5 hardening + acceptance freeze

## summary of changes

PR-07 closes Slice 5 with explicit automated acceptance coverage for all 15 S5 scenarios, non-scenario coverage rows, and invariant/error audit traceability. No product scope was expanded. No production code was changed.

### new files
- `python/tests/test_epub_ingest_real_fixtures.py` — real-EPUB smoke suite (5 parameterized tests).
- `python/tests/fixtures/epub/` — 10 EPUB fixture files: 8 Project Gutenberg public-domain books (4 titles × epub2/epub3, 319K–821K each) + 2 synthetic edge-case files (sanitization, unicode). `README.md` documents provenance/license.

### modified files
- `python/tests/test_media.py` — 3 new hardening tests + 1 extended test.
- `python/tests/test_epub_ingest.py` — strengthened active-content sanitization assertions in `test_resource_rewriting`.
- `apps/web/src/app/(authenticated)/media/[id]/page.test.tsx` — HtmlRenderer mock uses `dangerouslySetInnerHTML` to exercise real rendering path; strengthened DOM assertions.
- `apps/web/src/app/(authenticated)/conversations/page.test.tsx` — full send lifecycle simulation with `router.replace` and navigation assertions.
- `apps/web/src/app/(authenticated)/conversations/[id]/page.test.tsx` — full send lifecycle simulation with `router.replace` assertions for attach param cleanup.

### no production code changes
Zero changes to `python/nexus/`, `apps/web/src/` (non-test), or any public API surface. This is hardening-only.

---

## problems encountered

1. **`DATABASE_URL` not set for direct pytest invocation.** The `Makefile` sets this env var, but running `pytest` directly required explicit `DATABASE_URL=...` on the command line. Resolved by passing it explicitly for targeted test runs.

2. **ESLint `react/no-danger` in test mock.** The strengthened `HtmlRenderer` mock uses `dangerouslySetInnerHTML` to mirror real component behavior. `eslint-disable-next-line` didn't reach the prop line in multi-line JSX. Resolved with block-level `/* eslint-disable react/no-danger */` / `/* eslint-enable */` scoped to the mock definition.

3. **Unused variable in conversation detail test.** The strengthened send lifecycle test left a `result` variable from the original `render()` call. Removed.

4. **Python formatting drift.** New/modified test files needed `ruff format`. Applied.

---

## solutions implemented

| problem | solution |
|---|---|
| Scenario 1 immutability gap | `test_epub_chapter_fragments_immutable_across_reads_and_highlight_churn` — repeated reads + highlight create/delete, byte-for-byte fragment comparison |
| Scenario 11 embedding path gap | `test_epub_fragment_content_stable_across_embedding_status_transition` — controlled status transitions `ready_for_reading → embedding → ready`, read endpoint accessibility + fragment immutability |
| Scenario 12 retry cleanup gap | `test_retry_epub_failed_clears_persisted_epub_artifacts_before_dispatch` — seeds artifacts, retries, asserts all 3 artifact tables emptied |
| Retry precondition artifact preservation | Extended `test_retry_source_integrity_precondition_failure_no_mutation` — seeds artifacts, forces precondition failure, asserts artifacts + media row unchanged |
| No real EPUB fixture coverage | New `test_epub_ingest_real_fixtures.py` with 4-file corpus: epub2/ncx, epub3/nav, epub3/assets, epub3/unicode |
| Active-content sanitization assertions weak | Strengthened `test_resource_rewriting` with `<script>`, `onclick`, `onerror`, `javascript:` URL assertions |
| HtmlRenderer mock hides rendering bugs | Mock now uses `dangerouslySetInnerHTML` so DOM assertions exercise real HTML injection path |
| Attach-handoff tests only check chip presence | Both conversation page tests now simulate full send lifecycle through `apiFetch` mock → `onConversationCreated`/`onMessageSent` → `router.replace` assertions |

---

## decisions made

| decision | rationale |
|---|---|
| No production code changes | All S5 contracts pass as-is. Hardening is test-only. |
| Controlled status updates for scenario 11 | Direct DB status mutation avoids building embedding pipeline (S9 scope). Tests verify read-path contracts and fragment immutability across state transitions. |
| Block-level eslint disable for `react/no-danger` in test | Scoped to mock definition only. The real `HtmlRenderer` component already uses `dangerouslySetInnerHTML` with server-sanitized content; the mock must match. |
| Real EPUB fixtures from Project Gutenberg | Public domain, documented provenance (PG catalog numbers). 8 real books exercise real tool-chain parser paths; 2 synthetic files retained for active-content sanitization and unicode edge cases not present in real books. |
| Synthetic builders remain primary edge-case harness | Real fixtures complement but don't replace synthetic builders. Builders cover malformed archives, failure injection, and classification edge cases that real EPUBs can't represent deterministically. |
| Reuse existing PR-03–PR-06 tests as freeze evidence | Avoids redundant test suites. Traceability matrix explicitly maps existing tests to scenarios. |

---

## deviations from l4/l3/l2

None. All implementation follows the PR-07 spec as written. No contract drift was discovered during hardening.

---

## commands to run new/changed behavior

```bash
# new backend hardening tests (test_media.py additions)
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test \
  uv run pytest tests/test_media.py -k "immutable or embedding_status or clears_persisted or source_integrity" -v

# new real EPUB fixture smoke suite
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test \
  uv run pytest tests/test_epub_ingest_real_fixtures.py -v

# strengthened extraction sanitization test
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test \
  uv run pytest tests/test_epub_ingest.py::TestResourceRewriting -v

# strengthened frontend tests
cd apps/web && npx vitest run src/app/\(authenticated\)/media/\[id\]/page.test.tsx --reporter=verbose
cd apps/web && npx vitest run src/app/\(authenticated\)/conversations/page.test.tsx --reporter=verbose
cd apps/web && npx vitest run src/app/\(authenticated\)/conversations/\[id\]/page.test.tsx --reporter=verbose
```

---

## verification commands

```bash
# full verification (lint + format + type-check + all tests)
make verify
```

Result: all checks pass (exit 0). 333 frontend tests, 45 backend `test_media.py` tests, 16 `test_epub_ingest.py` tests, 19 `test_epub_ingest_real_fixtures.py` tests (8 real books + 2 synthetic + 9 sanitization checks). Zero lint errors (pre-existing `layout.tsx` font warning excluded).

---

## traceability table

| acceptance item | file(s) | test(s) | status |
|---|---|---|---|
| scenario 1: chapter fragment immutability | `test_media.py` | `test_epub_chapter_fragments_immutable_across_reads_and_highlight_churn` (new) | PASS |
| scenario 2: highlights scoped to fragment | `test_highlights.py` | `test_epub_highlight_scopes_to_target_fragment_only` (existing) | PASS |
| scenario 3: reuse all document logic | `test_highlights.py`, `test_send_message.py` | `test_epub_highlight_exact_prefix_suffix_derived_from_chapter_canonical_text`, `test_send_message_with_epub_highlight_context_renders_fragment_based_quote_context`, `test_send_message_with_epub_highlight_context_is_chapter_local_not_book_global`, `test_send_message_with_epub_highlight_context_not_visible_returns_404_e_not_found` (existing) | PASS |
| scenario 4: visibility suite | `test_media.py`, `media/[id]/page.test.tsx` | `test_get_epub_read_endpoints_visibility_masking`, `it("chapter fetch not-found shows masked not-found")` (existing) | PASS |
| scenario 5: processing-state suite | `test_upload.py`, `test_epub_ingest.py`, `test_epub_ingest_real_fixtures.py` | `test_ingest_epub_*` (existing), `test_extraction[*]` (new) | PASS |
| scenario 6: retry from failed extraction | `test_media.py` | `test_retry_epub_failed_resets_and_dispatches` (existing), `test_retry_epub_failed_clears_persisted_epub_artifacts_before_dispatch` (new), `test_retry_source_integrity_precondition_failure_no_mutation` (extended), `test_retry_dispatch_failure_rolls_back_state` (existing) | PASS |
| scenario 7: chapter navigation determinism | `test_media.py` | `test_paginate_chapters`, `test_navigation_pointers`, `test_nonexistent_idx`, `test_no_adjacent_content` (existing) | PASS |
| scenario 8: TOC persistence and mapping | `test_epub_ingest.py`, `test_epub_ingest_real_fixtures.py`, `test_media.py` | `test_epub3_nav_deterministic`, `test_epub2_ncx_deterministic` (existing), `test_extraction[*]` (new), `test_nested_toc_ordering`, `test_epub_without_toc`, `test_multiple_toc_nodes_same_chapter` (existing) | PASS |
| scenario 9: internal assets degrade safely | `test_epub_ingest.py`, `test_epub_ingest_real_fixtures.py`, `test_media.py` | `test_resource_rewriting` (strengthened), `test_assets_and_sanitization[epub3_assets.epub]` (new), `test_resolved_asset_returns_binary`, `test_missing_asset_returns_404`, `test_non_epub_returns_400`, `test_non_ready_epub_returns_409` (existing) | PASS |
| scenario 10: deterministic title fallback | `test_epub_ingest.py` | `test_missing_title_uses_filename`, `test_no_title_no_usable_filename`, `test_valid_dc_title_used` (existing) | PASS |
| scenario 11: embedding path transition | `test_media.py`, `media/[id]/page.test.tsx` | `test_epub_fragment_content_stable_across_embedding_status_transition` (new), `it("embedding status is readable")` (existing) | PASS |
| scenario 12: embedding-failure retry reset | `test_media.py` | `test_retry_epub_failed_clears_persisted_epub_artifacts_before_dispatch` (new), `test_retry_source_integrity_precondition_failure_no_mutation` (extended) | PASS |
| scenario 13: non-EPUB kind guards | `test_media.py` | `test_non_epub_returns_400` (chapters, TOC, assets), `test_retry_kind_guard_and_auth` (existing) | PASS |
| scenario 14: unsafe archive rejection | `test_epub_ingest.py`, `test_upload.py` | `test_path_traversal_rejected`, `test_oversized_entry_rejected`, `test_ingest_epub_archive_unsafe_fails_preflight_without_dispatch` (existing) | PASS |
| scenario 15: retry blocked for terminal archive failure | `test_media.py` | `test_retry_terminal_archive_failure_blocked` (existing) | PASS |
| 4.1: upload-init EPUB path | `test_upload.py` | `test_upload_init_epub_success`, `test_upload_init_invalid_content_type`, `test_upload_init_file_too_large` (existing) | PASS |
| 4.2: ingest backward-compat + idempotent re-entry | `test_upload.py` | `test_ingest_epub_response_includes_dispatch_status_compat_fields`, `test_ingest_epub_duplicate_preserves_compat_and_sets_ingest_enqueued_false`, `test_ingest_epub_repeat_call_is_idempotent_without_redispatch`, `test_ingest_epub_rejects_extension_only_spoofed_payload` (existing) | PASS |
| 4.3: retry source-integrity precondition | `test_media.py` | `test_retry_source_integrity_precondition_failure_no_mutation` (extended), `test_retry_preserves_source_identity_fields`, `test_retry_epub_failed_clears_persisted_epub_artifacts_before_dispatch` (new) | PASS |
| 4.7: media/highlight/chat compatibility | `test_media.py`, `test_highlights.py`, `test_send_message.py`, `conversations/page.test.tsx`, `conversations/[id]/page.test.tsx` | `test_get_fragments_epub_ready_returns_all_chapters_ordered_by_idx`, highlight compat tests, send-message compat tests, attach-context lifecycle tests (all existing + strengthened) | PASS |
| 4.8: internal asset safe fetch path | `test_epub_ingest.py`, `test_epub_ingest_real_fixtures.py`, `test_media.py` | `test_resource_rewriting` (strengthened), `test_assets_and_sanitization[epub3_assets.epub]` (new), asset route tests (existing) | PASS |
| 3.2: TOC artifact lifecycle incl. delete-on-retry | `test_epub_ingest.py`, `test_media.py` | `test_epub3_nav_deterministic`, `test_epub2_ncx_deterministic`, `test_retry_epub_failed_clears_persisted_epub_artifacts_before_dispatch` (new) | PASS |
| error-code status mapping conformance | `test_errors.py` | `test_error_code_maps_to_correct_status` (existing) | PASS |

---

## invariant/error-code audit summary

### extraction invariants
- **contiguous spine-order fragments**: asserted in `test_contiguous_fragments_and_blocks`, `test_extraction[*]` (real fixtures).
- **deterministic TOC snapshot**: asserted in `test_epub3_nav_deterministic`, `test_epub2_ncx_deterministic`, `test_extraction[*]`.
- **title fallback chain**: asserted in `test_missing_title_uses_filename`, `test_no_title_no_usable_filename`, `test_valid_dc_title_used`.
- **archive safety (path traversal, oversize)**: asserted in `test_path_traversal_rejected`, `test_oversized_entry_rejected`.
- **active-content sanitization**: asserted in `test_resource_rewriting` (`<script>`, `onclick`, `onerror`, `javascript:` URLs), `test_assets_and_sanitization[epub3_assets.epub]`.
- **no partial artifacts on failure**: asserted in `test_no_partial_artifacts_on_failure`.

### read invariants
- **fragment immutability post-ready**: asserted in `test_epub_chapter_fragments_immutable_across_reads_and_highlight_churn`.
- **fragment stability across embedding transitions**: asserted in `test_epub_fragment_content_stable_across_embedding_status_transition`.
- **visibility masking (404 for unauthorized)**: asserted in `test_unauthorized_viewer_gets_404`, `test_unreadable_user_gets_404`.
- **kind and readiness guards**: asserted in `test_non_epub_returns_400`, `test_non_ready_epub_returns_409` (chapters, TOC, assets).

### retry invariants
- **artifact cleanup before dispatch**: asserted in `test_retry_epub_failed_clears_persisted_epub_artifacts_before_dispatch` (fragments, fragment_blocks, epub_toc_nodes).
- **artifact preservation on precondition failure**: asserted in `test_retry_source_integrity_precondition_failure_no_mutation`.
- **source identity preservation**: asserted in `test_retry_preserves_source_identity_fields`.
- **terminal failure blocking**: asserted in `test_retry_terminal_archive_failure_blocked`.
- **dispatch failure rollback**: asserted in `test_retry_dispatch_failure_rolls_back_state`.

### S5 error codes
- `E_ARCHIVE_UNSAFE`, `E_MEDIA_NOT_READY`, `E_RETRY_NOT_ALLOWED`, `E_NOT_FOUND`, `E_STORAGE_MISSING`: all mapped through `test_error_code_maps_to_correct_status` and exercised in integration tests above.

---

## test strategy compliance

| criterion | status |
|---|---|
| integration-first / testing-trophy bias | All new tests are integration tests (real HTTP routes + DB for backend, full page render for frontend) |
| mocked externals list | backend: storage client, queue dispatch. frontend: `next/navigation`, `apiFetch`, SSE/token modules |
| avoided/reduced internal mocks | HtmlRenderer mock now uses `dangerouslySetInnerHTML` (mirrors real behavior); highlight module mocks retained where unavoidable but no new internal mocks added |
| real EPUB fixture corpus | 8 Project Gutenberg public-domain books (4 titles × epub2/epub3) + 2 synthetic edge-case files — documented in `README.md` |
| synthetic builders retained | All existing synthetic in-memory builder tests unchanged and passing |

---

## commit message

```
pr-07: s5 hardening + acceptance freeze — test-only

Close Slice 5 with explicit automated acceptance coverage for all 15
S5 scenarios, non-scenario coverage rows (4.1, 4.2, 4.3, 4.7, 4.8,
3.2), and invariant/error audit traceability. Zero production code
changes.

New backend tests (test_media.py):
- test_epub_chapter_fragments_immutable_across_reads_and_highlight_churn
  Scenario 1: byte-for-byte fragment immutability after repeated reads
  and highlight create/delete churn on a ready EPUB.
- test_epub_fragment_content_stable_across_embedding_status_transition
  Scenario 11: EPUB read endpoints remain accessible and fragment
  content unchanged across ready_for_reading → embedding → ready
  status transitions (contract-state verification, no embedding
  pipeline).
- test_retry_epub_failed_clears_persisted_epub_artifacts_before_dispatch
  Scenarios 6/12: explicit assertion that all persisted EPUB extraction
  artifacts (fragments, fragment_blocks, epub_toc_nodes) are deleted
  before retry dispatch completes.
- Extended test_retry_source_integrity_precondition_failure_no_mutation
  with artifact-preservation assertions (seeds artifacts, forces
  precondition failure, asserts artifacts + media row unchanged).

Real EPUB fixture corpus (python/tests/fixtures/epub/):
- 8 Project Gutenberg public-domain books (Confessions, Zarathustra,
  Moby Dick, City of God — each in EPUB2 and EPUB3 variants). Cover
  images, CSS, NCX/nav TOC structures from real tool chains.
- 2 synthetic edge-case fixtures retained (active-content sanitization,
  unicode) for scenarios real books don't naturally exercise.
- test_epub_ingest_real_fixtures.py: 19 parameterized tests exercising
  run_epub_ingest_sync end-to-end with no internal mocks. Asserts S5
  contract minimums (contiguous chapters, title, TOC, sanitization).

Strengthened existing tests:
- test_epub_ingest.py test_resource_rewriting: added assertions for
  <script> stripping, onclick/onerror handler removal, javascript:
  URL neutralization.
- media/[id]/page.test.tsx: HtmlRenderer mock uses
  dangerouslySetInnerHTML to exercise real rendering path; DOM
  assertions verify server-sanitized HTML reaches the DOM.
- conversations/page.test.tsx: send lifecycle simulates full
  apiFetch → onConversationCreated → router.replace flow; asserts
  attach params stripped from URL.
- conversations/[id]/page.test.tsx: send lifecycle simulates full
  apiFetch → onMessageSent → router.replace flow; asserts attach
  params stripped from URL.

All tests pass via `make verify` (333 frontend, 45 test_media,
16 test_epub_ingest, 19 test_epub_ingest_real_fixtures). Zero lint
errors. No contract drift found. No production code changes. No
out-of-scope work. S9 embedding pipeline ownership boundary intact.
```
