# pr-02: typed-highlight kernel compatibility

## goal
Make shared highlight/context/visibility kernel behavior anchor-kind-aware while preserving all existing fragment-backed product semantics and fragment-route API contracts.

## context
- `docs/v1/s6/s6_pr_roadmap.md` defines `pr-02` as the first behavioral adoption PR after `pr-01`, with ownership of typed-highlight kernel compatibility and dormant-window repair.
- `docs/v1/s6/s6_spec.md` Section `2.2` and Section `6` define the unified logical `highlights` aggregate with typed anchor subtypes and cross-kind visibility/context invariants.
- `docs/v1/s6/s6_spec_decisions.md` fixes the architecture via `S6-D01` (unified logical highlight + typed anchors) and preserves future PDF quote semantics under `S6-D05` / `S6-D06`.
- `docs/v1/s6/s6_prs/s6_pr01_spec.md` and `docs/v1/s6/s6_prs/s6_pr01_decisions.md` define the `pr-01` expand-only dormant rollout and carry-forward ownership for `pr-02`.
- `docs/v1/s6/s6_prs/s6_pr01_implementation_report.md` documents the actual `pr-01` migration/model shape and implementation-time compatibility notes (including the transitional bridge constraint name and deferred `Highlight.anchor_media` relationship ambiguity).
- Current backend kernels still assume fragment-only highlights in multiple shared paths:
  - highlight visibility point-read resolves media via `highlight.fragment.media_id` (`python/nexus/auth/permissions.py`)
  - highlight services/readers/annotation mutations rely on `highlight.fragment`
  - context target media resolution + `conversation_media` recompute use fragment joins
  - send-message context visibility and context rendering rely on fragment-backed highlight traversal
- Greenfield production assumption applies: there is zero existing production data, so no production data backfill is required. `pr-02` still must preserve compatibility for the live codebase and tests, including rows created during a possible `pr-01` -> `pr-02` deployment window.

## dependencies
- pr-01

---

## deliverables

### `python/nexus/services/highlight_kernel.py`
- Add a dedicated internal typed-highlight kernel module (resolver/typing/repair helper seams) with import boundaries safe for reuse across `highlights`, `permissions`, `contexts`, `send_message`, and later `pr-04`/`pr-05`.
- Define structured internal resolver result type(s) for logical highlight resolution:
  - resolved anchor kind/media id
  - fragment anchor details (when applicable)
  - state classification (`ok`, `dormant_repairable`, `mismatch`)
  - mismatch classification code for `S6-PR02-D03` path-specific mapping
- Implement side-effect-free shared resolver helper(s) (no writes/flush/commit/implicit repair).
- Implement explicit transactional fragment repair helper(s) used only by approved write-capable `pr-02` service paths (no implicit commit/rollback).
- Define a dedicated internal integrity exception for kernel mismatch mapping (recommended: `HighlightKernelIntegrityError`) with `E_INTERNAL` semantics and structured diagnostics (`mismatch_code`, target identifiers, consumer operation, mapping class).
- Implement centralized mismatch mapping + logging helper(s) that enforce `S6-PR02-D03` path-specific behavior and emit one canonical structured mismatch event (`highlight_kernel_mismatch`) per mapping decision.
- Provide internal typed highlight view/serializer seam(s) for later PDF endpoint expansion; fragment-only branch is sufficient in `pr-02`.
- Keep the module independent of route schemas and high-level service modules to avoid circular imports.

### `python/nexus/services/highlights.py`
- Adopt typed-highlight internal kernel helpers for fragment highlight reads/writes while preserving current fragment-route request/response semantics.
- Add/centralize fragment anchor normalization + dormant-window repair for fragment-backed highlights created while `pr-01` schema was dormant via explicit write-capable service paths / repair helper(s), not read-only shared resolvers (`S6-PR02-D02`):
  - populate/repair `highlights.anchor_kind`, `highlights.anchor_media_id`
  - create/repair `highlight_fragment_anchors` subtype rows
- Adopt the `pr-02` canonical fragment-anchor policy:
  - canonical internal source-of-truth is typed logical fields + `highlight_fragment_anchors`
  - legacy `highlights.fragment_id/start_offset/end_offset` remain a compatibility mirror in `pr-02`
  - fragment create/update paths perform transactional service-level dual-write to canonical subtype + legacy bridge (no triggers)
  - dormant-window fragment rows are repaired/normalized when touched by explicit write-capable fragment service paths / repair helpers; read-only consumers may proceed via `dormant_repairable` resolution without hidden repair per `S6-PR02-D02` / `S6-PR02-D06`
- Implement repair helpers with explicit transactional semantics; no hidden commits in shared read/visibility/context helpers (`S6-PR02-D02`).
- Shift canonical fragment-anchor reads/writes toward subtype rows under the transitional bridge without changing public behavior.
- Keep legacy fragment route payload shape unchanged (`fragment_id`, offsets, exact/prefix/suffix, annotation).
- Preserve fragment duplicate behavior and conflict/error semantics under the retained compatibility index.
- Update constraint/error mapping to recognize `pr-01` bridge constraint naming (`ck_highlights_fragment_bridge`) alongside legacy names as needed for compatibility.
- Implement `S6-PR02-D03` fail-safe mismatch mapping for direct fragment highlight service paths:
  - no-existence-leak highlight-id read loaders continue masked-404 behavior on mismatch
  - fragment-scoped list/get paths do not silently skip conflicting rows
  - owner-authorized mutation paths fail with explicit internal integrity error on irreconcilable bridge-vs-subtype mismatch
- Add internal typed-highlight serializer / service seam(s) for later PDF endpoint expansion without exposing new public payload fields in `pr-02`.

