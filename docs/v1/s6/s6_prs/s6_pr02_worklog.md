# S6 PR-02 L4 Spec Worklog

## Evidence Log

- Reviewed `pr-02` roadmap entry and acceptance bullets in `docs/v1/s6/s6_pr_roadmap.md` (typed-highlight kernel compatibility, `pr-01` dependency, no PDF API/frontend scope).
- Reviewed S6 L2 spec sections governing unified logical highlights, typed anchor subtypes, visibility/context invariants, and deferred PDF ownership (`docs/v1/s6/s6_spec.md` Sections `2`, `4.4`, `6`).
- Reviewed accepted S6 architecture decisions (`S6-D01`, `S6-D05`, `S6-D06`, `S6-D07`) in `docs/v1/s6/s6_spec_decisions.md`.
- Reviewed `pr-01` L4 spec and decisions for carry-forward constraints and ownership boundaries (`docs/v1/s6/s6_prs/s6_pr01_spec.md`, `docs/v1/s6/s6_prs/s6_pr01_decisions.md`).
- Reviewed `pr-01` implementation report for actual migration/model/test outcomes and implementation-time notes affecting `pr-02` kernel adoption (constraint naming, deferred ORM relationship ambiguity) in `docs/v1/s6/s6_prs/s6_pr01_implementation_report.md`.

## Current Codebase Findings (post-pr-01)

- `python/nexus/db/models.py` now includes:
  - dormant logical highlight fields on `Highlight` (`anchor_kind`, `anchor_media_id`)
  - `HighlightFragmentAnchor`, `HighlightPdfAnchor`, `HighlightPdfQuad`, `PdfPageTextSpan`
  - transitional nullable fragment bridge columns on `Highlight`
- Shared backend kernels still contain fragment-only assumptions that `pr-02` must remove:
  - `python/nexus/auth/permissions.py`: `can_read_highlight` point-read uses `highlight.fragment.media_id`
  - `python/nexus/services/highlights.py`: read/write/annotation paths rely on `highlight.fragment` and fragment-only serializer logic
  - `python/nexus/services/contexts.py`: context media resolution and `recompute_conversation_media` use fragment-only traversal/joins
  - `python/nexus/services/send_message.py`: context visibility checks use `highlight.fragment.media_id`
  - `python/nexus/services/context_rendering.py`: highlight/annotation rendering is fragment-only (behavior can stay fragment-only in `pr-02`, but seam must become future-ready)
- `python/nexus/schemas/highlights.py` public response/request contracts are still fragment-only, which is expected for `pr-02` (no public anchor payload rollout).

## Drafting Progress

- Created `docs/v1/s6/s6_prs/s6_pr02_spec.md` L4 skeleton with required sections.
- Seeded deliverables from the real code-backed kernel impact map.
- Seeded traceability matrix with the `pr-02` L3 roadmap acceptance set and candidate exact tests (expanded as carry-forward constraints were formalized during drafting).
- Seeded acceptance-test scaffolding across highlights, permissions, contexts, send-message, and optional stream/models parity tests.
- Resolved `S6-PR02-D01` (typed canonical fragment anchors + service-level dual-write + fail-safe mismatch posture, later clarified by `D02/D06` as explicit write-path repair plus read-only `dormant_repairable` tolerance) and prepared roadmap carry-forward notes.
- Resolved `S6-PR02-D02` (side-effect-free shared resolvers; explicit transactional repair helper(s) only in approved write-capable service paths) and patched roadmap carry-forward notes.
- Resolved `S6-PR02-D03` (path-specific fail-safe mismatch mapping across bool helpers, masked user-facing visibility surfaces, and owner/internal write paths) and patched roadmap carry-forward notes.
- Resolved `S6-PR02-D04` (dedicated `highlight_kernel` module for shared resolver/result typing/repair helpers/internal typed view seams with strict import boundaries) and patched roadmap carry-forward notes.
- Resolved `S6-PR02-D05` (`recompute_conversation_media` hybrid batch strategy reusing `highlight_kernel` semantics with dormant tolerance/no hidden repair and mismatch internal failures) and patched roadmap carry-forward notes.
- Resolved `S6-PR02-D06` (read-only consumers may proceed on `dormant_repairable` rows using resolver-returned legacy-derived data with observability; write-capable paths repair explicitly) and updated tests/traceability.
- Opened `S6-PR02-D07` (internal integrity exception/logging contract for kernel mismatch outcomes and path-specific mapping).
- Resolved `S6-PR02-D07` (centralized `highlight_kernel` mismatch mapping/logging helpers + dedicated kernel internal integrity exception diagnostics; resolver remains pure/log-free) and patched roadmap carry-forward notes.
- Reviewed legacy `docs/old-documents-specs/PDF_SPEC.md` with a `pr-02` scope lens; no `pr-02` kernel contract changes were required, but patched roadmap carry-forward clarity for `pr-07` PDF overlay color behavior and overlay interaction posture, and added an explicit `pr-02` non-goal excluding frontend PDF viewer debug instrumentation.
- Final hardening pass (pre-commit): patched `pr-02` D01 wording to remove hidden read-path repair ambiguity (`D02/D06` aligned), added missing acceptance-test definitions so all traceability-referenced tests are explicitly defined, and synced the new PDF overlay color requirement across `slice_roadmap` (L1), `s6_spec` (L2 UI contract/invariants/scenario/traceability), and `s6_pr_roadmap` (L3 `pr-07` acceptance).

## Open Decision Queue

- None currently. `S6-PR02-D01` through `S6-PR02-D07` are resolved in the current draft.
