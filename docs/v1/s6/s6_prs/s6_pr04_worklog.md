# S6 PR-04 L4 Spec Worklog

## Evidence Log

- Reviewed `pr-04` roadmap entry and acceptance bullets in `docs/v1/s6/s6_pr_roadmap.md` (PDF highlight API rollout, geometry canonicalization, duplicate enforcement, typed generic-route compatibility).
- Reviewed S6 L2 spec sections governing:
  - PDF geometry canonicalization and duplicate identity (`docs/v1/s6/s6_spec.md` Section `2.3`)
  - PDF highlight API contracts and generic route extensions (`docs/v1/s6/s6_spec.md` Section `4.3`)
  - geometry/duplicate invariants (`docs/v1/s6/s6_spec.md` Section `6`)
- Reviewed accepted S6 decisions relevant to `pr-04` in `docs/v1/s6/s6_spec_decisions.md` (`S6-D01`, `S6-D02`, `S6-D07` and prior carry-forward constraints).
- Reviewed current merged backend seams after `pr-02`/`pr-03`:
  - `highlight_kernel` shared resolver/mismatch infrastructure (`python/nexus/services/highlight_kernel.py`)
  - fragment-only highlight route and schema surfaces (`python/nexus/api/routes/highlights.py`, `python/nexus/schemas/highlights.py`)
  - `pr-03` PDF lifecycle/readiness implementation (`python/nexus/services/pdf_lifecycle.py`, `python/nexus/services/pdf_readiness.py`)
- Reviewed `pr-03` implementation report to anchor `pr-04` assumptions to actual merged code (`docs/v1/s6/s6_prs/s6_pr03_implementation_report.md`).
- Reviewed L4 template/process requirements in `docs/v1/sdlc/L4-pr-spec.md`.

## Current Codebase Findings (pre-pr-04)

- `python/nexus/api/routes/highlights.py` exposes fragment create/list routes and generic detail/update/delete/annotation routes; there are no PDF highlight routes yet.
- `python/nexus/schemas/highlights.py` still defines fragment-only `HighlightOut` and fragment-only create/update request shapes.
- `python/nexus/services/highlights.py` already uses `highlight_kernel` for generic visibility/write loaders and mismatch mapping, but create/list/update logic is fragment-oriented.
- `python/nexus/services/highlight_kernel.py` already supports a normalized PDF resolver `ok` path and explicitly defers the internal typed PDF view branch to `pr-04`.
- `pr-01` schema/model foundation already includes `highlight_pdf_anchors` and `highlight_pdf_quads`; exact PDF duplicate enforcement is not yet implemented.
- No pure geometry canonicalization/fingerprinting module exists yet; S6 geometry math is not implemented in backend service code.
- No PDF highlight route/service tests exist yet; `python/tests/test_highlights.py` and `python/tests/test_highlight_kernel.py` cover fragment and `pr-02` typed-kernel fragment behaviors.

## Drafting Progress

