# s5 pr-03 worklog

## purpose
Capture bounded-context evidence gathered while authoring `docs/v1/s5/s5_prs/s5_pr03.md`.

## acceptance checklist (source: `docs/v1/s5/s5_roadmap.md`)
- [x] Upload-init/ingest EPUB behavior conforms to S5 request/response/error contracts without breaking existing duplicate-client compatibility.
- [x] `POST /media/{media_id}/ingest` exposes EPUB-ready dispatch/status semantics while preserving existing duplicate behavior compatibility.
- [x] Repeat `POST /media/{media_id}/ingest` on non-duplicate media is idempotent after dispatch/state advance (no redispatch, no attempt inflation).
- [x] Processing transitions (`pending -> extracting -> ready_for_reading`, embedding paths, and failure transitions) follow S5 contract.
- [x] `POST /media/{media_id}/retry` enforces legal-state preconditions and full artifact cleanup before re-extraction.
- [x] Retry enforces source-integrity preconditions before cleanup/reset; precondition failures are deterministic and non-mutating.
- [x] Retry for terminal archive failures is rejected with `409 E_RETRY_NOT_ALLOWED`.

## evidence log

| id | acceptance item | file | lines | evidence | impact on spec |
|---|---|---|---|---|---|
| e-001 | PR-03 roadmap scope | `docs/v1/s5/s5_roadmap.md` | 99-110 | PR-03 owns EPUB ingest/retry lifecycle semantics; chapter/toc APIs are non-goals. | Locked singular PR-03 goal and prevented PR-04 scope leakage. |
| e-002 | C4 ownership boundary | `docs/v1/s5/s5_roadmap_ownership.md` | 19 | C4 cluster explicitly owns upload-init/ingest/retry lifecycle and cleanup/reset semantics. | Drove dedicated lifecycle service ownership and boundary wording. |
| e-003 | L2 state-machine guards | `docs/v1/s5/s5_spec.md` | 295-327 | Explicit transitions and retry-entry guards (`failed`, non-terminal error, artifact cleanup). | Anchored retry preconditions and state transition requirements. |
| e-004 | Ingest API contract | `docs/v1/s5/s5_spec.md` | 373-412 | `/ingest` response requires `{media_id, duplicate, processing_status, ingest_enqueued}` with duplicate compatibility semantics. | Drove schema/route/service response-shape deliverables and compatibility tests. |
| e-005 | Retry API contract | `docs/v1/s5/s5_spec.md` | 413-447 | `/retry` requires 202 response, legal-state guards, cleanup/reset semantics, and explicit error codes. | Drove new retry route/service deliverables and guard/cleanup test set. |
| e-006 | Terminal archive failure policy | `docs/v1/s5/s5_spec.md` | 286-288, 432, 445-446, 663 | `E_ARCHIVE_UNSAFE` is terminal for retry (`409 E_RETRY_NOT_ALLOWED`). | Locked terminal retry-block decision and no-mutation test requirement. |
| e-007 | Existing ingest implementation baseline | `python/nexus/api/routes/media.py`; `python/nexus/services/upload.py`; `python/nexus/schemas/media.py` | 190-212; 230-433; 89-94 | Current ingest endpoint still returns S1 `{media_id, duplicate}` and lacks PR-03 lifecycle dispatch semantics. | Established required delta in PR-03 deliverables. |
| e-008 | No retry endpoint exists yet | `python/nexus/api/routes/media.py` | 1-245 | No `/media/{id}/retry` route currently present. | Justified explicit retry route addition in PR-03 scope. |
| e-009 | PR-02 extraction boundary | `python/nexus/tasks/ingest_epub.py` | 1-119 | Extractor task returns structured outcomes and explicitly avoids lifecycle mutation ownership. | Reinforced C3/C4 split: PR-03 maps lifecycle around PR-02 outcomes. |
| e-010 | Existing upload validation + dedupe primitives | `python/nexus/services/upload.py` | 256-433 | File presence/magic/size/sha/dedupe behavior already implemented and race-aware. | Drove reuse/refactor strategy instead of duplicating validation logic. |
| e-011 | Existing strict response-shape regression from PR-02 | `python/tests/test_upload.py` | 841-871 | Test enforces exact ingest keys `{media_id, duplicate}`. | Triggered explicit PR-03 decision to replace strict-key assertion with compatibility semantics tests. |
| e-012 | Route architecture guardrails | `python/tests/test_route_structure.py` | 1-230 | Routes must remain transport-only with no raw DB/domain logic. | Constrained PR-03 route design to one-service-call handlers. |
| e-013 | Error registry baseline | `python/nexus/errors.py`; `python/tests/test_errors.py` | 93-96, 183-186; 115-118 | `E_RETRY_INVALID_STATE`, `E_RETRY_NOT_ALLOWED`, `E_ARCHIVE_UNSAFE` mappings are already stable. | Allowed PR-03 to consume existing error primitives without taxonomy changes. |
| e-014 | Task routing baseline | `python/nexus/celery.py`; `apps/worker/main.py` | 37-41; 31-33 | Queue routes/worker registration include web ingest but not explicit `ingest_epub` wiring. | Drove PR-03 deliverables to lock deterministic EPUB task routing and worker registration. |
| e-015 | Async completion transition baseline | `python/nexus/tasks/ingest_epub.py`; `python/nexus/tasks/ingest_web_article.py` | 27-95; 119-216 | `ingest_epub` currently returns structured outcomes but does not own lifecycle completion transitions, while `ingest_web_article` demonstrates authoritative task-owned completion transitions. | Drove PR-03 decision to make `ingest_epub` the completion-state authority for async EPUB runs. |
| e-016 | Enqueue failure behavior baseline | `python/nexus/services/media.py` | 270-311 | Existing enqueue helper logs and returns `False` on dispatch exception, which can mask operational failure if used after lifecycle mutation. | Drove PR-03 decision to treat dispatch failure as transactional failure with lifecycle rollback and deterministic server error. |
| e-017 | Legacy EPUB detection fallback risk | `docs/old-documents-specs/EPUB_SPEC.md` | 11-14 | Legacy spec allowed extension fallback (`.epub`) classification. | Drove PR-03 explicit byte-trust rule: MIME+magic authoritative, no extension fallback. |
| e-018 | Legacy source-deletion retry risk | `docs/old-documents-specs/EPUB_SPEC.md` | 84-90, 316-318 | Legacy flow deleted original EPUB after processing, creating reprocessing/retry fragility. | Drove PR-03 source-integrity precondition before retry cleanup/reset and no-mutation failure behavior. |
| e-019 | Existing byte-validation authority in upload path | `python/nexus/services/upload.py` | 201-334 | Upload confirm already enforces streamed magic-byte + size validation from source bytes. | Drove PR-03 requirement to reuse this validation seam for retry source-integrity checks and ingest anti-spoof guarantees. |