### `python/nexus/auth/permissions.py`
- Make highlight visibility point-read helper(s) anchor-kind-aware by resolving anchor media from logical highlight state instead of assuming `highlight.fragment.media_id`.
- Preserve S4 canonical visibility semantics and no-existence-leak behavior.
- Honor `S6-PR02-D01` conflict posture: if typed-anchor vs legacy-bridge fragment data is irreconcilably inconsistent, fail safe (no silent precedence choice).
- Use the shared logical highlight resolver in side-effect-free mode only; auth predicates do not perform dormant-window repair writes (`S6-PR02-D02`).
- Implement `S6-PR02-D03` bool-helper mapping: fail closed (`False`) on mismatch and emit integrity logging/observability signal.
- Reuse the `highlight_kernel` centralized mismatch mapping/logging helper(s) (no ad hoc local mismatch logging/mapping drift).
- Keep list-query helper semantics stable for existing fragment list routes (`highlight_visibility_filter`) while leaving room for future anchor-aware list expansions.

### `python/nexus/services/contexts.py`
- Make context target media resolution for `highlight` and `annotation` anchor-kind-aware using logical highlight anchor media resolution.
- Update `recompute_conversation_media` to stop relying on fragment-only joins for highlight/annotation contexts while preserving existing behavior for fragment-backed highlights.
- Implement `S6-PR02-D05` using a hybrid batch strategy:
  - bulk-load message_context references and referenced highlights/annotations
  - resolve highlight/annotation media via side-effect-free `highlight_kernel` resolver semantics (no duplicated raw SQL anchor logic)
  - tolerate `dormant_repairable` rows without hidden repair writes
  - raise explicit internal integrity failure on irreconcilable mismatches
  - compute expected media set in Python and apply set-diff updates to `conversation_media`
- Reuse the shared logical highlight media-resolution seam and `S6-PR02-D01` conflict posture (no silent bridge-vs-subtype drift acceptance).
- Keep context target resolvers side-effect free (no dormant-window repair writes); repair remains an explicit write-path concern in `pr-02` (`S6-PR02-D02`).
- Apply `S6-PR02-D03` path-specific mismatch mapping in context services:
  - explicit write/internal service paths (e.g., `insert_context`, `recompute_conversation_media`) surface explicit internal integrity failures on irreconcilable mismatches
  - no-existence-leak visibility gates remain masked through their own callers/helpers
- Reuse `highlight_kernel` centralized mismatch mapping/logging helper(s) for mismatch handling to avoid per-service logging drift or duplicate mismatch event emission.
- Preserve batch insertion and idempotent recompute semantics.

### `python/nexus/services/send_message.py`
- Make context visibility checks for `highlight` / `annotation` anchor-kind-aware via shared logical highlight media resolution (no fragment-only traversal assumptions).
- Reuse shared logical-highlight resolver behavior from `pr-02` (including safe handling of dormant-window rows and conflict posture).
- Keep send-message visibility validation read-only; no repair writes occur during context visibility checks (`S6-PR02-D02`).
- Implement `S6-PR02-D03` no-existence-leak mapping for context visibility checks: mismatch in highlight/annotation visibility resolution is treated as masked not-found for user-facing validation paths.
- Reuse `highlight_kernel` centralized mismatch mapping/logging helper(s) for mismatch handling (no duplicate local mismatch event logging).
- Preserve all existing fragment-backed quote-to-chat behavior and error masking semantics.

### `python/nexus/services/send_message_stream.py`
- Update any duplicated or parallel context visibility/context-prep seams if required to keep stream behavior aligned with `send_message.py`.
- If no direct changes are needed after `send_message.py` refactor, explicitly verify parity via tests and leave file untouched.

### `python/nexus/services/context_rendering.py`
- Introduce an internal anchor-kind-aware rendering seam/dispatch for highlight/annotation contexts while keeping fragment rendering behavior functionally unchanged in `pr-02`.
- Preserve existing fragment quote-context rendering path and output contract.
- Defer PDF rendering behavior to `pr-05`.

### `python/nexus/db/models.py`
- Only if required for `pr-02` kernel adoption:
  - add/adjust `Highlight` ORM relationships or loading strategy (e.g., explicit logical anchor media relationship or helper-safe relationship configuration)
  - resolve any ORM ambiguity introduced by typed-anchor kernel adoption without changing `pr-01` schema contracts
- Do not introduce new schema columns/tables (schema remains owned by `pr-01` / later PRs).

### `python/tests/test_highlights.py`
- Add integration tests covering fragment-route behavior preservation under typed-kernel adoption.
- Add tests covering dormant-window fragment row tolerance in read paths and explicit normalization/repair in approved write-capable fragment paths.
- Add tests proving fragment duplicate behavior/error semantics are unchanged after internal canonical-path adoption.
- Add tests proving typed internal seams do not leak new public fields in `pr-02` route payloads.

### `python/tests/test_highlight_kernel.py`
- Add unit/service-level tests for the dedicated `highlight_kernel` resolver result typing, side-effect-free resolution behavior, mismatch classification, centralized mismatch mapping/logging helpers, internal integrity exception diagnostics, and explicit repair-helper transactional behavior.
- Keep these tests focused on internal seam contracts (not route payloads).

### `python/tests/test_permissions.py`
- Add tests for anchor-kind-aware `can_read_highlight` point-read behavior using fragment-backed highlights under:
  - dormant fields unset
  - dormant fields normalized
  - subtype row present/missing (repair/tolerance expectations as applicable to the chosen seam)
- Preserve S4 library-intersection semantics and masked non-existence behavior.

### `python/tests/test_contexts.py`
- Add tests for anchor-kind-aware `resolve_media_id_for_context` for `highlight` and `annotation` targets using logical highlight media resolution.
- Add tests proving `recompute_conversation_media` remains correct after replacing fragment-only joins.
- Add tests for dormant-window fragment highlight rows and repaired rows.

### `python/tests/test_send_message.py`
- Add/adjust tests proving highlight/annotation context visibility and rendered fragment quote behavior remain unchanged after typed-kernel adoption.
- Add tests covering fragment-highlight context paths when logical anchor fields/subtype rows are initially dormant and repaired during `pr-02`.

### `python/tests/test_send_message_stream.py`
- Add/adjust parity tests only if stream path requires direct changes.
- Otherwise rely on existing coverage and document why no new stream-specific tests are needed.

---

## decision ledger

