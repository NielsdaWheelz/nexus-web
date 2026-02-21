# s5 pr-04 worklog

## purpose
Capture bounded-context evidence gathered while authoring `docs/v1/s5/s5_prs/s5_pr04.md`.

## acceptance checklist (source: `docs/v1/s5/s5_roadmap.md`)
- [x] `GET /media/{id}/chapters` returns metadata-only chapter manifest with deterministic cursor pagination.
- [x] `GET /media/{id}/chapters/{idx}` returns chapter payload with deterministic `prev_idx`/`next_idx`.
- [x] `GET /media/{id}/toc` returns deterministic nested TOC tree ordering by `order_key`.
- [x] Visibility masking, readiness guards, and non-EPUB kind guards are enforced exactly per contract.
- [x] Matching browser-path BFF transport exists for all new non-streaming EPUB read endpoints introduced in this PR.

## evidence log

| id | acceptance item | file | lines | evidence | impact on spec |
|---|---|---|---|---|---|
| e-001 | PR-04 roadmap scope | `docs/v1/s5/s5_roadmap.md` | 115-126 | PR-04 goal/acceptance/non-goals are explicit and bounded to read endpoints + BFF parity. | Locked singular PR-04 scope and prevented PR-05/PR-06 behavior leakage. |
| e-002 | PR ownership boundary | `docs/v1/s5/s5_roadmap_ownership.md` | 20 | C5 cluster is owned by PR-04 and includes pagination/guards/BFF parity. | Drove dedicated read-service ownership and explicit non-goals for lifecycle/extraction/UX. |
| e-003 | `/chapters` contract | `docs/v1/s5/s5_spec.md` | 462-503 | L2 defines metadata-only manifest, integer cursor semantics, and required errors. | Anchored list-endpoint deliverables and pagination/error test requirements. |
| e-004 | `/chapters/{idx}` contract | `docs/v1/s5/s5_spec.md` | 504-540 | L2 defines full chapter payload, deterministic navigation pointers, and `E_CHAPTER_NOT_FOUND`. | Anchored chapter-detail behavior and deterministic pointer tests. |
| e-005 | `/toc` contract | `docs/v1/s5/s5_spec.md` | 542-588 | L2 defines nested deterministic tree output and zero-row TOC success behavior. | Anchored TOC tree materialization and empty-TOC non-fatal behavior. |
| e-006 | read-endpoint invariants | `docs/v1/s5/s5_spec.md` | 665-674 | L2 invariants enforce deterministic ordering/navigation, visibility masking, metadata-only manifest, toc-summary mapping, and pagination envelope. | Drove guard ordering, summary derivation rules, and metadata-only assertions. |
| e-007 | scenario coverage target | `docs/v1/s5/s5_spec.md` | 700-704, 716-724, 746-749 | Scenarios 4, 7, 8, 13 explicitly test visibility, navigation determinism, TOC determinism, and kind guards. | Ensured each scenario maps directly into named acceptance tests. |
| e-008 | existing backend media routes | `python/nexus/api/routes/media.py` | 141-153, 190-243, 246-265 | Backend has fragments/ingest/retry/assets but no chapter/toc read routes. | Confirmed PR-04 introduces additive read routes without replacing existing surfaces. |
| e-009 | existing guard pattern reference | `python/nexus/services/media.py` | 393-440 | EPUB asset read path already applies visibility + kind + readiness + request validation guards. | Reused proven guard structure for chapter/toc read services. |
| e-010 | route structure constraints | `python/tests/test_route_structure.py` | 1-70 | Route handlers must remain transport-only and service-owned; raw DB usage in routes is forbidden. | Forced route deliverables to one-service-call handlers and prevented policy logic in routes. |
| e-011 | request-topology hard constraint | `docs/v1/constitution.md` | 111-133 | Non-streaming browser requests must go through Next.js BFF proxy; no direct FastAPI browser path exception. | Made BFF parity mandatory in same PR as backend endpoint surface. |
| e-012 | existing media BFF pattern | `apps/web/src/app/api/media/[id]/route.ts`; `apps/web/src/app/api/media/[id]/fragments/route.ts`; `apps/web/src/app/api/media/[id]/file/route.ts`; `apps/web/src/app/api/media/[id]/ingest/route.ts` | 1-10; 1-10; 1-10; 1-10 | Existing media BFF routes are thin `proxyToFastAPI` transport wrappers. | Set concrete implementation pattern for new chapter/toc BFF routes. |
| e-013 | existing web route-test pattern | `apps/web/src/app/api/libraries/invites-routes.test.ts` | 1-82 | Vitest route tests mock `proxyToFastAPI` and assert exact upstream paths. | Determined test shape for new media chapter/toc BFF route-proxy tests. |
| e-014 | error taxonomy already available | `python/nexus/errors.py` | 92-97, 117-201 | `E_CHAPTER_NOT_FOUND`, `E_INVALID_KIND`, `E_MEDIA_NOT_READY`, and `E_INVALID_REQUEST` mappings already exist. | Confirmed PR-04 uses existing error primitives only; no error-taxonomy expansion needed. |
| e-015 | legacy performance risk signal | `docs/old-documents-specs/EPUB_SPEC.md` | 129-150 | Legacy model stored/read large concatenated EPUB HTML blobs; explicit note warns against over-fetching full content for non-rendering use-cases. | Added PR-04 requirement that `/chapters` uses summary-only projection and does not fetch heavy content columns. |
| e-016 | legacy single-blob architecture risk | `docs/old-documents-specs/EPUB_SPEC.md` | 274-287, 304-310 | Legacy implementation concatenated all chapters and lacked chapter navigation boundaries. | Added anti-regression contract/test: `/chapters/{idx}` is strictly single-chapter scoped, never concatenated multi-chapter payload. |
| e-017 | legacy TOC/noise mapping risk | `docs/old-documents-specs/EPUB_SPEC.md`; `docs/v1/s5/s5_spec.md` | 304-310; 162-175, 673 | Legacy lacked deterministic chapter-to-TOC behavior; current L2 requires deterministic `primary_toc_node_id`. | Added explicit PR-04 test for multi-mapped TOC nodes selecting minimum `order_key` as primary node. |

## notes
- Phase 1 skeleton completed first across spec/decisions/worklog docs.
- Phase 2 acceptance-cluster micro-loop completed for all five PR-04 acceptance bullets.
- Legacy EPUB spec comparison hardening applied:
  - explicit out-of-range cursor exhausted-page semantics
  - explicit summary-only projection requirement for `/chapters`
  - explicit projection-verification test requirement to enforce summary-only query behavior
  - explicit single-chapter (non-concatenated) payload guard for `/chapters/{idx}`
  - explicit multi-mapped TOC deterministic primary-node coverage
  - explicit BFF query-forwarding assertion for chapter list route
- Hardening pass completed:
  - roadmap completeness: every PR-04 acceptance bullet mapped to deliverables/tests.
  - dependency sanity: PR-04 references only merged PR-01..PR-03 contracts/artifacts.
  - boundary cleanup: no PR-05 UX or PR-06 highlight/chat behavior added.
  - ambiguity cleanup: deterministic guard, pagination, and TOC tree-materialization semantics specified.
  - implementation readiness: deliverables/tests are executable without follow-up scope clarification.

## unresolved items
- none.