## notes
- Phase 1 skeleton completed first across spec/decisions/worklog docs.
- Phase 2 acceptance-cluster micro-loop completed for all seven PR-03 acceptance bullets.
- Explicit approvals captured during authoring:
  - Async extraction + synchronous preflight gate design for `/ingest`.
  - Shared archive-safety validator seam to prevent drift.
  - Dedicated `epub_lifecycle` service module as C4 boundary owner.
  - `ingest_epub` task as authoritative completion-state owner for async EPUB lifecycle transitions.
  - Dispatch-failure rollback policy (no stuck `extracting` state and no false-positive enqueue success).
  - Old-spec integration hardening additions:
    - retry source-integrity precondition before cleanup/reset.
    - idempotent ingest re-entry behavior with no redispatch/attempt inflation.
    - explicit rejection of extension-only EPUB classification.
- Hardening pass completed:
  - roadmap completeness: every PR-03 acceptance bullet mapped to deliverables/tests.
  - dependency sanity: only PR-01/PR-02 merged primitives referenced.
  - boundary cleanup: no PR-02 extraction-contract redefinition and no PR-04 read-endpoint behavior included.
  - ambiguity cleanup: deterministic guard, cleanup, and terminal-retry semantics specified with explicit error codes.
  - acceptance-spec consistency cleanup: added missing dispatch-failure rollback tests to acceptance-tests section and made retry success status explicit (`202`).
  - implementation readiness: deliverables/tests are executable by a junior implementer without hidden assumptions.

## unresolved items
- none.