| question | decision | rationale | fallback/default |
|---|---|---|---|
| What is the canonical fragment-anchor source-of-truth and read/write strategy in `pr-02` under the `pr-01` transitional bridge (`highlights.fragment_*` + `highlight_fragment_anchors`) while preserving fragment-route product semantics? | **Accepted (`S6-PR02-D01`)**: Treat typed logical fields + `highlight_fragment_anchors` as canonical for fragment anchor semantics in `pr-02`; keep legacy `highlights.fragment_*` as a compatibility mirror. Fragment create/update paths perform transactional service-level dual-write (no triggers). Read paths prefer typed subtype/logical data, tolerate `dormant_repairable` rows in read-only flows per `D06`, and fail safe on irreconcilable bridge-vs-subtype mismatch rather than silently choosing one. Explicit repair/normalization of dormant-window rows occurs in approved write-capable service paths / repair helpers per `D02`. | Delivers real typed-kernel migration in `pr-02` while preserving fragment-route behavior and duplicate semantics. Greenfield removes production backfill pressure but not rollout-window compatibility risk. Explicit fail-safe conflict handling prevents silent drift corruption. | If implementation friction appears, keep typed source-of-truth + dual-write policy and narrow explicit repair call sites (do not revert to legacy-canonical reads or add hidden read-path repairs). |
| Where is `pr-02` allowed to perform dormant-window fragment repair/normalization (including whether read-only helpers may write), and what is the required side-effect policy for shared kernel resolvers? | **Accepted (`S6-PR02-D02`)**: Shared logical highlight resolver/media-resolution helpers are side-effect free (no writes/commits/implicit repair). Dormant-window repair is performed only via explicit transactional `pr-02` repair helper(s) invoked from approved write-capable service paths (fragment create/update and other explicitly selected mutation paths) and optional explicit repair utilities used by tests/admin tooling. | Preserves clean read-vs-write boundaries, predictable transactions, and test stability while still satisfying `pr-02`'s requirement to tolerate and repair dormant-window fragment rows. Prevents hidden writes in auth/context/send-message read helpers. | If implementation friction appears, keep shared resolvers side-effect free and broaden approved explicit repair call sites; do not introduce writes into auth/context read helpers. |
| What exact fail-safe error behavior should `pr-02` use for irreconcilable fragment bridge-vs-subtype mismatches across bool helpers, read routes, and owner mutation paths? | **Accepted (`S6-PR02-D03`)**: Use path-specific fail-safe mapping. Shared bool visibility helpers fail closed (`False`) on mismatch. No-existence-leak user-facing visibility/read gating paths map mismatch to masked not-found behavior. Owner-authorized mutation paths and trusted internal write/repair services raise explicit internal integrity failure (no silent proceed/overwrite). Fragment-scoped read/list paths do not silently skip or auto-heal mismatches. | Preserves no-existence-leak guarantees and bool-helper contracts while surfacing real corruption loudly on trusted paths. Keeps behavior deterministic and testable without hidden repair writes in read helpers. | If implementation friction appears, preserve the same path-specific mapping classes and centralize the mapping in a helper; do not collapse to a single blanket behavior. |
| What module/API shape should `pr-02` use for the shared logical highlight resolver + typed serializer seams to avoid duplication and circular imports across `highlights`, `permissions`, `contexts`, and `send_message`? | **Accepted (`S6-PR02-D04`)**: Introduce a dedicated internal kernel module (`python/nexus/services/highlight_kernel.py`) that owns structured side-effect-free logical highlight resolution, mismatch classification, explicit transactional fragment repair helper(s), and internal typed highlight view/serializer seams. The module imports only models/errors/SQLAlchemy/stdlib and is reused by `highlights`, `permissions`, `contexts`, `send_message`, and later `pr-04`/`pr-05`. | Prevents circular imports, centralizes `D01/D02/D03` semantics, and gives later PRs a stable reusable seam without leaking public route schema concerns into kernel logic. | If implementation friction appears, keep the dedicated kernel module and reduce scope to resolver + mismatch typing first; do not scatter logic back into consumer modules. |
| What implementation strategy should `pr-02` use for `contexts.recompute_conversation_media` after removing fragment-only joins: SQL-first set-based query rewrite, shared-kernel resolver iteration, or a hybrid batch strategy? | **Accepted (`S6-PR02-D05`)**: Use a hybrid batch strategy. Bulk-load message contexts and referenced highlights/annotations, resolve media through side-effect-free `highlight_kernel` resolver semantics in Python, tolerate `dormant_repairable` rows without hidden repair writes, raise explicit internal integrity failure on mismatches, then diff/apply `conversation_media` updates. | Reuses canonical `highlight_kernel` semantics (no drift), preserves `D02` side-effect boundaries and `D03` internal mismatch behavior, and avoids both brittle fragment-only SQL duplication and naive N+1 per-row resolution. | If performance pressure appears, optimize batch loading/query shape while preserving kernel-semantic reuse and side-effect-free resolver behavior; do not revert to duplicated fragment-only raw SQL logic. |
| What is the exact shared-resolver contract for `dormant_repairable` fragment rows in read-only consumers: may they proceed using legacy-bridge-derived media/fragment anchor data, or must they fail closed until an explicit repair path runs? | **Accepted (`S6-PR02-D06`)**: `highlight_kernel` may return resolved media + fragment anchor data for fragment-backed rows in `state='dormant_repairable'` when legacy bridge fields are self-consistent and sufficient to resolve the anchor. Read-only consumers (auth/context resolution/send-message visibility/read routes) may proceed using that resolved data without hidden repair writes, while emitting observability for deferred repair. Write-capable fragment service paths should explicitly repair before continuing mutation logic where `pr-02` policy requires canonical synchronization. | Preserves pre-S6 fragment behavior across `pr-01` -> `pr-02` rollout windows without hidden writes, while keeping `dormant_repairable` distinct from true mismatches. Aligns with greenfield production plus existing code/test compatibility requirements. | If implementation friction appears, keep the resolver result semantics and narrow which read-only consumers proceed; do not collapse `dormant_repairable` into `mismatch`. |
| What exact internal integrity exception / logging contract should `pr-02` use for `highlight_kernel` mismatch outcomes so `D03` path-specific mapping is consistent across services? | **Accepted (`S6-PR02-D07`)**: Keep the resolver pure/log-free and centralize mismatch handling in `highlight_kernel` mapping helper(s). Define a dedicated internal kernel integrity exception (recommended `HighlightKernelIntegrityError`, `E_INTERNAL` semantics) carrying structured diagnostics (`mismatch_code`, target ids, `consumer_operation`, `mapping_class`). The centralized mapping helper(s) perform `D03` path-specific mapping (bool fail-closed / masked not-found / internal error) and emit one canonical structured mismatch log event (`highlight_kernel_mismatch`) per mapping decision; consumers reuse the helper and do not duplicate mismatch logs. | Preserves `D02` resolver purity, enforces `D03` consistently across services, prevents logging/mapping drift, and gives later PRs a stable kernel contract for mismatch handling and observability. | If implementation friction appears, keep the centralized kernel mapping/logging helper contract and typed internal exception, and phase in optional diagnostic fields later; do not move mismatch mapping/logging back into consumer modules. |

