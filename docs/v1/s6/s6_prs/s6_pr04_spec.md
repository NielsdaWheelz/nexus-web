# pr-04: pdf highlight apis and geometry canonicalization

## goal
Implement S6 PDF highlight API surfaces and generic highlight-route compatibility backed by authoritative server-side PDF geometry canonicalization, fingerprinting, duplicate enforcement, and typed-highlight persistence.

## context
- `docs/v1/s6/s6_pr_roadmap.md` defines `pr-04` as the owner of PDF highlight create/list/update APIs, geometry canonicalization/fingerprinting, exact duplicate enforcement, transactional PDF anchor write-time coherence validation, and generic highlight-route compatibility for typed highlights (`pr-04` entry).
- `docs/v1/s6/s6_spec.md` Section `2.3` defines S6 PDF geometry canonicalization (`geometry_version=1`), duplicate identity, deterministic sort keys, and payload bounds; Section `4.3` defines the PDF highlight API contracts and generic highlight-route extensions; Section `6` defines invariants for PDF geometry normalization and duplicate identity.
- `docs/v1/s6/s6_spec_decisions.md` fixes the major architectural constraints used by `pr-04`:
  - `S6-D01` unified logical highlight with typed anchor submodels
  - `S6-D02` canonical PDF page-space geometry + normalization/fingerprinting
  - `S6-D07` linked-items pane reuse via adapter (carry-forward only; no frontend work in `pr-04`)
- `docs/v1/s6/s6_prs/s6_pr01_implementation_report.md` documents the actual schema/model foundation now available:
  - `highlights.anchor_kind` / `anchor_media_id` (transitional paired-null bridge)
  - `highlight_pdf_anchors`, `highlight_pdf_quads` tables and row-local constraints
  - supporting PDF anchor indexes (exact duplicate uniqueness intentionally deferred)
- `docs/v1/s6/s6_prs/s6_pr02_implementation_report.md` (via merged code) established the `highlight_kernel` shared resolver/mismatch infrastructure and fragment typed-kernel adoption; `pr-04` must reuse those seams rather than reintroducing fragment-only assumptions.
- `docs/v1/s6/s6_prs/s6_pr03_implementation_report.md` shipped PDF lifecycle/readiness semantics (`pdf_lifecycle`, `pdf_ingest`, `pdf_readiness`) and accurate PDF `can_read` vs quote/search readiness gating; `pr-04` should reuse those ready-state/capability semantics, not redesign them.
- Current backend state before `pr-04`:
  - highlight routes are fragment-only for create/list and generic routes exist (`python/nexus/api/routes/highlights.py`)
  - `HighlightOut` is still fragment-only (`python/nexus/schemas/highlights.py`)
  - `highlight_kernel` already has a normalized-PDF resolver case and explicitly defers the internal PDF typed-view branch to `pr-04` (`python/nexus/services/highlight_kernel.py`)
  - `highlights.py` already uses `highlight_kernel` mismatch mapping/logging on generic routes, and fragment create/update paths currently dual-write fragment subtype rows (`python/nexus/services/highlights.py`)
- Greenfield production assumption still applies (zero existing production data), but `pr-04` must remain rollout-safe against live rows created after `pr-03`, and must preserve existing fragment highlight route behavior.

## dependencies
- pr-02
- pr-03

---

## deliverables

### `python/nexus/api/routes/highlights.py`
- Add S6 PDF highlight create/list routes:
  - `POST /media/{media_id}/pdf-highlights`
  - `GET /media/{media_id}/pdf-highlights`
- Preserve existing fragment highlight routes and generic highlight/annotation routes.
- Extend transport wiring for generic `PATCH /highlights/{highlight_id}` to accept the `pr-04` PDF bounds-update request shape while preserving fragment-route compatibility.
- Preserve existing response envelopes and error envelopes.

### `python/nexus/schemas/highlights.py`
- Extend highlight schemas to support typed-anchor responses for generic highlight routes and new PDF highlight routes.
- Add request/response schemas for S6 PDF highlight APIs:
  - PDF create request (`page_number`, `quads`, `exact`, `color`)
  - page-scoped PDF highlight list response
  - PDF bounds-update payload shape (for generic PATCH extension)
- Evolve the generic `PATCH /highlights/{highlight_id}` request schema with a backward-compatible unified request shape:
  - preserve existing fragment fields (`start_offset`, `end_offset`, `color`)
  - add nested `pdf_bounds` replacement payload (`page_number`, `quads`, `exact`)
  - enforce strict mutual exclusivity between fragment offset updates and `pdf_bounds`
  - require full replacement payload inside `pdf_bounds` when present
- Keep fragment route request compatibility (fragment create/list request/response shapes remain valid for existing callers).
- Implement strict schema-level payload validation only where it belongs in transport (shape/domain); leave geometry canonicalization semantics to service/pure-geometry logic.

### `python/nexus/services/highlights.py`
- Keep `highlights.py` as the generic highlight/annotation orchestration layer and fragment-route service owner in `pr-04`.
- Delegate PDF highlight create/list/update orchestration to `python/nexus/services/pdf_highlights.py` while preserving existing route-facing service boundaries and error semantics.
- Extend generic highlight detail/delete/annotation service paths to serialize and mutate PDF highlights correctly via typed-anchor-aware internals and delegation.
- Preserve `pr-02` kernel reuse:
  - side-effect-free/log-free resolver posture for read-only paths
  - path-specific mismatch mapping classes
  - centralized `highlight_kernel_mismatch` logging/mapping helper contract
  - tolerated read-only `dormant_repairable` fragment semantics
- Extend integrity error/conflict mapping for PDF highlight constraint failures and duplicate conflicts without regressing fragment mappings.
- Keep `pr-05` quote-to-chat semantics out of scope (no nearby-context enrichment logic).

### `python/nexus/services/pdf_highlights.py`
- Add a dedicated PDF highlight backend service/orchestration module for `pr-04`.
- Own PDF highlight create/list/update transactional behavior:
  - media/kind/ready guards (reusing existing visibility and `pr-03` readiness semantics as required)
  - S6 payload guardrails and page-number validation against `media.page_count`
  - transactional write-time coherence across `highlights` + `highlight_pdf_anchors` + `highlight_pdf_quads`
  - `anchor_kind='pdf_page_geometry'`
  - `anchor_media_id == media_id`
  - legacy fragment bridge columns remain `NULL` on PDF rows
  - `D02` advisory-lock duplicate race safety (exact duplicates rejected, overlaps allowed)
- On PDF highlight create/bounds-update, own write-time PDF quote-match metadata + `prefix/suffix` storage behavior required by S6 highlight write contracts:
  - persist `highlight.exact` immediately (empty string allowed)
  - if PDF quote-text infrastructure is ready (`media.plain_text` + `pdf_page_text_spans` available), compute deterministic PDF match metadata (`plain_text_match_*`) and derived `prefix/suffix` during the same mutation transaction (or same request lifecycle before response commit)
  - if quote-text infrastructure is not ready, persist/reset `plain_text_match_status='pending'`, null offsets/version, and empty `prefix/suffix`
  - on bounds replacement, recompute match metadata and `prefix/suffix` from the replacement `exact`/geometry per S6 rules
- Reuse `python/nexus/services/pdf_highlight_geometry.py` for canonicalization/fingerprint/sort-key derivation.
- Reuse `python/nexus/services/pdf_quote_match.py` for deterministic PDF match-status/offset computation and `prefix/suffix` derivation (`plain_text_match_version=1`) on create/bounds-update writes.
- Use a stable deterministic advisory-lock key derivation helper (no Python `hash()`) for `D02` duplicate race safety.
- Enforce `D09` lock ordering for write-time PDF mutations:
  - media-scoped coordination lock (for match-metadata/text-artifact interop)
  - then duplicate-identity advisory lock
- Keep duplicate-identity advisory lock hold time bounded to duplicate recheck + atomic persistence; do not hold it across expensive pure canonicalization/matching work.
- Own one canonical deterministic side-effect-free effective-state comparison helper/path for PDF PATCH equality/no-op evaluation (`D20`), reused by:
  - guarded pre-`D09` no-op short-circuit gating (`D19`)
  - post-lock no-op detection in the normal `D09` path (`D18`)
- Return a structured comparison result (not ad hoc booleans), including an explicit safe-fallback/`requires_full_path` outcome when equality cannot be safely proven pre-lock.
- Reuse `pr-02` `highlight_kernel` seams where generic route services delegate PDF-specific mutations/serialization helpers.
- Keep route transport concerns in `api/routes/highlights.py` and pure geometry semantics in `pdf_highlight_geometry.py`.

### `python/nexus/services/highlight_kernel.py`
- Implement the `pr-04` PDF branch of the internal typed highlight view/serializer seam (currently fragment-only).
- Ensure normalized PDF highlights resolve cleanly through the existing resolver and internal view paths used by generic highlight services.
- Preserve `pr-02` mismatch mapping/logging contracts and exception diagnostics (no drift in event names/fields).
- Do not add hidden repair writes to read-only resolver paths.

### `python/nexus/services/pdf_highlight_geometry.py`
- Add a pure deterministic geometry module for S6 PDF geometry normalization/fingerprinting (`geometry_version=1`) used by PDF highlight create/update paths.
- Own canonicalization semantics from S6 `2.3`:
  - canonical page-space coordinate validation
  - quantization (`0.001 pt`)
  - quad canonical ordering
  - deterministic quad sort/read order
  - degeneracy rejection
  - canonical geometry identity byte serialization (deterministic, hash-safe)
  - `geometry_fingerprint` derivation
  - `geometry_fingerprint` hash contract (`SHA-256`, lowercase hex digest)
  - stable namespaced advisory-lock key derivation helper (`int64`, deterministic, no Python `hash()`)
  - deterministic `sort_top` / `sort_left` derivation
- Provide pure helpers that are testable without DB I/O.
- Keep DB persistence and transactional write orchestration out of this module (owned by `python/nexus/services/pdf_highlights.py` under `S6-PR04-D04`).

### `python/nexus/services/pdf_locking.py`
- Add a small shared PDF locking helper module for cross-PR coordination-lock reuse (`pr-04` PDF highlight writes + narrow `pr-03` text rebuild/invalidation interop paths).
- Own media-scoped coordination lock key derivation and advisory xact-lock acquire helper(s) for the `S6-PR04-D09` lock-ordering contract.
- Own lock-order helper/wrapper(s) or equivalent contract helpers that enforce `media-scoped coordination lock` before `duplicate-identity advisory lock`.
- Keep this module neutral and low-level:
  - no imports from `pdf_highlights.py`, `pdf_lifecycle.py`, or `pdf_ingest.py`
  - no route/service error mapping
  - no geometry canonicalization or quote-match logic
- Preserve `S6-PR04-D08` deterministic duplicate identity semantics; if duplicate-lock acquisition helpers are added here, they must not redefine canonical geometry identity or fingerprint derivation.