- Created `docs/v1/s6/s6_prs/s6_pr04_spec.md` L4 skeleton with required sections.
- Seeded deliverables around the actual `pr-04` impact surface (routes, schemas, highlight services, `highlight_kernel`, pure geometry module, backend tests).
- Seeded traceability matrix for all `pr-04` L3 acceptance bullets with concrete test names and file targets.
- Seeded acceptance-test scaffolding across `python/tests/test_highlights.py`, `python/tests/test_highlight_kernel.py`, `python/tests/test_pdf_highlight_geometry.py`, and `python/tests/test_permissions.py`.
- Opened `S6-PR04-D01` (geometry canonicalization/fingerprinting module placement and separation from DB write orchestration) with a temporary draft default.
- Resolved `S6-PR04-D01` (dedicated pure `pdf_highlight_geometry.py` for canonicalization/fingerprinting/sort-key derivation + transactional persistence/coherence/duplicate enforcement in `highlights.py`) and prepared roadmap carry-forward notes.
- Opened `S6-PR04-D02` (exact race-safe duplicate enforcement strategy: transactional enforcement vs schema/index refinement) with a temporary draft default favoring service-level transactional enforcement.
- Resolved `S6-PR04-D02` (service-level transactional duplicate race safety with transaction-scoped advisory lock + duplicate recheck; no `pr-04` schema/index refinement unless required) and prepared roadmap carry-forward notes.
- Resolved `S6-PR04-D03` (typed anchor-discriminated generic/PDF highlight responses + preserved fragment-route compatibility) and prepared roadmap carry-forward notes.
- Resolved `S6-PR04-D04` (dedicated `pdf_highlights.py` module for PDF highlight orchestration, with `highlights.py` retained as generic/fragment compatibility layer) and prepared roadmap carry-forward notes.
- Resolved `S6-PR04-D05` (backward-compatible unified generic PATCH schema with nested `pdf_bounds` and strict mutual exclusivity vs fragment offsets) and prepared roadmap carry-forward notes.
- Resolved `S6-PR04-D06` (write-time deterministic PDF match metadata + `prefix/suffix` computation when quote-text infrastructure is ready; `pending` fallback only when not ready) and prepared roadmap carry-forward notes.
- Opened `S6-PR04-D07` (shared deterministic PDF quote-match helper placement for `pr-04` writes and `pr-05` enrichment/quote paths) with a temporary draft default favoring a shared pure helper module.
- Resolved `S6-PR04-D07` (shared pure `pdf_quote_match.py` helper reused by `pr-04` write paths and `pr-05` quote/enrichment paths) and prepared roadmap carry-forward notes.
- Opened `S6-PR04-D08` (deterministic hashing/serialization contract for `geometry_fingerprint` and advisory-lock key derivation) with a temporary draft default favoring canonical serialized geometry bytes + SHA-256 hex fingerprint + stable namespaced 64-bit advisory-lock key derivation with duplicate recheck preserved.
- Resolved `S6-PR04-D08` (canonical identity-byte serialization + SHA-256 lowercase hex `geometry_fingerprint` + stable namespaced deterministic `int64` advisory-lock key derivation, with duplicate recheck authoritative) and prepared roadmap carry-forward notes.
- Opened `S6-PR04-D09` (transaction sequencing and advisory-lock scope for PDF create/bounds-update with write-time match computation) with a temporary draft default favoring geometry/match computation before advisory-lock acquisition and lock hold only around duplicate recheck + atomic persistence.
- Resolved `S6-PR04-D09` (media coordination lock -> duplicate lock ordering, geometry/match before duplicate-lock acquisition, bounded duplicate-lock scope for recheck + atomic persistence) and prepared roadmap carry-forward notes.
- Opened `S6-PR04-D10` (shared media-scoped coordination lock helper placement for `pr-04` writes and narrow `pr-03` text rebuild/invalidation interop paths) with a temporary draft default favoring a small shared `pdf_locking.py` helper module.
- Resolved `S6-PR04-D10` (shared low-level `pdf_locking.py` helper module for media coordination lock key derivation and lock-order helpers reused by `pr-04` and narrow `pr-03` interop patch) and prepared roadmap carry-forward notes.
- Opened `S6-PR04-D11` (boundary between `pdf_highlight_geometry.py` and `pdf_locking.py` for duplicate-identity advisory-lock key ownership) with a temporary draft default preserving `D08` canonical-identity ownership in `pdf_highlight_geometry.py`.
- Resolved `S6-PR04-D11` (geometry-owned duplicate-identity/duplicate-lock key derivation, `pdf_locking.py`-owned coordination-lock keys + lock mechanics) and prepared roadmap carry-forward notes.
- Opened `S6-PR04-D12` (write-time PDF match anomaly error policy on quote-ready media during create/bounds-update) with a temporary draft default using recoverable-anomaly degrade-to-`pending` plus logging and fail-closed for unclassified exceptions.
- Resolved `S6-PR04-D12` (classified hybrid write-time matcher anomaly policy on quote-ready media: recoverable/classified anomalies degrade to `pending` + empty `prefix/suffix` with structured logging; unexpected/unclassified exceptions fail the mutation with no partial write) and prepared roadmap carry-forward notes.
- Opened `S6-PR04-D13` (boundary for matcher anomaly classification types vs structured anomaly logging ownership across `pr-04` writes and `pr-05` enrichment while preserving `D07` pure-matcher rules) with a temporary draft default favoring typed recoverable anomaly classifications in `pdf_quote_match.py` and service-owned logging/mapping.
- Resolved `S6-PR04-D13` (two-layer anomaly boundary: pure `pdf_quote_match.py` typed classifications + shared `pdf_quote_match_policy.py` structured logging/mapping helpers reused by `pr-04` and `pr-05`) and prepared roadmap carry-forward notes.
- Opened `S6-PR04-D14` (canonical anomaly log event schema + helper API contract for `pdf_quote_match_policy.py`, including no-double-logging ownership) with a temporary draft default favoring one `pdf_quote_match_anomaly` event and centralized logging in policy helpers.
- Resolved `S6-PR04-D14` (canonical `pdf_quote_match_anomaly` event schema + centralized `pdf_quote_match_policy.py` helper logging/mapping API contract, including no-double-logging ownership) and prepared roadmap/spec traceability updates.
- Opened `S6-PR04-D15` (redaction/privacy contract for matcher anomaly logs with document-derived text inputs) with a temporary draft default forbidding raw text in anomaly logs and allowing only non-content diagnostics.
- Resolved `S6-PR04-D15` (strict no-content matcher anomaly logging in MVP: no raw text or unsalted text hashes, sanitized exception diagnostics, approved non-content fields only) and prepared roadmap/spec traceability updates.
- Opened `S6-PR04-D16` (generic PATCH anchor-kind mismatch error mapping for cross-kind but syntactically valid payloads under the unified PATCH schema) with a temporary draft default favoring deterministic client-error rejection in service dispatch.
- Resolved `S6-PR04-D16` (service-level generic PATCH cross-kind semantic mismatch mapping to `400 E_INVALID_REQUEST` with deterministic anchor-kind mismatch details and no mutation after visibility/resource resolution) and prepared roadmap/spec traceability updates.
- Opened `S6-PR04-D17` (idempotency/no-op contract for PDF bounds-updates that canonicalize to the target highlight’s existing geometry identity) with a temporary draft default favoring non-conflict success and recomputation of write-time derived fields.
- Resolved `S6-PR04-D17` (self-same canonical PDF bounds-updates are not duplicate conflicts; PATCH succeeds with recomputation of write-time derived fields when mutable inputs change and idempotent no-op success allowed when effective state is unchanged) and prepared roadmap/spec traceability updates.
- Opened `S6-PR04-D18` (timestamp/persistence semantics for fully identical effective PDF PATCH updates) with a temporary draft default allowing success without conflict while deferring exact `updated_at` bump/no-bump behavior.
- Resolved `S6-PR04-D18` (fully identical effective PDF PATCH updates are true no-op successes with no persisted-state mutation, no `updated_at` bump, and no quad/subtype row rewrites) and prepared roadmap/spec traceability updates.
- Opened `S6-PR04-D19` (whether/when fully identical effective PDF PATCH requests may short-circuit before `D09` lock acquisition) with a temporary draft default allowing but not requiring safe pre-lock no-op short-circuiting.
- Resolved `S6-PR04-D19` (guarded hybrid optional pre-`D09` no-op short-circuiting allowed only with target-row lock + safe equality proof, otherwise normal `D09` path with `D18` no-op semantics) and prepared roadmap/spec traceability updates.
- Opened `S6-PR04-D20` (single canonical effective-state comparison helper/path requirement for pre-lock short-circuit and post-lock no-op detection) with a temporary draft default favoring one shared internal comparison logic path in `pdf_highlights.py`.
- Resolved `S6-PR04-D20` (require one canonical deterministic side-effect-free effective-state comparison helper/path for PDF PATCH equality/no-op detection across guarded pre-lock short-circuit and post-lock fallback branches, with an explicit `requires_full_path`/fallback outcome when safe equality cannot be proven) and prepared roadmap/spec traceability updates.

