# Slice 5 (EPUB) - PR Roadmap

Implements `docs/v1/s5/s5_spec.md` in a merge-safe sequence.

## Baseline We Are Building From

- Upload init and confirm-ingest already exist for file-backed media, but confirm-ingest currently returns only duplicate identity semantics.
- There is no public EPUB retry endpoint today.
- There is no EPUB chapter/TOC read API surface today.
- Browser reader flow currently assumes single-fragment document rendering.

## Locked Pre-L4 Decisions

1. S5 remains upload-first; EPUB/PDF URL ingestion stays deferred to v2.
2. New non-streaming EPUB read endpoints must include browser-path BFF transport in the same PR that introduces the endpoint contract.
3. PR-07 is hardening-only; it may fix blocking drift but may not expand product surface.
4. If implementation uncovers L2 contract drift, fix L2/L3 first, then regenerate impacted L4 docs.

## 1. Dependency Graph

```text
PR-01 -> PR-02 -> PR-03 -> PR-04
                           |      \
                           v       v
                         PR-05    PR-06
                           \       /
                            v     v
                              PR-07
```

## 2. Ownership Matrix

| contract cluster (from L2) | owning pr |
|---|---|
| `epub_toc_nodes` persistence contract and deterministic `order_key` storage constraints (sections 2.2, 6.4, 6.13) | PR-01 |
| S5 API/error primitive contract registration (`E_RETRY_INVALID_STATE`, `E_RETRY_NOT_ALLOWED`, `E_CHAPTER_NOT_FOUND`, archive-safety error usage) (section 5) | PR-01 |
| EPUB extraction artifact pipeline: spine-order chapter fragments, fragment block generation, TOC snapshot materialization, title fallback, resource rewrite + safe degradation, internal asset persistence + safe fetch path (`/media/{id}/assets/{asset_key}`), archive safety validation (sections 2.1-2.6, 3.1 guards, 4.8, 6.1-6.3, 6.12, 6.15-6.17) | PR-02 |
| Upload-init/ingest/retry lifecycle behavior for EPUB, including cleanup/reset and terminal retry blocking semantics (sections 3.1, 4.1-4.3, 6.10, 6.16) | PR-03 |
| EPUB chapter and TOC read API contract (`/chapters`, `/chapters/{idx}`, `/toc`), including deterministic ordering, pagination envelope, visibility/readiness/kind guards, and BFF transport parity for browser path (sections 4.4-4.6, 6.5, 6.9, 6.11, 6.13-6.14) | PR-04 |
| EPUB reader baseline adoption (chapter-first navigation behavior in UI flows) | PR-05 |
| Existing endpoint compatibility and reuse of highlight/quote-to-chat semantics on EPUB fragments (section 4.7, invariants 6.6-6.8) | PR-06 |
| End-to-end acceptance closure, invariants audit, and freeze gate for Slice 5 (sections 6-8) | PR-07 |

## 3. Acceptance Coverage Map

| L2 acceptance scenario | owning PR(s) |
|---|---|
| 1. chapter fragment immutability | PR-02, PR-07 |
| 2. highlights scoped to fragment | PR-06 |
| 3. reuse all document logic | PR-06 |
| 4. visibility test suite passes for new EPUB endpoints | PR-04, PR-07 |
| 5. processing-state suite passes for EPUB | PR-03 |
| 6. retry from failed extraction | PR-03 |
| 7. chapter navigation determinism | PR-04 |
| 8. TOC persistence and mapping | PR-02, PR-04 |
| 9. unresolved internal assets degrade safely | PR-02 |
| 10. deterministic title fallback | PR-02 |
| 11. embedding path transition coverage | PR-03 |
| 12. embedding-failure retry reset | PR-03 |
| 13. non-epub kind guards on chapter/toc endpoints | PR-04 |
| 14. unsafe archive rejection | PR-02, PR-03 |
| 15. retry blocked for terminal archive failure | PR-03 |

## 3.1 Non-Scenario Contract Coverage

| L2 contract surface not directly named in scenarios | owning PR(s) |
|---|---|
| 4.1 `POST /media/upload/init` EPUB path conformance | PR-03, PR-07 |
| 4.2 backward-compat semantics for existing ingest clients (`media_id`, `duplicate`) | PR-03, PR-07 |
| 4.7 existing endpoint compatibility (`/media/{id}/fragments`, highlights, quote-to-chat) | PR-06, PR-07 |
| 4.8 EPUB internal asset safe fetch path contract (`/media/{id}/assets/{asset_key}`) | PR-02, PR-07 |
| 3.2 TOC artifact lifecycle (`absent -> materialized -> immutable -> deleted on retry`) | PR-02, PR-03, PR-07 |

## 4. PRs

### PR-01: S5 Contract Primitives (Schema + Error Surface)
- **goal**: Land S5 foundation contracts that other PRs depend on: TOC storage schema and API/error primitive registration.
- **dependencies**: none.
- **acceptance**:
  - `epub_toc_nodes` schema constraints and deterministic ordering storage rules are available.
  - S5-specific error/status mappings are defined in the platform error model.