### `python/nexus/services/pdf_quote_match.py`
- Add a pure deterministic PDF quote-match helper module shared by `pr-04` write paths and `pr-05` quote/enrichment paths.
- Implement S6 `plain_text_match_version=1` matching and `prefix/suffix` derivation rules:
  - page-scoped match attempt using `pdf_page_text_spans`
  - deterministic fallback behavior only when page-span data is unavailable per S6 rules
  - `unique` / `ambiguous` / `no_match` classification
  - derived `prefix/suffix` outputs (empty strings when match is not `unique`)
- Keep this module DB-free and side-effect free (no DB I/O, logging, or route/service error mapping).
- Return a structured typed result that can be persisted by `pdf_highlights.py` and reused by `pr-05` quote/enrichment logic without algorithm drift.
- Define typed recoverable matcher anomaly classifications (exception/result types) used by higher-layer policy/logging helpers without violating module purity.

### `python/nexus/services/pdf_quote_match_policy.py`
- Add a shared non-pure policy/helper module for PDF matcher anomaly logging and path-specific mapping, reused by `pr-04` write paths and later `pr-05` enrichment/quote paths.
- Preserve `D07` matcher purity by keeping logging/mapping out of `pdf_quote_match.py`.
- Own canonical structured anomaly log helper(s) and `D12` write-path mapping helpers:
  - recoverable/classified anomaly => degrade-to-`pending` mutation policy inputs (no partial writes)
  - unexpected/unclassified exception => raise/propagate internal failure for fail-closed handling
- Own the canonical `D14` anomaly observability contract:
  - canonical structured event name (`pdf_quote_match_anomaly`)
  - required/optional event fields and no-double-logging ownership rules
  - helper APIs that centralize logging + policy mapping/raising so callers do not re-log the same anomaly decision
- Own the `D15` redaction/privacy contract for anomaly logs:
  - no raw document-derived text (`exact`, `prefix`, `suffix`, `media.plain_text` excerpts)
  - no unsalted text hashes in MVP
  - sanitize exception details/messages before logging
  - emit only approved non-content diagnostics (codes, booleans, lengths, presence flags, ids, and other approved non-sensitive fields)
- Keep this module free of route transport/schema concerns; it may depend on logging and service-layer error helpers but not on route handlers.

### `python/tests/test_highlights.py`
- Add backend integration coverage for S6 PDF highlight API routes and generic highlight-route compatibility:
  - create/list/update/detail/delete
  - annotation upsert/delete on PDF highlights
  - overlap allowed vs exact duplicate conflict
  - payload validation and ready-state/kind guards
  - deterministic page-scoped list ordering
- Add regression coverage proving fragment highlight routes remain behaviorally unchanged.
- Add at least one race-safety/duplicate-enforcement test for exact duplicate concurrent PDF highlight writes (service or route level).

### `python/tests/test_highlight_kernel.py`
- Add unit/service tests for normalized PDF highlight resolution and internal typed-view PDF branch support.
- Verify `pr-04` PDF generic-route reuse does not change the centralized mismatch mapping/logging helper contract (single canonical mismatch event behavior remains intact).

### `python/tests/test_pdf_highlight_geometry.py`
- Add pure unit tests for geometry canonicalization/fingerprinting/sort-key derivation and degeneracy rejection.
- Make order-equivalent inputs and quantization edge cases explicit so canonicalization is deterministic and regression-resistant.

### `python/tests/test_pdf_quote_match.py`
- Add pure unit tests for deterministic PDF quote-match result classification and `prefix/suffix` derivation (`plain_text_match_version=1`).
- Cover page-scoped unique matches, ambiguous matches, no-match, and page-span-unavailable fallback behavior.
- Verify empty/non-empty `prefix/suffix` outputs follow the shared helper contract exactly.
- Verify typed recoverable matcher anomaly classifications are exposed without logging side effects.

### `python/tests/test_pdf_quote_match_policy.py`
- Add unit/service tests for structured matcher anomaly logging helpers and path-specific mapping helpers reused by `pr-04`/`pr-05`.
- Verify `D12` write-path mapping contract (`recoverable => pending inputs`, unexpected => internal failure path) is enforced without mutating matcher purity.
- Verify `D14` canonical event name/required fields and the no-double-logging helper ownership contract.
- Verify `D15` no-content logging contract and exception-detail sanitization behavior for matcher anomaly events.

### `python/tests/test_pdf_locking.py`
- Add unit tests for media-scoped coordination lock key derivation and ordered lock helper behavior.
- Verify lock namespace stability and ordering helper semantics without requiring PDF geometry canonicalization logic.

### `python/tests/test_permissions.py`
- Add or adjust coverage proving `can_read_highlight(...)` and generic visibility helpers work for normalized PDF highlights via the existing `highlight_kernel` seam (no fragment-only regression).

---

## decision ledger

