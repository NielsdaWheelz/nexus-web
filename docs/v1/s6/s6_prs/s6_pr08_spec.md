# pr-08: acceptance hardening and regression closure

## goal
Close S6 by hardening integrated acceptance/regression coverage for the merged PDF backend+frontend path and resolving integration defects uncovered by that coverage.

## builds on
- pr-02 (typed-highlight visibility/kernel compatibility)
- pr-03 (pdf processing/readiness and retry invalidation policy)
- pr-05 (pdf quote-to-chat compatibility + blocking semantics)
- pr-07 (pdf reader highlighting + linked-items adapter)

## acceptance
- automated coverage proves S6 acceptance scenarios end-to-end across merged behavior: upload-to-viewer readability, quote-readiness gating, persistent PDF highlighting, linked-items page-scoped behavior, and quote-to-chat from persisted PDF highlights.
- at least one automated browser flow covers: `upload -> processing -> viewer open -> create PDF highlight -> reload -> send highlight to chat`.
- at least one automated degrade/failure flow validates either scanned/image-only visual-read-only semantics or password-protected deterministic failure semantics.
- visibility regression coverage explicitly includes PDF highlight surfaces, including shared-read visibility and masked-not-found behavior for non-visible/non-owner paths.
- processing-state regression coverage explicitly includes PDF `can_read` vs `can_quote` split, retry/rebuild invalidation behavior, and quote-path blocking semantics (`E_MEDIA_NOT_READY`) for both sync and streaming paths.
- linked-items PDF behavior remains active-page scoped and continues to reuse existing row interactions (focus/scroll/quote/annotation) with no behavior regression for non-PDF media.
- integration bugs found during this closure are fixed with contract-preserving changes that keep S6 behavior within L2 boundaries.

## key decisions
- **test-layer allocation**: keep one high-confidence browser happy-path for full user flow; close most degrade/visibility/processing contracts in existing backend integration suites to reduce flake while preserving behavioral proof.
- **closure discipline**: bug fixes discovered in pr-08 are allowed, but only as minimal corrections to satisfy existing S6 contracts.

## non-goals
- no new S6 feature scope (including pdf ingest-from-url, perfect text-geometry reconciliation, or full linked-items unification).
- no redesign of highlight, quote-context, or pdf lifecycle architecture beyond regression fixes required for acceptance closure.