- **non-goals**:
  - Does not implement EPUB extraction behavior.
  - Does not implement ingest/retry or chapter/TOC endpoint behavior.

### PR-02: EPUB Extraction Artifacts
- **goal**: Implement deterministic EPUB extraction that materializes chapter + TOC artifacts aligned to S5 invariants.
- **dependencies**: PR-01.
- **acceptance**:
  - EPUB extraction materializes contiguous chapter fragments in spine order and generates fragment blocks from immutable canonical text.
  - TOC snapshot persistence is deterministic and supports stable chapter linkage semantics.
  - Title resolution follows deterministic fallback order.
  - Resource rewriting follows safe resolution rules; resolved internal assets are served only via canonical safe fetch path; unresolved assets degrade without blocking readable output.
  - Archive safety controls are enforced and unsafe archives fail deterministically with `E_ARCHIVE_UNSAFE`.
- **non-goals**:
  - Does not add or change retry endpoint behavior.
  - Does not add chapter/TOC read routes.

### PR-03: EPUB Ingest + Retry Lifecycle
- **goal**: Align upload-confirm and retry orchestration with the S5 processing state machine.
- **dependencies**: PR-01, PR-02.
- **acceptance**:
  - Upload-init/ingest EPUB behavior conforms to S5 request/response/error contracts without breaking existing duplicate-client compatibility.
  - `POST /media/{media_id}/ingest` exposes EPUB-ready dispatch/status semantics while preserving existing duplicate behavior compatibility.
  - Processing transitions (`pending -> extracting -> ready_for_reading`, embedding paths, and failure transitions) follow S5 contract.
  - `POST /media/{media_id}/retry` enforces legal-state preconditions and full artifact cleanup before re-extraction.
  - Retry for terminal archive failures is rejected with `409 E_RETRY_NOT_ALLOWED`.
- **non-goals**:
  - Does not add EPUB chapter or TOC reader endpoints.
  - Does not change reader UX flows.

### PR-04: EPUB Chapter + TOC Read APIs
- **goal**: Expose deterministic read APIs for chapter navigation and TOC retrieval.
- **dependencies**: PR-03.
- **acceptance**:
  - `GET /media/{id}/chapters` returns metadata-only chapter manifest with deterministic cursor pagination.
  - `GET /media/{id}/chapters/{idx}` returns chapter payload with deterministic `prev_idx`/`next_idx`.
  - `GET /media/{id}/toc` returns deterministic nested TOC tree ordering by `order_key`.
  - Visibility masking, readiness guards, and non-EPUB kind guards are enforced exactly per contract.
  - Matching browser-path BFF transport exists for all new non-streaming EPUB read endpoints introduced in this PR.
- **non-goals**:
  - Does not implement frontend reader adoption.
  - Does not alter highlight or quote-to-chat contracts.

### PR-05: EPUB Reader Baseline Adoption
- **goal**: Adopt chapter-based EPUB read contracts in reader baseline UX flows.
- **dependencies**: PR-04.
- **acceptance**:
  - EPUB reader flow uses chapter manifest + chapter fetch contracts instead of single-fragment assumptions.
  - Empty/partial TOC behavior is handled safely without regressing basic reading and navigation.
- **non-goals**:
  - Does not add advanced EPUB reading polish beyond S5 scope.
  - Does not modify backend endpoint contract semantics, extraction, or retry state-machine logic.

### PR-06: Highlight + Quote-to-Chat Compatibility on EPUB
- **goal**: Prove existing highlight and quote-to-chat semantics remain valid on EPUB chapter fragments.
- **dependencies**: PR-02, PR-04.
- **acceptance**:
  - Highlight anchoring remains fragment-offset based with no EPUB-specific offset model.
  - Existing highlight APIs and behavior apply to EPUB chapter fragments without contract drift.
  - Quote-to-chat context for EPUB highlights is derived from immutable fragment canonical text via existing context-window semantics.
  - Existing `/media/{id}/fragments` compatibility remains intact.
- **non-goals**:
  - Does not introduce new highlight or chat features.
  - Does not alter chapter/TOC endpoint contracts.

### PR-07: Hardening + Slice 5 Acceptance Freeze
- **goal**: Close Slice 5 with explicit acceptance coverage, invariants audit, and regression guardrails.
- **dependencies**: PR-03, PR-05, PR-06.
- **acceptance**:
  - All S5 scenarios (1-15) are covered by automated checks with explicit traceability.
  - Invariant and error-code conformance is audited across extraction, read, and retry paths.
  - Compatibility for existing media/highlight/chat surfaces is verified with no contract regressions.
- **non-goals**:
  - Does not expand product scope beyond S5 contract.
  - Does not add v2 features (including EPUB/PDF URL ingestion).

## Global Non-Goals

- EPUB ingest-from-URL (v2 scope).
- PDF ingest-from-URL (v2 scope).
- Advanced EPUB reader polish beyond baseline chapter navigation.
- Changes to sharing semantics, ranking/retrieval behavior, or non-EPUB media contracts outside compatibility safeguards.