| question | decision | rationale | fallback/default |
|---|---|---|---|
| Where should `pr-04` place PDF geometry canonicalization/fingerprinting logic and how should pure canonicalization be separated from DB write orchestration? | **Accepted (`S6-PR04-D01`)**: use a dedicated pure geometry module (`python/nexus/services/pdf_highlight_geometry.py`) for canonicalization/fingerprinting/sort-key derivation, and keep transactional DB validation/persistence/duplicate/coherence enforcement in highlight service orchestration (`python/nexus/services/pdf_highlights.py` under `S6-PR04-D04`, reached via the generic `highlights.py` compatibility layer). | Preserves a single authoritative deterministic geometry implementation, keeps canonicalization deeply unit-testable without DB setup, prevents create/update drift, and keeps transactional correctness centralized in the service layer. This is the cleanest production-ready MVP split without premature abstraction. | If implementation friction appears, keep the pure-geometry vs transactional-service split and extract small helpers within those modules; do not move canonicalization math into routes or duplicate it across create/update paths. |
| What exact race-safe duplicate enforcement strategy should `pr-04` use for PDF highlight writes (transactional enforcement only vs schema/index refinement now) while honoring the `pr-01` deferred-hardening posture? | **Accepted (`S6-PR04-D02`)**: service-level transactional duplicate enforcement using canonical geometry identity with a transaction-scoped Postgres advisory lock + duplicate recheck (no schema/index refinement in `pr-04` unless implementation proves it necessary). | Delivers exact duplicate race safety without schema churn, preserves the `pr-01` deferred-hardening posture, and keeps lock scope precise to the canonical duplicate identity instead of over-serializing writes at media/page scope. Produces a clean, testable production-ready MVP and leaves room for later DB hardening if warranted. | If implementation friction appears, preserve service-level transactional race safety and duplicate recheck semantics (fallback to a coarser transactional lock only if needed); do not ship a naive check-then-insert race window or force schema/index refinement into `pr-04` without a new decision. |
| How should `pr-04` evolve the public highlight response schema(s) so generic routes can return typed PDF highlights while preserving fragment-route compatibility for existing clients/tests? | **Accepted (`S6-PR04-D03`)**: introduce an explicit anchor-discriminated generic highlight response schema for generic highlight routes and PDF highlight routes, while preserving fragment-route response compatibility (including legacy fragment fields where required by existing fragment-route contracts/tests). | Satisfies the S6 typed-highlight contract without breaking established fragment-route clients/tests. Provides a clear migration path: generic routes become future-proof and typed, while fragment routes remain stable during the PDF rollout. This is the lowest-risk production-ready MVP response strategy. | If implementation friction appears, preserve the core split (typed generic responses + fragment-route compatibility). Do not ship fragment-only generic responses for PDF highlights or force a full fragment-route response migration in `pr-04` without a new decision. |
| How should `pr-04` split PDF highlight write/read logic between `python/nexus/services/highlights.py` and any new PDF-specific service helper/module while preserving the `D01` pure-geometry split and `pr-02` kernel reuse? | **Accepted (`S6-PR04-D04`)**: introduce a dedicated `python/nexus/services/pdf_highlights.py` module for PDF highlight create/list/update transactional orchestration, while keeping `python/nexus/services/highlights.py` as the generic/fragment orchestration layer and route-facing compatibility surface. | Keeps `pr-04` reviewable and maintainable without a broad highlight-service refactor, concentrates PDF-specific complexity (canonicalization orchestration, advisory-lock duplicate enforcement, PDF subtype persistence/coherence) in one module, and preserves existing generic-route and `highlight_kernel` seams. Best production-ready MVP service split. | If implementation friction appears, preserve the split between `pdf_highlights.py` (PDF orchestration) and `highlights.py` (generic/fragment compatibility); do not collapse all PDF logic back into `highlights.py` or perform a full multi-module highlight-service re-architecture in `pr-04` without a new decision. |
| How should `pr-04` evolve the generic `PATCH /highlights/{highlight_id}` request schema/validation to support both fragment offset updates and PDF bounds replacement while preserving fragment-client compatibility and preventing ambiguous mixed payloads? | **Accepted (`S6-PR04-D05`)**: use a backward-compatible unified PATCH schema that preserves existing fragment fields (`start_offset`, `end_offset`, `color`) and adds a nested `pdf_bounds` payload for PDF bounds replacement, with strict mutual exclusivity between fragment offsets and `pdf_bounds`, plus service-level anchor-kind validation/dispatch. | Preserves fragment PATCH compatibility, prevents ambiguous mixed payloads, and makes PDF bounds replacement explicit and testable. Keeps transport validation clear while allowing typed service dispatch for fragment vs PDF highlights. Best production-ready MVP evolution of the generic PATCH route. | If implementation friction appears, preserve the unified backward-compatible PATCH contract and mutual-exclusivity guarantees; do not require a new discriminated PATCH request contract in `pr-04` or allow ambiguous flat mixed payloads without a new decision. |
| What exact `pr-04` write-time behavior should PDF highlight create/bounds-update use for `plain_text_match_*` metadata and `prefix/suffix` fields (attempt deterministic match enrichment now vs initialize/reset pending and defer enrichment to `pr-05`)? | **Accepted (`S6-PR04-D06`)**: `pr-04` implements S6 write-time PDF match metadata computation on create/bounds-update when PDF quote-text infrastructure is ready, and persists/resets `pending` + empty `prefix/suffix` only when quote-text infrastructure is not ready. `pr-05` owns quote rendering usage and follow-on enrichment paths, not the core write-time storage contract. | Aligns `pr-04` with the normative S6 write-path contract (`2.4` match lifecycle step 2 and stored `prefix/suffix` rules), keeps highlight write responses/storage semantically correct as soon as PDF quote text is ready, and prevents pushing core persistence semantics into the quote-rendering PR. Best production-ready MVP separation of concerns. | If implementation friction appears, preserve synchronous write-time match metadata/prefix-suffix computation semantics for ready PDFs and `pending` fallback for not-ready PDFs; do not degrade all `pr-04` writes to `pending` by default or defer normative write-path match computation to `pr-05` without an explicit L2/L3 decision change. |
| Where should the deterministic PDF quote-match algorithm/prefix-suffix derivation helper live for `pr-04` writes and later `pr-05` enrichment/quote paths (reuse boundary to avoid duplication)? | **Accepted (`S6-PR04-D07`)**: use a shared pure helper module (`python/nexus/services/pdf_quote_match.py`) reused by `pdf_highlights.py` in `pr-04` and quote/enrichment paths in `pr-05`. | Prevents algorithm drift across write-time persistence and quote/enrichment behavior, provides one authoritative deterministic implementation of a correctness-critical matcher, and keeps the module pure/DB-free for exact unit testing. Best production-ready MVP reuse boundary. | If implementation friction appears, preserve a single shared pure helper module for deterministic PDF matching and `prefix/suffix` derivation; do not duplicate the algorithm across `pdf_highlights.py` and quote/enrichment services or push DB/logging concerns into the matcher without a new decision. |
| What exact deterministic hashing/serialization contract should `pr-04` use for persisted `geometry_fingerprint` and advisory-lock key derivation so duplicate identity is stable and concurrency behavior is testable? | **Accepted (`S6-PR04-D08`)**: canonical geometry identity bytes in `pdf_highlight_geometry.py`; persisted `geometry_fingerprint` is SHA-256 lowercase hex over canonical identity bytes (`geometry_version`, `page_number`, normalized quads); advisory-lock key is a stable namespaced deterministic `int64` derived from the full duplicate identity (`user_id`, `media_id`, `page_number`, `geometry_version`, `geometry_fingerprint`) with duplicate recheck preserved for correctness. | Prevents unstable process-dependent hashing, makes fingerprint and lock-key derivation deterministic/testable across environments, and preserves `D02` correctness even if advisory-lock key collisions occur (duplicate recheck remains authoritative). Best production-ready MVP hash/lock contract without schema churn. | If implementation friction appears, preserve deterministic canonical byte serialization + non-process-dependent hashing semantics and keep duplicate recheck authoritative; do not use Python `hash()` or implicit object/float string hashing for persisted fingerprints or lock keys. |
| What transaction sequencing and advisory-lock scope should `pr-04` use for PDF create/bounds-update so `D02` duplicate race safety, `D06` write-time match persistence, and `D07` shared matcher reuse remain atomic while lock contention stays bounded? | **Accepted (`S6-PR04-D09`)**: canonicalize geometry and compute deterministic match results before advisory-lock acquisition; acquire a media-scoped coordination advisory lock first, then the duplicate-identity advisory lock; perform duplicate recheck + atomic persistence under the locks; keep duplicate lock hold time bounded and duplicate recheck authoritative. | Balances correctness and throughput: duplicate race safety remains exact, write-time match persistence remains atomic with stored rows, and lock contention is bounded by keeping pure canonicalization/matching work outside the duplicate lock. Explicit lock ordering also provides a safe interop contract with `pr-03` text-rebuild/invalidation paths. | If implementation friction appears, preserve the lock-ordering contract (media coordination lock -> duplicate lock) and duplicate recheck authority, and keep duplicate lock hold time minimized; do not hold the duplicate lock across expensive pure matching/canonicalization work without a new decision. |
| Where should the shared media-scoped coordination lock helper live so `pr-04` PDF highlight writes and `pr-03` internal PDF text-rebuild/invalidation paths reuse the same lock namespace/ordering contract without duplication or drift? | **Accepted (`S6-PR04-D10`)**: a small shared helper module (`python/nexus/services/pdf_locking.py`) owns media-scoped coordination lock key derivation and lock-order helper(s), and is reused by `pdf_highlights.py` in `pr-04` plus narrow `pr-03` interop patches for internal text rebuild/invalidation paths. | Prevents lock namespace/order drift across `pr-03`/`pr-04`, avoids cross-domain coupling between highlights and lifecycle/ingest modules, and keeps concurrency correctness in one low-level reusable seam. Best production-ready MVP placement for the shared coordination lock contract. | If implementation friction appears, preserve one shared low-level PDF locking helper module for coordination-lock key derivation/order helpers; do not duplicate lock-key/order logic across `pdf_highlights.py` and `pdf_lifecycle`/`pdf_ingest` without a new decision. |
| How should `pr-04` split duplicate-identity advisory-lock key ownership between `pdf_highlight_geometry.py` (`D08`) and the shared `pdf_locking.py` module (`D10`) so lock helpers are reusable without redefining canonical geometry identity? | **Accepted (`S6-PR04-D11`)**: `pdf_highlight_geometry.py` owns canonical geometry identity + deterministic duplicate-identity advisory-lock key derivation primitives; `pdf_locking.py` owns media coordination lock keys and generic ordered advisory-lock acquisition helpers, and may wrap duplicate-lock acquisition only by calling geometry-owned duplicate-key derivation. | Preserves `D08` canonical-identity ownership, keeps `pdf_locking.py` low-coupling and reusable, prevents duplicate-lock key drift, and cleanly separates pure identity semantics from lock mechanics. Best production-ready MVP boundary between geometry and locking helpers. | If implementation friction appears, preserve geometry-owned duplicate-key derivation and keep `pdf_locking.py` limited to coordination-lock keys + lock mechanics; do not duplicate canonical duplicate-identity logic across modules without a new decision. |
| What error policy should `pr-04` use when write-time PDF quote-match computation (`D06`/`D07`) encounters unexpected anomalies on quote-ready media (matcher exception or inconsistent text artifacts) during create/bounds-update? | **Accepted (`S6-PR04-D12`)**: deterministic matcher outcomes persist normally; recoverable/classified matcher anomalies on quote-ready media degrade to `plain_text_match_status='pending'` + empty `prefix/suffix` with structured anomaly logging; unexpected/unclassified exceptions fail the mutation (`500`) with no partial write. | Balances highlight UX resilience and engineering rigor: recoverable artifact anomalies do not block highlighting, while real programmer/runtime bugs are not silently masked. Preserves S6 degrade-safe semantics and fits `D09` atomic write guarantees cleanly. | If implementation friction appears, preserve the classified hybrid policy (recoverable anomaly degrade-to-`pending`; unclassified exception fail-closed) and no-partial-write guarantees; do not convert to blanket fail-open or blanket fail-closed behavior without a new decision. |
| Where should write-time PDF matcher anomaly classification types and structured anomaly logging boundaries live so `D12` is implemented consistently across `pr-04` writes and later `pr-05` enrichment without violating `D07` (pure matcher, no logging)? | **Accepted (`S6-PR04-D13`)**: use a two-layer split where `pdf_quote_match.py` remains pure/log-free and exposes typed recoverable anomaly classifications, while a shared non-pure `pdf_quote_match_policy.py` module owns structured anomaly logging and path-specific mapping helpers reused by `pr-04` writes and `pr-05` enrichment/quote paths. | Preserves `D07` matcher purity while preventing `pr-04`/`pr-05` drift on a correctness/observability-critical policy. Keeps classification testable in pure unit tests and logging/mapping testable at the service-policy layer. | If implementation friction appears, preserve the two-layer split (pure matcher classification + shared policy logging/mapping). Do not move logging into `pdf_quote_match.py` or duplicate anomaly taxonomies/log schemas in `pdf_highlights.py`/`pr-05` services without a new decision. |
| What exact structured anomaly log event schema and helper API contract should `pdf_quote_match_policy.py` expose so `pr-04` and `pr-05` reuse one observability surface for `D12`/enrichment anomaly handling without log drift or double-logging? | **Accepted (`S6-PR04-D14`)**: `pdf_quote_match_policy.py` owns a canonical `pdf_quote_match_anomaly` event schema (required anomaly classification + target context fields, with optional non-sensitive diagnostics), centralized helper logging/mapping APIs, and an explicit no-double-logging rule for callers; helper APIs return typed policy outcomes for recoverable cases and raise typed internal failures for unclassified cases. | Locks observability consistency across `pr-04` and `pr-05`, prevents duplicate anomaly event noise, and keeps logging/mapping ownership in the shared policy layer established by `D13`. This is the minimum production-ready observability contract for matcher anomaly handling. | If implementation friction appears, preserve a single canonical event name/schema and centralized helper logging ownership in `pdf_quote_match_policy.py`; do not let callers define local event names/fields or re-log the same anomaly decision without a new decision. |
| What exact redaction/privacy contract should `pdf_quote_match_policy.py` anomaly logging follow for document-derived text inputs (`exact`, `prefix/suffix`, `media.plain_text`) so observability remains useful without leaking user content? | **Accepted (`S6-PR04-D15`)**: anomaly logs include no raw document-derived text (`exact`, `prefix`, `suffix`, `media.plain_text` excerpts) and no unsalted text hashes in MVP; `pdf_quote_match_policy.py` must sanitize exception details/messages and emit only approved non-content diagnostics (codes, ids, booleans, presence flags, lengths/counts, and other non-sensitive fields). | Establishes a strong default privacy posture for production telemetry while preserving useful debugging signal through structured non-content diagnostics. Prevents accidental user-content leakage via matcher anomaly logs and keeps the policy consistent across `pr-04` and `pr-05`. | If implementation friction appears, preserve the no-raw-text/no-unsalted-hash contract and centralized sanitization in `pdf_quote_match_policy.py`; do not add raw excerpts or default text hashes to anomaly logs without an explicit new decision. |
| What exact error-code/status mapping should generic `PATCH /highlights/{id}` use when a syntactically valid `pdf_bounds` payload targets a non-PDF highlight (or fragment offsets target a PDF highlight) under the unified backward-compatible PATCH schema? | **Accepted (`S6-PR04-D16`)**: service-level anchor-kind dispatch rejects cross-kind but syntactically valid unified PATCH payloads with `400 E_INVALID_REQUEST` (after visibility/resource resolution), returns deterministic machine-readable anchor-kind mismatch details, and applies no mutation. | Keeps `D05` transport validation focused on shape while classifying cross-kind payloads correctly as client semantic errors (not conflicts/internal failures). Produces deterministic unified PATCH behavior across fragment/PDF highlights without introducing a new narrow error code. | If implementation friction appears, preserve service-level semantic rejection with `400 E_INVALID_REQUEST`, no mutation, and deterministic anchor-kind mismatch details; do not remap these cases to `409` or `500` without a new decision. |
| What exact idempotency/no-op contract should generic `PATCH /highlights/{id}` use for PDF bounds replacements that canonicalize to the highlight’s existing geometry identity (same canonical geometry, maybe different raw input ordering/jitter)? | **Accepted (`S6-PR04-D17`)**: self-same canonical geometry is not a duplicate conflict (duplicate checks exclude the target highlight id); generic PATCH succeeds (`200`) and remains a normal success path, with write-time derived fields recomputed/persisted when mutable inputs (e.g., `exact`, `color`) change, and idempotent no-op success allowed when effective persisted state is unchanged. | Preserves client retry idempotency, avoids false duplicate conflicts on semantically identical geometry, and keeps write-time `exact`/match/prefix-suffix correctness intact. Allows performance optimizations (e.g., skipping unnecessary quad rewrites) without making them part of the external API contract. | If implementation friction appears, preserve the no-conflict self-same-geometry rule and success response semantics; do not treat self-same canonical geometry as `E_HIGHLIGHT_CONFLICT` or force a failure path without a new decision. |
| What exact timestamp/persistence semantics should generic `PATCH /highlights/{id}` use for fully identical effective updates (self-same canonical geometry and no effective field changes) on PDF highlights? | **Accepted (`S6-PR04-D18`)**: fully identical effective PATCH is a true no-op success (`200`) with no persisted-state mutation, no `updated_at` bump, and no quad/subtype row rewrites; if any effective mutable value differs, normal update semantics (including `updated_at` changes) apply. | Provides strong idempotency semantics, avoids audit/cache noise, and keeps PATCH behavior deterministic and efficient for retries while preserving normal mutation behavior when anything actually changes. | If implementation friction appears, preserve the observable no-op contract (success with unchanged persisted state/timestamps); do not rewrite/bump `updated_at` for fully identical effective updates without a new decision. |
| May `pr-04` short-circuit fully identical effective PDF PATCH requests before acquiring the `D09` media/duplicate advisory locks (to avoid unnecessary lock contention), and if so under what safety conditions? | **Accepted (`S6-PR04-D19`)**: a guarded hybrid policy allows an optional pre-`D09` no-op short-circuit only when a transaction-scoped target-row lock is held and fully identical effective state is safely proven (including no derived-field recomputation need); otherwise the normal `D09` lock sequence is used, while `D18` no-op semantics remain observable either way. | Preserves `D18` no-op correctness while preventing stale-snapshot short-circuits under concurrency. Reduces lock contention for true no-ops without making the optimization mandatory, and keeps the normal `D09` path as the safe fallback. | If implementation friction appears, skip the optimization and always use `D09`; preserve `D18` observable no-op semantics and do not introduce unsafe pre-lock short-circuits without the target-row-lock + safe-equality-proof conditions. |
| Should `pr-04` require a single canonical service helper/path for PDF PATCH effective-state comparison (used by both pre-`D09` short-circuit checks and post-lock no-op detection) to avoid drift in “effective equality” logic? | **Accepted (`S6-PR04-D20`)**: require one canonical deterministic side-effect-free effective-state comparison helper/path in `pdf_highlights.py` (or an equivalent narrowly scoped helper in the same service boundary), reused by guarded pre-`D09` short-circuit gating and post-lock no-op detection; the helper returns a structured comparison result with an explicit `requires_full_path`/safe-fallback outcome when equality cannot be safely proven. | Prevents equality/no-op drift across optimized vs fallback PATCH branches, keeps `D17`/`D18`/`D19` semantics consistent (including no-op detection and timestamp behavior), and provides one testable correctness seam for a subtle idempotency path. | If implementation friction appears, preserve one canonical comparison logic path and the explicit fallback-to-`D09` outcome; do not duplicate effective-equality checks across branches or replace the structured outcome with ambiguous booleans without a new decision. |

