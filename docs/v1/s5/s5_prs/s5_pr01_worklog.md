# s5 pr-01 worklog

## purpose
Capture bounded-context evidence gathered while authoring `docs/v1/s5/s5_prs/s5_pr01.md`.

## acceptance checklist (source: `docs/v1/s5/s5_roadmap.md`)
- [x] `epub_toc_nodes` schema constraints and deterministic ordering storage rules are available.
- [x] S5-specific error/status mappings are defined in the platform error model.

## evidence log

| id | acceptance item | file | lines | evidence | impact on spec |
|---|---|---|---|---|---|
| e-001 | PR-01 scope contract | `docs/v1/s5/s5_roadmap.md` | 75-83 | PR-01 goal and acceptance are schema+error primitives only; extraction and endpoint behavior are explicit non-goals. | Established singular PR-01 goal and non-goals sections. |
| e-002 | Ownership boundary C1/C2 | `docs/v1/s5/s5_roadmap.md` | 33-40 | C1/C2 are owned by PR-01; C3+ owned by later PRs. | Prevented scope smuggling into PR-02/03/04 territory. |
| e-003 | Ownership ledger drift check | `docs/v1/s5/s5_roadmap_ownership.md` | 14-23 | C2 had section-ref ambiguity vs endpoint/pagination behavior ownership boundaries. | Triggered surgical docs correction to keep C2 citations scoped to section 5 error taxonomy only. |
| e-004 | Normative TOC storage schema | `docs/v1/s5/s5_spec.md` | 87-146 | Exact DDL contract for `epub_toc_nodes` including PK/FK/check/index names and deterministic ordering semantics. | Drove migration/model deliverables and constraint naming requirements. |
| e-005 | Invariant tie-in for TOC linkage determinism | `docs/v1/s5/s5_spec.md` | 610-625 | Invariants 6.4 and 6.13 require valid fragment linkage and deterministic TOC mapping. | Reinforced FK and unique order-key requirements in PR-01 contract. |
| e-006 | Platform error taxonomy baseline | `python/nexus/errors.py` | 9-190 | File is canonical enum+status registry; S5 codes not yet present. | Added explicit deliverable to register S5 error primitives with stable statuses. |
| e-007 | Error mapping test baseline | `python/tests/test_errors.py` | 74-118 | Parametrized status-map test already used for slice-level error additions. | Chosen test insertion point for S5 error mapping coverage. |
| e-008 | Migration baseline/hardening style | `migrations/alembic/versions/0007_slice4_library_sharing.py` | 31-34 | Current head is `0007`; migration naming and deterministic contract style established. | Locked PR-01 migration revision to `0008` and additive-only pattern. |
| e-009 | Existing schema anchor models | `python/nexus/db/models.py` | 228-383 | `Media`, `Fragment`, `MediaFile` exist and define FK anchors required by TOC model. | Confirmed feasible `epub_toc_nodes` FK design in ORM and migration. |
| e-010 | Decision: DB-level order-key enforcement | `docs/v1/s5/s5_spec.md` + authoring decision | 138-144 | L2 defines strict `order_key` syntax and lexical semantics; without DB check, invalid keys can persist. | Added decision d-002 and mandated `ck_epub_toc_nodes_order_key_format` + tests. |
| e-011 | Revision-scoped migration testing precedent | `python/tests/test_migrations.py` | 1147-1173, 1369-1462 | S4 revision tests already self-manage migration state and explicitly assert intermediate upgrades. | Locked PR-01 S5 tests to the same deterministic revision-scoped orchestration pattern. |
| e-012 | ORM minimal-surface baseline | `python/nexus/db/models.py` | 330-409 | Existing association models use minimal relationship surfaces without speculative graph traversal logic. | Locked PR-01 TOC ORM scope to no self-parent/children relationships. |
| e-013 | Migration teardown stability baseline | `python/tests/test_migrations.py` | 1154-1160 | S4 revision test fixture restores head after each test teardown. | Locked PR-01 S5 migration test teardown to restore head after downgrade for suite stability. |

## notes
- Phase 1 skeleton created for PR spec, decisions, and worklog.
- Phase 2 acceptance clusters completed:
  - Cluster A: TOC schema/migration/model scope.
  - Cluster B: error enum/status registration.
- Hardening pass complete:
  - roadmap completeness: both PR-01 acceptance bullets mapped to deliverables/tests.
  - dependency sanity: no unmerged PR dependency introduced.
  - boundary cleanup: endpoint/extraction/retry behavior explicitly excluded.
  - ambiguity cleanup: L3/L3 ownership section-ref drift corrected (C2 now cites section `5` only; no pagination behavior citation).
  - boundary lock: self-referential TOC ORM relationships deferred; PR-01 remains schema-contract only.
  - test rigor lock: S5 migration tests require explicit `0007 -> 0008/head` revision orchestration and teardown restoration to head.

## unresolved items
- none.