---

## traceability matrix

| l3 acceptance item | deliverable(s) | test(s) |
|---|---|---|
| Shared visibility and context-target resolution operate on logical highlights across anchor kinds. | `python/nexus/services/highlight_kernel.py`; `python/nexus/auth/permissions.py`; `python/nexus/services/contexts.py`; `python/nexus/services/send_message.py`; `python/nexus/services/send_message_stream.py` (if needed) | `test_pr02_highlight_kernel_resolver_returns_structured_logical_anchor_resolution_states`; `test_pr02_can_read_highlight_resolves_anchor_media_via_logical_highlight`; `test_pr02_resolve_media_id_for_context_highlight_uses_logical_anchor_media`; `test_pr02_resolve_media_id_for_context_annotation_uses_logical_anchor_media`; `test_pr02_send_message_highlight_context_visibility_uses_logical_anchor_media`; `test_pr02_recompute_conversation_media_resolves_highlight_annotation_media_without_fragment_only_join` |
| Existing fragment-backed highlight reads, annotations, and quote-context behavior remain functionally unchanged. | `python/nexus/services/highlights.py`; `python/nexus/services/context_rendering.py`; `python/nexus/services/send_message.py`; `python/tests/test_highlights.py`; `python/tests/test_send_message.py` | `test_pr02_fragment_highlight_routes_behavior_unchanged_under_typed_kernel`; `test_pr02_fragment_annotation_routes_behavior_unchanged_under_typed_kernel`; `test_pr02_fragment_highlight_context_rendering_output_unchanged`; `test_pr02_send_message_fragment_highlight_context_quote_behavior_unchanged` |
| Existing fragment-route API behavior is preserved while internal typed-highlight canonical paths are adopted for S6 rollout readiness. | `python/nexus/services/highlights.py`; `python/nexus/services/context_rendering.py` | `test_pr02_fragment_routes_preserve_public_payload_shape_no_anchor_fields_leak`; `test_pr02_fragment_highlight_service_uses_typed_internal_seam_without_public_contract_change` |
| `pr-02` adopts typed logical fields + `highlight_fragment_anchors` as the canonical internal fragment-anchor source-of-truth, keeps legacy `highlights.fragment_*` as a transitional compatibility mirror, and uses transactional service-level dual-write (no triggers) for fragment create/update paths. | `python/nexus/services/highlights.py`; `python/nexus/db/models.py` (if needed) | `test_pr02_fragment_highlight_create_populates_typed_fragment_anchor_and_compatibility_bridge`; `test_pr02_fragment_highlight_update_keeps_subtype_and_bridge_in_sync`; `test_pr02_fragment_highlight_read_prefers_canonical_fragment_anchor_source_per_pr02_policy` |
| `pr-02` adopts and validates `pr-01` dormant logical-highlight fields (`anchor_kind`, `anchor_media_id`) and handles compatibility normalization for rows created while `pr-01` schema was dormant. | `python/nexus/services/highlights.py`; `python/nexus/auth/permissions.py`; `python/nexus/services/contexts.py` | `test_pr02_normalizes_dormant_logical_anchor_fields_for_fragment_highlight_on_touch`; `test_pr02_validates_fragment_logical_anchor_fields_after_normalization`; `test_pr02_permissions_tolerate_dormant_fragment_highlight_rows_without_fragment_only_assumptions` |
| `pr-02` tolerates and repairs fragment highlights created during the `pr-01` dormant window that do not yet have `highlight_fragment_anchors` subtype rows. | `python/nexus/services/highlights.py`; `python/nexus/services/contexts.py`; `python/nexus/services/send_message.py` | `test_pr02_fragment_read_paths_proceed_on_dormant_repairable_without_hidden_repair`; `test_pr02_repairs_missing_fragment_subtype_row_for_dormant_window_highlight_mutation`; `test_pr02_context_resolution_tolerates_missing_fragment_subtype_row_before_repair` |
| `pr-02` does not silently accept irreconcilable fragment bridge-vs-subtype mismatches; it uses a fail-safe error/repair posture while preserving fragment-route product semantics for valid data. | `python/nexus/services/highlights.py`; `python/nexus/auth/permissions.py`; `python/nexus/services/contexts.py`; `python/nexus/services/send_message.py` | `test_pr02_fragment_highlight_conflicting_bridge_vs_subtype_state_fails_safe`; `test_pr02_can_read_highlight_resolves_anchor_media_via_logical_highlight`; `test_pr02_context_and_visibility_helpers_share_logical_highlight_media_resolution_seam` |
| Shared logical highlight media-resolution helpers remain side-effect free; dormant-window repair writes occur only in explicit transactional `pr-02` service paths / repair helpers. | `python/nexus/services/highlight_kernel.py`; `python/nexus/services/highlights.py`; `python/nexus/auth/permissions.py`; `python/nexus/services/contexts.py`; `python/nexus/services/send_message.py`; `python/nexus/services/send_message_stream.py` (if needed) | `test_pr02_highlight_kernel_repair_helper_is_explicit_and_no_implicit_commit`; `test_pr02_shared_logical_highlight_resolver_is_side_effect_free_on_dormant_rows`; `test_pr02_fragment_mutation_paths_can_repair_dormant_rows_transactionally`; `test_pr02_send_message_visibility_checks_do_not_repair_or_mutate_dormant_rows` |
| `dormant_repairable` fragment rows may be resolved by `highlight_kernel` for read-only consumers using legacy-bridge-derived data (with observability), while write-capable fragment paths explicitly repair before mutation logic. | `python/nexus/services/highlight_kernel.py`; `python/nexus/services/highlights.py`; `python/nexus/auth/permissions.py`; `python/nexus/services/contexts.py`; `python/nexus/services/send_message.py` | `test_pr02_highlight_kernel_dormant_repairable_returns_resolved_data_without_mutation`; `test_pr02_fragment_read_paths_proceed_on_dormant_repairable_without_hidden_repair`; `test_pr02_send_message_visibility_allows_visible_dormant_repairable_context_without_repair`; `test_pr02_fragment_mutation_paths_can_repair_dormant_rows_transactionally` |
| `pr-02` uses path-specific fail-safe mismatch mapping (bool helpers fail closed, no-existence-leak user-facing checks mask, owner/internal write paths raise explicit internal integrity failure), implemented via centralized `highlight_kernel` mismatch mapping/logging helpers. | `python/nexus/services/highlight_kernel.py`; `python/nexus/auth/permissions.py`; `python/nexus/services/highlights.py`; `python/nexus/services/send_message.py`; `python/nexus/services/contexts.py` | `test_pr02_permissions_bool_helper_mismatch_fails_closed_false`; `test_pr02_highlight_get_or_visibility_gating_mismatch_masks_not_found`; `test_pr02_highlight_owner_mutation_mismatch_raises_internal_integrity_error`; `test_pr02_context_internal_write_service_mismatch_raises_internal_integrity_error`; `test_pr02_highlight_kernel_internal_integrity_error_carries_structured_diagnostics`; `test_pr02_highlight_kernel_mismatch_mapping_helpers_emit_single_structured_log_event` |
| `recompute_conversation_media` replaces fragment-only SQL anchor resolution with a hybrid batch strategy that reuses `highlight_kernel` semantics, tolerates dormant rows without hidden repair writes, and raises internal integrity failure on mismatches. | `python/nexus/services/contexts.py`; `python/nexus/services/highlight_kernel.py` | `test_pr02_recompute_conversation_media_resolves_highlight_annotation_media_without_fragment_only_join`; `test_pr02_recompute_conversation_media_tolerates_dormant_repairable_rows_without_hidden_repair`; `test_pr02_context_internal_write_service_mismatch_raises_internal_integrity_error` |
| `pr-02` treats legacy fragment columns on `highlights` as a transitional compatibility bridge and shifts canonical fragment-anchor reads/writes toward subtype rows without changing fragment-route product semantics. | `python/nexus/services/highlights.py`; `python/nexus/db/models.py` (if needed) | `test_pr02_fragment_highlight_create_populates_typed_fragment_anchor_and_compatibility_bridge`; `test_pr02_fragment_highlight_update_keeps_subtype_and_bridge_in_sync`; `test_pr02_fragment_highlight_read_prefers_canonical_fragment_anchor_source_per_pr02_policy` |
| `pr-02` preserves fragment duplicate behavior under the `pr-01` retained compatibility index unless a separately-reviewed index refactor is introduced. | `python/nexus/services/highlights.py`; `python/tests/test_highlights.py` | `test_pr02_fragment_duplicate_conflict_behavior_unchanged_under_typed_kernel`; `test_pr02_fragment_duplicate_integrity_mapping_handles_bridge_constraint_names` |
| Test/fixture expectations are updated for the typed-highlight internal model without changing pre-S6 product semantics. | `python/tests/test_highlights.py`; `python/tests/test_contexts.py`; `python/tests/test_send_message.py`; `python/tests/test_permissions.py`; `python/tests/test_send_message_stream.py` (if needed) | `test_pr02_fixture_helpers_can_create_dormant_window_fragment_highlights_for_repair_paths`; `test_pr02_existing_fragment_route_and_context_fixtures_remain_product_equivalent` |
| Typed-highlight serializers/service seams are ready for later PDF endpoint expansion. | `python/nexus/services/highlight_kernel.py`; `python/nexus/services/highlights.py`; `python/nexus/services/context_rendering.py`; `python/nexus/services/contexts.py`; `python/nexus/services/send_message.py` | `test_pr02_internal_typed_highlight_serializer_seam_supports_anchor_kind_dispatch_fragment_only`; `test_pr02_highlight_kernel_internal_typed_view_fragment_branch_only`; `test_pr02_context_and_visibility_helpers_share_logical_highlight_media_resolution_seam` |