---

## traceability matrix

| l3 acceptance item | deliverable(s) | test(s) |
|---|---|---|
| PDF highlight create/list/update flows are available with 1-based page numbering and canonical page-space geometry payload semantics. | `python/nexus/api/routes/highlights.py`; `python/nexus/schemas/highlights.py`; `python/nexus/services/highlights.py`; `python/nexus/services/pdf_highlights.py`; `python/nexus/services/pdf_quote_match.py`; `python/tests/test_highlights.py`; `python/tests/test_pdf_quote_match.py` | `test_pr04_create_pdf_highlight_success_with_1_based_page_number_and_canonical_page_space_payload`; `test_pr04_create_pdf_highlight_rejects_non_pdf_media_kind`; `test_pr04_create_pdf_highlight_rejects_not_ready_media_for_mutation`; `test_pr04_create_pdf_highlight_rejects_invalid_page_number_range`; `test_pr04_list_pdf_highlights_page_scoped_success`; `test_pr04_list_pdf_highlights_defaults_mine_only_and_supports_visible_shared_rows`; `test_pr04_patch_pdf_highlight_color_only_update_via_generic_route`; `test_pr04_patch_pdf_highlight_bounds_replaces_geometry_via_generic_route`; `test_pr04_patch_pdf_highlight_rejects_partial_geometry_patch_payload`; `test_pr04_patch_pdf_highlight_rejects_mixed_fragment_and_pdf_bounds_payload`; `test_pr04_patch_pdf_highlight_self_same_canonical_geometry_identical_effective_state_succeeds_idempotently`; `test_pr04_create_pdf_highlight_computes_match_metadata_and_prefix_suffix_when_quote_text_ready`; `test_pr04_create_or_update_pdf_highlight_sets_pending_and_empty_prefix_suffix_when_quote_text_not_ready`; `test_pr04_pdf_quote_match_v1_page_scoped_unique_match_derives_prefix_suffix` |
| Server-side geometry normalization, fingerprinting, duplicate detection, deterministic ordering, payload bounds, and fingerprint hash encoding follow the S6 contract. | `python/nexus/services/pdf_highlight_geometry.py`; `python/nexus/services/pdf_highlights.py`; `python/nexus/services/highlights.py`; `python/nexus/schemas/highlights.py`; `python/tests/test_pdf_highlight_geometry.py`; `python/tests/test_highlights.py` | `test_pr04_geometry_v1_normalizes_quantizes_and_fingerprints_equivalent_inputs_deterministically`; `test_pr04_geometry_v1_derives_deterministic_sort_keys`; `test_pr04_geometry_v1_fingerprint_uses_stable_sha256_hex_over_canonical_identity_bytes`; `test_pr04_create_pdf_highlight_rejects_payload_bounds_violations`; `test_pr04_list_pdf_highlights_uses_deterministic_geometry_ordering_then_created_at_then_id` |
| Overlapping PDF highlights are supported while exact duplicates are rejected per geometry identity rules. | `python/nexus/services/pdf_highlights.py`; `python/tests/test_highlights.py` | `test_pr04_create_pdf_highlight_allows_overlapping_non_identical_geometry`; `test_pr04_create_pdf_highlight_rejects_exact_duplicate_geometry_with_conflict` |
| PDF logical highlight writes use the unified `highlights` core together with the `pr-01` transitional legacy-fragment-column bridge (`fragment_id/start_offset/end_offset` remain `NULL` for PDF rows under bridge constraints). | `python/nexus/services/pdf_highlights.py`; `python/tests/test_highlights.py` | `test_pr04_create_pdf_highlight_persists_unified_logical_row_with_pdf_subtypes_and_null_fragment_bridge` |
| `pr-04` owns exact race-safe PDF duplicate enforcement for PDF highlight writes (transactional enforcement and/or schema/index refinement), building on `pr-01` supporting indexes. | `python/nexus/services/pdf_highlights.py`; `python/nexus/services/pdf_highlight_geometry.py`; `python/tests/test_highlights.py`; `python/tests/test_pdf_highlight_geometry.py` | `test_pr04_create_pdf_highlight_exact_duplicate_race_results_in_one_success_one_conflict`; `test_pr04_patch_pdf_highlight_self_same_canonical_geometry_is_not_treated_as_duplicate_conflict`; `test_pr04_pdf_duplicate_advisory_lock_key_derivation_is_stable_and_namespaced` |
| `pr-04` write-time PDF mutations use the accepted lock-ordering/transaction-sequencing contract (media coordination lock before duplicate lock; duplicate lock held only for duplicate recheck + atomic persistence) and remain interoperable with `pr-03` text-rebuild/invalidation locking semantics, with `D19` guarded pre-lock no-op short-circuit allowed only under the approved safety conditions. | `python/nexus/services/pdf_highlights.py`; `python/nexus/services/pdf_highlight_geometry.py`; `python/nexus/services/pdf_locking.py`; `python/tests/test_highlights.py`; `python/tests/test_pdf_locking.py` | `test_pr04_pdf_highlight_write_acquires_media_coordination_lock_before_duplicate_lock`; `test_pr04_pdf_highlight_write_keeps_duplicate_lock_scope_bounded_to_recheck_and_atomic_persist`; `test_pr04_pdf_highlight_write_locking_interops_with_pdf_text_rebuild_invalidation_lock_contract`; `test_pr04_pdf_patch_safe_prelock_noop_short_circuit_uses_target_row_lock_and_skips_d09_locks`; `test_pr04_pdf_patch_when_safe_noop_cannot_be_proven_falls_back_to_d09_path_and_preserves_d18_noop_semantics`; `test_pr04_pdf_locking_media_coordination_key_is_stable_and_namespaced`; `test_pr04_pdf_locking_ordered_helper_enforces_media_then_duplicate_lock_sequence` |
| `pr-04` uses one canonical deterministic effective-state comparison helper/path for PDF PATCH no-op detection across guarded pre-lock short-circuit and post-lock `D09` branches, preventing equality/no-op drift between optimization and fallback paths. | `python/nexus/services/pdf_highlights.py`; `python/tests/test_highlights.py` | `test_pr04_pdf_patch_prelock_and_postlock_paths_reuse_single_effective_state_comparison_helper`; `test_pr04_pdf_patch_effective_state_comparison_helper_returns_requires_full_path_when_safe_equality_cannot_be_proven` |
| `pr-04` owns PDF geometry canonicalization semantics (degeneracy rejection, quantization, canonical ordering, fingerprint correctness), building on the `pr-01` `highlight_pdf_quads` row-shape schema. | `python/nexus/services/pdf_highlight_geometry.py`; `python/tests/test_pdf_highlight_geometry.py` | `test_pr04_geometry_v1_rejects_degenerate_quads`; `test_pr04_geometry_v1_is_order_invariant_for_equivalent_quad_inputs`; `test_pr04_geometry_v1_fingerprint_changes_for_material_geometry_changes` |
| `pr-04` owns authoritative transactional write-time validation of `highlight_pdf_anchors` cross-table coherence and geometry-derived anchor fields (beyond the row-local domains introduced in `pr-01`), including mismatch rejection without trigger-based enforcement. | `python/nexus/services/pdf_highlights.py`; `python/nexus/services/highlights.py`; `python/tests/test_highlights.py` | `test_pr04_pdf_highlight_write_validates_anchor_media_and_anchor_kind_coherence_transactionally`; `test_pr04_pdf_highlight_write_rejects_pdf_rows_with_non_null_fragment_bridge_fields` |
| `pr-04` and `pr-05` share one deterministic PDF quote-match implementation boundary for write-time match metadata/prefix-suffix derivation and later quote/enrichment reuse (no algorithm duplication across services). | `python/nexus/services/pdf_quote_match.py`; `python/nexus/services/pdf_highlights.py`; `python/tests/test_pdf_quote_match.py`; `python/tests/test_highlights.py` | `test_pr04_pdf_quote_match_v1_page_scoped_unique_match_derives_prefix_suffix`; `test_pr04_pdf_quote_match_v1_ambiguous_or_no_match_returns_empty_prefix_suffix`; `test_pr04_pdf_quote_match_v1_fallbacks_only_when_page_span_unavailable`; `test_pr04_create_pdf_highlight_uses_shared_pdf_quote_match_helper_contract` |
| `pr-04` write-time match metadata persistence handles deterministic match outcomes and approved anomaly policy on quote-ready media without corrupting highlight writes. | `python/nexus/services/pdf_highlights.py`; `python/nexus/services/pdf_quote_match.py`; `python/tests/test_highlights.py` | `test_pr04_create_pdf_highlight_persists_deterministic_match_outcomes_unique_ambiguous_no_match`; `test_pr04_patch_pdf_highlight_self_same_canonical_geometry_recomputes_match_metadata_when_exact_changes`; `test_pr04_write_time_pdf_match_recoverable_anomaly_degrades_to_pending_with_empty_prefix_suffix`; `test_pr04_write_time_pdf_match_unclassified_exception_fails_mutation_without_partial_write` |
| `pr-04` implements the `D12`/`D13`/`D14`/`D15` anomaly classification/logging boundary without violating `D07` purity (matcher classifies, shared policy logs/maps, services reuse policy helpers). | `python/nexus/services/pdf_quote_match.py`; `python/nexus/services/pdf_quote_match_policy.py`; `python/nexus/services/pdf_highlights.py`; `python/tests/test_pdf_quote_match.py`; `python/tests/test_pdf_quote_match_policy.py`; `python/tests/test_highlights.py` | `test_pr04_pdf_quote_match_exposes_typed_recoverable_anomaly_classification_without_logging`; `test_pr04_pdf_quote_match_policy_maps_recoverable_anomaly_to_pending_write_outcome`; `test_pr04_pdf_quote_match_policy_raises_internal_for_unclassified_matcher_exception`; `test_pr04_pdf_quote_match_policy_emits_canonical_pdf_quote_match_anomaly_event_with_required_fields`; `test_pr04_pdf_quote_match_policy_omits_raw_document_text_and_unsalted_text_hashes_from_anomaly_event`; `test_pr04_pdf_quote_match_policy_sanitizes_exception_message_to_avoid_document_text_leakage`; `test_pr04_pdf_highlight_write_logs_structured_match_anomaly_and_maps_to_pending_using_shared_policy_helper`; `test_pr04_pdf_highlight_write_does_not_double_log_pdf_quote_match_anomaly_when_policy_helper_handles_logging` |
| Any DB-level hardening for PDF anchor cross-table coherence is explicitly deferred to a later dedicated hardening/contraction step and is not a prerequisite for S6 `pr-04` completion. | `python/nexus/services/pdf_highlights.py`; `python/tests/test_highlights.py` | `test_pr04_pdf_highlight_duplicate_and_coherence_rules_are_enforced_transactionally_without_trigger_or_schema_hardening_changes` |
| `pr-04` reuses the dedicated `pr-02` `highlight_kernel` shared logical-highlight media-resolution and typed serializer/service seams for generic highlight detail/delete/annotation compatibility rather than reintroducing fragment-only assumptions, preserves the side-effect-free/log-free resolver posture for read-only paths, preserves `pr-02` path-specific fail-safe mismatch mapping classes on reused generic routes, reuses the centralized `highlight_kernel` mismatch logging/mapping helper contract, and preserves `dormant_repairable` tolerated-read-only semantics unless a later spec explicitly tightens them. | `python/nexus/services/highlight_kernel.py`; `python/nexus/services/highlights.py`; `python/nexus/services/pdf_highlights.py`; `python/tests/test_highlight_kernel.py`; `python/tests/test_highlights.py`; `python/tests/test_permissions.py` | `test_pr04_highlight_kernel_resolver_returns_ok_for_normalized_pdf_highlight`; `test_pr04_highlight_kernel_internal_typed_view_supports_pdf_branch`; `test_pr04_get_pdf_highlight_route_uses_kernel_mismatch_mapping_contract_without_duplicate_mismatch_logs`; `test_pr04_can_read_highlight_supports_normalized_pdf_highlight_via_kernel` |
| Generic highlight detail/delete/annotation interactions remain compatible with typed-highlight semantics. | `python/nexus/api/routes/highlights.py`; `python/nexus/schemas/highlights.py`; `python/nexus/services/highlights.py`; `python/nexus/services/pdf_highlights.py`; `python/tests/test_highlights.py` | `test_pr04_get_highlight_returns_anchor_discriminated_pdf_highlight_out`; `test_pr04_delete_pdf_highlight_cascades_annotation_via_generic_route`; `test_pr04_put_and_delete_annotation_on_pdf_highlight_match_existing_semantics`; `test_pr04_patch_pdf_highlight_rejects_pdf_bounds_payload_for_fragment_highlight_with_deterministic_client_error`; `test_pr04_patch_pdf_highlight_rejects_fragment_offsets_payload_for_pdf_highlight_with_deterministic_client_error`; `test_pr04_fragment_highlight_routes_remain_behaviorally_unchanged_after_pdf_rollout` |

