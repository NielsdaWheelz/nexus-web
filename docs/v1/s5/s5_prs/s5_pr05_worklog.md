# s5 pr-05 worklog

## purpose
Capture bounded-context evidence gathered while authoring `docs/v1/s5/s5_prs/s5_pr05.md`.

## acceptance checklist (source: `docs/v1/s5/s5_roadmap.md`)
- [x] EPUB reader flow uses chapter manifest + chapter fetch contracts instead of single-fragment assumptions.
- [x] Empty/partial TOC behavior is handled safely without regressing basic reading and navigation.

## evidence log

| id | acceptance item | file | lines | evidence | impact on spec |
|---|---|---|---|---|---|
| e-001 | PR-05 roadmap scope | `docs/v1/s5/s5_roadmap.md` | 128-136 | PR-05 is explicitly reader baseline adoption only, with backend/extraction/retry out of scope. | Locked singular C6 scope and strict non-goals in PR-05 spec. |
| e-002 | Ownership boundary | `docs/v1/s5/s5_roadmap_ownership.md` | 20-21 | C5 (endpoint semantics) is owned by PR-04; C6 (reader UX adoption) is owned by PR-05. | Prevented endpoint-contract changes from leaking into PR-05 deliverables. |
| e-003 | L2 chapter manifest contract | `docs/v1/s5/s5_spec.md` | 462-503 | `/chapters` defines deterministic idx ordering and cursor envelope, including exhausted-page behavior. | Drove manifest pagination helper, cursor-walk behavior, and cursor safety tests. |
| e-004 | L2 chapter detail contract | `docs/v1/s5/s5_spec.md` | 505-542 | `/chapters/{idx}` is canonical single-chapter payload with deterministic navigation pointers and chapter-scoped semantics. | Anchored active chapter fetch and chapter-switch behavior constraints. |
| e-005 | L2 TOC contract | `docs/v1/s5/s5_spec.md` | 544-590 | `/toc` returns deterministic nested tree; empty TOC is valid and non-error. | Drove non-fatal empty TOC behavior and partial TOC-safe rendering requirements. |
| e-006 | L2 compatibility contract | `docs/v1/s5/s5_spec.md` | 594-605 | `/media/{id}/fragments` remains supported and highlight/chat contracts are unchanged. | Drove dual-path approach: keep non-EPUB fragment flow and preserve highlight semantics. |
| e-007 | L2 scope guard | `docs/v1/s5/s5_spec.md` | 21-27 | Advanced EPUB reader polish remains out of scope in S5. | Constrained PR-05 to baseline navigation only (no advanced reader features). |
| e-008 | Current single-fragment assumption | `apps/web/src/app/(authenticated)/media/[id]/page.tsx` | 161-163, 191-193, 201-207 | Reader stores `fragments` array, selects `fragments[0]`, and fetches `/api/media/{id}/fragments`. | Confirmed concrete migration need to chapter-based EPUB path. |
| e-009 | Existing readable-state drift risk | `apps/web/src/app/(authenticated)/media/[id]/page.tsx` | 644-646 | UI currently treats only `ready` and `ready_for_reading` as readable. | Added decision to include `embedding` in UI readable set for contract alignment. |
| e-010 | Highlight coupling to fragment id | `apps/web/src/app/(authenticated)/media/[id]/page.tsx` | 80-84, 226-241 | Highlight fetch is fragment-id based and reloads on fragment change. | Enforced chapter-switch requirement to clear stale state and refetch highlights for new fragment id. |
| e-011 | Existing PR-04 BFF transport availability | `apps/web/src/app/api/media/[id]/chapters/route.ts`; `apps/web/src/app/api/media/[id]/chapters/[idx]/route.ts`; `apps/web/src/app/api/media/[id]/toc/route.ts` | 1-10; 1-10; 1-10 | Browser-path BFF proxies already exist for all required EPUB read endpoints. | Allowed PR-05 to focus exclusively on UI adoption with no new transport routes. |
| e-012 | Backend chapter/toc routes already merged | `python/nexus/api/routes/media.py` | 273-322 | FastAPI chapter/toc endpoints are available and contract-owned by PR-04. | Confirmed PR-05 should consume APIs and avoid backend edits. |
| e-013 | Testing stack conventions | `apps/web/package.json`; `apps/web/vitest.config.ts` | 1-32; 1-12 | Frontend uses Vitest + Testing Library + happy-dom for unit/integration tests. | Drove concrete test deliverables in `.test.ts`/`.test.tsx` files. |
| e-014 | Legacy concatenation anti-pattern | `docs/old-documents-specs/EPUB_SPEC.md` | 287-291, 304-309 | Legacy EPUB reader had no chapter boundaries/navigation due whole-book concatenation. | Reinforced PR-05 requirement to make chapter selection first-class and TOC-aware. |
| e-015 | Historical large-book rendering risk | `docs/old-documents-specs/EPUB_SPEC.md` | 326-329 | Legacy notes call out performance issues from rendering entire book in one blob. | Supported manifest-driven single-chapter loading as baseline and avoided whole-book render regressions. |
| e-016 | Legacy CSS leakage risk signal | `docs/old-documents-specs/EPUB_SPEC.md` | 320-323 | Legacy notes warn EPUB CSS can leak into application UI and suggest isolation architectures. | Added PR-05 boundary decision to keep server-sanitized render path and explicitly defer new isolation architecture to future scoped work. |
| e-017 | Current reader has no chapter-request race guard | `apps/web/src/app/(authenticated)/media/[id]/page.tsx` | 198-224 | Current load path does not manage concurrent chapter-detail request versions because chapter-mode orchestration does not yet exist. | Added explicit PR-05 requirement for stale-response protection during rapid chapter navigation. |
| e-018 | Legacy whole-book render performance trap | `docs/old-documents-specs/EPUB_SPEC.md` | 287-291, 326-329 | Legacy behavior coupled full-book rendering with large DOM/memory cost for long books. | Added explicit PR-05 no-eager-all-chapter-detail-prefetch guard and matching test requirement. |
| e-019 | Chapter-detail error surface for reader adoption | `docs/v1/s5/s5_spec.md` | 538-542 | L2 chapter endpoint explicitly defines `E_MEDIA_NOT_FOUND`, `E_MEDIA_NOT_READY`, and `E_CHAPTER_NOT_FOUND`. | Added deterministic PR-05 chapter-fetch recovery matrix and explicit tests for each branch. |
| e-020 | Existing user-action navigation history baseline | `apps/web/src/app/(authenticated)/media/[id]/page.tsx` | 612-621 | Current explicit user action (quote-to-chat) uses `router.push`, indicating user-intent transitions preserve history. | Added PR-05 push-vs-replace rule: user chapter navigation uses push; automatic canonicalization uses replace. |
| e-021 | Highlight reload path currently tied to fragment lifecycle | `apps/web/src/app/(authenticated)/media/[id]/page.tsx` | 226-241 | Highlight fetches are bound to active fragment identity and currently assume monotonic fragment changes. | Added stale-highlight-response guard requirement for rapid chapter switches. |