---

## acceptance tests

### file: `python/tests/test_highlights.py`

**test: `test_pr02_fragment_highlight_routes_behavior_unchanged_under_typed_kernel`**
- input: run representative fragment highlight CRUD/list/get/update/delete + annotation flows through existing routes after `pr-02` kernel adoption.
- output: responses and persistence semantics remain identical to pre-`pr-02` fragment behavior (status codes, masked 404 rules, payload shape, duplicate conflicts, readiness gating).

**test: `test_pr02_fragment_annotation_routes_behavior_unchanged_under_typed_kernel`**
- input: exercise representative annotation upsert/read/delete flows attached to fragment highlights after `pr-02` kernel adoption.
- output: annotation route behavior and payload semantics remain functionally unchanged for valid fragment-backed highlights.

**test: `test_pr02_normalizes_dormant_logical_anchor_fields_for_fragment_highlight_on_touch`**
- input: create a fragment-backed highlight row in `pr-01` dormant shape (`anchor_kind/anchor_media_id` NULL, no `highlight_fragment_anchors` row), then exercise an approved write-capable `pr-02` fragment highlight service path.
- output: `pr-02` tolerates the row and normalizes/repairs logical anchor fields and/or subtype row per the final `S6-PR02-D01` policy without changing route-visible behavior.