---

## acceptance tests

### file: `python/tests/test_pdf_highlight_geometry.py`

**test: `test_pr04_geometry_v1_normalizes_quantizes_and_fingerprints_equivalent_inputs_deterministically`**
- input: two logically equivalent PDF quad payloads for the same page with different quad order and float jitter beyond/within quantization thresholds.
- output: canonicalization produces `geometry_version=1`, equal normalized quads, equal `geometry_fingerprint`, and equal sort keys.

**test: `test_pr04_geometry_v1_derives_deterministic_sort_keys`**
- input: canonicalizable multi-quad payloads with different vertical/horizontal positions.
- output: derived `sort_top` / `sort_left` are deterministic and match S6 ordering expectations for page-scoped list ordering.

**test: `test_pr04_geometry_v1_rejects_degenerate_quads`**
- input: zero-area/degenerate quad payloads.
- output: canonicalization rejects the payload with a deterministic validation error suitable for `E_INVALID_REQUEST`.

**test: `test_pr04_geometry_v1_is_order_invariant_for_equivalent_quad_inputs`**
- input: the same highlight region encoded with quads in different input orders and vertex orderings.
- output: canonicalized quads and fingerprint are identical.

**test: `test_pr04_geometry_v1_fingerprint_changes_for_material_geometry_changes`**
- input: two materially different geometries on the same page after canonicalization.
- output: fingerprints differ and duplicate identity does not collide.

**test: `test_pr04_geometry_v1_fingerprint_uses_stable_sha256_hex_over_canonical_identity_bytes`**
- input: a canonicalized geometry fixture and its canonical identity byte serialization.
- output: `geometry_fingerprint` equals the lowercase SHA-256 hex digest of the canonical identity bytes and is stable across repeated runs.

**test: `test_pr04_pdf_duplicate_advisory_lock_key_derivation_is_stable_and_namespaced`**
- input: duplicate-identity tuples (`user_id`, `media_id`, `page_number`, `geometry_version`, `geometry_fingerprint`) including same-geometry/different-user and same-user/different-media cases.
- output: advisory-lock key derivation returns deterministic `int64` values, changes when namespaced identity inputs change, and does not rely on Python `hash()`.

### file: `python/tests/test_pdf_locking.py`

**test: `test_pr04_pdf_locking_media_coordination_key_is_stable_and_namespaced`**
- input: media IDs (and any lock-namespace discriminator inputs) across repeated runs and differing PDF media identities.
- output: media-scoped coordination lock key derivation is deterministic, namespaced, and independent of Python `hash()`.

**test: `test_pr04_pdf_locking_ordered_helper_enforces_media_then_duplicate_lock_sequence`**
- input: instrumented ordered lock helper invocation with both media coordination and duplicate lock keys.
- output: helper acquires locks in the `D09` order (`media coordination` -> `duplicate`) and does not silently invert order.

### file: `python/tests/test_pdf_quote_match.py`

**test: `test_pr04_pdf_quote_match_v1_page_scoped_unique_match_derives_prefix_suffix`**
- input: `exact`, `page_number`, normalized `media.plain_text`, and page-span rows where exactly one page-scoped match exists.
- output: returns `match_status='unique'`, `plain_text_match_version=1`, deterministic offsets, and non-empty derived `prefix/suffix` per S6 rules.

**test: `test_pr04_pdf_quote_match_v1_ambiguous_or_no_match_returns_empty_prefix_suffix`**
- input: cases where page-scoped/global search result is ambiguous or missing.
- output: returns `match_status in {'ambiguous','no_match'}` with null offsets and empty `prefix/suffix`.

**test: `test_pr04_pdf_quote_match_v1_fallbacks_only_when_page_span_unavailable`**
- input: one case with page span present but no page-local match, and one case with page span unavailable.
- output: no global fallback when page span is present; deterministic global fallback only when page span is unavailable, matching S6 rules.

**test: `test_pr04_pdf_quote_match_exposes_typed_recoverable_anomaly_classification_without_logging`**
- input: matcher fixture that triggers a recoverable/classified anomaly (e.g., page-span inconsistency) through the pure matcher path.
- output: matcher exposes the documented typed recoverable anomaly classification (exception/result type) with no logging side effects and no service-level error mapping.

### file: `python/tests/test_pdf_quote_match_policy.py`

**test: `test_pr04_pdf_quote_match_policy_maps_recoverable_anomaly_to_pending_write_outcome`**
- input: typed recoverable matcher anomaly classification from `pdf_quote_match.py` passed into the shared policy helper for a `pr-04` write-path context.
- output: policy helper emits the canonical structured anomaly log event and returns the approved `D12` degrade-to-`pending` write outcome inputs (`pending`, cleared offsets/version, empty `prefix/suffix`) without performing DB writes.

**test: `test_pr04_pdf_quote_match_policy_raises_internal_for_unclassified_matcher_exception`**
- input: unexpected/unclassified matcher exception passed into the shared policy helper for a `pr-04` write-path context.
- output: policy helper emits the canonical structured anomaly log event once and raises/propagates the approved internal failure path (no recoverable downgrade).

**test: `test_pr04_pdf_quote_match_policy_emits_canonical_pdf_quote_match_anomaly_event_with_required_fields`**
- input: a recoverable and an unexpected matcher anomaly handled through `pdf_quote_match_policy.py` with representative write-path context fields.
- output: emitted event name is exactly `pdf_quote_match_anomaly`; required fields are present with stable keys/values per `D14`; optional diagnostics are omitted or present only when provided.

