# s5 pr-06 worklog

## purpose
Capture bounded-context evidence gathered while authoring `docs/v1/s5/s5_prs/s5_pr06.md`.

## acceptance checklist (source: `docs/v1/s5/s5_roadmap.md`)
- [x] Highlight anchoring remains fragment-offset based with no EPUB-specific offset model.
- [x] Existing highlight APIs and behavior apply to EPUB chapter fragments without contract drift.
- [x] Quote-to-chat context for EPUB highlights is derived from immutable fragment canonical text via existing context-window semantics.
- [x] Route-bound quote-to-chat attach handoff semantics are preserved for `/conversations` and `/conversations/{id}` without cross-page global target state.
- [x] Existing `/media/{id}/fragments` compatibility remains intact.

## evidence log

| id | acceptance item | file | lines | evidence | impact on spec |
|---|---|---|---|---|---|
| e-001 | PR-06 roadmap scope | `docs/v1/s5/s5_roadmap.md` | 140-151 | PR-06 is explicitly compatibility proof for highlights + quote-to-chat on EPUB fragments; no feature expansion. | Locked singular C7 scope and strict non-goals. |
| e-002 | Ownership boundary | `docs/v1/s5/s5_roadmap_ownership.md` | 22 | C7 ownership is `4.7` and invariants `6.6-6.8`, and PR-06 preserves existing contracts. | Prevented contract-shape changes from leaking into deliverables. |
| e-003 | L2 compatibility contract | `docs/v1/s5/s5_spec.md` | 592-607 | `/media/{id}/fragments`, highlight endpoints, and quote-to-chat compatibility semantics are unchanged in S5 and must remain compatible. | Drove no-API-shape-change requirement, route-bound attach-handoff coverage, and fragments regression test. |
| e-004 | L2 invariants | `docs/v1/s5/s5_spec.md` | 668-670 | EPUB highlight anchoring remains canonical offsets; quote context determinism derives from immutable `fragment.canonical_text`. | Drove EPUB highlight offset tests and quote-to-chat canonical-text assertions. |
| e-005 | Existing quote trigger seam | `apps/web/src/app/(authenticated)/media/[id]/page.tsx` | 786-793 | Reader already emits quote-to-chat navigation with `attach_type=highlight&attach_id=<id>`. | Justified adding attach-query consumption bridge in conversations pages. |
| e-006 | Composer context contract exists | `apps/web/src/components/ChatComposer.tsx` | 64-70, 398-406, 448-467 | Composer already accepts `attachedContexts`, includes them in send payload, and renders removable chips. | Enabled minimal bridge design instead of changing composer payload contracts. |
| e-007 | Attach gap on conversations pages | `apps/web/src/app/(authenticated)/conversations/page.tsx` | 10-15, 136-145 | New-chat conversations page does not read attach query params and does not pass attached contexts to composer. | Added explicit deliverables/tests for `/conversations` attach preload + lifecycle. |
| e-008 | Attach gap on conversation detail | `apps/web/src/app/(authenticated)/conversations/[id]/page.tsx` | 10-14, 240-248 | Conversation detail page also does not consume attach query params or pass attached contexts. | Added explicit deliverables/tests for `/conversations/{id}` attach preload + lifecycle. |
| e-009 | Route-binding source contract | `docs/v1/s3/s3_prs/s3_pr07.md` | 297-312 | S3 defines route-determined attach target and `contexts` payload behavior; no global focused-conversation state. | Locked route-as-source-of-truth behavior in PR-06 UI requirements. |
| e-010 | Highlight API is fragment-scoped | `python/nexus/api/routes/highlights.py` | 39-66, 68-106 | Highlight create/list routes are already fragment-based with existing request/response shapes. | Confirmed compatibility proof should use additive tests, not endpoint changes. |
| e-011 | Highlight text derivation source | `python/nexus/services/highlights.py` | 84-96, 223-235 | `exact/prefix/suffix` are derived from `fragment.canonical_text` using canonical offsets. | Drove EPUB-specific derivation tests to assert no contract drift. |
| e-012 | Quote context rendering source | `python/nexus/services/context_rendering.py` | 147-185 | Highlight context rendering path resolves highlight -> fragment and uses context window text around `highlight.exact`. | Drove quote-to-chat rendering assertions for EPUB highlight contexts. |
| e-013 | Context window canonical source | `python/nexus/services/context_window.py` | 44-79 | Context window loads fragment and computes text window from `fragment.canonical_text` (blocks or fallback). | Anchored deterministic canonical-text requirement in send-message EPUB tests. |
| e-014 | Current send-message visibility gate | `python/nexus/services/send_message.py` | 345-379 | Highlight/annotation context visibility checks currently use media-level `can_read_media` gate and return masked `E_NOT_FOUND`. | Locked approved no-change boundary and deferred policy migration. |
| e-015 | S3 quote gate documentation | `docs/v1/s3/s3_spec.md` | 553-562 | S3 documents quote-to-chat gate using `can_read_media` for highlight/annotation contexts. | Reinforced decision to avoid auth-policy changes in PR-06. |
| e-016 | Existing fragments endpoint behavior | `python/nexus/api/routes/media.py` | 141-153 | `/media/{id}/fragments` route remains service-owned and returns ordered fragments. | Added explicit compatibility regression test requirement for EPUB payload/order. |
| e-017 | Existing fragments ordering implementation | `python/nexus/services/media.py` | 314-361 | Service enforces visibility masking and `ORDER BY f.idx ASC` payload shape. | Specified exact ordering/payload assertions in PR-06 media test. |
| e-018 | Browser-path fragments transport parity | `apps/web/src/app/api/media/[id]/fragments/route.ts` | 1-10 | BFF already proxies `/api/media/{id}/fragments` to FastAPI unchanged. | Confirmed PR-06 should not add/alter transport routes for compatibility proof. |
| e-019 | Existing send-message context tests are generic | `python/tests/test_send_message.py` | 580-683 | Current context tests cover highlight contexts generally, but not explicit EPUB fixture coverage. | Added requirement for EPUB-specific quote-to-chat tests and fixtures. |
| e-020 | Existing fragments tests are web-article-centric | `python/tests/test_media.py` | 288-431 | Existing `/fragments` tests focus on generic/web-article media setup; no explicit EPUB ordered-compatibility guard. | Added dedicated EPUB fragments compatibility test requirement. |
| e-021 | Existing factories are web-article defaults | `python/tests/factories.py` | 167-225, 289-302 | Core media/fragment factories default to `web_article` and fixed fragment idx=0 behavior. | Added factory extension requirement for reusable EPUB media/chapter fragment fixtures. |
| e-022 | Legacy offset-domain risk | `docs/old-documents-specs/EPUB_SPEC.md` | 192-200, 271-291 | Legacy EPUB annotation model used a concatenated-book offset domain across all chapters and one long rendered HTML flow. | Added PR-06 regression tests to reject legacy global offsets and assert chapter-local quote context behavior. |
| e-023 | Legacy CSS leakage concern | `docs/old-documents-specs/EPUB_SPEC.md` | 202-207, 319-323 | Legacy notes document EPUB internal style interactions and CSS leakage mitigation ideas (isolation/stripping). | Added explicit PR-06 non-goal: no rendering architecture/CSS isolation changes in this PR. |