**test: `test_pr02_validates_fragment_logical_anchor_fields_after_normalization`**
- input: drive a fragment highlight through `pr-02` normalization/repair, then reload through typed-kernel read paths.
- output: logical anchor fields are valid/consistent with the canonical fragment subtype row and accepted by `pr-02` validation logic.

**test: `test_pr02_fragment_highlight_create_populates_typed_fragment_anchor_and_compatibility_bridge`**
- input: create a fragment highlight through the existing route/service after `pr-02` adoption.
- output: persisted row includes typed logical anchor fields and fragment subtype anchor row, while legacy fragment bridge fields remain populated and public route payload stays unchanged.

**test: `test_pr02_fragment_highlight_update_keeps_subtype_and_bridge_in_sync`**
- input: update fragment highlight offsets/color via existing route.
- output: offset changes preserve fragment duplicate semantics and keep typed fragment subtype data + legacy bridge fields synchronized per final `S6-PR02-D01`.

**test: `test_pr02_fragment_routes_preserve_public_payload_shape_no_anchor_fields_leak`**
- input: call existing fragment highlight create/list/get/update routes.
- output: response payload remains fragment-route contract (`fragment_id`, offsets, exact/prefix/suffix, annotation, author fields) with no new `anchor` discriminator/public typed fields in `pr-02`.

**test: `test_pr02_fragment_highlight_service_uses_typed_internal_seam_without_public_contract_change`**
- input: exercise a representative fragment highlight read/write service path while inspecting persisted canonical subtype/logical fields and route response payload.
- output: service behavior uses the typed internal seam/canonical path, while the public fragment route contract remains unchanged.

**test: `test_pr02_fragment_duplicate_conflict_behavior_unchanged_under_typed_kernel`**
- input: attempt duplicate fragment highlight creation/update under the same `(user_id, fragment_id, start_offset, end_offset)`.
- output: conflict behavior remains `409 E_HIGHLIGHT_CONFLICT` and is not changed by typed-kernel adoption.

**test: `test_pr02_fragment_duplicate_integrity_mapping_handles_bridge_constraint_names`**
- input: trigger a DB constraint violation that surfaces the `pr-01` fragment bridge constraint name in a fragment highlight mutation path.
- output: service maps the error to the same public error class as pre-`pr-02` fragment behavior (no unexpected internal error).

**test: `test_pr02_fragment_highlight_conflicting_bridge_vs_subtype_state_fails_safe`**
- input: construct a fragment highlight row where legacy bridge fields and typed fragment subtype fields disagree after `pr-02` adoption, then call a `pr-02` fragment/kernel read path.
- output: service/kernel does not silently choose one source; it surfaces the documented fail-safe error/repair behavior per `S6-PR02-D01`.

**test: `test_pr02_fragment_mutation_paths_can_repair_dormant_rows_transactionally`**
- input: create a `pr-01` dormant-window fragment highlight row and invoke an approved `pr-02` write-capable fragment service path (e.g., update color/offset or explicit repair helper).
- output: row is normalized/repaired in the same transaction without hidden extra commits, and public mutation semantics remain unchanged.

**test: `test_pr02_repairs_missing_fragment_subtype_row_for_dormant_window_highlight_mutation`**
- input: construct a dormant-window fragment highlight with valid legacy bridge fields but no `highlight_fragment_anchors` subtype row, then invoke an approved mutation path.
- output: mutation path repairs the missing subtype row (and logical fields if needed) transactionally before applying/returning the mutation result.

**test: `test_pr02_fragment_read_paths_proceed_on_dormant_repairable_without_hidden_repair`**
- input: call fragment highlight GET/list routes on `pr-01` dormant-window fragment highlights that are repairable from legacy bridge fields.
- output: read routes preserve fragment behavior and payloads using tolerated `dormant_repairable` resolution, without mutating rows in the read path.

**test: `test_pr02_fragment_highlight_read_prefers_canonical_fragment_anchor_source_per_pr02_policy`**
- input: load a normalized fragment highlight where typed subtype/logical fields and legacy bridge fields are both present and consistent.
- output: read path resolves fragment anchor semantics through the canonical typed source and returns unchanged fragment-route payload semantics.

**test: `test_pr02_fixture_helpers_can_create_dormant_window_fragment_highlights_for_repair_paths`**
- input: use/update test fixtures/helpers to construct a `pr-01` dormant-window fragment highlight state (legacy bridge only) for `pr-02` compatibility tests.
- output: fixtures can create the intended dormant state deterministically without changing pre-S6 product semantics in unrelated tests.

**test: `test_pr02_existing_fragment_route_and_context_fixtures_remain_product_equivalent`**
- input: run representative pre-existing fragment route/context tests or fixture-backed setup flows after fixture updates for typed-kernel internals.
- output: fixture changes preserve the same user-visible fragment route/context behavior and masking semantics as before `pr-02`.

### file: `python/tests/test_permissions.py`

**test: `test_pr02_can_read_highlight_resolves_anchor_media_via_logical_highlight`**
- input: create fragment-backed highlights in multiple storage states (dormant logical fields unset, normalized logical fields set, subtype row present/missing) with shared-library visibility scenarios.
- output: `can_read_highlight` preserves S4 semantics and no-existence-leak behavior while resolving media via logical highlight anchor-aware helper(s), not `highlight.fragment` assumptions alone.

**test: `test_pr02_permissions_tolerate_dormant_fragment_highlight_rows_without_fragment_only_assumptions`**
- input: call permissions point-read/list visibility helpers against fragment highlights in `dormant_repairable` storage states.
- output: helpers preserve visibility semantics using typed-kernel resolution fallback/tolerance without requiring fragment-only traversal assumptions or hidden repairs.

**test: `test_pr02_permissions_bool_helper_mismatch_fails_closed_false`**
- input: construct an irreconcilable fragment bridge-vs-subtype mismatch on a highlight and call `can_read_highlight`.
- output: helper returns `False` (fail closed) and does not raise; integrity event/logging is emitted per implementation conventions.

**test: `test_pr02_shared_logical_highlight_resolver_is_side_effect_free_on_dormant_rows`**
- input: call permissions/context logical media-resolution helper paths against dormant-window fragment highlight rows within a read-only request path.
- output: helpers resolve/tolerate according to `pr-02` policy without writing/repairing rows, flushing, or committing.