**test: `test_pr04_pdf_quote_match_policy_omits_raw_document_text_and_unsalted_text_hashes_from_anomaly_event`**
- input: matcher anomaly contexts containing document-derived text inputs (`exact`, derived `prefix/suffix`, and simulated plain-text excerpts) plus potential unsalted text-hash candidate diagnostics.
- output: emitted `pdf_quote_match_anomaly` event omits raw text fields and unsalted text hashes entirely, while preserving approved non-content diagnostics (lengths, flags, ids, codes).

**test: `test_pr04_pdf_quote_match_policy_sanitizes_exception_message_to_avoid_document_text_leakage`**
- input: unexpected matcher exception whose message contains document text fragments or other unsafe content.
- output: policy helper logs only sanitized exception diagnostics (e.g., exception type and safe summary), with no leaked document text in event fields.

### file: `python/tests/test_highlights.py`

**test: `test_pr04_create_pdf_highlight_success_with_1_based_page_number_and_canonical_page_space_payload`**
- input: `POST /media/{media_id}/pdf-highlights` on a quote-ready/readable PDF with `page_number=1`, canonical page-space quads, client-captured `exact`, and valid color.
- output: `201` with typed highlight response (`anchor.type='pdf_page_geometry'`), persisted logical row + PDF subtype rows, and deterministic geometry-derived fields.

**test: `test_pr04_create_pdf_highlight_rejects_non_pdf_media_kind`**
- input: call the PDF highlight create route for non-PDF media.
- output: `E_INVALID_KIND` with no highlight rows created.

**test: `test_pr04_create_pdf_highlight_rejects_not_ready_media_for_mutation`**
- input: create a PDF highlight on a PDF media row in a disallowed mutation status (explicitly cover `pending`, `extracting`, and `failed`; mutation-allowed statuses are `ready_for_reading|embedding|ready` per S6).
- output: `409 E_MEDIA_NOT_READY`.

**test: `test_pr04_create_pdf_highlight_rejects_payload_bounds_violations`**
- input: create payloads exceeding `quads.length` bound or non-empty `exact` length bound.
- output: `400 E_INVALID_REQUEST` with no persisted rows.

**test: `test_pr04_create_pdf_highlight_rejects_invalid_page_number_range`**
- input: `page_number=0` or `page_number > media.page_count`.
- output: `400 E_INVALID_REQUEST`.

**test: `test_pr04_create_pdf_highlight_persists_unified_logical_row_with_pdf_subtypes_and_null_fragment_bridge`**
- input: successful PDF highlight create.
- output: `highlights` row has `anchor_kind='pdf_page_geometry'`, `anchor_media_id=media_id`, `fragment_id/start_offset/end_offset IS NULL`; `highlight_pdf_anchors` row + `highlight_pdf_quads` rows exist and are coherent.

**test: `test_pr04_create_pdf_highlight_allows_overlapping_non_identical_geometry`**
- input: create two overlapping PDF highlights on the same page whose canonical fingerprints differ.
- output: both succeed and remain listable in deterministic order.

**test: `test_pr04_create_pdf_highlight_rejects_exact_duplicate_geometry_with_conflict`**
- input: create the same logical PDF highlight twice with geometry that canonicalizes to the same identity.
- output: second request returns `409 E_HIGHLIGHT_CONFLICT`.

**test: `test_pr04_create_pdf_highlight_exact_duplicate_race_results_in_one_success_one_conflict`**
- input: two concurrent create attempts for the same canonical PDF geometry identity.
- output: exactly one succeeds and one returns `E_HIGHLIGHT_CONFLICT` (or equivalent transactional conflict mapping), with no duplicate persisted rows.

**test: `test_pr04_pdf_highlight_write_acquires_media_coordination_lock_before_duplicate_lock`**
- input: instrumented PDF highlight create/bounds-update path with lock helper call-order capture.
- output: write path acquires the media-scoped coordination lock before the duplicate-identity advisory lock on every PDF mutation.

**test: `test_pr04_pdf_highlight_write_keeps_duplicate_lock_scope_bounded_to_recheck_and_atomic_persist`**
- input: instrumented PDF highlight write path with hooks around canonicalization/match computation and duplicate-lock acquire/release.
- output: pure geometry canonicalization and shared matcher computation occur before duplicate-lock acquisition, and duplicate-lock scope covers duplicate recheck + atomic persistence only.

**test: `test_pr04_pdf_highlight_write_locking_interops_with_pdf_text_rebuild_invalidation_lock_contract`**
- input: simulated contention between PDF highlight write and an internal PDF text rebuild/invalidation path using the shared media-scoped coordination lock contract.
- output: operations serialize via the media-scoped lock without deadlock and preserve atomic highlight write / invalidation correctness guarantees.

**test: `test_pr04_list_pdf_highlights_page_scoped_success`**
- input: `GET /media/{media_id}/pdf-highlights?page_number=N` with visible PDF highlights on multiple pages.
- output: only page `N` highlights are returned with typed anchors; response shape is page-scoped and suitable for active-page overlay/pane usage.

**test: `test_pr04_list_pdf_highlights_defaults_mine_only_and_supports_visible_shared_rows`**
- input: list route with and without `mine_only=false` on a shared PDF in a shared library.
- output: default returns viewer-authored rows only; `mine_only=false` returns visible rows under S4 semantics.

**test: `test_pr04_list_pdf_highlights_uses_deterministic_geometry_ordering_then_created_at_then_id`**
- input: multiple page highlights with sort-key ties / created_at ties.
- output: list order matches the S6 deterministic ordering contract.

**test: `test_pr04_get_highlight_returns_anchor_discriminated_pdf_highlight_out`**
- input: `GET /highlights/{highlight_id}` for a PDF highlight.
- output: generic detail route succeeds, returns anchor-discriminated typed highlight output, and preserves masked existence behavior for invisible rows.

**test: `test_pr04_patch_pdf_highlight_color_only_update_via_generic_route`**
- input: `PATCH /highlights/{highlight_id}` for a PDF highlight with color-only update.
- output: color updates without geometry replacement; geometry rows and fingerprint remain unchanged.

**test: `test_pr04_patch_pdf_highlight_bounds_replaces_geometry_via_generic_route`**
- input: `PATCH /highlights/{highlight_id}` for a PDF highlight with full replacement `page_number`, `quads`, and replacement `exact`.
- output: all prior PDF quads are atomically replaced, geometry is re-canonicalized, `geometry_fingerprint` and sort keys recompute, and stored `exact/prefix/suffix` update per S6 rules.

**test: `test_pr04_patch_pdf_highlight_self_same_canonical_geometry_is_not_treated_as_duplicate_conflict`**
- input: `PATCH /highlights/{highlight_id}` with `pdf_bounds` whose raw quads differ in ordering/jitter but canonicalize to the target highlight’s existing geometry identity.
- output: request succeeds (`200`) and is not rejected as `E_HIGHLIGHT_CONFLICT`; duplicate checks exclude the target highlight id.

**test: `test_pr04_patch_pdf_highlight_self_same_canonical_geometry_identical_effective_state_succeeds_idempotently`**
- input: `PATCH /highlights/{highlight_id}` with `pdf_bounds` and other mutable fields that canonicalize/resolve to the same effective persisted state already stored on the target PDF highlight.
- output: request succeeds (`200`) with deterministic final state and no conflict/error; persisted state is unchanged, `updated_at` is not bumped, and quad/subtype rows are not rewritten.

**test: `test_pr04_pdf_patch_safe_prelock_noop_short_circuit_uses_target_row_lock_and_skips_d09_locks`**
- input: instrumented PDF PATCH path for a fully identical effective update where safe equality can be deterministically proven.
- output: implementation may short-circuit before `D09` media/duplicate locks, but only after acquiring a transaction-scoped target-row lock sufficient to stabilize comparison; response still satisfies `D18` no-op semantics.

**test: `test_pr04_pdf_patch_when_safe_noop_cannot_be_proven_falls_back_to_d09_path_and_preserves_d18_noop_semantics`**
- input: PDF PATCH request near the no-op boundary where the implementation cannot safely prove full effective equality pre-lock (or short-circuit optimization is disabled).
- output: path falls back to normal `D09` lock sequencing and still returns the `D18` no-op result (success, no persisted-state mutation, no `updated_at` bump) when effective state is unchanged.

**test: `test_pr04_pdf_patch_prelock_and_postlock_paths_reuse_single_effective_state_comparison_helper`**
- input: instrumented PDF PATCH executions covering both branches:
  - guarded pre-lock no-op short-circuit path (`D19`)
  - normal `D09` path with post-lock no-op detection (`D18`)
- output: both branches invoke the same canonical effective-state comparison helper/path (or equivalent single logic seam) instead of duplicating local equality logic; helper outputs drive branch decisions consistently.

**test: `test_pr04_pdf_patch_effective_state_comparison_helper_returns_requires_full_path_when_safe_equality_cannot_be_proven`**
- input: a PDF PATCH comparison fixture where effective equality cannot be safely proven in the pre-lock optimization branch.
- output: the canonical effective-state comparison helper/path returns a structured `requires_full_path`/safe-fallback outcome (not an ambiguous boolean), and the caller uses the normal `D09` path while preserving `D18` semantics if the update is later proven to be a no-op.

**test: `test_pr04_patch_pdf_highlight_rejects_partial_geometry_patch_payload`**
- input: a PDF bounds-update patch missing required replacement geometry fields (e.g., `quads` omitted while `page_number` present).
- output: `400 E_INVALID_REQUEST`.

**test: `test_pr04_patch_pdf_highlight_rejects_mixed_fragment_and_pdf_bounds_payload`**
- input: generic `PATCH /highlights/{highlight_id}` payload containing both fragment offset fields and `pdf_bounds`.
- output: `400 E_INVALID_REQUEST` from unified PATCH schema validation (or equivalent transport validation), with no mutation applied.

**test: `test_pr04_patch_pdf_highlight_rejects_pdf_bounds_payload_for_fragment_highlight_with_deterministic_client_error`**
- input: syntactically valid generic PATCH payload containing `pdf_bounds` targeting a fragment highlight.
- output: `400 E_INVALID_REQUEST` after highlight visibility/resource resolution, with deterministic machine-readable anchor-kind mismatch details (`offending_field_group='pdf_bounds'`, actual anchor kind, allowed anchor kind(s)); no mutation is applied.

**test: `test_pr04_patch_pdf_highlight_rejects_fragment_offsets_payload_for_pdf_highlight_with_deterministic_client_error`**
- input: syntactically valid generic PATCH payload containing fragment `start_offset`/`end_offset` targeting a PDF highlight.
- output: `400 E_INVALID_REQUEST` after highlight visibility/resource resolution, with deterministic machine-readable anchor-kind mismatch details (`offending_field_group='fragment_offsets'`, actual anchor kind, allowed anchor kind(s)); no mutation is applied.

**test: `test_pr04_create_pdf_highlight_computes_match_metadata_and_prefix_suffix_when_quote_text_ready`**
- input: create a PDF highlight on a quote-ready PDF (`media.plain_text` + `pdf_page_text_spans` present) with `exact` that matches uniquely within the page span.
- output: create path persists deterministic `plain_text_match_*` metadata and derives non-empty `prefix/suffix` per S6 rules within the write lifecycle (no `pending` fallback).