## notes
- Phase 1 skeleton completed first across spec/decisions/worklog docs.
- Phase 2 acceptance-cluster micro-loop completed for both PR-05 acceptance bullets.
- Key forced decisions locked during authoring:
  - EPUB-only chapter-path adoption with non-EPUB compatibility path preserved.
  - URL-canonical chapter state (`chapter` query param) with deterministic fallback.
  - user chapter navigation uses history-preserving push; automatic canonicalization uses replace.
  - Manifest-as-truth navigation with TOC as auxiliary metadata.
  - UI-readable status alignment to include `embedding`.
  - TOC failure/partial-data graceful degradation without read-path regression.
  - one-active-chapter payload performance guard (no eager all-chapter detail prefetch).
  - deterministic chapter-fetch failure recovery matrix (`E_CHAPTER_NOT_FOUND` reconciliation, `E_MEDIA_NOT_READY` gate, `E_MEDIA_NOT_FOUND` masked state).
  - stale-response safety for rapid chapter navigation (cancel/ignore older chapter and highlight requests).
  - rendering boundary hardening: backend-sanitized HTML remains authoritative; no ad-hoc client rewrite/isolation layer in PR-05.
- Hardening pass completed:
  - roadmap completeness: both PR-05 acceptance bullets mapped to deliverables/tests.
  - dependency sanity: references only merged PR-04 endpoint surfaces.
  - boundary cleanup: no PR-04 backend contract edits and no PR-06 feature expansion.
  - ambiguity cleanup: explicit chapter selection, chapter-fetch recovery, URL history semantics, TOC behavior, and highlight-reset/stale-response rules.
  - implementation readiness: junior implementer can execute with deterministic file/test targets.

## unresolved items
- none.
