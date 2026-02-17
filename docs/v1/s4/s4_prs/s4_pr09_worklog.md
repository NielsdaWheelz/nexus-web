# s4 pr-09 worklog

## purpose
capture bounded-context evidence gathered while authoring `s4_pr09.md`.

## acceptance checklist (source: `docs/v1/s4/s4_roadmap.md`)
- [x] s4 scenarios 1-15 are each mapped to at least one automated test, with traceability table in this pr description.
- [x] route structure constraints still pass (`python/tests/test_route_structure.py`).
- [x] compatibility audit confirms:
  - [x] conversation/message list limits unchanged (`50`, bounds `1..100`)
  - [x] search response shape unchanged
  - [x] additive-only response evolution honored
- [x] helper retirement audit confirms no stale duplicate visibility helpers remain.
- [x] drift triage is explicit and enforced:
  - [x] blocking drift fixed minimally in pr-09.
  - [x] non-blocking feature churn reassigned to owner prs with roadmap pointer updates.
- [x] short handoff note lists final l4 spec inputs per pr (files, invariants, tests, non-goals).

## evidence log
| id | acceptance item | file | lines | evidence | impact on spec |
|---|---|---|---|---|---|
| e-001 | pr-09 acceptance extraction and hardening scope | `docs/v1/s4/s4_roadmap.md` | 341-362 | pr-09 owns hardening, acceptance matrix, compatibility/helper audits, and handoff gate; non-goals forbid product-surface changes. | seeded pr-09 scope and non-goals; blocked feature-scope expansion. |
| e-002 | drift triage policy requires explicit blocking-vs-owner-pr split | `docs/v1/s4/s4_roadmap.md` | 355-358 | roadmap now explicitly distinguishes minimal blocking fixes vs feature churn reassignment. | added deliverable + decision requirements for reassignment logging and roadmap pointers. |
| e-003 | s4 requires explicit scenario-coverage mapping | `docs/v1/s4/s4_spec.md` | 1009-1215 | scenarios 1-15 are normative acceptance contracts. | required `s4_pr09_acceptance_matrix.md` artifact and per-scenario test mapping. |
| e-004 | helper centralization and stale-helper retirement are explicit slice constraints | `docs/v1/s4/s4_spec.md` | 1234-1235 | canonical conversation visibility must be centralized; stale duplicate helpers forbidden by slice end. | required dedicated helper-retirement audit test module. |
| e-005 | route-structure contract already has deterministic static suite | `python/tests/test_route_structure.py` | 80-240 | route import/db-access/handler structure constraints are encoded as tests. | route-structure pass is retained as a hard pr-09 gate; no route-surface churn in scope. |
| e-006 | conversation/message limit compatibility contract is still encoded in route/service | `python/nexus/api/routes/conversations.py`; `python/nexus/services/conversations.py` | routes 49,209; service 35-37 | limits remain default `50`, bounds `1..100` at both route and service layers. | required static/introspection compatibility tests in `test_s4_compatibility_audit.py`. |
| e-007 | `/search` shape compatibility already has runtime proof | `python/tests/test_search.py` | 1065-1091 | existing test verifies top-level `{results,page}` and no envelope wrapper. | reused as runtime compatibility gate in traceability matrix. |
| e-008 | additive schema fields are already asserted in integration tests | `python/tests/test_conversations.py`; `python/tests/test_highlights.py` | conv 667-700, 903-907; hl 1176-1178, 1506-1560 | tests assert `owner_user_id/is_owner` and `author_user_id/is_owner` across response paths. | compatibility audit includes schema-field-presence tests to prevent field regressions. |
| e-009 | split visibility helpers are present in canonical service modules | `python/nexus/services/conversations.py`; `python/nexus/services/highlights.py` | conv 127-159; hl 124-157 | both conversation and highlight services expose visible-read and write-only helper split surfaces. | helper-retirement audit requires split surfaces remain present. |
| e-010 | search scope auth is already wired to canonical read helper | `python/nexus/services/search.py` | 153-177 | conversation scope auth uses `can_read_conversation(...)`; owner-write helper is absent from search path. | helper-retirement audit includes explicit source check for this invariant. |
| e-011 | deprecated helper names are absent from python codebase | `python/` | rg result: no matches | `get_conversation_for_viewer_or_404` and `get_highlight_for_viewer_or_404` do not appear under `python/`. | helper-retirement audit adds deterministic regression guard for symbol reintroduction. |
| e-012 | scenario 11 ordering contract has stability coverage but not strict mixed-visibility sort-key assertion | `python/tests/test_conversations.py` | 991-1035 | current scope=all test checks no duplicates/skips via cursor traversal; it does not explicitly assert `updated_at DESC, id DESC` on mixed visibility rows. | defined one blocking-gap test addition in pr-09 for explicit ordering assertion. |
| e-013 | scenario-specific contracts are already broadly covered in owner-pr tests | `python/tests/test_libraries.py`; `python/tests/test_shares.py`; `python/tests/test_conversations.py`; `python/tests/test_highlights.py`; `python/tests/test_search.py`; `python/tests/test_visibility_helpers.py` | libs 1214, 2078, 2327, 2724, 2762, 3058, 3169, 3401; shares 495-514; conv 883-985; hl 1069-1375; search 764-1060; visibility 187-267, 299-328 | existing coverage maps to scenarios 1-10 and 12-15, with scenario 11 ordering gap identified separately. | matrix deliverable can anchor mostly existing tests; only scenario 11 requires new blocking test. |
| e-014 | legacy share service path still allows default-library targets despite s4 prohibition | `python/nexus/services/shares.py`; `python/tests/test_shares.py` | service 69-170, 257-316; tests 131-140 | service-layer `set_sharing_mode(..., library_ids=[default_library_id])` test currently succeeds; prohibition is only enforced in owner route path tests. | added blocking-drift deliverable to patch legacy service entry points and replace contradictory service tests. |
| e-015 | route-level prohibition exists but does not protect all callable service surfaces | `python/tests/test_shares.py` | 495-514 | route-level `PUT /conversations/{id}/shares` correctly returns `E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN`. | confirms mismatch is cross-surface consistency drift, not missing contract definition. |
| e-016 | stale module docstrings still claim pre-s4 owner-only read semantics | `python/nexus/services/conversations.py`; `python/nexus/services/highlights.py` | conv 1-10; hl 1-12 | headers describe owner-only read semantics that no longer match merged behavior. | scoped behavior-neutral docstring cleanup in pr-09 hardening deliverables. |
| e-017 | drift-triage reassignment lane is process evidence, not a pure runtime assertion | `docs/v1/s4/s4_prs/s4_pr09.md`; `docs/v1/s4/s4_roadmap.md` | pr09 traceability row; roadmap 355-358 | automated tests can gate blocking technical drift; reassignment proof must be doc-gated via handoff + roadmap pointers. | updated pr-09 traceability wording to avoid test-overclaim and require explicit doc review gate. |

## notes
- phase 1 complete: pr-09 skeleton drafted with explicit hardening-only boundary.
- phase 2 complete: acceptance clusters expanded into matrix, compatibility audit, helper-retirement audit, and handoff artifacts.
- phase 2 gap findings:
  - scenario 11 strict order assertion under `scope=all` requires one new minimal test.
  - legacy share-service default-library target prohibition is inconsistent with s4 and must be closed as blocking drift.
- phase 3 completeness pass complete: every l3 pr-09 acceptance bullet maps to at least one deliverable + test.
- phase 3 boundary pass complete: no new product surfaces or non-audit refactors were included.
- roadmap was patched to codify drift triage policy before finalizing l4 spec.