**test: `test_pr04_create_or_update_pdf_highlight_sets_pending_and_empty_prefix_suffix_when_quote_text_not_ready`**
- input: create or bounds-update a PDF highlight when quote-text infrastructure is not yet ready (e.g., missing `plain_text`/page spans).
- output: write path persists `plain_text_match_status='pending'`, clears match offsets/version, and persists `prefix=\"\"`, `suffix=\"\"` while preserving stored `exact`.

**test: `test_pr04_patch_pdf_highlight_self_same_canonical_geometry_recomputes_match_metadata_when_exact_changes`**
- input: quote-ready PDF highlight bounds-update where replacement `pdf_bounds` canonicalizes to the existing geometry identity but incoming `exact` differs.
- output: request succeeds, geometry identity remains unchanged, and write-time `plain_text_match_*` / `prefix` / `suffix` are recomputed/persisted from the replacement `exact` per `D06`/`D12`.

**test: `test_pr04_create_pdf_highlight_persists_deterministic_match_outcomes_unique_ambiguous_no_match`**
- input: quote-ready PDF highlight creates with fixtures producing each deterministic matcher outcome (`unique`, `ambiguous`, `no_match`).
- output: persisted `plain_text_match_status`, offsets/version, and `prefix/suffix` fields match the shared matcher contract for each outcome.

**test: `test_pr04_write_time_pdf_match_recoverable_anomaly_degrades_to_pending_with_empty_prefix_suffix`**
- input: quote-ready PDF highlight create/bounds-update where shared matcher raises a classified/recoverable anomaly (e.g., inconsistent page-span data) under the approved `D12` policy.
- output: highlight mutation succeeds, persists `plain_text_match_status='pending'`, clears offsets/version, persists empty `prefix/suffix`, and emits structured anomaly logging.

**test: `test_pr04_pdf_highlight_write_logs_structured_match_anomaly_and_maps_to_pending_using_shared_policy_helper`**
- input: quote-ready PDF highlight write path with a classified/recoverable matcher anomaly and instrumentation around `pdf_quote_match_policy.py`.
- output: `pdf_highlights.py` reuses the shared policy helper (no local anomaly taxonomy/log schema), emits one canonical structured anomaly event, and applies the approved `D12` degrade-to-`pending` mapping.

**test: `test_pr04_pdf_highlight_write_does_not_double_log_pdf_quote_match_anomaly_when_policy_helper_handles_logging`**
- input: quote-ready PDF highlight write path with matcher anomaly instrumentation capturing structured logs and higher-level service failure logs.
- output: exactly one `pdf_quote_match_anomaly` event is emitted per anomaly-handling decision (from `pdf_quote_match_policy.py`), while any additional service/request log uses a distinct event name/category.

**test: `test_pr04_write_time_pdf_match_unclassified_exception_fails_mutation_without_partial_write`**
- input: quote-ready PDF highlight create/bounds-update where matcher raises an unexpected/unclassified exception.
- output: request fails (`500`-class), and no partial highlight/PDF subtype mutation is committed.

**test: `test_pr04_create_pdf_highlight_uses_shared_pdf_quote_match_helper_contract`**
- input: create/update a PDF highlight on quote-ready media with deterministic matching opportunities and verify service integration against the shared matcher result.
- output: persisted `plain_text_match_*` and `prefix/suffix` fields match the `pdf_quote_match.py` helper contract (no service-local matching drift).

**test: `test_pr04_delete_pdf_highlight_cascades_annotation_via_generic_route`**
- input: create PDF highlight + annotation, then call generic `DELETE /highlights/{id}`.
- output: highlight and annotation are removed; subtype rows/quads are deleted via cascade or service delete path.

**test: `test_pr04_put_and_delete_annotation_on_pdf_highlight_match_existing_semantics`**
- input: use generic annotation PUT/DELETE routes on a PDF highlight.
- output: create/update/delete semantics and status codes match fragment highlight behavior.

**test: `test_pr04_pdf_highlight_write_validates_anchor_media_and_anchor_kind_coherence_transactionally`**
- input: call the PDF highlight write/update path against a deliberately corrupted/tampered PDF highlight row (or inject inconsistency before mutation).
- output: mutation fails safely (no partial write), with mismatch/coherence rejection following `pr-02` kernel/service policy.

**test: `test_pr04_pdf_highlight_write_rejects_pdf_rows_with_non_null_fragment_bridge_fields`**
- input: attempt to persist/update a PDF highlight write that violates the bridge contract by setting fragment bridge fields.
- output: request/service rejects the write and no invalid persisted PDF row survives.

**test: `test_pr04_pdf_highlight_duplicate_and_coherence_rules_are_enforced_transactionally_without_trigger_or_schema_hardening_changes`**
- input: normal PDF create/update flows exercising duplicate/conflict and coherence checks under the `pr-04` implementation.
- output: correctness is enforced by service-level transactional logic; no trigger-based enforcement is required for `pr-04` acceptance.

**test: `test_pr04_get_pdf_highlight_route_uses_kernel_mismatch_mapping_contract_without_duplicate_mismatch_logs`**
- input: generic read or write access to a deliberately mismatched typed highlight state.
- output: path-specific fail-safe mapping and the centralized `highlight_kernel_mismatch` event contract are reused with no duplicate mismatch logging.

**test: `test_pr04_fragment_highlight_routes_remain_behaviorally_unchanged_after_pdf_rollout`**
- input: fragment highlight create/list/get/update/delete/annotation smoke flow after `pr-04` changes land.
- output: fragment behavior remains compatible with existing S2/S4 semantics.

### file: `python/tests/test_highlight_kernel.py`

**test: `test_pr04_highlight_kernel_resolver_returns_ok_for_normalized_pdf_highlight`**
- input: a normalized PDF highlight row with coherent `highlights` logical fields and `highlight_pdf_anchors`/quads.
- output: `resolve_highlight(...)` returns `ResolverState.ok` with `anchor_kind='pdf_page_geometry'` and resolved `anchor_media_id`.

**test: `test_pr04_highlight_kernel_internal_typed_view_supports_pdf_branch`**
- input: build internal typed view for a normalized PDF highlight.
- output: internal typed serializer/view seam supports the PDF branch without regressing the fragment branch.

### file: `python/tests/test_permissions.py`

**test: `test_pr04_can_read_highlight_supports_normalized_pdf_highlight_via_kernel`**
- input: a visible normalized PDF highlight in a shared library.
- output: `can_read_highlight(...)` resolves media via `highlight_kernel` and returns the correct read visibility result without fragment-only assumptions.

---

## non-goals
- No frontend PDF rendering, selection, overlay, or linked-items pane integration (`pr-06`/`pr-07`).
- No PDF quote-to-chat nearby-context enrichment or PDF match-status/offset usage semantics (`pr-05`).
- No media-wide PDF highlight browsing/list pagination route; S6 remains page-scoped via `GET /media/{media_id}/pdf-highlights`.
- No changes to PDF lifecycle/readiness/invalidation rules from `pr-03` (`pdf_lifecycle`, `pdf_ingest`, `pdf_readiness`) beyond route/service reuse.
- No trigger-based DB enforcement or post-S6 contraction hardening for PDF anchor cross-table coherence.

## constraints
- Follow S6 L2 geometry canonicalization contract exactly (`geometry_version=1`), including quantization precision, canonical ordering, degeneracy rejection, and duplicate identity semantics.
- `page_number` is 1-based in public PDF highlight APIs and must satisfy `1..media.page_count`.
- PDF highlight create/update payload coordinates are canonical page-space points, not viewport pixels.
- Overlaps are allowed; exact duplicates are rejected per canonical geometry identity.
- PDF write-time lock ordering for `pr-04` mutations is `media-scoped coordination lock` then `duplicate-identity advisory lock`; duplicate recheck remains authoritative.
- `pr-04` must reuse `pr-02` `highlight_kernel` resolver/mismatch mapping/logging contracts on generic highlight routes; do not introduce local mismatch event schemas or duplicate mismatch logs.
- Preserve `pr-02` side-effect-free/log-free resolver posture on read-only paths (no hidden repair writes).
- Preserve fragment highlight route behavior and existing API compatibility while adding PDF support.
- Keep PDF quote behavior limited to stored-field maintenance required by S6 create/update contracts (`exact/prefix/suffix` updates), without implementing `pr-05` nearby-context semantics.
- Under `D12`, write-time PDF match anomalies on quote-ready media must follow the approved fail-open/fail-closed split (recoverable anomalies may degrade to `pending`; unclassified exceptions do not silently degrade).
- Under `D14`, matcher anomaly logging/mapping for `pr-04` must reuse `pdf_quote_match_policy.py` helper APIs, emit the canonical `pdf_quote_match_anomaly` event schema, and avoid duplicate anomaly event emission by callers.
- Under `D15`, `pdf_quote_match_anomaly` events must not include raw document-derived text (`exact`, `prefix`, `suffix`, `media.plain_text` excerpts) or unsalted text hashes; exception diagnostics must be sanitized by `pdf_quote_match_policy.py`.
- Under `D16`, cross-kind unified PATCH payloads that are syntactically valid but semantically incompatible with the target highlight anchor kind must be rejected by service-level dispatch with `400 E_INVALID_REQUEST`, deterministic anchor-kind mismatch details, and no mutation.
- Under `D17`, PDF bounds-updates whose replacement geometry canonicalizes to the target highlight’s existing geometry identity are not duplicate conflicts; generic PATCH succeeds and may still recompute/persist write-time derived fields when mutable inputs change.
- Under `D18`, fully identical effective PDF PATCH updates are true no-op successes: no persisted-state mutation, no `updated_at` bump, and no quad/subtype row rewrites.
- Under `D19`, any pre-`D09` no-op short-circuit for fully identical effective PDF PATCH updates is optional and must only occur after acquiring a transaction-scoped target-row lock and safely proving effective-state equality; otherwise the path must use normal `D09` sequencing while preserving `D18` no-op semantics.
- Under `D20`, guarded pre-lock no-op short-circuit gating and post-lock `D18` no-op detection must reuse one canonical deterministic side-effect-free effective-state comparison helper/path; if safe equality cannot be proven, the helper/path must return an explicit structured fallback outcome that routes execution to the normal `D09` path.