### file: `python/tests/test_contexts.py`

**test: `test_pr02_resolve_media_id_for_context_highlight_uses_logical_anchor_media`**
- input: resolve context media for fragment highlight rows across dormant/repaired typed-anchor states.
- output: resolved `media_id` is correct and independent of fragment-only traversal assumptions.

**test: `test_pr02_resolve_media_id_for_context_annotation_uses_logical_anchor_media`**
- input: resolve context media for annotations attached to fragment highlights across dormant/repaired typed-anchor states.
- output: resolved `media_id` remains correct and future-PDF-ready at the kernel seam.

**test: `test_pr02_context_resolution_tolerates_missing_fragment_subtype_row_before_repair`**
- input: resolve media for highlight/annotation contexts that reference a fragment highlight in a dormant-window state with missing fragment subtype row but self-consistent legacy bridge fields.
- output: context resolution succeeds using tolerated `dormant_repairable` semantics without hidden repair writes and returns the correct media id.

**test: `test_pr02_context_and_visibility_helpers_share_logical_highlight_media_resolution_seam`**
- input: exercise representative permissions/context/send-message visibility-related paths against the same normalized, dormant-repairable, and mismatch highlight states.
- output: all paths use the same `highlight_kernel` logical media-resolution/mismatch classification seam and produce consistent path-specific outcomes per `D03`.

**test: `test_pr02_recompute_conversation_media_resolves_highlight_annotation_media_without_fragment_only_join`**
- input: insert message contexts referencing highlight/annotation and run `recompute_conversation_media`.
- output: recompute remains correct after replacing fragment-only SQL joins with logical highlight anchor-aware media resolution/query strategy.

**test: `test_pr02_recompute_conversation_media_tolerates_dormant_repairable_rows_without_hidden_repair`**
- input: run `recompute_conversation_media` for a conversation whose contexts reference `pr-01` dormant-window fragment highlights (repairable via legacy bridge, missing typed fields/subtype rows).
- output: recompute succeeds and computes correct `conversation_media` membership using side-effect-free `highlight_kernel` resolution semantics, without mutating/repairing highlight rows.

**test: `test_pr02_context_internal_write_service_mismatch_raises_internal_integrity_error`**
- input: invoke a trusted/internal context service write path (e.g., `insert_context` or `recompute_conversation_media`) against a highlight/annotation with an irreconcilable fragment bridge-vs-subtype mismatch.
- output: service raises explicit internal integrity failure and does not silently proceed.

### file: `python/tests/test_send_message.py`

**test: `test_pr02_send_message_highlight_context_visibility_uses_logical_anchor_media`**
- input: send-message with highlight context for fragment-backed highlights in dormant/repaired typed-anchor states under visible and non-visible scenarios.
- output: visibility outcomes and masked 404 behavior remain unchanged while using logical highlight media resolution.

**test: `test_pr02_highlight_get_or_visibility_gating_mismatch_masks_not_found`**
- input: call a user-facing no-existence-leak highlight visibility/read-gating path with a highlight row in irreconcilable fragment bridge-vs-subtype mismatch state.
- output: path returns masked not-found behavior (not an existence-leaking explicit integrity error) per `S6-PR02-D03`.

**test: `test_pr02_send_message_visibility_checks_do_not_repair_or_mutate_dormant_rows`**
- input: invoke send-message context visibility validation for a dormant-window fragment highlight context in a path that should remain read-only.
- output: visibility logic uses the shared resolver in side-effect-free mode and does not repair/mutate highlight rows during validation.

**test: `test_pr02_send_message_visibility_allows_visible_dormant_repairable_context_without_repair`**
- input: invoke send-message context visibility validation for a visible fragment highlight context backed by a `dormant_repairable` row.
- output: visibility succeeds using resolver-returned legacy-bridge-derived anchor media, no hidden repair write occurs, and observability is emitted for deferred repair.

**test: `test_pr02_highlight_owner_mutation_mismatch_raises_internal_integrity_error`**
- input: call an owner-authorized fragment highlight mutation path (update/delete/annotation upsert) against a row with irreconcilable fragment bridge-vs-subtype mismatch.
- output: path raises explicit internal integrity failure (500-class) and does not silently repair/overwrite conflicting anchor data.

**test: `test_pr02_send_message_fragment_highlight_context_quote_behavior_unchanged`**
- input: send-message with fragment/epub highlight contexts after `pr-02`.
- output: rendered quote/context behavior remains fragment-based and functionally unchanged (no PDF-specific logic introduced).

**test: `test_pr02_fragment_highlight_context_rendering_output_unchanged`**
- input: render fragment/epub highlight and annotation context blocks through the context-rendering path after `pr-02` seam extraction.
- output: rendered fragment context output remains functionally unchanged (same quote text/context formatting semantics) for existing routes/flows.

### file: `python/tests/test_send_message_stream.py`

**test: `test_pr02_send_message_stream_highlight_context_parity_with_send_message`** (only if stream path changes)
- input: stream send-message with fragment highlight context through the direct stream path after `pr-02`.
- output: visibility and rendered-context parity matches non-stream send-message behavior for fragment highlights.

### file: `python/tests/test_models.py`

**test: `test_pr02_highlight_mapper_configuration_supports_kernel_adoption_relationships`** (only if `python/nexus/db/models.py` changes)
- input: import ORM models and configure mappers after any `pr-02` relationship/loading changes.
- output: mapper configuration succeeds without ambiguity regressions while supporting typed-kernel adoption.

### file: `python/tests/test_highlight_kernel.py`

**test: `test_pr02_highlight_kernel_resolver_returns_structured_logical_anchor_resolution_states`**
- input: construct fragment highlights in normalized, dormant-repairable, and irreconcilable mismatch states; call the side-effect-free `highlight_kernel` resolver.
- output: resolver returns structured result objects with deterministic state classification (`ok`, `dormant_repairable`, `mismatch`) and anchor media/kind data (or mismatch classification) without side effects.