## notes
- Phase 1 skeleton completed first across spec/decisions/worklog docs.
- Phase 2 acceptance-cluster micro-loop completed for all five PR-06 acceptance bullets.
- Key forced decisions locked during authoring:
  - include attach-query to composer bridge (approved);
  - keep send-message visibility predicate unchanged in PR-06 and defer policy migration (approved);
  - parse attach query strictly (`highlight` + UUID only), ignore invalid values safely;
  - clear attach state and canonicalize URL only after successful send; preserve attach state on failures;
  - preserve route-determined quote-to-chat target semantics from S3 (no global target state);
  - add EPUB-specific compatibility tests for highlights, send-message quote context, and fragments endpoint;
  - add explicit protections against legacy concatenated-book offset behavior and cross-chapter quote-context bleed;
  - keep CSS isolation/rendering architecture changes out of PR-06 scope.
- Hardening pass completed:
  - roadmap completeness: all PR-06 acceptance bullets mapped to deliverables/tests;
  - dependency sanity: references merged PR-02/PR-04/PR-05 state only;
  - boundary cleanup: no chapter/toc/retry or auth-policy redesign scope smuggling;
  - ambiguity cleanup: explicit attach parse/consume lifecycle and failure behavior;
  - implementation readiness: file targets and deterministic test names are implementation-ready.

## unresolved items
- none.