## boundaries (for ai implementers)
- Do not implement frontend PDF highlight UI, overlay rendering, or linked-items pane integration in `pr-04`.
- Do not implement PDF quote-to-chat nearby-context enrichment or PDF match-status/offset quote semantics (`pr-05`).
- Do not redesign `pdf_lifecycle`, `pdf_ingest`, or `pdf_readiness` behavior from `pr-03` unless fixing a blocking bug discovered during `pr-04`; any such bug fix must be narrowly scoped and traceable.
- A narrow `pr-03` interop patch is allowed only to adopt the shared media-scoped PDF coordination-lock contract for internal text rebuild/invalidation paths required by `S6-PR04-D09`; do not broaden this into a lifecycle redesign.
- Do not add trigger-based repair/enforcement for PDF anchors/quads in `pr-04`.
- Do not introduce a generalized cross-domain/global advisory-lock framework in `pr-04`; `pdf_locking.py` is a narrow PDF coordination helper only.
- Do not bypass `highlight_kernel` for generic highlight route read/write visibility/mismatch handling.
- Keep geometry canonicalization deterministic and pure; avoid embedding canonicalization math directly in route handlers.
- If schema/index refinements are proposed for exact duplicate enforcement, they require an explicit `pr-04` decision and must not violate the roadmap’s deferred-hardening boundary.

## open questions + temporary defaults (all accepted / retained for template continuity)

| id | question | temporary default | owner | due |
|---|---|---|---|---|
| S6-PR04-D01 | Where should PDF geometry canonicalization/fingerprinting logic live, and how should pure canonicalization be separated from DB write orchestration? | **Accepted**: dedicated pure module `python/nexus/services/pdf_highlight_geometry.py`, with transactional persistence/coherence enforcement in highlight service orchestration (`pdf_highlights.py` under `D04`, via the generic `highlights.py` layer). | Spec owner + platform | pr-04 drafting |
| S6-PR04-D02 | What exact race-safe duplicate enforcement strategy should `pr-04` use for PDF highlight writes (transactional enforcement only vs schema/index refinement now) while honoring the `pr-01` deferred-hardening posture? | **Accepted**: service-level transactional duplicate enforcement using canonical geometry identity with a transaction-scoped advisory lock + duplicate recheck, without schema/index refinement in `pr-04` unless implementation proves it necessary. | Spec owner + platform | pr-04 drafting |
| S6-PR04-D03 | How should `pr-04` evolve the public highlight response schema(s) so generic routes can return typed PDF highlights while preserving fragment-route compatibility for existing clients/tests? | **Accepted**: introduce an anchor-discriminated typed generic highlight response schema for generic/PDF routes while preserving fragment-route response compatibility (including legacy fragment fields where required). | Spec owner + platform | pr-04 drafting |
| S6-PR04-D04 | How should `pr-04` split PDF highlight write/read logic between `python/nexus/services/highlights.py` and any new PDF-specific service helper/module while preserving the `D01` pure-geometry split and `pr-02` kernel reuse? | **Accepted**: a dedicated `python/nexus/services/pdf_highlights.py` module owns PDF highlight create/list/update transactional orchestration while `python/nexus/services/highlights.py` remains the generic/fragment compatibility layer. | Spec owner + platform | pr-04 drafting |
| S6-PR04-D05 | How should `pr-04` evolve the generic `PATCH /highlights/{highlight_id}` request schema/validation to support both fragment offset updates and PDF bounds replacement while preserving fragment-client compatibility and preventing ambiguous mixed payloads? | **Accepted**: backward-compatible unified PATCH schema with preserved fragment fields plus nested `pdf_bounds`, strict mutual exclusivity, and service-level anchor-kind validation/dispatch. | Spec owner + platform | pr-04 drafting |
| S6-PR04-D06 | What exact `pr-04` write-time behavior should PDF highlight create/bounds-update use for `plain_text_match_*` metadata and `prefix/suffix` fields (attempt deterministic match enrichment now vs initialize/reset pending and defer enrichment to `pr-05`)? | **Accepted**: `pr-04` computes deterministic PDF match metadata + `prefix/suffix` on create/bounds-update when quote-text infrastructure is ready, and persists/resets `pending` + empty `prefix/suffix` only when quote-text infrastructure is not ready. | Spec owner + platform | pr-04 drafting |
| S6-PR04-D07 | Where should the deterministic PDF quote-match algorithm/prefix-suffix derivation helper live for `pr-04` writes and later `pr-05` enrichment/quote paths (reuse boundary to avoid duplication)? | **Accepted**: shared pure helper module `python/nexus/services/pdf_quote_match.py`, reused by `pdf_highlights.py` in `pr-04` and quote/enrichment logic in `pr-05`. | Spec owner + platform | pr-04 drafting |
| S6-PR04-D08 | What exact deterministic hashing/serialization contract should `pr-04` use for persisted `geometry_fingerprint` and advisory-lock key derivation so duplicate identity is stable and concurrency behavior is testable? | **Accepted**: canonical serialized geometry bytes + SHA-256 lowercase hex `geometry_fingerprint` + stable namespaced deterministic `int64` advisory-lock key derived from the full duplicate identity, with duplicate recheck preserved for correctness. | Spec owner + platform | pr-04 drafting |
| S6-PR04-D09 | What transaction sequencing and advisory-lock scope should `pr-04` use for PDF create/bounds-update so `D02` duplicate race safety, `D06` write-time match persistence, and `D07` shared matcher reuse remain atomic while lock contention stays bounded? | **Accepted**: canonicalize geometry and compute deterministic match results before advisory-lock acquisition; acquire media-scoped coordination lock first, then duplicate-identity advisory lock; perform duplicate recheck + atomic persistence under locks; keep duplicate-lock hold time bounded and duplicate recheck authoritative. | Spec owner + platform | pr-04 drafting |
| S6-PR04-D10 | Where should the shared media-scoped coordination lock helper live so `pr-04` PDF highlight writes and `pr-03` internal PDF text-rebuild/invalidation paths reuse the same lock namespace/ordering contract without duplication or drift? | **Accepted**: a small shared helper module `python/nexus/services/pdf_locking.py` owns media-scoped coordination lock key derivation and lock-order helper(s), reused by `pdf_highlights.py` in `pr-04` and narrow `pr-03` interop patches. | Spec owner + platform | pr-04 drafting |
| S6-PR04-D11 | How should `pr-04` split duplicate-identity advisory-lock key ownership between `pdf_highlight_geometry.py` (`D08`) and `pdf_locking.py` (`D10`) so lock helpers are reusable without redefining canonical geometry identity? | **Accepted**: `pdf_highlight_geometry.py` owns canonical geometry identity + duplicate-identity lock-key primitives; `pdf_locking.py` owns media coordination lock keys and generic ordered lock acquisition helpers, and may wrap duplicate-lock acquire by calling geometry-owned key derivation. | Spec owner + platform | pr-04 drafting |
| S6-PR04-D13 | Where should write-time PDF matcher anomaly classification types and structured anomaly logging boundaries live so `D12` is implemented consistently across `pr-04` writes and later `pr-05` enrichment without violating `D07` (pure matcher, no logging)? | **Accepted**: two-layer split with `pdf_quote_match.py` providing typed recoverable anomaly classifications (pure/log-free) and shared `pdf_quote_match_policy.py` owning structured anomaly logging + path-specific mapping helpers reused by `pr-04` and `pr-05`. | Spec owner + platform | pr-04 drafting |
| S6-PR04-D14 | What exact structured anomaly log event schema and helper API contract should `pdf_quote_match_policy.py` expose so `pr-04` and `pr-05` reuse one observability surface for matcher anomalies without log drift or double-logging? | **Accepted**: `pdf_quote_match_policy.py` owns the canonical `pdf_quote_match_anomaly` event schema (required anomaly classification + target context fields, optional non-sensitive diagnostics), centralized logging/mapping helper APIs, and the no-double-logging rule for caller services. | Spec owner + platform | pr-04 drafting |
| S6-PR04-D15 | What exact redaction/privacy contract should `pdf_quote_match_policy.py` anomaly logging follow for document-derived text inputs (`exact`, `prefix/suffix`, `media.plain_text`) so observability remains useful without leaking user content? | **Accepted**: strict no-content anomaly logging in MVP (no raw document text or unsalted text hashes; sanitized exception diagnostics; approved non-content fields only). | Spec owner + platform | pr-04 drafting |
| S6-PR04-D16 | What exact error-code/status mapping should generic `PATCH /highlights/{id}` use when a syntactically valid `pdf_bounds` payload targets a non-PDF highlight (or fragment offsets target a PDF highlight) under the unified backward-compatible PATCH schema? | **Accepted**: service-level anchor-kind dispatch rejects cross-kind but syntactically valid unified PATCH payloads with `400 E_INVALID_REQUEST`, deterministic anchor-kind mismatch details, and no mutation (after visibility/resource resolution). | Spec owner + platform | pr-04 drafting |
| S6-PR04-D17 | What exact idempotency/no-op contract should generic `PATCH /highlights/{id}` use for PDF bounds replacements that canonicalize to the target highlight’s existing geometry identity? | **Accepted**: self-same canonical geometry is not a conflict (duplicate checks exclude target id); generic PATCH succeeds and remains a normal success path, with recomputation/persistence of write-time derived fields when mutable inputs change and idempotent no-op success allowed when effective state is unchanged. | Spec owner + platform | pr-04 drafting |
| S6-PR04-D18 | What exact timestamp/persistence semantics should generic `PATCH /highlights/{id}` use for fully identical effective updates (self-same canonical geometry and no effective field changes) on PDF highlights? | **Accepted**: fully identical effective PATCH is a true no-op success with no persisted-state mutation, no `updated_at` bump, and no quad/subtype row rewrites. | Spec owner + platform | pr-04 drafting |
| S6-PR04-D19 | May `pr-04` short-circuit fully identical effective PDF PATCH requests before acquiring the `D09` media/duplicate advisory locks, and under what safety conditions? | **Accepted**: guarded hybrid policy allows optional pre-`D09` no-op short-circuit only after a transaction-scoped target-row lock is acquired and fully identical effective state is safely proven (including no derived-field recomputation need); otherwise use normal `D09` sequencing and preserve `D18` no-op semantics. | Spec owner + platform | pr-04 drafting |
| S6-PR04-D20 | Should `pr-04` require a single canonical service helper/path for PDF PATCH effective-state comparison (used by both pre-`D09` short-circuit checks and post-lock no-op detection) to avoid drift in “effective equality” logic? | **Accepted**: require one canonical deterministic side-effect-free effective-state comparison helper/path in `pdf_highlights.py` (or an equivalent narrowly scoped helper in the same service boundary), reused by guarded pre-lock short-circuit gating and post-lock no-op detection, with an explicit structured fallback outcome when equality cannot be safely proven. | Spec owner + platform | pr-04 drafting |

## checklist
- [ ] every l3 acceptance bullet is in traceability matrix
- [ ] every traceability row has at least one test
- [ ] every behavior-changing decision has an assertion in tests
- [ ] non-goals exclude adjacent pdf viewer / quote semantics work
- [ ] constraints reflect `pr-02` kernel mismatch/logging reuse requirements
- [ ] `open questions + temporary defaults` is empty (or explicitly accepted) before implementation
- [ ] only scoped files are touched (implementation-time verification)