## Open Decision Queue

- `S6-PR04-D07` — Resolved: shared pure `pdf_quote_match.py` helper module reused by `pr-04` and `pr-05`.
- `S6-PR04-D08` — Resolved: deterministic hashing/serialization contract for `geometry_fingerprint` and advisory-lock key derivation.
- `S6-PR04-D09` — Resolved: transaction sequencing and advisory-lock scope for PDF create/bounds-update with write-time match computation.
- `S6-PR04-D10` — Resolved: shared media-scoped coordination lock helper placement (`pdf_locking.py`) for `pr-04` writes and narrow `pr-03` rebuild/invalidation interop paths.
- `S6-PR04-D11` — Resolved: boundary between `pdf_highlight_geometry.py` and `pdf_locking.py` for duplicate-identity advisory-lock key ownership.
- `S6-PR04-D12` — Resolved: classified hybrid write-time matcher anomaly policy on quote-ready media during create/bounds-update.
- `S6-PR04-D13` — Resolved: two-layer anomaly boundary (`pdf_quote_match.py` typed classifications + shared `pdf_quote_match_policy.py` logging/mapping).
- `S6-PR04-D14` — Resolved: canonical anomaly log event schema + helper API contract for `pdf_quote_match_policy.py` (including no-double-logging ownership).
- `S6-PR04-D15` — Resolved: redaction/privacy contract for matcher anomaly logs with document-derived text inputs.
- `S6-PR04-D16` — Resolved: generic PATCH anchor-kind mismatch error mapping for cross-kind but syntactically valid payloads.
- `S6-PR04-D17` — Resolved: idempotency/no-op contract for PDF bounds-updates that canonicalize to the target highlight’s existing geometry identity.
- `S6-PR04-D18` — Resolved: timestamp/persistence semantics for fully identical effective PDF PATCH updates.
- `S6-PR04-D19` — Resolved: pre-lock no-op short-circuit allowance/contract for fully identical effective PDF PATCH updates.
- `S6-PR04-D20` — Resolved: canonical effective-state comparison helper/path requirement for PDF PATCH no-op detection (shared across pre-lock short-circuit and post-lock fallback/no-op paths with explicit safe-fallback outcome).
- Legacy `PDF_SPEC.md` review for `pr-04` found no additional backend highlight API/canonicalization blockers, but surfaced two frontend carry-forward hardening items now captured in `pr-07` roadmap notes: explicit overlay redraw/reprojection trigger-matrix tests and text-layer domain-symmetry requirements for any DOM text-walking helpers.