**test: `test_pr02_highlight_kernel_dormant_repairable_returns_resolved_data_without_mutation`**
- input: call the side-effect-free `highlight_kernel` resolver on a `pr-01` dormant-window fragment highlight row that is repairable from the legacy bridge.
- output: resolver returns `state='dormant_repairable'` with resolved media + fragment anchor data and does not mutate, flush, or commit.

**test: `test_pr02_highlight_kernel_repair_helper_is_explicit_and_no_implicit_commit`**
- input: invoke the explicit `highlight_kernel` fragment repair helper inside an open transaction on a dormant-window row.
- output: helper repairs/synchronizes canonical subtype + logical fields + compatibility bridge as specified, does not commit/rollback implicitly, and leaves transaction control to the caller.

**test: `test_pr02_highlight_kernel_internal_typed_view_fragment_branch_only`**
- input: build internal typed view/serializer output for a fragment-backed highlight via `highlight_kernel` seam.
- output: internal typed view is available for fragment branch and is suitable for downstream service serialization; no public route schema coupling is introduced.

**test: `test_pr02_internal_typed_highlight_serializer_seam_supports_anchor_kind_dispatch_fragment_only`**
- input: invoke the internal typed serializer/service seam with fragment-backed highlights (and a non-fragment placeholder/unsupported path as applicable to `pr-02` stubs).
- output: fragment anchor-kind dispatch succeeds through the internal seam, and non-fragment branches remain explicitly deferred/private without leaking public PDF behavior into `pr-02`.

**test: `test_pr02_highlight_kernel_internal_integrity_error_carries_structured_diagnostics`**
- input: invoke the centralized `highlight_kernel` mismatch mapping helper in an internal-write mapping mode using a resolver result in `state='mismatch'`.
- output: helper raises the dedicated kernel internal integrity exception with `E_INTERNAL` semantics and structured diagnostics including mismatch classification and target identifiers (plus `consumer_operation` / `mapping_class`).

**test: `test_pr02_highlight_kernel_mismatch_mapping_helpers_emit_single_structured_log_event`**
- input: exercise centralized `highlight_kernel` mismatch mapping helper(s) for each `S6-PR02-D03` mapping class (`bool_fail_closed`, `masked_not_found`, `internal_error`) against resolver mismatch results.
- output: each mapping emits one canonical structured `highlight_kernel_mismatch` log event with required fields (`mismatch_code`, target ids, `consumer_operation`, `mapping_class`, `resolver_state='mismatch'`) and consumers do not emit duplicate mismatch events for the same mapping decision in the tested paths.

---

## non-goals
- does not add PDF highlight create/list/update routes (owned by `pr-04`)
- does not implement PDF geometry canonicalization, fingerprinting, or duplicate race-safety (owned by `pr-04`)
- does not implement PDF quote matching or PDF quote-context rendering behavior (owned by `pr-05`)
- does not implement PDF processing/readiness/text artifact production (owned by `pr-03`)
- does not implement frontend PDF viewer/highlighting UX (owned by `pr-06` / `pr-07`)
- does not add frontend PDF viewer debug/event snapshot instrumentation (legacy PDF.js viewer debug concerns belong to `pr-06` / `pr-07`)
- does not change existing fragment highlight public route payload contracts to anchor-discriminated output in `pr-02`
- does not add trigger-based synchronization between `highlights` and anchor subtype tables

---

## constraints
- only touch files listed in deliverables unless the spec is revised.
- preserve pre-S6 fragment highlight and annotation product semantics on existing routes.
- assume zero existing production data (greenfield), but support compatibility/repair for rows that may be created during the `pr-01` -> `pr-02` rollout window.
- `pr-02` owns service-level/kernel compatibility adoption and repair for fragment typed anchors; schema contracts remain defined by `pr-01`.
- preserve fragment duplicate behavior under the retained `pr-01` compatibility index unless an explicit, separately-reviewed index refactor is added.
- keep PDF endpoint/geometry/match behavior out of scope while still establishing internal typed seams for later PRs.
- `python/nexus/services/highlight_kernel.py` is the canonical shared resolver/typing/repair seam in `pr-02`; consumer modules must not reimplement local logical highlight resolution semantics.

---

## boundaries (for ai implementers)

**do**:
- introduce shared logical highlight media-resolution helper(s) and reuse them across permissions, contexts, send-message, and highlight service seams.
- adopt typed-anchor internal fragment read/write paths in a way that preserves current fragment-route API behavior.
- repair/normalize dormant-window fragment highlights transactionally in explicit write-capable `pr-02` fragment service paths / repair helpers, while keeping read-only consumers side-effect free and `dormant_repairable`-tolerant per `D02/D06`.
- keep legacy fragment columns as a transitional compatibility bridge while shifting canonical fragment semantics toward `highlight_fragment_anchors`.
- add tests for dormant/repaired fragment highlight states and representative route/context visibility parity.
- keep internal typed serializer/service seams private in `pr-02` (no public anchor payload rollout).
- route shared logical highlight resolution, mismatch classification, and explicit repair through `python/nexus/services/highlight_kernel.py` to avoid duplicated `D01/D02/D03` behavior.

**do not**:
- add PDF CRUD APIs, PDF quote matching, PDF geometry normalization, or PDF frontend behavior.
- introduce DB triggers for subtype population or cross-table anchor coherence.
- re-open `pr-01` schema decisions (nullable bridge, retained fragment duplicate index, row-local-only PDF schema checks) without an explicit spec/roadmap update.
- change fragment route payload shape to the S6 anchor-discriminated `HighlightOut` contract in this PR.
- bypass `highlight_kernel` by re-implementing divergent logical highlight resolution or mismatch mapping in consumer modules.

---

## open questions + temporary defaults

None currently. `S6-PR02-D01` through `S6-PR02-D07` are resolved in this draft.

---

## checklist
- [x] every l3 acceptance bullet is in traceability matrix
- [x] every traceability row has at least one test
- [x] every behavior-changing decision has assertions
- [ ] only scoped files are touched (implementation-time verification; not a spec-drafting completeness check)
- [x] non-goals are explicit and enforced
